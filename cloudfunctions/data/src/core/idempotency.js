/**
 * 幂等键
 * ============================================================
 * 【要防的是什么】
 * 弱网下用户连点两下「提交」，或者请求超时后客户端自动重试，都可能让同一
 * 场比赛被录入两次。等级分是零和的，重复一场比赛会让比赛双方各多算一次
 * 分，而且看不出哪里错了。发公告同理。
 *
 * 【为什么用哈希而不是查询去重】
 * 微信云开发的事务里，集合查询受限，而按 _id 读写稳定可靠。于是把
 * 「这位会员在这个时间用这个比分打了这场比赛」压成一个自然键，直接当成
 * 文档 _id：第二次提交会撞上同一个 _id，事务里读到已存在就知道是重试。
 * 不需要查询，不需要唯一索引，也不需要额外的去重表。
 *
 * 【键里为什么包含录入人】
 * 不同的人确实可能在不同场次报出完全相同的四人组合与比分——那是两场
 * 真实比赛。用录入人把这种巧合区分开，避免误判成重复。
 * ============================================================
 */

const crypto = require('crypto');
const { schoolAccountKey } = require('../../lib/shared/utils/school.js');

/**
 * 把若干字段拼成定长十六进制摘要。
 * @param {Array<*>} parts
 * @returns {string} 32 位十六进制
 */
function digest(parts) {
  return crypto
    .createHash('md5')
    .update(parts.map((part) => String(part === null || part === undefined ? '' : part)).join('|'))
    .digest('hex');
}

/**
 * 把协会并进摘要输入。
 *
 * 【为什么并进摘要、而不是给主键加前缀】
 * 给主键加 `{assoc}_` 前缀会让代码里长出「某些协会带前缀、某些不带」的分支，
 * 还要把旧数据的 _id 全部重排。并进摘要输入则前缀一律不变，跨协会同名内容
 * 因摘要不同而永不碰撞，旧文档的 _id 也原样保留。
 *
 * 【为什么缺字段时不并入】
 * 改造前的旧文档没有 association。对它们保持旧算法（摘要输入不变），_id 就
 * 与历史一致；写过之后带上 association 的文档，摘要多一段、自然是新键。
 *
 * @param {Array<*>} parts
 * @param {string} [association]
 * @returns {Array<*>}
 */
function withAssociation(parts, association) {
  return association ? [...parts, association] : parts;
}

/**
 * 比赛的自然键。
 * 队伍成员先排序，避免「A 队里两人顺序不同」被误判成两场不同的比赛。
 *
 * @param {Object} record buildMatchRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function matchNaturalKey(record) {
  return `m_${digest(
    withAssociation(
      [
        record.pool,
        [...record.teamA].sort().join(','),
        [...record.teamB].sort().join(','),
        record.scoreA.join(','),
        record.scoreB.join(','),
        new Date(record.matchTime).toISOString(),
        record.recorder || '',
      ],
      record.association
    )
  )}`;
}

/**
 * 公告的自然键。
 * @param {Object} record buildAnnouncementRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function announcementNaturalKey(record) {
  return `a_${digest(
    withAssociation([record.publisherId || '', record.title, record.content], record.association)
  )}`;
}

/**
 * 会员记录的主键：一个 OpenID 只对应一个账号。
 * 用它当 _id，重复提交入会申请就会落到同一条文档上。
 *
 * 【为什么与协议 2 用的是同一把键】
 * 从前这里是 `u_ + md5(openId)`，而协议 2 开户走 `utils/school.js` 的
 * `schoolAccountKey(openId)` = `acc:<openId>`。同一微信身份若既走过旧注册、
 * 又走协议 2 注册，就会留下两条账号文档，此后「解析到哪条」不确定，表现为
 * 「注册过却进不去」「榜单里没有我」（2026-10-16 只读审计 H5 / P1）。
 *
 * 产品已定「旧协议完全下线」，那 `u_` 键就没有存在理由；这里直接复用协议 2
 * 的键生成，两套协议从此落到**同一条账号文档**上。趁线上还没有真实数据统一，
 * 成本接近零；等跑出真实数据再改就得附迁移脚本。
 *
 * @param {string} openId
 * @returns {string} 可直接用作 _id
 */
function memberKey(openId) {
  return schoolAccountKey(openId);
}

/**
 * 赛事的自然键：同一位发布者在同一时刻发的同名赛事只该有一条。
 * 弱网重试最容易在这里出问题——线上市集里出现两条一模一样的赛事，
 * 报名的会员会不知道该点哪一个。
 *
 * @param {Object} record buildEventRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function eventNaturalKey(record) {
  return `e_${digest(
    withAssociation(
      [record.publisherId || '', record.title, new Date(record.startTime).toISOString()],
      record.association
    )
  )}`;
}

/**
 * 协会角色行的主键：「某人在某协会」压成一个 _id。
 *
 * 一人可负责多个协会，因此键里必须同时有 userId 与 association——只按人
 * 取键会让「这个人换了协会任职」覆盖掉上一处。
 *
 * @param {string} userId
 * @param {string} association
 * @returns {string} 可直接用作 _id
 */
function membershipKey(userId, association) {
  return `mb_${digest([userId, association])}`;
}

/**
 * 报名记录的自然键：「这位会员报了这场赛事」压成一个 _id。
 *
 * 同一人同一赛事只该有一条报名记录。取消不删记录、只改状态，于是重新报名
 * 会落回同一条文档（见 event.buildSignupRecord）——这样「报了多少人、退了
 * 多少人」有据可查，也不会因为连点两下报名而长出两条。
 *
 * @param {string} eventId
 * @param {string} userId
 * @returns {string} 可直接用作 _id
 */
function signupNaturalKey(eventId, userId) {
  return `s_${digest([eventId, userId])}`;
}

/**
 * 学院赛的自然键：同一位发布者在同一时刻发的同名学院赛只该有一条。
 * 与 eventNaturalKey 同一思路——弱网重试不该在列表里留下两场一样的赛事。
 *
 * @param {Object} record buildCollegeEventRecord 产出的记录
 * @returns {string} 可直接用作 _id
 */
function collegeEventNaturalKey(record) {
  return `ce_${digest(
    withAssociation(
      [record.publisherId || '', record.title, new Date(record.startTime).toISOString()],
      record.association
    )
  )}`;
}

/**
 * 学院名单的自然键：「这场学院赛里这个学院」压成一个 _id。
 *
 * 同一赛事同一学院只该有一份有效名单（D10）。名单可以改后重交，重交会落回
 * 同一条文档，于是不需要先删后插，也不会长出两份互相矛盾的名单。
 *
 * @param {string} eventId
 * @param {string} college
 * @returns {string} 可直接用作 _id
 */
function collegeEntryNaturalKey(eventId, college) {
  return `cn_${digest([eventId, college])}`;
}

/**
 * 大场排阵的自然键：「这个大场里这个学院」压成一个 _id。
 *
 * 同一大场同一学院只该有一份有效排阵；学院负责人改后重交（含换替补，D30）会落回
 * 同一条文档，于是不需要先删后插，也不会留下两份互相矛盾的排阵。学院名带
 * 中文，用摘要压成定长十六进制，避免主键里出现非 ASCII 字符。
 *
 * @param {string} tieId
 * @param {string} college
 * @returns {string} 可直接用作 _id
 */
function collegeLineupNaturalKey(tieId, college) {
  return `ln_${digest([tieId, college])}`;
}

module.exports = {
  digest,
  matchNaturalKey,
  memberKey,
};
