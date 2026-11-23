const { withFormExperience } = require('../../templates/form-experience.js');
/**
 * 发布赛事
 * ============================================================
 * 只做一件事：把一张填好的单子变成一场「报名中」的赛事。
 * 表单校验与组装在 services/event.js（纯函数），发布本身走学校维度服务
 * （school-event-service 的 publishSchoolEvent），这里负责交互与 setData。
 *
 * 【为什么独立成页而不是详情页里的一个弹层】
 * 名称、等级、三四名赛方式、时间、场地、名额、说明七项，说明还要一大块
 * 输入区，弹层里挤不下；带参数的独立页也更好扩展。
 *
 * 【等级与三四名赛方式为什么默认不选】
 * 决策 13 / 8：两者都直接决定积分怎么算，留空取默认等于悄悄改分。
 * 数据层对历史赛事会按三级 / 并列兜底（见 event.js），但新建时必须由
 * 管理员亲手选定，所以这里初值就是「未选择」，不靠默认值蒙混过去。
 *
 * 【没有发布权为什么不让进】
 * 用户可能绕过赛事页直接从小程序码进来。填完再被拒，比一开始就说清楚
 * 糟得多，所以进来先判一道，不给表单。发布权取自学校维度身份会话
 * （canManageAssociation）——协会负责人及以上才能在本协会办个人赛。
 *
 * 【requestId 是什么】
 * 学校维度发布接口按 requestId 派生稳定编号：同一次提交重试（网络重发、
 * 连点）落到同一条；改了内容却复用同号则被拒。所以每次提交现生成一个。
 * ============================================================
 */

const {
  MATCH_TYPE,
  EVENT_LEVEL_LABEL,
  EVENT_BRONZE_MODE,
  EVENT_BRONZE_MODE_LABEL,
  EVENT_FORMAT,
  EVENT_FORMAT_LABEL,
  DEFAULT_EVENT_FORMAT,
  GROUP_CONFIG,
  DEFAULT_GROUP_COUNT,
  DEFAULT_ADVANCE_PER_GROUP,
  EVENT_PLACEMENT_MODE,
  DEFAULT_PLACEMENT_MODE,
  DEFAULT_GF_RESET,
  SEED_MODE,
  SEED_MODE_LABEL,
  SEED_COUNTS,
  DEFAULT_SEED_COUNT,
  DOUBLES_SEED_MODES,
  COURT_LIMITS,
  disciplineOptionsFor,
} = require('../../utils/constants.js');
const {
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
} = require('../../services/event.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const { drawCapacityOf } = require('../../utils/event-capacity.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 生成一次提交的请求编号：时间戳 + 随机后缀，满足服务端的编号字符集要求 */
function nextRequestId() {
  return `pub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 赛事等级下拉的取值与文案。顺序固定为 一级 → 二级 → 三级 */
const LEVELS = [1, 2, 3];
const LEVEL_LABELS = LEVELS.map((level) => EVENT_LEVEL_LABEL[level]);

/** 三四名赛方式下拉的取值与文案 */
const BRONZE_MODES = [EVENT_BRONZE_MODE.TIED, EVENT_BRONZE_MODE.PLAYOFF];
const BRONZE_LABELS = BRONZE_MODES.map((mode) => EVENT_BRONZE_MODE_LABEL[mode]);

/** 项目下拉。默认单打——双打赛事不计积分，别让人一进来就踩坑 */
const MATCH_TYPES = [MATCH_TYPE.SINGLES, MATCH_TYPE.DOUBLES];
const MATCH_TYPE_LABELS = ['单打', '双打'];

/**
 * 「组别」下拉：单打为 不限 / 男单 / 女单，双打为 不限 / 男双 / 女双 / 混双。
 * 选项由 constants 的真相源生成，与报名校验、学院赛排阵同一份定义。
 * 首项恒为「不限」（value 为空串），缺省即不按性别限制。
 */
const SINGLES_DISCIPLINES = disciplineOptionsFor(MATCH_TYPE.SINGLES);
const DOUBLES_DISCIPLINES = disciplineOptionsFor(MATCH_TYPE.DOUBLES);
const SINGLES_DISCIPLINE_LABELS = SINGLES_DISCIPLINES.map((item) => item.label);
const DOUBLES_DISCIPLINE_LABELS = DOUBLES_DISCIPLINES.map((item) => item.label);

/** 某个项目（单打 / 双打）下的组别选项，取值与文案各取一份 */
function disciplinesOf(matchType) {
  return matchType === MATCH_TYPE.DOUBLES ? DOUBLES_DISCIPLINES : SINGLES_DISCIPLINES;
}

/**
 * 赛制下拉。单打双打都显示——双打同样要抽签定赛程，可选赛制与单打一致。
 * 顺序按「由简到繁」：单败 → 循环 → 小组 → 各复合形态；前两项的下标
 * 与旧版一致，老表单行为不受影响。
 */
const FORMATS = [
  EVENT_FORMAT.SINGLE_ELIM,
  EVENT_FORMAT.ROUND_ROBIN,
  EVENT_FORMAT.GROUP_KNOCKOUT,
  EVENT_FORMAT.ROUND_ROBIN_KNOCKOUT,
  EVENT_FORMAT.DOUBLE_ELIM,
  EVENT_FORMAT.GROUP_DOUBLE_ELIM,
];
const FORMAT_LABELS = FORMATS.map((format) => EVENT_FORMAT_LABEL[format]);

/** 小组数下拉（仅小组赛显示）。取值固定为 GROUP_CONFIG 允许的档位 */
const GROUP_COUNT_OPTIONS = GROUP_CONFIG.COUNT_OPTIONS;
const GROUP_COUNT_LABELS = GROUP_COUNT_OPTIONS.map((count) => `${count} 组`);
const DEFAULT_GROUP_COUNT_INDEX = GROUP_COUNT_OPTIONS.indexOf(DEFAULT_GROUP_COUNT);

/** 每组出线人数下拉（仅小组赛显示） */
const ADVANCE_OPTIONS = GROUP_CONFIG.ADVANCE_OPTIONS;
const ADVANCE_LABELS = ADVANCE_OPTIONS.map((count) => `每组出线 ${count} 人`);
const DEFAULT_ADVANCE_INDEX = ADVANCE_OPTIONS.indexOf(DEFAULT_ADVANCE_PER_GROUP);

/** 单打的种子来源下拉：手工 / 等级分 / 赛季积分 */
const SINGLES_SEED_MODES = [SEED_MODE.MANUAL, SEED_MODE.ELO, SEED_MODE.POINTS];
const SINGLES_SEED_MODE_LABELS = SINGLES_SEED_MODES.map((mode) => SEED_MODE_LABEL[mode]);

/** 双打的种子来源下拉：没有赛季积分，只认手工指定 / 按等级分（决策 1、3） */
const DOUBLES_SEED_MODE_OPTIONS = DOUBLES_SEED_MODES;
const DOUBLES_SEED_MODE_LABELS = DOUBLES_SEED_MODE_OPTIONS.map((mode) => SEED_MODE_LABEL[mode]);

/** 种子数量下拉。只认 2 / 4 / 8（决策 3），默认 8。双打下数量指种子组数 */
const SEED_COUNT_OPTIONS = SEED_COUNTS;
const SEED_COUNT_LABELS = SEED_COUNTS.map((count) => `${count} 位`);
const SEED_COUNT_TEAM_LABELS = SEED_COUNTS.map((count) => `${count} 组`);
const DEFAULT_SEED_COUNT_INDEX = SEED_COUNTS.indexOf(DEFAULT_SEED_COUNT);

/** 日期选择器的下界：今天。赛事不该往过去发 */
function todayText(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

Page(withFormExperience({
  data: {
    capacity: drawCapacityOf({ matchType: MATCH_TYPE.SINGLES }),
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock: false,
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',

    /** 没有发布权时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 各下拉的数据源与当前下标 */
    matchTypes: MATCH_TYPE_LABELS,
    matchTypeIndex: 0,
    // 组别随项目切换：单打列 不限/男单/女单，双打列 不限/男双/女双/混双
    disciplines: SINGLES_DISCIPLINE_LABELS,
    disciplineIndex: 0,
    formats: FORMAT_LABELS,
    formatIndex: FORMATS.indexOf(DEFAULT_EVENT_FORMAT),
    groupCounts: GROUP_COUNT_LABELS,
    // 小组参数预填默认值；只有选中「小组赛」时才显示，也允许不选
    groupCountIndex: DEFAULT_GROUP_COUNT_INDEX,
    advanceOptions: ADVANCE_LABELS,
    advanceIndex: DEFAULT_ADVANCE_INDEX,
    levels: LEVEL_LABELS,
    levelIndex: 0,
    bronzeModes: BRONZE_LABELS,
    bronzeIndex: 0,
    // 种子来源的可选项随项目变：切到双打会去掉「按积分」（见 onPickMatchType）
    seedModes: SINGLES_SEED_MODE_LABELS,
    seedModeIndex: 0,
    seedCounts: SEED_COUNT_LABELS,
    // 数量按决策 3 预填 8，来源仍需管理员显式选定
    seedCountIndex: DEFAULT_SEED_COUNT_INDEX,

    /** 日期选择器的下界 */
    today: todayText(),

    /** 输入长度上限，交给 maxlength 属性 */
    titleMax: TITLE_MAX,
    descriptionMax: DESCRIPTION_MAX,
    locationMax: LOCATION_MAX,
    /** 场地数的提示区间，模板里拼进占位符 */
    courtMin: COURT_LIMITS.MIN,
    courtMax: COURT_LIMITS.MAX,

    /** 表单本体。level / bronzeMode 初值为空，必须由管理员选定 */
    form: {
      title: '',
      description: '',
      matchType: MATCH_TYPES[0],
      // 组别留空即「不限」：不选就不会按性别拦人，与旧赛事行为一致
      discipline: '',
      // 赛制预填单败淘汰：不选就是旧行为，老流程无感
      format: DEFAULT_EVENT_FORMAT,
      groupCount: DEFAULT_GROUP_COUNT,
      advancePerGroup: DEFAULT_ADVANCE_PER_GROUP,
      placementMode: DEFAULT_PLACEMENT_MODE,
      // 双败总决赛重赛：标准口径默认开启（决策 D3）
      gfReset: DEFAULT_GF_RESET,
      level: null,
      bronzeMode: '',
      // 种子来源留空必须显式选；数量预填默认值（决策 2 / 3）
      seedMode: '',
      seedCount: DEFAULT_SEED_COUNT,
      location: '',
      date: '',
      time: '',
      quota: '',
      // 可用场地数：必填，初值留空，必须由管理员填
      courtCount: '',
    },
    /** 逐字段的错误提示 */
    errors: {},
    /** 整体错误提示 */
    errorText: '',

    // ---------- 报名资格（小组限制，B6） ----------
    audienceModes: ['不限小组', '仅限所选小组'],
    audienceIndex: 0,
    /** 本协会小组清单（{ groupId, name, checked }） */
    groups: [],
    /** 已勾选的小组编号（发布时随单子提交） */
    selectedGroupIds: [],
  },

  async onLoad() {
    this.setData({ isMock: isMockNow() });
    const scope = this.currentScope();
    this.scope = scope;

    let session = null;
    try {
      session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
    } catch (err) {
      console.error('[event-edit] 读取学校身份失败', err);
    }

    const allowed = Boolean(session && session.canManageAssociation);
    this.setData({ blockReason: this.describeBlock(allowed, session), themeClass: currentThemeClass() });

    // 小组清单：发布页用来勾选报名资格。读不到（未启用 / 无权限）就保持空清单，
    // 只有选了「仅限小组」却没有任何小组可选时，提交端会据服务端校验给出提示。
    try {
      const result = await space.forScope(scope).listAssociationGroups({});
      if (result && result.ok) {
        this.setData({ groups: (result.groups || []).map((row) => ({ groupId: row.groupId, name: row.name, checked: false })) });
      }
    } catch (err) {
      console.error('[event-edit] 读取小组清单失败', err);
    }
  },

  /** 当前「学校 + 协会」范围。写操作复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
  },

  /**
   * 不能发布的原因。能发布时返回空串。
   * 有没有在册学校身份（account）决定是「去登录」还是「没权限」——演示账号里
   * 没有停用的平台账号，拿 user 判不出「没有学校身份」。
   */
  describeBlock(allowed, session) {
    if (allowed) return '';
    return session && session.account
      ? '当前账号没有发布赛事的权限，请联系管理员'
      : '请先登录后再发布赛事';
  },

  /** 轻提示。测试环境里可能没有这个 API */
  showToast(title, icon = 'none') {
    if (typeof wx !== 'undefined' && typeof wx.showToast === 'function') {
      wx.showToast({ title, icon });
    }
  },

  /* ---------- 表单交互 ---------- */

  /**
   * 写入一个字段，并清掉它的旧错误。
   * 一律走这里，免得某个字段改了、错误提示却没跟着消失。
   */
  setField(key, value) {
    this.setData({
      form: { ...this.data.form, [key]: value },
      errors: { ...this.data.errors, [key]: '' },
      errorText: '',
    });
  },

  onInputTitle(event) {
    this.setField('title', event.detail.value);
  },

  onInputDescription(event) {
    this.setField('description', event.detail.value);
  },

  onInputLocation(event) {
    this.setField('location', event.detail.value);
  },

  onInputQuota(event) {
    this.setField('quota', event.detail.value);
  },

  onInputCourtCount(event) {
    this.setField('courtCount', event.detail.value);
  },

  onPickMatchType(event) {
    const index = Number(event.detail.value);
    const type = MATCH_TYPES[index];
    if (type === undefined) return;
    const doubles = type === MATCH_TYPE.DOUBLES;
    // 种子来源与数量随项目换一档：双打没有赛季积分（来源只剩手工 / 等级分），
    // 数量也从「几位」变成「几组」。若此前在单打下选了「按积分」，切到双打要
    // 把它清掉，否则会带着一个双打不合法的来源提交，白白吃一条校验错误
    const allowed = doubles ? DOUBLES_SEED_MODE_OPTIONS : SINGLES_SEED_MODES;
    const resetMode = doubles && !allowed.includes(this.data.form.seedMode);
    this.setData({
      matchTypeIndex: index,
      capacity: drawCapacityOf({ matchType: type }),
      errors: { ...this.data.errors, quota: '' },
      // 组别选项随项目换一套，且一并复位到「不限」——单打选过「男单」再切双打，
      // 男单不是双打的合法组别，留着会带着一个必被校验拒绝的值提交
      disciplines: doubles ? DOUBLES_DISCIPLINE_LABELS : SINGLES_DISCIPLINE_LABELS,
      disciplineIndex: 0,
      seedModes: doubles ? DOUBLES_SEED_MODE_LABELS : SINGLES_SEED_MODE_LABELS,
      seedCounts: doubles ? SEED_COUNT_TEAM_LABELS : SEED_COUNT_LABELS,
      seedModeIndex: resetMode ? 0 : this.data.seedModeIndex,
    });
    this.setField('matchType', type);
    this.setField('discipline', '');
    if (resetMode) this.setField('seedMode', '');
  },

  /** 组别：不限 / 男单 / 女单（单打），不限 / 男双 / 女双 / 混双（双打） */
  onPickDiscipline(event) {
    const index = Number(event.detail.value);
    const options = disciplinesOf(this.data.form.matchType);
    const option = options[index];
    if (!option) return;
    this.setData({ disciplineIndex: index });
    this.setField('discipline', option.value);
  },

  onPickFormat(event) {
    const index = Number(event.detail.value);
    const format = FORMATS[index];
    if (format === undefined) return;
    this.setData({ formatIndex: index });
    this.setField('format', format);
  },

  onPickGroupCount(event) {
    const index = Number(event.detail.value);
    const count = GROUP_COUNT_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ groupCountIndex: index });
    this.setField('groupCount', count);
  },

  onPickAdvance(event) {
    const index = Number(event.detail.value);
    const count = ADVANCE_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ advanceIndex: index });
    this.setField('advancePerGroup', count);
  },

  /** 倒三角排位开关：勾上则八强负者加赛分出 5–8 名 */
  onToggleTop8(event) {
    this.setField(
      'placementMode',
      event.detail.value ? EVENT_PLACEMENT_MODE.TOP8 : EVENT_PLACEMENT_MODE.NONE
    );
  },

  /** 双败总决赛重赛开关：勾上则败者组冠军赢了首场要加赛定冠军 */
  onToggleGfReset(event) {
    this.setField('gfReset', Boolean(event.detail.value));
  },

  onPickLevel(event) {
    const index = Number(event.detail.value);
    const level = LEVELS[index];
    if (level === undefined) return;
    this.setData({ levelIndex: index });
    this.setField('level', level);
  },

  onPickBronzeMode(event) {
    const index = Number(event.detail.value);
    const mode = BRONZE_MODES[index];
    if (mode === undefined) return;
    this.setData({ bronzeIndex: index });
    this.setField('bronzeMode', mode);
  },

  onPickSeedMode(event) {
    const index = Number(event.detail.value);
    // 取哪一张表要与界面显示的 seedModes 一致，否则双打下会错位取到「按积分」
    const modes =
      this.data.form.matchType === MATCH_TYPE.DOUBLES ? DOUBLES_SEED_MODE_OPTIONS : SINGLES_SEED_MODES;
    const mode = modes[index];
    if (mode === undefined) return;
    this.setData({ seedModeIndex: index });
    this.setField('seedMode', mode);
  },

  onPickSeedCount(event) {
    const index = Number(event.detail.value);
    const count = SEED_COUNT_OPTIONS[index];
    if (count === undefined) return;
    this.setData({ seedCountIndex: index });
    this.setField('seedCount', count);
  },

  onPickDate(event) {
    this.setField('date', event.detail.value);
  },

  onPickTime(event) {
    this.setField('time', event.detail.value);
  },

  /* ---------- 报名资格（小组限制，B6） ---------- */

  /** 不限 / 仅限所选小组 */
  onPickAudience(event) {
    const index = Number(event.detail.value);
    if (index !== 0 && index !== 1) return;
    this.setData({ audienceIndex: index });
  },

  /** 勾选 / 取消一个小组；并集命中任一即可报名 */
  onToggleGroup(event) {
    const groupId = event.currentTarget.dataset.groupId;
    if (!groupId) return;
    const selected = this.data.selectedGroupIds.includes(groupId)
      ? this.data.selectedGroupIds.filter((id) => id !== groupId)
      : [...this.data.selectedGroupIds, groupId];
    this.setData({
      selectedGroupIds: selected,
      groups: this.data.groups.map((row) => (row.groupId === groupId ? { ...row, checked: !row.checked } : row)),
    });
  },

  /* ---------- 提交 ---------- */

  /**
   * 把日期与时间两栏拼成 ISO 绝对串，缺一不可。
   *
   * 【为什么先解析再 toISOString，而不是直接拼串】
   * picker 两栏是本地墙上时间。云函数容器时区是 UTC+0、小程序端是 UTC+8，
   * 直接发 `2026-10-17T19:30:00` 会被服务端按 UTC 解析、比用户选的时间
   * 晚 8 小时——报名截止与开赛判定跟着错（2026-10-17 只读审计 C1）。
   * 样板见 pages/school-exchange 的创建跨校赛事。
   */
  buildStartTime() {
    const { date, time } = this.data.form;
    if (!date || !time) return '';
    const at = new Date(`${date}T${time}:00`);
    return Number.isFinite(at.getTime()) ? at.toISOString() : '';
  },

  /**
   * 提交。校验不通过时逐字段标红并给一条总提示——只标红的话，
   * 用户可能滚不到出错的那一项。
   */
  async onSubmit() {
    if (this.data.submitting) return undefined;
    if (this.data.blockReason) return undefined;

    const form = { ...this.data.form, startTime: this.buildStartTime() };
    const capacity = drawCapacityOf(form);
    if (Number(form.quota) > capacity) {
      const message = `本项目最多 ${capacity} 人，请调整名额`;
      this.setData({ errors: { quota: message }, errorText: message });
      return;
    }
    // 报名资格：不限小组，或勾选的小组（B6）
    const audience = this.data.audienceIndex === 1
      ? { audienceMode: 'groups', audienceGroupIds: this.data.selectedGroupIds }
      : { audienceMode: 'all', audienceGroupIds: [] };

    this.setData({ submitting: true, errors: {}, errorText: '' });
    const result = await space.forScope(this.scope || this.currentScope())
      .publishSchoolEvent({ ...form, ...audience, requestId: nextRequestId() });

    if (!result.ok) {
      this.setData({
        submitting: false,
        errors: result.errors || {},
        errorText: result.firstError || result.message || '发布失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已发布', 'success');
    // 退回赛事页，onShow 会刷新，刚发的这场就在列表里
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
}));
