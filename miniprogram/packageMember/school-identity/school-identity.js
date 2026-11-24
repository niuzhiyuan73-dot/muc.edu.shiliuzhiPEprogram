const service = require('../../services/school-identity.js');
const { activeAssociations } = require('../../shared/utils/associations.js');
const associationScope = require('../../services/association-scope.js');
const schoolSession = require('../../services/school-session.js');
const STATUS_LABEL = { pending: '待审核', active: '已通过', rejected: '已驳回', left: '已离校', disabled: '已停用' };
// 管理员评级调整的项目池与提示（Elo 交接 §5.3；服务端只认这两个池）
const RATING_POOL_OPTIONS = [{ pool: 'singles', label: '单打' }, { pool: 'doubles', label: '双打' }];

Page({
  data: {
    schoolId: 'muc', schoolName: '中央民族大学', schools: [], schoolIndex: 0,
    association: 'pkb', associationName: '', associations: [], associationIndex: 0,
    colleges: [], collegeIndex: -1, collegeName: '', studentId: '',
    loading: true, submitting: false, error: '', notice: '',
    user: null, account: null, statusText: '', canApply: false, canReview: false, applications: [],
    members: [], grants: [], readOnly: false, applicationsHasMore: false, grantEditor: null, managedCollegeName: '',
    /** 管理员评级调整弹层，保留上次提交用于重试。 */
    ratingEditor: null, ratingPools: RATING_POOL_OPTIONS,
    // 名册分页（2026-10-26 第四轮审查 P-2）：一页 50 人，总数单独下发。
    memberTotal: 0, memberHasMore: false, memberCursor: '', memberLoadingMore: false,
    /** 能不能在这所学校发起转校申请（浏览外校 + 本人在别校有有效身份） */
    canTransfer: false,
    /** 我在本校是否已有待审的转校申请 */
    transferPending: false,
  },
  onLoad() {
    this.unloaded = false;
    const associations = activeAssociations();
    const association = associationScope.getAssociation();
    const associationIndex = Math.max(0, associations.findIndex(row => row.id === association));
    this.update({ schoolId: schoolSession.getSchoolId() || 'muc', associations, association, associationIndex, associationName: associations[associationIndex]?.name || association });
    return this.reload();
  },
  onUnload() { this.unloaded = true; this.loadVersion = (this.loadVersion || 0) + 1; },
  onPullDownRefresh() {
    if (this.data.submitting) { wx.stopPullDownRefresh(); return; }
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
  update(data) { if (!this.unloaded) this.setData(data); },
  async reload() {
    const version = this.loadVersion = (this.loadVersion || 0) + 1;
    const schoolId = this.data.schoolId;
    const api = service.forSchoolIdentity({ schoolId, association: this.data.association });
    this.update({ loading: true, memberLoadingMore: false, memberCursor: '', memberHasMore: false, error: '', applications: [], canReview: false, canApply: false,
      members: [], grants: [], readOnly: false, canTransfer: false, transferPending: false,
      user: null, account: null, statusText: '', applicationsHasMore: false, grantEditor: null, ratingEditor: null });
    try {
      const [directory, session] = await Promise.all([api.getSchoolDirectory(), api.getSchoolIdentitySession()]);
      if (!directory.ok || !session.ok) throw new Error(directory.message || session.message || '读取学校信息失败');
      let applications = [];
      let applicationsHasMore = false;
      if (session.canReview) {
        const result = await api.getSchoolApplications();
        if (!result.ok) throw new Error(result.message || '读取申请失败');
        applications = result.applications;
        applicationsHasMore = Boolean(result.hasMore);
      }
      // 成员名单与「可授予的权限」独立读取：失败只是收起指定权限入口，
      // 不该拖垮本页的身份与申请内容（跨校只读同样走这条只读接口）。
      let members = [];
      let grants = session.grants || [];
      let readOnly = Boolean(session.readOnly);
      let memberTotal = 0;
      let memberHasMore = false;
      let memberCursor = '';
      try {
        const roster = await api.getSchoolMembers();
        if (roster && roster.ok) {
          members = roster.members;
          grants = roster.grants;
          readOnly = roster.readOnly;
          memberTotal = Number(roster.total || members.length);
          memberHasMore = Boolean(roster.hasMore);
          memberCursor = roster.nextCursor || '';
        }
      } catch (err) { console.error('[school-identity] 成员名单读取失败', err); }
      if (this.unloaded || version !== this.loadVersion) return;
      this.api = api;
      const account = session.account;
      const collegeIndex = account ? directory.colleges.findIndex(c => c.collegeId === account.collegeId) : -1;
      const schoolIndex = directory.schools.findIndex(s => s.schoolId === schoolId);
      const homeMismatch = session.user && session.user.primarySchoolId && session.user.primarySchoolId !== schoolId;
      // 转校：正在浏览外校、本人在别校有有效身份，且本校这一侧没有已生效身份。
      // 「谁能批」不在这里判——审批权由目标学校的管理员在服务端复核（见 reviewSchoolTransfer）。
      const transferPending = Boolean(homeMismatch && account && account.status === 'pending' && account.transferFrom);
      const canTransfer = Boolean(session.user && homeMismatch && !transferPending &&
        (!account || account.status !== 'active'));
      this.update({ schools: directory.schools, schoolIndex, colleges: directory.colleges,
        schoolName: schoolIndex >= 0 ? directory.schools[schoolIndex].name : schoolId,
        collegeIndex, collegeName: collegeIndex >= 0 ? directory.colleges[collegeIndex].name : '',
        studentId: account && account.studentId || '', user: session.user, account,
        statusText: account ? STATUS_LABEL[account.status] || '身份状态待确认' : '尚未申请',
        canReview: session.canReview,
        applicationsHasMore,
        managedCollegeName: (directory.colleges.find(c => c.collegeId === session.managedCollegeId) || {}).name || '',
        members, grants, readOnly, memberTotal, memberHasMore, memberCursor,
        canApply: Boolean(session.user && !homeMismatch && (!account || ['pending', 'rejected'].includes(account.status))),
        canTransfer,
        transferPending,
        notice: homeMismatch
          ? (transferPending
            ? '转校申请已提交，等待本校管理员审核；原学校无需处理。'
            : '当前浏览外校。要转到这所学校，请提交转校申请（只需该校管理员同意）。')
          : session.message || '',
        applications: applications.map(row => ({ ...row, reason: '',
          collegeName: (directory.colleges.find(c => c.collegeId === row.collegeId) || {}).name || '学院待核实' })),
      });
    } catch (err) {
      if (version === this.loadVersion) this.update({ error: err.message || '加载失败，请重试' });
    } finally {
      if (version === this.loadVersion) this.update({ loading: false });
    }
  },
  /**
   * 名册「加载更多」。
   *
   * 与 reload 共用 `loadVersion`：翻页在途时若整页重载（下拉刷新 / 换学校 /
   * 审批后刷新），旧响应不得把新列表追加成两段——那是五态里的「竞态」。
   * 失败不清已有成员，只给一句可重试的提示（与列表加载失败同一口径）。
   */
  async onLoadMoreMembers() {
    if (this.data.memberLoadingMore || !this.data.memberHasMore || !this.api) return;
    const version = this.loadVersion;
    this.update({ memberLoadingMore: true });
    try {
      const roster = await this.api.getSchoolMembers({ cursor: this.data.memberCursor });
      if (this.unloaded || version !== this.loadVersion) return;
      if (!roster || !roster.ok) throw new Error((roster && roster.message) || '成员加载失败');
      this.update({
        members: this.data.members.concat(roster.members || []),
        memberHasMore: Boolean(roster.hasMore),
        memberCursor: roster.nextCursor || '',
        memberTotal: Number(roster.total || this.data.memberTotal),
      });
    } catch (err) {
      if (version === this.loadVersion) this.update({ error: err.message || '成员加载失败' });
    } finally {
      if (version === this.loadVersion) this.update({ memberLoadingMore: false });
    }
  },
  onSchoolChange(event) {
    if (this.data.submitting) return;
    const school = this.data.schools[Number(event.detail.value)];
    if (!school || school.schoolId === this.data.schoolId) return;
    this.update({ schoolId: school.schoolId, schoolName: school.name, notice: '', studentId: '', collegeIndex: -1 });
    return this.reload();
  },
  onAssociationChange(event) {
    if (this.data.submitting || this.data.loading) return;
    const associationIndex = Number(event.detail.value);
    const row = this.data.associations[associationIndex];
    if (!row || row.id === this.data.association) return;
    this.update({ association: row.id, associationName: row.name, associationIndex });
    return this.reload();
  },
  onCollegeChange(event) {
    if (this.data.submitting || this.data.loading) return;
    const index = Number(event.detail.value);
    if (this.data.colleges[index]) this.update({ collegeIndex: index, collegeName: this.data.colleges[index].name });
  },
  onStudentIdInput(event) { if (!this.data.submitting) this.update({ studentId: event.detail.value }); },
  onReasonInput(event) {
    if (this.data.submitting) return;
    const userId = event.currentTarget.dataset.userId;
    this.update({ applications: this.data.applications.map(row => row.userId === userId ? { ...row, reason: event.detail.value } : row) });
  },
  async write(action) {
    if (this.data.loading || this.data.submitting || !this.api) return;
    this.update({ submitting: true, error: '', notice: '' });
    try {
      const result = await action(this.api);
      if (!result.ok) throw new Error(result.message || '提交失败');
      await this.reload();
      this.update({ notice: '操作成功' });
    } catch (err) {
      this.update({ error: err.message || '提交失败，请重试' });
    } finally { this.update({ submitting: false }); }
  },
  onApply() {
    if (!this.data.canApply) return;
    const college = this.data.colleges[this.data.collegeIndex];
    if (!college) { this.update({ error: '请选择学院' }); return; }
    const studentId = this.data.studentId;
    return this.write(api => api.applySchoolMembership({ collegeId: college.collegeId, studentId }));
  },

  /** 提交转校申请：转入这所学校，只需该校校级管理员同意（原学校不参与审批）。 */
  onTransfer() {
    if (!this.data.canTransfer) return;
    const college = this.data.colleges[this.data.collegeIndex];
    if (!college) { this.update({ error: '请选择学院' }); return; }
    const studentId = this.data.studentId;
    return this.write(api => api.applySchoolTransfer({ collegeId: college.collegeId, studentId }));
  },

  /** 撤回自己的待审转校申请（撤回后仍留在原学校）。 */
  onCancelTransfer() {
    if (!this.data.transferPending) return;
    return this.write(api => api.cancelSchoolTransfer({}));
  },

  async onReview(event) {
    if (!this.data.canReview) return;
    const { userId, decision } = event.currentTarget.dataset;
    const row = this.data.applications.find(item => item.userId === userId);
    if (!row || !['approve', 'reject'].includes(decision)) return;
    if (decision === 'reject' && !row.reason.trim()) { this.update({ error: '请先填写驳回理由' }); return; }
    if (typeof wx !== 'undefined' && wx.showModal) {
      if (this.reviewConfirming) return;
      this.reviewConfirming = true;
      const version = this.loadVersion;
      const confirmed = await new Promise(resolve => wx.showModal({ title: (row.transfer ? '转校申请' : '入会申请') + (decision === 'approve' ? ' · 通过' : ' · 驳回'),
        content: (row.nickName || userId) + ' → ' + this.data.schoolName + ' · ' + row.collegeName + (row.transfer ? '。通过后变更学校身份，历史成绩保留原归属。' : '。请核对申请信息。'),
        success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
      this.reviewConfirming = false;
      if (!confirmed || this.unloaded || version !== this.loadVersion) return;
    }
    // 转校申请走自己的审批动作：通过时要搬运两侧身份，与普通入会不是同一条口径
    return this.write(api => (row.transfer
      ? api.reviewSchoolTransfer({ userId, decision, revision: row.revision, reason: row.reason })
      : api.reviewSchoolMembership({ userId, decision, revision: row.revision, reason: row.reason })));
  },
  /**
   * 统一的「指定权限」入口。点某位会员后，按当前身份**可授予**的档位给出选项，
   * 已持有该档则给出「取消」。能授予哪几档完全由服务端返回的 grants 决定，
   * 页面不自行判断（平台管理员三档、校管理员协会/学院两档、协会负责人学院一档），
   * 避免前端越权，也让各身份共用同一个入口（§11）。
   */
  onGrant(event) {
    if (this.data.loading || this.data.submitting || !this.data.grants.length) return;
    const userId = event.currentTarget.dataset.userId;
    const member = this.data.members.find(row => row.userId === userId);
    if (!member) return;
    const options = [];
    for (const grant of this.data.grants) {
      // 学院负责人必须落到本校有效学院；会员未登记学院时这一档无从指定
      if (grant.permission === 'collegeLeader' && !this.data.colleges.length) continue;
      const holding = member.permission === grant.permission;
      options.push({ permission: grant.permission, make: !holding,
        label: holding ? `取消${grant.label}` : `设为${grant.label}` });
    }
    if (!options.length) return;
    // 真机弹选择框；测试环境没有 wx.showActionSheet，直接采用首项。
    if (typeof wx === 'undefined' || typeof wx.showActionSheet !== 'function') {
      return this.chooseGrant(userId, options[0].permission, options[0].make);
    }
    return wx.showActionSheet({
      itemList: options.map(option => option.label),
      success: res => {
        const picked = options[res.tapIndex];
        if (picked) this.chooseGrant(userId, picked.permission, picked.make);
      },
    });
  },

  /** 提交一次授权/取消：改哪一档由 permission 决定，学院负责人需带学院。 */
  chooseGrant(userId, permission, make) {
    if (permission !== 'collegeLeader' || !make) return this.submitGrant(userId, permission, make);
    const member = this.data.members.find(row => row.userId === userId);
    if (!member || !this.data.colleges.length) return;
    const index = this.data.colleges.findIndex(row => row.collegeId === (member.managedCollegeId || member.collegeId));
    this.update({ grantEditor: { userId, name: member.nickName, collegeIndex: Math.max(0, index) } });
  },
  onGrantCollegeChange(event) {
    const index = Number(event.detail.value);
    if (!this.data.submitting && this.data.grantEditor && this.data.colleges[index]) this.update({ 'grantEditor.collegeIndex': index });
  },
  onCancelGrant() { if (!this.data.submitting) this.update({ grantEditor: null }); },
  onConfirmGrant() {
    const editor = this.data.grantEditor;
    const college = editor && this.data.colleges[editor.collegeIndex];
    if (college) return this.submitGrant(editor.userId, 'collegeLeader', true, college.collegeId);
  },
  async submitGrant(userId, permission, make, targetCollegeId) {
    const member = this.data.members.find(row => row.userId === userId);
    if (!member || this.data.submitting || this._granting) return undefined;
    this._granting = true;
    try {
      const collegeId = permission === 'collegeLeader' ? targetCollegeId || member.managedCollegeId || member.collegeId : '';
      const label = (this.data.grants.find(row => row.permission === permission) || {}).label || permission;
      const college = this.data.colleges.find(row => row.collegeId === collegeId);
      const scope = `${this.data.schoolName} · ${this.data.associationName || this.data.association}${college ? ' · ' + college.name : ''}`;
      if (typeof wx !== 'undefined' && wx.showModal) {
        const version = this.loadVersion;
        const confirmed = await new Promise(resolve => wx.showModal({ title: `${make ? '授予' : '取消'}${label}`,
          content: `${member.nickName || userId}：${scope}。请核对授权范围。`,
          success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
        if (!confirmed || this.unloaded || version !== this.loadVersion) return;
      }
      return await this.write(api => api.grantSchoolPermission({ userId, permission, make, collegeId }));
    } finally {
      this._granting = false;
    }
  },

  /* ---- 管理员评级调整（Elo 交接 §5.3） ---- */

  /** 从成员行打开调分弹层；只有协会负责人及以上（服务端再判一次）看得到按钮。 */
  onAdjustRating(event) {
    if (this.data.submitting || this.data.readOnly) return;
    const userId = event.currentTarget.dataset.userId;
    const member = this.data.members.find(row => row.userId === userId);
    if (!member) return;
    this.update({ ratingEditor: { userId, name: member.nickName || userId,
      poolIndex: 0, targetElo: '', reason: '', lastRequest: null }, error: '', notice: '' });
  },
  onRatingPoolChange(event) {
    if (this.data.submitting || !this.data.ratingEditor) return;
    this.update({ ratingEditor: { ...this.data.ratingEditor, poolIndex: Number(event.detail.value) } });
  },
  onRatingTargetInput(event) {
    if (this.data.submitting) return;
    this.update({ ratingEditor: { ...this.data.ratingEditor, targetElo: event.detail.value } });
  },
  onRatingReasonInput(event) {
    if (this.data.submitting) return;
    this.update({ ratingEditor: { ...this.data.ratingEditor, reason: event.detail.value } });
  },
  onCancelRating() { if (!this.data.submitting) this.update({ ratingEditor: null }); },
  async onSubmitRating() {
    const editor = this.data.ratingEditor;
    if (!editor || this.data.submitting) return;
    const pool = (RATING_POOL_OPTIONS[editor.poolIndex] || {}).pool;
    const targetText = String(editor.targetElo ?? '').trim();
    const targetElo = Number(targetText);
    const reason = String(editor.reason || '').trim();
    if (!pool || !targetText || !Number.isInteger(targetElo) || targetElo < 0 || targetElo > 3000) {
      this.update({ error: '目标分需为 0–3000 的整数' }); return;
    }
    if (!reason) { this.update({ error: '请填写调整原因（审计必填）' }); return; }
    const last = editor.lastRequest;
    const sameRequest = last && last.pool === pool && last.targetElo === targetElo && last.reason === reason;
    const requestId = sameRequest ? last.requestId : `ra_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const request = { userId: editor.userId, pool, targetElo, reason, requestId };
    this.update({ submitting: true, error: '', notice: '', ratingEditor: { ...editor, lastRequest: request } });
    try {
      const space = service.forSpace({ schoolId: this.data.schoolId, association: this.data.association });
      const result = await space.adjustMemberRating(request);
      if (!result?.ok || !result.adjustment) throw new Error(result?.message || '未能确认调整结果，请重试');
      const label = RATING_POOL_OPTIONS.find(option => option.pool === result.adjustment.pool)?.label || '';
      await this.reload();
      this.update({ notice: `已将 ${editor.name} 的${label}评级调整为 ${result.adjustment.after}，排名可能变化。` });
    } catch (err) {
      this.update({ error: err.message || '调整失败，请重试' });
    } finally {
      if (!this.unloaded) this.update({ submitting: false });
    }
  },

  onRetry() { if (!this.data.submitting) return this.reload(); },
});
