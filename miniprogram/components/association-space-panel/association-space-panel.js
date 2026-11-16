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
const { validateAnnouncement } = require('../../services/announcement.js');
const { ANNOUNCEMENT_CATEGORIES } = require('../../utils/constants.js');
const { formatDateTime } = require('../../utils/format.js');

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
const ymd = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const hm = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
/** 本地日期 + 时间拼成可被 Date.parse 解析的本地时刻串；缺一即视为未填 */
/**
 * 日期 + 时间两栏（picker 产出，本地墙上时间）→ ISO 绝对串。
 *
 * 【为什么不能直接拼 naive 串】（2026-10-17 只读审计 C1）
 * 云函数容器时区是 UTC+0、小程序端是 UTC+8。直接发 `2026-10-17T19:30`
 * 会被服务端按 UTC 解析，比用户选的时间晚 8 小时：发布训练的「开始必须在
 * 未来」校验、报名截止、签到窗口全部按错误时刻判定。先在本地时区解析再
 * `toISOString()`，两端才解析同一个绝对时刻（样板见 school-exchange 页）。
 *
 * 只用于组装 payload；回显走 isoToLocal（下方）， round-trip 不依赖本函数。
 */
const localMoment = (date, time) => {
  if (!date || !time) return '';
  const at = new Date(`${date}T${time}`);
  return Number.isFinite(at.getTime()) ? at.toISOString() : '';
};

Component({
  options: {
    // 组件默认样式隔离，app.wxss 里的 .card / .pool-tabs / .btn 等全局类进不来。
    // apply-shared 让全局与所在页面的样式渗入组件，本面板的样式仍不外泄。
    styleIsolation: 'apply-shared',
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
      if (!this.loaded) return undefined;
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
        schoolName = schoolName || require('../../services/school-demo.js').schoolShortName(scope.schoolId);
        const associationName = this.resolveAssociationName(scope.association);

        const [groupResult, memberResult] = await Promise.all([
          this.api.listAssociationGroups({ limit: 50 }),
          this.api.listAssociationMembers({ limit: PICK_POOL }),
        ]);
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
      const demo = require('../../services/school-demo.js').schoolAssociations(schoolId);
      const found = demo && demo.find((item) => item.id === association);
      if (found) return found.name;
      return require('../../utils/associations.js').getAssociation(association).shortName;
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

    /* ============================================================
     * 分组页签
     * ============================================================ */

    onToggleCreate() {
      if (!this.data.canManage || this.data.groupBusy) return undefined;
      const open = !this.data.showCreate;
      this.requestId = '';
      this.setData({
        showCreate: open,
        editingId: '',
        groupForm: { name: '', description: '' },
        selectedMemberIds: [],
        selectedMembers: [],
        groupKeyword: '',
        roster: this.data.roster.map((row) => ({ ...row, picked: false })),
        notice: '',
      });
      // 打开表单时按「无关键词的第一页」重取一次：上一次可能搜过、也可能翻过页，
      // 直接沿用会让管理员对着一个自己都不记得筛过的名单选人
      return open ? this.loadGroupRoster() : undefined;
    },

    /** 展开/收起某个小组的编辑表单（点第二次收起，不再请求） */
    onToggleEdit(event) {
      const groupId = event.currentTarget.dataset.groupid;
      const revision = event.currentTarget.dataset.revision;
      if (!groupId || this.data.groupBusy) return undefined;
      if (this.data.editingId === groupId) {
        return this.setData({ editingId: '' });
      }
      const group = this.data.groups.find((row) => row.groupId === groupId);
      if (!group) return undefined;
      return this.setData({
        editingId: groupId,
        editRevision: revision,
        showCreate: false,
        groupForm: { name: group.name, description: group.description || '' },
        notice: '',
        error: '',
      });
    },

    /** 提交编辑：带上进表单时的版本号，避免覆盖他人改动 */
    onSaveEdit() {
      if (this.data.groupBusy || !this.api) return undefined;
      const groupId = this.data.editingId;
      if (!groupId) return undefined;
      const name = String(this.data.groupForm.name || '').trim();
      if (name.length < 2 || name.length > 30) {
        this.setData({ error: '小组名称请填 2 到 30 个字' });
        return undefined;
      }
      return this.write(() => this.api.updateAssociationGroup({
        groupId, name, description: this.data.groupForm.description || '',
        expectedRevision: this.data.editRevision,
      }), '小组已更新').then(() => {
        if (!this.data.error) this.setData({ editingId: '' });
      });
    },

    onField(event) {
      const field = event.currentTarget.dataset.field;
      if (!['name', 'description'].includes(field)) return undefined;
      this.requestId = '';
      return this.setData({ [`groupForm.${field}`]: event.detail.value });
    },

    onTogglePick(event) {
      const userId = event.currentTarget.dataset.userid;
      if (!userId) return undefined;
      // 选中清单是唯一真值：候选列表可能只是搜索结果里的一页，
      // 拿它反推「谁被选了」会把当前没显示出来的人丢掉
      const selected = this.data.selectedMemberIds.includes(userId)
        ? this.data.selectedMemberIds.filter((id) => id !== userId)
        : this.data.selectedMemberIds.concat(userId);
      return this.applySelected(selected);
    },

    /* ---------- 建组选人的搜索与分页 ---------- */

    /**
     * 记下见过的会员昵称。搜索换词后已选的人可能不在当前结果里，
     * 「已选」那一行仍要显示得出名字，不能退化成编号。
     * @param {Array<Object>} rows
     * @returns {Object} userId → nickName
     */
    rememberMemberNames(rows) {
      const names = this.memberNames || {};
      for (const row of rows || []) {
        if (row && row.userId && !names[row.userId]) names[row.userId] = row.nickName || '';
      }
      this.memberNames = names;
      return names;
    },

    /** 已选编号 → 展示行（名字用见过的那份；实在没有才退回编号） */
    selectedRowsOf(ids) {
      const names = this.memberNames || {};
      return (ids || []).map((userId) => ({ userId, nickName: names[userId] || userId }));
    },

    /** 给候选行标上勾选态：WXML 不能 indexOf，选中与否必须预先算好 */
    markPicked(rows, selected) {
      const chosen = new Set(selected || []);
      return (rows || []).map((row) => ({ ...row, picked: chosen.has(row.userId) }));
    },

    /**
     * 落一次选人结果：`selectedMemberIds` 是唯一真值，列表勾选态与「已选」小卡片都由它推出来。
     * @param {string[]} selected
     * @returns {Promise<void>}
     */
    applySelected(selected) {
      const names = this.rememberMemberNames(this.data.roster);
      const ids = Array.from(new Set(selected || []));
      return this.setData({
        selectedMemberIds: ids,
        selectedMembers: ids.map((userId) => ({ userId, nickName: names[userId] || userId })),
        roster: this.markPicked(this.data.roster, ids),
      });
    },

    /**
     * 取建组候选人的一页。
     *
     * 【为什么把关键词交给服务端，而不是在客户端把 50 条过滤一遍】
     * 候选池是按页取的，会里人一多，要的人根本不在已经取回来的那一页里，
     * 客户端过滤只会给出「搜不到」的假象。服务端（见 association-member.js）
     * 按昵称或真实姓名匹配、前缀命中优先排序、游标分页，与成员页签同一把尺子，
     * 协会再大也搜得全、翻得完。
     *
     * @param {Object} [options]
     * @param {boolean} [options.append] 为真时接在当前列表后面（「加载更多」）
     * @returns {Promise<void>}
     */
    loadGroupRoster(options = {}) {
      if (!this.api) return Promise.resolve();
      const { append = false } = options;
      const keyword = String(this.data.groupKeyword || '').trim();
      // 请求序号：换词或翻页都会顶掉在途请求，旧响应不许回写（见 loadMembers 同款说明）
      const seq = this.rosterSeq = (this.rosterSeq || 0) + 1;
      const stale = () => seq !== this.rosterSeq;
      this.setData({ groupLoading: true, groupEmptyNote: '', error: '' });
      return this.api.listAssociationMembers({
        keyword,
        limit: PICK_POOL,
        cursor: append ? this.data.groupCursor : '',
      })
        .then((result) => {
          if (stale()) return undefined;
          if (!result || result.ok === false) throw new Error((result && result.message) || '成员加载失败');
          const rows = (result.members || []).map((row) => this.describeMember(row));
          this.rememberMemberNames(rows);
          const merged = append ? this.data.roster.concat(rows) : rows;
          this.setData({
            groupLoading: false,
            roster: this.markPicked(merged, this.data.selectedMemberIds),
            selectedMembers: this.selectedRowsOf(this.data.selectedMemberIds),
            groupCursor: result.nextCursor || '',
            groupHasMore: Boolean(result.hasMore),
            groupEmptyNote: merged.length === 0
              ? (keyword ? '没有找到匹配的成员' : '本协会暂无可选会员')
              : '',
          });
          return undefined;
        })
        .catch((err) => {
          if (stale()) return;
          this.setData({
            groupLoading: false,
            error: err.message || '成员加载失败',
            groupEmptyNote: '成员加载失败，请重试',
          });
        });
    },

    /** 搜索框输入：关键词变了就得重新取第一页（游标里的排序档位依赖关键词） */
    onInputGroupKeyword(event) {
      const raw = event.detail.value == null ? '' : String(event.detail.value);
      this.setData({ groupKeyword: raw });
      return this.scheduleSearch('roster', () => this.loadGroupRoster());
    },

    onClearGroupKeyword() {
      this.cancelSearch('roster');
      this.setData({ groupKeyword: '' });
      return this.loadGroupRoster();
    },

    onLoadMoreGroupRoster() {
      if (this.data.groupLoading || !this.data.groupHasMore) return undefined;
      return this.loadGroupRoster({ append: true });
    },

    onCreateGroup() {
      if (this.data.groupBusy || !this.api) return undefined;
      const name = String(this.data.groupForm.name || '').trim();
      if (name.length < 2 || name.length > 30) {
        this.setData({ error: '小组名称请填 2 到 30 个字' });
        return undefined;
      }
      this.requestId = this.requestId || `ag_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      return this.write(() => this.api.createAssociationGroup({
        requestId: this.requestId, name, description: this.data.groupForm.description || '',
        memberIds: this.data.selectedMemberIds.slice(),
      }), '小组已创建');
    },

    /** 展开/收起某个小组的成员名册（点第二次收起，不再请求） */
    onToggleGroupDetail(event) {
      const groupId = event.currentTarget.dataset.groupid;
      if (!groupId || this.data.groupBusy) return undefined;
      if (!this.data.canManage && !this.data.groups.some(group => group.groupId === groupId && group.canReadRoster)) return undefined;
      if (this.data.openGroupId === groupId) {
        return this.setData({ openGroupId: '', detailMembers: [] });
      }
      return this.loadGroupDetail(groupId);
    },

    /** 拉取并展开某个小组的名册（移出成员后用它刷新名单） */
    loadGroupDetail(groupId) {
      if (!groupId || !this.api) return Promise.resolve();
      this.setData({ openGroupId: groupId, detailMembers: [], detailLoading: true });
      return this.api.getAssociationGroup({ groupId }).then((result) => {
        if (this.data.openGroupId !== groupId) return;
        this.setData({
          detailLoading: false,
          detailMembers: (result.members || []).map((row) => this.describeMember(row)),
        });
      }).catch((err) => {
        this.setData({ detailLoading: false, error: err.message || '名单读取失败' });
      });
    },

    onLeaveGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      if (!groupId || this.data.groupBusy) return undefined;
      return this.write(() => this.api.leaveAssociationGroup({ groupId }), '已退出小组');
    },

    onRemoveMember(event) {
      const { groupid: groupId, userid: userId } = event.currentTarget.dataset;
      if (!this.data.canManage || !groupId || !userId || this.data.groupBusy) return undefined;
      // write 成功后会 refresh 首屏；名册此刻可能已被收起，按需再展开并重拉。
      return this.write(() => this.api.removeAssociationGroupMember({ groupId, userId }), '已移出该成员')
        .then(() => (this.data.openGroupId === groupId ? this.loadGroupDetail(groupId) : undefined));
    },

    onArchiveGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      const revision = event.currentTarget.dataset.revision;
      if (!groupId || this.data.groupBusy) return undefined;
      return this.write(() => this.api.archiveAssociationGroup({ groupId, expectedRevision: revision }), '小组已归档');
    },

    /**
     * 破坏性操作的二次确认。与项目其他页面同一写法：测试环境没有 wx.showModal
     * 时直接放行——用例要验证的是「确认之后做了什么」，不是弹窗本身。
     * @param {string} content
     * @returns {Promise<boolean>}
     */
    confirmAction(content) {
      return new Promise((resolve) => {
        if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') {
          resolve(true);
          return;
        }
        wx.showModal({
          title: '删除小组',
          content,
          success: (res) => resolve(Boolean(res.confirm)),
          fail: () => resolve(false),
        });
      });
    },

    /**
     * 删除整个小组。服务端是软删除：小组与成员关系不再有效，但历史活动 / 训练 / 审计
     * 记录都还在——确认文案要说清这一点，不能让用户以为历史也被一并抹掉。
     * 归档的小组同样能删（模板不按 archived 过滤），用户正是删不掉才来报的。
     */
    onDeleteGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      const revision = event.currentTarget.dataset.revision;
      if (!groupId || this.data.groupBusy) return undefined;
      return this.confirmAction('删除后小组与成员关系不再有效，历史活动记录保留。确定删除吗？')
        .then((confirmed) => {
          if (!confirmed) return undefined;
          return this.write(() => this.api.deleteAssociationGroup({ groupId, expectedRevision: revision }),
            '小组已删除').then(() => {
            if (this.data.error) return undefined;
            // 组已经没了：展开的名单与编辑态一起收掉，否则它们还指着一个查无此物的组
            return this.setData({ openGroupId: '', detailMembers: [], editingId: '' });
          });
        });
    },

    /* ============================================================
     * 成员页签
     * ============================================================ */

    /** 首屏/切回时按当前关键词重拉第一页 */
    loadMembers() {
      if (!this.api) return Promise.resolve();
      // 【请求序号】快速改词时会有多个请求在途，云端的返回顺序不保证与发出顺序
      // 一致。旧响应若回写，会把「张」的结果盖到「张三」的界面上，并顺手把
      // memberCursor 换成旧页的游标——下一次「加载更多」就从错的位置续读，
      // 表现为重复或漏人（2026-10-26 第四轮审查 P-1）。
      const seq = this.memberSeq = (this.memberSeq || 0) + 1;
      const stale = () => seq !== this.memberSeq;
      this.setData({ memberLoading: true, memberError: '' });
      return this.api.listAssociationMembers({ keyword: this.data.keyword, limit: MEMBER_PAGE })
        .then((result) => {
          if (stale()) return undefined;
          this.setData({
            memberLoading: false,
            members: (result.members || []).map((row) => this.describeMember(row)),
            memberCursor: result.nextCursor || '',
            memberHasMore: Boolean(result.hasMore),
          });
          this.refreshMemberEmptyNote(result.keyword);
          return undefined;
        })
        .catch((err) => {
          if (stale()) return;
          this.setData({ memberLoading: false, memberError: err.message || '成员加载失败' });
        });
    },

    onLoadMore() {
      if (this.data.memberLoading || !this.data.memberHasMore || !this.api) return undefined;
      const seq = this.memberSeq = (this.memberSeq || 0) + 1;
      const stale = () => seq !== this.memberSeq;
      this.setData({ memberLoading: true });
      return this.api.listAssociationMembers({ keyword: this.data.keyword, cursor: this.data.memberCursor, limit: MEMBER_PAGE })
        .then((result) => {
          if (stale()) return undefined;
          this.setData({
            memberLoading: false,
            members: this.data.members.concat((result.members || []).map((row) => this.describeMember(row))),
            memberCursor: result.nextCursor || '',
            memberHasMore: Boolean(result.hasMore),
          });
          return undefined;
        })
        .catch((err) => {
          if (stale()) return;
          this.setData({ memberLoading: false, memberError: err.message || '成员加载失败' });
        });
    },

    onInputKeyword(event) {
      this.applyKeyword(event.detail.value);
      return this.scheduleSearch('member', () => this.loadMembers());
    },

    onClearKeyword() {
      this.cancelSearch('member');
      this.applyKeyword('');
      return this.loadMembers();
    },

    /**
     * 搜索防抖：`scheduleSearch(key, run)`。
     *
     * 【为什么要返回 Promise】调用方（页面、用例）等的是「这次输入最终取到了」，
     * 不是「防抖排上了队」。所以定时器到点后把 `run()` 的结果接过来 resolve；
     * 若这次输入被下一次输入顶掉，也要立刻 resolve 掉旧的——否则它永远挂着。
     *
     * @param {string} key 'member' | 'roster'，两处搜索各有一套定时器
     * @param {Function} run 真正发起请求的函数（返回 Promise）
     * @returns {Promise<void>}
     */
    scheduleSearch(key, run) {
      const timers = this.searchTimers || (this.searchTimers = {});
      const waiters = this.searchWaiters || (this.searchWaiters = {});
      if (timers[key]) {
        clearTimeout(timers[key]);
        timers[key] = null;
      }
      // 上一次输入被这次的按键顶掉：给它一个着落，别让调用方一直等
      if (waiters[key]) {
        waiters[key]();
        waiters[key] = null;
      }
      return new Promise((resolve) => {
        waiters[key] = resolve;
        timers[key] = setTimeout(() => {
          timers[key] = null;
          const done = waiters[key];
          waiters[key] = null;
          Promise.resolve(run()).then(
            () => { if (done) done(); },
            () => { if (done) done(); },
          );
        }, SEARCH_DEBOUNCE_MS);
      });
    },

    /** 收掉某一处的挂起搜索（清空关键词时用：马上重取，不必再等 300ms 后重复取一次）。 */
    cancelSearch(key) {
      const timers = this.searchTimers || {};
      const waiters = this.searchWaiters || {};
      if (timers[key]) {
        clearTimeout(timers[key]);
        timers[key] = null;
      }
      if (waiters[key]) {
        waiters[key]();
        waiters[key] = null;
      }
    },

    /** 组件卸载时收摊（见 detached 的说明）。 */
    cancelSearchTimers() {
      const keys = new Set([
        ...Object.keys(this.searchTimers || {}),
        ...Object.keys(this.searchWaiters || {}),
      ]);
      for (const key of keys) this.cancelSearch(key);
    },

    /** 只更新关键词与搜索态，真正的取数交给 loadMembers */
    applyKeyword(keyword) {
      const word = String(keyword == null ? '' : keyword).trim();
      return this.setData({ keyword: word, searching: Boolean(word) });
    },

    refreshMemberEmptyNote(keyword) {
      const empty = this.data.members.length === 0;
      this.setData({ memberEmptyNote: !empty ? '' : keyword ? '没有找到匹配的成员' : '本协会暂无在册会员' });
    },

    /** 点成员行进入个人主页 */
    onOpenMember(event) {
      const userId = event.currentTarget.dataset.userid;
      if (!userId) return undefined;
      return wx.navigateTo({ url: `/packageMember/member/member?userId=${userId}` });
    },

    /* ============================================================
     * 通知页签（P2）
     * ============================================================ */

    /** 首次切到通知时拉第一页；挂过之后保留状态，来回切不重拉 */
    loadNotices() {
      if (!this.api) return Promise.resolve();
      this.noticeLoaded = true;
      this.setData({ noticeLoading: true, noticeError: '' });
      return this.api.listAssociationNotices({ limit: NOTICE_PAGE })
        .then((result) => {
          this.setData({
            noticeLoading: false,
            noticeError: result.ok ? '' : (result.message || '通知加载失败'),
            notices: (result.notices || []).map((row) => this.describeNotice(row)),
            noticeCursor: result.nextCursor || '',
            noticeHasMore: Boolean(result.hasMore),
            canManage: result.canManage === undefined ? this.data.canManage : Boolean(result.canManage),
          });
        })
        .catch((err) => this.setData({ noticeLoading: false, noticeError: err.message || '通知加载失败' }));
    },

    onLoadMoreNotices() {
      if (this.data.noticeLoading || !this.data.noticeHasMore || !this.api) return undefined;
      this.setData({ noticeLoading: true });
      return this.api.listAssociationNotices({ limit: NOTICE_PAGE, cursor: this.data.noticeCursor })
        .then((result) => {
          this.setData({
            noticeLoading: false,
            notices: this.data.notices.concat((result.notices || []).map((row) => this.describeNotice(row))),
            noticeCursor: result.nextCursor || '',
            noticeHasMore: Boolean(result.hasMore),
          });
        })
        .catch((err) => this.setData({ noticeLoading: false, noticeError: err.message || '通知加载失败' }));
    },

    describeNotice(row) {
      return {
        noticeId: row.noticeId,
        title: row.title || '',
        content: row.content || '',
        category: row.category || '',
        pinned: Boolean(row.pinned),
        status: row.status,
        statusLabel: row.statusLabel || '',
        withdrawn: row.status === 'withdrawn',
        publisherName: row.publisherName || '',
        publishText: formatDateTime(row.publishedAt),
        revision: row.revision,
        canEdit: Boolean(row.canEdit),
        canWithdraw: Boolean(row.canWithdraw),
      };
    },

    onToggleNoticeCreate() {
      if (!this.data.canManage || this.data.groupBusy) return undefined;
      this.noticeRequestId = '';
      this.setData({
        showNoticeCreate: !this.data.showNoticeCreate,
        editingNoticeId: '',
        noticeForm: { title: '', content: '', category: ANNOUNCEMENT_CATEGORIES[0], pinned: false },
        noticeCategoryIndex: 0,
        error: '',
        notice: '',
      });
    },

    onNoticeField(event) {
      const field = event.currentTarget.dataset.field;
      if (!['title', 'content'].includes(field)) return undefined;
      this.noticeRequestId = '';
      return this.setData({ [`noticeForm.${field}`]: event.detail.value });
    },

    onPickNoticeCategory(event) {
      const index = Number(event.detail.value);
      const category = ANNOUNCEMENT_CATEGORIES[index] || ANNOUNCEMENT_CATEGORIES[0];
      this.noticeRequestId = '';
      return this.setData({ noticeCategoryIndex: index, 'noticeForm.category': category });
    },

    onToggleNoticePinned(event) {
      return this.setData({ 'noticeForm.pinned': Boolean(event.detail.value) });
    },

    /** 客户端先按全局公告同一套文本校验挡一遍，错误文案与服务端一致 */
    validateNoticeForm() {
      const check = validateAnnouncement(this.data.noticeForm);
      if (!check.ok) {
        this.setData({ error: check.firstError });
        return null;
      }
      return check.draft;
    },

    onCreateNotice() {
      if (this.data.groupBusy || !this.api) return undefined;
      const draft = this.validateNoticeForm();
      if (!draft) return undefined;
      this.noticeRequestId = this.noticeRequestId || `ant_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      return this.writeSub(() => this.api.publishAssociationNotice({
        requestId: this.noticeRequestId, ...draft,
      }), '通知已发布', () => this.loadNotices()).then(() => {
        if (!this.data.error) this.setData({ showNoticeCreate: false });
      });
    },

    onToggleNoticeEdit(event) {
      const noticeId = event.currentTarget.dataset.noticeid;
      const revision = event.currentTarget.dataset.revision;
      if (!noticeId || this.data.groupBusy) return undefined;
      if (this.data.editingNoticeId === noticeId) return this.setData({ editingNoticeId: '' });
      const row = this.data.notices.find((item) => item.noticeId === noticeId);
      if (!row) return undefined;
      return this.setData({
        editingNoticeId: noticeId,
        noticeEditRevision: revision,
        showNoticeCreate: false,
        noticeForm: {
          title: row.title, content: row.content,
          category: row.category || ANNOUNCEMENT_CATEGORIES[0], pinned: row.pinned,
        },
        noticeCategoryIndex: Math.max(0, ANNOUNCEMENT_CATEGORIES.indexOf(row.category)),
        error: '',
        notice: '',
      });
    },

    onSaveNoticeEdit() {
      if (this.data.groupBusy || !this.api) return undefined;
      const noticeId = this.data.editingNoticeId;
      if (!noticeId) return undefined;
      const draft = this.validateNoticeForm();
      if (!draft) return undefined;
      return this.writeSub(() => this.api.updateAssociationNotice({
        noticeId, ...draft, expectedRevision: this.data.noticeEditRevision,
      }), '通知已更新', () => this.loadNotices()).then(() => {
        if (!this.data.error) this.setData({ editingNoticeId: '' });
      });
    },

    onWithdrawNotice(event) {
      const noticeId = event.currentTarget.dataset.noticeid;
      const revision = event.currentTarget.dataset.revision;
      if (!noticeId || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.withdrawAssociationNotice({
        noticeId, expectedRevision: revision,
      }), '通知已撤回', () => this.loadNotices());
    },

    /* ============================================================
     * 训练页签（P3）
     * ============================================================ */

    /** 首屏（默认页签）与切回时按当前筛选拉第一页 */
    loadTrainings() {
      if (!this.api) return Promise.resolve();
      this.trainingLoaded = true;
      this.setData({ trainingLoading: true, trainingError: '' });
      return this.api.listTrainings({ state: this.data.trainingFilter, limit: TRAINING_PAGE })
        .then((result) => {
          this.setData({
            trainingLoading: false,
            trainingError: result.ok ? '' : (result.message || '训练加载失败'),
            trainings: (result.trainings || []).map((row) => this.describeTraining(row)),
            trainingCursor: result.nextCursor || '',
            trainingHasMore: Boolean(result.hasMore),
            canManage: result.canManage === undefined ? this.data.canManage : Boolean(result.canManage),
          });
        })
        .catch((err) => this.setData({ trainingLoading: false, trainingError: err.message || '训练加载失败' }));
    },

    onLoadMoreTrainings() {
      if (this.data.trainingLoading || !this.data.trainingHasMore || !this.api) return undefined;
      this.setData({ trainingLoading: true });
      return this.api.listTrainings({ state: this.data.trainingFilter, limit: TRAINING_PAGE, cursor: this.data.trainingCursor })
        .then((result) => {
          this.setData({
            trainingLoading: false,
            trainings: this.data.trainings.concat((result.trainings || []).map((row) => this.describeTraining(row))),
            trainingCursor: result.nextCursor || '',
            trainingHasMore: Boolean(result.hasMore),
          });
        })
        .catch((err) => this.setData({ trainingLoading: false, trainingError: err.message || '训练加载失败' }));
    },

    onTrainingFilter(event) {
      const key = event.currentTarget.dataset.key || '';
      if (key === this.data.trainingFilter) return undefined;
      this.setData({ trainingFilter: key, openTrainingId: '', trainingDetail: null, trainingRoster: [] });
      return this.loadTrainings();
    },

    describeTraining(row) {
      return {
        trainingId: row.trainingId,
        title: row.title || '',
        description: row.description || '',
        location: row.location || '',
        startAt: row.startAt || null,
        endAt: row.endAt || null,
        startText: formatDateTime(row.startAt),
        endText: formatDateTime(row.endAt),
        capacity: row.capacity,
        capacityText: row.capacity === null || row.capacity === undefined ? '不限' : `${row.capacity} 人`,
        signupCount: Number(row.signupCount || 0),
        state: row.state,
        stateLabel: row.stateLabel || '',
        status: row.status,
        canceled: row.state === 'canceled',
        finishable: row.state === 'finished' && row.status === 'published',
        audienceMode: row.audienceMode,
        audienceText: row.audienceMode === 'groups' ? `限 ${(row.audienceGroupIds || []).length} 个小组` : '不限小组',
        revision: row.revision,
      };
    },

    /** 默认训练时间：明天 10:00–12:00（本地时区），保证开始时间落在未来 */
    defaultTrainingForm() {
      const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
      start.setHours(10, 0, 0, 0);
      const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
      return {
        title: '', description: '', location: '',
        date: ymd(start), time: hm(start), endDate: ymd(end), endTime: hm(end),
        capacity: '', audienceMode: 'all',
      };
    },

    /** ISO 时刻转成本地日期 / 时间两段，回填编辑表单 */
    isoToLocal(value) {
      const date = value ? new Date(value) : null;
      if (!date || Number.isNaN(date.getTime())) return { date: '', time: '' };
      return { date: ymd(date), time: hm(date) };
    },

    /** 限组候选：只列未归档小组，选中态预先算好（WXML 不能 indexOf） */
    buildAudienceOptions(selectedIds) {
      const selected = new Set(selectedIds || []);
      return this.data.groups
        .filter((group) => !group.archived)
        .map((group) => ({ groupId: group.groupId, name: group.name, picked: selected.has(group.groupId) }));
    },

    onToggleTrainingCreate() {
      if (!this.data.canManage || this.data.groupBusy) return undefined;
      this.trainingRequestId = '';
      const open = !this.data.showTrainingCreate;
      this.setData({
        showTrainingCreate: open,
        editingTrainingId: '',
        trainingForm: open ? this.defaultTrainingForm() : this.data.trainingForm,
        trainingAudience: [],
        audienceGroups: this.buildAudienceOptions([]),
        error: '',
        notice: '',
      });
    },

    onTrainingField(event) {
      const field = event.currentTarget.dataset.field;
      if (!['title', 'description', 'location', 'capacity'].includes(field)) return undefined;
      this.trainingRequestId = '';
      return this.setData({ [`trainingForm.${field}`]: event.detail.value });
    },

    onPickTrainingDate(event) {
      const kind = event.currentTarget.dataset.kind;
      if (kind !== 'start' && kind !== 'end') return undefined;
      return this.setData({ [`trainingForm.${kind === 'start' ? 'date' : 'endDate'}`]: event.detail.value });
    },

    onPickTrainingTime(event) {
      const kind = event.currentTarget.dataset.kind;
      if (kind !== 'start' && kind !== 'end') return undefined;
      return this.setData({ [`trainingForm.${kind === 'start' ? 'time' : 'endTime'}`]: event.detail.value });
    },

    onPickAudienceMode(event) {
      const mode = event.currentTarget.dataset.mode;
      if (mode !== 'all' && mode !== 'groups') return undefined;
      return this.setData({
        'trainingForm.audienceMode': mode,
        trainingAudience: mode === 'all' ? [] : this.data.trainingAudience,
        audienceGroups: mode === 'all' ? this.buildAudienceOptions([]) : this.data.audienceGroups,
      });
    },

    onToggleAudienceGroup(event) {
      const groupId = event.currentTarget.dataset.groupid;
      if (!groupId) return undefined;
      const current = this.data.trainingAudience;
      const next = current.includes(groupId) ? current.filter((id) => id !== groupId) : current.concat(groupId);
      return this.setData({
        trainingAudience: next,
        audienceGroups: this.data.audienceGroups.map((row) =>
          (row.groupId === groupId ? { ...row, picked: !row.picked } : row)),
      });
    },

    /** 组装并轻校验训练表单（发布 / 编辑共用）；失败时给出第一条错误并返回 null */
    buildTrainingPayload() {
      const form = this.data.trainingForm;
      const startAt = localMoment(form.date, form.time);
      const endAt = localMoment(form.endDate, form.endTime);
      const title = String(form.title || '').trim();
      if (title.length < 2 || title.length > 30) { this.setData({ error: '训练标题需 2～30 个字' }); return null; }
      if (!String(form.location || '').trim()) { this.setData({ error: '请填写训练地点' }); return null; }
      if (!startAt || Number.isNaN(Date.parse(startAt))) { this.setData({ error: '请选择开始的日期与时间' }); return null; }
      if (!endAt || Number.isNaN(Date.parse(endAt))) { this.setData({ error: '请选择结束的日期与时间' }); return null; }
      if (Date.parse(endAt) <= Date.parse(startAt)) { this.setData({ error: '结束时间必须晚于开始时间' }); return null; }
      if (form.audienceMode === 'groups' && this.data.trainingAudience.length === 0) {
        this.setData({ error: '请至少选择一个小组' });
        return null;
      }
      return {
        title, description: form.description, location: form.location,
        startAt, endAt, capacity: form.capacity,
        audienceMode: form.audienceMode,
        audienceGroupIds: form.audienceMode === 'groups' ? this.data.trainingAudience.slice() : [],
      };
    },

    onCreateTraining() {
      if (this.data.groupBusy || !this.api) return undefined;
      const payload = this.buildTrainingPayload();
      if (!payload) return undefined;
      this.trainingRequestId = this.trainingRequestId || `at_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      return this.writeSub(() => this.api.publishTraining({ requestId: this.trainingRequestId, ...payload }),
        '训练已发布', () => this.loadTrainings()).then(() => {
        if (!this.data.error) this.setData({ showTrainingCreate: false });
      });
    },

    onToggleTrainingEdit(event) {
      const trainingId = event.currentTarget.dataset.trainingid;
      const revision = event.currentTarget.dataset.revision;
      if (!trainingId || this.data.groupBusy) return undefined;
      if (this.data.editingTrainingId === trainingId) return this.setData({ editingTrainingId: '' });
      const row = this.data.trainings.find((item) => item.trainingId === trainingId);
      if (!row) return undefined;
      const start = this.isoToLocal(row.startAt);
      const end = this.isoToLocal(row.endAt);
      const selected = (row.audienceMode === 'groups' ? row.audienceGroupIds : []) || [];
      return this.setData({
        editingTrainingId: trainingId,
        trainingEditRevision: revision,
        showTrainingCreate: false,
        trainingForm: {
          title: row.title, description: row.description, location: row.location,
          date: start.date, time: start.time, endDate: end.date, endTime: end.time,
          capacity: row.capacity === null || row.capacity === undefined ? '' : String(row.capacity),
          audienceMode: row.audienceMode || 'all',
        },
        trainingAudience: selected.slice(),
        audienceGroups: this.buildAudienceOptions(selected),
        error: '',
        notice: '',
      });
    },

    onSaveTrainingEdit() {
      if (this.data.groupBusy || !this.api) return undefined;
      const trainingId = this.data.editingTrainingId;
      if (!trainingId) return undefined;
      const payload = this.buildTrainingPayload();
      if (!payload) return undefined;
      return this.writeSub(() => this.api.updateTraining({
        trainingId, ...payload, expectedRevision: this.data.trainingEditRevision,
      }), '训练已更新', () => this.loadTrainings()).then(() => {
        if (!this.data.error) this.setData({ editingTrainingId: '' });
      });
    },

    onCancelTraining(event) {
      const trainingId = event.currentTarget.dataset.trainingid;
      if (!trainingId || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.cancelTraining({ trainingId }), '训练已取消',
        () => this.loadTrainings());
    },

    onFinishTraining(event) {
      const trainingId = event.currentTarget.dataset.trainingid;
      if (!trainingId || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.finishTraining({ trainingId }), '训练已结束',
        () => this.loadTrainings());
    },

    onToggleTrainingDetail(event) {
      const trainingId = event.currentTarget.dataset.trainingid;
      if (!trainingId || this.data.groupBusy) return undefined;
      if (this.data.openTrainingId === trainingId) {
        return this.setData({ openTrainingId: '', trainingDetail: null, trainingRoster: [] });
      }
      return this.loadTrainingDetail(trainingId);
    },

    /** 拉详情与名单；写操作后重进也会走这里 */
    loadTrainingDetail(trainingId) {
      if (!trainingId || !this.api) return Promise.resolve();
      this.setData({
        openTrainingId: trainingId, trainingDetail: null, trainingDetailError: '',
        trainingRoster: [], trainingDetailLoading: true,
        approvalAction: null, approvalReason: '',
      });
      return Promise.all([
        this.api.getTraining({ trainingId }),
        this.api.listTrainingRegistrations({ trainingId }),
      ]).then(([detail, roster]) => {
        if (this.data.openTrainingId !== trainingId) return;
        this.setData({
          trainingDetailLoading: false,
          trainingDetail: detail && detail.ok ? detail : null,
          trainingDetailError: detail && detail.ok ? '' : ((detail && detail.message) || '训练详情读取失败'),
          trainingRoster: this.describeRoster(roster),
        });
      }).catch((err) => {
        this.setData({ trainingDetailLoading: false, trainingDetailError: err.message || '训练详情读取失败' });
      });
    },

    describeRoster(result) {
      if (!result || !result.ok) return [];
      const rows = result.canManage ? (result.registrations || []) : (result.members || []);
      return rows.map((row) => {
        const attendance = row.attendanceStatus || 'not_submitted';
        const canceled = row.signupStatus === 'canceled';
        // 待确认是负责人唯一可操作的状态（确认 / 退回二选一）；
        // 已确认可撤销回待确认。未签到者没有可操作的会员动作（T08）。
        return {
          userId: row.userId,
          nickName: row.nickName || '会员',
          avatarUrl: row.avatarUrl || '',
          collegeName: row.collegeName || '',
          canceled,
          statusLabel: canceled ? '已取消' : '已报名',
          attendanceStatus: attendance,
          attendanceLabel: row.attendanceLabel || '',
          rejectionReason: row.rejectionReason || '',
          revision: Number(row.revision || 1),
          canApprove: !canceled && attendance === 'pending',
          canRevoke: !canceled && attendance === 'confirmed',
        };
      });
    },

    onRegisterTraining() {
      const trainingId = this.data.openTrainingId;
      if (!trainingId || !this.data.trainingDetail || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.registerTraining({ trainingId }), '报名成功',
        () => this.reloadTrainingDetail(trainingId));
    },

    onCancelRegistration() {
      const trainingId = this.data.openTrainingId;
      if (!trainingId || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.cancelTrainingRegistration({ trainingId }), '已取消报名',
        () => this.reloadTrainingDetail(trainingId));
    },

    onRemoveRegistration(event) {
      const trainingId = this.data.openTrainingId;
      const userId = event.currentTarget.dataset.userid;
      if (!trainingId || !userId || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.removeTrainingRegistration({ trainingId, userId }), '已移出该报名',
        () => this.reloadTrainingDetail(trainingId));
    },

    /* ---------- 签到（P5） ---------- */

    /**
     * 本人签到：只到「待确认」，负责人确认后才计分（§6.1）。
     * 按钮是否出现由详情页的 canCheckIn 决定——那已经涵盖了「已报名 + 资格在 +
     * 训练未取消 + 处于签到窗口 + 当前不是待确认 / 已确认」五条，页面不再重算。
     */
    onRequestCheckIn() {
      const trainingId = this.data.openTrainingId;
      if (!trainingId || !this.data.trainingDetail || this.data.groupBusy) return undefined;
      return this.writeSub(() => this.api.requestTrainingCheckIn({ trainingId }),
        '已提交签到，等待负责人确认', () => this.reloadTrainingDetail(trainingId));
    },

    /** 负责人确认：pending → confirmed，确认后才产生一条训练积分事实 */
    onConfirmCheckIn(event) {
      const trainingId = this.data.openTrainingId;
      const userId = event.currentTarget.dataset.userid;
      const revision = event.currentTarget.dataset.revision;
      if (!trainingId || !userId || this.data.groupBusy) return undefined;
      return this.writeSub(
        () => this.api.confirmTrainingCheckIn({ trainingId, userId, expectedRevision: revision }),
        '已确认签到', () => this.reloadTrainingDetail(trainingId));
    },

    /** 展开就地原因输入（退回 / 撤销都需要写原因，服务端强校验） */
    onStartApproval(event) {
      const { userid: userId, kind } = event.currentTarget.dataset;
      if (!userId || (kind !== 'reject' && kind !== 'revoke')) return undefined;
      return this.setData({ approvalAction: { userId, kind }, approvalReason: '', error: '' });
    },

    onApprovalReason(event) {
      return this.setData({ approvalReason: event.detail.value });
    },

    onCancelApproval() {
      return this.setData({ approvalAction: null, approvalReason: '' });
    },

    onSubmitApproval() {
      const action = this.data.approvalAction;
      const trainingId = this.data.openTrainingId;
      if (!action || !trainingId || this.data.groupBusy) return undefined;
      const reason = String(this.data.approvalReason || '').trim();
      if (!reason) {
        this.setData({ error: '请填写原因' });
        return undefined;
      }
      const call = action.kind === 'reject' ? this.api.rejectTrainingCheckIn : this.api.revokeTrainingCheckIn;
      return this.writeSub(
        () => call({ trainingId, userId: action.userId, reason }),
        action.kind === 'reject' ? '已退回该签到' : '已撤销确认',
        () => this.reloadTrainingDetail(trainingId))
        .then(() => { if (!this.data.error) this.setData({ approvalAction: null, approvalReason: '' }); });
    },

    /** 详情内的写操作后：列表（人数 / 状态会变）与当前详情一起重拉 */
    reloadTrainingDetail(trainingId) {
      return Promise.all([this.loadTrainings(), this.loadTrainingDetail(trainingId)]);
    },

    /**
     * 二级页签的写操作：跑 action、拉起忙碌态、成功后重载该页签并给轻提示。
     * 与分组共用 groupBusy，避免同一面板里多个写操作并发。
     * @param {Function} action 返回 Promise<{ok, message}>
     * @param {string} successText
     * @param {Function} [reload] 成功后要重拉的取数函数；缺省则只提示
     */
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
