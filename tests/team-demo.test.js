/**
 * 团队演示内容自检
 * ============================================================
 * 演示数据是给人看的，也是给页面测试当夹具的。三件事必须成立：
 *   1. 每场的个人得分合计**恰好**等于球队比分——否则一打开就满屏
 *      「差 N 分待归属」，看的人会以为是 bug；
 *   2. 名次与签表对得上：冠军是决赛胜者，季军是季军赛胜者；
 *   3. 球员榜的场次是「这个队打了几场已发布的比赛」，不是报名队数。
 * ============================================================
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTeamDemoContent } = require('../miniprogram/services/team-demo.js');
const { teamMemberKey } = require('../src/shared/utils/school.js');
const {
  TEAM_STATUS, TEAM_MEMBER_STATUS, TEAM_EVENT_STATUS, TEAM_ENTRY_STATUS, TEAM_MATCH_STATUS,
} = require('../src/shared/utils/constants.js');
const { computeTeamTable, computeTeamPlacements } = require('../src/shared/utils/team-standings.js');
const teamEvent = require('../src/server/services/team-event-service');

const content = createTeamDemoContent();
const finished = content.teamEvents.find(event => event.status === TEAM_EVENT_STATUS.FINISHED);
// 扩容后有 6 届赛事：本文件只守「院际篮球邀请赛」这一届的签表与统计口径
const finishedMatches = content.teamMatches.filter(match => match.eventId === finished._id);
const finishedStats = content.teamMatchStats.filter(doc => doc.eventId === finished._id);

test('演示内容 —— 四支球队各 5 人，队长写在球队文档上', () => {
  assert.equal(content.teams.length, 4);
  content.teams.forEach((team) => {
    assert.equal(team.status, TEAM_STATUS.ACTIVE);
    assert.ok(team.captainId, '每支队都要有队长');
    const rows = content.teamMembers.filter(row => row.teamId === team._id);
    assert.equal(rows.length, 5, '满 5 人即可比赛');
    assert.equal(rows.filter(row => row.role === 'captain').length, 1);
    assert.ok(rows.every(row => row.status === TEAM_MEMBER_STATUS.ACTIVE));
    const captain = rows.find(row => row.role === 'captain');
    assert.equal(captain.userId, team.captainId);
  });
});

test('演示内容 —— 一届打完的淘汰赛：四场全部已发布，名次四季齐全', () => {
  assert.equal(finished.name, '院际篮球邀请赛');
  assert.equal(finished.status, TEAM_EVENT_STATUS.FINISHED);
  assert.equal(finished.bronzeMode, 'playoff', '季军赛必须真的打了');
  assert.equal(finished.statPolicy, 'detailed', '演示数据要能展示按节统计');

  assert.equal(finishedMatches.length, 4);
  finishedMatches.forEach((match) => {
    assert.equal(match.status, TEAM_MATCH_STATUS.PUBLISHED);
    assert.ok(match.winner, '每场都要分出胜负');
    assert.notEqual(match.scoreA, match.scoreB, '淘汰赛不留平局');
  });

  assert.deepEqual(finished.placements.map(row => row.note), ['冠军', '亚军', '季军', '第四名']);
  // 冠军是决赛胜者，季军是季军赛胜者——不是算出来的
  const final = finishedMatches.find(m => m.stage === 'main' && m.round === 2);
  const bronze = finishedMatches.find(m => m.stage === 'bronze');
  assert.equal(finished.placements[0].teamId, final.winner === 'A' ? final.teamA : final.teamB);
  assert.equal(finished.placements[2].teamId, bronze.winner === 'A' ? bronze.teamA : bronze.teamB);
});

test('演示内容 —— 每场个人得分合计与球队比分分毫不差', () => {
  assert.equal(finishedStats.length, 8, '四场 × 两队');
  finishedStats.forEach((doc) => {
    assert.equal(doc.mode, 'detailed');
    assert.equal(doc.integrity, 'full', '演示数据要每个人都录了');
    const total = doc.rows.reduce((sum, row) => sum + row.points, 0);
    const match = content.teamMatches.find(item => item._id === doc.matchId);
    const score = doc.teamId === match.teamA ? match.scoreA : match.scoreB;
    assert.equal(total, score, `${doc.teamId} 的合计对不上，页面会弹出差额提醒`);
    // 每节一行：5 人 × 4 节
    assert.equal(doc.rows.length, 20);
  });
});

test('演示内容 —— 名次与积分表由同一批比赛算出来，且互相不矛盾', () => {
  const table = computeTeamTable({
    entries: content.teamEventEntries
      .filter(entry => entry.eventId === finished._id)
      .map(entry => ({ teamId: entry.teamId, teamName: entry.teamId })),
    matches: finishedMatches,
  });
  // 每支队都打两场：冠军两战全胜，第四名两战全败
  table.forEach((row) => assert.equal(row.played, 2, '四队单败 + 季军赛，每支队正好两场'));
  const heat = table.find(row => row.teamId === finished.placements[0].teamId);
  const rock = table.find(row => row.teamId === finished.placements[3].teamId);
  assert.equal(heat.wins, 2);
  assert.equal(heat.losses, 0);
  assert.equal(rock.wins, 0);

  const placements = computeTeamPlacements({
    draw: finished.draw, matches: finishedMatches, table,
  });
  assert.deepEqual(placements.map(row => row.teamId), finished.placements.map(row => row.teamId),
    '服务端算法与演示数据摆的名次必须一致，否则演示本身就是错的');
});

test('演示内容 —— 签表自洽：决赛两队都不打季军赛，季军两队都不进决赛', () => {
  // 只看「院际篮球邀请赛」这一届：扩容后又多了循环赛 / 进行中 / 待开赛等赛事，
  // 混在一起数场次会把别的赛事的对阵也算进来。
  const invitationId = content.teamEvents.find(event => event.name === '院际篮球邀请赛')._id;
  const invitationMatches = content.teamMatches.filter(match => match.eventId === invitationId);
  const final = invitationMatches.find(m => m.stage === 'main' && m.round === 2);
  const bronze = invitationMatches.find(m => m.stage === 'bronze');
  const finalSides = [final.teamA, final.teamB];
  const bronzeSides = [bronze.teamA, bronze.teamB];
  bronzeSides.forEach((teamId) => assert.ok(!finalSides.includes(teamId),
    '同时打决赛和季军赛的球队说明对阵摆错了'));
  // 每支队恰好两场
  const counts = new Map();
  invitationMatches.forEach((match) => {
    [match.teamA, match.teamB].forEach((teamId) => counts.set(teamId, (counts.get(teamId) || 0) + 1));
  });
  assert.deepEqual([...counts.values()], [2, 2, 2, 2]);
});

test('演示内容 —— 报名中的赛事：一队已通过、一队待审核', () => {
  const registration = content.teamEvents.find(event => event.status === TEAM_EVENT_STATUS.REGISTRATION);
  assert.ok(registration, '要有一届在报名中的赛事，否则审核与锁定没法演示');
  const rows = content.teamEventEntries.filter(entry => entry.eventId === registration._id);
  assert.equal(rows.filter(row => row.status === TEAM_ENTRY_STATUS.APPROVED).length, 1);
  assert.equal(rows.filter(row => row.status === TEAM_ENTRY_STATUS.SUBMITTED).length, 1);
  // 报名中的赛事还没有赛程与比分
  assert.equal(content.teamMatches.filter(m => m.eventId === registration._id).length, 0);
});

test('演示内容 —— 队长都有协会会籍，默认演示身份也在队里', () => {
  content.teams.forEach((team) => {
    const row = content.memberships.find(item => item.userId === team.captainId);
    assert.ok(row, `${team.captainId} 没有会籍，队长录不了分`);
    assert.equal(row.status, 'active');
  });
  // u06 是默认演示身份（defaultActorId），要能演示「队长视角」
  const flash = content.teams.find(team => team.name === '闪电队');
  assert.equal(flash.captainId, 'u06');
});

test('演示内容 —— 球队与队员的键和服务端同一套拼法', () => {
  const team = content.teams[0];
  const row = content.teamMembers.find(item => item.teamId === team._id && item.role === 'captain');
  assert.equal(row._id, teamMemberKey(team._id, row.userId));
});
