const { withFormExperience } = require('../../templates/form-experience.js');
/**
 * 发布学院赛
 * ============================================================
 * 只做一件事：把一张填好的单子变成一场「报名中」的学院赛。
 * 校验与组装在 services/college-event.js（纯函数）；写入由协会空间按当前身份
 * 执行（学校维度按 requestId 派生稳定编号做幂等）。这里负责交互与 setData。
 *
 * 【为什么独立成页而不是赛事页里的一个弹层】
 * 小项序列、人数上下限、胜负算法、净胜口径、时间、场地、说明七项，
 * 说明还要一大块输入区，弹层里挤不下；带参数的独立页也更好扩展。
 *
 * 【为什么小项要逐项添加而不是勾选】
 * 一场学院赛的大场由若干小项按顺序组成（例如男单 → 女单 → 混双），
 * 「打哪几项」与「第几项打什么」都是规则的一部分。勾选只是一个集合，
 * 定不了先后；改成默认一项、点「+」逐项添加，录入顺序就是出场顺序。
 *
 * 【胜负算法为什么必选、净胜口径为什么按条件显示】
 * 「打满比净胜」与「先到 N 场胜」是两种完全不同的判分口径，留空取默认
 * 等于悄悄替管理员定了规则；而净胜口径只对前者有意义，选后者时这一项
 * 不显示，校验也会跳过（见 college-event.validateCollegeEvent）。
 *
 * 【没有发布权为什么不让进】
 * 用户可能绕过入口直接从小程序码进来。填完再被拒，比一开始就说清楚
 * 糟得多，所以进来先判一道，不给表单。
 * ============================================================
 */

const {
  ALL_LEG_DISCIPLINES,
  LEG_DISCIPLINE_LABEL,
  TIE_ALGO,
  TIE_ALGO_LABEL,
  DEFAULT_TIE_ALGO,
  TIE_NET_MODE,
  TIE_NET_MODE_LABEL,
  DEFAULT_TIE_NET_MODE,
  ROSTER_LIMITS,
  DEFAULT_ALLOW_MULTI_ENTRY,
  COURT_LIMITS,
} = require('../../utils/constants.js');
const {
  TITLE_MAX,
  DESCRIPTION_MAX,
  LOCATION_MAX,
  LEG_PLAN_MAX,
} = require('../../services/college-event.js');
const { canPublishCollegeEvent } = require('../../services/school-college-view.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const { currentThemeClass } = require('../../services/branding.js');
const schoolSession = require('../../services/school-session.js');
const associationScope = require('../../services/association-scope.js');
const space = require('../../services/association-space.js');
const identity = require('../../services/school-identity.js');
const { getAssociation } = require('../../utils/associations.js');
const { LEGACY_SCHOOL_ID } = require('../../utils/school.js');

/** 生成一次提交的请求编号：时间戳 + 随机后缀，满足服务端的编号字符集要求 */
function nextRequestId() {
  return `pub_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 大场胜负算法下拉。顺序：打满比净胜 → 先到 N 场胜 */
const TIE_ALGOS = [TIE_ALGO.FULL_POINTS, TIE_ALGO.FIRST_TO_N];
const TIE_ALGO_LABELS = TIE_ALGOS.map((algo) => TIE_ALGO_LABEL[algo]);

/** 净胜口径下拉。仅「打满比净胜」时显示 */
const TIE_NET_MODES = [TIE_NET_MODE.WIN_DIFF, TIE_NET_MODE.POINT_DIFF];
const TIE_NET_MODE_LABELS = TIE_NET_MODES.map((mode) => TIE_NET_MODE_LABEL[mode]);

/** 小项下拉的取值与文案：男单 / 女单 / 男双 / 女双 / 混双 */
const LEG_VALUES = ALL_LEG_DISCIPLINES;
const LEG_LABELS = LEG_VALUES.map((value) => LEG_DISCIPLINE_LABEL[value]);

/** 新建表单默认先摆一项（男单），其余由管理员点「+」逐项加 */
const DEFAULT_LEG_VALUE = LEG_VALUES[0];

/**
 * 小项序列 → 页面上的行。每行带 picker 的下标与展示文案。
 * 行号即出场顺序：第 1 行打第 1 项。
 *
 * @param {string[]} legPlan
 * @returns {Array<{row:number, value:string, valueIndex:number, label:string}>}
 */
function buildLegRows(legPlan) {
  return (Array.isArray(legPlan) ? legPlan : []).map((value, row) => ({
    row,
    value,
    // 取值不在池内时下标退回 0，至少让 picker 有个合法位置
    valueIndex: Math.max(0, LEG_VALUES.indexOf(value)),
    label: LEG_DISCIPLINE_LABEL[value] || value,
  }));
}

/**
 * 加一项时先挑还没出现过的项目，省得每次都要再改一下；
 * 五项都出现过后就从男单再来一个（小项允许重复）。
 *
 * @param {string[]} legPlan
 * @returns {string}
 */
function nextLegValue(legPlan) {
  const used = new Set(Array.isArray(legPlan) ? legPlan : []);
  return LEG_VALUES.find((value) => !used.has(value)) || LEG_VALUES[0];
}

/** 日期选择器的下界：今天。赛事不该往过去发 */
function todayText(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

Page(withFormExperience({
  data: {
    /** 提交中，防止连点重复提交 */
    submitting: false,
    isMock: false,
    /** 当前协会的主题类，挂在页面根节点上 */
    themeClass: '',

    /** 所属项目（石榴籽杯的三个球类之一）：由进入时选定的项目决定，表单内不可改 */
    projectName: '',

    /** 没有发布权时的原因，非空就在页面上顶掉整张表单 */
    blockReason: '',

    /** 小项行与下拉，以及各下拉的数据源、当前下标 */
    legLabels: LEG_LABELS,
    legRows: buildLegRows([DEFAULT_LEG_VALUE]),
    legMax: LEG_PLAN_MAX,
    tieAlgos: TIE_ALGO_LABELS,
    tieAlgoIndex: TIE_ALGOS.indexOf(DEFAULT_TIE_ALGO),
    tieNetModes: TIE_NET_MODE_LABELS,
    tieNetModeIndex: TIE_NET_MODES.indexOf(DEFAULT_TIE_NET_MODE),

    /** 日期选择器的下界 */
    today: todayText(),

    /** 输入长度上限，交给 maxlength 属性 */
    titleMax: TITLE_MAX,
    descriptionMax: DESCRIPTION_MAX,
    locationMax: LOCATION_MAX,

    /** 人数硬边界，交给输入提示 */
    rosterHardMin: ROSTER_LIMITS.MIN,
    rosterHardMax: ROSTER_LIMITS.MAX,

    /** 场地数硬边界，交给输入提示 */
    courtHardMin: COURT_LIMITS.MIN,
    courtHardMax: COURT_LIMITS.MAX,

    /** 表单本体。tieAlgo 初值为默认算法，但净胜口径随算法显隐 */
    form: {
      title: '',
      description: '',
      // 默认摆一项（男单）：大场至少有得打，管理员再按需加
      legPlan: [DEFAULT_LEG_VALUE],
      allowMultiEntry: DEFAULT_ALLOW_MULTI_ENTRY,
      rosterMin: ROSTER_LIMITS.DEFAULT_MIN,
      rosterMax: ROSTER_LIMITS.DEFAULT_MAX,
      tieAlgo: DEFAULT_TIE_ALGO,
      tieNetMode: DEFAULT_TIE_NET_MODE,
      location: '',
      date: '',
      time: '',
      // 可用场地数：必填，初值留空（一个大场占一块场地）
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

  async onLoad(query = {}) {
    this.setData({ isMock: isMockNow() });
    // 石榴籽杯首页带项目进来：直接锁定到该项目，避免落到全局默认协会。
    // 关键兜底——用户不经杯赛首页、直接从小程序码 / 分享链接进发布页时，
    // 全局当前协会可能仍是别的球类，必须按参数强制归属，否则会发到错误的项目。
    this.applyProjectFromQuery(query);
    const scope = this.currentScope();
    this.scope = scope;

    // 有没有在册学校身份（account）决定是「去登录」还是「没权限」——演示账号里
    // 没有停用的平台账号，拿 user 判不出「没有学校身份」。
    let session = null;
    try {
      session = await identity.forSchoolIdentity(scope).getSchoolIdentitySession();
    } catch (err) {
      console.error('[college-event-edit] 读取学校身份失败', err);
    }

    // 发布权以服务端算好的 canManageCollegeEvent 为准（借列表读端探针），
    // 不在页面上拼角色——判权与服务端同一把尺子。
    let allowed = false;
    try {
      allowed = await canPublishCollegeEvent({ schoolId: scope.schoolId, association: scope.association });
    } catch (err) {
      console.error('[college-event-edit] 发布权探针失败', err);
    }

    this.setData({
      blockReason: this.describeBlock(allowed, session),
      themeClass: currentThemeClass(),
      projectName: this.projectNameOf(scope.association),
    });

    // 小组清单（报名资格勾选用，B6）。读不到就保持空清单，提交端由服务端校验把关。
    try {
      const result = await space.forScope(scope).listAssociationGroups({});
      if (result && result.ok) {
        this.setData({ groups: (result.groups || []).map((row) => ({ groupId: row.groupId, name: row.name, checked: false })) });
      }
    } catch (err) {
      console.error('[college-event-edit] 读取小组清单失败', err);
    }
  },

  /**
   * 杯赛首页带项目进来时锁定协会；无参数或已是该项目则不动。
   * 单独抽出来是为了可测——发布页的其余逻辑不应关心「项目从哪来」。
   *
   * @param {Object} query onLoad 的入参，可能带 projectId
   */
  applyProjectFromQuery(query) {
    const wanted = query && query.projectId;
    if (wanted && associationScope.getAssociation() !== wanted) {
      associationScope.setAssociation(wanted);
    }
  },

  /** 当前「学校 + 协会」范围。写操作复用它，避免异步期间全局范围被切走 */
  currentScope() {
    return {
      schoolId: schoolSession.getSchoolId() || LEGACY_SCHOOL_ID,
      association: associationScope.getAssociation(),
    };
  },

  /** 所属项目的展示名；注册表里没有就留空，不显示半截文案 */
  projectNameOf(associationId) {
    try {
      return getAssociation(associationId).sportName || '';
    } catch (err) {
      return '';
    }
  },

  /** 不能发布的原因。能发布时返回空串 */
  describeBlock(allowed, session) {
    if (allowed) return '';
    return session && session.account
      ? '当前账号没有发布学院赛的权限，请联系管理员'
      : '请先登录后再发布学院赛';
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

  onInputCourtCount(event) {
    this.setField('courtCount', event.detail.value);
  },

  onInputRosterMin(event) {
    this.setField('rosterMin', event.detail.value);
  },

  onInputRosterMax(event) {
    this.setField('rosterMax', event.detail.value);
  },

  /**
   * 写入小项序列：整块替换 form.legPlan 与界面上的行，并清掉旧错误。
   * 一律走这里，免得某次改动只更新了一边（序列与行对不上）。
   */
  applyLegPlan(legPlan) {
    this.setData({
      form: { ...this.data.form, legPlan },
      errors: { ...this.data.errors, legPlan: '' },
      errorText: '',
      legRows: buildLegRows(legPlan),
    });
  },

  /** 改某一行的项目 */
  onPickLeg(event) {
    const row = Number(event.currentTarget.dataset.row);
    const value = LEG_VALUES[Number(event.detail.value)];
    if (value === undefined) return;
    const legPlan = (this.data.form.legPlan || []).slice();
    if (!(row >= 0 && row < legPlan.length)) return;
    legPlan[row] = value;
    this.applyLegPlan(legPlan);
  },

  /** 加一个小项：默认挑还没出现过的项目，省得每次都要再改一下 */
  onAddLeg() {
    const legPlan = (this.data.form.legPlan || []).slice();
    if (legPlan.length >= this.data.legMax) {
      this.showToast(`一场大场最多 ${this.data.legMax} 个小项`);
      return undefined;
    }
    legPlan.push(nextLegValue(legPlan));
    this.applyLegPlan(legPlan);
    return undefined;
  },

  /** 删掉某一行。至少保留一项——没有小项的大场排不出来 */
  onRemoveLeg(event) {
    const legPlan = (this.data.form.legPlan || []).slice();
    if (legPlan.length <= 1) {
      this.showToast('一场大场至少要有一个小项');
      return undefined;
    }
    const row = Number(event.currentTarget.dataset.row);
    if (!(row >= 0 && row < legPlan.length)) return undefined;
    legPlan.splice(row, 1);
    this.applyLegPlan(legPlan);
    return undefined;
  },

  /** 是否允许多项兼报 */
  onToggleMultiEntry(event) {
    this.setField('allowMultiEntry', Boolean(event.detail.value));
  },

  onPickTieAlgo(event) {
    const index = Number(event.detail.value);
    const algo = TIE_ALGOS[index];
    if (algo === undefined) return;
    this.setData({ tieAlgoIndex: index });
    this.setField('tieAlgo', algo);
  },

  onPickTieNetMode(event) {
    const index = Number(event.detail.value);
    const mode = TIE_NET_MODES[index];
    if (mode === undefined) return;
    this.setData({ tieNetModeIndex: index });
    this.setField('tieNetMode', mode);
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
    // 报名资格：不限小组，或勾选的小组（B6）
    const audience = this.data.audienceIndex === 1
      ? { audienceMode: 'groups', audienceGroupIds: this.data.selectedGroupIds }
      : { audienceMode: 'all', audienceGroupIds: [] };

    this.setData({ submitting: true, errors: {}, errorText: '' });
    const result = await space.forScope(this.scope || this.currentScope())
      .publishCollegeEvent({ ...form, ...audience, requestId: nextRequestId() });

    if (!result || !result.ok) {
      this.setData({
        submitting: false,
        errors: (result && result.errors) || {},
        errorText: (result && (result.firstError || result.message)) || '发布失败',
      });
      return undefined;
    }

    this.setData({ submitting: false });
    this.showToast('已发布', 'success');
    // 退回上一页，onShow 会刷新，刚发的这场就在列表里
    wx.navigateBack();
    return undefined;
  },

  onCancel() {
    wx.navigateBack();
  },
}));
