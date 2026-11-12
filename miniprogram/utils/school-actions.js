/**
 * 协议 2 的动作白名单
 * ============================================================
 * 【为什么要有这份清单】
 * 服务端注册处理器时曾经这样写：
 *
 *     const handlers = Object.fromEntries(
 *       Object.entries({ ...11 个 service }).filter(([, v]) => typeof v === 'function'));
 *
 * 于是**所有导出函数**都成了协议 2 的 action——包括 27 个内部辅助函数
 * （`buildDirectory` / `isEventDoc` / `medalOf` / `tallySignups` …），客户端
 * 从不声明它们。而 `school-request.js` 只做 `hasOwnProperty(handlers, action)`
 * 检查，所以任何拿到 OpenID 的客户端都能构造调用这些名字，攻击面被无谓放大
 * （2026-10-16 只读审计 H1）。
 *
 * 【清单从哪来】
 * 从**客户端三个门面**反推：`school-cloud.js` 的 `forSchoolIdentity` /
 * `forAssociationSpace` / `forExchange` 才是「客户端真正会发」的动作全集。
 * 服务端注册面必须与它**恰好相等**——不多（多了就是攻击面）、不少（少了
 * 客户端一调就报「该操作尚未支持学校范围」）。
 *
 * 【为什么住在 utils/、而不是云端与模拟端各写一份】
 * 本文件被 `tools/sync-cloud-lib.js` 镜像到 `cloudfunctions/data/lib/utils/`，
 * 因此**云端注册表与本地模拟注册表读的是同一份清单**，结构上不可能分叉。
 * 清单本身由 `tests/school-action-surface.test.js` 双向守护：
 * 谁改了客户端门面或服务实现却没同步这里，测试立刻红。
 * ============================================================
 */

/** 学校身份（`forSchoolIdentity` 声明，14 个）。 */
const SCHOOL_IDENTITY_ACTIONS = Object.freeze([
  'registerSchoolAccount',    'applySchoolMembership',    'reviewSchoolMembership',
  'getMySchoolMembership',    'getSchoolApplications',    'getSchoolDirectory',
  'getSchoolIdentitySession', 'getSchoolMembers',         'grantSchoolPermission',
  'updateSchoolProfile',      'applySchoolTransfer',      'reviewSchoolTransfer',
  'cancelSchoolTransfer',
  'getMySportsDashboard',
]);

/** 协会空间（`forAssociationSpace` 声明，119 个）。 */
const SCHOOL_SPACE_ACTIONS = Object.freeze([
  'listAssociationGroups',        'getAssociationGroup',          'createAssociationGroup',
  'updateAssociationGroup',       'addAssociationGroupMembers',   'removeAssociationGroupMember',
  'leaveAssociationGroup',        'archiveAssociationGroup',      'deleteAssociationGroup',
  'listAssociationMembers',       'listAssociationNotices',       'getAssociationNotice',
  'publishAssociationNotice',     'updateAssociationNotice',      'withdrawAssociationNotice',
  'listTrainings',                'getTraining',                  'listTrainingRegistrations',
  'publishTraining',              'updateTraining',               'cancelTraining',
  'finishTraining',               'registerTraining',             'cancelTrainingRegistration',
  'removeTrainingRegistration',   'requestTrainingCheckIn',       'confirmTrainingCheckIn',
  'rejectTrainingCheckIn',        'revokeTrainingCheckIn',        'listSchoolEvents',
  'setSchoolEventPinned',         'getSchoolEvent',               'listSchoolEventSignups',
  'publishSchoolEvent',           'signUpSchoolEvent',            'cancelSchoolEventSignup',
  'startSchoolEvent',             'drawSchoolEvent',              'checkInSchoolEvent',
  'finishSchoolEvent',            'listSchoolMatches',            'getSchoolMatchEntryContext',
  'getSchoolMatch',               'submitSchoolMatch',            'confirmSchoolMatch',
  'rejectSchoolMatch',            'forfeitSchoolMatch',
  'assignSchoolMatchReferee',     'startSchoolLiveScore',         'recordSchoolRally',
  'undoSchoolRally',              'finishSchoolLiveScore',        'getSchoolLiveScores',
  'listCollegeEvents',            'getCollegeEvent',              'publishCollegeEvent',
  'setCollegeEventPinned',        'listCollegeEntries',           'submitCollegeEntry',
  'reviewCollegeEntry',           'listCollegeTies',              'drawCollegeEvent',
  'startCollegeEvent',            'listCollegeLineups',           'submitCollegeLineup',
  'startCollegeTie',              'assignCollegeTieReferee',      'finishCollegeEvent',
  'forfeitCollegeTieLeg',         'listSchoolAnnouncements',      'publishSchoolAnnouncement',
  'archiveSchoolAnnouncement',    'listSchoolMembers',            'getSchoolMember',
  'getSchoolRanking',             'getSchoolMemberStats',         'getSchoolMemberHonors',
  'getSchoolMemberProfile',       'getSchoolSeason',              'resetSchoolSeason',
  // 团队运动（篮球/足球/排球）：球队与队员。与个人赛彻底分开，见 team-service.js
  'listTeams',                    'getTeam',                      'createTeamApplication',
  'reviewTeamApplication',        'applyToJoinTeam',              'reviewTeamMember',
  'leaveTeam',                    'transferTeamCaptain',          'archiveTeam',
  // 学院代表队（石榴籽杯学院赛）：系统按学院目录预置、负责人挑人、成员可自退
  'getCollegeTeam',               'addCollegeTeamMembers',        'removeCollegeTeamMember',
  // 团队赛事：建赛 / 报名 / 审核 / 锁定名单（C 期首片）
  'listTeamEvents',               'getTeamEvent',                 'createTeamEvent',
  'submitTeamEntry',              'reviewTeamEntry',              'lockTeamEntries',
  // 团队赛事：抽签 / 赛程 / 录分 / 发布 / 下一轮 / 结算
  'drawTeamEvent',                'listTeamMatches',              'recordTeamMatch',
  'publishTeamMatch',             'advanceTeamRound',             'settleTeamEvent',
  // 团队赛事：个人统计（基础 / 按节）与球员数据榜
  'getTeamMatchStats',            'saveTeamMatchStats',         'getTeamEventPlayerStats',
  // 团队赛事：已发布比赛的统计新版本单独审核（统计不能绕过发布审核直接生效）
  'reviewTeamMatchStats',
  // 团队赛事：单场赛程（时间 / 场地 / 裁判 / 记录员）与整轮顺延
  'getTeamMatchSchedule',         'updateTeamMatchSchedule',     'updateTeamRoundSchedule',
  // 团队赛事：报名选人（球衣号）与单场出场名单
  'getTeamEntryRoster',           'getTeamMatchLineup',          'saveTeamMatchLineup',
  // 团队赛事：个人团队档案（我的球队 / 参赛经历 / 荣誉 / 跨赛事累计）与球队战绩
  'getMyTeamProfile',             'getTeamRecord',
  'startTeamLiveScore',           'updateTeamLiveScore',         'getTeamLiveScores',
]);

/** 跨校邀请赛（`forExchange` 声明，16 个）。 */
const SCHOOL_EXCHANGE_ACTIONS = Object.freeze([
  'createExchangeEvent',        'respondExchangeInvitation',  'signUpExchangeEvent',
  'cancelExchangeSignup',       'removeExchangeSignup',       'checkInExchangeSignup',
  'withdrawExchangeInvitation', 'cancelExchangeEvent',
  'lockExchangeRoster',         'drawExchangeEvent',          'assignExchangeReferee',
  'submitExchangeScore',        'confirmExchangeRanking',     'getExchangeEvents',
  'getExchangeEvent',           'listExchangeRefereeCandidates',
]);

/**
 * 运动会（`forMeet` 声明）。前 9 个是 B3／B4 已实现的草稿与配置动作，
 * 后续批次在同一清单里追加报名、赛程、录分、发布。
 *
 * 注意：这一组请求**不带 association**（运动会是学校级栏目），
 * 由 school-request.js 走独立的 meet 分支，不要塞进协会空间那一组。
 */
const SCHOOL_MEET_ACTIONS = Object.freeze([
  // 草稿与配置（B4）
  'createSportsMeet',            'updateMeetDraft',            'listSportsMeets',
  'getSportsMeet',               'listSportsEventTemplates', 'configureMeetEvent',
  'publishMeetRegistration',     'deleteSportsMeet',            'removeMeetEvent',
  'listMeetColleges',            'setMeetEventProcedure',
  // 学院部长授权（B3）
  'grantMeetCollegeLead',        'revokeMeetCollegeLead',
  'listMeetCollegeLeads',        'getMyMeetCollegeLead',
  // 报名主链（B5）：学生意向 / 学院提交 / 校级审核 / 补报窗口
  'submitMeetInterest',          'withdrawMeetInterest',        'getMyMeetParticipation',
  'listMeetCollegeEvents',       'getMeetApplicantPool',
  'submitMeetCollegeEntry',          'withdrawMeetCollegeEntry',
  'reviewMeetEntry',             'openMeetLateWindow',          'listMeetEntries',
  // 赛程与裁判（B6）
  'saveMeetSession',             'publishMeetSchedule',
  'assignMeetJudge',             'removeMeetJudge',             'startMeetEvent',
  'getMeetSchedule',             'getMyMeetJudgeTasks',         'listMeetJudgeCandidates',
  // 批量指派与场次切换（B9c）
  'assignMeetJudges',            'listMeetEventSessions',
  // 录分与发布（B7）
  'getMeetSessionScores',        'saveMeetJudgeScore',          'submitMeetJudgeScore',
  'getMeetResultPreview',          'publishMeetResults',          'getPublishedResults',
  // 成绩公示与届次收口（试用反馈）：任何成员可读本届已发布成绩；管理员结束运动会
  'listMeetPublishedResults',      'finishSportsMeet',
  // 预赛晋级与赛制名次（B8a）
  'drawMeetHeats',               'advanceMeetEvent',
  // 学院总榜与个人荣誉（B8）
  'getMeetStandings',            'getMyMeetHonors',
  'drawMeetBracket',             'setMeetMatchWinner',          'getMeetBracket',
  // 重排与总裁判（M3）：抽错了能重抽，本届可指定一名总裁判
  'resetMeetDraw',               'appointMeetChiefJudge',       'revokeMeetChiefJudge',
]);

/**
 * 按白名单从若干 service 模块里挑出处理器。
 *
 * 【缺一个就当场抛，而不是静默少注册】
 * 少注册一个动作的后果是「线上调用才报『该操作尚未支持学校范围』」，
 * 那时离改动现场已经很远。这里在**加载期**就抛，测试与本地启动立刻可见。
 *
 * @param {Array<Object>} modules service 模块（后者覆盖前者的同名导出）
 * @param {ReadonlyArray<string>} names 白名单
 * @returns {Object} `{ [actionName]: handler }`
 */
function pickActions(modules, names) {
  const pool = Object.assign({}, ...modules);
  const actions = {};
  for (const name of names) {
    const handler = pool[name];
    if (typeof handler !== 'function') throw new Error(`协议 2 缺少动作实现：${name}`);
    actions[name] = handler;
  }
  return actions;
}

module.exports = {
  SCHOOL_IDENTITY_ACTIONS,
  SCHOOL_SPACE_ACTIONS,
  SCHOOL_EXCHANGE_ACTIONS,
  SCHOOL_MEET_ACTIONS,
  pickActions,
};
