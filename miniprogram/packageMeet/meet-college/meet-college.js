/**
 * 学院部长工作台 / 校管理员代报
 * ============================================================
 * 一屏看本院每个项目组别的「已报 / 上限 / 待审 / 意向人数」，点开某个项目从
 * 申请人池里选人提交。三条约束直接来自裁决：
 *   · 只能从已提交意向的人里选（D14），所以选人面板只列意向池；
 *   · 提交按项目组别一条（D22），一次只提交一个项目，失败时只影响这一项；
 *   · 名额、兼项、人数、重复全部由服务端判，页面只负责把失败原因显示清楚。
 *
 * 【校管理员要先选学院】
 * 代报（D13）允许校级管理员替任一学院报名，但「替哪个学院」必须明确选，不能
 * 猜。所以管理员进入本页时先出现学院选择（带搜索）；学院部长则直接落到本院，
 * 不需要也不应该看到全院列表——服务端也会拒绝他调这个接口。
 *
 * 【人数不限的项目】
 * members = 0 表示不限人数（入场式展示这类）。此时选人上限取一个宽松值，
 * 只保证「至少 1 人」，不强行要求等于某个数。
 * ============================================================
 */

const meet = require('../services/meet.js');
const { updateMeetPage } = require('../utils/meet-ui.js');
const session = require('../../services/school-session.js');

/** 人数不限时选人面板的硬上限，纯前端保护，避免一次勾几百人 */
const OPEN_MEMBER_CAP = 60;

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    collegeId: '',
    collegeName: '',
    byAdmin: false,
    rows: [],
    // 管理员：学院选择
    colleges: [],
    filteredColleges: [],
    collegeKeyword: '',
    needCollege: false,
    // 当前展开的项目与它的申请人池
    activeEventKey: '',
    activeEvent: null,
    /** 本院该项目已提交名单：面板只提示「先撤回」，不再给提交按钮 */
    activeClosed: false,
    applicants: [],
    picked: [],
    entries: [],
    memberCap: 1,
    /** 报名窗口是否还开着：关了就只展示名单，不再提示「可报名」 */
    registrationClosed: false,
    /** 学院部长（管理员可见）：本校各学院的任命情况 + 当前学院的部长 */
    leads: [],
    currentLead: null,
    /** 部长候选面板（可搜索）：actionSheet 最多 6 项，成员一多就选不到人 */
    leadOpen: false,
    leadKeyword: '',
    leadCandidates: [],
    /** 切换学院时记住原来的学院：取消切换要能回到它（没有则不给「取消」） */
    switchFromCollegeId: '',
  },

  onLoad(options = {}) {
    this.unloaded = false;
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId: String(options.meetId || ''),
    });
    return this.reload();
  },

  onUnload() {
    this.unloaded = true;
    this.leadSeq = (this.leadSeq || 0) + 1;
    clearTimeout(this.leadTimer);
    this.leadTimer = null;
  },

  update(values) {
    updateMeetPage(this, values);
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  /** 当前学院的过滤条件；管理员没选学院时不传，让服务端明确回报 */
  scopePayload() {
    return this.data.collegeId ? { collegeId: this.data.collegeId } : {};
  },

  async reload() {
    this.update({ loading: true, error: '' });
    try {
      const [board, entries, meet, leads] = await Promise.all([
        this.client().listMeetCollegeEvents(this.scopePayload()),
        this.client().listMeetEntries({}),
        // 报名窗口状态：截止之后页面不能再写「可报名」，点了才被拒
        this.client().getSportsMeet({ meetId: this.data.meetId }),
        // 部长名单只有管理员能取；非管理员这里会失败，按空处理
        this.client().listMeetCollegeLeads({}).catch(() => ({ items: [] })),
      ]);
      const boardCollegeId = board.collegeId;
      const leadRows = leads.items || [];
      this.update({
        loading: false,
        needCollege: false,
        collegeId: boardCollegeId,
        collegeName: this.nameOfCollege(boardCollegeId) || this.data.collegeName,
        byAdmin: Boolean(board.byAdmin),
        rows: board.items,
        entries: entries.items,
        registrationClosed: Boolean(meet.meet && meet.meet.registration && !meet.meet.registration.open
          && meet.meet.status !== 'draft'),
        leads: leadRows,
        currentLead: leadRows.find((row) => row.collegeId === boardCollegeId) || null,
      });
    } catch (err) {
      // 校管理员尚未指定学院时，服务端会要求先选学院；此时给出学院列表
      const message = (err && err.message) || '加载失败';
      const colleges = await this.loadColleges();
      this.update({
        loading: false,
        colleges,
        filteredColleges: this.filterColleges(colleges, this.data.collegeKeyword),
        needCollege: colleges.length > 0,
        error: colleges.length > 0 ? '' : message,
      });
    }
  },

  async loadColleges() {
    try {
      const result = await this.client().listMeetColleges({});
      return result.items || [];
    } catch (err) {
      // 不是校管理员：没有全院列表，也不需要
      return [];
    }
  },

  filterColleges(colleges, keyword) {
    const needle = String(keyword || '').trim();
    if (!needle) return colleges;
    return colleges.filter((row) => String(row.name || '').includes(needle)
      || String(row.collegeId || '').includes(needle));
  },

  nameOfCollege(collegeId) {
    const found = (this.data.colleges || []).find((row) => row.collegeId === collegeId);
    return found ? found.name : '';
  },

  onCollegeKeyword(event) {
    const collegeKeyword = event.detail.value;
    this.update({
      collegeKeyword,
      filteredColleges: this.filterColleges(this.data.colleges, collegeKeyword),
    });
  },

  async onPickCollege(event) {
    const { collegeId } = event.currentTarget.dataset;
    if (!collegeId) return undefined;
    this.update({
      collegeId,
      collegeName: this.nameOfCollege(collegeId),
      needCollege: false,
      collegeKeyword: '',
      filteredColleges: this.data.colleges,
      activeEventKey: '',
      applicants: [],
      picked: [],
    });
    return this.reload();
  },

  /**
   * 已选学院后仍可换一个。
   *
   * 必须先取学院目录：`colleges` 原先只在 reload 的**失败分支**里才填，
   * 所以从「自己的学院」点切换会得到一个空列表 + 没有返回入口的死路。
   */
  async onChangeCollege() {
    const colleges = await this.loadColleges();
    this.update({
      needCollege: true,
      switchFromCollegeId: this.data.collegeId,
      collegeId: '',
      rows: [],
      entries: [],
      colleges,
      filteredColleges: this.filterColleges(colleges, this.data.collegeKeyword),
    });
    return undefined;
  },

  /** 放弃切换，回到原来的学院视图（没有原学院就什么也不做，留在选择页） */
  onCancelCollege() {
    const back = this.data.switchFromCollegeId;
    if (!back) return undefined;
    this.update({ needCollege: false, collegeKeyword: '', collegeId: back, switchFromCollegeId: '' });
    return this.reload();
  },

  /** 展开某个项目的选人面板 */
  async onOpenEvent(event) {
    const eventKey = event.currentTarget.dataset.eventKey;
    if (!eventKey) return undefined;
    if (this.data.activeEventKey === eventKey) {
      this.update({ activeEventKey: '', activeEvent: null, applicants: [], picked: [] });
      return undefined;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      const pool = await this.client().getMeetApplicantPool({ eventKey, ...this.scopePayload() });
      const cap = this.capOf(pool.event);
      const picked = [];
      this.update({
        busy: false,
        activeEventKey: eventKey,
        activeEvent: pool.event,
        activeClosed: Boolean((this.data.rows.find((row) => row.eventKey === eventKey) || {}).closed),
        memberCap: cap,
        applicants: pool.items.map((row) => ({ ...row, checked: picked.includes(row.userId) })),
        picked,
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '申请人加载失败' });
    }
  },

  /** 可选人数上限：人数不限时给一个宽松上限 */
  capOf(activeEvent) {
    const members = Number((activeEvent && activeEvent.members) || 0);
    if (members > 0) return members;
    return OPEN_MEMBER_CAP;
  },

  onToggleApplicant(event) {
    const userId = event.currentTarget.dataset.userId;
    const need = this.data.memberCap || 1;
    const picked = [...this.data.picked];
    const index = picked.indexOf(userId);
    if (index >= 0) picked.splice(index, 1);
    else if (picked.length < need) picked.push(userId);
    else return;

    this.update({
      picked,
      applicants: this.data.applicants.map((row) => ({ ...row, checked: picked.includes(row.userId) })),
    });
  },

  async onSubmitEntry() {
    if (this.data.busy) return undefined;
    const { activeEventKey, picked, activeEvent } = this.data;
    const members = Number((activeEvent && activeEvent.members) || 0);
    if (picked.length === 0) {
      this.update({ error: '请至少选择 1 人' });
      return undefined;
    }
    if (members > 0 && picked.length !== members) {
      this.update({ error: `该项目每组需 ${members} 人，当前选了 ${picked.length} 人` });
      return undefined;
    }
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().submitMeetCollegeEntry({ eventKey: activeEventKey, userIds: picked });
      this.update({ busy: false, notice: '已提交，等待校级审核', activeEventKey: '', applicants: [], picked: [] });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '提交失败' });
      return undefined;
    }
  },

  async onWithdrawEntry(event) {
    if (this.data.busy) return undefined;
    const entryKey = event.currentTarget.dataset.entryKey;
    if (!entryKey) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().withdrawMeetCollegeEntry({ entryKey });
      this.update({ busy: false, notice: '已撤回' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤回失败' });
      return undefined;
    }
  },

  /**
   * 打开「任命学院部长」候选面板。
   *
   * 之前这条链路只有服务与演示种子，没有任何页面入口——真实环境里没人能成为
   * 学院部长，学院自主报名整条路不可达，只能靠管理员逐院代报。
   * 候选列表用院校成员接口（可搜索），与「指派裁判」同一套交互；
   * 不用 wx.showActionSheet：它最多 6 项，本校成员一多就选不到人。
   */
  async onAppointLead() {
    if (this.data.busy || !this.data.byAdmin) return undefined;
    if (!this.data.collegeId) {
      this.update({ error: '请先选择学院' });
      return undefined;
    }
    // 一院一名：已有部长时必须先撤销，否则服务端会拒绝（这里先把话说在前面）
    if (this.data.currentLead) {
      this.update({ error: '该学院已有学院部长，请先撤销再改派' });
      return undefined;
    }
    if (this.data.leadOpen) {
      this.update({ leadOpen: false });
      return undefined;
    }
    this.update({ leadOpen: true, leadKeyword: '' });
    return this.loadLeadCandidates('');
  },

  async loadLeadCandidates(keyword) {
    const seq = this.leadSeq = (this.leadSeq || 0) + 1;
    try {
      const result = await this.client().listMeetJudgeCandidates({ keyword });
      if (this.unloaded || seq !== this.leadSeq) return undefined;
      // 只列**本学院**的在册成员：服务端要求部长是该学院成员，
      // 摆出别院的人只会让管理员点了才收到「不是本学院在册会员」。
      const collegeId = this.data.collegeId;
      const rows = (result.items || []).filter((row) => !collegeId || row.collegeId === collegeId);
      this.update({ leadCandidates: rows.slice(0, 20) });
    } catch (err) {
      if (this.unloaded || seq !== this.leadSeq) return undefined;
      this.update({ leadCandidates: [], error: (err && err.message) || '成员加载失败' });
    }
    return undefined;
  },

  onLeadKeyword(event) {
    const leadKeyword = event.detail.value;
    this.update({ leadKeyword });
    if (this.leadTimer) clearTimeout(this.leadTimer);
    this.leadTimer = setTimeout(() => {
      this.leadTimer = null;
      this.loadLeadCandidates(leadKeyword);
    }, 250);
  },

  onPickLead(event) {
    const userId = event.currentTarget.dataset.userId;
    if (userId) this.submitLead(userId);
  },

  async submitLead(userId) {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().grantMeetCollegeLead({ collegeId: this.data.collegeId, userId });
      this.update({ busy: false, notice: '已任命学院部长' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '任命失败' });
      return undefined;
    }
  },

  async onRevokeLead() {
    if (this.data.busy || !this.data.currentLead) return undefined;
    this.update({ busy: true, error: '', notice: '' });
    try {
      await this.client().revokeMeetCollegeLead({ collegeId: this.data.currentLead.collegeId });
      this.update({ busy: false, notice: '已撤销学院部长' });
      return this.reload();
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || '撤销失败' });
      return undefined;
    }
  },

  onOpenDetail() {
    return wx.navigateTo({ url: `/packageMeet/meet-detail/meet-detail?meetId=${this.data.meetId}` });
  },
});
