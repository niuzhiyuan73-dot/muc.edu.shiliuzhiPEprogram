const { validateAnnouncement } = require('../../shared/services/announcement.js');
const { ANNOUNCEMENT_CATEGORIES } = require('../../shared/utils/constants.js');
const { formatDateTime } = require('../../shared/utils/format.js');
const NOTICE_PAGE = 20;

module.exports = {
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

};
