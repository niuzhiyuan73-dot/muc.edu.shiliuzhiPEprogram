/**
 * 运动会项目模板库（B1）
 * ============================================================
 * 46 条静态元数据，对应决策文档 4.1「十类全部启用」。这份表**只是项目库**，
 * 不是某一届运动会的规则：限额、组别、每队人数、是否预赛决赛、是否计分
 * 都由创建运动会时逐项目填写（N11／N12）。
 *
 * 【为什么要有 order 与 entryForm，而不是只有名字】
 * 计分引擎不能靠项目名分支。三个字段承担三种语义：
 *   - scoreType：怎么读这个数（时间/距离/高度/次数/评分/赛制）
 *   - order：越小越好还是越大越好。计时是 asc，距离次数评分是 desc，
 *     胜负项目没有数值方向（bracket）。
 *   - entryForm：一条参赛记录是「1 个人」「固定 N 人的一组」还是「一支队」。
 *     这个区分直接决定限额单位（人数/组数/队数）与兼项口径
 *     （single 与 group 计入个人 2 项额度，team 不计入，见 D35）。
 *
 * 【order / unit / defaultScored 为什么是推导出来的】
 * 手写这三列必然出现「计时项目写成 desc」这类错，而且改一处忘一处。
 * 它们一律由 scoreType 与 category 推导（`normalizeTemplate`），
 * 测试再反向断言推导结果，结构上不给不一致留口子。
 *
 * 【计分口径（N16）】
 * 评分展示类（广播体操、健美操、啦啦操、武术展示、入场式展示）默认不计分，
 * 只记录成绩与名次；趣味类默认计分。这是 `defaultScored` 的唯一来源，
 * 创建运动会时可以逐项目覆盖，但默认值不接受实现者自行改。
 * ============================================================
 */

/** 成绩类型。`versus` 不打分，只产赛制名次（拔河）。 */
const MEET_SCORE_TYPE = Object.freeze({
  TIME: 'time',
  DISTANCE: 'distance',
  HEIGHT: 'height',
  COUNT: 'count',
  SCORE: 'score',
  VERSUS: 'versus',
});

/** 排序方向。 */
const MEET_ORDER = Object.freeze({
  ASC: 'asc',
  DESC: 'desc',
  BRACKET: 'bracket',
});

/** 参赛形态：单人／固定人数组／队伍。 */
const MEET_ENTRY_FORM = Object.freeze({
  SINGLE: 'single',
  GROUP: 'group',
  TEAM: 'team',
});

/** 组别（D44 只分男女混合三类，逐项目逐届勾选）。 */
const MEET_GROUP = Object.freeze({
  MALE: 'male',
  FEMALE: 'female',
  MIXED: 'mixed',
});

/** 项目分类（项目选择器内的筛选控件，不是栏目一级标签）。 */
const MEET_CATEGORY = Object.freeze({
  SPRINT: 'sprint',
  MIDDLE: 'middle',
  HURDLE: 'hurdle',
  RELAY: 'relay',
  JUMP: 'jump',
  THROW: 'throw',
  TEAM: 'team',
  FUN: 'fun',
  REPS: 'reps',
  SHOW: 'show',
});

/** 分类展示顺序与中文名。 */
const CATEGORY_ORDER = Object.freeze([
  MEET_CATEGORY.SPRINT,
  MEET_CATEGORY.MIDDLE,
  MEET_CATEGORY.HURDLE,
  MEET_CATEGORY.RELAY,
  MEET_CATEGORY.JUMP,
  MEET_CATEGORY.THROW,
  MEET_CATEGORY.TEAM,
  MEET_CATEGORY.FUN,
  MEET_CATEGORY.REPS,
  MEET_CATEGORY.SHOW,
]);

const CATEGORY_LABEL = Object.freeze({
  [MEET_CATEGORY.SPRINT]: '短跑',
  [MEET_CATEGORY.MIDDLE]: '中长跑',
  [MEET_CATEGORY.HURDLE]: '跨栏/障碍',
  [MEET_CATEGORY.RELAY]: '接力',
  [MEET_CATEGORY.JUMP]: '跳跃',
  [MEET_CATEGORY.THROW]: '投掷',
  [MEET_CATEGORY.TEAM]: '团体',
  [MEET_CATEGORY.FUN]: '趣味',
  [MEET_CATEGORY.REPS]: '次数',
  [MEET_CATEGORY.SHOW]: '评分展示',
});

/**
 * 分批方式：一个项目怎么切成多个场次。
 *
 * 这是 2026-10-18 审查补上的一个**模型缺口**。此前所有项目都按「每组 = 跑道数」
 * 分批，后果是 1500 米 30 人被拆成 5 组、跳远 30 人被拆成 5 枪——前者规则上
 * 应 15 人一组，后者根本不该分批。
 *
 *   - lane：分道跑，一批 = 道数（8 道场地一批 8 人 / 8 队）
 *   - capacity：不分道或按顺序，一批 = 人数上限（长跑 15、次数 10、趣味 6）
 *   - single：不分批，一个场次按顺序进行（田赛试跳、评分展示依次上场）
 */
const HEAT_MODE = Object.freeze({
  LANE: 'lane',
  CAPACITY: 'capacity',
  SINGLE: 'single',
});

/** 默认道数。8 条跑道的场地最常见；6 道场地在编排时逐项目改。 */
const DEFAULT_LANE_CAPACITY = 8;

/**
 * 少数项目不能套用分类默认值，按 id 单列。
 *
 * 迎面接力与运球/障碍接力都是「队伍接力」，一批只能同时跑 2 队（场地宽可改 4），
 * 不是分类默认的 6——按 6 排会让 12 支队伍挤进一场。
 */
const CAPACITY_BY_ID = Object.freeze({
  steeplechase: 15,   // 障碍跑：不分道，按人数分批
  'relay-shuttle': 2, // 迎面接力：两队对向跑
  'fun-dribble': 2,   // 运球接力：队伍接力
  'fun-obstacle': 2,  // 障碍接力：队伍接力
});

/** 按分类的默认每批上限（仅 capacity 模式使用）。 */
const CAPACITY_BY_CATEGORY = Object.freeze({
  [MEET_CATEGORY.MIDDLE]: 15,
  [MEET_CATEGORY.REPS]: 10,
  [MEET_CATEGORY.FUN]: 6,
  [MEET_CATEGORY.TEAM]: 6,
});

/**
 * 不分批的分类：田赛按抽签顺序试跳/试投，评分展示按队伍依次上场。
 *
 * 这两类若也允许分组，赛程页会出现「跳远 决赛 第 3 枪」这种不存在的形态。
 */
const SINGLE_HEAT_CATEGORIES = Object.freeze([
  MEET_CATEGORY.JUMP,
  MEET_CATEGORY.THROW,
  MEET_CATEGORY.SHOW,
]);

/**
 * 推导一个项目的分批规则。
 *
 * 与 order / unit / defaultScored 一样由分类推导，**不接受手写**：
 * 手写 46 行必然出现「跳远写了 lane」这类错，而且改一处忘一处。
 *
 * @returns {{heatMode: string|null, heatCapacity: number}} 胜负项目不分批，返回 null
 */
function heatRuleOf({ id, category, scoreType }) {
  // 拔河走签表，没有「一批几个人」的概念
  if (scoreType === MEET_SCORE_TYPE.VERSUS) return { heatMode: null, heatCapacity: 0 };
  if (SINGLE_HEAT_CATEGORIES.includes(category)) {
    return { heatMode: HEAT_MODE.SINGLE, heatCapacity: 0 };
  }
  // 逐个 id 的特例优先：障碍跑在跨栏分类里，迎面接力在接力分类里
  const byId = CAPACITY_BY_ID[id];
  if (byId) return { heatMode: HEAT_MODE.CAPACITY, heatCapacity: byId };

  if (category === MEET_CATEGORY.SPRINT
    || category === MEET_CATEGORY.HURDLE
    || category === MEET_CATEGORY.RELAY) {
    return { heatMode: HEAT_MODE.LANE, heatCapacity: DEFAULT_LANE_CAPACITY };
  }
  return {
    heatMode: HEAT_MODE.CAPACITY,
    heatCapacity: CAPACITY_BY_CATEGORY[category] || 6,
  };
}

/** scoreType → 排序方向。计时越小越好，其余数值越大越好，赛制无名次方向。 */
const ORDER_BY_SCORE_TYPE = Object.freeze({
  [MEET_SCORE_TYPE.TIME]: MEET_ORDER.ASC,
  [MEET_SCORE_TYPE.DISTANCE]: MEET_ORDER.DESC,
  [MEET_SCORE_TYPE.HEIGHT]: MEET_ORDER.DESC,
  [MEET_SCORE_TYPE.COUNT]: MEET_ORDER.DESC,
  [MEET_SCORE_TYPE.SCORE]: MEET_ORDER.DESC,
  [MEET_SCORE_TYPE.VERSUS]: MEET_ORDER.BRACKET,
});

/** scoreType → 计量单位。 */
const UNIT_BY_SCORE_TYPE = Object.freeze({
  [MEET_SCORE_TYPE.TIME]: '秒',
  [MEET_SCORE_TYPE.DISTANCE]: '米',
  [MEET_SCORE_TYPE.HEIGHT]: '米',
  [MEET_SCORE_TYPE.COUNT]: '次',
  [MEET_SCORE_TYPE.SCORE]: '分',
  [MEET_SCORE_TYPE.VERSUS]: null,
});

/**
 * 原始表：`[id, 名称, 别名, 分类, 成绩类型, 参赛形态, 建议人数, 推荐组别]`。
 *
 * `建议人数` 只是创建表单的初始值，可以被管理员改写；唯一强制的是
 * 三人板鞋必须 3 人成组（B2），由 `fixedMembers` 另行标注。
 */
const RAW_TEMPLATES = [
  // 短跑（5）
  ['sprint-50m', '50 米', ['五十米'], 'sprint', 'time', 'single', 1, ['male', 'female']],
  ['sprint-60m', '60 米', ['六十米'], 'sprint', 'time', 'single', 1, ['male', 'female']],
  ['sprint-100m', '100 米', ['一百米', '百米'], 'sprint', 'time', 'single', 1, ['male', 'female']],
  ['sprint-200m', '200 米', ['二百米'], 'sprint', 'time', 'single', 1, ['male', 'female']],
  ['sprint-400m', '400 米', ['四百米'], 'sprint', 'time', 'single', 1, ['male', 'female']],

  // 中长跑（6）
  ['middle-800m', '800 米', ['八百米'], 'middle', 'time', 'single', 1, ['male', 'female']],
  ['middle-1000m', '1000 米', ['一千米'], 'middle', 'time', 'single', 1, ['male', 'female']],
  ['middle-1500m', '1500 米', ['一千五百米'], 'middle', 'time', 'single', 1, ['male', 'female']],
  ['middle-3000m', '3000 米', ['三千米'], 'middle', 'time', 'single', 1, ['male', 'female']],
  ['middle-5000m', '5000 米', ['五千米'], 'middle', 'time', 'single', 1, ['male', 'female']],
  ['middle-10000m', '10000 米', ['一万米'], 'middle', 'time', 'single', 1, ['male', 'female']],

  // 跨栏 / 障碍（4）
  ['hurdle-100m', '100 米栏', ['百米栏'], 'hurdle', 'time', 'single', 1, ['female']],
  ['hurdle-110m', '110 米栏', ['一百一十米栏'], 'hurdle', 'time', 'single', 1, ['male']],
  ['hurdle-400m', '400 米栏', ['四百米栏'], 'hurdle', 'time', 'single', 1, ['male', 'female']],
  ['steeplechase', '障碍跑', ['3000 米障碍', '障碍赛'], 'hurdle', 'time', 'single', 1, ['male', 'female']],

  // 接力（4）
  ['relay-4x100', '4×100 米', ['4*100 米', '4x100 米'], 'relay', 'time', 'team', 4, ['male', 'female']],
  ['relay-4x400', '4×400 米', ['4*400 米', '4x400 米'], 'relay', 'time', 'team', 4, ['male', 'female']],
  ['relay-medley', '混合接力', ['男女混合接力'], 'relay', 'time', 'team', 4, ['mixed']],
  ['relay-shuttle', '迎面接力', ['穿梭接力', '对向接力'], 'relay', 'time', 'team', 10, ['mixed']],

  // 跳跃（4）
  ['jump-high', '跳高', [], 'jump', 'height', 'single', 1, ['male', 'female']],
  ['jump-long', '跳远', ['急行跳远'], 'jump', 'distance', 'single', 1, ['male', 'female']],
  ['jump-triple', '三级跳远', ['三级跳'], 'jump', 'distance', 'single', 1, ['male', 'female']],
  ['jump-standing', '立定跳远', [], 'jump', 'distance', 'single', 1, ['male', 'female']],

  // 投掷（5）
  ['throw-shot', '铅球', ['推铅球'], 'throw', 'distance', 'single', 1, ['male', 'female']],
  ['throw-medicine', '实心球', ['抛实心球'], 'throw', 'distance', 'single', 1, ['male', 'female']],
  ['throw-softball', '垒球', ['投垒球'], 'throw', 'distance', 'single', 1, ['male', 'female']],
  ['throw-javelin', '标枪', ['投标枪'], 'throw', 'distance', 'single', 1, ['male', 'female']],
  ['throw-discus', '铁饼', ['掷铁饼'], 'throw', 'distance', 'single', 1, ['male', 'female']],

  // 团体（2）
  ['tug-of-war', '拔河', [], 'team', 'versus', 'team', 10, ['mixed']],
  ['team-rope', '团体跳绳', ['长绳', '跳大绳'], 'team', 'count', 'team', 10, ['mixed']],

  // 趣味（8）
  ['fun-three-leg', '两人三足', ['二人三足'], 'fun', 'time', 'group', 2, ['mixed']],
  ['fun-multi-leg', '多人绑腿跑', ['多人多足'], 'fun', 'time', 'group', 5, ['mixed']],
  ['fun-kangaroo', '袋鼠跳', ['麻袋跳'], 'fun', 'time', 'single', 1, ['mixed']],
  ['fun-dribble', '运球接力', ['运球跑'], 'fun', 'time', 'team', 4, ['mixed']],
  ['fun-balance', '托球跑', ['托球接力'], 'fun', 'time', 'single', 1, ['mixed']],
  ['fun-obstacle', '障碍接力', ['障碍跑接力'], 'fun', 'time', 'team', 4, ['mixed']],
  ['fun-clogs', '三人板鞋', ['板鞋竞速'], 'fun', 'time', 'group', 3, ['mixed']],
  ['fun-stilts', '高脚马', ['踩高跷'], 'fun', 'time', 'single', 1, ['mixed']],

  // 次数（3）
  ['reps-rope', '一分钟跳绳', ['跳绳'], 'reps', 'count', 'single', 1, ['male', 'female']],
  ['reps-shuttlecock', '踢毽子', ['毽子'], 'reps', 'count', 'single', 1, ['male', 'female']],
  ['reps-basketball', '定点投篮', ['投篮'], 'reps', 'count', 'single', 1, ['male', 'female']],

  // 评分展示（5）
  ['show-gymnastics', '广播体操', ['广播操'], 'show', 'score', 'team', 10, ['mixed']],
  ['show-aerobics', '健美操', [], 'show', 'score', 'team', 10, ['mixed']],
  ['show-cheer', '啦啦操', ['啦啦队'], 'show', 'score', 'team', 10, ['mixed']],
  ['show-martial', '武术展示', ['武术'], 'show', 'score', 'team', 5, ['mixed']],
  ['show-parade', '入场式展示', ['入场式'], 'show', 'score', 'team', 20, ['mixed']],
];

/** 声明式强制人数：这些项目的人数不允许被创建表单改写。 */
const FIXED_MEMBERS = Object.freeze({
  'fun-clogs': 3,
  'fun-three-leg': 2,
});

/** 全角转半角（数字与字母），并折叠乘号变体，去掉空白。 */
function normalizeKeyword(input) {
  const text = String(input == null ? '' : input);
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    // 全角 ASCII 区（！-～）平移到半角
    out += code >= 0xff01 && code <= 0xff5e ? String.fromCharCode(code - 0xfee0) : ch;
  }
  return out
    .replace(/[\u3000\s]+/g, '')
    .replace(/[×✕✖＊*]/g, 'x')
    .toLowerCase();
}

/** 由原始行推导完整模板（order / unit / defaultScored 不接受手写）。 */
function normalizeTemplate(row) {
  const [id, name, aliases, category, scoreType, entryForm, defaultMembers, recommendedGroups] = row;
  const heat = heatRuleOf({ id, category, scoreType });
  return Object.freeze({
    id,
    name,
    aliases: Object.freeze([...aliases]),
    category,
    scoreType,
    order: ORDER_BY_SCORE_TYPE[scoreType],
    entryForm,
    defaultMembers,
    fixedMembers: FIXED_MEMBERS[id] || null,
    recommendedGroups: Object.freeze([...recommendedGroups]),
    unit: UNIT_BY_SCORE_TYPE[scoreType],
    // 分批规则：怎么切成多个场次（审查 C1/C2 的落点）
    heatMode: heat.heatMode,
    heatCapacity: heat.heatCapacity,
    // N16：评分展示类默认不计分，其余默认计分。
    defaultScored: category !== MEET_CATEGORY.SHOW,
    // 胜负项目不走数值排序，也不允许配预赛＋决赛之外的赛制由 B7 决定。
    numeric: scoreType !== MEET_SCORE_TYPE.VERSUS,
    keywordIndex: Object.freeze(
      [name, ...aliases, id].map(normalizeKeyword).filter(Boolean),
    ),
  });
}

const TEMPLATES = Object.freeze(RAW_TEMPLATES.map(normalizeTemplate));

const BY_ID = new Map(TEMPLATES.map((item) => [item.id, item]));

/** 取单个模板；不存在返回 null（调用方决定报错文案）。 */
function getTemplate(id) {
  return BY_ID.get(String(id || '')) || null;
}

/**
 * 按关键词与分类搜项目。
 *
 * 关键词匹配是「归一后包含」：`100米`、`百米`、`１００米` 命中同一项；
 * `4*100` 与 `4×100` 等价。空关键词返回该分类全部。
 */
function searchTemplates(keyword, options = {}) {
  const needle = normalizeKeyword(keyword);
  const category = options.category ? String(options.category) : '';
  return TEMPLATES.filter((item) => {
    if (category && item.category !== category) return false;
    if (!needle) return true;
    return item.keywordIndex.some((text) => text.includes(needle));
  });
}

/** 按分类分组（项目选择器用；组内保持 4.1 的顺序）。 */
function listByCategory() {
  return CATEGORY_ORDER.map((category) => ({
    category,
    label: CATEGORY_LABEL[category],
    items: TEMPLATES.filter((item) => item.category === category),
  }));
}

module.exports = {
  MEET_SCORE_TYPE,
  MEET_ORDER,
  MEET_ENTRY_FORM,
  MEET_GROUP,
  MEET_CATEGORY,
  HEAT_MODE,
  DEFAULT_LANE_CAPACITY,
  CATEGORY_ORDER,
  CATEGORY_LABEL,
  TEMPLATES,
  getTemplate,
  searchTemplates,
  listByCategory,
  normalizeKeyword,
  heatRuleOf,
};
