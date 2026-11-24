/** 客户端交互：保护当前页面的未提交输入，不写本地存储。 */
const { MEASURE_RULES } = require('../shared/services/meet-measure.js');
function withScoreDraftExperience(config) {
  config.data = { ...config.data, scoreDirty: false, dirtyEntryKeys: {}, scoreContext: '' };
  const update = config.update;
  config.update = function (values) {
    if (this.unloaded) return;
    update.call(this, values);
    if (values.scoreItems || values.drafts) {
      const dirtyEntryKeys = {};
      for (const row of this.data.scoreItems || []) {
        if (String(this.data.drafts[row.entryKey] || '') !== String(row.myScore?.text || '')) dirtyEntryKeys[row.entryKey] = true;
      }
      const scoreDirty = Object.keys(dirtyEntryKeys).length > 0;
      this.setData({ dirtyEntryKeys, scoreDirty });
      if (typeof wx !== 'undefined') {
        if (scoreDirty && wx.enableAlertBeforeUnload) wx.enableAlertBeforeUnload({ message: '还有未提交的成绩，离开后当前输入不会保存。' });
        else if (!scoreDirty && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload();
      }
    }
  };
  const confirm = page => {
    if (!page.data.scoreDirty) return Promise.resolve(true);
    if (typeof wx === 'undefined' || !wx.showModal) return Promise.resolve(false);
    return new Promise(resolve => wx.showModal({ title: '还有未提交的成绩',
      content: '切换后会丢弃当前输入。可以取消切换，先逐条提交。', confirmText: '放弃并切换', cancelText: '继续录入',
      success: result => resolve(Boolean(result.confirm)), fail: () => resolve(false) }));
  };
  const open = config.openSession;
  config.openSession = async function (key, judge = '') {
    if ((key !== this.data.activeSessionKey || judge !== this.data.scoringJudgeId) && !await confirm(this)) return;
    await open.call(this, key, judge);
    if (this.unloaded) return;
    const task = (this.data.tasks || []).find(row => row.sessionKey === key);
    const event = (this.data.events || []).find(row => (row.sessions || []).some(slot => slot.sessionKey === key));
    const slot = (event?.sessions || []).find(row => row.sessionKey === key);
    const rule = MEASURE_RULES[event?.scoreType];
    this.update({ scoreContext: [task?.name || event?.name, task?.roundLabel || slot?.roundLabel, slot?.index ? `第 ${slot.index} 场` : ''].filter(Boolean).join(' · '),
      scoreFormatHint: rule ? `单位：${rule.unit} · ${rule.maxDecimals ? '最多 ' + rule.maxDecimals + ' 位小数' : '填写整数'}${rule.round === 'truncate' ? '，按规则截取到厘米' : ''}` : '请按项目规程填写成绩；无成绩交由发布时单独标记，勿填 0 代替。' });
  };
  const openEvent = config.onOpenEvent;
  config.onOpenEvent = async function (event) { if (await confirm(this)) return openEvent.call(this, event); };
  const unload = config.onUnload;
  config.onUnload = function () { if (typeof wx !== 'undefined' && wx.disableAlertBeforeUnload) wx.disableAlertBeforeUnload(); if (unload) unload.call(this); };
  return config;
}
module.exports = { withScoreDraftExperience };
