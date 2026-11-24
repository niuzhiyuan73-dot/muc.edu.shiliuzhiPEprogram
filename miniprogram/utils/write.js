/**
 * 写操作的统一错误约定
 * ============================================================
 * 【要解决什么】
 * 两个数据源对「基础设施故障」的表现不一样：
 *   mock  —— 从不抛错，业务失败包在 {ok:false, message} 里正常返回；
 *   cloud —— 顶层失败（未登录、账号停用、事务失败、云环境未就绪）会被
 *            school-cloud.js 的 requestFor 直接抛出（见该文件说明）。
 *
 * 页面代码写惯了「等一个 {ok:...} 回来」，切到云端后，一次基础设施故障
 * 会让 await 当场抛出：若页面没包 try/catch，提示不弹、submitting 不复位，
 * 提交按钮从此卡死，还会留下一串未处理的 Promise rejection。这类页面有
 * 二十来个、写接口三十个，逐个包 try/catch 必然漏，漏掉的那一页就是
 * 「点了没反应」。
 *
 * 【怎么做】
 * 学校维度（协议 2）的三个门面（school-cloud.js 的 forSchoolIdentity /
 * forAssociationSpace / forExchange）的 requestFor 对 SCHOOL_WRITE_ACTIONS
 * 里的动作套 guardWrite，把抛出的异常收敛成与 mock 同形的业务失败对象，
 * 页面只认一种形状：{ ok:false, errors:{}, scoreErrors:[], firstError, message }；
 * 成功则原样返回实现的结果。读接口不套——读失败本就该让页面自己去 catch，
 * 收敛成空数据反而会把故障伪装成「没有内容」。此前这三处没套，
 * 云端一次故障就让 11 个页面的提交按钮永久卡死。
 *
 * 【为什么写接口名单要显式列出来】
 * 无法从动作名机械判断谁写谁读。名单由 tests/school-write-guard.test.js
 * 双向校验，新增写接口时若忘了加进来，测试会点名，而不是某个页面在故障时卡死。
 * ============================================================
 */

const SCHOOL_WRITE_ACTIONS = [
  // 学校身份：注册 / 入会申请与审核 / 授权 / 改资料 / 转校三动作
  'registerSchoolAccount',
  'applySchoolMembership',
  'reviewSchoolMembership',
  'grantSchoolPermission',
  'updateSchoolProfile',
  'deactivateMySchoolAccount',
  'applySchoolTransfer',
  'reviewSchoolTransfer',
  'cancelSchoolTransfer',
  // 协会空间：分组增删改、通知、训练、赛事 / 比赛 / 实时比分 / 学院赛的写入
  'createAssociationGroup',
  'updateAssociationGroup',
  'addAssociationGroupMembers',
  'removeAssociationGroupMember',
  'leaveAssociationGroup',
  'archiveAssociationGroup',
  'deleteAssociationGroup',
  'publishAssociationNotice',
  'updateAssociationNotice',
  'withdrawAssociationNotice',
  'publishTraining',
  'updateTraining',
  'cancelTraining',
  'finishTraining',
  'registerTraining',
  'cancelTrainingRegistration',
  'removeTrainingRegistration',
  'requestTrainingCheckIn',
  'confirmTrainingCheckIn',
  'rejectTrainingCheckIn',
  'revokeTrainingCheckIn',
  'setSchoolEventPinned',
  'publishSchoolEvent',
  'signUpSchoolEvent',
  'cancelSchoolEventSignup',
  'startSchoolEvent',
  'drawSchoolEvent',
  'checkInSchoolEvent',
  'finishSchoolEvent',
  'submitSchoolMatch',
  'confirmSchoolMatch',
  'rejectSchoolMatch',
  'forfeitSchoolMatch',
  'assignSchoolMatchReferee',
  'startSchoolLiveScore',
  'recordSchoolRally',
  'undoSchoolRally',
  'finishSchoolLiveScore',
  'publishCollegeEvent',
  'setCollegeEventPinned',
  'submitCollegeEntry',
  'reviewCollegeEntry',
  'drawCollegeEvent',
  'startCollegeEvent',
  'submitCollegeLineup',
  'startCollegeTie',
  'assignCollegeTieReferee',
  'finishCollegeEvent',
  'forfeitCollegeTieLeg',
  'publishSchoolAnnouncement',
  'archiveSchoolAnnouncement',
  'resetSchoolSeason',
  // 团队运动（篮球/足球/排球）：建队 / 审核 / 入队申请与审批 / 退队 / 交接 / 归档
  'createTeamApplication',
  'reviewTeamApplication',
  'applyToJoinTeam',
  'reviewTeamMember',
  'leaveTeam',
  'transferTeamCaptain',
  'archiveTeam',
  // 学院代表队（石榴籽杯学院赛）：负责人挑人 / 移出（读动作 getCollegeTeam 也会补建院队，
  // 但它幂等且只写一条，仍是读入口；真正改名单的这两条按写动作走重试与失败提示）
  'addCollegeTeamMembers',
  'removeCollegeTeamMember',
  // 团队赛事：建赛 / 报名 / 审核 / 锁定
  'createTeamEvent',
  'submitTeamEntry',
  'reviewTeamEntry',
  'lockTeamEntries',
  // 团队赛事：抽签 / 录分 / 发布 / 下一轮 / 结算
  'drawTeamEvent',
  'recordTeamMatch',
  'startTeamLiveScore',
  'updateTeamLiveScore',
  'publishTeamMatch',
  'advanceTeamRound',
  'settleTeamEvent',
  // 团队赛事：个人统计（含已发布比赛统计新版本的审核）
  'saveTeamMatchStats',
  'reviewTeamMatchStats',
  // 团队赛事：单场赛程与整轮顺延
  'updateTeamMatchSchedule',
  'updateTeamRoundSchedule',
  // 团队赛事：单场出场名单（报名走 submitTeamEntry，已在上面）
  'saveTeamMatchLineup',
  // 跨校邀请赛：建赛 / 邀请应答 / 报名签到 / 抽签指派 / 录分与定名次
  'createExchangeEvent',
  'respondExchangeInvitation',
  'signUpExchangeEvent',
  'cancelExchangeSignup',
  'removeExchangeSignup',
  'checkInExchangeSignup',
  'withdrawExchangeInvitation',
  'cancelExchangeEvent',
  'lockExchangeRoster',
  'drawExchangeEvent',
  'assignExchangeReferee',
  'submitExchangeScore',
  'confirmExchangeRanking',
  // 运动会：草稿 / 项目配置 / 发布报名 / 删除 / 学院部长授权
  // （读动作 listSportsMeets、getSportsMeet、searchSportsEventTemplates 不在此列）
  'createSportsMeet',
  'updateMeetDraft',
  'removeMeetEvent',
  'setMeetEventProcedure',
  'configureMeetEvent',
  'publishMeetRegistration',
  'deleteSportsMeet',
  'grantMeetCollegeLead',
  'revokeMeetCollegeLead',
  // 运动会报名（B5）：意向、正式名单、审核、补报窗口
  'submitMeetInterest',
  'withdrawMeetInterest',
  'submitMeetCollegeEntry',
  'withdrawMeetCollegeEntry',
  'reviewMeetEntry',
  'openMeetLateWindow',
  // 运动会赛程与裁判（B6）
  'saveMeetSession',
  'publishMeetSchedule',
  'assignMeetJudge',
  'assignMeetJudges',
  'removeMeetJudge',
  'startMeetEvent',
  // 运动会录分与发布（B7）
  'saveMeetJudgeScore',
  'submitMeetJudgeScore',
  'publishMeetResults',
  'finishSportsMeet',
  // 运动会晋级与赛制（B8a）：抽签、推进、判定胜负都是写动作
  'drawMeetHeats',
  'advanceMeetEvent',
  'drawMeetBracket',
  'setMeetMatchWinner',
  // 重排与总裁判（M3）
  'resetMeetDraw',
  'appointMeetChiefJudge',
  'revokeMeetChiefJudge',
];

const SCHOOL_WRITE_ACTION_SET = new Set(SCHOOL_WRITE_ACTIONS);

/** 基础设施故障但异常没带 message 时的兜底提示 */
const FALLBACK_MESSAGE = '网络异常，请稍后重试';

/**
 * 该动作是否会改动数据（决定 requestFor 要不要套 guardWrite）。
 *
 * 【为什么写动作能靠「不以 get / list 开头」兜不住、必须列名单】
 * 学校维度的读动作一律以 get / list 起头（getSchoolMatch、listCollegeTies…），
 * 写动作没有一个是这两个前缀——这是这份名单能被 tests/school-write-guard.test.js
 * 双向校验的前提：门面里非读动作必须在名单里，名单里不许有读动作。将来若加了
 * 一个不符合这条约定的动作名，测试会立刻点名，而不是某个页面在故障时卡死。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isSchoolWriteAction(name) {
  return SCHOOL_WRITE_ACTION_SET.has(name);
}

/**
 * 把一次写操作的异常收敛成业务失败形状。
 *
 * @param {Function} run 发起写操作，返回 Promise
 * @returns {Promise<Object>} 成功时是实现的原始结果；抛错时是
 *          {ok:false, errors:{}, scoreErrors:[], firstError, message}
 */
async function guardWrite(run) {
  try {
    return await run();
  } catch (err) {
    const message = (err && err.message) || FALLBACK_MESSAGE;
    return { ok: false, errors: {}, scoreErrors: [], firstError: message, message };
  }
}

module.exports = {
  SCHOOL_WRITE_ACTIONS,
  FALLBACK_MESSAGE,
  isSchoolWriteAction,
  guardWrite,
};
