/**
 * 运动会处理器注册表（协议 2 · 学校级，不带协会）。
 *
 * 与身份 / 协会空间 / 跨校三面并列，由 school-request.js 的 **meet 分支**分发：
 * 运动会请求只带 schoolId（+ 可选 meetId），没有 association，所以不能走
 * handleSchoolRequest 里那段「必须指定学校和项目」的校验。
 *
 * 注册面同样是显式白名单（SCHOOL_MEET_ACTIONS），由
 * tests/school-action-surface.test.js 与客户端门面双向守护。
 */
const { SCHOOL_MEET_ACTIONS, pickActions } = require('../../lib/shared/utils/school-actions.js');
const meetService = require('../../lib/server/services/meet-service.js');
const leadService = require('../../lib/server/services/meet-college-lead-service.js');
const registrationService = require('../../lib/server/services/meet-registration-service.js');
const scheduleService = require('../../lib/server/services/meet-schedule-service.js');
const scoreService = require('../../lib/server/services/meet-score-service.js');
const advanceService = require('../../lib/server/services/meet-advance-service.js');
const standingService = require('../../lib/server/services/meet-standing-service.js');

module.exports = Object.freeze(
  pickActions([
    meetService, leadService, registrationService, scheduleService, scoreService,
    advanceService, standingService,
  ], SCHOOL_MEET_ACTIONS),
);
