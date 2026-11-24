/** 匹克球协会插件声明 */
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const { baseRules } = require('./base.js');

module.exports = {
  id: 'pkb',
  name: '中央民族大学匹克球俱乐部',
  shortName: '民大匹克球',
  sportName: '匹克球',
  sportKey: 'pickleball',
  logoGlyph: '匹',
  logoIcon: '/assets/assoc/pkb.png',
  theme: {
    // 匹克球 → 蓝
    primary: '#1565C0',
    primaryDark: '#0D47A1',
    primaryLight: '#E3F0FB',
    accent: '#FF7A45',
  },
  ...baseRules(),
  status: ASSOCIATION_STATUS.ACTIVE,
};
