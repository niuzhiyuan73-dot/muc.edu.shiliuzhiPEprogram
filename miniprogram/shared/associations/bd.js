/** 羽毛球协会插件声明 */
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const { baseRules } = require('./base.js');

module.exports = {
  id: 'bd',
  name: '中央民族大学羽毛球协会',
  shortName: '民大羽球',
  sportName: '羽毛球',
  sportKey: 'badminton',
  logoGlyph: '羽',
  logoIcon: '/assets/assoc/bd.png',
  theme: {
    // 羽毛球 → 紫
    primary: '#6A1B9A',
    primaryDark: '#4A148C',
    primaryLight: '#F3E8F7',
    accent: '#F2994A',
  },
  ...baseRules(),
  status: ASSOCIATION_STATUS.ACTIVE,
};
