const space = require('../../services/association-space');
const { buildPickerRows, pickerEmptyText } = require('../../services/match-entry-view.js');

const ACTION_TEXT = {
  reject: {
    title: '驳回这场比分',
    hint: '驳回后这场成绩作废，不会计入等级分。请说明哪里不对。',
    placeholder: '例如：第二局比分录反了',
  },
};

module.exports = {
    async onConfirm(event) {
      if (this.data.acting) return undefined;
      const matchId = event.currentTarget.dataset.matchId;
      const user = this.currentUser();
      if (!matchId) return undefined;
      if (!user) {
        this.showToast('请先登录后再确认比分');
        return undefined;
      }
      // 确认即最终结算：先核对结果、把「不可撤销」说在前面，再落库
      // （交接文档 §4.3：确认前必须有可见的结果核对与不可撤销提示）。
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;
      this.setData({ acting: true });
      try {
        const confirmed = await new Promise((resolve) => {
          wx.showModal({
            title: '确认比分',
            content: '确认后成绩立即生效并计入等级分，之后不可撤销、不可修改。确定确认吗？',
            success: (res) => resolve(Boolean(res && res.confirm)),
            fail: () => resolve(false),
          });
        });
        if (!confirmed) return undefined;

        const result = await this.write('confirmSchoolMatch', { matchId });
        if (!result.ok) {
          this.showToast(result.message || '确认失败');
          return undefined;
        }

        this.showToast('已确认，成绩已计入等级分', 'success');
        return this.refresh();
      } finally {
        this.setData({ acting: false });
      }
    },

    /* ---------- 弃权 ---------- */

    /**
     * 本人自选弃权（D41）。
     *
     * 弃权是不可逆的：对手直接晋级，且这一场不计个人等级分。所以先弹一个
     * 确认框把后果说清楚，再落库。管理员在场上时由同一入口执行。
     */
    async onForfeit(event) {
      const matchId = event.currentTarget.dataset.matchId;
      const user = this.currentUser();
      if (!matchId || this.data.acting) return undefined;
      if (!user) {
        this.showToast('请先登录后再弃权');
        return undefined;
      }
      if (typeof wx === 'undefined' || typeof wx.showModal !== 'function') return undefined;

      const confirmed = await new Promise((resolve) => {
        wx.showModal({
          title: '确认弃权',
          content: '弃权后对手直接晋级，且这一场不计个人等级分。确定弃权吗？',
          success: (res) => resolve(Boolean(res && res.confirm)),
          fail: () => resolve(false),
        });
      });
      if (!confirmed) return undefined;

      this.setData({ acting: true });
      const result = await this.write('forfeitSchoolMatch', { matchId, forfeitBy: user._id });
      this.setData({ acting: false });

      if (!result.ok) {
        this.showToast(result.message || '弃权失败');
        return undefined;
      }

      this.showToast('已弃权，对手晋级', 'success');
      return this.refresh();
    },

    /* ---------- 驳回面板 ---------- */

    /** 打开驳回面板 */
    onOpenAction(event) {
      const { matchId, kind } = event.currentTarget.dataset;
      const text = ACTION_TEXT[kind];
      if (!matchId || !text) return;

      this.setData({
        action: { open: true, matchId, kind, ...text },
        reason: '',
        actionError: '',
      });
    },

    onInputReason(event) {
      this.setData({ reason: event.detail.value, actionError: '' });
    },

    onCancelAction() {
      if (this.data.acting) return;
      this.setData({ action: { ...this.data.action, open: false }, reason: '', actionError: '' });
    },

    /**
     * 提交驳回。
     * 理由必填——没有理由的驳回，事后谁也说不清当初为什么拒。
     * 校验放在这里而不是只靠后端：让用户在点下按钮的当下就看到问题。
     * （撤销已随 Elo 逐场结算改造取消：确认即最终结算，这里只剩驳回。）
     */
    async onSubmitAction() {
      if (this.data.acting) return undefined;

      const { matchId } = this.data.action;
      const reason = String(this.data.reason || '').trim();
      const user = this.currentUser();

      if (!reason) {
        this.setData({ actionError: '请填写理由' });
        return undefined;
      }
      if (!user) {
        this.showToast('请先登录后再操作');
        return undefined;
      }

      this.setData({ acting: true, actionError: '' });
      const result = await this.write('rejectSchoolMatch', { matchId, reason });
      this.setData({ acting: false });

      if (!result.ok) {
        this.setData({ actionError: result.message || '操作失败' });
        return undefined;
      }

      this.setData({ action: { ...this.data.action, open: false }, reason: '' });
      this.showToast('已驳回', 'success');
      return this.refresh();
    },

    /* ---------- 指派裁判 ---------- */

    /**
     * 取会员名单，供面板筛选。
     * 只取一次并缓存在实例上：面板可能被反复打开，名单在一次会话里不会变。
     * 名字优先用昵称（面板上显示的），真实姓名只参与搜索匹配。
     */
    async pickerMembers() { return this.members || []; },

    /** 按关键字刷新面板列表 */
    async applyRefereeKeyword(keyword) {
      if (this.data.focusMatchId) return this.loadFocusedReferees(keyword);
      const members = await this.pickerMembers();
      this.setData({
        'referee.keyword': keyword,
        'referee.rows': buildPickerRows(members, keyword, this.data.referee.selectedId),
        'referee.emptyText': pickerEmptyText(keyword),
      });
    },

    /** 打开指派面板。当前是谁当头一版勾出来 */
    async onOpenReferee(event) {
      const matchId = event.currentTarget.dataset.matchId;
      if (!matchId) return undefined;

      const record = (this.data.view.records || []).find((item) => item.matchId === matchId);
      const selectedId = (record && record.referee) || '';
      if (this.data.focusMatchId) {
        this.setData({ referee: { open: true, matchId, hasReferee: Boolean(record && record.hasReferee),
          selectedId, keyword: '', rows: [], loading: true, hasMore: false, nextCursor: '', error: '' } });
        return this.loadFocusedReferees('');
      }
      const members = await this.pickerMembers();
      const rows = buildPickerRows(members, '', selectedId);

      this.setData({
        referee: {
          open: true,
          matchId,
          hasReferee: Boolean(record && record.hasReferee),
          selectedId,
          keyword: '',
          rows,
          emptyText: pickerEmptyText(''),
        },
      });
    },

    onInputRefereeKeyword(event) {
      if (this.data.focusMatchId) {
        clearTimeout(this.refereeSearchTimer);
        this.refereePageVersion = (this.refereePageVersion || 0) + 1;
        const keyword = String(event.detail.value || '').slice(0, 32);
        this.setData({ 'referee.keyword': keyword, 'referee.rows': [], 'referee.hasMore': false });
        const request = this.request;
        this.refereeSearchTimer = setTimeout(() => {
          if (request === this.request && this.data.referee.open) this.loadFocusedReferees(keyword);
        }, 250);
        return;
      }
      return this.applyRefereeKeyword(event.detail.value);
    },

    async loadFocusedReferees(keyword, append = false) {
      const version = this.refereePageVersion = (this.refereePageVersion || 0) + 1;
      const request = this.request;
      this.setData({ 'referee.loading': true, 'referee.error': '' });
      try {
        const page = await this.api.listSchoolMembers({ page: true, keyword, limit: 20,
          cursor: append ? this.data.referee.nextCursor : '' });
        if (version !== this.refereePageVersion || request !== this.request || !this.data.referee.open) return;
        if (!page.ok) throw new Error(page.message || '候选读取失败');
        const rows = buildPickerRows((page.members || []).map(row => ({ id: row.userId, name: row.nickName || '会员' })), '', this.data.referee.selectedId);
        this.setData({ 'referee.rows': append ? [...this.data.referee.rows, ...rows] : rows, 'referee.loading': false,
          'referee.hasMore': Boolean(page.hasMore), 'referee.nextCursor': page.nextCursor || '', 'referee.emptyText': pickerEmptyText(keyword) });
      } catch (error) {
        if (version === this.refereePageVersion && request === this.request && this.data.referee.open) this.setData({ 'referee.loading': false, 'referee.error': error.message || '候选读取失败，请重试' });
      }
    },
    onMoreFocusedReferees() {
      if (this.data.referee.loading) return;
      return this.loadFocusedReferees(this.data.referee.keyword, Boolean(this.data.referee.rows.length));
    },

    onCancelReferee() {
      if (this.data.refereeActing) return;
      clearTimeout(this.refereeSearchTimer);
      this.refereePageVersion = (this.refereePageVersion || 0) + 1;
      this.setData({ referee: { ...this.data.referee, open: false } });
    },

    /** 撤下裁判：传空串，比赛随即回到「人人照旧」的口径 */
    onClearReferee() {
      return this.assignReferee('');
    },

    /** 选中某位会员当裁判。点「当前」那位等于不改派，直接关掉面板 */
    onPickReferee(event) {
      const userId = event.currentTarget.dataset.userId;
      if (!userId || userId === this.data.referee.selectedId) {
        this.setData({ referee: { ...this.data.referee, open: false } });
        return undefined;
      }
      return this.assignReferee(userId);
    },

    /**
     * 落库一次指派。
     * 写入端会再校验一遍（仅管理员、比赛未生效、此人正常在册），这里的
     * 校验只为了少跑一趟：点错了当场就能看到原因。
     */
    async assignReferee(refereeId) {
      if (this.data.refereeActing) return undefined;

      const { matchId } = this.data.referee;
      const user = this.currentUser();
      if (!matchId) return undefined;
      if (!user) {
        this.showToast('请先登录后再指派裁判');
        return undefined;
      }

      this.setData({ refereeActing: true });
      const result = await this.write('assignSchoolMatchReferee', { matchId, refereeId });
      this.setData({ refereeActing: false });

      if (!result.ok) {
        this.showToast(result.message || '指派失败');
        return undefined;
      }

      this.setData({ referee: { ...this.data.referee, open: false } });
      this.showToast(refereeId ? '已指派裁判' : '已撤下裁判', 'success');
      return this.refresh();
    },

    /** 挡住遮罩层的点击穿透，点面板内部不该关掉面板 */
};
