/** 网球协会插件声明 */
const { ASSOCIATION_STATUS } = require('../utils/constants.js');
const { tennisRules } = require('./base.js');

module.exports = {
  id: 'tn',
  name: '中央民族大学网球协会',
  shortName: '民大网球',
  sportName: '网球',
  sportKey: 'tennis',
  logoGlyph: '网',
  logoIcon: '/assets/assoc/tn.png',
  theme: {
    // 网球 → 草地绿（与乒乓的墨绿 #004D40 靠明度区分，配网球黄做点缀）
    primary: '#2E7D32',
    primaryDark: '#1B5E20',
    primaryLight: '#E8F5E9',
    accent: '#C6D93B',
  },
  // 唯一走三层计分（分 → 局 → 盘）的协会，见 tennisRules()
  ...tennisRules(),
  status: ASSOCIATION_STATUS.ACTIVE,
};
