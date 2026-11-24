/**
 * 团队赛事建赛表单的声明驱动配置。
 *
 * 页面不再直接 import 篮球的 RULE_PRESETS；规则预设由 SportAdapter.rules
 * 声明，新增运动只要在插件里给 presetOptions，页面就能直接建赛。
 */

const { getSportAdapterFor } = require('../../shared/sports/registry.js');

function eventFormConfigOf(associationId) {
  const adapter = getSportAdapterFor(associationId);
  if (!adapter) {
    return { mode: 'unsupported', presets: [], defaultPresetKey: '' };
  }
  const presets = (adapter.rules.presetOptions || []).map(option => ({
    key: option.key,
    label: option.label,
  }));
  const defaultPresetKey = adapter.rules.defaultPresetKey || '';
  // 防御性收口：插件声明的默认预设不在选项里时，建赛页原本会静默选中
  // presets[0]，用户拿到与插件声明不符的规则。契约校验已拦正常注册路径，
  // 这里再守一道——对声明不一致的适配器降级为 unsupported（拒绝而非错建）。
  // 足球无 presetOptions（走专属表单），presets 为空，不受此约束。
  if (presets.length > 0 && !presets.some(item => item.key === defaultPresetKey)) {
    return { mode: 'unsupported', presets: [], defaultPresetKey: '' };
  }
  return {
    mode: adapter.view.eventFormMode || 'unsupported',
    presets,
    defaultPresetKey,
  };
}

module.exports = { eventFormConfigOf };
