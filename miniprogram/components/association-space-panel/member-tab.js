const MEMBER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 300;

module.exports = {
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

};
