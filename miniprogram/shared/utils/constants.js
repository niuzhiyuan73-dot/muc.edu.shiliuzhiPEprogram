/**
 * 全局常量定义
 * ============================================================
 * 全项目共用一套枚举值，避免在代码里散落魔法数字。
 *
 * 【为什么用数字而不是字符串存数据库】
 * 数字占用空间小，且比较效率高。但直接在代码里写 `status === 1`
 * 很难维护，所以统一在这里定义具名常量。
 *
 * 【重要】这些数值一旦上线就不可随意改动，否则历史数据会错乱。
 * 新增状态请追加编号，不要复用已删除的编号。
 * ============================================================
 */

/** 用户角色 */
const ROLE = {
  MEMBER: 0, // 普通会员
  STAFF: 1, // 学院负责人
  ADMIN: 2, // 管理员
};

const ROLE_LABEL = {
  [ROLE.MEMBER]: '会员',
  [ROLE.STAFF]: '学院负责人',
  [ROLE.ADMIN]: '管理员',
};

/**
 * 协会角色（「某人在某协会」的身份）。
 *
 * 【为什么与 ROLE 分开】
 * ROLE 是**全局角色**，记在账号上；协会角色是「进了这个协会才有的身份」，
 * 记在 memberships 集合里，一人可在不同协会担任不同角色。取值用字符串：
 * 它们只活在这一张稀疏表里，不参与数值比较，可读性优先。
 */
const ASSOC_ROLE = {
  STAFF: 'staff', // 学院负责人：在本协会内、按学院
  LEADER: 'leader', // 协会负责人：在本协会内等同管理员
};

const ASSOC_ROLE_LABEL = {
  [ASSOC_ROLE.STAFF]: '学院负责人',
  [ASSOC_ROLE.LEADER]: '协会负责人',
};

/**
 * 协会启用状态。
 * 协会定义在代码注册表 `utils/associations.js` 里，此枚举只描述其 status 取值。
 * 停用而非删除：停用后仍保留其历史数据，只是不再进入、不再写入。
 */
const ASSOCIATION_STATUS = {
  ACTIVE: 'active', // 启用：可选择，可读写其内容
  DISABLED: 'disabled', // 停用：保留历史数据，不再进入
};

/** 用户账号状态 */
const USER_STATUS = {
  PENDING: 0, // 待审核：刚注册，尚未通过实名审核
  ACTIVE: 1, // 正常：可正常使用全部功能
  DISABLED: 2, // 已禁用：违规被封禁
  LEFT: 3, // 已离校：不再上榜、不可报名，但历史记录与个人页保留
};

const USER_STATUS_LABEL = {
  [USER_STATUS.PENDING]: '待审核',
  [USER_STATUS.ACTIVE]: '正常',
  [USER_STATUS.DISABLED]: '已禁用',
  [USER_STATUS.LEFT]: '已离校',
};

/**
 * 学院名单。
 *
 * 取自学校现行院系，共 26 所。注册时必选其一，且注册后不可修改——
 * 学期内转学院是极少数情况，与其让每个人随时能改、把历史成绩的归属搅乱，
 * 不如要求走管理员后台。学院全名同时是学院团体赛的对阵主键，
 * 因此只认这张表里的字面值，不接受自由输入，避免「体育学院」与
 * 「体育学院 」被当成两所学院。
 */
const COLLEGES = [
  '中华民族共同体学院',
  '民族学与社会学学院',
  '中国少数民族语言文学学院',
  '文学院',
  '历史文化学院',
  '哲学与宗教学院',
  '新闻与传播学院',
  '外国语学院',
  '马克思主义学院',
  '经济学院',
  '管理学院',
  '法学院',
  '生命与环境科学学院',
  '药学院',
  '理学院',
  '信息工程学院',
  '音乐学院',
  '舞蹈学院',
  '美术学院',
  '体育学院',
  '教育学院',
  '国际教育学院',
  '海南国际学院',
  '预科教育学院',
  '继续教育学院（干部培训部）',
  '藏学研究院',
];

/**
 * 这个账号还算不算「在册会员」。
 *
 * 【为什么离校也算】
 * 离校的人历史比赛还留在流水里。回放引擎按名单重放，名单里少一个人，
 * 遇到他参加过的比赛就会直接抛错——整条回放全废，不只是他一个人的分数没了。
 * 所以「能不能进回放名单」和「能不能上榜」是两件事：
 *   - 本函数判前者，正常与离校都算在册；
 *   - 上榜、报名另用 isRankable / USER_STATUS.ACTIVE 把关。
 *
 * @param {number} [status]
 * @returns {boolean}
 */
function isMemberStatus(status) {
  return status === USER_STATUS.ACTIVE || status === USER_STATUS.LEFT;
}

/**
 * 这个账号该不该出现在榜上。
 *
 * 离校的人不再是「当前会员」，榜首挂着一个已经毕业的账号会让榜失去意义。
 * 但记录仍在、个人页仍能打开——藏起来的是名次，不是痕迹。
 * status 缺失（老数据、单元测试造的假会员）一律当作可上榜。
 *
 * @param {Object} [user]
 * @returns {boolean}
 */
function isRankable(user) {
  return !user || user.status !== USER_STATUS.LEFT;
}

/**
 * 会员性别。
 *
 * 【为什么必须采集，而且不让本人随意改】
 * 性别参与两处业务判断，都不只是「展示一下」：
 *   1. 定级——女会员的初始分比男会员低 genderInitialGap 分（见 elo.js）；
 *   2. 上榜——男单榜 / 女单榜按性别过滤（见 RANK_PROJECT_CONFIG）。
 * 少了它，会员会同时从两张单打榜消失，还会被按男会员的初始分定级。
 * 它又会影响历史成绩的定级，因此与姓名、学号一样属于实名信息：
 * 注册时采集，之后由管理员核改，不在个人可改的白名单里。
 *
 * 取值沿用种子数据里的 'M' / 'F'，便于与既有数据对接。
 */
const GENDER = {
  MALE: 'M',
  FEMALE: 'F',
};

const GENDER_LABEL = {
  [GENDER.MALE]: '男',
  [GENDER.FEMALE]: '女',
};

/** 全部性别。校验「填的性别是否在册」时用它 */
const ALL_GENDERS = Object.values(GENDER);

/**
 * 比赛项目类型
 * 【重要】编号 2 曾用于「女子单打」，现已废弃，不要复用。
 *   男女单打合并计算后，两者共用一个单打池；性别差异体现在
 *   排行榜的展示维度（见 RANK_PROJECT）而不是比赛类型上。
 */
const MATCH_TYPE = {
  SINGLES: 1, // 单打（不分男女，男女可以互相对打）
  DOUBLES: 3, // 双打
};

const MATCH_TYPE_LABEL = {
  [MATCH_TYPE.SINGLES]: '单打',
  [MATCH_TYPE.DOUBLES]: '双打',
};

/**
 * 等级分池
 * ============================================================
 * 【核心设计】每位会员在不同池中持有完全独立的等级分。
 *   单打的分数不影响双打。一个从没打过双打的人，他的双打分数
 *   始终是初始分，不会因为单打打得好而虚高。
 *
 * 【为什么男女单打合并成一个池】
 * 男女选手之间会互相打单打比赛，如果分成两个池，一场男女对打
 * 就没法同时更新两个人的分数；而且两个池互不相通，女生打得再好
 * 也无法和男生比较。合并成一个池后，所有单打都在同一把尺子上
 * 比较，男女水平的真实差距也能被分数反映出来。
 *
 * 【排行榜为什么仍然分开】
 * 分数池是「计算口径」，排行榜是「展示口径」，两者不必一致。
 *   排行榜按 RANK_PROJECT 拆分出男单榜和女单榜，只是展示时按性别
 *   过滤，取的仍然是同一个单打池里的分数——所以一个女生在女单榜
 *   排第一，她的分数和男单榜第一名是直接可比的。
 *
 * 【为什么双打不区分男女】
 * 双打比赛不按性别分组，男双、女双、混双在同一个池里竞争，
 * 因此只设一个双打池。若将来要拆分，在此处新增池并补充映射即可，
 * 业务代码无需改动——这正是把池定义抽成配置的目的。
 * ============================================================
 */
const RATING_POOL = {
  SINGLES: 'singles', // 单打池（男女合并计算）
  DOUBLES: 'doubles', // 双打池（不分男女）
};

const RATING_POOL_LABEL = {
  [RATING_POOL.SINGLES]: '单打',
  [RATING_POOL.DOUBLES]: '双打',
};

/** 全部等级分池。遍历池时一律用它，避免漏掉某个池。 */
const ALL_RATING_POOLS = Object.values(RATING_POOL);

/**
 * 比赛类型 → 等级分池。
 * 这是「一场比赛该更新哪个池」的唯一判定依据。
 */
const MATCH_TYPE_TO_POOL = {
  [MATCH_TYPE.SINGLES]: RATING_POOL.SINGLES,
  [MATCH_TYPE.DOUBLES]: RATING_POOL.DOUBLES,
};

/**
 * 排行榜项目（展示口径）
 * ============================================================
 * 排行榜按「项目」拆分展示，一个项目 = 一个分数池 + 一个性别过滤条件。
 *   men_singles  → 单打池里的男生
 *   women_singles→ 单打池里的女生
 *   doubles      → 双打池里的所有人
 *
 * gender 为 null 表示不做性别过滤。项目与池是「多对一」的关系：
 * 男单榜和女单榜共用同一个单打池，因此两张榜上的分数可以互相比较。
 * ============================================================
 */
const RANK_PROJECT = {
  MEN_SINGLES: 'men_singles',
  WOMEN_SINGLES: 'women_singles',
  DOUBLES: 'doubles',
};

const RANK_PROJECT_LABEL = {
  [RANK_PROJECT.MEN_SINGLES]: '男单',
  [RANK_PROJECT.WOMEN_SINGLES]: '女单',
  [RANK_PROJECT.DOUBLES]: '双打',
};

/** 全部排行榜项目。遍历项目时一律用它，避免漏掉某个项目。 */
const ALL_RANK_PROJECTS = Object.values(RANK_PROJECT);

/**
 * 排行榜项目配置：项目 → 取哪个池的分数 + 只保留哪个性别。
 * 这是「一个项目该展示哪些人、用哪套分数」的唯一判定依据。
 */
const RANK_PROJECT_CONFIG = {
  [RANK_PROJECT.MEN_SINGLES]: { pool: RATING_POOL.SINGLES, gender: 'M' },
  [RANK_PROJECT.WOMEN_SINGLES]: { pool: RATING_POOL.SINGLES, gender: 'F' },
  [RANK_PROJECT.DOUBLES]: { pool: RATING_POOL.DOUBLES, gender: null },
};

/** 比赛记录状态 */
const MATCH_STATUS = {
  PENDING: 0, // 待确认：已录入，等待对手确认或管理员审核
  ACTIVE: 1, // 已生效：成绩已确认，已计入排名
  REVOKED: 2, // 已撤销：成绩作废，分数已回滚
};

const MATCH_STATUS_LABEL = {
  [MATCH_STATUS.PENDING]: '待确认',
  [MATCH_STATUS.ACTIVE]: '已生效',
  [MATCH_STATUS.REVOKED]: '已撤销',
};

/**
 * 单场结算快照的状态（Elo 逐场结算改造）。
 *
 * 每场比赛走到终态（生效或弃权等不计分收口）时，都在比赛文档上落一份
 * **一次性结算快照**：计分场带赛前/赛后分数链，不计分场带明确的排除原因。
 * 此后规则再怎么改，历史分差都以快照为准，不由当前评级反推。
 */
const SETTLEMENT_STATUS = {
  RATED: 'rated', // 计分：已按当场比赛更新评级
  EXCLUDED: 'excluded', // 不计分：写明排除原因，评级不动
};

/**
 * 不计分的排除原因。写进快照的 exclusionReason，是审计与「为什么这场没涨分」
 * 的唯一依据。新增原因时先在这里登记，不要裸写魔法字符串。
 */
const EXCLUSION_REASON = {
  FORFEIT: 'forfeit', // 弃权（D41：对阵照常推进，但不产生等级分）
  COLLEGE_DOUBLES: 'college_doubles', // 学院赛双打只汇总大场（D25）
};

/** 结算算法版本：快照与评级表都带它，将来调参可解释「这批数据是哪套规则算的」。 */
const ALGORITHM_VERSION = 'elo-v2';

/**
 * 防刷分上限：同一对会员在一个赛季内最多这么多场「自行录入的比赛」计入等级分。
 *
 * 【为什么要有这条】
 * 日常约球没有门槛：两个人可以在一周内互录二十场，赢的那个的等级分就会被
 * 同一份对阵反复推高——分数反映的不再是水平，而是约球次数。赛事比赛不设
 * 上限，因为它有名次、有裁判、有赛程，刷不出来。
 *
 * 【只数「自行录入的比赛」】
 * 判据是没有 eventId / collegeEventId / tieId，这三者齐全才算赛事或学院赛。
 *
 * 【双打按跨队无序对算】
 * 一队两人、对手两人，四组跨队组合各记一场。「无序」指 (甲,乙) 与 (乙,甲)
 * 是同一个人对，不重复计数。
 *
 * 【超限之后怎么办】
 * 比赛照常记在台账里，但不再计入等级分，也不进成绩公示与逐场战绩
 * （见 rating-cap.js）。防刷分要防的是分数被刷高，不是否认这场球发生过。
 */
const RATED_PAIR_LIMIT = 15;

/**
 * 赛事状态机。
 *
 *   报名中 ──开始赛事──▶ 进行中 ──录入名次──▶ 已结束
 *     │                     │
 *     └──── 可报名/取消 ─────┘  可签到
 *
 * 【重要】「已结束」必须保持取值 2：种子赛事写死字面量 2，改动它会让
 * 全部历史赛事变成「未结束」，赛季积分瞬间归零。
 * 新增状态一律往下追加编号，不要复用 2。
 */
const EVENT_STATUS = {
  SIGNUP: 0, // 报名中：可报名、可取消，尚未开始
  ONGOING: 1, // 进行中：报名截止，可签到、可录入名次
  FINISHED: 2, // 已结束：名次已定，可计入赛季积分
};

const EVENT_STATUS_LABEL = {
  [EVENT_STATUS.SIGNUP]: '报名中',
  [EVENT_STATUS.ONGOING]: '进行中',
  [EVENT_STATUS.FINISHED]: '已结束',
};

/** 新发布的赛事先落在「报名中」 */
const DEFAULT_EVENT_STATUS = EVENT_STATUS.SIGNUP;

/**
 * 赛事签表的阶段。
 *
 *   main      —— 主赛（淘汰赛各轮）
 *   bronze    —— 三四名决赛（仅 bronzeMode = playoff 时生成）
 *   group     —— 小组 / 循环赛（同名次赛事里的分组循环部分）
 *   wb        —— 双败淘汰·胜者组
 *   lb        —— 双败淘汰·败者组
 *   gf        —— 双败淘汰·总决赛
 *   placement —— 5–8 名排位赛（「八强倒三角」）
 *
 * 它是比赛记录上的一个字段：同一场赛事下的各阶段比赛靠 stage 区分归属，
 * 读的时候才不会把季军赛混进半决赛的轮次里。
 *
 * 【为什么 main / bronze 的取值一个字都不能改】
 * stage 会拼进比赛编号（见 draw.eventMatchKey），而编号是历史数据的 _id。
 * 改掉这两个值，等于让所有已落库的签表比赛找不到自己。新增阶段只能往后加。
 */
const BRACKET_STAGE = {
  MAIN: 'main',
  BRONZE: 'bronze',
  GROUP: 'group',
  WINNERS: 'wb',
  LOSERS: 'lb',
  GRAND_FINAL: 'gf',
  PLACEMENT: 'placement',
};

/**
 * 阶段的展示次序：小的在前。
 *
 * 【为什么要放在这里而不是留在赛事页】
 * 它有两个消费方——赛事详情页的签表排序（events-view.buildBracketRows）
 * 与场地分配（services/court.js）。后者要上云，读不到 miniprogram 里的
 * 视图模块，所以两边共用的次序只能住在 constants 里。两处排序一旦分叉，
 * 「界面上看到的先后」与「场号的先后」就会对不上。
 *
 * 让位给新增的 group 阶段。main 与 bronze 之间的相对位置不影响任何判定，
 * 只影响同一轮里先给谁排场号。
 */
function stageOrder(stage) {
  if (stage === BRACKET_STAGE.GROUP) return 0;
  if (stage === BRACKET_STAGE.WINNERS) return 1;
  if (stage === BRACKET_STAGE.LOSERS) return 2;
  if (stage === BRACKET_STAGE.BRONZE) return 2;
  if (stage === BRACKET_STAGE.PLACEMENT) return 3;
  if (stage === BRACKET_STAGE.GRAND_FINAL) return 3;
  return 1; // 正赛 / 未标注阶段
}

/**
 * 赛事赛制。
 *
 *   single_elim          —— 单败淘汰（历史缺省，抽签引擎原先唯一支持的形态）
 *   round_robin          —— 循环赛：单人成组，人人与所有人交手
 *   group_knockout       —— 小组循环 + 单败淘汰（复合赛制的第一种）
 *   round_robin_knockout —— 循环赛 + 单败淘汰（小组赛只有一个组时的形态）
 *   double_elim          —— 双败淘汰：胜者组 / 败者组 / 总决赛
 *   group_double_elim    —— 小组循环 + 双败淘汰（复合赛制）
 *
 * 【为什么是「赛制」而不是继续加布尔开关】
 * 复合赛制（小组打完接着淘汰）要求把多个阶段按顺序串起来。若用开关去拼，
 * 组合数一旦上去，分支就再也理不清。这里把它收成一个有序的阶段序列
 * （见 services/format-plan.js），新增复合形态只是多一行预设。
 */
const EVENT_FORMAT = {
  SINGLE_ELIM: 'single_elim',
  ROUND_ROBIN: 'round_robin',
  GROUP_KNOCKOUT: 'group_knockout',
  ROUND_ROBIN_KNOCKOUT: 'round_robin_knockout',
  DOUBLE_ELIM: 'double_elim',
  GROUP_DOUBLE_ELIM: 'group_double_elim',
};

const EVENT_FORMAT_LABEL = {
  [EVENT_FORMAT.SINGLE_ELIM]: '单败淘汰',
  [EVENT_FORMAT.ROUND_ROBIN]: '循环赛',
  [EVENT_FORMAT.GROUP_KNOCKOUT]: '小组赛+淘汰',
  [EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT]: '循环赛+淘汰',
  [EVENT_FORMAT.DOUBLE_ELIM]: '双败淘汰',
  [EVENT_FORMAT.GROUP_DOUBLE_ELIM]: '小组赛+双败',
};

/** 历史赛事没有 format 字段，按单败淘汰处理——缺省即旧行为 */
const DEFAULT_EVENT_FORMAT = EVENT_FORMAT.SINGLE_ELIM;

/** 需要分组的赛制（小组数 / 出线人数只对这些有意义） */
const GROUPED_FORMATS = [
  EVENT_FORMAT.ROUND_ROBIN,
  EVENT_FORMAT.GROUP_KNOCKOUT,
  EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT,
  EVENT_FORMAT.GROUP_DOUBLE_ELIM,
];

/** 组数可配置（2 / 4 组）的赛制：循环类恒为单组，不需要这个参数 */
const GROUP_COUNT_FORMATS = [EVENT_FORMAT.GROUP_KNOCKOUT, EVENT_FORMAT.GROUP_DOUBLE_ELIM];

/** 出线人数可配置的赛制（单组循环赛取前 N 名进淘汰，N 由这里给） */
const ADVANCE_FORMATS = [
  EVENT_FORMAT.GROUP_KNOCKOUT,
  EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT,
  EVENT_FORMAT.GROUP_DOUBLE_ELIM,
];

/**
 * 主淘汰阶段是「单败」的赛制。
 *
 * 三四名赛与 5–8 名排位赛都长在单败主签表上：半决赛负者打季军赛、八强
 * 负者打排位赛。双败淘汰有自己的名次体系（人人排出 1..N），用不上它们。
 */
const KNOCKOUT_FORMATS = [
  EVENT_FORMAT.SINGLE_ELIM,
  EVENT_FORMAT.GROUP_KNOCKOUT,
  EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT,
];

/**
 * 主淘汰阶段是「双败」的赛制。
 * 总决赛重赛开关只对它们有意义（见 services/format-plan.js）。
 */
const DOUBLE_ELIM_FORMATS = [
  EVENT_FORMAT.DOUBLE_ELIM,
  EVENT_FORMAT.GROUP_DOUBLE_ELIM,
];

/**
 * 名次由赛制自动推导为 1..N 的赛制。
 *
 * 循环赛按积分表排、双败按淘汰轮次排，名次天然包含第 4 名甚至更靠后，
 * 名次校验对它们走「阶梯」口径，不再套三四名成对规则（见 event.validatePlacements）。
 */
const LADDER_FORMATS = [...GROUPED_FORMATS, ...DOUBLE_ELIM_FORMATS];

/**
 * 双败总决赛是否默认启用「重赛」。
 * 决策 D3：标准口径——胜者组冠军先记 1:0，若输给败者组冠军则加赛一场。
 */
const DEFAULT_GF_RESET = true;

/**
 * 「八强倒三角」5–8 名排位赛的开关。
 *
 *   none —— 不排：八强战负者并列（与历史口径一致）
 *   top8 —— 排位：八强战负者再打一个小签表，分出第 5–8 名
 */
const EVENT_PLACEMENT_MODE = {
  NONE: 'none',
  TOP8: 'top8',
};

const EVENT_PLACEMENT_MODE_LABEL = {
  [EVENT_PLACEMENT_MODE.NONE]: '不排位',
  [EVENT_PLACEMENT_MODE.TOP8]: '排 5–8 名',
};

/** 历史赛事没有这个字段，按「不排位」处理 */
const DEFAULT_PLACEMENT_MODE = EVENT_PLACEMENT_MODE.NONE;

/** 小组赛的可选参数 */
const GROUP_CONFIG = {
  COUNT_OPTIONS: [2, 4, 8],
  ADVANCE_OPTIONS: [1, 2, 3, 4],
};

/** 缺省小组数 / 每组出线人数（4 人一组、每组前 2 出线是最常见的青少年赛制） */
const DEFAULT_GROUP_COUNT = 2;
const DEFAULT_ADVANCE_PER_GROUP = 2;

/**
 * 三四名赛的两种办赛方式（决策 2.3）。
 *
 *   tied    —— 并列季军：两个半决赛负者都记第 3 名，不再加赛
 *   playoff —— 打三四名：半决赛负者再打一场，分出第 3、第 4 名
 *
 * 【为什么是一个字段而不是两套流程】
 * 两种方式只差「第 4 名有没有人」：名次分表里 3 与 4 各有基准分，
 * 并列时两人都取 3，加赛时一人 3 一人 4。名次录入与积分结算因此
 * 可以共用一条通路，只在保存时校验一次名次是否成对。
 */
const EVENT_BRONZE_MODE = {
  TIED: 'tied', // 并列季军
  PLAYOFF: 'playoff', // 打三四名
};

const EVENT_BRONZE_MODE_LABEL = {
  [EVENT_BRONZE_MODE.TIED]: '并列季军',
  [EVENT_BRONZE_MODE.PLAYOFF]: '打三四名',
};

/** 历史赛事没有这个字段，按「并列季军」处理——种子数据正是并列口径 */
const DEFAULT_BRONZE_MODE = EVENT_BRONZE_MODE.TIED;

/**
 * 报名状态。
 *
 * 记录一旦产生就不再删除：取消了也留着（status 置为 CANCELED），
 * 这样「报了多少人、退了多少人」有据可查，重复报名也能靠同一条
 * 记录翻回来——同一人同一赛事永远只有一条。
 */
const SIGNUP_STATUS = {
  CANCELED: 0, // 已取消报名
  SIGNED: 1, // 已报名
  CHECKED_IN: 2, // 已签到
};

const SIGNUP_STATUS_LABEL = {
  [SIGNUP_STATUS.CANCELED]: '已取消',
  [SIGNUP_STATUS.SIGNED]: '已报名',
  [SIGNUP_STATUS.CHECKED_IN]: '已签到',
};

/**
 * 赛事等级（决策 13、2.1）。
 * 等级决定名次分的倍数，也决定赛事比赛的 elo K 值（见 elo.js）。
 */
const EVENT_LEVEL = {
  FIRST: 1, // 一级赛事
  SECOND: 2, // 二级赛事
  THIRD: 3, // 三级赛事
};

const EVENT_LEVEL_LABEL = {
  [EVENT_LEVEL.FIRST]: '一级赛事',
  [EVENT_LEVEL.SECOND]: '二级赛事',
  [EVENT_LEVEL.THIRD]: '三级赛事',
};

/**
 * 等级 → 名次分倍数（决策 2.1）。
 * 只放大名次分，与等级分（elo）无关——后者见 elo.js 的赛事 K 配置。
 */
const EVENT_LEVEL_MULTIPLIER = {
  [EVENT_LEVEL.FIRST]: 4,
  [EVENT_LEVEL.SECOND]: 2,
  [EVENT_LEVEL.THIRD]: 1,
};

/**
 * 缺省赛事等级。
 * 历史 / 种子赛事没有等级字段时按三级处理（决策 13：默认三级，但新建时必选）。
 */
const DEFAULT_EVENT_LEVEL = EVENT_LEVEL.THIRD;

/**
 * 种子来源（决策 2：创建赛事时必选）。
 *
 *   manual —— 手工指定：管理员在抽签时逐个指定 1 号、2 号…
 *   elo    —— 按等级分：取当前单打池 elo 最高的前若干位
 *   points —— 按赛季积分：取本赛季积分最高的前若干位
 *
 * 【为什么和「三四名赛」一样必须显式选】
 * 它决定谁是种子、进而决定谁在签表里受保护。若留空取默认，一次「忘了选」
 * 就会静默改变整张签表，事后也看不出当初本想按什么排。
 */
const SEED_MODE = {
  MANUAL: 'manual',
  ELO: 'elo',
  POINTS: 'points',
};

const SEED_MODE_LABEL = {
  [SEED_MODE.MANUAL]: '手工指定',
  [SEED_MODE.ELO]: '按等级分',
  [SEED_MODE.POINTS]: '按赛季积分',
};

/** 允许的种子数量（决策 3：只有 2 / 4 / 8，不考虑其它数字） */
const SEED_COUNTS = [2, 4, 8];

/** 默认种子数量（决策 3） */
const DEFAULT_SEED_COUNT = 8;

/**
 * 双打可用的种子来源。
 *
 * 【为什么没有 points】
 * 「按赛季积分」排的是个人赛季积分，双打赛事本身不计分（决策 3），
 * 拿一个与双打无关的数去排双打种子毫无意义。双打只按等级分（两人
 * 双打分之和）或手工指定。
 */
const DOUBLES_SEED_MODES = [SEED_MODE.MANUAL, SEED_MODE.ELO];

/**
 * 双打队伍在签表里的编号分隔符。
 *
 * 签表算法只把「参赛者」当成不透明的字符串，单打是一位选手的编号，
 * 双打则把同队两人的编号拼成一个串（如 `u1|u2`）。这样 bracket.js、
 * 分组与逐轮推进全都不用为双打改一行——它们照旧搬字符串即可。
 * 编号本身由服务端生成，不含 `|`，因此这个分隔符不会误伤。
 */
const TEAM_ID_SEPARATOR = '|';

/** 参赛队伍标识 */
const TEAM = {
  A: 'A',
  B: 'B',
};

/**
 * 排行榜时间范围。
 * 只保留「总榜」与「赛季榜」：周榜、月榜已按决策 2 去掉——
 * 短期尺子奖励的是「最近打得勤」，与「谁强谁在前」的等级分榜讲的是
 * 两件事，混在一起反而让人看不懂名次是怎么来的。
 */
const RANK_PERIOD = {
  ALL: 'all', // 总榜
  SEASON: 'season', // 赛季榜
};

const RANK_PERIOD_LABEL = {
  [RANK_PERIOD.ALL]: '总榜',
  [RANK_PERIOD.SEASON]: '赛季榜',
};

/** 排行榜排序依据 */
const RANK_SORT_BY = {
  ELO: 'elo', // 按等级分
  POINTS: 'points', // 按积分
};

/** 数据库集合名。集中定义便于后续改名或迁移。 */
const COLLECTION = {
  SCHOOLS: 'schools',
  SCHOOL_ASSOCIATIONS: 'school_associations',
  COLLEGES: 'colleges',
  SCHOOL_MEMBERS: 'school_members',
  SCHOOL_ROLES: 'school_roles',
  STUDENT_ID_CLAIMS: 'student_id_claims',
  EXCHANGE_EVENTS: 'exchange_events',
  EXCHANGE_INVITATIONS: 'exchange_invitations',
  EXCHANGE_SIGNUPS: 'exchange_signups',
  EXCHANGE_MATCHES: 'exchange_matches',
  USERS: 'users',
  MATCHES: 'matches',
  EVENTS: 'events',
  EVENT_SIGNUPS: 'event_signups',
  ANNOUNCEMENTS: 'announcements',
  AUDIT_LOGS: 'audit_logs',
  SEASONS: 'seasons',
  // 学院赛独立成体系，不与个人赛共用集合（见「学院赛设计方案」D1）
  COLLEGE_EVENTS: 'college_events',
  COLLEGE_ENTRIES: 'college_entries',
  TIES: 'ties',
  COLLEGE_LINEUPS: 'lineups',
  // 团队运动（篮球/足球/排球）：球队、队员、团队赛事、报名、比赛、单场统计。
  // 与个人赛彻底分开——matches 是个人 Elo 的唯一流水，团队赛写进去会污染
  // 个人账本（一场 5v5 既不是单打也不是双打）。见 docs/篮球协会-需求与实施规划.md
  TEAMS: 'teams',
  TEAM_MEMBERS: 'team_members',
  TEAM_EVENTS: 'team_events',
  TEAM_EVENT_ENTRIES: 'team_event_entries',
  TEAM_MATCHES: 'team_matches',
  TEAM_MATCH_STATS: 'team_match_stats',
  // 实时比分一场一条（_id = 'ls_' + matchId），重启不堆记录。
  // 只存「正在逐球计分」的过程态，定稿后转成 matches 里的正式比分
  LIVE_SCORES: 'live_scores',
  // 协会角色表：只在某人于某协会获得学院负责人/协会负责人时才有行，
  // 无行即普通会员。会员资格是隐式的，不逐条登记（见 utils/associations.js）。
  MEMBERSHIPS: 'memberships',
  // 协会空间：成员小组（如「新手组」「校队组」）。与赛事签表的「小组」无关——
  // 这里的 group 是长期会员小组，只存在于一个学校的一个协会内（规划 §5.2）。
  ASSOCIATION_GROUPS: 'association_groups',
  // 组内成员关系：_id = scope + groupId + userId 的稳定唯一键，含退出/被移除状态。
  ASSOCIATION_GROUP_MEMBERS: 'association_group_members',
  // 空间通知：协会内部公告，与本模块顶部的全局 announcements 各自独立——
  // 空间通知只在本校本协会可见，绝不进首页 / 公告中心 / 全局统计（规划 §3.3）。
  ASSOCIATION_NOTICES: 'association_notices',
  // 空间训练活动：一个学校一个协会内的训练发布（规划 §5.4）。
  ASSOCIATION_TRAININGS: 'association_trainings',
  // 训练报名：_id = scope + trainingId + userId，含取消/移除与资格快照（规划 §5.5）。
  TRAINING_REGISTRATIONS: 'training_registrations',
  // 每赛季「一对会员的自行录入场次」计数：_id = scope + 赛季号 + 两人编号。
  // 它本身没有业务含义，只为一件事存在——把名额判断放进事务，让并发的两次录分
  // 在同一份文档上撞车（见 school-match-service 的 pairUsage 一段）。
  PAIR_COUNTS: 'pair_counts',
  // 会员评级表（Elo 逐场结算）：每个「学校 + 协会 + 用户 + 池」一条，当前评级落库，
  // 确认比赛时在事务里逐场结算。_id = scope + userId + pool 的稳定键（见 school.js）。
  MEMBER_RATINGS: 'member_ratings',
  // 结算序号计数：每个「学校 + 协会」一条，settlementSeq 从这里原子递增，
  // 决定 Elo 变化链的顺序（用服务端结算顺序，不靠客户端比赛时间）。
  RATING_COUNTERS: 'rating_counters',
  // 管理员评级调整审计：每次手工改当前分一条，与结算共用序号计数，
  // 解释分数跳变且不伪装成比赛（见 Elo 交接 §5.3）。
  RATING_ADJUSTMENTS: 'rating_adjustments',
  // 运动会（学校级栏目，不属于任何协会）。14 个集合一律带 schoolId + meetId，
  // 范围由 utils/meet-scope.js 的 forMeet 校验；子资源不得越届读写。
  SPORTS_MEETS: 'sports_meets',
  SPORTS_MEET_EVENTS: 'sports_meet_events',
  SPORTS_MEET_COLLEGES: 'sports_meet_colleges',
  SPORTS_MEET_INTERESTS: 'sports_meet_interests',
  SPORTS_MEET_ENTRIES: 'sports_meet_entries',
  SPORTS_MEET_SESSIONS: 'sports_meet_sessions',
  SPORTS_MEET_JUDGE_ASSIGNMENTS: 'sports_meet_judge_assignments',
  SPORTS_MEET_SCORES: 'sports_meet_scores',
  SPORTS_MEET_PUBLICATIONS: 'sports_meet_publications',
  SPORTS_MEET_RESULT_ROWS: 'sports_meet_result_rows',
  SPORTS_MEET_QUOTA_USAGE: 'sports_meet_quota_usage',
  // B8：学院总榜快照（一院一条）与个人荣誉（一人一项目一条）
  SPORTS_MEET_STANDINGS: 'sports_meet_standings',
  SPORTS_MEET_HONORS: 'sports_meet_honors',
  SPORTS_MEET_PARTICIPANT_CLAIMS: 'sports_meet_participant_claims',
  // 学院部长授权：一院一条（_id = 学校 + 学院），常设角色、不随届次失效。
  SPORTS_MEET_COLLEGE_LEADS: 'sports_meet_college_leads',
};

/** 本地缓存键名 */
const STORAGE_KEY = {
  USER_INFO: 'userInfo', // 登录后的用户信息
  SETTINGS: 'settings', // 本地设置项
  // 首页快照：冷启动先画一屏用。**必须随登出清除**——同一台设备换微信账号后，
  // 缓存里还留着上一位用户的「我报名了」等个人相关标记（2026-10-23 第三轮 X-14）。
  HOME_VIEW: 'home_view_cache',
};

/**
 * 数据源模式。
 * mock：使用本地模拟数据，无需云开发环境即可完整预览（开发初期使用）
 * cloud：调用真实云函数与云数据库（拿到 AppID 并开通云开发后切换）
 */
const DATA_SOURCE = {
  MOCK: 'mock',
  CLOUD: 'cloud',
};

/**
 * 公告分类。
 * 收敛成固定几项，而不是让发布者随手写：自由文本很快就会出现
 * 「通知」「通知 」「比赛通知」并存，筛选和统计都没法做。
 */
const ANNOUNCEMENT_CATEGORIES = ['通知', '赛事', '战报'];

/**
 * 公告状态。
 * 「下架」不等于「删除」：记录仍留在管理列表里，只是不再对外展示。
 * 与比赛「撤销」保留记录是同一思路——话已经发出去了，收不回来，至少要留痕。
 */
const ANNOUNCEMENT_STATUS = {
  PUBLISHED: 'published',
  ARCHIVED: 'archived',
};

const ANNOUNCEMENT_STATUS_LABEL = {
  [ANNOUNCEMENT_STATUS.PUBLISHED]: '已发布',
  [ANNOUNCEMENT_STATUS.ARCHIVED]: '已下架',
};

/**
 * 空间通知状态（协会空间内部，与全局公告各自独立）。
 * 「撤回」不等于「删除」：记录留在管理列表里留痕，只是不再对本协会会员展示。
 * 与全局公告的 published/archived 语义一致，但字段与集合分开，互不干扰。
 */
const ASSOCIATION_NOTICE_STATUS = {
  PUBLISHED: 'published',
  WITHDRAWN: 'withdrawn',
};

const ASSOCIATION_NOTICE_STATUS_LABEL = {
  [ASSOCIATION_NOTICE_STATUS.PUBLISHED]: '已发布',
  [ASSOCIATION_NOTICE_STATUS.WITHDRAWN]: '已撤回',
};

/**
 * 训练活动状态（协会空间）。
 * 取消后仍保留记录（留痕），不再对外显示为可报名。
 */
const TRAINING_STATUS = {
  PUBLISHED: 'published',
  FINISHED: 'finished',
  CANCELED: 'canceled',
};

const TRAINING_STATUS_LABEL = {
  [TRAINING_STATUS.PUBLISHED]: '可报名',
  [TRAINING_STATUS.FINISHED]: '已结束',
  [TRAINING_STATUS.CANCELED]: '已取消',
};

/**
 * 训练报名状态。取消/移出保留记录（否则重报会丢历史），有效名额只数 registered。
 */
const TRAINING_SIGNUP_STATUS = {
  REGISTERED: 'registered',
  CANCELED: 'canceled',
};

/* ============================================================
 * 学院赛
 * ============================================================
 * 学院赛与个人赛是两套并行的体系（D1）：个人赛仍是一个赛事一个项目、
 * 一张签表；学院赛则以学院为单位报名，一场「大场」由若干「小场」组成。
 * 下面这些常量只服务于学院赛，个人赛一行都不用改。
 * ============================================================ */

/**
 * 小项（小场）的项目池。
 *
 * 取值用国际通行的项目缩写：男单 MS、女单 WS、男双 MD、女双 WD、混双 XD。
 * 与个人赛的 MATCH_TYPE 分开，是因为学院赛的一个小项还要带上「男女」
 * 与「单双」两重信息，而 MATCH_TYPE 只有单/双，且女单编号已被废弃过
 * （见 MATCH_TYPE 的说明），不便复用。
 *
 * 同一场大场里同名小项可以重复出现（D19），例如两场男单——
 * 因此这里只能是一份「可选值清单」，不能当成唯一键。
 */
const LEG_DISCIPLINE = {
  MS: 'MS',
  WS: 'WS',
  MD: 'MD',
  WD: 'WD',
  XD: 'XD',
};

const LEG_DISCIPLINE_LABEL = {
  [LEG_DISCIPLINE.MS]: '男单',
  [LEG_DISCIPLINE.WS]: '女单',
  [LEG_DISCIPLINE.MD]: '男双',
  [LEG_DISCIPLINE.WD]: '女双',
  [LEG_DISCIPLINE.XD]: '混双',
};

/** 项目池的合法取值，用于校验「小项序列非空且都在池内」 */
const ALL_LEG_DISCIPLINES = Object.values(LEG_DISCIPLINE);

/**
 * 不计个人分的双打类小项。
 *
 * 男双 / 女双 / 混双只参与大场胜负的汇总，不产生 ELO，也不产生赛事积分
 * （D25）。单打小项则照一级赛事口径计 ELO（K=32），但不计积分（D24）。
 */
const DOUBLES_DISCIPLINES = [LEG_DISCIPLINE.MD, LEG_DISCIPLINE.WD, LEG_DISCIPLINE.XD];

/** 单打类小项。与 DOUBLES_DISCIPLINES 互补。 */
const SINGLES_DISCIPLINES = [LEG_DISCIPLINE.MS, LEG_DISCIPLINE.WS];

/**
 * 小项 → 上场队员性别（真相源）
 * ============================================================
 * 这是全项目「谁能在哪个小项上场」的唯一依据。学院赛排阵要按它校验，
 * 个人赛报名要按它拦人，个人赛双打抽签要按它配对——三处共用一份定义，
 * 免得各处各写一套、慢慢分叉。
 *
 * 【为什么是「按位置列出性别」而不是「男 / 女 / 混」三个标签】
 * 混双的约束是「恰好一男一女」，用 ['M','F'] 直接表达清楚；男双是
 * ['M','M']，也顺手把「两人」这个人数信息带了出来。数组长度即人数，
 * 排序后比对就能判定一份上场名单合不合法，不必再写一套人数规则。
 * ============================================================
 */
const LEG_DISCIPLINE_GENDERS = {
  [LEG_DISCIPLINE.MS]: [GENDER.MALE],
  [LEG_DISCIPLINE.WS]: [GENDER.FEMALE],
  [LEG_DISCIPLINE.MD]: [GENDER.MALE, GENDER.MALE],
  [LEG_DISCIPLINE.WD]: [GENDER.FEMALE, GENDER.FEMALE],
  [LEG_DISCIPLINE.XD]: [GENDER.MALE, GENDER.FEMALE],
};

/**
 * 小项 → 个人赛的比赛项目类型（单打 / 双打）。
 * 「这个个人赛项目属单打还是双打」只有这一处判定，赛事表单据此校验
 * 用户选的项目与单打 / 双打是否对得上。
 */
const DISCIPLINE_MATCH_TYPE = {
  [LEG_DISCIPLINE.MS]: MATCH_TYPE.SINGLES,
  [LEG_DISCIPLINE.WS]: MATCH_TYPE.SINGLES,
  [LEG_DISCIPLINE.MD]: MATCH_TYPE.DOUBLES,
  [LEG_DISCIPLINE.WD]: MATCH_TYPE.DOUBLES,
  [LEG_DISCIPLINE.XD]: MATCH_TYPE.DOUBLES,
};

/**
 * 某个小项需要哪些性别的队员，按位置排列；未知小项返回 null。
 * @param {string} discipline
 * @returns {string[]|null}
 */
function requiredGendersOf(discipline) {
  return LEG_DISCIPLINE_GENDERS[discipline] || null;
}

/**
 * 小项对应的比赛项目类型；未知小项返回 null。
 * @param {string} discipline
 * @returns {number|null}
 */
function disciplineMatchType(discipline) {
  return DISCIPLINE_MATCH_TYPE[discipline] || null;
}

/**
 * 某个比赛项目类型可选的小项清单（不含「不限」）。
 * 双打含混双——个人赛同样可以办混双，只是双打仍共用一个分数池。
 * @param {number} matchType
 * @returns {string[]}
 */
function disciplinesForMatchType(matchType) {
  if (matchType === MATCH_TYPE.SINGLES) return SINGLES_DISCIPLINES.slice();
  if (matchType === MATCH_TYPE.DOUBLES) return DOUBLES_DISCIPLINES.slice();
  return [];
}

/**
 * 小项对「单个报名者」的性别限制。
 *
 * 男单 / 男双 → 'M'，女单 / 女双 → 'F'；混双（一男一女）与「不限」
 * 返回 null，表示不对单个报名者作性别限制——混双的组合约束留给抽签配对。
 *
 * @param {string} discipline
 * @returns {string|null}
 */
function singleGenderOf(discipline) {
  const genders = requiredGendersOf(discipline);
  if (!genders || genders.length === 0) return null;
  const unique = Array.from(new Set(genders));
  return unique.length === 1 ? unique[0] : null;
}

/**
 * 赛事项目文案。未指定项目（不限）返回空串，界面据此决定是否显示标签。
 * @param {string} discipline
 * @returns {string}
 */
function disciplineLabelOf(discipline) {
  return LEG_DISCIPLINE_LABEL[discipline] || '';
}

/**
 * 个人赛表单里「项目」下拉的可选项，首项固定为「不限」。
 * 与学院赛共用同一份小项定义，避免两套体系各写一份选项。
 * @param {number} matchType
 * @returns {Array<{value:string, label:string}>}
 */
function disciplineOptionsFor(matchType) {
  const options = [{ value: '', label: '不限' }];
  for (const discipline of disciplinesForMatchType(matchType)) {
    options.push({ value: discipline, label: LEG_DISCIPLINE_LABEL[discipline] });
  }
  return options;
}

/**
 * 大场胜负算法（D23 / D33）。
 *
 *   FULL_POINTS —— 打满比净胜：所有小项都打完，比净胜
 *   FIRST_TO_N  —— 先到 N 场胜：先赢够 N 场者胜，N = 小项数的一半加一（D29）
 *
 * 两种都实现，由管理员发布学院赛时二选一。
 */
const TIE_ALGO = {
  FULL_POINTS: 'full_points',
  FIRST_TO_N: 'first_to_n',
};

const TIE_ALGO_LABEL = {
  [TIE_ALGO.FULL_POINTS]: '打满比净胜',
  [TIE_ALGO.FIRST_TO_N]: '先到 N 场胜',
};

/** 默认「打满比净胜」（D29） */
const DEFAULT_TIE_ALGO = TIE_ALGO.FULL_POINTS;

/**
 * 「打满比净胜」里「净胜」的口径（D34）。
 *
 *   WIN_DIFF   —— 小场胜场差：赢的小场数减去输的小场数
 *   POINT_DIFF —— 累计局分净胜：把所有小场的局分累加起来再比
 *
 * 两套口径都实现，同样由管理员发布时选择。选「先到 N 场胜」时本项无意义。
 */
const TIE_NET_MODE = {
  WIN_DIFF: 'win_diff',
  POINT_DIFF: 'point_diff',
};

const TIE_NET_MODE_LABEL = {
  [TIE_NET_MODE.WIN_DIFF]: '小场胜场差',
  [TIE_NET_MODE.POINT_DIFF]: '累计局分净胜',
};

/** 默认「小场胜场差」 */
const DEFAULT_TIE_NET_MODE = TIE_NET_MODE.WIN_DIFF;

/**
 * 学院赛状态机（D35）。
 *
 *   报名中 ──抽签──▶ 待开赛 ──赛事级开始──▶ 进行中 ──录入名次──▶ 已结束
 *
 * 与个人赛的 EVENT_STATUS 分开：学院赛在「报名中」与「进行中」之间多一个
 * 「待开赛」，因为抽签与开赛是两次独立的管理员操作（先排种子、再开始），
 * 中间要能停住。
 *
 * 【编号规则】与 EVENT_STATUS 一样，上线后只增不改。
 */
const COLLEGE_EVENT_STATUS = {
  SIGNUP: 0, // 报名中：名单可提交、可修改，尚未抽签
  READY: 1, // 待开赛：已抽签、名单已锁定，等待赛事级「开始」
  ONGOING: 2, // 进行中：已生成首轮大场，逐场排阵、开赛、录分
  FINISHED: 3, // 已结束：学院名次已录入
};

const COLLEGE_EVENT_STATUS_LABEL = {
  [COLLEGE_EVENT_STATUS.SIGNUP]: '报名中',
  [COLLEGE_EVENT_STATUS.READY]: '待开赛',
  [COLLEGE_EVENT_STATUS.ONGOING]: '进行中',
  [COLLEGE_EVENT_STATUS.FINISHED]: '已结束',
};

/** 新发布的学院赛先落在「报名中」 */
const DEFAULT_COLLEGE_EVENT_STATUS = COLLEGE_EVENT_STATUS.SIGNUP;

/**
 * 大场状态（D38：大场级独立开始）。
 *
 *   待排阵 ──双方交齐排阵──▶ 待开赛 ──管理员点「开始」──▶ 进行中 ──小场录完──▶ 已结束
 *
 * 与学院赛整体状态分开：赛事级「开始」只把整场推进到进行中并生成首轮大场，
 * 每个大场还要各自等排阵、各自开始，所以大场需要一条自己的状态线。
 *
 * 【编号规则】与其它状态机一样，上线后只增不改。
 */
const TIE_STATUS = {
  PENDING_LINEUP: 0, // 待排阵：至少一方尚未提交出场安排
  READY: 1, // 待开赛：双方排阵已齐，等待管理员点该大场的「开始」
  ONGOING: 2, // 进行中：大场已开始，逐个小项录分
  FINISHED: 3, // 已结束：大场胜负已定
};

const TIE_STATUS_LABEL = {
  [TIE_STATUS.PENDING_LINEUP]: '待排阵',
  [TIE_STATUS.READY]: '待开赛',
  [TIE_STATUS.ONGOING]: '进行中',
  [TIE_STATUS.FINISHED]: '已结束',
};

/** 新生成的大场先落在「待排阵」 */
const DEFAULT_TIE_STATUS = TIE_STATUS.PENDING_LINEUP;

/**
 * 一场比赛的结果性质（D41）。
 *
 *   NORMAL  —— 正常打完，按比分判胜负，该计 ELO 的照计
 *   FORFEIT —— 弃权：不计 ELO，但对阵照常推进（对手晋级 / 大场汇总照算）
 *
 * 个人赛不带这个字段时一律按 NORMAL 处理，既有流水不受影响。
 */
const MATCH_OUTCOME = {
  NORMAL: 'normal',
  FORFEIT: 'forfeit',
};

/**
 * 比赛记录属于哪套体系（D1）。
 *
 *   personal —— 个人赛：一场比赛就是一场比赛，按等级分池计分
 *   college  —— 学院赛的小场：一场大场里的一个项目，只有单打算个人分（D24/D25）
 *
 * 【为什么要有这个字段】
 * 学院赛的小场复用个人赛那条「录分 → 对手确认 → 计等级分」的通路，
 * 于是两者同住 matches 集合。但个人读路径（排行榜、个人页、赛事列表）
 * 绝不能把小场当成自己的比赛，回放也要据此分流计分口径——所以必须能
 * 一眼分清谁是谁。缺省一律视为个人赛，既有流水一行都不用改。
 */
const MATCH_COMPETITION = {
  PERSONAL: 'personal',
  COLLEGE: 'college',
};

/**
 * 名单状态。
 *
 * 没有记录即「尚未提交」；提交后进「待审核」；管理员通过或退回。
 * 「退回」保留记录而不是删掉——跟入会审核借「已禁用」的壳是同一个道理，
 * 得让学院知道上一份为什么没过，才能改了再交。
 */
const COLLEGE_ENTRY_STATUS = {
  PENDING: 0, // 待审核：已提交，等待管理员审核
  APPROVED: 1, // 已通过：名单有效，等待抽签锁定
  RETURNED: 2, // 已退回：管理员打回，可修改后重新提交
};

const COLLEGE_ENTRY_STATUS_LABEL = {
  [COLLEGE_ENTRY_STATUS.PENDING]: '待审核',
  [COLLEGE_ENTRY_STATUS.APPROVED]: '已通过',
  [COLLEGE_ENTRY_STATUS.RETURNED]: '已退回',
};

/**
 * 团队运动（篮球/足球/排球）的状态机。
 *
 * 【为什么用字符串而不是数字】
 * 学院赛用的是 0/1/2/3，那是历史选择；团队赛是新增业务，没有兼容包袱，
 * 用可读的字符串：控制台里直接看字段就知道是什么状态，不必翻枚举表。
 */
const TEAM_STATUS = {
  PENDING: 'pending', // 待审核：学生申请建队，等协会管理员审
  ACTIVE: 'active', // 正常
  REJECTED: 'rejected', // 未通过：申请被退回，可改名后再申请
  ARCHIVED: 'archived', // 已归档（解散）：历史成绩仍可查，不再接受报名
};

const TEAM_STATUS_LABEL = {
  [TEAM_STATUS.PENDING]: '待审核',
  [TEAM_STATUS.ACTIVE]: '正常',
  [TEAM_STATUS.REJECTED]: '未通过',
  [TEAM_STATUS.ARCHIVED]: '已归档',
};

/**
 * 球队类型。
 *
 * 【为什么只有两种，且学院队不是「建」出来的】
 * 自由球队由学生申请组建（有队长、可申请入队、可归档）；学院代表队是**系统按
 * 学院目录预置**的常设队，一个学院在一个项目里恒有一条，用户看不到「创建」动作。
 * 两者共用 teams / team_members 两张表，靠这个字段区分权限与展示，
 * 不为学院队另建集合——否则录分、报名、战绩都要再写一遍。
 */
const TEAM_TYPE = {
  FREE: 'free', // 自由球队（缺省）
  COLLEGE: 'college', // 学院代表队：系统预置，队员由学院负责人挑选
};

const TEAM_TYPE_LABEL = {
  [TEAM_TYPE.FREE]: '球队',
  [TEAM_TYPE.COLLEGE]: '学院队',
};

/** 队员状态。入队申请与被移出都留痕，不物理删除。 */
const TEAM_MEMBER_STATUS = {
  PENDING: 'pending', // 已申请，等队长批
  ACTIVE: 'active', // 在队
  REJECTED: 'rejected', // 申请被拒
  LEFT: 'left', // 已退队 / 被移出
};

const TEAM_MEMBER_STATUS_LABEL = {
  [TEAM_MEMBER_STATUS.PENDING]: '待审批',
  [TEAM_MEMBER_STATUS.ACTIVE]: '在队',
  [TEAM_MEMBER_STATUS.REJECTED]: '已拒绝',
  [TEAM_MEMBER_STATUS.LEFT]: '已离队',
};

/** 团队赛事状态 */
const TEAM_EVENT_STATUS = {
  DRAFT: 'draft', // 草稿：只有管理员可见
  REGISTRATION: 'registration', // 报名中
  LOCKED: 'locked', // 名单已锁定：等待抽签，不接受新报名
  SCHEDULED: 'scheduled', // 赛程已发布
  RUNNING: 'running', // 进行中
  FINISHED: 'finished', // 已结束
  CANCELED: 'canceled', // 已取消
};

const TEAM_EVENT_STATUS_LABEL = {
  [TEAM_EVENT_STATUS.DRAFT]: '草稿',
  [TEAM_EVENT_STATUS.REGISTRATION]: '报名中',
  [TEAM_EVENT_STATUS.LOCKED]: '名单已锁定',
  [TEAM_EVENT_STATUS.SCHEDULED]: '赛程已发布',
  [TEAM_EVENT_STATUS.RUNNING]: '进行中',
  [TEAM_EVENT_STATUS.FINISHED]: '已结束',
  [TEAM_EVENT_STATUS.CANCELED]: '已取消',
};

/** 球队报名状态。锁定（LOCKED）之后名单不再接受修改。 */
const TEAM_ENTRY_STATUS = {
  SUBMITTED: 'submitted', // 已提交，待审核
  APPROVED: 'approved', // 已通过
  REJECTED: 'rejected', // 已退回
  LOCKED: 'locked', // 已锁定：赛前名单冻结，进快照
};

const TEAM_ENTRY_STATUS_LABEL = {
  [TEAM_ENTRY_STATUS.SUBMITTED]: '待审核',
  [TEAM_ENTRY_STATUS.APPROVED]: '已通过',
  [TEAM_ENTRY_STATUS.REJECTED]: '已退回',
  [TEAM_ENTRY_STATUS.LOCKED]: '已锁定',
};

/**
 * 团队赛事的杯赛归属。
 *
 * 空 = 普通团队赛事（自由球队可报名）；`college` = 石榴籽杯学院赛，只接受
 * **学院代表队**报名。它只参与「资格判定与文案」，**不进 rules 快照**：
 * 一场学院赛的节数、犯规、加时与同项目的普通赛事完全一样。
 */
const CUP_MODE = {
  COLLEGE: 'college',
};

const CUP_MODE_LABEL = {
  [CUP_MODE.COLLEGE]: '学院赛',
};

/**
 * 团队比赛状态。
 *
 * 「已发布」与「已更正」是同一场的两个版本：比分可以改，但每次发布都留一版，
 * 个人累计按最新版本替换而不是再次累加。
 */
const TEAM_MATCH_STATUS = {
  SCHEDULED: 'scheduled', // 已排期
  LIVE: 'live', // 进行中（有录制员在录）
  REVIEWING: 'reviewing', // 待审核：录完了，等赛事管理员发布
  PUBLISHED: 'published', // 已发布：成绩与统计对外可见
  CANCELED: 'canceled', // 已取消
};

const TEAM_MATCH_STATUS_LABEL = {
  [TEAM_MATCH_STATUS.SCHEDULED]: '未开赛',
  [TEAM_MATCH_STATUS.LIVE]: '进行中',
  [TEAM_MATCH_STATUS.REVIEWING]: '待审核',
  [TEAM_MATCH_STATUS.PUBLISHED]: '已发布',
  [TEAM_MATCH_STATUS.CANCELED]: '已取消',
};

/** 统计完整性：区分「确认是 0」「还没录」「本赛事不统计」 */
const TEAM_STAT_INTEGRITY = {
  FULL: 'full', // 全部指标已录
  PARTIAL: 'partial', // 只录了部分指标
  BASIC: 'basic', // 只录了总分与犯规
  NONE: 'none', // 没有统计
};

/**
 * 统计的审核状态。
 *
 * 【为什么统计要独立于比赛再走一次审核】
 * 比赛发布的是「比分」，统计发布的是「谁得了多少分」。已发布比赛的统计如果
 * 还能直接改，球员榜就绕过了审核——录错一个人的 20 分，榜单立刻变形，而
 * 页面上看不出这一版有没有人核对过。所以已发布比赛的统计修改只写工作副本
 * （`pending`），对外仍读 `published` 快照，由管理员单独通过或退回。
 */
const TEAM_STAT_STATUS = {
  DRAFT: 'draft', // 未发布的比赛在录入中：本来就不对外可见
  PENDING: 'pending', // 已发布比赛的新版本，等管理员审核
  PUBLISHED: 'published', // 已发布：对外唯一可见的版本
};

const TEAM_STAT_STATUS_LABEL = {
  [TEAM_STAT_STATUS.DRAFT]: '录入中',
  [TEAM_STAT_STATUS.PENDING]: '统计待审核',
  [TEAM_STAT_STATUS.PUBLISHED]: '统计已发布',
};

/**
 * 名单人数的边界与默认区间（D22 / D28）。
 *
 * 管理员可在发布时自定义每院最少 / 最多报名人数，默认 4–20；替补计入其中
 * （名单里没上场的都算替补，不单列替补栏）。上下界本身另设硬限制：
 * 太少的「最少」等于没约束，太多的「最多」会把整个年级塞进一份名单。
 */
const ROSTER_LIMITS = {
  MIN: 1,
  /**
   * 单份学院赛名单的人数上限。
   *
   * 【为什么是 30】（第二十二轮 P2）
   * 提交名单在一个事务里逐人核对资格：每人 2 次点读（账号 + 学籍），限组赛事
   * 再加一次。事务总操作预算 100（见 cloud-repo 的 TX_OPERATION_BUDGET），
   * 固定开销约 10 次，30 人 = 10 + 3×30 = 100 —— 正好顶到上限、不能再放。
   * 原先写 50，但提交端只准备了 31 人的目录，32 人起报「查不到的会员」；
   * 两处数字必须由这一个常量说了算，改大就要同时改提交路径（批读 + 分批）。
   */
  MAX: 30,
  DEFAULT_MIN: 4,
  DEFAULT_MAX: 20,
};

/** 默认允许兼项（D20）：同一队员可参加多个小项 */
const DEFAULT_ALLOW_MULTI_ENTRY = true;

/**
 * 可用场地数的边界。
 *
 * 【为什么是必填而不是「不限」】
 * 场地数决定同一批能同时开打几场比赛。缺省成「不限」等于没有约束，
 * 排出来的场号也就无从谈起——所以发布时必须显式填一个数，不许留空。
 *
 * 【为什么上限是 20】
 * 与 ROSTER_LIMITS.MAX、学院赛 LEG_PLAN_MAX 同一量级：一个校园赛事同时
 * 开二十块场地已经远超实际，再多只可能是填错了。下限 1 是因为「一块
 * 场地都没有」的比赛排不出任何场号，没有意义。
 */
const COURT_LIMITS = {
  MIN: 1,
  MAX: 20,
};

/** 场地数文案：0 / 非法值一律显示「未设置」 */
function courtCountTextOf(count) {
  const value = Number(count);
  return Number.isFinite(value) && value >= COURT_LIMITS.MIN ? `${value} 块场地` : '未设置';
}

/** 场号文案：1 号场；未分配（0 / 非法）时为空串，界面据此不显示 */
function courtNoTextOf(courtNo) {
  const value = Number(courtNo);
  return Number.isFinite(value) && value >= 1 ? `${value} 号场` : '';
}

/**
 * 学院赛小场的赛制：11 分制、一局一胜。
 *
 * 【为什么写死而不是让管理员选】
 * 一场大场里往往有多个小项，每个小项再各自三局两胜，赛程会长到一天打不完；
 * 小场又是大场胜负的计量单位，赛制还得整齐划一才好比较「净胜」。因此
 * 学院赛先统一按一局一胜跑，需要时从这里整体调整——与个人赛 DEFAULT_FORMAT
 * （三局两胜）刻意不同。
 */
const COLLEGE_LEG_FORMAT = { gamePoints: 11, bestOf: 1 };

module.exports = {
  ROLE,
  ROLE_LABEL,
  ASSOC_ROLE,
  ASSOC_ROLE_LABEL,
  ASSOCIATION_STATUS,
  COLLEGES,
  USER_STATUS,
  USER_STATUS_LABEL,
  isMemberStatus,
  isRankable,
  GENDER,
  GENDER_LABEL,
  ALL_GENDERS,
  MATCH_TYPE,
  MATCH_TYPE_LABEL,
  RATING_POOL,
  RATING_POOL_LABEL,
  ALL_RATING_POOLS,
  MATCH_TYPE_TO_POOL,
  RANK_PROJECT,
  RANK_PROJECT_LABEL,
  ALL_RANK_PROJECTS,
  RANK_PROJECT_CONFIG,
  MATCH_STATUS,
  MATCH_STATUS_LABEL,
  SETTLEMENT_STATUS,
  EXCLUSION_REASON,
  ALGORITHM_VERSION,
  RATED_PAIR_LIMIT,
  EVENT_STATUS,
  EVENT_STATUS_LABEL,
  DEFAULT_EVENT_STATUS,
  BRACKET_STAGE,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  DEFAULT_BRONZE_MODE,
  SIGNUP_STATUS,
  SIGNUP_STATUS_LABEL,
  EVENT_LEVEL,
  EVENT_LEVEL_LABEL,
  EVENT_LEVEL_MULTIPLIER,
  DEFAULT_EVENT_LEVEL,
  SEED_MODE,
  SEED_MODE_LABEL,
  SEED_COUNTS,
  DEFAULT_SEED_COUNT,
  DOUBLES_SEED_MODES,
  TEAM_ID_SEPARATOR,
  EVENT_FORMAT,
  EVENT_FORMAT_LABEL,
  DEFAULT_EVENT_FORMAT,
  GROUPED_FORMATS,
  GROUP_COUNT_FORMATS,
  ADVANCE_FORMATS,
  KNOCKOUT_FORMATS,
  DOUBLE_ELIM_FORMATS,
  LADDER_FORMATS,
  DEFAULT_GF_RESET,
  EVENT_PLACEMENT_MODE,
  EVENT_PLACEMENT_MODE_LABEL,
  DEFAULT_PLACEMENT_MODE,
  COURT_LIMITS,
  courtCountTextOf,
  courtNoTextOf,
  stageOrder,
  GROUP_CONFIG,
  DEFAULT_GROUP_COUNT,
  DEFAULT_ADVANCE_PER_GROUP,
  TEAM,
  RANK_PERIOD,
  RANK_PERIOD_LABEL,
  RANK_SORT_BY,
  COLLECTION,
  STORAGE_KEY,
  DATA_SOURCE,
  ANNOUNCEMENT_CATEGORIES,
  ANNOUNCEMENT_STATUS,
  ANNOUNCEMENT_STATUS_LABEL,
  ASSOCIATION_NOTICE_STATUS,
  ASSOCIATION_NOTICE_STATUS_LABEL,
  TRAINING_STATUS,
  TRAINING_STATUS_LABEL,
  TRAINING_SIGNUP_STATUS,
  LEG_DISCIPLINE,
  LEG_DISCIPLINE_LABEL,
  ALL_LEG_DISCIPLINES,
  DOUBLES_DISCIPLINES,
  SINGLES_DISCIPLINES,
  LEG_DISCIPLINE_GENDERS,
  DISCIPLINE_MATCH_TYPE,
  requiredGendersOf,
  disciplineMatchType,
  disciplinesForMatchType,
  singleGenderOf,
  disciplineLabelOf,
  disciplineOptionsFor,
  TIE_ALGO,
  TIE_ALGO_LABEL,
  DEFAULT_TIE_ALGO,
  TIE_NET_MODE,
  TIE_NET_MODE_LABEL,
  DEFAULT_TIE_NET_MODE,
  COLLEGE_EVENT_STATUS,
  COLLEGE_EVENT_STATUS_LABEL,
  DEFAULT_COLLEGE_EVENT_STATUS,
  COLLEGE_ENTRY_STATUS,
  COLLEGE_ENTRY_STATUS_LABEL,
  TEAM_STATUS,
  TEAM_STATUS_LABEL,
  TEAM_TYPE,
  TEAM_TYPE_LABEL,
  TEAM_MEMBER_STATUS,
  TEAM_MEMBER_STATUS_LABEL,
  TEAM_EVENT_STATUS,
  TEAM_EVENT_STATUS_LABEL,
  CUP_MODE,
  CUP_MODE_LABEL,
  TEAM_ENTRY_STATUS,
  TEAM_ENTRY_STATUS_LABEL,
  TEAM_MATCH_STATUS,
  TEAM_MATCH_STATUS_LABEL,
  TEAM_STAT_INTEGRITY,
  TEAM_STAT_STATUS,
  TEAM_STAT_STATUS_LABEL,
  TIE_STATUS,
  TIE_STATUS_LABEL,
  DEFAULT_TIE_STATUS,
  MATCH_OUTCOME,
  MATCH_COMPETITION,
  ROSTER_LIMITS,
  DEFAULT_ALLOW_MULTI_ENTRY,
  COLLEGE_LEG_FORMAT,
};
