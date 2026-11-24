/**
 * 测试辅助：给某裁判在某场次造一条「已提交」的成绩。
 *
 * N4 裁决：只允许撤换**已提交成绩**的裁判（分母按原始指派算，撤掉没交分的裁判
 * 会让该场次永远凑不齐全员提交）。因此凡是测「撤销裁判」的用例，都必须先让
 * 该裁判有成绩，否则撤销会被拒绝。
 *
 * 直接写库而不是走 saveMeetJudgeScore：那些用例关心的不是录分链路，
 * 走完整录分会把每个测试都拖长。
 */

const { meetScoreKey } = require('../../src/shared/utils/meet-scope.js');

module.exports = async function markSubmitted(repo, options) {
  const {
    schoolId, meetId, eventKey, sessionKey, judgeId,
    entryKey = 'e_test', rawText = '12.30', scaled = 1230,
  } = options;
  await repo.sportsMeetScores.set(meetScoreKey(entryKey, sessionKey, judgeId), {
    schoolId,
    meetId,
    eventKey,
    entryKey,
    sessionKey,
    judgeId,
    state: 'submitted',
    rawText,
    scaled,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
};
