/**
 * 公告 —— 发布权限与内容校验
 * ============================================================
 * 「发公告」要回答两个问题，答案全在这里：
 *   1. 我有没有资格发？（发布权）
 *   2. 我填的这条公告能不能发出去？（内容校验）
 *
 * 【为什么单独成模块】
 * 与 match-record.js / member-review.js 同一套路数：两件事都是纯判断，
 * 不碰 wx、不碰数据源。放进页面里就要靠点真机验证，放进 mock.js 又会被
 * 卷进「哪些公告该列出来」的取数逻辑里。单独拿出来，每一条边界都能用
 * 字面量在 Node 里钉死。
 *
 * 【发布权为什么与审核权共用一套判定】
 * 「谁能管这件事」在本项目里已经出现三处：审核入会、发布公告、（将来）
 * 管理赛事。规则一字不差，只是管的事不同，所以判定抽在 permission.js，
 * 这里只声明自己需要的门槛——不另抄一遍，免得两处口径慢慢分叉。
 *
 * 【分类为什么必须落在白名单里】
 * 分类决定筛选标签与样式。若允许自由输入，某天出现一个「公告」或
 * 「通知 」这种带空格的分类，标签栏会多出一个点不动的空档，页面上
 * 看起来像是坏了。所以只认 constants.ANNOUNCEMENT_CATEGORIES 里的值。
 * ============================================================
 */

const {
  ROLE,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_STATUS_LABEL,
} = require('../utils/constants.js');
const { formatDateTime } = require('../utils/format.js');
const { canManage } = require('./permission.js');
const { isGlobalAdminMember } = require('./member-review.js');

/** 标题长度下限与上限 */
const TITLE_MIN = 2;
const TITLE_MAX = 30;
/** 正文长度上限 */
const CONTENT_MAX = 500;
/** 分类缺省时的展示兜底，只用于渲染，不用于「接受输入」 */
const DEFAULT_CATEGORY = ANNOUNCEMENT_CATEGORIES[0];

/** 校验顺序即表单顺序，取「第一条错误」时按它走 */
const FIELD_ORDER = ['title', 'content', 'category'];

/**
 * 公告排序：置顶优先，其余按发布时间倒序。
 *
 * 【为什么排序不放在数据层】
 * 「置顶」是展示口径，不是数据属性——后台随时可能取消某条置顶。
 * 数据层只给时间倒序，置顶策略留在这里，改起来不动数据。
 *
 * 【为什么放在本模块而不是首页】
 * 首页公告栏与公告列表页都要用同一套排序。留在 home-view 里会逼着
 * 列表页反向依赖首页模块，两处各写一份又迟早会分叉。
 *
 * @param {Array<Object>} list
 * @returns {Array<Object>} 新数组，不改动入参
 */
function sortAnnouncements(list) {
  return [...list].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return new Date(b.publishTime) - new Date(a.publishTime);
  });
}

/**
 * 有没有发布资格。**仅全局管理员**。
 *
 * 【为什么门槛是管理员而不是学院负责人】
 * 公告是发给全俱乐部的，发出去就收不回，还会顶在首页——这是「定盘子」
 * 的事，与发布赛事、赛季重置同一级别（见 event.canManageEvent 的同款理由）。
 * 学院负责人的权限以学院为界（见 permission.managesCollege），
 * 而公告根本没有「某个学院的公告」这一说，做成学院负责人可发就必然越界：
 * 法学院的负责人能往全校发通知。所以这里连学院范围都没得收，只能收归管理员。
 *
 * 【为什么还要卡 isGlobalAdmin，而不只看 role】
 * 协会负责人在**本协会**的有效角色也是 ADMIN（见 context.effectiveRole 与
 * mock 的角色补丁 / ASSOC_ROLE_SEED），若只判 role，协会负责人就会被当成
 * 管理员，凭空多出首页公告的发布与下架权。公告没有协会边界，只该给账号级的
 * 全局管理员。判定与任免协会负责人（member-review.isGlobalAdminMember）、
 * 云端 role-handlers 一字不差。
 *
 * 【为什么还要包一层】
 * 判定规则与审核入会同源；这里留住「发布」这个业务语义的函数名，并声明
 * 本业务自己的门槛。
 *
 * @param {Object|null} actor
 * @param {Object} [options] 透传给 permission.canManage（如 minRole）；
 *   可传 options.isGlobalAdmin 显式声明（云端 ctx.isGlobalAdmin），
 *   缺省取 actor.isGlobalAdmin / 退回按 role 判定
 * @returns {boolean}
 */
function canPublish(actor, options = {}) {
  const isGlobalAdmin =
    options.isGlobalAdmin !== undefined
      ? Boolean(options.isGlobalAdmin)
      : isGlobalAdminMember(actor);
  return canManage(actor, { ...options, minRole: ROLE.ADMIN }) && isGlobalAdmin;
}

/**
 * 去掉各项的首尾空格，并把缺失字段补成空串。
 * 用户从别处复制来的标题很容易带空格，不处理会莫名其妙校验失败。
 *
 * @param {Object} [form]
 * @returns {{title:string, content:string, category:string, pinned:boolean}}
 */
function normalizeDraft(form) {
  const source = form && typeof form === 'object' ? form : {};
  const text = (value) => (value === null || value === undefined ? '' : String(value).trim());

  return {
    title: text(source.title),
    content: text(source.content),
    category: text(source.category),
    // 复选框给过来的多半是字符串，统一收敛成布尔量，别让 'false' 变成真
    pinned: Boolean(source.pinned),
  };
}

/**
 * 校验一条公告草稿。
 *
 * @param {Object} [form] 原始表单，内部会先做 normalize
 * @returns {{ok:boolean, draft:Object, errors:Object<string,string>, firstError:string}}
 */
function validateAnnouncement(form = {}) {
  const draft = normalizeDraft(form);
  const errors = {};

  if (draft.title.length < TITLE_MIN || draft.title.length > TITLE_MAX) {
    errors.title = `标题需为 ${TITLE_MIN}~${TITLE_MAX} 个字`;
  }

  if (!draft.content) {
    errors.content = '请填写公告正文';
  } else if (draft.content.length > CONTENT_MAX) {
    errors.content = `正文最多 ${CONTENT_MAX} 个字`;
  }

  if (!ANNOUNCEMENT_CATEGORIES.includes(draft.category)) {
    errors.category = '请选择公告分类';
  }

  const firstFailed = FIELD_ORDER.find((field) => errors[field]);

  return {
    ok: !firstFailed,
    draft,
    errors,
    firstError: firstFailed ? errors[firstFailed] : '',
  };
}

/**
 * 由草稿组装一条可落库的公告记录。
 *
 * 记录里带 publisherId / publisherName：公告是「谁发的」在管理台账里
 * 必须能追溯，出了问题才知道该找谁核实。这与比赛记录带 recorder 同理。
 *
 * @param {Object} form 公告表单
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 发布者
 * @param {Date} [ctx.now=new Date()] 发布时间，注入以便测试固定
 * @returns {{ok:boolean, record:Object|null, errors:Object, firstError:string}}
 */
function buildAnnouncementRecord(form, ctx = {}) {
  const { actor = null, now = new Date() } = ctx;
  const validation = validateAnnouncement(form);

  if (!validation.ok) {
    return { ok: false, record: null, errors: validation.errors, firstError: validation.firstError };
  }

  const { draft } = validation;
  return {
    ok: true,
    record: {
      ...draft,
      publishTime: now,
      publisherId: actor ? actor._id : '',
      // 昵称逐层兜底：注册资料里昵称可能没填，绝不落库一个空字符串
      publisherName: actor ? actor.nickName || actor.realName || actor._id : '',
    },
    errors: {},
    firstError: '',
  };
}

/**
 * 整形公告列表的一行。
 *
 * 与 member-review.buildApplicationRow 同一约定：把权限算进数据里，
 * 模板只照着渲染按钮，不写 `wx:if="{{viewer.role >= 1}}"` 这类业务判断
 * ——那种写法 Node 跑不了，等于没法测。
 *
 * @param {Object} item 一条公告
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor] 当前看页面的会员
 * @returns {Object}
 */
function buildAnnouncementRow(item, ctx = {}) {
  const { actor = null } = ctx;

  const archived = item.status === ANNOUNCEMENT_STATUS.ARCHIVED;
  const allowed = canPublish(actor);

  return {
    id: item._id,
    // 逐层兜底，绝不渲染出 undefined
    title: item.title || '（无标题）',
    content: item.content || '',
    category: item.category || DEFAULT_CATEGORY,
    pinned: Boolean(item.pinned),
    publishText: formatDateTime(item.publishTime),
    statusLabel:
      ANNOUNCEMENT_STATUS_LABEL[item.status] ||
      ANNOUNCEMENT_STATUS_LABEL[ANNOUNCEMENT_STATUS.PUBLISHED],
    archived,
    publisherName: item.publisherName || '',
    // 已下架的没有再下架一次的道理；能发生效的只有「已发布」的那些
    canArchive: allowed && !archived,
  };
}

module.exports = {
  TITLE_MIN,
  TITLE_MAX,
  CONTENT_MAX,
  DEFAULT_CATEGORY,
  sortAnnouncements,
  canPublish,
  normalizeDraft,
  validateAnnouncement,
  buildAnnouncementRecord,
  buildAnnouncementRow,
};
