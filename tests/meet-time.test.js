const test=require('node:test');
const assert=require('node:assert/strict');
const {parseMeetTime}=require('../src/server/services/meet-time');
test('无时区报名时间按北京时间，显式 UTC 和偏移量表示同一时刻',()=>{
  assert.equal(parseMeetTime('2026-10-24T08:00'),Date.parse('2026-10-24T00:00:00Z'));
  assert.equal(parseMeetTime('2026-10-24T08:00+08:00'),parseMeetTime('2026-10-24T00:00:00Z'));
  for(const value of ['随便填','2026-02-30T08:00','2026-10-24T24:00','2026-10-24T08:61'])assert.ok(Number.isNaN(parseMeetTime(value)));
});
