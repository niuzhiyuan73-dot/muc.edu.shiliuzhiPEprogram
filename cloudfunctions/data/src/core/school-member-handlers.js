/**
 * 学校身份处理器注册表（协议 2）。
 *
 * 【注册面按白名单收口】
 * `createSchoolHandlers` 目前返回的恰好是 14 个动作，但那是「实现恰好像这样」，
 * 不是「注册面必须这样」。这里按 SCHOOL_IDENTITY_ACTIONS 白名单再挑一次，
 * 与协会空间 / 跨校两面同口径：身份实现将来多导出任何内部函数，都不会
 * 悄悄变成可被客户端调用的 action（见 2026-10-16 只读审计 H1）。
 */
const crypto = require('crypto');
const { SCHOOL_IDENTITY_ACTIONS, pickActions } = require('../../lib/utils/school-actions.js');
const { createSchoolHandlers } = require('../../lib/services/school-membership-service.js');
const personalSportsService = require('../../lib/services/personal-sports-service.js');

module.exports = Object.freeze(pickActions([createSchoolHandlers({
  claimKey: (schoolId, studentId) => `sid_${crypto.createHash('sha256').update(JSON.stringify([schoolId, studentId])).digest('hex')}`,
}), personalSportsService], SCHOOL_IDENTITY_ACTIONS));
