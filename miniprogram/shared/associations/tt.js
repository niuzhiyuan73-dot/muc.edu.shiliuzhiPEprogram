/** 乒乓球协会插件声明 */
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const { baseRules } = require('./base.js');

module.exports = {
  id: 'tt',
  name: '中央民族大学乒乓球协会',
  shortName: '民大乒乓',
  sportName: '乒乓球',
  sportKey: 'table_tennis',
  logoGlyph: '乒',
  logoIcon: '/assets/assoc/tt.png',
  theme: {
    // 乒乓球 → 深绿（RGB 0,77,64）
    primary: '#004D40',
    primaryDark: '#00332B',
    primaryLight: '#E0F0EC',
    accent: '#C9A227',
  },
  ...baseRules(),
  status: ASSOCIATION_STATUS.ACTIVE,
};
