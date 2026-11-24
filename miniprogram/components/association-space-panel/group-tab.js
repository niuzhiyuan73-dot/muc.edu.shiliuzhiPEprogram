const PICK_POOL = 50;

module.exports = {
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

};
