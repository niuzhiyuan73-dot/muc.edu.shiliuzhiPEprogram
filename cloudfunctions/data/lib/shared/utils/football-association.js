/** 足球协会定义。注册表调用工厂，规则和品牌每次返回独立副本。 */
const { defaultRulesFor } = require('./football-rules.js');
const { ASSOCIATION_STATUS } = require('./constants.js');

function createFootballAssociation() {
  return {
    id: 'fb',
    name: '中央民族大学足球协会',
    shortName: '民大足球',
    sportName: '足球',
    logoGlyph: '足',
    logoIcon: '/assets/assoc/fb.png',
    theme: { primary: '#0D6B45', primaryDark: '#08492F', primaryLight: '#E7F3EC', accent: '#D4AF37' },
    sportType: 'team',
    teamSportFormat: 'football11',
    capabilities: ['space', 'teams', 'myTeams', 'events'],
    footballRules: defaultRulesFor(),
    status: ASSOCIATION_STATUS.ACTIVE,
  };
}

module.exports = { createFootballAssociation };
