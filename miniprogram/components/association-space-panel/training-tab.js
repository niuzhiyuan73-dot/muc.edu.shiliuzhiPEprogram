const { formatDateTime } = require('../../shared/utils/format.js');
const TRAINING_PAGE = 20;
const pad2 = (value) => String(value).padStart(2, '0');
const ymd = (date) => `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
const hm = (date) => `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
const localMoment = (date, time) => {
  if (!date || !time) return '';
  const at = new Date(`${date}T${time}`);
  return Number.isFinite(at.getTime()) ? at.toISOString() : '';
};

module.exports = {
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
        audienceGroupIds: Array.isArray(row.audienceGroupIds) ? [...row.audienceGroupIds] : [],
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
};
