/**
 * P-04：详情页统计列由 SportAdapter.view.statColumns 声明。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { statFieldsOf } = require('../miniprogram/packageTeam/services/team-event-stat-view.js');

test('统计列按运动插件声明：篮球 7 列、足球 4 列、未知为空', () => {
  assert.deepEqual(statFieldsOf('basketball5').map(item => item.field), [
    'points', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'fouls',
  ]);
  assert.deepEqual(statFieldsOf('football11').map(item => item.field), [
    'goals', 'assists', 'yellowCards', 'dismissals',
  ]);
  assert.deepEqual(statFieldsOf('volleyball_unknown'), []);
  assert.deepEqual(statFieldsOf(null), []);
});
