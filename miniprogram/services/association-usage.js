/**
 * 「这个人在哪个协会打得最多」
 * ============================================================
 * 多协会版本的默认协会规则（需求整理 §11.1）：每次进小程序，中间三个界面
 * 默认取「该用户比赛最多的协会」；并列按注册表顺序取第一个；一场都没打过
 * 就回落默认协会。
 *
 * 【为什么单列一个模块】这条规则要被两处用：app.js 启动定全局协会、
 * 个人详情页定本页默认。三处各写一份迟早分叉。
 *
 * 【数据源为什么是 S2 的 getSchoolMemberStats】协议 1 已完全下线（P10），
 * 比赛台账只存在于学校维度的协会空间里。getSchoolMemberStats 回放本协会
 * 空间流水，ratings 里各池的 matchCount 就是「本协会打过多少场」的全程
 * 计数（与榜单同一把尺子）；逐个启用协会取一次、按池累加即可，不必把整条
 * 比赛流水拉出来。页面主数据同样来自 association-space.forScope——规则
 * 与展示同源，不会出现「默认协会按一套数据算、页面展示另一套数据」。
 *
 * 【权限差异，记录在案】getSchoolMemberStats 受 canReadAssociationSpace
 * 闸门约束（本学校有效会员或平台管理员才能读；同一学校的有效会员可读本校
 * 全部协会空间，因为该闸门是学校级而非协会级）。旧栈 getMyProjects 无闸门：
 * 读取者与被统计者不同校（或读取者无有效身份）时，旧栈能算出对方的默认协会、
 * 新实现读不到，按 0 场处理并回落默认协会。已记入
 * docs/隐患与未定产品决策-2026-10-16.md §三 P10，不擅自放宽闸门。
 *
 * 【读取失败为什么按 0 处理】这条规则只决定「进入时落在哪个协会」，不是
 * 业务动作（app.js 的 syncAssociationForUser 本来就整段吞错回落）；单协会
 * 读取失败按 0 计，其余协会照常参与比较，规则仍然能给出一个确定结果。
 * ============================================================
 */

const { defaultAssociationId, activeAssociations } = require('../shared/utils/associations.js');
const { LEGACY_SCHOOL_ID } = require('../shared/utils/school.js');

/**
 * 各启用协会里，这个人的比赛场次（单打 + 双打，按池累加）。
 *
 * @param {string} userId
 * @returns {Promise<Array<{id: string, matchCount: number}>>} 与启用协会同序
 */
async function matchCountsByAssociation(userId) {
  if (!userId) return [];
  // 延迟取用：避开 app.js / member-view → association-usage → 服务层的加载期环
  // （两个调用方都是函数体内 require 本模块，本模块再回头 require 也得延迟）。
  const schoolSession = require('./school-session.js');
  const space = require('./association-space.js');
  const schoolId = schoolSession.getSchoolId() || LEGACY_SCHOOL_ID;

  return Promise.all(activeAssociations().map(async (assoc) => {
    try {
      const client = space.forScope({ schoolId, association: assoc.id });
      const result = await client.getSchoolMemberStats({ userIds: [userId], ratingsOnly: true });
      const row = result && result.ok !== false && Array.isArray(result.members)
        ? result.members.find(member => member.userId === userId)
        : null;
      const matchCount = row
        ? Object.values(row.ratings || {}).reduce(
          (sum, rating) => sum + (Number(rating && rating.matchCount) || 0), 0)
        : 0;
      return { id: assoc.id, matchCount };
    } catch (err) {
      console.warn(`[association-usage] 读取 ${assoc.id} 的场次失败，按 0 处理`, err);
      return { id: assoc.id, matchCount: 0 };
    }
  }));
}

/**
 * 「比赛最多的协会」。并列取注册表在前的；一场都没打过（或没登录）回落默认协会。
 *
 * @param {string} [userId]
 * @returns {Promise<string>} 协会 id
 */
async function mostPlayedAssociation(userId) {
  if (!userId) return defaultAssociationId();

  const counts = await matchCountsByAssociation(userId);
  let best = null;
  for (const item of counts) {
    // 严格大于：并列时保留先出现的（即注册表在前的那个）
    if (!best || item.matchCount > best.matchCount) best = item;
  }
  if (!best || best.matchCount <= 0) return defaultAssociationId();
  return best.id;
}

module.exports = {
  matchCountsByAssociation,
  mostPlayedAssociation,
};
