/** S2 身份接口客户端，明确范围，不改变旧业务门面的行为。 */
const { schoolScope } = require('../shared/utils/school.js');
const { meetRequestScope } = require('../shared/utils/meet-scope.js');
const { guardWrite, isSchoolWriteAction } = require('../utils/write.js');
const { pacer } = require('./request-pace.js');

/**
 * 绑定范围 + 协议 2 的请求器；身份 / 协会空间 / 跨校邀请赛三个门面共用一份。
 *
 * 【写动作要不要套 guardWrite 的差别】
 * 云端的基础设施故障（未登录 / 账号停用 / 事务失败 / 云环境未就绪）会让
 * callFunction 当场抛出。页面写惯了「等一个 {ok:...} 回来」，若这层没人接住
 * 抛出，一次故障就能让 submitting 永远停在 true、提交按钮从此点不动——这正是
 * 学校维度 11 个页面此前在真实环境下的表现。所以写动作套 guardWrite，把抛出
 * 收敛成与 mock 同形的 {ok:false,...}；读动作放行，读失败仍让页面自己 catch
 * （收敛成空数据会把故障伪装成「没有内容」）。口径与 utils/write.js 一致。
 *
 * 【读动作为什么先排队】（2026-10-23 第三轮审查 X-2）
 * 服务端按「每账号每秒 8 次读」限流，而首页一次要发约 15 个读请求——
 * 超出的部分被拒后，页面各自 catch 成「该协会没有内容」，首屏静默缺数据。
 * 这里按 6/秒排队（低于阈值、留并发余量），把「被拒」换成「晚一点到」。
 *
 * 【运动会门面为什么把业务拒绝重新抛成异常】（2026-10-28 第十轮只读审计 P1）
 * 服务端已统一：业务拒绝一律在 data 里（`{ok:false, message}`），顶层 ok:false
 * 只留给「请求本身处理不了」——两类失败在信封上分得开了。
 * 但客户端的 6 个运动会页面是按「读完要么拿到数据、要么进 catch」写的
 * （meet-detail / meet-schedule / meet-score / meet-setup / meet-standing /
 * meet-college 共 60 余处 catch，只有 meet-list 判过 `ok === false`）。
 * 若这里直接改成值返回，那些页面在「没权限 / 没指定学院 / 报名已截止」时会
 * 静默变成空数据、连提示都没有——退化比不统一更糟。所以运动会门面显式传
 * `throwOnRefused`：失败照旧抛出，页面一行不改，服务端契约仍然是对的。
 * 将来若要把四个门面在客户端也统一成值返回，先改那 6 个页面的失败分支。
 */
function requestFor(scope, options = {}) {
  const throwOnRefused = options.throwOnRefused === true;
  return (action, payload = {}) => {
    const isWrite = isSchoolWriteAction(action);
    const run = async () => {
      if (typeof wx === 'undefined' || !wx.cloud) throw new Error('云开发尚未初始化');
      // 写动作由用户逐个触发，远低于写阈值（3/秒），不排队以免「点下去没反应」
      if (!isWrite) await pacer.take();
      const res = await wx.cloud.callFunction({ name: 'data', data: {
        protocolVersion: 2, ...scope, action, payload,
      } });
      const result = res && res.result;
      if (!result || !result.ok) throw new Error(result && result.message || '学校接口请求失败');
      const data = result.data;
      if (throwOnRefused && data && data.ok === false) throw new Error(data.message || '操作失败');
      return data;
    };
    return isWrite && !throwOnRefused ? guardWrite(run) : run();
  };
}

function forSchoolIdentity(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    registerSchoolAccount: payload => request('registerSchoolAccount', payload),
    applySchoolMembership: payload => request('applySchoolMembership', payload),
    reviewSchoolMembership: payload => request('reviewSchoolMembership', payload),
    getMySchoolMembership: () => request('getMySchoolMembership'),
    getSchoolApplications: () => request('getSchoolApplications'),
    getSchoolDirectory: () => request('getSchoolDirectory'),
    getSchoolIdentitySession: () => request('getSchoolIdentitySession'),
    getMySportsDashboard: payload => request('getMySportsDashboard', payload),
    getSchoolHomeSummary: payload => request('getSchoolHomeSummary', payload),
    getSchoolMembers: payload => request('getSchoolMembers', payload),
    grantSchoolPermission: payload => request('grantSchoolPermission', payload),
    updateSchoolProfile: payload => request('updateSchoolProfile', payload),
    deactivateMySchoolAccount: payload => request('deactivateMySchoolAccount', payload),
    // 转校：申请 / 目标学校审批 / 申请人撤回（原学校无需同意）
    applySchoolTransfer: payload => request('applySchoolTransfer', payload),
    reviewSchoolTransfer: payload => request('reviewSchoolTransfer', payload),
    cancelSchoolTransfer: payload => request('cancelSchoolTransfer', payload),
  });
}

/** 协会空间客户端：分组与成员名录，动作名与云端 school-request 注册的一致。 */
function forAssociationSpace(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    listAssociationGroups: payload => request('listAssociationGroups', payload),
    getAssociationGroup: payload => request('getAssociationGroup', payload),
    createAssociationGroup: payload => request('createAssociationGroup', payload),
    updateAssociationGroup: payload => request('updateAssociationGroup', payload),
    addAssociationGroupMembers: payload => request('addAssociationGroupMembers', payload),
    removeAssociationGroupMember: payload => request('removeAssociationGroupMember', payload),
    leaveAssociationGroup: payload => request('leaveAssociationGroup', payload),
    archiveAssociationGroup: payload => request('archiveAssociationGroup', payload),
    deleteAssociationGroup: payload => request('deleteAssociationGroup', payload),
    listAssociationMembers: payload => request('listAssociationMembers', payload),
    listAssociationNotices: payload => request('listAssociationNotices', payload),
    getAssociationNotice: payload => request('getAssociationNotice', payload),
    publishAssociationNotice: payload => request('publishAssociationNotice', payload),
    updateAssociationNotice: payload => request('updateAssociationNotice', payload),
    withdrawAssociationNotice: payload => request('withdrawAssociationNotice', payload),
    listTrainings: payload => request('listTrainings', payload),
    getTraining: payload => request('getTraining', payload),
    listTrainingRegistrations: payload => request('listTrainingRegistrations', payload),
    publishTraining: payload => request('publishTraining', payload),
    updateTraining: payload => request('updateTraining', payload),
    cancelTraining: payload => request('cancelTraining', payload),
    finishTraining: payload => request('finishTraining', payload),
    registerTraining: payload => request('registerTraining', payload),
    cancelTrainingRegistration: payload => request('cancelTrainingRegistration', payload),
    removeTrainingRegistration: payload => request('removeTrainingRegistration', payload),
    requestTrainingCheckIn: payload => request('requestTrainingCheckIn', payload),
    confirmTrainingCheckIn: payload => request('confirmTrainingCheckIn', payload),
    rejectTrainingCheckIn: payload => request('rejectTrainingCheckIn', payload),
    revokeTrainingCheckIn: payload => request('revokeTrainingCheckIn', payload),
    listSchoolEvents: payload => request('listSchoolEvents', payload),
    setSchoolEventPinned: payload => request('setSchoolEventPinned', payload),
    getSchoolEvent: payload => request('getSchoolEvent', payload),
    // 报名名单：之前漏在门外。`school-event-view.js` 的 loadEventParts（赛事详情页
    // 与名次录入页共用）会调它，云数据源下曾经直接 `api.listSchoolEventSignups is
    // not a function`。服务端一直注册着这个动作（school-event-service.js 有导出），
    // mock 门面也有——只有这一份清单漏写。
    listSchoolEventSignups: payload => request('listSchoolEventSignups', payload),
    publishSchoolEvent: payload => request('publishSchoolEvent', payload),
    signUpSchoolEvent: payload => request('signUpSchoolEvent', payload),
    cancelSchoolEventSignup: payload => request('cancelSchoolEventSignup', payload),
    startSchoolEvent: payload => request('startSchoolEvent', payload),
    drawSchoolEvent: payload => request('drawSchoolEvent', payload),
    checkInSchoolEvent: payload => request('checkInSchoolEvent', payload),
    finishSchoolEvent: payload => request('finishSchoolEvent', payload),
    listSchoolMatches: payload => request('listSchoolMatches', payload),
    getSchoolMatchEntryContext: payload => request('getSchoolMatchEntryContext', payload),
    getSchoolMatch: payload => request('getSchoolMatch', payload),
    submitSchoolMatch: payload => request('submitSchoolMatch', payload),
    confirmSchoolMatch: payload => request('confirmSchoolMatch', payload),
    rejectSchoolMatch: payload => request('rejectSchoolMatch', payload),
    forfeitSchoolMatch: payload => request('forfeitSchoolMatch', payload),
    assignSchoolMatchReferee: payload => request('assignSchoolMatchReferee', payload),
    startSchoolLiveScore: payload => request('startSchoolLiveScore', payload),
    recordSchoolRally: payload => request('recordSchoolRally', payload),
    undoSchoolRally: payload => request('undoSchoolRally', payload),
    finishSchoolLiveScore: payload => request('finishSchoolLiveScore', payload),
    getSchoolLiveScores: payload => request('getSchoolLiveScores', payload),
    listCollegeEvents: payload => request('listCollegeEvents', payload),
    getCollegeEvent: payload => request('getCollegeEvent', payload),
    publishCollegeEvent: payload => request('publishCollegeEvent', payload),
    setCollegeEventPinned: payload => request('setCollegeEventPinned', payload),
    listCollegeEntries: payload => request('listCollegeEntries', payload),
    submitCollegeEntry: payload => request('submitCollegeEntry', payload),
    reviewCollegeEntry: payload => request('reviewCollegeEntry', payload),
    listCollegeTies: payload => request('listCollegeTies', payload),
    drawCollegeEvent: payload => request('drawCollegeEvent', payload),
    startCollegeEvent: payload => request('startCollegeEvent', payload),
    listCollegeLineups: payload => request('listCollegeLineups', payload),
    submitCollegeLineup: payload => request('submitCollegeLineup', payload),
    startCollegeTie: payload => request('startCollegeTie', payload),
    assignCollegeTieReferee: payload => request('assignCollegeTieReferee', payload),
    finishCollegeEvent: payload => request('finishCollegeEvent', payload),
    forfeitCollegeTieLeg: payload => request('forfeitCollegeTieLeg', payload),
    listSchoolAnnouncements: payload => request('listSchoolAnnouncements', payload),
    publishSchoolAnnouncement: payload => request('publishSchoolAnnouncement', payload),
    archiveSchoolAnnouncement: payload => request('archiveSchoolAnnouncement', payload),
    listSchoolMembers: payload => request('listSchoolMembers', payload),
    getSchoolMember: payload => request('getSchoolMember', payload),
    getSchoolRanking: payload => request('getSchoolRanking', payload),
    getSchoolMemberStats: payload => request('getSchoolMemberStats', payload),
    getSchoolMemberHonors: payload => request('getSchoolMemberHonors', payload),
    getSchoolMemberProfile: payload => request('getSchoolMemberProfile', payload),
    getSchoolSeason: payload => request('getSchoolSeason', payload),
    resetSchoolSeason: payload => request('resetSchoolSeason', payload),
    // 管理员评级调整（带审计与幂等键，不伪装成比赛）
    adjustMemberRating: payload => request('adjustMemberRating', payload),
    // 团队运动（篮球/足球/排球）：球队与队员。与个人赛录分完全分开。
    listTeams: payload => request('listTeams', payload),
    getTeam: payload => request('getTeam', payload),
    createTeamApplication: payload => request('createTeamApplication', payload),
    reviewTeamApplication: payload => request('reviewTeamApplication', payload),
    applyToJoinTeam: payload => request('applyToJoinTeam', payload),
    reviewTeamMember: payload => request('reviewTeamMember', payload),
    leaveTeam: payload => request('leaveTeam', payload),
    transferTeamCaptain: payload => request('transferTeamCaptain', payload),
    archiveTeam: payload => request('archiveTeam', payload),
    // 学院代表队（石榴籽杯学院赛）：系统预置、负责人挑人
    getCollegeTeam: payload => request('getCollegeTeam', payload),
    addCollegeTeamMembers: payload => request('addCollegeTeamMembers', payload),
    removeCollegeTeamMember: payload => request('removeCollegeTeamMember', payload),
    // 团队赛事（C 期首片）：建赛、报名、审核、锁定名单
    listTeamEvents: payload => request('listTeamEvents', payload),
    getTeamEvent: payload => request('getTeamEvent', payload),
    createTeamEvent: payload => request('createTeamEvent', payload),
    submitTeamEntry: payload => request('submitTeamEntry', payload),
    reviewTeamEntry: payload => request('reviewTeamEntry', payload),
    lockTeamEntries: payload => request('lockTeamEntries', payload),
    // 团队赛事：抽签、赛程、录分、发布、下一轮、结算
    drawTeamEvent: payload => request('drawTeamEvent', payload),
    listTeamMatches: payload => request('listTeamMatches', payload),
    recordTeamMatch: payload => request('recordTeamMatch', payload),
    startTeamLiveScore: payload => request('startTeamLiveScore', payload),
    updateTeamLiveScore: payload => request('updateTeamLiveScore', payload),
    getTeamLiveScores: payload => request('getTeamLiveScores', payload),
    publishTeamMatch: payload => request('publishTeamMatch', payload),
    advanceTeamRound: payload => request('advanceTeamRound', payload),
    settleTeamEvent: payload => request('settleTeamEvent', payload),
    // 团队赛事：个人统计
    getTeamMatchStats: payload => request('getTeamMatchStats', payload),
    saveTeamMatchStats: payload => request('saveTeamMatchStats', payload),
    reviewTeamMatchStats: payload => request('reviewTeamMatchStats', payload),
    getTeamEventPlayerStats: payload => request('getTeamEventPlayerStats', payload),
    // 团队赛事：单场赛程与整轮顺延
    getTeamMatchSchedule: payload => request('getTeamMatchSchedule', payload),
    updateTeamMatchSchedule: payload => request('updateTeamMatchSchedule', payload),
    updateTeamRoundSchedule: payload => request('updateTeamRoundSchedule', payload),
    // 团队赛事：报名选人与单场出场名单
    getTeamEntryRoster: payload => request('getTeamEntryRoster', payload),
    getTeamMatchLineup: payload => request('getTeamMatchLineup', payload),
    saveTeamMatchLineup: payload => request('saveTeamMatchLineup', payload),
    // 团队赛事：个人团队档案与球队战绩
    getMyTeamProfile: payload => request('getMyTeamProfile', payload),
    getTeamRecord: payload => request('getTeamRecord', payload),
  });
}

/**
 * 跨校邀请赛客户端（协议 2）。
 * 动作名与服务端 school-exchange-handlers 注册的一致；范围仍取调用者的
 * 学校 + 协会，跨校能力由服务端按「赛事邀请了哪些学校」判定，不由客户端声明。
 */
function forExchange(input) {
  const request = requestFor(schoolScope(input));
  return Object.freeze({
    createExchangeEvent: payload => request('createExchangeEvent', payload),
    respondExchangeInvitation: payload => request('respondExchangeInvitation', payload),
    signUpExchangeEvent: payload => request('signUpExchangeEvent', payload),
    cancelExchangeSignup: payload => request('cancelExchangeSignup', payload),
    removeExchangeSignup: payload => request('removeExchangeSignup', payload),
    checkInExchangeSignup: payload => request('checkInExchangeSignup', payload),
    withdrawExchangeInvitation: payload => request('withdrawExchangeInvitation', payload),
    cancelExchangeEvent: payload => request('cancelExchangeEvent', payload),
    lockExchangeRoster: payload => request('lockExchangeRoster', payload),
    drawExchangeEvent: payload => request('drawExchangeEvent', payload),
    assignExchangeReferee: payload => request('assignExchangeReferee', payload),
    submitExchangeScore: payload => request('submitExchangeScore', payload),
    confirmExchangeRanking: payload => request('confirmExchangeRanking', payload),
    getExchangeEvents: payload => request('getExchangeEvents', payload),
    getExchangeEvent: payload => request('getExchangeEvent', payload),
    listExchangeRefereeCandidates: payload => request('listExchangeRefereeCandidates', payload),
  });
}

/**
 * 运动会客户端：**不带 association**。
 *
 * 请求体只拼 schoolId（+ 可选 meetId），与协议 2 的其余三面故意不同——
 * 运动会是学校级栏目，若为了复用门面而塞一个协会参数，服务端就会把它当成
 * 「该协会的运动会」，协会停用会连带停用运动会。
 *
 * meetId 可选：列清单、搜项目模板、发起运动会都没有「届」。
 */
function forMeet(input) {
  const request = requestFor(meetRequestScope(input), { throwOnRefused: true });
  return Object.freeze({
    // 草稿与配置（B4）
    createSportsMeet: payload => request('createSportsMeet', payload),
    updateMeetDraft: payload => request('updateMeetDraft', payload),
    configureMeetEvent: payload => request('configureMeetEvent', payload),
    publishMeetRegistration: payload => request('publishMeetRegistration', payload),
    deleteSportsMeet: payload => request('deleteSportsMeet', payload),
    removeMeetEvent: payload => request('removeMeetEvent', payload),
    setMeetEventProcedure: payload => request('setMeetEventProcedure', payload),
    listMeetColleges: payload => request('listMeetColleges', payload),
    listSportsMeets: payload => request('listSportsMeets', payload),
    getSportsMeet: payload => request('getSportsMeet', payload),
    listSportsEventTemplates: payload => request('listSportsEventTemplates', payload),
    // 学院部长授权（B3）
    grantMeetCollegeLead: payload => request('grantMeetCollegeLead', payload),
    revokeMeetCollegeLead: payload => request('revokeMeetCollegeLead', payload),
    listMeetCollegeLeads: payload => request('listMeetCollegeLeads', payload),
    getMyMeetCollegeLead: payload => request('getMyMeetCollegeLead', payload),
    // 报名主链（B5）
    submitMeetInterest: payload => request('submitMeetInterest', payload),
    withdrawMeetInterest: payload => request('withdrawMeetInterest', payload),
    getMyMeetParticipation: payload => request('getMyMeetParticipation', payload),
    listMeetCollegeEvents: payload => request('listMeetCollegeEvents', payload),
    getMeetApplicantPool: payload => request('getMeetApplicantPool', payload),
    submitMeetCollegeEntry: payload => request('submitMeetCollegeEntry', payload),
    withdrawMeetCollegeEntry: payload => request('withdrawMeetCollegeEntry', payload),
    reviewMeetEntry: payload => request('reviewMeetEntry', payload),
    openMeetLateWindow: payload => request('openMeetLateWindow', payload),
    listMeetEntries: payload => request('listMeetEntries', payload),
    // 赛程与裁判（B6）
    saveMeetSession: payload => request('saveMeetSession', payload),
    publishMeetSchedule: payload => request('publishMeetSchedule', payload),
    assignMeetJudge: payload => request('assignMeetJudge', payload),
    removeMeetJudge: payload => request('removeMeetJudge', payload),
    startMeetEvent: payload => request('startMeetEvent', payload),
    getMeetSchedule: payload => request('getMeetSchedule', payload),
    getMyMeetJudgeTasks: payload => request('getMyMeetJudgeTasks', payload),
    listMeetJudgeCandidates: payload => request('listMeetJudgeCandidates', payload),
    // 批量指派与场次切换（B9c）
    assignMeetJudges: payload => request('assignMeetJudges', payload),
    listMeetEventSessions: payload => request('listMeetEventSessions', payload),
    // 录分与发布（B7）
    getMeetSessionScores: payload => request('getMeetSessionScores', payload),
    saveMeetJudgeScore: payload => request('saveMeetJudgeScore', payload),
    submitMeetJudgeScore: payload => request('submitMeetJudgeScore', payload),
    getMeetResultPreview: payload => request('getMeetResultPreview', payload),
    publishMeetResults: payload => request('publishMeetResults', payload),
    getPublishedResults: payload => request('getPublishedResults', payload),
    listMeetPublishedResults: payload => request('listMeetPublishedResults', payload),
    finishSportsMeet: payload => request('finishSportsMeet', payload),
    // 预赛晋级与赛制名次（B8a）
    drawMeetHeats: payload => request('drawMeetHeats', payload),
    advanceMeetEvent: payload => request('advanceMeetEvent', payload),
    drawMeetBracket: payload => request('drawMeetBracket', payload),
    resetMeetDraw: payload => request('resetMeetDraw', payload),
    appointMeetChiefJudge: payload => request('appointMeetChiefJudge', payload),
    revokeMeetChiefJudge: payload => request('revokeMeetChiefJudge', payload),
    setMeetMatchWinner: payload => request('setMeetMatchWinner', payload),
    getMeetBracket: payload => request('getMeetBracket', payload),
    // 学院总榜与个人荣誉（B8）
    getMeetStandings: payload => request('getMeetStandings', payload),
    getMyMeetHonors: payload => request('getMyMeetHonors', payload),
  });
}

module.exports = { forSchoolIdentity, forAssociationSpace, forExchange, forMeet };
