/**
 * 协会注册表（多协会的唯一真相源）
 * ============================================================
 * 一个小程序承载校内多个体育协会：匹克球、乒乓球、羽毛球……将来还可能继续加。
 * 各协会「功能完全一致」，差异只有两处：
 *   1. 品牌——名称、简称、图标字、主题色；
 *   2. 少数规则默认值——赛制选项/默认、Elo 锚点、防刷阈值。
 * 这两处都写在这里。业务代码只按当前协会的 id 泛化处理，永远不判断
 * 「是不是匹克球/乒乓/羽毛」，也不写死数量。
 *
 * 【为什么协会是代码而不是数据库】
 * 新增一个协会，必然要有人定它的名称与配色——这本就是一次前端改动。与其
 * 为此建一整套后台增删 + 数据集合，不如把清单放进代码：新增协会 = 在这里
 * 加一条并配品牌，然后发版。加第 N 个协会时，数据、业务逻辑、云端接口都
 * 不用动（隔离靠内容文档上的 association 字段，见施工方案 §四）。
 *
 * 【为什么账号不带协会、内容和角色才带】
 * 账号按 OpenID 全局唯一（注册一次即可）；「是不是某协会的会员」是隐式的
 * （账号在册 + 协会启用），不逐条登记；只有比赛/赛事/公告/学院赛等内容数据
 * 带 association 字段（读过滤、写盖章），以及 memberships 里记协会角色。
 *
 * 【镜像】
 * 本模块是纯计算模块（不碰 wx、不碰 I/O），云端要用同一份清单来校验请求
 * 里的 association 并落地字段，因此列入 tools/sync-cloud-lib.js 的 MANIFEST，
 * 由 tests/cloud-lib-sync.test.js 逐字节守卫。
 * ============================================================
 */

const { DEFAULT_CONFIG } = require('./elo.js');
const {
  SCORING,
  GAME_POINTS_OPTIONS,
  BEST_OF_OPTIONS,
  DEFAULT_FORMAT,
  TENNIS_SET_GAMES_OPTIONS,
  TENNIS_BEST_OF_OPTIONS,
  TENNIS_TIEBREAK_POINTS,
  DEFAULT_TENNIS_FORMAT,
} = require('./match-format.js');
const { RATED_PAIR_LIMIT, ASSOCIATION_STATUS } = require('./constants.js');
const { defaultRulesFor } = require('./basketball-rules.js');
const { createFootballAssociation } = require('./football-association.js');

/**
 * 运动类型。
 *
 * 【为什么要分这个】
 * 球拍运动是「个人 vs 个人」，一场比赛的结果决定个人等级分；篮球、足球、
 * 排球是「球队 vs 球队」，结果是名次与技术统计，**不进个人 Elo**。
 * 两者的工作台页签、赛事模型、录分台、数据集合全都不同，不能靠
 * 「加一个赛制」混过去。业务代码只读这个字段，不判断具体是哪个协会。
 */
const SPORT_TYPE = {
  RACKET: 'racket', // 球拍运动：匹克球 / 乒乓 / 羽球 / 网球
  TEAM: 'team', // 团队运动：篮球 / 足球 / 排球
};

/**
 * 工作台能力。页签由它生成，页面不再假设「每个协会都有排行榜和比赛」。
 *
 * space  协会空间（分组 / 通知 / 训练 / 成员）
 * teams  组队（长期球队、入队申请、队长管理）
 * rank   排行榜（等级分 / 积分，仅球拍运动）
 * match  比赛（个人比赛流水：录分、确认、驳回）
 * events 赛事（个人赛 / 团队赛事）
 */
const CAPABILITY = {
  SPACE: 'space',
  TEAMS: 'teams',
  MY_TEAMS: 'myTeams',
  RANK: 'rank',
  MATCH: 'match',
  EVENTS: 'events',
};

/** 能力 → 页签文案与顺序。顺序即工作台上的先后。 */
const CAPABILITY_TAB = {
  [CAPABILITY.SPACE]: { tab: CAPABILITY.SPACE, label: '协会空间' },
  [CAPABILITY.TEAMS]: { tab: CAPABILITY.TEAMS, label: '组队' },
  [CAPABILITY.MY_TEAMS]: { tab: CAPABILITY.MY_TEAMS, label: '我的球队' },
  [CAPABILITY.RANK]: { tab: CAPABILITY.RANK, label: '排行榜' },
  [CAPABILITY.MATCH]: { tab: CAPABILITY.MATCH, label: '比赛' },
  [CAPABILITY.EVENTS]: { tab: CAPABILITY.EVENTS, label: '赛事' },
};

/** 球拍运动的能力组合 */
const RACKET_CAPABILITIES = Object.freeze([CAPABILITY.SPACE, CAPABILITY.RANK, CAPABILITY.MATCH, CAPABILITY.EVENTS]);
/** 团队运动的能力组合（没有排行榜与个人比赛入口） */
const TEAM_CAPABILITIES = Object.freeze([CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.EVENTS]);

/**
 * 各协会共用的规则默认值。
 *
 * 本期除网球外的协会都沿用现有默认（赛制 11 分制三局两胜、Elo 锚点 1450、
 * 防刷 15 场），与改造前的行为一致。网球在条目里整块覆盖 format（见下），
 * 因为它的计分体系不同——不是换个数字，而是多一层「盘」。
 * 返回新对象，避免各条目之间共享同一份可变引用。
 *
 * @returns {{format: Object, elo: Object, ratedPairLimit: number, sportType: string, capabilities: string[]}}
 */
function baseRules() {
  return {
    sportType: SPORT_TYPE.RACKET,
    capabilities: RACKET_CAPABILITIES.slice(),
    format: {
      scoring: SCORING.POINT,
      gamePointsOptions: GAME_POINTS_OPTIONS.slice(),
      bestOfOptions: BEST_OF_OPTIONS.slice(),
      defaultFormat: { ...DEFAULT_FORMAT },
    },
    elo: { ...DEFAULT_CONFIG },
    ratedPairLimit: RATED_PAIR_LIMIT,
  };
}

/**
 * 团队运动的规则默认值。
 *
 * 与球拍运动的关键差别：**没有 format、没有 elo、没有防刷阈值**——团队赛
 * 不进个人等级分，一场 5v5 也就无所谓「一对会员打了几场」。取而代之的是
 * 规则快照（节数/节长/犯规上限），默认值取自 utils/basketball-rules.js。
 *
 * @param {string} [presetKey] 规则预设
 * @returns {{sportType: string, capabilities: string[], basketballRules: Object}}
 */
function teamRules(presetKey) {
  return {
    sportType: SPORT_TYPE.TEAM,
    teamSportFormat: 'basketball5',
    capabilities: TEAM_CAPABILITIES.slice(),
    basketballRules: defaultRulesFor(presetKey),
  };
}

/**
 * 网球规则：三层计分（分 → 局 → 盘）。
 *
 * 与 baseRules 的差别不只是数值，而是整块换掉：网球没有「每局打到几分」这
 * 个选项（一局恒定 4 分），可变的是「每盘几局」。录入页据 scoring 决定
 * 显示哪组 picker，两套选项不能混在一张表里。
 *
 * @returns {{format: Object, elo: Object, ratedPairLimit: number}}
 */
function tennisRules() {
  const base = baseRules();
  return {
    ...base,
    format: {
      scoring: SCORING.TENNIS,
      setGamesOptions: TENNIS_SET_GAMES_OPTIONS.slice(),
      bestOfOptions: TENNIS_BEST_OF_OPTIONS.slice(),
      tiebreakPoints: TENNIS_TIEBREAK_POINTS,
      defaultFormat: { ...DEFAULT_TENNIS_FORMAT },
    },
  };
}

/**
 * 协会清单。数组顺序即选择页展示顺序；首个启用中的协会是兜底默认。
 *
 * 【字段】
 *   id            写进内容文档的 association 字段，也是 memberships 的协会标识；
 *                 一旦上线不可改（改了等于把历史数据指向别的协会）。
 *   name          全称，用于选择页与页内大标题。
 *   shortName     简称，用于导航栏标题等窄处。
 *   sportName     项目名（2–3 字），用于协会切换徽章、公告页协会标签等极窄处。
 *   logoGlyph     文字徽标（一个汉字），小面积场景（公告 chip、比分行）与图标
 *                 缺失时的兜底。
 *   logoIcon      运动项目线条图标（白色 PNG，透明底），铺在协会主题色的渐变
 *                 圆底上；用于协会选择页与工作台名头等大尺寸场景。纯展示字段，
 *                 云端校验不读它，但镜像同步要求两边一致。
 *   theme         主题色，配合 app.wxss 的 .assoc-<id> 覆盖 CSS 变量。
 *   format/elo/…  规则默认值，见 baseRules()。
 *   status        启用/停用；停用保留历史数据，见 ASSOCIATION_STATUS。
 *
 * 【按 N 个设计】增删协会只动这个数组，不牵动数据与业务逻辑。
 */
const ASSOCIATIONS = [
  {
    id: 'pkb',
    name: '中央民族大学匹克球俱乐部',
    shortName: '民大匹克球',
    sportName: '匹克球',
    logoGlyph: '匹',
    logoIcon: '/assets/assoc/pkb.png',
    theme: {
      // 匹克球 → 蓝
      primary: '#1565C0',
      primaryDark: '#0D47A1',
      primaryLight: '#E3F0FB',
      accent: '#FF7A45',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'tt',
    name: '中央民族大学乒乓球协会',
    shortName: '民大乒乓',
    sportName: '乒乓球',
    logoGlyph: '乒',
    logoIcon: '/assets/assoc/tt.png',
    theme: {
      // 乒乓球 → 深绿（RGB 0,77,64）
      primary: '#004D40',
      primaryDark: '#00332B',
      primaryLight: '#E0F0EC',
      accent: '#C9A227',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'bd',
    name: '中央民族大学羽毛球协会',
    shortName: '民大羽球',
    sportName: '羽毛球',
    logoGlyph: '羽',
    logoIcon: '/assets/assoc/bd.png',
    theme: {
      // 羽毛球 → 紫
      primary: '#6A1B9A',
      primaryDark: '#4A148C',
      primaryLight: '#F3E8F7',
      accent: '#F2994A',
    },
    ...baseRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'tn',
    name: '中央民族大学网球协会',
    shortName: '民大网球',
    sportName: '网球',
    logoGlyph: '网',
    logoIcon: '/assets/assoc/tn.png',
    theme: {
      // 网球 → 草地绿（与乒乓的墨绿 #004D40 靠明度区分，配网球黄做点缀）
      primary: '#2E7D32',
      primaryDark: '#1B5E20',
      primaryLight: '#E8F5E9',
      accent: '#C6D93B',
    },
    // 唯一走三层计分（分 → 局 → 盘）的协会，见 tennisRules()
    ...tennisRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  {
    id: 'bk',
    name: '中央民族大学篮球协会',
    shortName: '民大篮球',
    sportName: '篮球',
    logoGlyph: '篮',
    logoIcon: '/assets/assoc/bk.png',
    theme: {
      // 篮球 → 橙（与匹克球的蓝、网球的草绿拉开；accent 用琥珀，配球体质感）
      primary: '#E65100',
      primaryDark: '#BF360C',
      primaryLight: '#FFF3E0',
      accent: '#F9A825',
    },
    // 团队运动：没有 format / elo，换成规则快照（节数、节长、犯规上限）
    ...teamRules(),
    status: ASSOCIATION_STATUS.ACTIVE,
  },
  createFootballAssociation(),
];

/**
 * 全部协会（含已停用）。
 * 返回浅拷贝：清单只读，调用方改不动数组本身，也拿不到内部数组引用。
 *
 * @returns {Array<Object>}
 */
function allAssociations() {
  return ASSOCIATIONS.slice();
}

/**
 * 仅启用中的协会。选择页与默认值只认这些。
 *
 * @returns {Array<Object>}
 */
function activeAssociations() {
  return ASSOCIATIONS.filter((a) => a.status === ASSOCIATION_STATUS.ACTIVE);
}

/**
 * 按 id 取一个协会。
 *
 * 未知 id **抛错**，不静默退回某个协会——请求带错协会时宁可当场炸，
 * 也不要让数据悄悄落到别的协会名下。
 *
 * @param {string} id
 * @returns {Object}
 */
function getAssociation(id) {
  const found = ASSOCIATIONS.find((a) => a.id === id);
  if (!found) throw new Error(`未知的协会 id：${id}`);
  return found;
}

/**
 * id 是否登记在册（含已停用）。用于校验请求携带的 association。
 *
 * @param {string} id
 * @returns {boolean}
 */
function isKnownAssociation(id) {
  return ASSOCIATIONS.some((a) => a.id === id);
}

/**
 * 兜底默认协会：首个启用中的协会。
 * 一个启用协会都没有时返回空串（调用方应据空串跳过业务，而不是硬闯）。
 *
 * @returns {string}
 */
function defaultAssociationId() {
  const first = activeAssociations()[0];
  return first ? first.id : '';
}

/**
 * 多协会改造之前唯一存在的协会 id。
 *
 * 【为什么要有它】
 * 改造前的内容文档没有 association 字段。迁移脚本会批量回填为这个值，但在
 * 回填完成之前（以及测试夹具里），读取必须把「缺字段」等同于它，否则旧数据
 * 一条都读不出来。**只对缺字段生效**：字段存在但与请求协会不符，一律挡住。
 */
const LEGACY_ASSOCIATION_ID = 'pkb';

/**
 * 一条内容文档是否属于某个协会。
 *
 * 读路径的统一谓词：字段缺省视作 LEGACY_ASSOCIATION_ID（旧数据），字段存在
 * 则要求严格相等——「旧数据归匹克球、新数据各归各协会」一条规则说清。
 *
 * @param {Object|null} doc
 * @param {string} association
 * @returns {boolean}
 */
function belongsToAssociation(doc, association) {
  if (!doc) return false;
  const owner = doc.association || LEGACY_ASSOCIATION_ID;
  return owner === association;
}

/**
 * 某协会的默认比赛赛制（深拷贝）。
 *
 * 抽签铺比赛、学院赛小场这类「没有人现场选赛制」的场合都取它：默认值写
 * 在注册表里，只有这一份，不会出现「录入页按 11 分制、签表按别的」这种事。
 * 未知协会回落到匹克球口径，绝不抛错——那会让整个抽签失败。
 *
 * @param {string} id
 * @returns {Object}
 */
function defaultFormatOf(id) {
  try {
    return { ...getAssociation(id).format.defaultFormat };
  } catch (err) {
    return { ...DEFAULT_FORMAT };
  }
}

/**
 * 某协会的运动类型。
 *
 * 未知 id 按球拍运动处理：这是改造前的唯一类型，旧数据与旧调用方都按它
 * 工作，兜底成 team 会让它们全部走到没有实现的分支上。
 *
 * @param {string} id
 * @returns {'racket'|'team'}
 */
function sportTypeOf(id) {
  try {
    return getAssociation(id).sportType === SPORT_TYPE.TEAM ? SPORT_TYPE.TEAM : SPORT_TYPE.RACKET;
  } catch (err) {
    return SPORT_TYPE.RACKET;
  }
}

/** 是否团队运动（篮球/足球/排球）。个人赛录分等入口据此拒绝。 */
function isTeamSport(id) {
  return sportTypeOf(id) === SPORT_TYPE.TEAM;
}

/**
 * 某协会工作台的能力组合（副本）。
 * 页面据它生成页签与挂载的面板，不再假设「每个协会都有排行榜」。
 *
 * @param {string} id
 * @returns {string[]}
 */
function capabilitiesOf(id) {
  try {
    const caps = getAssociation(id).capabilities;
    return Array.isArray(caps) && caps.length ? caps.slice() : RACKET_CAPABILITIES.slice();
  } catch (err) {
    return RACKET_CAPABILITIES.slice();
  }
}

/**
 * 某协会工作台的页签（{ tab, label } 数组），顺序固定为
 * 协会空间 → 组队 → 排行榜 → 比赛 → 赛事，只保留该协会有能力的那几个。
 *
 * @param {string} id
 * @returns {Array<{tab:string,label:string}>}
 */
function workbenchTabsOf(id) {
  const caps = capabilitiesOf(id);
  return [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.RANK, CAPABILITY.MATCH, CAPABILITY.EVENTS]
    .filter((tab) => caps.includes(tab))
    .map((tab) => ({ ...CAPABILITY_TAB[tab] }));
}

/**
 * 团队运动的默认规则快照（深拷贝）。球拍运动返回 null。
 *
 * @param {string} id
 * @returns {Object|null}
 */
function basketballRulesOf(id) {
  try {
    const assoc = getAssociation(id);
    if (assoc.sportType !== SPORT_TYPE.TEAM || !assoc.basketballRules
      || (assoc.teamSportFormat && assoc.teamSportFormat !== 'basketball5')) return null;
    return { ...assoc.basketballRules };
  } catch (err) {
    return null;
  }
}

module.exports = {
  allAssociations,
  activeAssociations,
  getAssociation,
  isKnownAssociation,
  defaultAssociationId,
  defaultFormatOf,
  sportTypeOf,
  isTeamSport,
  capabilitiesOf,
  workbenchTabsOf,
  basketballRulesOf,
  SPORT_TYPE,
  CAPABILITY,
  CAPABILITY_TAB,
  LEGACY_ASSOCIATION_ID,
  belongsToAssociation,
};
