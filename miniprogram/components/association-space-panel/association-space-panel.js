/**
 * 协会空间面板（协会工作台内嵌页签）
 * ============================================================
 * 工作台顶层新增「协会空间」页签，排在第一且进入即默认展示。面板内含四个
 * 二级页签：分组 / 通知 / 训练 / 成员，默认展示「训练」（见规划 §3.1）。
 *
 * 【为什么二级也懒挂载】
 * 与顶层同理：一次全挂会同时取四份数据。只有切过去才挂，挂过的保持挂载，
 * 来回切不丢搜索词与滚动位置。
 *
 * 【本阶段落了什么】
 * P1 落「分组」「成员」；P2 落「通知」（发布 / 编辑 / 撤回 / 置顶，会员只读）；
 * P3 落「训练」（发布 / 筛选 / 报名 / 取消 / 名单管理）；P5 落「签到」：
 * 本人在窗口内提交 → 只到「待确认」，负责人确认后才计 1 分，并可退回 / 撤销
 * （见 training-points.js 与 association-training-service.js 的两步签到状态机）。
 *
 * 【取数一律绑定进入时的范围】
 * 学校取 school-session、协会取 association-scope，创建客户端时一次固定，
 * 之后的每个请求都用这把范围——不在异步等待期间再读全局状态（见 §9.4）。
 * ============================================================
 */

const identity = require('../../services/school-identity.js');
const space = require('../../services/association-space.js');
const { currentThemeClass } = require('../../services/branding.js');
const { ANNOUNCEMENT_CATEGORIES } = require('../../shared/utils/constants.js');
const { isMockNow } = require('../../services/runtime-mode.js');
const groupTab = require('./group-tab.js');
const memberTab = require('./member-tab.js');
const noticeTab = require('./notice-tab.js');
const trainingTab = require('./training-tab.js');
/** 二级页签定义。顺序即页面上的先后，默认落在「训练」 */
const SUB_TABS = [
  { key: 'group', label: '分组' },
  { key: 'notice', label: '通知' },
  { key: 'training', label: '训练' },
  { key: 'member', label: '成员' },
];
const DEFAULT_SUB = 'training';
const isKnownSub = (key) => SUB_TABS.some((def) => def.key === key);
/** 一格的名录一次取多少——既是成员页签一页，也是建组选人的候选池 */
const MEMBER_PAGE = 20;

/**
 * 搜索输入防抖窗口（2026-10-26 第四轮审查 P-1）。
 *
 * 【为什么必须有】名录搜索走的是服务端聚合（`schoolMembers` 关联 `users`
 * 再按计算字段排序），一次请求的成本与全校在册人数成正比。`bindinput` 每按
 * 一个键就发一次：输入「张宇轩」在中文输入法下是 3~6 次触发，等于 3~6 次全量
 * 聚合，而只有最后一次的结果会被看到。300ms 是「停下再取」的经验值，低于
 * 人对卡顿的感知阈值。
 */
const SEARCH_DEBOUNCE_MS = 300;
const PICK_POOL = 50;
/** 通知 / 训练列表一页条数 */
const NOTICE_PAGE = 20;
const TRAINING_PAGE = 20;

const pad2 = (value) => String(value).padStart(2, '0');
Component({
  options: {
    // 组件默认样式隔离，app.wxss 里的 .card / .pool-tabs / .btn 等全局类进不来。
    // apply-shared 让全局与所在页面的样式渗入组件，本面板的样式仍不外泄。
    styleIsolation: 'apply-shared',
  },

  properties: {
    active: { type: Boolean, value: true },
  },

  data: {
    loading: true,
    /* 首屏加载失败：只有这种「整块取不到数」才替换整个面板 */
    loadError: '',
    /* 表单 / 写操作的就地错误：显示在页签下方，不动面板结构 */
    error: '',
    notice: '',
    themeClass: '',
    /** 顶栏：当前学校与协会，避免只显示「匹克球」分不清民大与北航 */
    spaceTitle: '协会空间',

    /* 无权限：协会空间只对本校在册会员与管理者开放。
       与 error 分开——这不是「加载失败」，而是一道明确的准入线，
       要给出说明与「去学校身份页」的去路，而不是一句报错把整块面板打白。 */
    noAccess: false,
    noAccessNote: '',
    /** 无权限时给一个去学校身份页办理身份的入口（本地与云端一致） */
    canGoIdentity: false,

    /** 二级页签：[{ key, label, active }] */
    subTabs: SUB_TABS.map((def) => ({ ...def, active: def.key === DEFAULT_SUB })),
    activeSub: DEFAULT_SUB,
    /** 挂载过的二级页签，默认只挂「训练」 */
    mountedSub: { group: false, notice: false, training: true, member: false },

    // ---------- 分组页签 ----------
    groups: [],
    canManage: false,
    groupBusy: false,
    // 建组 / 编辑表单（同一份 groupForm 两处复用）
    showCreate: false,
    groupForm: { name: '', description: '' },
    /** 正在编辑的小组 id；空串表示没有在编辑 */
    editingId: '',
    /** 编辑时自带的版本号，提交时回传以防覆盖他人改动 */
    editRevision: 0,
    /** 建组候选：本协会在册会员（脱敏 DTO），筛选后的一页 */
    roster: [],
    selectedMemberIds: [],
    /**
     * 已选成员的展示行（[{ userId, nickName }]）。
     * 搜索会把已选的人筛到结果之外，只靠候选列表看不出来；这一行始终列出已选的人，
     * 点一下就取消，省得为了取消一个人再把他搜出来。
     */
    selectedMembers: [],
    /** 建组选人的搜索词（与成员页签的 keyword 各管一摊，互不串） */
    groupKeyword: '',
    /** 建组选人正在取数（搜索 / 加载更多） */
    groupLoading: false,
    /** 建组选人还有下一页 */
    groupHasMore: false,
    /** 建组选人的游标；关键词变化时必须重置（排序档位依赖关键词） */
    groupCursor: '',
    /** 建组选人一行都没有时给的原因 */
    groupEmptyNote: '',
    /** 展开的名册：groupId -> { loading, members } */
    openGroupId: '',
    detailMembers: [],
    detailLoading: false,

    // ---------- 成员页签 ----------
    keyword: '',
    members: [],
    memberCursor: '',
    memberHasMore: false,
    memberLoading: false,
    memberError: '',
    searching: false,
    memberEmptyNote: '',

    // ---------- 通知页签 ----------
    notices: [],
    noticeLoading: false,
    noticeError: '',
    noticeCursor: '',
    noticeHasMore: false,
    /** 分类白名单（复用全局公告的分类，避免两处口径分叉） */
    noticeCategories: ANNOUNCEMENT_CATEGORIES.slice(),
    noticeCategoryIndex: 0,
    showNoticeCreate: false,
    noticeForm: { title: '', content: '', category: ANNOUNCEMENT_CATEGORIES[0], pinned: false },
    editingNoticeId: '',
    noticeEditRevision: 0,

    // ---------- 训练页签 ----------
    trainings: [],
    trainingLoading: false,
    trainingError: '',
    trainingCursor: '',
    trainingHasMore: false,
    /** 状态筛选：'' 表示全部 */
    trainingFilter: '',
    trainingFilters: [
      { key: '', label: '全部' },
      { key: 'open', label: '可报名' },
      { key: 'ongoing', label: '进行中' },
      { key: 'finished', label: '已结束' },
      { key: 'canceled', label: '已取消' },
    ],
    showTrainingCreate: false,
    trainingForm: {
      title: '', description: '', location: '',
      date: '', time: '', endDate: '', endTime: '', capacity: '',
      audienceMode: 'all',
    },
    /** 发布/编辑表单里勾选的小组 id（限组时使用） */
    trainingAudience: [],
    /** 限组候选：[{ groupId, name, picked }]，WXML 不能 indexOf，选中态须预先算好 */
    audienceGroups: [],
    editingTrainingId: '',
    trainingEditRevision: 0,
    /** 展开详情的训练 id 与详情 / 名单 */
    openTrainingId: '',
    trainingDetail: null,
    trainingDetailError: '',
    trainingRoster: [],
    trainingDetailLoading: false,
    /**
     * 退回 / 撤销需要写原因。WXML 不便弹输入框，于是在名单行下方就地展开一个
     * 原因输入。approvalAction = { userId, kind }：kind 为 'reject' | 'revoke'。
     */
    approvalAction: null,
    approvalReason: '',
  },

  lifetimes: {
    attached() {
      this.destroyed = false;
      this.loadSeq = 0;
      this.onLoad();
    },
    /**
     * 卸载时收掉搜索防抖的定时器。
     *
     * 组件被销毁后 `setData` 会告警（「setData 在已销毁的组件上调用」），而防抖
     * 定时器正好是「延迟 300ms 之后才 setData」——不清理就是一次必然发生的告警。
     * 同时把还在等待的那次输入 resolve 掉，避免调用方（含用例）一直挂着。
     */
    detached() {
      // 卸载后作废在途装载；否则 await 回来的 setData 会打到已销毁的组件上。
      this.destroyed = true;
      this.loadSeq = (this.loadSeq || 0) + 1;
      this.cancelSearchTimers();
    },
  },

  pageLifetimes: {
    show() {
      if (typeof this.onShow === 'function') this.onShow();
    },
  },

  methods: {
    onLoad() {
      return this.refresh();
    },

    /**
     * 从别的页签切回时重算：刚建/退的组会改变列表。
     * loaded 只在首屏落地后置真，避免 attached 后紧跟的 show 白刷一遍。
     */
    onShow() {
      if (!this.loaded || this.data.active === false) return undefined;
      return this.refresh();
    },

    onPullDownRefresh() {
      return this.refresh().then(() => wx.stopPullDownRefresh());
    },

    /** 组装当前范围（学校 + 协会），并固定成本次的客户端 */
    scopeKey() {
      const schoolId = require('../../services/school-session.js').getSchoolId();
      const association = require('../../services/association-scope.js').getAssociation();
      return { schoolId, association };
    },

    /**
     * 标题：学校 + 协会。演示协会名（北航匹克球）已带学校前缀，避免「北航·北航匹克球」。
     * @param {string} schoolName
     * @param {string} associationName
     */
    composeTitle(schoolName, associationName) {
      if (!schoolName) return associationName || '协会空间';
      const rest = associationName && associationName.startsWith(schoolName)
        ? associationName.slice(schoolName.length)
        : associationName;
      return rest ? `${schoolName}·${rest}` : schoolName;
    },

    /** 装载首屏：学校名 + 分组列表 + 成员名录（供成员页签与建组选人共用） */
    async refresh() {
      const seq = this.loadSeq = (this.loadSeq || 0) + 1;
      try {
        const scope = this.scopeKey();
        this.api = space.forScope(scope);
        const sessionApi = identity.forSchoolIdentity(scope);
        this.scope = scope;

        let schoolName = '';
        try {
          const directory = await sessionApi.getSchoolDirectory();
          const found = directory && directory.ok && (directory.schools || []).find((row) => row.schoolId === scope.schoolId);
          if (found) schoolName = found.shortName || found.name || '';
          this.colleges = (directory && directory.colleges) || [];
        } catch (err) {
          console.error('[space] 学校目录读取失败', err);
        }
        // 演示简称只在 mock 数据源下兜底；云端模式读不到就留空，不拿演示数据冒充。
        schoolName = schoolName || (isMockNow()
          ? require('../../services/school-demo.js').schoolShortName(scope.schoolId) : '');
        const associationName = this.resolveAssociationName(scope.association);

        const [groupResult, memberResult] = await Promise.all([
          this.api.listAssociationGroups({ limit: 50 }),
          this.api.listAssociationMembers({ limit: PICK_POOL }),
        ]);
        if (this.destroyed || seq !== this.loadSeq) return undefined;
        this.loaded = true;
        // listAssociationGroups 的 ok:false 只出现在权限判定处（其余失败都抛异常，
        // 走下面的 catch）。因此这里能确定是「没有读取权」，而非加载故障。
        const denied = !groupResult.ok;
        const rosterRows = denied ? [] : (memberResult.members || []).map((row) => this.describeMember(row));
        const selected = denied ? [] : this.data.selectedMemberIds.slice();
        this.rememberMemberNames(rosterRows);
        this.setData({
          loading: false,
          loadError: '',
          error: '',
          noAccess: denied,
          noAccessNote: denied
            ? (groupResult.message || '协会空间仅对本校在册会员与管理者开放')
            : '',
          canGoIdentity: denied,
          spaceTitle: this.composeTitle(schoolName, associationName),
          themeClass: currentThemeClass(),
          groups: denied ? [] : (groupResult.groups || []).map((row) => this.describeGroup(row)),
          canManage: denied ? false : Boolean(groupResult.canManage),
          roster: this.markPicked(rosterRows, selected),
          selectedMembers: this.selectedRowsOf(selected),
          // 重新装载后选人区回到「无关键词的第一页」：搜索词不跨次保留，
          // 免得下次点开表单时列表是筛过的、却看不出筛了什么
          groupKeyword: '',
          groupLoading: false,
          groupCursor: denied ? '' : (memberResult.nextCursor || ''),
          groupHasMore: denied ? false : Boolean(memberResult.hasMore),
          groupEmptyNote: '',
        });
        // 无权限时不再往下拉数据——训练 / 通知同样是同一道准入线，拉了也是空。
        if (denied) return undefined;
        this.applyKeyword(this.data.keyword);
        // 训练是默认页签，首屏就得渲染出来；通知按需在首次切过去时再拉。
        await this.loadTrainings();
      } catch (err) {
        console.error('[space] 加载失败', err);
        this.loaded = true;
        this.setData({ loading: false, loadError: err.message || '协会空间加载失败，请下拉重试',
          themeClass: currentThemeClass() });
      }
    },

    /** 协会显示名：演示学校取演示名（带学校前缀），本校取注册表简称 */
    resolveAssociationName(association) {
      const schoolId = this.scope && this.scope.schoolId;
      const demo = isMockNow()
        ? require('../../services/school-demo.js').schoolAssociations(schoolId) : null;
      const found = demo && demo.find((item) => item.id === association);
      if (found) return found.name;
      return require('../../shared/utils/associations.js').getAssociation(association).shortName;
    },

    describeGroup(row) {
      return {
        groupId: row.groupId,
        name: row.name,
        description: row.description || '',
        status: row.status,
        archived: row.status === 'archived',
        cleanupPending: Boolean(row.cleanupPending),
        memberCount: row.memberCount || 0,
        revision: row.revision,
        joined: Boolean(row.joined),
        canReadRoster: row.canReadRoster === true,
      };
    },

    describeMember(row) {
      return {
        userId: row.userId,
        nickName: row.nickName || '',
        realName: row.realName || '',
        avatarUrl: row.avatarUrl || '',
        collegeName: row.collegeName || '',
        permissionLabel: row.permissionLabel || '',
        picked: false,
      };
    },

    /** 切二级页签。首次切到时挂上对应的栏目 */
    onSwitchSub(event) {
      const { sub } = event.currentTarget.dataset;
      if (!isKnownSub(sub) || sub === this.data.activeSub) return undefined;
      this.setData({
        activeSub: sub,
        subTabs: SUB_TABS.map((def) => ({ ...def, active: def.key === sub })),
        [`mountedSub.${sub}`]: true,
        // 上一个页签的表单错误不跟着漂到新页签
        error: '',
      });
      // 成员 / 通知首次展开时才拉第一页；挂过之后保留状态，来回切不重拉。
      if (sub === 'member' && !this.memberLoaded) {
        this.memberLoaded = true;
        return this.loadMembers();
      }
      if (sub === 'notice' && !this.noticeLoaded) return this.loadNotices();
      if (sub === 'training' && !this.trainingLoaded) return this.loadTrainings();
      return undefined;
    },

    /**
     * 无权限时的去路：跳到「学校身份」页办理 / 查看本校身份。
     *
     * 协会空间是学校维度的会员功能，只对本校在册会员与管理者开放。
     * 当前身份若不是本校在册会员（例如在浏览外校），这不是故障，是准入线——
     * 但用户得知道该去哪儿把身份办妥，否则只会看到一句「没有权限」卡在原地。
     * 办妥后回到本页时，工作台的 show 生命周期会触发重刷。
     */
    onGoSchoolIdentity() {
      return wx.navigateTo({ url: '/packageMember/school-identity/school-identity' });
    },

    ...groupTab,
    ...memberTab,
    ...noticeTab,
    ...trainingTab,
    writeSub(action, successText, reload) {
      if (this.data.groupBusy) return Promise.resolve();
      this.setData({ groupBusy: true, error: '', notice: '' });
      return Promise.resolve()
        .then(action)
        .then((result) => {
          if (!result || !result.ok) throw new Error((result && result.message) || '操作失败');
          return reload ? reload() : undefined;
        })
        .then(() => this.setData({ groupBusy: false, notice: successText || '操作成功' }))
        .catch((err) => this.setData({ groupBusy: false, error: err.message || '操作失败，请重试' }));
    },

    /**
     * 统一写操作：跑 action、拉起忙碌态、成功后重载首屏并给轻提示。
     * @param {Function} action 返回 Promise<{ok, message}>
     * @param {string} successText
     */
    write(action, successText) {
      if (this.data.groupBusy) return Promise.resolve();
      this.setData({ groupBusy: true, error: '', notice: '' });
      return Promise.resolve()
        .then(action)
        .then((result) => {
          if (!result || !result.ok) throw new Error((result && result.message) || '操作失败');
          return this.refresh();
        })
        .then(() => this.setData({ groupBusy: false, notice: successText || '操作成功' }))
        .catch((err) => this.setData({ groupBusy: false, error: err.message || '操作失败，请重试' }));
    },
  },
});
