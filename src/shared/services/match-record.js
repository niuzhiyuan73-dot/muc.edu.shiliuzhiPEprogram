/**
 * 比赛记录 —— 录入、权限与状态流转
 * ============================================================
 * 比赛页要回答三个问题，答案全在这里：
 *   1. 我能不能确认这一场？（确认权）
 *   2. 我能不能撤销这一场？（撤销权）
 *   3. 我填的这张单子能不能变成一条记录？（录入校验）
 *
 * 【为什么单独成模块】
 * 这三件事都是纯判断，不碰 wx、不碰数据源。放进页面里就要靠点真机验证，
 * 放进 mock.js 又会被卷进「哪些比赛该回放」的复杂逻辑里。单独拿出来，
 * 就能用字面量输入把每一条边界都钉死在测试里。
 *
 * 【胜负不由录入者说了算】
 * 本模块永不接受 winner 入参，一律由 match-format.js 的 validateMatchScore
 * 从比分推出来。这是整条链路的基石：比分是唯一事实，等级分、积分、排名
 * 都由它推导。如果允许手工指定胜方，就会出现「11:9 却记成 B 队赢」这种
 * 自相矛盾的记录。
 *
 * 【时间窗为什么必须拦】
 * 旧回放引擎（已删除）曾用赛季首场比赛当定级锚点；逐场结算改造后
 * 如果允许把时间录到赛季首场之前，锚点会前移，「赛季开始后才入会」的
 * 判定随之改变，全体中途入会者的初始分被静默重算——一个人的笔误
 * 会变成全站分数漂移。所以 minMatchTime 是一个硬边界。
 * ============================================================
 */

const {
  MATCH_TYPE,
  MATCH_TYPE_TO_POOL,
  MATCH_STATUS,
  MATCH_COMPETITION,
  MATCH_OUTCOME,
  ROLE,
  TEAM,
} = require('../utils/constants.js');
const { validateMatchScore, isValidFormat } = require('../utils/match-format.js');

/** 每队人数。单打一人，双打两人。 */
const TEAM_SIZE = {
  [MATCH_TYPE.SINGLES]: 1,
  [MATCH_TYPE.DOUBLES]: 2,
};

/**
 * 某位会员站在哪一边。
 * @param {Object} match
 * @param {string} userId
 * @returns {'A'|'B'|null}
 */
function sideOf(match, userId) {
  if (!match || !userId) return null;
  if ((match.teamA || []).includes(userId)) return 'A';
  if ((match.teamB || []).includes(userId)) return 'B';
  return null;
}

/**
 * 是否是这场比赛的参赛者。
 * @param {Object} match
 * @param {string} userId
 * @returns {boolean}
 */
function isParticipant(match, userId) {
  return sideOf(match, userId) !== null;
}

/**
 * 是否是这场比赛的录入者。
 * @param {Object} match
 * @param {string} userId
 * @returns {boolean}
 */
function isRecorder(match, userId) {
  return Boolean(match && userId && match.recorder === userId);
}

/**
 * 这场比赛的参赛者里，有没有人属于某个学院。
 *
 * 学院负责人代录比赛时用它划范围：只有自己学院有人上场的比赛，
 * 才轮得到他代录。collegeOf 由调用方注入（比赛记录里只有编号，没有学院，
 * 学院存在会员档案里），本模块因此仍是不碰数据源的纯逻辑。
 *
 * @param {Object} match
 * @param {string} college 学院全名
 * @param {Function} collegeOf 编号 → 学院
 * @returns {boolean}
 */
function involvesCollege(match, college, collegeOf) {
  if (!match || !college || typeof collegeOf !== 'function') return false;
  const ids = [...(match.teamA || []), ...(match.teamB || [])];
  return ids.some((id) => collegeOf(id) === college);
}

/**
 * 这场比赛指不指定了裁判。
 *
 * `referee` 是后加的字段：历史比赛没有它，读到 undefined。统一在这里归一，
 * 免得每个调用方各写一遍 `!== '' && !== null` 这种判断，漏一处就是一个越权口子。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function hasReferee(match) {
  return Boolean(match) && Boolean(String(match.referee || '').trim());
}

/**
 * 有没有资格录入这场比赛的比分。
 *
 * 规则与写入端（mock.submitMatch、云端 submitScheduledMatch）同源：
 *   1. 指定了裁判的场次，只有裁判本人与管理员能录；
 *   2. 没指定裁判时（含历史数据）：
 *      a. 参赛者本人可以录；
 *      b. 管理员可以代录任意一场；
 *      c. 学院负责人只能代录**本学院有人上场**的比赛——其权限以学院为界，
 *         替别的学院录分会把本院的账记到别人名下。
 *
 * 判定需要「编号 → 学院」，而比赛记录里只有编号，所以由调用方传入
 * collegeOf。拿不到学院时，学院负责人的代录一律不放行（宁严勿松）。
 *
 * @param {Object} match
 * @param {string} actorId
 * @param {Object} [options]
 * @param {number} [options.role=ROLE.MEMBER] 操作者角色
 * @param {string} [options.college] 操作者所属学院（学院负责人用）
 * @param {Function} [options.collegeOf] 编号 → 学院
 * @returns {boolean}
 */
function canRecordScore(match, actorId, options = {}) {
  const { role = ROLE.MEMBER, college = '', collegeOf = null } = options;

  if (!match || !actorId) return false;
  // 指定裁判后录分口收窄：裁判与管理员之外一律不放行。管理员兜底永远在——
  // 裁判临时来不了，管理员取消裁判即回到下面那套普通口径（§5.2 第 3 条）。
  if (hasReferee(match)) {
    return actorId === match.referee || Number(role) >= ROLE.ADMIN;
  }
  if (isParticipant(match, actorId)) return true;
  if (Number(role) >= ROLE.ADMIN) return true;
  if (Number(role) < ROLE.STAFF) return false;

  return involvesCollege(match, college, collegeOf);
}

/**
 * 确认资格（与状态无关）：这场成绩轮不轮得到「这个人」盖章。
 *
 * 【为什么从 canConfirm 里拆出来】
 * 已生效的比赛不再接受再次确认，但「确认响应丢失后重试」必须能凭同一资格
 * 取回既有结算结果（交接文档 §6 约束 6）——判断「谁有资格」与「比赛处于
 * 什么状态」是两件事。canConfirm = 待确认状态 ∧ 本函数。
 *
 * @param {Object} match
 * @param {string} userId
 * @param {Object} [options] 同 canConfirm：isMock / role
 * @returns {boolean}
 */
function canConfirmIdentity(match, userId, options = {}) {
  const { isMock = false, role = ROLE.MEMBER } = options;
  if (!match || !userId) return false;
  // 指定裁判后确认口与录分口同宽：只有裁判与管理员
  if (hasReferee(match)) {
    return userId === match.referee || Number(role) >= ROLE.ADMIN;
  }
  // 管理员可确认任意一场（含不是自己打的）
  if (role === ROLE.ADMIN) return true;
  if (!isParticipant(match, userId)) return false;

  const recorderSide = sideOf(match, match.recorder);
  // 异常数据：录入者不在场上，无法判断谁是对手，不做额外限制
  if (recorderSide === null) return true;

  // 站在录入者的对面才有资格确认；录入方自己不行
  return sideOf(match, userId) !== recorderSide || isMock;
}

/**
 * 能否确认这场比赛的比分。
 *
 * 生产口径是「对手确认」：录入方不能给自己盖章，否则一个人就能凭空
 * 造出一场胜利并让自己涨分。只有站在对面的人点了确认，成绩才生效。
 *
 * 【管理员为什么可以确认任意一场】
 * 临场常见的收口场景：双方都到场、都认账，但没人愿意掏手机点确认，或者
 * 录入手机没电了。这时管理员代为确认，比让这场成绩一直悬着更可靠。
 * 管理员权限本就包含「撤销任意一场」，确认口径与撤销对齐，不再额外设限。
 *
 * 【mock 下为什么放宽】
 * 本地演示只有一个账号，真要严格按「对手确认」，任何一场待确认的比赛
 * 都永远确认不了，整条链路没法走通。所以 isMock 时放宽为「参与即可」，
 * 界面必须把这一点明示出来（见 match-view 的 demoNotice），
 * 免得把演示口径当成真实规则。放宽只影响 mock，云端仍走严格口径。
 *
 * 【指定裁判后为什么也收窄】
 * 需求口径：指定裁判的场次，「录分」与「确认」都只有裁判与管理员能做
 * （§二 第 4 条）。确认是给成绩盖章，与录分同属一次执法，交给同一个人。
 * 这里不放宽 mock —— 放宽只针对「对手确认」那套口径，裁判闸是显式的指派
 * 结果，本地演示也应当按真实规则走。
 *
 * @param {Object} match
 * @param {string} userId
 * @param {Object} [options]
 * @param {boolean} [options.isMock=false]
 * @param {number} [options.role] 操作者角色；管理员可确认任意比分
 * @returns {boolean}
 */
function canConfirm(match, userId, options = {}) {
  if (!match || match.status !== MATCH_STATUS.PENDING) return false;
  return canConfirmIdentity(match, userId, options);
}

/**
/**
 * 这场比赛现在还轮不轮得到指派 / 改派 / 取消裁判。
 *
 * 只在「待确认」期间可动：已生效（ACTIVE）的成绩一经结算即为最终结论
 * （Elo 逐场结算改造：确认即结算、无撤销），已作废的场次本就不该再执法。
 * 这样不会出现「改历史」——已经打完并盖章的成绩，不能事后换一个裁判来
 * 背书（§5.2 第 4 条）。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function canAssignReferee(match) {
  return Boolean(match) && match.status === MATCH_STATUS.PENDING;
}

/**
 * 指派 / 改派 / 取消裁判要写进比赛记录的字段。
 *
 * refereeId 传空串即取消裁判。refereeAt / refereeBy 是审计字段：取消时
 * 同样记下「谁在什么时候取消的」，事后追责才追得到人。
 *
 * 与录入比分同一纪律：这个纯函数只负责组装字段，不校验权限——「谁能指派」
 * 由调用方（服务端 / mock）按 canManage 判，界面说了不算。
 *
 * @param {string} refereeId 裁判会员编号；空串 = 取消
 * @param {Object} [ctx]
 * @param {string} [ctx.actorId] 操作人编号（审计）
 * @param {Date} [ctx.now] 操作时间
 * @returns {Object}
 */
function buildRefereePatch(refereeId, ctx = {}) {
  const { actorId = '', now = new Date() } = ctx;
  return {
    referee: String(refereeId || '').trim(),
    refereeAt: now,
    refereeBy: actorId,
  };
}

/**
 * 这场比赛是否「还没比分、等着有人来录」。
 *
 * 抽签排出来的比赛天生没有比分，胜方要等赛后录入才产生。此时状态虽是
 * 待确认，却不能像日常约球那样直接「确认」——把一场没有胜方的比赛
 * 确认生效，回放算等级分时会读到一个空 win，整条赛季回放都会崩。
 *
 * 【为什么单独一个函数，而不并进 canConfirm】
 * canConfirm 回答的是「这个人有没有资格确认」，与「这场比赛有没有可确认
 * 的内容」是两回事：录分后该由谁确认，规则不变；只是没比分前谁都确认
 * 不了。分开表述，界面才好分别给出「录分」与「确认」两个入口。
 *
 * @param {Object} match
 * @returns {boolean}
 */
function needsScore(match) {
  return Boolean(match) && match.status === MATCH_STATUS.PENDING && !match.winner;
}

/**
 * 能不能给这场比赛记弃权（M5-3）。
 *
 * 【为什么只有个人赛走这里】
 * 学院赛小场的弃权是「学院丢一项」，由管理员在大场页操作（college-handlers
 * 的 recordForfeit），落点是 tie 不是 match。个人赛没有大场这层，弃权就是
 * 一个人的事（D41），所以另开一条路，靠 competition 把两者分开，免得
 * 两套规则在同一函数里互相牵扯。
 *
 * 【为什么约球不能弃权】
 * 日常约球没有「晋级」这回事，弃了也不影响谁；没有 eventId 就一律拒绝。
 *
 * 【为什么本人之外还放管理员】
 * D41 说「本人可以自选弃权」，但临场没到场、又不肯掏手机的人总得有人收口。
 * 管理员口径与「可确认 / 可撤销任意一场」对齐——他本就能替这场比赛下结论，
 * 再挡一次弃权只是逼他先去改比分，反而留下假成绩。
 *
 * @param {Object} match
 * @param {string} forfeitBy 弃权者编号，必须是场上的人
 * @param {string} actorId 操作者编号
 * @param {Object} [options]
 * @param {number} [options.role=ROLE.MEMBER] 操作者角色
 * @returns {boolean}
 */
function canForfeit(match, forfeitBy, actorId, options = {}) {
  const { role = ROLE.MEMBER } = options;

  if (!match || !forfeitBy || !actorId) return false;
  // 赛事比赛才谈得上弃权与晋级
  if (!match.eventId) return false;
  // 学院赛小场有自己的一套（记给学院），别从这条路进来
  if (match.competition === MATCH_COMPETITION.COLLEGE) return false;
  // 已生效的成绩要改，走撤销；已作废的不必再弃
  if (match.status !== MATCH_STATUS.PENDING) return false;
  // 弃权的是场上的人，不是随便谁
  if (!isParticipant(match, forfeitBy)) return false;

  if (Number(role) >= ROLE.ADMIN) return true;
  return actorId === forfeitBy;
}

/**
 * 弃权要写进比赛记录的字段（M5-3）。
 *
 * 与学院赛弃权（college-handlers.recordForfeit）同一形状：比分清空、胜方
 * 判给对手、状态直接生效，结果性质由 outcome 表达。这样个人赛与学院赛的
 * 弃权在回放侧走同一条路——isEloEligibleMatch 只认 outcome，不计 ELO。
 *
 * 【为什么胜方由 forfeitBy 推出，而不是调用方传入】
 * 与录入比分同一纪律：胜负是算出来的事实，不是填进来的参数。传入 winner
 * 就等于给了「让 A 弃权却判 B 赢」的错配空间。
 *
 * @param {Object} match
 * @param {string} forfeitBy 弃权者编号
 * @param {Object} ctx
 * @param {string} ctx.actorId 操作者编号
 * @param {Date} [ctx.now]
 * @returns {Object}
 */
function buildForfeitPatch(match, forfeitBy, ctx = {}) {
  const { actorId = '', now = new Date() } = ctx;
  const side = sideOf(match, forfeitBy);
  // 站在 A 边的人弃权，就是 B 边获胜
  const winner = side === 'A' ? TEAM.B : TEAM.A;

  return {
    outcome: MATCH_OUTCOME.FORFEIT,
    forfeitBy,
    winner,
    scoreA: [],
    scoreB: [],
    recorder: actorId,
    status: MATCH_STATUS.ACTIVE,
    action: 'forfeit',
    actor: actorId,
    actedAt: now,
  };
}

/**
 * 把一行输入转成比分。
 * 空行返回 null（而不是 0），非数字返回 NaN——两者交给校验去报错，
 * 在这里悄悄当成 0 会让「11:0」和「没填」看起来一模一样。
 *
 * @param {*} value
 * @returns {number|null}
 */
function toScore(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : NaN;
}

/**
 * 把逐局比分的原始输入（多半是表单里的字符串）整理成数字数组。
 *
 * 尾部的空行会被去掉：局制决定了渲染几行输入框，但一局一胜的人
 * 只会填第一行，后面两行空着不该被当成「填了空比分」。
 * 中间的空行则保留，让它变成一个明确的错误而不是被悄悄跳过。
 *
 * @param {Array<*>} rawScores
 * @returns {Array<number|null>} ['11','9',''] → [11, 9]
 */
function normalizeScores(rawScores) {
  const list = Array.isArray(rawScores) ? rawScores.map(toScore) : [];
  while (list.length > 0 && list[list.length - 1] === null) list.pop();
  return list;
}

/** 把会员列表（对象或编号）整理成一个编号集合，非数组时返回 null（表示不校验） */
function rosterIds(members) {
  if (!Array.isArray(members)) return null;
  return new Set(
    members.map((item) => (typeof item === 'string' ? item : item && item._id)).filter(Boolean)
  );
}

/**
 * 校验一支队伍。
 * @returns {string} 错误文案，合法时为空串
 */
function checkTeam(team, matchType, roster) {
  const size = TEAM_SIZE[matchType];
  if (!size) return '请先选择单打或双打';

  if (!Array.isArray(team) || team.length !== size) {
    return size === 1 ? '请选择参赛会员' : `双打每队需要 ${size} 位会员`;
  }
  if (new Set(team).size !== team.length) return '同一位会员不能重复出现在一队里';
  if (roster && team.some((id) => !roster.has(id))) return '有参赛会员不在名单中';

  return '';
}

/** 两队之间有没有重叠的人 */
function overlapOf(teamA, teamB) {
  const inB = new Set(Array.isArray(teamB) ? teamB : []);
  return (Array.isArray(teamA) ? teamA : []).filter((id) => inB.has(id));
}

/**
 * 抢七小分归一。
 *
 * 抢七不参与胜负判定（盘比分 7:6 已经决定了谁赢），它只是比分后面那个
 * 括号（7:6(5)）。所以这里不做严格校验，只把形状收干净：脏数据不该
 * 让整条比赛写不进去；但形状不对的条目要丢掉，免得渲染出奇怪的括号。
 *
 * @param {Array<Object>} list [{ setIndex, a, b }]
 * @returns {Array<{setIndex:number, a:number, b:number}>}
 */
function normalizeTiebreaks(list) {
  return (Array.isArray(list) ? list : [])
    .map((item, index) => ({
      setIndex: Number.isInteger(item && item.setIndex) ? item.setIndex : index,
      a: Number(item && item.a) || 0,
      b: Number(item && item.b) || 0,
    }))
    // 打平的（含 0:0 这种脏数据）与负数丢掉。注意输方 0 分是**合法**的：
    // 抢七 7:0 的官方记法就是 7:6(0)，不能因为「0 看起来像没填」就吞掉。
    .filter((item) => item.a >= 0 && item.b >= 0 && item.a !== item.b);
}

/**
 * 组装并校验一条待确认的比赛记录。
 *
 * 校验顺序刻意从「粗」到「细」：先确认项目与赛制，再看人有没有选对，
 * 最后才逐局核分。这样一个人只选了双打却没选人时，看到的会是
 * 「请选择参赛会员」而不是一条莫名其妙的比分错误。
 *
 * @param {Object} params
 * @param {number} params.matchType 比赛类型，取值见 constants.MATCH_TYPE
 * @param {Array<string>} params.teamA
 * @param {Array<string>} params.teamB
 * @param {Array<*>} params.scoreA A 队逐局比分（原始输入）
 * @param {Array<*>} params.scoreB B 队逐局比分
 * @param {number} params.gamePoints 分制
 * @param {number} params.bestOf 局制
 * @param {Date|string|number} params.matchTime 比赛时间
 * @param {string} [params.location] 场地
 * @param {string} [params.recorder] 录入者，默认取 A 队第一位
 * @param {string|null} [params.eventId] 所属赛事；日常约球留空
 * @param {Object} [options]
 * @param {Array<Object|string>} [options.members] 会员名单，传了就校验参赛者在名单内
 * @param {Date|string|number} [options.now] 当前时间，注入以便测试
 * @param {Date|string|number} [options.minMatchTime] 时间下界（赛季首场）
 * @returns {{ok:boolean, record:Object|null, errors:Object, scoreErrors:string[], firstError:string}}
 */
function buildMatchRecord(params = {}, options = {}) {
  const {
    matchType,
    teamA,
    teamB,
    scoreA,
    scoreB,
    gamePoints,
    bestOf,
    scoring,
    setGames,
    tiebreakAt,
    tiebreakPoints,
    noAd,
    tiebreaks,
    matchTime,
    location = '',
    recorder,
    eventId = null,
  } = params;
  const { members, now, minMatchTime } = options;

  const errors = {};
  const pool = MATCH_TYPE_TO_POOL[matchType];

  // ---------- 1. 项目 ----------
  if (!pool) {
    errors.matchType = '请选择单打或双打';
  }

  // ---------- 2. 赛制 ----------
  // 网球与其余项目的赛制形状不同：它没有「每局几分」，多一个「每盘几局」。
  // 只有明确标了 tennis 才走三层口径，缺省一律按 point（历史记录都没有
  // scoring 字段，不能因为多了个字段解释就把老比赛判成非法）。
  const isTennis = scoring === 'tennis';
  const format = isTennis
    ? { scoring: 'tennis', bestOf, setGames, tiebreakAt, tiebreakPoints, noAd }
    : { gamePoints, bestOf };

  if (!isValidFormat(format)) {
    errors.format = isTennis
      ? '请选择有效的盘制与每盘局数'
      : '请选择有效的分制与局制';
  }

  // ---------- 3. 参赛者 ----------
  const roster = rosterIds(members);
  const teamAError = checkTeam(teamA, matchType, roster);
  if (teamAError) errors.teamA = teamAError;

  const teamBError = checkTeam(teamB, matchType, roster);
  if (teamBError) errors.teamB = teamBError;

  if (!errors.teamA && !errors.teamB && overlapOf(teamA, teamB).length > 0) {
    errors.teamB = '同一位会员不能同时出现在两队';
  }

  // ---------- 4. 时间 ----------
  const time = matchTime === null || matchTime === undefined ? null : new Date(matchTime);
  if (!time || Number.isNaN(time.getTime())) {
    errors.matchTime = '请选择比赛时间';
  } else if (minMatchTime && time.getTime() < new Date(minMatchTime).getTime()) {
    errors.matchTime = '比赛时间不能早于本赛季首场比赛';
  } else if (now && time.getTime() > new Date(now).getTime()) {
    errors.matchTime = '比赛时间不能晚于现在';
  }

  // ---------- 5. 比分 ----------
  const normalizedA = normalizeScores(scoreA);
  const normalizedB = normalizeScores(scoreB);
  let winner = null;
  let scoreErrors = [];

  // 赛制不合法时 validateMatchScore 只会报「赛制不合法」，重复且没用，
  // 所以跳过，让上面那条 errors.format 单独把话说清楚
  if (!errors.format) {
    const result = validateMatchScore(normalizedA, normalizedB, format);
    winner = result.winner;
    scoreErrors = result.errors;
  }

  const firstError =
    errors.matchType ||
    errors.format ||
    errors.teamA ||
    errors.teamB ||
    errors.matchTime ||
    scoreErrors[0] ||
    '';

  if (firstError) {
    return { ok: false, record: null, errors, scoreErrors, firstError };
  }

  return {
    ok: true,
    record: {
      matchType,
      // 池必须跟着记录一起写死：漏了会被 getMatches({ pool }) 静默过滤掉，
      // 比赛录进去却哪儿都查不到，是最难排查的一类问题
      pool,
      teamA: [...teamA],
      teamB: [...teamB],
      scoreA: normalizedA,
      scoreB: normalizedB,
      // 赛制与比分同生共死：脱离赛制就看不出 11:9（或 6:4）到底打完没有。
      // 网球多一层「盘」，字段也就不同——两套写法不能混，混了另一端就读不出赛制。
      ...(isTennis
        ? {
            scoring: 'tennis',
            bestOf: format.bestOf,
            setGames: format.setGames,
            tiebreakAt: format.tiebreakAt,
            tiebreakPoints: format.tiebreakPoints,
            noAd: format.noAd === true,
            ...(normalizeTiebreaks(tiebreaks).length > 0
              ? { tiebreaks: normalizeTiebreaks(tiebreaks) }
              : {}),
          }
        : { gamePoints, bestOf }),
      winner,
      location: String(location || '').trim(),
      matchTime: time,
      // 录入方默认是 A 队第一位，与 seed.js 的模拟数据保持一致
      recorder: recorder || (Array.isArray(teamA) ? teamA[0] : null),
      // 抽签生成的赛事比赛带上赛事编号，日常约球留空。
      // 靠它把赛事详情页的对阵与「比赛」页的比赛串成同一批记录
      eventId: eventId || null,
    },
    errors: {},
    scoreErrors: [],
    firstError: '',
  };
}

/**
 * 给抽签生成的待确认比赛补录比分。
 *
 * 【为什么几支队伍、什么赛制不从入参取】
 * 抽签已经把「谁打谁、第几轮、哪个签位」定死了。录分只该补上比分与录入
 * 人；若允许改队伍，签表里写的是一组对阵、记录里却是另一组，账就对不上
 * 了。所以对阵、赛制、时间一律取自那条待确认记录，这里只收比分。
 *
 * 【为什么返回的是补丁而不是整条记录】
 * 签位信息（轮次 / 阶段 / 签位）不在 buildMatchRecord 的产出里，只在这条
 * 既有记录上。调用方拿补丁去合并，才不会把签位冲掉——冲掉了重抽去重
 * 就认不出同一场，比赛会翻倍。
 *
 * @param {Object} match 抽签生成的待确认比赛
 * @param {Object} scores { scoreA, scoreB }
 * @param {Object} [options] 同 buildMatchRecord，另可传 recorder（服务端按登录者填）
 * @returns {{ok:boolean, patch:Object|null, errors:Object, scoreErrors:string[], firstError:string}}
 */
function fillScheduledMatch(match, scores = {}, options = {}) {
  if (!match) {
    return { ok: false, patch: null, errors: {}, scoreErrors: [], firstError: '找不到这场比赛' };
  }
  if (match.status !== MATCH_STATUS.PENDING) {
    return { ok: false, patch: null, errors: {}, scoreErrors: [], firstError: '只有待确认的比赛可以录分' };
  }

  const result = buildMatchRecord(
    {
      matchType: match.matchType,
      teamA: match.teamA,
      teamB: match.teamB,
      scoreA: scores.scoreA,
      scoreB: scores.scoreB,
      // 网球定稿时把抢七小分一起带进来，用来还原 7:6(5) 的括号
      tiebreaks: scores.tiebreaks,
      gamePoints: match.gamePoints,
      bestOf: match.bestOf,
      // 网球补录：赛制同样取自那条待确认记录。这里若能改赛制，
      // 签表里排的「6 局盘」就会被按另一套规则录进去，签表与记录自相矛盾。
      scoring: match.scoring,
      setGames: match.setGames,
      tiebreakAt: match.tiebreakAt,
      tiebreakPoints: match.tiebreakPoints,
      noAd: match.noAd,
      matchTime: match.matchTime,
      location: match.location,
      recorder: options.recorder || match.recorder,
      eventId: match.eventId,
    },
    options
  );

  if (!result.ok) {
    return {
      ok: false,
      patch: null,
      errors: result.errors,
      scoreErrors: result.scoreErrors,
      firstError: result.firstError,
    };
  }

  return {
    ok: true,
    patch: { ...result.record, round: match.round, stage: match.stage, slot: match.slot },
    errors: {},
    scoreErrors: [],
    firstError: '',
  };
}

module.exports = {
  TEAM_SIZE,
  sideOf,
  isParticipant,
  isRecorder,
  involvesCollege,
  hasReferee,
  canRecordScore,
  canConfirm,
  canConfirmIdentity,
  canAssignReferee,
  buildRefereePatch,
  needsScore,
  canForfeit,
  buildForfeitPatch,
  toScore,
  normalizeScores,
  normalizeTiebreaks,
  buildMatchRecord,
  fillScheduledMatch,
};
