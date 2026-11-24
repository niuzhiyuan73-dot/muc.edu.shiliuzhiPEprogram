/**
 * 学院赛出场安排（排阵）—— 提交、自动沿用上次、换替补
 * ============================================================
 * 大场（tie）排出来之后，双方学院各交一份「本大场每个小项谁上」的安排，
 * 也就是排阵。这个模块回答排阵这一步的问题：
 *   1. 谁能替哪个学院提交？（权限，学院负责人限本学院，D37）
 *   2. 这份排阵能不能提交？（人数、名额、兼项、同一小项不重复，D20/D21/D40）
 *   3. 没改动的排阵从哪来？（自动沿用上一次，D30）
 *   4. 排阵在页面上显示成什么样？
 *
 * 【为什么排阵里的人是「编号」而不是「名字」】
 * 名单本身就是队员编号的集合（见 college-store / college_entries）。排阵
 * 存编号，换替补时只需要换一个编号，比分与 ELO 仍然认这个人；若存名字，
 * 有人改了昵称，历史排阵就对不上名单了。
 *
 * 【为什么「未排人不能提交」要在这一层挡】
 * D40：学院负责人不排人就不能提交，未提交就不能开大场，从源头避免「开赛后记弃权」。
 * 把这条放在纯函数里，页面、mock、云端三处共用同一道闸，不会各自松紧不一。
 *
 * 【为什么沿用「上一次」而不是「上一轮」】
 * 一个学院可能在同一天连打两个大场（第二轮），两次之间没有新名单。沿用
 * 最近一次提交（不论它属于哪个大场），最贴近学院负责人脑子里的「上次这么排的」。
 *
 * 纯函数，不碰 wx、不碰数据源，可在 Node 里完整测试。
 * ============================================================
 */

const {
  COLLEGE_EVENT_STATUS,
  TIE_STATUS,
  COLLEGE_ENTRY_STATUS,
  LEG_DISCIPLINE_LABEL,
  GENDER,
  GENDER_LABEL,
  SINGLES_DISCIPLINES,
  requiredGendersOf,
} = require('../utils/constants.js');
const { managesCollege } = require('./permission.js');

/** 一个小项需要几个人：单打 1 人，双打 2 人（真相源里按位置列出性别，长度即人数） */
function playersPerLeg(discipline) {
  const required = requiredGendersOf(discipline);
  return required ? required.length : 1;
}

/**
 * 把一个小项的性别要求说成一句人话，用于拒绝时给出具体原因。
 * 例：男单 → 「男单」需要 1 名男队员；混双 → 「混双」需要 1 名男队员 + 1 名女队员。
 *
 * @param {string} discipline
 * @returns {string}
 */
function genderRequirementText(discipline) {
  const required = requiredGendersOf(discipline);
  if (!required) return '';
  const label = LEG_DISCIPLINE_LABEL[discipline] || discipline || '';
  const countOf = (gender) => required.filter((item) => item === gender).length;
  const parts = [GENDER.MALE, GENDER.FEMALE]
    .filter((gender) => countOf(gender) > 0)
    .map((gender) => `${countOf(gender)} 名${GENDER_LABEL[gender]}队员`);
  return `「${label}」需要 ${parts.join(' + ')}`;
}

/* ============================================================
 * 权限
 * ============================================================ */

/**
 * 能不能替某个学院提交本大场的排阵。**学院负责人（本学院）+ 管理员**。
 *
 * 【为什么大场进行中 / 已结束就不能再改】
 * 排阵一旦交上去、管理员点了「开始」，小场就逐项打起来了。此时再改排阵，
 * 已经打完的小场与还没打的会指向不同的人，成绩无法追认。锁定后唯一允许的
 * 调整是「换替补」，那仍属于「提交一份新排阵」，但只在大场开始前有效。
 *
 * @param {Object|null} tie 大场
 * @param {Object|null} actor
 * @param {Object} [options]
 * @param {string} [options.college] 目标学院；缺省取 actor.college
 * @param {Object} [options.event] 学院赛（判是否在比赛态）
 * @returns {boolean}
 */
function canSubmitLineup(tie, actor, options = {}) {
  if (!tie) return false;
  if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) return false;

  const event = options.event || null;
  if (event && event.status !== COLLEGE_EVENT_STATUS.ONGOING) return false;

  const college = options.college || (actor && actor.college) || '';
  if (!college) return false;
  // 只能给本大场的参赛学院排阵，不能替无关学院交
  if (college !== tie.collegeA && college !== tie.collegeB) return false;

  return managesCollege(actor, college);
}

/* ============================================================
 * 提交校验
 * ============================================================ */

/**
 * 校验一次排阵提交。
 *
 * @param {Object} payload
 * @param {Array<Object>} payload.entries [{ legNo, players: string[] }]
 * @param {string} payload.college 提交学院
 * @param {Object} ctx
 * @param {Object|null} ctx.tie 大场
 * @param {Object|null} ctx.event 学院赛
 * @param {Object|null} ctx.actor 提交人
 * @param {Object|null} [ctx.entry] 该学院已通过审核的名单
 * @param {Array<Object>|Map<string,Object>} [ctx.members] 全量会员档案，用于查性别。
 *        真机 / 云端的两个写入端都会传；纯逻辑测试不传时则跳过性别校验。
 * @returns {{ok:boolean, message:string, entries:Array<Object>, college:string}}
 */
function validateLineup(payload = {}, ctx = {}) {
  const { tie = null, event = null, actor = null, entry = null, members = null } = ctx;
  const college = String(payload.college || '').trim();
  const raw = Array.isArray(payload.entries) ? payload.entries : [];
  const failed = (message) => ({ ok: false, message, entries: [], college });

  if (!tie) return failed('找不到这个大场');
  if (event && event.status !== COLLEGE_EVENT_STATUS.ONGOING) {
    return failed('赛事还没开始，不能排阵');
  }
  if (!canSubmitLineup(tie, actor, { college, event })) {
    if (tie.status === TIE_STATUS.ONGOING || tie.status === TIE_STATUS.FINISHED) {
      return failed('大场已经开始，不能再改排阵');
    }
    return failed('只能提交本学院大场的排阵');
  }
  // 名单必须先通过审核——排阵的人必须出自名单（D37）
  if (!entry || entry.status !== COLLEGE_ENTRY_STATUS.APPROVED) {
    return failed('本学院的名单尚未通过审核，不能排阵');
  }

  const roster = new Set(
    (Array.isArray(entry.members) ? entry.members : []).map((id) => String(id || ''))
  );
  // 会员编号 → 会员档案。写入端一定给；给了才做性别校验（没有档案就无从判性别）
  const memberMap = members instanceof Map
    ? members
    : new Map((Array.isArray(members) ? members : []).map((member) => [member._id, member]));
  // 「给了档案」才做性别校验。空集合等于没给（数据未装载），若按 true 处理，
  // 每个人都会查到空性别，导致所有队伍被误报「性别不符」。
  const canCheckGender = members instanceof Map ? members.size > 0 : Array.isArray(members) && members.length > 0;
  const legs = Array.isArray(tie.legs) ? tie.legs : [];
  if (legs.length === 0) return failed('这场大场还没有小项，无法排阵');

  // legNo → 提交内容，便于按小项序列逐条核对，顺序与缺漏一并查出来
  const byLegNo = new Map();
  for (const item of raw) {
    const legNo = Number(item && item.legNo);
    if (Number.isFinite(legNo)) byLegNo.set(legNo, item);
  }

  const entries = [];
  const uses = new Map(); // 队员编号 → 已出场的小项数（查兼项用）

  for (const leg of legs) {
    const legNo = Number(leg.legNo);
    const submitted = byLegNo.get(legNo);
    const players = [...new Set(
      ((submitted && Array.isArray(submitted.players)) ? submitted.players : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean)
    )];
    const need = playersPerLeg(leg.discipline);
    const label = `第 ${legNo} 场`;

    // D40：一个小项都不能空着——少排一个人就不给提交
    if (players.length < need) {
      return failed(`${label}还没排满 ${need} 名队员`);
    }
    if (players.length > need) {
      return failed(`${label}最多只能排 ${need} 名队员`);
    }

    for (const id of players) {
      if (!roster.has(id)) {
        return failed(`${label}的队员不在本学院名单内，请重新选择`);
      }
      uses.set(id, (uses.get(id) || 0) + 1);
    }

    // 性别硬校验：上场队员的性别必须与小项要求完全吻合（男单限男、混双一男
    // 一女）。按排序后的数组比对，既管性别也管人数，不必分两条规则写。
    const required = requiredGendersOf(leg.discipline);
    if (canCheckGender && required) {
      const actual = players
        .map((id) => {
          const member = memberMap.get(id);
          return member ? member.gender : '';
        })
        .sort();
      const need = required.slice().sort();
      const same =
        actual.length === need.length && actual.every((gender, index) => gender === need[index]);
      if (!same) {
        return failed(`${label} ${genderRequirementText(leg.discipline)}，请重新选择队员`);
      }
    }

    entries.push({ legNo, discipline: leg.discipline, players });
  }

  // D20：默认允许兼项；管理员关掉后，同一个人只能出现在一个小项里
  if (event && event.allowMultiEntry === false) {
    for (const [id, count] of uses) {
      if (count > 1) {
        return failed('本赛事不允许兼项，同一个人只能打一个小项');
      }
    }
  }

  return { ok: true, message: '', entries, college };
}

/**
 * 由校验结果组装一条可落库的排阵记录（不含 _id）。
 *
 * @param {Object} payload 原始提交
 * @param {Object} ctx
 * @param {Object} ctx.tie
 * @param {Object} ctx.event
 * @param {Object} ctx.actor
 * @param {Object} [ctx.entry] 该学院名单
 * @param {Date} [ctx.now=new Date()]
 * @param {string} [ctx.carriedFrom] 沿用自哪份排阵的 _id（可空）
 * @param {Array<Object>|Map<string,Object>} [ctx.members] 全量会员档案，用于校验性别
 * @returns {{ok:boolean, record:Object|null, message:string}}
 */
function buildLineupRecord(payload = {}, ctx = {}) {
  const { tie = null, event = null, actor = null, entry = null, now = new Date(), carriedFrom = '', members = null } = ctx;
  const check = validateLineup(payload, { tie, event, actor, entry, members });

  if (!check.ok) {
    return { ok: false, record: null, message: check.message };
  }

  return {
    ok: true,
    record: {
      eventId: event ? event._id : (tie ? tie.eventId : ''),
      tieId: tie._id,
      college: check.college,
      entries: check.entries.map((row) => ({ ...row, players: row.players.slice() })),
      submittedBy: actor ? actor._id : '',
      submittedName: actor ? actor.nickName || actor.realName || actor._id : '',
      submitTime: now,
      // 记录这份排阵是沿用了哪一份（没有沿用则为空）。纯台账信息，
      // 便于复盘「这个换人是有意为之，还是忘了改沿用值」
      carriedFrom: carriedFrom || '',
    },
    message: '',
  };
}

/* ============================================================
 * 自动沿用上次
 * ============================================================ */

/**
 * 找某学院最近一次提交的排阵内容，供本次默认带上（D30）。
 *
 * @param {Array<Object>} [lineups] 本赛事全部排阵
 * @param {string} college
 * @param {string} [excludeTieId] 排除本大场（重进本页时应带出自己已交的那份）
 * @returns {Array<Object>|null} entries 形状的数组，没有则为 null
 */
function carriedEntriesOf(lineups, college, excludeTieId) {
  const list = (Array.isArray(lineups) ? lineups : []).filter(
    (item) => item && item.college === college && item.tieId !== excludeTieId
  );
  if (list.length === 0) return null;

  const latest = list.reduce((best, item) => {
    const at = new Date(item.submitTime || 0).getTime();
    const bestAt = best ? new Date(best.submitTime || 0).getTime() : -Infinity;
    return at >= bestAt ? item : best;
  }, null);

  const entries = latest && Array.isArray(latest.entries) ? latest.entries : [];
  return entries.length > 0 ? entries.map((row) => ({ ...row, players: (row.players || []).slice() })) : null;
}

/**
 * 本次排阵的默认值：优先本大场已交的那份，其次沿用上一次，最后空。
 *
 * @param {Object} ctx
 * @param {Object} ctx.tie
 * @param {string} ctx.college
 * @param {Array<Object>} [ctx.lineups] 本赛事全部排阵
 * @returns {{entries:Array<Object>, source:string, carriedFrom:string}}
 */
function defaultLineupEntries({ tie = null, college = '', lineups = [] } = {}) {
  const legs = tie && Array.isArray(tie.legs) ? tie.legs : [];

  const own = (Array.isArray(lineups) ? lineups : []).find(
    (item) => item && item.tieId === (tie ? tie._id : '') && item.college === college
  );
  if (own && Array.isArray(own.entries) && own.entries.length > 0) {
    return { entries: own.entries.map((row) => ({ ...row, players: (row.players || []).slice() })), source: 'own', carriedFrom: '' };
  }

  const carried = carriedEntriesOf(lineups, college, tie ? tie._id : '');
  if (carried) {
    return { entries: carried, source: 'carried', carriedFrom: '' };
  }

  return {
    entries: legs.map((leg) => ({ legNo: leg.legNo, discipline: leg.discipline, players: [] })),
    source: 'empty',
    carriedFrom: '',
  };
}

/* ============================================================
 * 展示整形
 * ============================================================ */

/**
 * 排阵行整形。权限布尔量与文案在这里算好，模板不写业务判断。
 *
 * @param {Object} lineup
 * @param {Object} [ctx]
 * @param {Object|null} [ctx.actor]
 * @param {Object} [ctx.members] 编号 → 会员 的映射
 * @returns {Object}
 */
function buildLineupRow(lineup, ctx = {}) {
  const { actor = null, members = null } = ctx;
  const source = lineup || {};
  const byId = members instanceof Map ? members : new Map();
  const entries = Array.isArray(source.entries) ? source.entries : [];

  return {
    lineupId: source._id || '',
    eventId: source.eventId || '',
    tieId: source.tieId || '',
    college: source.college || '',
    submittedName: source.submittedName || '',
    submitTimeText: source.submitTime ? String(source.submitTime).slice(0, 16) : '',
    entries: entries.map((row) => ({
      legNo: row.legNo,
      discipline: row.discipline,
      players: (row.players || []).slice(),
      // 姓名拼成一串，模板里不必再嵌一层 wx:for
      playersText: (row.players || [])
        .map((id) => {
          const member = byId.get(id);
          if (!member) return id;
          return member.nickName || member.realName || id;
        })
        .join('、'),
    })),
    // 这份排阵是不是当前看页面的人所属学院的（页面据此高亮「我方」）
    isMine: Boolean(actor && actor.college === source.college),
  };
}

/**
 * 排阵主键：同一大场同一学院恒为一条。
 * @param {string} tieId
 * @param {string} college
 * @returns {string}
 */
function lineupKey(tieId, college) {
  return `ln_${tieId}_${college}`;
}

module.exports = {
  SINGLES_DISCIPLINES,
  playersPerLeg,
  canSubmitLineup,
  validateLineup,
  buildLineupRecord,
  carriedEntriesOf,
  defaultLineupEntries,
  buildLineupRow,
  lineupKey,
};
