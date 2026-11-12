/**
 * 本地账号台账（仅内存）
 * ============================================================
 * mock 数据源原本只有种子里的 24 位会员，注册进来的人只活在小程序的
 * globalData 里，数据源对它一无所知——于是没人能把它从「待审核」变成
 * 「正常」，注册这条链路是死的。这里就是补上的那块暂存区：注册写的账号
 * 落在这里，审核的改判也落在这里。
 *
 * 【为什么保持「笨」】
 * 与 match-store.js 同一条纪律：只负责存取，刻意不提供
 * `applyTo(members)` 这类合并函数。「哪些账号能进回放名单」「未生效的
 * 申请要不要剔除」是有讲究的，属于数据层的知识（见 mock.js 的 buildCache）。
 * 一旦下沉到这里，最危险的约束就离使用现场太远。
 *
 * 【为什么要按协会分桶】
 * 与 match-store 同理：每个协会各持一份独立的账号台账，切换协会即切换
 * 整份台账。注意两条演示申请是全局的（账号是全局的，见 associations.js
 * 的说明），分桶的是「本次会话注册的账号」与「审核改判」——这正是随
 * 协会而异的部分。
 *
 * 【为什么预置两条演示申请】
 * 审核页首屏若空空如也，没法演示也没法自测。待审核的申请不计入「会员数」
 * （只有 ACTIVE 才进 getMembers），所以 24 这个数字不会因此变动。
 *
 * 【为什么不 require auth.js】
 * auth.js 需要从门面取数据源，数据源又要 require 本模块——在这里顶层
 * require auth.js 会绕成一个环。演示数据索性写成字面量，与 auth.buildAccount
 * 的字段形状保持一致即可（同样含 ratings，这样一旦通过审核就能直接进回放）。
 *
 * 【纯内存】
 * 刻意不写 wx storage：这些是演示期的临时写入，重启即失效。上云后
 * 持久化由云函数负责，届时整个模块可以直接删掉。
 * ============================================================
 */

const { ROLE, USER_STATUS } = require('../utils/constants.js');
const { createEmptyRatings } = require('../utils/rating.js');
const { perAssociation } = require('./association-scope.js');

/**
 * 预置的两条入会申请。
 * 冻结起来：它们代表「种子数据」，被谁顺手改一下都会让基线的断言莫名其妙
 * 地飘移。要改判请走 setStatus，别直接动这里。
 */
const DEMO_APPLICATIONS = Object.freeze([
  Object.freeze({
    _id: 'local_demo01',
    openId: '',
    nickName: '周雨桐',
    avatarUrl: '',
    realName: '周雨桐',
    studentId: '20240117',
    college: '经济学院',
    points: 0,
    role: ROLE.MEMBER,
    status: USER_STATUS.PENDING,
    joinDate: new Date('2026-08-24T19:20:00'),
    ratings: createEmptyRatings(),
  }),
  Object.freeze({
    _id: 'local_demo02',
    openId: '',
    nickName: '马俊',
    avatarUrl: '',
    realName: '马俊',
    studentId: '20230905',
    college: '信息工程学院',
    points: 0,
    role: ROLE.MEMBER,
    status: USER_STATUS.PENDING,
    joinDate: new Date('2026-09-02T20:05:00'),
    ratings: createEmptyRatings(),
  }),
]);

/**
 * 按协会分桶的账号台账：每个协会各持一份「本次会话注册 + 改判」。
 * @type {{current: Function, clear: Function}}
 */
const state = perAssociation(() => ({
  /** 本次会话中注册产生的账号（按注册顺序），已定案的也在里面 */
  submitted: [],
  /** 对账号的改判：_id → { status, action, reason, actor, actedAt } */
  overrides: new Map(),
}));

/**
 * 需要逐层复制的字段。
 * 其余字段都是标量，浅拷贝就够了；但 ratings 是对象，浅拷贝会让台账与
 * 调用方共用同一份分数——审核页随手改一下，种子数据就跟着变了。
 */
const OBJECT_FIELDS = ['ratings'];

/**
 * 复制一条账号记录。
 * @param {Object} account
 * @returns {Object} 与入参不共享任何可变子对象的新记录
 */
function cloneAccount(account) {
  const copy = { ...account };
  for (const field of OBJECT_FIELDS) {
    const value = account[field];
    if (!value || typeof value !== 'object') continue;

    // 逐池复制：ratings 是「池名 → 分数对象」的两层结构，只摊平外面一层的话
    // 里层的分数对象仍与台账共享，改一下就把演示数据也改了
    const pools = {};
    for (const [pool, rating] of Object.entries(value)) {
      pools[pool] = rating && typeof rating === 'object' ? { ...rating } : rating;
    }
    copy[field] = pools;
  }
  return copy;
}

/** 当前协会台账里的全部账号（演示 + 注册），未叠加改判 */
function listRaw() {
  return DEMO_APPLICATIONS.concat(state.current().submitted);
}

/**
 * 某条账号的当前状态。改判优先于记录本身——审批过的账号，
 * 记录里仍写着 PENDING，真正管用的是那条改判。
 */
function effectiveStatus(account) {
  const patch = state.current().overrides.get(account._id);
  return patch && patch.status !== undefined ? patch.status : account.status;
}

/**
 * 取某条账号的改判记录。
 * @param {string} id
 * @returns {Object|null} 没有改判时返回 null
 */
function overrideOf(id) {
  const patch = state.current().overrides.get(id);
  return patch ? { ...patch } : null;
}

/**
 * 写入一条账号的改判。多次改判以最后一次为准（后一次在前一次之上合并）。
 *
 * @param {string} id
 * @param {Object} patch 至少含 status；驳回还要带 reason、action、actor、actedAt
 * @returns {Object} 合并后的改判
 */
function setStatus(id, patch) {
  const bucket = state.current();
  const next = { ...(bucket.overrides.get(id) || {}), ...patch };
  bucket.overrides.set(id, next);
  return { ...next };
}

/**
 * 记入一个注册产生的账号。
 *
 * 【为什么要管「已定案」这条分支】
 * 同一个人重复提交注册（网络重试、用户手抖点两下）不该把管理员已经批过
 * 的账号打回「待审核」——那等于用一次重试把审批结果抹掉。所以只在账号
 * 仍处于待审核时允许覆盖，已经转正或被驳回的一律保持原样。
 *
 * @param {Object} account auth.buildAccount 给出的账号
 * @returns {Object|null} 台账中的账号（副本）；入参没有 _id 时返回 null
 */
function addAccount(account) {
  if (!account || !account._id) return null;

  const bucket = state.current();
  const index = bucket.submitted.findIndex((item) => item._id === account._id);
  if (index >= 0 && effectiveStatus(bucket.submitted[index]) !== USER_STATUS.PENDING) {
    // 交回去的是「改判生效后」的那一条，否则调用方拿到的还是一个 PENDING，
    // 会以为自己的重试把审批结果顶掉了
    return findAccount(account._id);
  }

  // 落库时状态一律收回「待审核」：就算调用方塞进来一个 ACTIVE，
  // 也不能凭这一次写入让自己转正——激活的权力只属于审核接口。
  const record = cloneAccount({ ...account, status: USER_STATUS.PENDING });
  if (index >= 0) bucket.submitted[index] = record;
  else bucket.submitted.push(record);

  return cloneAccount(record);
}

/**
 * 列出全部账号（副本），逐条叠加改判。
 * @returns {Array<Object>} 待审核、已驳回、已通过都在里面，由调用方分类
 */
function listAccounts() {
  const overrides = state.current().overrides;
  return listRaw().map((account) => {
    const patch = overrides.get(account._id);
    return patch ? { ...cloneAccount(account), ...patch } : cloneAccount(account);
  });
}

/**
 * 按编号找一条账号，改判同样生效。
 * @param {string} id
 * @returns {Object|null}
 */
function findAccount(id) {
  if (!id) return null;
  const found = listRaw().find((account) => account._id === id);
  if (!found) return null;

  const patch = state.current().overrides.get(id);
  return patch ? { ...cloneAccount(found), ...patch } : cloneAccount(found);
}

/** 清空全部协会的注册与改判。mock.resetCache() 会调用它。 */
function reset() {
  state.clear();
}

module.exports = {
  DEMO_APPLICATIONS,
  addAccount,
  listAccounts,
  findAccount,
  overrideOf,
  setStatus,
  reset,
};
