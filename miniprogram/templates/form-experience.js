/** 客户端表单交互；不进入云端纯模块镜像。 */
const { fingerprintOf } = require('../utils/fingerprint.js');
const LABELS = {
  title: '名称', name: '名称', description: '说明', content: '正文', location: '场地', date: '日期', time: '时间',
  startTime: '开始时间', endTime: '结束时间', quota: '报名名额', courtCount: '场地数', groupCount: '小组数',
  rosterMin: '名单下限', rosterMax: '名单上限', maleCount: '男队员人数', femaleCount: '女队员人数',
  allowMultiEntry: '允许兼项', remark: '备注', seedCount: '种子数量', advancePerGroup: '每组出线人数',
  gfReset: '总决赛重赛', placementMode: '排位赛', level: '赛事等级', bronzeMode: '三四名赛',
  matchType: '项目', format: '赛制', discipline: '组别', seedMode: '种子来源',
  tieAlgo: '同分算法', tieNetMode: '净胜口径', pinned: '置顶',
};
const VALUES = { single_elim: '单败淘汰', double_elim: '双败淘汰', round_robin: '循环赛',
  group_knockout: '小组循环 + 淘汰', round_robin_knockout: '循环 + 淘汰', group_double_elim: '小组 + 双败',
  top8: '5–8 名排位', none: '不启用', shared: '并列季军', match: '加赛', manual: '手工指定', elo: '等级分',
  points: '赛季积分', all: '不限', male: '男子', female: '女子', mixed: '混合' };
function signature(data) { return fingerprintOf([data.form, data.audienceIndex, data.selectedGroupIds]); }
function formRows(data, labels = {}) {
  const selectors = { matchType: ['matchTypes', 'matchTypeIndex'], discipline: ['disciplines', 'disciplineIndex'],
    format: ['formats', 'formatIndex'], level: ['levels', 'levelIndex'], bronzeMode: ['bronzeModes', 'bronzeIndex'],
    seedMode: ['seedModes', 'seedModeIndex'], tieAlgo: ['tieAlgos', 'tieAlgoIndex'], tieNetMode: ['tieNetModes', 'tieNetModeIndex'] };
  const rows = Object.entries(data.form || {}).filter(([field, value]) => (labels[field] || LABELS[field]) && (value == null || typeof value !== 'object'))
    .map(([field, value]) => {
      const select = selectors[field]; const label = select && data[select[0]]?.[data[select[1]]];
      return { field, label: labels[field] || LABELS[field], value: value === '' || value == null ? '未填写' : label || (typeof value === 'boolean' ? (value ? '是' : '否') : Object.prototype.hasOwnProperty.call(VALUES, value) ? VALUES[value] : String(value)) };
    });
  if (data.form?.legPlan) rows.push({ field: 'legPlan', label: '对阵小项顺序', value: data.form.legPlan.map(key => ({ MS: '男单', WS: '女单', MD: '男双', WD: '女双', XD: '混双' })[key] || key).join(' → ') });
  if (data.audienceIndex !== undefined) rows.push({ field: 'audience', label: '报名资格', value: data.audienceIndex === 1 ? '仅限所选小组：' + (data.groups || []).filter(row => (data.selectedGroupIds || []).includes(row.groupId)).map(row => row.name).join('、') : '不限小组' });
  return rows;
}
function withFormExperience(config, labels = {}) {
  config.data = { ...config.data, formFolds: {}, formReview: null, formErrorItems: [] };
  const submit = config.onSubmit;
  config.onSubmit = async function (...args) {
    try { return await submit.apply(this, args); }
    catch (error) { this.setData({ submitting: false, errorText: error.message || '提交失败，请重试' }); }
    finally {
      const items = Object.entries(this.data.errors || {}).filter(([, message]) => message).map(([field, message]) => ({ field, message }));
      this.setData({ formErrorItems: items, ...(items.length ? { formReview: null, formFolds: {} } : {}) });
      if (items.length) this.onFormError({ currentTarget: { dataset: { field: items[0].field } } });
    }
  };
  for (const key of Object.keys(config).filter(key => /^on(Input|Pick|Toggle)/.test(key))) {
    const original = config[key];
    config[key] = function (...args) { this.setData({ formReview: null }); return original.apply(this, args); };
  }
  config.onToggleFormGroup = function (event) {
    const group = event.currentTarget.dataset.group;
    if (!/^group-\d+$/.test(group)) return;
    this.setData({ formFolds: { ...this.data.formFolds, [group]: !this.data.formFolds[group] } });
  };
  config.onPrepareFormReview = function () {
    if (this.data.submitting || this.data.loading || this.data.blockReason) return;
    this.setData({ formReview: { signature: signature(this.data), rows: formRows(this.data, labels) } }, () => {
      if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ selector: '#form-review', duration: 180 });
    });
  };
  config.onConfirmFormReview = function () {
    if (!this.data.formReview || signature(this.data) !== this.data.formReview.signature) return this.onPrepareFormReview();
    return this.onSubmit();
  };
  config.onBackToForm = function () { this.setData({ formReview: null }); };
  config.onFormError = function (event) {
    const field = event.currentTarget.dataset.field;
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(field)) return;
    this.setData({ formFolds: {} }, () => {
      if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ selector: `#form-${field}`, duration: 180 });
    });
  };
  return config;
}
module.exports = { withFormExperience, formRows, signature };
