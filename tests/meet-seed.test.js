/**
 * 运动会演示种子（B9）端到端
 * ============================================================
 * 演示种子把一整届运动会跑完（建届→报名→抽签→录分→发布→更正→总榜），
 * 本文件逐条核对施工分批计划 B9 要求的演示场景是否真的演到了：
 *
 *   学院不报项目 / 未报满 / 团体与接力 / 三人板鞋固定人数 / 三裁判平均 /
 *   并列名次 / 人数不足 / 无成绩 / 学院总榜 / 个人荣誉 / 更正一次 / 删除一次
 *
 * 另外钉住两件容易在后续改动中悄悄坏掉的事：
 *   · **总榜与结果行一致**——学院总分之和必须等于正式结果行的积分之和；
 *   · **零分学院也在榜上**（D82）且学院名是当届快照，不是原始编号。
 *
 * 【为什么盯死总榜的具体数字】
 * 演示数据的意义就在于「打开页面能看到这一届」。分组算法（同院分散）
 * 或积分表一改，榜就会变——那时应当先确认新榜符合预期，再改这里的数字，
 * 而不是让测试默默放行一个自己都没见过的演示届。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');

const { runMeetDemo, createMeetDemoRecords } = require('../miniprogram/services/meet-seed.js');

// 整届只跑一遍：所有用例共享同一结果（node:test 默认顺序执行）。
const demo = runMeetDemo();

const rowsOf = (world, templateId, official = true) => world.resultRows.filter(
  (row) => row.eventKey === world.eventKeys[templateId] && row.official === official);

test('演示种子：六类项目全部报满到计划形态', async () => {
  const { world } = await demo;
  assert.equal(world.clogsRejected, '该项目每组需 3 人，当前选了 2 人',
    '三人板鞋固定 3 人：2 人组必须被服务端拒绝');
  assert.deepEqual(world.entryCount['sprint-100m'], { c01: 2, c02: 1, c03: 1 });
  assert.deepEqual(world.entryCount['middle-800m'], { c01: 1, c02: 1 });
  assert.deepEqual(world.entryCount['relay-4x100'], { c01: 1, c02: 1, c03: 1, c04: 1 });
  assert.deepEqual(world.entryCount['show-gymnastics'], { c01: 1, c02: 1, c03: 1, c04: 1, c05: 1 });
});

test('学院不报项目：c04 只报 400 米一项个人赛，c05 只报团体操', async () => {
  const { world } = await demo;
  for (const templateId of ['sprint-100m', 'middle-800m', 'fun-clogs']) {
    assert.ok(!world.entryCount[templateId].c04, `c04 不该报${templateId}`);
    assert.ok(!world.entryCount[templateId].c05, `c05 不该报${templateId}`);
  }
  for (const templateId of ['sprint-100m', 'middle-800m', 'sprint-400m', 'fun-clogs']) {
    assert.ok(!world.entryCount[templateId].c05, `c05 不该报任何个人项：${templateId}`);
  }
  assert.equal(world.entryCount['relay-4x100'].c04, 1, 'c04 报了接力');
  assert.equal(world.entryCount['sprint-400m'].c04, 1, 'c04 只报一项个人赛');
});

test('未报满：100 米每院上限 3，一院只报 2', async () => {
  const { repo, world } = await demo;
  const event = await repo.sportsMeetEvents.getById(world.eventKeys['sprint-100m']);
  assert.equal(event.perCollegeLimit, 3);
  assert.equal(world.entryCount['sprint-100m'].c01, 2, '报 2 条即未报满，且合法');
});

test('人数不足：800 米只报 2 人，单场进行', async () => {
  const { repo, world } = await demo;
  const event = await repo.sportsMeetEvents.getById(world.eventKeys['middle-800m']);
  assert.equal(event.heatMode, 'capacity');
  assert.equal(event.heatCapacity, 15, '长跑每批上限 15');
  const sessions = (await repo.sportsMeetSessions.list())
    .filter((doc) => doc.eventKey === world.eventKeys['middle-800m']);
  assert.equal(sessions.length, 1, '人数远不足一批，只有一个场次');
  assert.equal(sessions[0].entryKeys.length, 2);
});

test('三裁判平均：广播体操 88/90/92 去极值平均为 90，且展示类不计分', async () => {
  const { world } = await demo;
  const rows = rowsOf(world, 'show-gymnastics');
  assert.equal(rows.length, 5, '五院都上场了');
  for (const row of rows) {
    assert.equal(row.value, 900, '90.0 分（量表 10）');
    assert.equal(row.points, 0, '展示类不计学院分');
    assert.equal(row.rank, 1, '成绩全部相同，并列第一');
  }
});

test('并列名次：更正前 100 米两院同成绩并列第 3（竞赛排名 1,2,3,3）', async () => {
  const { world } = await demo;
  assert.deepEqual(world.beforeCorrection.map((row) => [row.collegeId, row.rank, row.points]), [
    ['c01', 1, 9],
    ['c01', 2, 7],
    ['c02', 3, 6],
    ['c03', 3, 6],
  ]);
});

test('无成绩：800 米记无成绩的选手不得分、不占名次、不进荣誉', async () => {
  const { world } = await demo;
  const rows = rowsOf(world, 'middle-800m');
  const voidRow = rows.find((row) => row.collegeId === 'c02');
  assert.equal(voidRow.status, 'void');
  assert.equal(voidRow.rank, null);
  assert.equal(voidRow.points, 0);
  const winner = rows.find((row) => row.collegeId === 'c01');
  assert.equal(winner.rank, 1);
  assert.equal(winner.points, 9, '人数不足也按实际名次正常计分（D75）');
  const mine = world.honors.m_c02_2;
  assert.ok(mine.items.every((item) => item.eventKey !== world.eventKeys['middle-800m']),
    '无成绩不产生荣誉');
});

test('预赛晋级：400 米 9 人分 2 组，每组前 2 进决赛；预赛不计分', async () => {
  const { repo, world } = await demo;
  assert.deepEqual(world.draw, { heatCount: 2, heatMode: 'lane', heatCapacity: 8 });
  const sessions = (await repo.sportsMeetSessions.list())
    .filter((doc) => doc.eventKey === world.eventKeys['sprint-400m']);
  const heats = sessions.filter((doc) => doc.round === 'heat');
  assert.deepEqual(heats.map((doc) => doc.entryKeys.length).sort(), [4, 5], '5+4 两组');
  const final = sessions.find((doc) => doc.round === 'final');
  assert.equal(final.entryKeys.length, 4, '每组前 2，共 4 人进决赛');
  assert.equal(world.finalists.length, 4);

  const prelim = rowsOf(world, 'sprint-400m', false);
  assert.equal(prelim.length, 9, '预赛行覆盖全部 9 人');
  assert.ok(prelim.every((row) => !row.official));
  const finalRows = rowsOf(world, 'sprint-400m').sort((a, b) => a.rank - b.rank);
  assert.deepEqual(finalRows.map((row) => [row.rank, row.points]), [[1, 9], [2, 7], [3, 6], [4, 5]]);
});

test('学院总榜：按名次分表累加，零分学院也在榜（D82），名称是当届快照', async () => {
  const { world } = await demo;
  assert.equal(world.standingsPublished, true);
  assert.deepEqual(world.standings.map((row) => [row.collegeId, row.rank, row.total]), [
    ['c01', 1, 63],
    ['c02', 2, 37],
    ['c03', 3, 23],
    ['c04', 4, 10],
    ['c05', 5, 0],
  ]);
  const zero = world.standings.find((row) => row.collegeId === 'c05');
  assert.equal(zero.collegeName, '历史文化学院', '学院名取本届快照，不是原始编号');
  // 明细可追溯：学院总分之和 === 正式结果行的积分之和
  const fromRows = world.resultRows
    .filter((row) => row.official)
    .reduce((sum, row) => sum + Number(row.points || 0), 0);
  const fromBoard = world.standings.reduce((sum, row) => sum + row.total, 0);
  assert.equal(fromBoard, fromRows, '总榜必须与结果行一致');
  // 参与范围快照：报了名的五院各一行
  assert.deepEqual(world.collegeScope.map((row) => row.collegeId).sort(),
    ['c01', 'c02', 'c03', 'c04', 'c05']);
});

test('团体双倍与队员人人有荣誉：接力第一 18 分，四名队员都有', async () => {
  const { world } = await demo;
  const rows = rowsOf(world, 'relay-4x100').sort((a, b) => a.rank - b.rank);
  assert.deepEqual(rows.map((row) => [row.collegeId, row.rank, row.points]), [
    ['c01', 1, 18],
    ['c02', 2, 14],
    ['c03', 3, 12],
    ['c04', 4, 10],
  ], '团体按个人分表 ×2（D72）');
  const mine = world.honors.m_c01_1;
  const relay = mine.items.find((item) => item.eventKey === world.eventKeys['relay-4x100']);
  assert.equal(relay.rank, 1);
  assert.equal(relay.points, 18, '队员看到的是团体分，不是被平摊');
});

test('个人荣誉：更正后金牌易主，各人汇总与明细一致', async () => {
  const { world } = await demo;
  // 更正把 100 米金牌从 c01 换给 c02
  const sprintRows = rowsOf(world, 'sprint-100m')
    .slice()
    .sort((a, b) => a.rank - b.rank);
  assert.deepEqual(sprintRows.map((row) => [row.collegeId, row.rank, row.points]), [
    ['c02', 1, 9],
    ['c01', 2, 7],
    ['c01', 3, 6],
    ['c03', 4, 5],
  ]);
  assert.equal(world.honors.m_c02_1.items.find((item) => item.eventKey === world.eventKeys['sprint-100m']).rank, 1);
  assert.equal(world.honors.m_c01_1.items.find((item) => item.eventKey === world.eventKeys['sprint-100m']).rank, 2);
  // 800 米第一、团体操第一（0 分）也都在「我的荣誉」里（D89：全部有效正式名次）
  assert.equal(world.honors.m_c01_3.items.find((item) => item.eventKey === world.eventKeys['middle-800m']).points, 9);
  const show = world.honors.m_c05_1.items.find((item) => item.eventKey === world.eventKeys['show-gymnastics']);
  assert.equal(show.rank, 1);
  assert.equal(show.points, 0);
  assert.equal(world.honors.m_c05_1.summary.points, 0);
});

test('更正一次：重发后版本为 2，总分是修正值而不是新旧相加（D87）', async () => {
  const { world } = await demo;
  assert.equal(world.sprintCorrection.version, 2);
  assert.equal(world.publications['sprint-100m'].version, 2);
  // c02：100 米金牌 9 + 接力银 14 + 板鞋银 7 + 400 米银 7 = 37（不含旧版 6 分）
  assert.equal(world.standings.find((row) => row.collegeId === 'c02').total, 37);
  // c01 少了 100 米金牌（9→7）但总榜第一不变
  assert.equal(world.standings.find((row) => row.collegeId === 'c01').total, 63);
});

test('删除一次：草稿届软删后列表不可见，记录仍在库', async () => {
  const { repo, world } = await demo;
  assert.equal(world.listVisible.length, 1);
  assert.equal(world.listVisible[0], world.meetId);
  assert.ok(!world.listVisible.includes(world.draftMeetId), '删掉的届不出现在列表');
  const deleted = await repo.sportsMeets.getById(world.draftMeetId);
  assert.equal(deleted.status, 'deleted', '软删除：记录保留，只是不再可见');
});

test('mock 装载：演示记录齐备，且全部归属民大', async () => {
  const records = await createMeetDemoRecords();
  for (const key of ['sportsMeets', 'sportsMeetEvents', 'sportsMeetEntries', 'sportsMeetSessions',
    'sportsMeetJudgeAssignments', 'sportsMeetScores', 'sportsMeetPublications', 'sportsMeetResultRows',
    // sportsMeetHonors 自第二十二轮起停写（「我的荣誉」直接读发布快照），
    // 演示数据里不再产生这张表。
    'sportsMeetStandings', 'sportsMeetColleges', 'sportsMeetCollegeLeads']) {
    assert.ok(Array.isArray(records[key]) && records[key].length > 0, `${key} 不能空`);
    for (const doc of records[key]) {
      assert.equal(doc.schoolId, 'muc', `${key} 混进了外校数据`);
    }
  }
  // 2026-10-20 扩容：三届（2025 / 2026 / 2027）各带一届被删的草稿
  const activeMeets = records.sportsMeets.filter(row => row.status !== 'deleted');
  assert.equal(activeMeets.length, 3, '三届正赛');
  assert.equal(records.sportsMeets.length, 6, '每届各有一届被删的草稿');
});

test('隔离：演示种子不碰协会赛事与 Elo', async () => {
  const { repo } = await demo;
  assert.equal((await repo.matches.list()).length, 0, '运动会不写 matches');
  assert.equal((await repo.events.list()).length, 0, '运动会不写协会赛事');
  assert.equal((await repo.memberRatings.list()).length, 0, '运动会不产评级（D93）');
});
