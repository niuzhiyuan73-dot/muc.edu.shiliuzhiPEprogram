const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, instantiate } = require('./helpers/page-harness');
const space = require('../miniprogram/services/association-space');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const members = (ids, extra = {}) => ({ ok: true, members: ids.map(userId => ({ userId, nickName: userId })), hasMore: false, ...extra });
const picker = () => {
  const page = instantiate(loadPage('match-entry'));
  page.setData({ pickerVisible: true, pickerSide: 'B', pickerSlot: 0, pickerKeyword: '', members: [], form: { teamA: ['self'], teamB: [''] } });
  return page;
};

test('录分选人使用服务端关键词和游标，续页去重并保留姓名缓存', async () => {
  const page = picker(), calls = [];
  page.setData({ pickerKeyword: 'new' });
  page.api = { listSchoolMembers: async payload => {
    calls.push(payload);
    return calls.length === 1 ? members(['newA'], { hasMore: true, nextCursor: 'cursor-1' }) : members(['newA', 'newB']);
  } };
  await page.loadPickerMembers(false); await page.onMorePicker();
  assert.deepEqual(calls.map(row => [row.keyword, row.cursor, row.page]), [['new', '', true], ['new', 'cursor-1', true]]);
  assert.deepEqual(page.data.pickerRows.map(row => row.id), ['newA', 'newB']);
  assert.equal(page.nameById.newA, 'newA'); assert.equal(page.data.pickerHasMore, false);
});

test('录分选人搜索逆序返回时不覆盖新结果', async () => {
  const page = picker(), old = defer(), next = defer();
  page.api = { listSchoolMembers: payload => payload.keyword === 'old' ? old.promise : next.promise };
  page.setData({ pickerKeyword: 'old' }); const a = page.loadPickerMembers(false);
  page.setData({ pickerKeyword: 'new' }); const b = page.loadPickerMembers(false);
  next.resolve(members(['new'])); await b;
  old.resolve(members(['old'])); await a;
  assert.deepEqual(page.data.pickerRows.map(row => row.id), ['new']);
  assert.equal(page.nameById.old, undefined);
});

test('录分选人关闭或卸载后忽略在途请求', async () => {
  for (const close of ['onClosePicker', 'onUnload']) {
    const page = picker(), pending = defer();
    page.api = { listSchoolMembers: () => pending.promise };
    const task = page.loadPickerMembers(false); page[close]();
    pending.resolve(members(['late'])); await task;
    assert.equal(page.data.members.length, 0);
  }
});

test('录分选人续页失败可按原游标重试', async () => {
  const page = picker(); let count = 0;
  page.api = { listSchoolMembers: async () => {
    count++;
    if (count === 1) return members(['a'], { hasMore: true, nextCursor: 'next' });
    if (count === 2) throw new Error('网络故障');
    return members(['b']);
  } };
  await page.loadPickerMembers(false); await page.onMorePicker();
  assert.equal(page.data.pickerCursor, 'next'); assert.equal(page.data.members.length, 1);
  await page.onMorePicker(); assert.deepEqual(page.data.pickerRows.map(row => row.id), ['a', 'b']);
});

async function scheduleTest(fetch, run) {
  const original = space.forScope;
  space.forScope = () => ({ getTeamMatchSchedule: fetch });
  try {
    const page = instantiate(loadPage('team-event-detail'));
    page.scope = { schoolId: 'muc', association: 'fb' };
    page.setData({ scheduleEditing: { matchId: 'm', peopleKeyword: 'next', referees: [{ userId: 'chosen', name: '已选' }],
      recorders: [], refereeIndex: 1, recorderIndex: 0 } });
    await run(page);
  } finally { space.forScope = original; }
}

test('赛程候选搜索保留已选人员，续页传递服务端游标', async () => {
  const calls = [];
  await scheduleTest(async payload => {
    calls.push(payload);
    return { ok: true, referees: [{ userId: 'candidate', name: '候选' }], recorders: [], hasMore: calls.length === 1, nextCursor: 'next-page' };
  }, async page => {
    await page.loadSchedulePeople(false); await page.onMoreSchedulePeople();
    assert.deepEqual(calls.map(row => row.cursor), ['', 'next-page']);
    assert.deepEqual(page.data.scheduleEditing.referees.map(row => row.userId), ['chosen', 'candidate']);
    assert.equal(page.data.scheduleEditing.refereeIndex, 1);
  });
});

test('赛程候选关闭后不被晚到响应重新打开', async () => {
  const pending = defer();
  await scheduleTest(() => pending.promise, async page => {
    const task = page.loadSchedulePeople(false); page.onCloseSchedule();
    pending.resolve({ ok: true, referees: [], recorders: [] }); await task;
    assert.equal(page.data.scheduleEditing, null);
  });
});
