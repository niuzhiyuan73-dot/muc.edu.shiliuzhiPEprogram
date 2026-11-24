/**
 * 团队运动分派（兼容入口，实际注册表收口至 `src/shared/sports/registry.js`）。
 * 运动身份来自协会注册表，不能由请求的 presetKey 决定。
 */

const {
  getSportAdapter,
  getSportAdapterFor,
  toLegacyStrategy,
} = require('../sports/registry.js');

function teamSportStrategy(sportFormat) {
  return toLegacyStrategy(getSportAdapter(sportFormat));
}

function teamSportStrategyFor(associationId, event = null) {
  return toLegacyStrategy(getSportAdapterFor(associationId, event));
}

module.exports = { teamSportStrategy, teamSportStrategyFor };
