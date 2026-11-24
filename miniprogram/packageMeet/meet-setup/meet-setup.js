/**
 * 发起运动会 / 继续配置项目（两段向导）
 * ============================================================
 * 两种进入方式：
 *   · 不带 meetId：新发起。第一步填基本信息并建草稿，第二步选项目。
 *   · 带 meetId：继续配置已有草稿，直接进第二步，并**回填已配置的项目**。
 *
 * 【勾选即保存】
 * 早先的写法是「先改一堆，最后点保存项目统一提交」。中途退出、切页面，或者
 * 某一项被服务端拒绝，用户看到的就是「我明明选了，草稿里却没有」。
 * 现在每次勾选/取消/改人数都立刻写库：勾上就 configureMeetEvent，取消就
 * removeMeetEvent。草稿状态永远等于屏幕上的状态，不需要用户记得点保存。
 *
 * 【为什么人数与限额可以是 0（不限）】
 * 入场式展示这类项目，各院上场人数与队数由学院自己定，系统只关心「有没有报」。
 * 0 在服务端表示「不限」，页面显示成「不限」而不是「0 人」。
 *
 * 【赛制与轮次用分段选择，不是一个按钮】
 * 原来单个 chip 显示「直接决赛」，点一下才知道是切换，也看不出还有别的选项。
 * 现在明确列出全部可选值：数值型「直接决赛 / 预赛+决赛」，胜负型
 * 「单败淘汰 / 循环赛 / 小组+淘汰」；选中项高亮，未选项一眼可见。
 * ============================================================
 */

const meet = require('../../services/meet.js');
const { updateMeetPage } = require('../../utils/meet-ui.js');
const session = require('../../services/school-session.js');
const { meetEventKey } = require('../../shared/utils/meet-scope.js');

const GROUP_LABEL = { male: '男子', female: '女子', mixed: '混合' };
const GROUP_ORDER = ['male', 'female', 'mixed'];

/** 限额单位：单人按人、团体按队、多人协作按组（4.2） */
function unitOf(entryForm) {
  if (entryForm === 'single') return '人';
  if (entryForm === 'team') return '队';
  return '组';
}

/** 给每个模板算出可勾选组别，并标出当前是否已选（WXML 只能读数据，不能调方法） */
function decorateTemplates(templates, picked) {
  const chosen = new Set(picked.map((row) => row.key));
  return templates.map((item) => ({
    ...item,
    groupOptions: GROUP_ORDER
      .filter((group) => item.recommendedGroups.includes(group))
      .map((group) => ({
        group,
        label: GROUP_LABEL[group],
        picked: chosen.has(`${item.templateId}|${group}`),
      })),
  }));
}

/** 按模板与参赛形态给出默认限额（与 meet-service 的默认值同源） */
function defaultLimit(template) {
  return template.entryForm === 'single' || template.entryForm === 'group' ? 3 : 1;
}

Page({
  data: {
    loading: true,
    error: '',
    notice: '',
    busy: false,
    schoolId: '',
    meetId: '',
    isContinue: false,
    /** 带 meetId 且 step=1 进入：改草稿基本信息，保存走 updateMeetDraft */
    editBasics: false,
    step: 1,

    // 基本信息
    name: '',
    year: '',
    startDate: '',
    endDate: '',
    location: '',

    // 项目选择
    keyword: '',
    categories: [],
    activeCategory: '',
    templates: [],
    picked: [],
    pickedCount: 0,
    savingKey: '',
  },

  onLoad(options = {}) {
    this.unloaded = false;
    const meetId = String(options.meetId || '');
    // 带 step=1 进入 = 改草稿基本信息（详情页「编辑基本信息」）：仍从第一步开始，
    // 但保存时走 updateMeetDraft 而不是 createSportsMeet。
    const editBasics = String(options.step || '') === '1';
    const now = new Date();
    this.update({
      schoolId: session.getSchoolId() || 'muc',
      meetId,
      isContinue: Boolean(meetId),
      editBasics: Boolean(meetId) && editBasics,
      step: meetId && !editBasics ? 2 : 1,
      year: String(now.getFullYear()),
      startDate: this.dateAfter(30),
      endDate: this.dateAfter(31),
    });
    return (meetId && editBasics ? this.loadMeetBasics(meetId) : Promise.resolve())
      .then(() => this.loadTemplates());
  },

  /** 改草稿时回填基本信息（名称 / 年份 / 起止 / 地点） */
  async loadMeetBasics(meetId) {
    try {
      const result = await meet.forScope({ schoolId: this.data.schoolId, meetId }).getSportsMeet({ meetId });
      const doc = result.meet || {};
      this.update({
        name: doc.name || '',
        year: doc.year ? String(doc.year) : this.data.year,
        startDate: doc.startDate || this.data.startDate,
        endDate: doc.endDate || this.data.endDate,
        location: doc.location || '',
      });
    } catch (err) {
      this.update({ error: (err && err.message) || '读取草稿失败' });
    }
  },

  onUnload() {
    this.unloaded = true;
    if (this.inputTimers) {
      Object.values(this.inputTimers).forEach((timer) => clearTimeout(timer));
      this.inputTimers = null;
    }
  },

  update(values) {
    updateMeetPage(this, values);
  },

  dateAfter(days) {
    const date = new Date(Date.now() + days * 86400000);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  },

  client() {
    return meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId });
  },

  async loadTemplates() {
    this.update({ loading: true, error: '' });
    try {
      const [result, existing] = await Promise.all([
        meet.forScope({ schoolId: this.data.schoolId })
          .listSportsEventTemplates({ keyword: this.data.keyword, category: this.data.activeCategory }),
        // 继续配置必须回填：否则一进来「已选 0 项」，看起来像之前什么都没保存
        // 只在首次进入时回填：之后每次切分类都重新拉会覆盖本地刚改的设置
        this.data.meetId && !this.prefilled ? this.client().getSportsMeet({}) : Promise.resolve(null),
      ]);
      const byId = new Map(result.items.map((item) => [item.templateId, item]));
      const picked = existing ? this.pickedFromEvents(existing.events, byId) : this.data.picked;
      if (existing) this.prefilled = true;
      this.update({
        loading: false,
        categories: result.categories,
        templates: decorateTemplates(result.items, picked),
        picked,
        pickedCount: picked.length,
      });
    } catch (err) {
      this.update({ loading: false, error: (err && err.message) || '项目库加载失败' });
    }
  },

  /** 把服务端已配置的项目还原成编辑行（人数、限额、赛制、轮次一个不能丢） */
  pickedFromEvents(events, templateById) {
    return (events || []).map((ev) => {
      const template = templateById.get(ev.templateId) || {};
      return {
        key: `${ev.templateId}|${ev.group}`,
        eventKey: ev.eventKey,
        templateId: ev.templateId,
        name: ev.name,
        group: ev.group,
        groupLabel: GROUP_LABEL[ev.group],
        entryForm: ev.entryForm,
        scoreType: ev.scoreType,
        members: Number(ev.members) || 0,
        membersUnlimited: Number(ev.members) === 0,
        limit: Number(ev.perCollegeLimit) || 0,
        limitUnlimited: Number(ev.perCollegeLimit) === 0,
        limitUnit: unitOf(ev.entryForm),
        fixedMembers: template.fixedMembers || null,
        isVersus: ev.scoreType === 'versus',
        saved: true,
      };
    });
  },

  // ---------- 第一步：基本信息 ----------

  onFieldInput(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.update({ [field]: event.detail.value });
  },

  onDateChange(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    this.update({ [field]: event.detail.value });
  },

  async onNext() {
    if (this.data.busy) return undefined;
    this.update({ busy: true, error: '' });
    const basics = {
      name: this.data.name,
      startDate: this.data.startDate,
      endDate: this.data.endDate,
      location: this.data.location,
    };
    try {
      // 改草稿：同一个向导第一步，保存口径不同（updateMeetDraft 只接受草稿期）
      if (this.data.meetId) {
        await meet.forScope({ schoolId: this.data.schoolId, meetId: this.data.meetId })
          .updateMeetDraft(basics);
        this.update({ busy: false, step: 2, notice: '基本信息已保存' });
        return undefined;
      }
      const created = await meet.forScope({ schoolId: this.data.schoolId }).createSportsMeet({
        ...basics,
        year: Number(this.data.year),
      });
      this.update({
        busy: false,
        step: 2,
        meetId: created.meet.meetId,
        notice: '草稿已建立，选中的项目会立即保存',
      });
    } catch (err) {
      this.update({ busy: false, error: (err && err.message) || (this.data.meetId ? '保存失败' : '创建失败') });
    }
    return undefined;
  },

  // ---------- 第二步：选项目 ----------

  onKeywordInput(event) {
    this.update({ keyword: event.detail.value });
  },

  onSearch() {
    return this.loadTemplates();
  },

  onCategoryTap(event) {
    const category = String(event.currentTarget.dataset.category || '');
    this.update({ activeCategory: category });
    return this.loadTemplates();
  },

  /** 勾选 = 立即写入草稿；取消 = 立即从草稿移除 */
  async onToggleGroup(event) {
    const { templateId, group } = event.currentTarget.dataset;
    const key = `${templateId}|${group}`;
    const picked = [...this.data.picked];
    const index = picked.findIndex((row) => row.key === key);

    if (index >= 0) {
      const row = picked[index];
      this.update({ savingKey: key, error: '' });
      try {
        await this.client().removeMeetEvent({ eventKey: row.eventKey });
      } catch (err) {
        this.update({ savingKey: '', error: (err && err.message) || '移除失败' });
        return;
      }
      picked.splice(index, 1);
      this.update({
        savingKey: '',
        picked,
        pickedCount: picked.length,
        templates: decorateTemplates(this.data.templates, picked),
      });
      return;
    }

    const template = this.data.templates.find((item) => item.templateId === templateId);
    if (!template) return;
    const row = {
      key,
      eventKey: meetEventKey(this.data.meetId, templateId, group),
      templateId,
      name: template.name,
      group,
      groupLabel: GROUP_LABEL[group],
      entryForm: template.entryForm,
      scoreType: template.scoreType,
      members: template.fixedMembers || template.defaultMembers || 1,
      membersUnlimited: false,
      limit: defaultLimit(template),
      limitUnlimited: false,
      limitUnit: unitOf(template.entryForm),
      fixedMembers: template.fixedMembers || null,
      isVersus: template.scoreType === 'versus',
      saved: false,
    };
    picked.push(row);
    this.update({
      picked,
      pickedCount: picked.length,
      templates: decorateTemplates(this.data.templates, picked),
    });
    await this.persist(row);
  },

  /** 把一行的当前设置写进草稿；失败时明确报出来，不吞掉 */
  async persist(row) {
    // 这一步只写「项目怎么参加」：人数与限额。赛制（轮次/分组/签表）留到
    // 报名截止后的编排阶段——那时候才知道有多少人报名、要分几组。
    const payload = {
      templateId: row.templateId,
      group: row.group,
      members: row.entryForm === 'single'
        ? 1
        : (row.membersUnlimited ? 0 : Number(row.members) || 0),
      perCollegeLimit: row.limitUnlimited ? 0 : Number(row.limit) || 0,
    };

    this.update({ savingKey: row.key, error: '' });
    try {
      await this.client().configureMeetEvent(payload);
      this.markSaved(row.key, true);
      this.update({ savingKey: '' });
      return true;
    } catch (err) {
      const message = (err && err.message) || '保存失败';
      this.markSaved(row.key, false, message);
      this.update({ savingKey: '', error: `${row.name}（${row.groupLabel}）：${message}` });
      return false;
    }
  },

  markSaved(key, saved, message = '') {
    const picked = this.data.picked.map((row) => (row.key === key
      ? { ...row, saved, saveError: message } : row));
    this.update({ picked });
  },

  /** 改了一行之后：先写库，再刷新界面 */
  async applyChange(index, patch, { debounce = false } = {}) {
    const picked = [...this.data.picked];
    const row = { ...picked[index], ...patch };
    picked[index] = row;
    this.update({ picked });
    if (!debounce) {
      await this.persist(row);
      return row;
    }
    this.inputTimers = this.inputTimers || {};
    if (this.inputTimers[index]) clearTimeout(this.inputTimers[index]);
    this.inputTimers[index] = setTimeout(() => {
      delete this.inputTimers[index];
      const latest = this.data.picked[index];
      if (latest) this.persist(latest);
    }, 250);
    return row;
  },

  /** 人数与限额：允许直接输入，不再只能点加减 */
  onMembersInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value) || row.fixedMembers) return;
    const members = Math.max(0, Math.min(200, Math.trunc(value)));
    this.applyChange(index, { members, membersUnlimited: members === 0 }, { debounce: true });
  },

  onLimitInput(event) {
    const index = Number(event.currentTarget.dataset.index);
    const value = Number(event.detail.value);
    const row = this.data.picked[index];
    if (!row || !Number.isFinite(value)) return;
    const limit = Math.max(0, Math.min(20, Math.trunc(value)));
    this.applyChange(index, { limit, limitUnlimited: limit === 0 }, { debounce: true });
  },

  onToggleMembersUnlimited(event) {
    const index = Number(event.currentTarget.dataset.index);
    const row = this.data.picked[index];
    if (!row || row.fixedMembers) return;
    // 取消「不限」时给一个合理默认值，避免人数停在 0 让报名端无从校验
    const next = row.membersUnlimited ? (row.entryForm === 'single' ? 1 : 10) : 0;
    this.applyChange(index, { membersUnlimited: !row.membersUnlimited, members: next });
  },

  onToggleLimitUnlimited(event) {
    const index = Number(event.currentTarget.dataset.index);
    const row = this.data.picked[index];
    if (!row) return;
    this.applyChange(index, {
      limitUnlimited: !row.limitUnlimited,
      limit: row.limitUnlimited ? 1 : 0,
    });
  },

  onStep(event) {
    const { index, field, delta } = event.currentTarget.dataset;
    const row = this.data.picked[Number(index)];
    if (!row) return;
    const next = Number(row[field]) + Number(delta);
    if (field === 'members') {
      if (row.fixedMembers || row.entryForm === 'single') return;
      if (next < 0 || next > 200) return;
    }
    if (field === 'limit' && (next < 0 || next > 20)) return;
    if (field === 'advanceCount' && (next < 1 || next > 50)) return;
    this.applyChange(Number(index), { [field]: next });
  },

  /** 收尾：项目在勾选时就已写库，这里只校验有没有保存失败的 */
  async onSubmit() {
    if (this.data.busy) return undefined;
    if (this.data.picked.length === 0) {
      this.update({ error: '请至少选择一个项目再继续' });
      return undefined;
    }
    this.update({ busy: true, error: '' });
    try {
      if (this.inputTimers) {
        const pendingIndexes = Object.keys(this.inputTimers);
        pendingIndexes.forEach((idx) => {
          clearTimeout(this.inputTimers[idx]);
          delete this.inputTimers[idx];
        });
        for (const idx of pendingIndexes) {
          const row = this.data.picked[Number(idx)];
          if (row) await this.persist(row);
        }
      }
      const failed = this.data.picked.filter((row) => !row.saved);
      if (failed.length > 0) {
        // 逐项重试一次：多数是网络抖动，重试就能过
        for (const row of failed) await this.persist(row);
        const stillFailed = this.data.picked.filter((row) => !row.saved);
        if (stillFailed.length > 0) {
          this.update({ error: `还有 ${stillFailed.length} 项没有保存成功，请检查后重试` });
          return undefined;
        }
      }
      return wx.redirectTo({ url: `/packageMeet/meet-detail/meet-detail?meetId=${this.data.meetId}` });
    } finally {
      this.update({ busy: false });
    }
  },

  onBackToBasic() {
    if (this.data.isContinue) {
      return wx.navigateBack({ delta: 1 });
    }
    this.update({ step: 1, error: '', notice: '' });
    return undefined;
  },
});
