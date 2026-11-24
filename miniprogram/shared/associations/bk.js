/** 篮球协会插件声明 */
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const { teamRules } = require('./base.js');

module.exports = {
  id: 'bk',
  name: '中央民族大学篮球协会',
  shortName: '民大篮球',
  sportName: '篮球',
  sportKey: 'basketball',
  logoGlyph: '篮',
  logoIcon: '/assets/assoc/bk.png',
  theme: {
    // 篮球 → 橙（与匹克球的蓝、网球的草绿拉开；accent 用琥珀，配球体质感）
    primary: '#E65100',
    primaryDark: '#BF360C',
    primaryLight: '#FFF3E0',
    accent: '#F9A825',
  },
  // 团队运动：没有 format / elo，换成规则快照（节数、节长、犯规上限）
  ...teamRules(),
  status: ASSOCIATION_STATUS.ACTIVE,
};
