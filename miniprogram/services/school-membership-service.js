const ok = data => ({ ok: true, data });
const { buildSchoolContext } = require('./school-context.js');
const { loadColleges } = require('./college-directory.js');
const {
  canSchoolAction, canReadSchool, canGrantPermission, grantablePermissions,
  isPlatformAdminCtx, permissionOf, permissionLabelOf, PERMISSION, PERMISSION_LABEL,
} = require('./school-permission.js');
const { buildSchoolApplication, buildSchoolAccount } = require('./school-member.js');
const { buildProfilePatch } = require('./profile.js');
const { accountDirectoryFields } = require('./account-directory.js');
const { allAssociations } = require('../utils/associations.js');
const { detachUserFromTeams } = require('./team-service.js');
const { syncRatingProfileInTransaction } = require('./school-rating-service.js');
const {
  schoolMemberKey, schoolRoleKey, schoolMembershipKey, collegeKey,
  PLATFORM_ROLE, PLATFORM_STATUS, SCHOOL_MEMBER_STATUS, SCHOOL_ROLE,
} = require('../utils/school.js');

/** 可授予的三档权限，顺序从高到低；界面选项与校验共用这一份。 */
const GRANT_PERMISSIONS = Object.freeze([PERMISSION.SCHOOL_ADMIN, PERMISSION.ASSOCIATION_LEADER, PERMISSION.COLLEGE_LEADER]);
const grantOptions = ctx => grantablePermissions(ctx).map(permission => ({
  permission, label: PERMISSION_LABEL[permission],
}));

/** 名册一页的默认条数与上限（下发给客户端的 DTO 数量，直接决定回包体积）。 */
const ROSTER_PAGE = 50;
const ROSTER_PAGE_MAX = 200;
/**
 * 待审申请的单次上限。
 *
 * 【为什么是软上限而不是分页】审核页是「逐条处理」的工作台，处理完一条就整页
 * 重载，天然不会翻到第 N 页；真正要防的是「一次把几千条待审读进回包」。
 * 200 条远超一次开学的积压量，超出时回 `hasMore` 让页面提示先处理本批。
 */
const APPLICATIONS_PAGE_MAX = 200;

function createSchoolHandlers({ claimKey }) {
  const refused = (message) => ({ ok: false, account: null, message });
  const freshContext = (tx, ctx) => buildSchoolContext({ repo: tx, actorId: ctx.actorId,
    scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
  // 只下发展示字段，不下发 openId 等账号隐私。
  const publicAccountOf = user => ({ userId: user._id, nickName: user.nickName || '',
    realName: user.realName || '', gender: user.gender || '' });

  /**
   * 开通平台账号（协议 2，M3-d）。
   *
   * 【这一步补的是什么】
   * 其余身份接口都要求账号已存在且 `platformStatus` 明确（见 S2 身份审核记录
   * 「下一步 1. 新账号创建」），但此前没有任何接口为新微信用户开户。这里补上
   * 旧栈 `registerMember` 的学校维度对应物：凭 OpenID 落一条平台账号，之后
   * 才能走 `applySchoolMembership` 登记学号 / 学院。
   *
   * 【平台账号与学校身份分开（迁移清单 §7）】
   * 真名 / 性别留在账号上（跨学校不变）；学号 / 学院归学校身份，由
   * `applySchoolMembership` 另行登记。因此这里**不碰** payload 里的
   * studentId / college / role / points——它们不是账号字段，进不了落库记录。
   * 校验复用旧栈 `auth.PROFILE_RULES`（真名 / 性别两条，同一把尺子）。
   *
   * 【幂等与不改写实名】
   * 编号由 OpenID 派生（`schoolAccountKey`），同一微信身份恒一条。已有账号
   * （旧账号 / 演示身份 / 重复注册）一律原样返回，绝不用新表单覆盖既有实名——
   * 实名是审核依据，只认首次登记。
   *
   * @param {Object} payload { profile: {realName, gender, nickName?, avatarUrl?} }
   * @param {Object} ctx
   * @returns {Promise<Object>} {ok, account, errors, firstError}
   */
  async function registerSchoolAccount(payload = {}, ctx) {
    // 已解析出账号（旧账号 / 演示身份）：原样返回，不改写实名。
    if (ctx.actor) return ok({ ok: true, account: publicAccountOf(ctx.actor), message: '' });
    const built = buildSchoolAccount({ openId: ctx.openId, profile: payload.profile, now: ctx.now });
    if (!built.ok) {
      return ok({ ok: false, account: null, errors: built.errors, firstError: built.firstError });
    }
    const account = await ctx.repo.transaction(async tx => {
      // 事务内复核：并发注册同一 OpenID 只落一条
      const existing = await tx.users.getById(built.account._id);
      if (existing) return publicAccountOf(existing);
      await tx.users.set(built.account._id, built.account);
      await tx.audit.append({ _id: `reg_${built.account._id}`, action: 'registerSchoolAccount',
        schoolId: ctx.schoolId, actorId: built.account._id, userId: built.account._id, at: ctx.now });
      return publicAccountOf(built.account);
    });
    return ok({ ok: true, account, errors: {}, firstError: '' });
  }

  async function applySchoolMembership(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!fresh.actor || fresh.actor.platformStatus !== 'active') return refused('账号不可用');
      if (fresh.actor.primarySchoolId && fresh.actor.primarySchoolId !== fresh.schoolId) {
        return refused('已有其他学校身份，请改用「转校申请」（由转入学校审批）');
      }
      const previous = fresh.schoolMember;
      if (previous && ['active', 'left', 'disabled'].includes(previous.status)) return refused('当前学校身份不能重新申请，请联系管理员');
      const college = typeof payload.collegeId === 'string' && payload.collegeId
        ? await tx.colleges.getById(collegeKey(fresh.schoolId, payload.collegeId)) : null;
      let application;
      try {
        application = buildSchoolApplication({ userId: fresh.actorId, school: fresh.school,
          college, studentId: payload.studentId, now: fresh.now });
      } catch (err) { return refused(err.message); }
      if (previous && previous.status === 'pending' && previous.collegeId === application.collegeId && previous.studentId === application.studentId) {
        return { ok: true, account: previous, message: '' };
      }
      application.revision = Number(previous && previous.revision || 0) + 1;
      await tx.schoolMembers.set(application._id, application);
      await tx.audit.append({ _id: `apply_${application._id}_${application.revision}`, action: 'applySchoolMembership', schoolId: fresh.schoolId,
        actorId: fresh.actorId, userId: fresh.actorId, revision: application.revision, at: fresh.now });
      return { ok: true, account: application, message: '' };
    });
    return ok(result);
  }

  async function reviewSchoolMembership(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    if (!canSchoolAction(ctx, 'reviewMembers', ctx)) return ok(refused('没有本校审核权限'));
    if (!['approve', 'reject'].includes(payload.decision)) return ok(refused('审核决定无效'));
    if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少申请人'));
    if (!Number.isInteger(payload.revision) || payload.revision < 1) return ok(refused('请刷新申请版本后重试'));
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (payload.decision === 'reject' && !reason) return ok(refused('驳回必须填写理由'));
    if (reason.length > 500) return ok(refused('审核理由过长'));
    // 兼容尚未生成学号占用文档的 S1 种子/存量身份。新审批统一写 claim，
    // 因而读取后的并发审批仍由事务中的共享 claim 文档阻止重复占用。
    //
    // 【为什么只查「这个学号」】（2026-10-26 第四轮审查 P-7）
    // 原先 `schoolMembers.list()` 把整校名册读回来再 some()：5000 人的学校
    // 每次审批 = 50 页 RPC，而且这次读**不提供任何额外保护**——并发判重的真正
    // 防线是事务内的 studentIdClaims（同一学号写同一 _id，冲突即重试）。
    // 现在先点读申请单取学号，再按字段窄查（索引 schoolId + studentId）。
    const reviewTargetId = payload.decision === 'approve'
      ? schoolMemberKey(payload.userId, ctx.schoolId) : '';
    const reviewTarget = reviewTargetId
      ? await ctx.repo.forScope(ctx).schoolMembers.getById(reviewTargetId) : null;
    const priorMembers = reviewTarget && reviewTarget.studentId
      ? await ctx.repo.forScope(ctx).schoolMembers.listByStudentId(reviewTarget.studentId) : [];
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!canSchoolAction(fresh, 'reviewMembers', fresh)) return refused('没有本校审核权限');
      if (payload.userId === fresh.actorId) return refused('不能审核自己的申请');
      const id = schoolMemberKey(payload.userId, fresh.schoolId);
      const application = await tx.schoolMembers.getById(id);
      if (!application || application.userId !== payload.userId || application.schoolId !== fresh.schoolId || application.status !== 'pending') return refused('申请不存在或已处理');
      if (application.revision !== payload.revision) return refused('申请已修改，请刷新后重新审核');
      const user = await tx.users.getById(payload.userId);
      if (!user || user.platformStatus !== 'active') return refused('申请人账号不可用');
      const approved = payload.decision === 'approve';
      if (approved) {
        if (user.primarySchoolId && user.primarySchoolId !== fresh.schoolId) return refused('申请人已有其他学校身份');
        if (priorMembers.some(row => row.userId !== user._id && row.studentId === application.studentId &&
            ['active', 'left', 'disabled'].includes(row.status))) return refused('该学号已被其他账号使用');
        const college = await tx.colleges.getById(collegeKey(fresh.schoolId, application.collegeId));
        if (!college || college.schoolId !== fresh.schoolId || college.status !== 'active') return refused('申请学院已失效');
        const claimId = claimKey(fresh.schoolId, application.studentId);
        const claim = await tx.studentIdClaims.getById(claimId);
        if (claim && (claim.userId !== user._id || claim.schoolId !== fresh.schoolId)) return refused('该学号已被其他账号使用');
        await tx.studentIdClaims.set(claimId, { schoolId: fresh.schoolId, userId: user._id, claimedAt: fresh.now });
        // 共享用户文档使不同学校同时审批同一用户时产生事务写冲突。
        await tx.users.set(user._id, { ...user, primarySchoolId: fresh.schoolId,
          schoolIdentityVersion: Number(user.schoolIdentityVersion || 0) + 1 });
      }
      const next = { ...application, status: approved ? 'active' : 'rejected', reviewedBy: fresh.actorId,
        reviewedAt: fresh.now, reviewReason: reason, revision: application.revision + 1 };
      await tx.schoolMembers.set(id, next);
      // 入会通过：评级表里的 gender / memberStatus 是物化副本（方案 A），
      // 重入校的人可能还留着上一次的评级文档（status 停在 transferred/left），
      // 这里一并恢复为 active，否则榜单仍会把他排除在外。
      // 新会员通常一条评级都没有，24 次点读全是 missing——低频路径，可接受。
      if (approved) {
        await syncRatingProfileInTransaction(tx, {
          userId: user._id, schoolId: fresh.schoolId,
          gender: user.gender, memberStatus: SCHOOL_MEMBER_STATUS.ACTIVE, now: fresh.now,
        });
      }
      await tx.audit.append({ _id: `review_${id}_${next.revision}`, action: 'reviewSchoolMembership', schoolId: fresh.schoolId,
        actorId: fresh.actorId, userId: user._id, decision: payload.decision, reason,
        revision: next.revision, at: fresh.now });
      return { ok: true, account: next, message: '' };
    });
    return ok(result);
  }

  async function getMySchoolMembership(_payload, ctx) {
    if (!ctx.actor || ctx.actor.platformStatus !== 'active') return ok(refused('请使用有效账号登录'));
    return ok({ ok: true, account: ctx.schoolMember, message: '' });
  }

  /* ============================================================
   * 转校（2026-10-16 用户口径）
   * ============================================================
   * 【谁说了算】只需**转入学校**的校级管理员同意，原学校不需要任何同意。
   * 于是申请的落点就是「目标学校的一条待审身份申请」（带 `transferFrom` 标记），
   * 由目标学校的管理员用 `reviewSchoolTransfer` 审批；原学校那一侧只在通过时写
   * 一条转出备案审计——不用它点头，但名录与角色的变化要看得见。
   *
   * 【为什么复用 schoolMembers 而不新开集合】
   * 待审申请本来就是一条 pending 的学校身份行；转校与首次入会的差别，只在
   * 「申请人原本属于另一所学校」以及通过时要做的搬运。复用同一张表，目标校
   * 管理员的待办列表、revision 版本校验与并发保护全都沿用既有的一套。
   *
   * 【历史归属不搬】
   * 比赛、赛事、积分与积分事实仍留在原学校范围（它们记的是「当时那所学校那个
   * 协会发生的事」）。通过时只做三件事：原学校身份转出、原学校校级角色与协会
   * 身份停用、账号的 primarySchoolId 指向新学校。新学校从普通会员起步，权限
   * 需要重新指定。
   */

  /**
   * 发起转校申请：把「我想转到本校」写成目标学校的一条待审身份申请。
   *
   * @param {Object} payload { collegeId, studentId }
   * @param {Object} ctx 当前浏览的学校即**目标学校**
   * @returns {Promise<Object>} {ok, account, message}
   */
  async function applySchoolTransfer(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!fresh.actor || fresh.actor.platformStatus !== PLATFORM_STATUS.ACTIVE) return refused('账号不可用');
      const fromSchoolId = fresh.actor.primarySchoolId || '';
      if (!fromSchoolId) return refused('当前没有学校身份，请直接申请加入本校');
      if (fromSchoolId === fresh.schoolId) return refused('你已经是本校成员，无需转校');
      const previous = fresh.schoolMember;
      if (previous && previous.status === SCHOOL_MEMBER_STATUS.ACTIVE) return refused('你已是本校有效会员，无需转校');
      if (previous && previous.status === SCHOOL_MEMBER_STATUS.PENDING && !previous.transferFrom) {
        return refused('你已有本校入会申请待审核');
      }
      const college = typeof payload.collegeId === 'string' && payload.collegeId
        ? await tx.colleges.getById(collegeKey(fresh.schoolId, payload.collegeId)) : null;
      let application;
      try {
        application = buildSchoolApplication({ userId: fresh.actorId, school: fresh.school,
          college, studentId: payload.studentId, now: fresh.now });
      } catch (err) { return refused(err.message); }
      application.transferFrom = fromSchoolId;
      // 申请时的身份版本：审批时用它判「这份申请是不是已经过期」。
      // 每次归属变更（入会通过、转校通过）都会把账号的 schoolIdentityVersion +1，
      // 所以版本对不上就说明申请人已经在校际之间移动过，这份申请不再可信。
      application.identityVersion = Number(fresh.actor.schoolIdentityVersion || 0);
      // 幂等：同一目标学校、同一学院学号的待审转校申请重复提交返回同一条。
      // 但「申请时的身份版本」要刷成本次的值，否则身份变过之后这份申请会永远审不过
      // （审批按旧版本判陈旧），形成「重提也没用」的死结。
      if (previous && previous.status === SCHOOL_MEMBER_STATUS.PENDING && previous.transferFrom &&
          previous.collegeId === application.collegeId && previous.studentId === application.studentId) {
        if (Number(previous.identityVersion) === application.identityVersion) {
          return { ok: true, account: previous, message: '' };
        }
        const refreshed = { ...previous, identityVersion: application.identityVersion,
          revision: Number(previous.revision || 0) + 1 };
        await tx.schoolMembers.set(refreshed._id, refreshed);
        return { ok: true, account: refreshed, message: '' };
      }
      application.revision = Number((previous && previous.revision) || 0) + 1;
      await tx.schoolMembers.set(application._id, application);
      await tx.audit.append({ _id: `transfer_apply_${application._id}_${application.revision}`,
        action: 'applySchoolTransfer', schoolId: fresh.schoolId, actorId: fresh.actorId,
        userId: fresh.actorId, fromSchoolId, revision: application.revision, at: fresh.now });
      return { ok: true, account: application, message: '' };
    });
    return ok(result);
  }

  /**
   * 审批转校申请。**必须由转入学校的审核人（校级管理员）操作**——
   * 原学校的管理员在这里没有角色：ctx.schoolId 就是目标学校。
   *
   * 通过时按顺序做完整搬运：目标校学号占用与学院复核 → 原校身份转出 →
   * 原校校级角色与协会身份停用 → 账号归属切到新学校 → 两侧各写一条审计。
   * 驳回只改申请状态，申请人仍留在原学校。
   *
   * @param {Object} payload { userId, decision: 'approve'|'reject', reason, revision }
   * @param {Object} ctx
   */
  async function reviewSchoolTransfer(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    if (!canSchoolAction(ctx, 'reviewMembers', ctx)) return ok(refused('没有本校审核权限'));
    if (!['approve', 'reject'].includes(payload.decision)) return ok(refused('审核决定无效'));
    if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少申请人'));
    if (!Number.isInteger(payload.revision) || payload.revision < 1) return ok(refused('请刷新申请版本后重试'));
    const reason = typeof payload.reason === 'string' ? payload.reason.trim() : '';
    if (payload.decision === 'reject' && !reason) return ok(refused('驳回必须填写理由'));
    if (reason.length > 500) return ok(refused('审核理由过长'));
    const priorMembers = payload.decision === 'approve'
      ? await ctx.repo.forScope(ctx).schoolMembers.list() : [];

    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!canSchoolAction(fresh, 'reviewMembers', fresh)) return refused('没有本校审核权限');
      if (payload.userId === fresh.actorId) return refused('不能审核自己的申请');
      const id = schoolMemberKey(payload.userId, fresh.schoolId);
      const application = await tx.schoolMembers.getById(id);
      if (!application || application.userId !== payload.userId ||
          application.schoolId !== fresh.schoolId ||
          application.status !== SCHOOL_MEMBER_STATUS.PENDING || !application.transferFrom) {
        return refused('转校申请不存在或已处理');
      }
      if (application.revision !== payload.revision) return refused('申请已修改，请刷新后重新审核');
      const user = await tx.users.getById(payload.userId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE) return refused('申请人账号不可用');
      const approved = payload.decision === 'approve';
      let moved = null;

      if (approved) {
        const fromSchoolId = application.transferFrom;
        if (fromSchoolId === fresh.schoolId) return refused('申请人已经属于本校');
        // 【陈旧申请必须挡住】（2026-10-26 只读审查 P2-4）
        // 审批只信申请里记的 transferFrom，不看本人现在归属哪所学校。
        // 于是同时开出 A→B、A→C 两份申请后依次获批，会把**两份**有效会籍同时留下：
        // B 侧那条从不会被清理，账号却指向 C，后续想再转回 B 还会被「已是本校会员」挡下。
        // 这里要求「当前主学校 = 申请来源」，并比对申请时记下的身份版本。
        if (user.primarySchoolId !== fromSchoolId) {
          // 作废它，而不是让它一直挂在待办里、每次点开都报错。
          const voided = { ...application, status: SCHOOL_MEMBER_STATUS.REJECTED,
            reviewedBy: fresh.actorId, reviewedAt: fresh.now,
            reviewReason: '申请人所属学校已变化，本申请已作废，请重新提交',
            revision: Number(application.revision || 0) + 1 };
          await tx.schoolMembers.set(id, voided);
          await tx.audit.append({ _id: `transfer_stale_${id}_${voided.revision}`,
            action: 'voidStaleSchoolTransfer', schoolId: fresh.schoolId, actorId: fresh.actorId,
            userId: user._id, fromSchoolId, currentSchoolId: user.primarySchoolId || '',
            revision: voided.revision, at: fresh.now });
          return refused('申请人所属学校已变化，该申请已作废，请让申请人重新提交');
        }
        if (Number.isInteger(application.identityVersion) &&
            Number(user.schoolIdentityVersion || 0) !== application.identityVersion) {
          return refused('申请人的学校身份已变化，请让申请人重新提交转校申请');
        }
        // 目标学校这一侧：学号占用与学院复核，与首次入会同一把尺子
        if (priorMembers.some(row => row.userId !== user._id && row.studentId === application.studentId &&
            [SCHOOL_MEMBER_STATUS.ACTIVE, SCHOOL_MEMBER_STATUS.LEFT, SCHOOL_MEMBER_STATUS.DISABLED].includes(row.status))) {
          return refused('该学号已被其他账号使用');
        }
        const college = await tx.colleges.getById(collegeKey(fresh.schoolId, application.collegeId));
        if (!college || college.status !== 'active' || college.schoolId !== fresh.schoolId) return refused('申请学院已失效');
        const claimId = claimKey(fresh.schoolId, application.studentId);
        const claim = await tx.studentIdClaims.getById(claimId);
        if (claim && (claim.userId !== user._id || claim.schoolId !== fresh.schoolId)) return refused('该学号已被其他账号使用');
        await tx.studentIdClaims.set(claimId, { schoolId: fresh.schoolId, userId: user._id, claimedAt: fresh.now });

        // 原学校这一侧：身份转出 + 角色 / 协会身份停用（历史记录与积分事实不动）
        const fromMemberKey = schoolMemberKey(user._id, fromSchoolId);
        const fromMember = await tx.schoolMembers.getById(fromMemberKey);
        let fromRevision = 1;
        if (fromMember) {
          fromRevision = Number(fromMember.revision || 1) + 1;
          await tx.schoolMembers.set(fromMemberKey, { ...fromMember,
            status: SCHOOL_MEMBER_STATUS.TRANSFERRED,
            transferredTo: fresh.schoolId, transferredAt: fresh.now, revision: fromRevision });
        }
        const fromRoleKey = schoolRoleKey(user._id, fromSchoolId);
        const fromRole = await tx.schoolRoles.getById(fromRoleKey);
        if (fromRole && fromRole.status === 'active') {
          await tx.schoolRoles.set(fromRoleKey, { ...fromRole, status: 'disabled',
            updatedBy: fresh.actorId, updatedAt: fresh.now });
        }
        const revokedAssociations = [];
        for (const sport of allAssociations()) {
          const key = schoolMembershipKey(user._id, { schoolId: fromSchoolId, association: sport.id });
          const row = await tx.memberships.get(key);
          if (!row || row.status !== 'active') continue;
          await tx.memberships.set(key, { ...row, status: 'revoked',
            updatedBy: fresh.actorId, updatedAt: fresh.now });
          revokedAssociations.push(sport.id);
        }
        await tx.users.set(user._id, { ...user, primarySchoolId: fresh.schoolId,
          schoolIdentityVersion: Number(user.schoolIdentityVersion || 0) + 1 });
        // 评级副本跟着转出：本人在原校各协会的评级文档要标成 transferred，
        // 否则原校榜单仍把转走的人算进排名（榜单按 memberStatus 过滤，方案 A）。
        //
        // 目标学校那一侧**不扫**：转校进来的人在新校还没有评级文档（惰性建档），
        // 扫一遍要多 24 次读，而转校事务本身已约 31 个操作、满配时加原校这一侧
        // 就到 79，再翻一倍就撞 100 的预算了。真有残留（转出后又转回），由回填
        // 脚本按 school_members 的权威值纠正。
        await syncRatingProfileInTransaction(tx, {
          userId: user._id, schoolId: fromSchoolId,
          gender: user.gender, memberStatus: SCHOOL_MEMBER_STATUS.TRANSFERRED, now: fresh.now,
        });
        // 原学校备案：不需要它同意，但「谁在什么时候转走、停了哪些身份」要留痕
        await tx.audit.append({ _id: `transfer_out_${fromMemberKey}_${fromRevision}`,
          action: 'transferSchoolOut', schoolId: fromSchoolId, actorId: fresh.actorId,
          userId: user._id, toSchoolId: fresh.schoolId,
          revokedAssociations, at: fresh.now });
        moved = { fromSchoolId, revokedAssociations };
      }

      const next = { ...application,
        status: approved ? SCHOOL_MEMBER_STATUS.ACTIVE : SCHOOL_MEMBER_STATUS.REJECTED,
        reviewedBy: fresh.actorId, reviewedAt: fresh.now, reviewReason: reason,
        revision: application.revision + 1 };
      if (approved) {
        // 转校来的人留一个「从哪来」的印记，便于日后排查；不再是待审状态
        delete next.transferFrom;
        next.transferredFrom = application.transferFrom;
      }
      await tx.schoolMembers.set(id, next);
      await tx.audit.append({ _id: `review_transfer_${id}_${next.revision}`,
        action: 'reviewSchoolTransfer', schoolId: fresh.schoolId, actorId: fresh.actorId,
        userId: user._id, decision: payload.decision, reason,
        fromSchoolId: application.transferFrom, revision: next.revision, at: fresh.now });
      return { ok: true, account: next, moved, message: '' };
    });

    // 转校成功之后把他从原学校的球队里摘掉。
    // 放在事务外：球队清理是多协会循环 + 整表读，塞进上面那个事务会把
    // 一次转校变成「先锁一堆表」；而它失败也不该把已经通过的转校回滚——
    // 转校是主事实，球队残留可以再清一次。
    if (result && result.ok && result.moved) {
      try {
        result.teams = await detachUserFromTeams(ctx.repo, {
          schoolId: result.moved.fromSchoolId,
          userId: payload.userId,
          now: ctx.now,
          actorId: ctx.actorId,
        });
      } catch (err) {
        console.error('[reviewSchoolTransfer] 球队清理失败', err);
        result.teams = { detached: 0, captainMoved: 0, archived: 0, error: true };
      }
    }
    return ok(result);
  }

  /** 申请人撤回自己的待审转校申请（只能撤自己的，撤回后仍留在原学校）。 */
  async function cancelSchoolTransfer(_payload, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      const id = schoolMemberKey(fresh.actorId, fresh.schoolId);
      const application = await tx.schoolMembers.getById(id);
      if (!application || application.status !== SCHOOL_MEMBER_STATUS.PENDING || !application.transferFrom) {
        return refused('没有待处理的本校转校申请');
      }
      const next = { ...application, status: SCHOOL_MEMBER_STATUS.REJECTED,
        reviewReason: '申请人撤回', reviewedBy: fresh.actorId, reviewedAt: fresh.now,
        revision: application.revision + 1 };
      await tx.schoolMembers.set(id, next);
      await tx.audit.append({ _id: `cancel_transfer_${id}_${next.revision}`,
        action: 'cancelSchoolTransfer', schoolId: fresh.schoolId, actorId: fresh.actorId,
        userId: fresh.actorId, revision: next.revision, at: fresh.now });
      return { ok: true, account: next, message: '' };
    });
    return ok(result);
  }

  /**
   * 本校待审核入会申请台账。**只返回待审核记录**——通过的人已是正式会员
   * （进 `getSchoolMembers` 名单），驳回的人留在学校身份记录里但不再出现在
   * 这份待办台账里（学校维度没有「已驳回」列表，与旧栈的已处理标签不同，
   * 见迁移清单 M3-b）。
   *
   * 【下发的字段】
   * 除编号与状态外，带上审核时要核对的展示信息：昵称、实名、性别、学院名
   * （与旧栈 `member-review.buildApplicationRow` 同口径，供审核页直接渲染）。
   * 手机号不在下发之列——学校维度统一不收手机号（与名录同一隐私口径）。
   *
   * @param {Object} _payload
   * @param {Object} ctx
   */
  async function getSchoolApplications(_payload, ctx) {
    if (!canSchoolAction(ctx, 'reviewMembers', ctx)) return ok({ ok: false, applications: [], hasMore: false, message: '没有本校审核权限' });
    // 账号按「待审申请人」的编号批量取。原先是 users.list()（全平台账号整表读），
    // 审核页一次就把别校账号也读回来了（2026-10-21 审查 P0-1）。
    // 转出校名称只对「转校申请」存在，按去重后的 id 逐个取——不走 schools.list()，
    // 免得给本读路径新增对 where({}) 空条件的依赖（该兼容性未实测，见审计 §二）。
    const colleges = await loadColleges(ctx);
    // 学院名走 Map（原先 find 在循环里，2026-10-21 审查 P2-7）。
    const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
    const collegeName = id => collegeNameById.get(id) || '';
    // 只取 pending：原来是把整校名册读回来再 filter，5000 人的学校 = 50 页 RPC
    // 只为了几条待审（2026-10-26 第四轮审查 P-3）。
    const pendingPage = await ctx.repo.forScope(ctx).schoolMembers
      .listByStatus(SCHOOL_MEMBER_STATUS.PENDING, { limit: APPLICATIONS_PAGE_MAX });
    const pending = pendingPage.rows;
    const userById = new Map(
      (await ctx.repo.users.listByIds(pending.map(row => row.userId))).map(user => [user._id, user]),
    );
    const transferIds = [...new Set(pending.filter(row => row.transferFrom).map(row => row.transferFrom))];
    const schoolById = new Map(await Promise.all(transferIds.map(async id => [id, await ctx.repo.schools.getById(id)])));
    const applications = pending.map(row => {
      const user = userById.get(row.userId);
      // 转校申请在同一条待审台账里，但要标出来「从哪转来」：
      // 审核页据此走 reviewSchoolTransfer，而不是普通入会审批（两条口径不同）。
      const fromSchool = row.transferFrom ? schoolById.get(row.transferFrom) : null;
      return { userId: row.userId, schoolId: row.schoolId,
        collegeId: row.collegeId, collegeName: collegeName(row.collegeId),
        studentId: row.studentId, revision: row.revision, appliedAt: row.appliedAt,
        transfer: Boolean(row.transferFrom),
        transferFrom: row.transferFrom || '',
        transferFromName: fromSchool ? fromSchool.name || row.transferFrom : '',
        nickName: user && user.nickName || '申请人',
        realName: user && user.realName || '',
        gender: user && user.gender || '',
        avatarUrl: user && user.avatarUrl || '' };
    });
    // hasMore=true 表示待审超过一页上限：审核页提示「先处理当前批次」，
    // 而不是悄悄只显示一部分（软上限，见 APPLICATIONS_PAGE_MAX）。
    return ok({ ok: true, applications, hasMore: Boolean(pendingPage.hasMore), message: '' });
  }

  async function getSchoolDirectory(_payload, ctx) {
    const schools = (await ctx.repo.schools.list()).filter(row => row.status === 'active').map(row => ({
      schoolId: row.schoolId, name: row.name, shortName: row.shortName,
    }));
    const colleges = (await loadColleges(ctx)).filter(row => row.status === 'active').map(row => ({
      collegeId: row.collegeId, name: row.name,
    }));
    return ok({ ok: true, schools, colleges, message: '' });
  }

  /**
   * 当前身份在本范围下的会话。除「能不能审 / 能不能管协会 / 能不能管本校 / 能授哪些权限」外，
   * 还下发**操作者本人的权限档位**（`permission` / `permissionLabel`）与
   * **能不能管自己的学院**（`canManageCollege`）。
   *
   * 【为什么要下发本人的权限档位】
   * 学院赛名单页要判断「本人能不能替本学院提交名单」，旧栈口径是
   * `managesCollege(actor, actorCollege)`。会话原先只给 `canReview` /
   * `canManageAssociation` / `grants`——普通学院负责人（membership role='staff'）
   * 这三项分别是 false / false / []，与普通会员在会话里**无从分辨**，页面自己
   * 也推不出来。这里把权限档位与派生的 `canManageCollege` 一并下发，让
   * 判定回到 `canSchoolAction(ctx, 'manageCollege', ...)` 这一把尺子，页面照着用。
   *
   * 【为什么还要 canManageSchool】
   * 公告发布/下架的门槛是「平台管理员 + 本校校级管理员」。公告页原先自己拿
   * `isPlatformAdmin` 判，校级管理员被挡在门外；补一个与 `manageSchool` 同源的
   * 布尔量，页面不再自己拼权限（也顺带覆盖了将来校务设置等同类入口）。
   *
   * 【只读不下发权限】
   * 浏览外校时 `account` 为 null、权限档位留空、`canManageCollege` /
   * `canManageSchool` 为假——「看得到外校名单」不能被当成「管得了外校」。
   *
   * @param {Object} _payload
   * @param {Object} ctx
   */
  async function getSchoolIdentitySession(_payload, ctx) {
    const active = ctx.actor && ctx.actor.platformStatus === 'active';
    // 浏览的是不是外校：本校身份只在 primarySchoolId 上，当前范围与它不一致即只读。
    const readOnly = Boolean(active && ctx.actor.primarySchoolId && ctx.actor.primarySchoolId !== ctx.schoolId);
    const manageable = active && !readOnly;
    const collegeId = (ctx.schoolMember && ctx.schoolMember.collegeId) || '';
    // user 是**本人账号**的展示字段：真名 / 性别 / 头像随账号走（跨校不变），
    // platformStatus 让客户端分清「没有账号 / 账号停用」两种情形（B3：登录页
    // 不能把停用账号当新用户引导去注册）。
    return ok({ ok: true, user: ctx.actor ? {
      userId: ctx.actorId,
      nickName: ctx.actor.nickName || '',
      realName: ctx.actor.realName || '',
      gender: ctx.actor.gender || '',
      avatarUrl: ctx.actor.avatarUrl || '',
      primarySchoolId: ctx.actor.primarySchoolId || '',
      platformStatus: ctx.actor.platformStatus || '',
    } : null,
      account: active ? ctx.schoolMember : null,
      // 本人权限档位：校级 / 协会 / 学院，普通会员为空串（展示标签退回「会员」）。
      permission: manageable ? permissionOf(ctx.schoolRole, ctx.membership) : '',
      permissionLabel: manageable ? permissionLabelOf(ctx.schoolRole, ctx.membership) : '',
      managedCollegeId: manageable && ctx.membership && ctx.membership.status === 'active' && ctx.membership.role === 'staff'
        ? ctx.membership.collegeId || '' : '',
      // 能不能管**自己的学院**（学院赛名单提交的判据）。校级 / 协会负责人可管任一本校学院；
      // 学院负责人只在本学院上有权；平台管理员跨校也可管。口径与 canSchoolAction 同源。
      canManageCollege: manageable ? canSchoolAction(ctx, 'manageCollege',
        { schoolId: ctx.schoolId, association: ctx.association, collegeId }) : false,
      // 能不能管**本校**的校级事务（公告发布与下架、校务设置）。平台管理员与校级管理员为真。
      // 公告页原先自己拿 isPlatformAdmin 判，把校级管理员挡在门外；判定收回服务端这把尺子，
      // 页面照着布尔量走，避免两处口径分叉。
      canManageSchool: manageable ? canSchoolAction(ctx, 'manageSchool',
        { schoolId: ctx.schoolId, association: ctx.association }) : false,
      isPlatformAdmin: isPlatformAdminCtx(ctx),
      canReview: canSchoolAction(ctx, 'reviewMembers', ctx),
      canManageAssociation: canSchoolAction(ctx, 'manageAssociation', ctx),
      readOnly,
      grants: manageable ? grantOptions(ctx) : [],
      message: active ? '' : '当前账号尚未开通学校身份，请联系管理员' });
  }

  /**
   * 本校成员与权限。**任何有效平台账号都能读任意启用学校**（跨校只读），
   * 因此这里不放管理角色门槛，只要求学校与协会可用；返回里不带学号、手机号，
   * 与跨校参赛名单同一隐私口径。
   *
   * @param {Object} _payload
   * @param {Object} ctx
   */
  /**
   * 本校成员与权限。**任何有效平台账号都能读任意启用学校**（跨校只读），
   * 因此这里不放管理角色门槛，只要求学校与协会可用；返回里不带学号、手机号，
   * 与跨校参赛名单同一隐私口径。
   *
   * 【为什么分页】（2026-10-26 第四轮审查 P-2）
   * 原先一次下发全校在册成员。名册只增不减，几千人时单次回包会撞云函数 1MB
   * 上限，表现为整个接口「服务异常」；而页面一屏也只看得下十几行。现在按
   * `_id` 游标分页（同一校内等价于按 userId 升序，展示顺序不变），`countByStatus`
   * 单独给总数——它是聚合计数，不读文档。
   *
   * 【权限标签为什么可以按页批读】
   * 每行的「校级角色 + 协会身份」都是按主键点取，主键由 userId 派生，整页一次
   * `_.in` 就够（原来每页 20 行 40 次点读，见 H-5）。角色表与 membership 表
   * 也不再整表读：只取这一页涉及的那几个人。
   *
   * @param {Object} payload { limit?, cursor? }
   * @param {Object} ctx
   * @returns {Promise<Object>} {ok, members, total, hasMore, nextCursor, grants, readOnly}
   */
  async function getSchoolMembers(payload = {}, ctx) {
    if (!canReadSchool(ctx)) {
      return ok({ ok: false, members: [], grants: [], readOnly: false,
        total: 0, hasMore: false, nextCursor: '', message: '没有读取该校成员的权限' });
    }
    const readOnly = Boolean(ctx.actor.primarySchoolId && ctx.actor.primarySchoolId !== ctx.schoolId);
    const limit = Number.isInteger(payload.limit) && payload.limit > 0
      ? Math.min(payload.limit, ROSTER_PAGE_MAX) : ROSTER_PAGE;
    const afterId = typeof payload.cursor === 'string' ? payload.cursor : '';
    const scoped = ctx.repo.forScope(ctx);
    const page = await scoped.schoolMembers.listByStatus(SCHOOL_MEMBER_STATUS.ACTIVE, { limit, afterId });
    const rows = page.rows;
    // 学院名走 Map（原先 find 在循环里，2026-10-21 审查 P2-7）；
    // 角色与 membership 只按这一页的人批读，不再整表取。
    const [colleges, roles, memberships, total] = await Promise.all([
      loadColleges(ctx),
      scoped.schoolRoles.listByIds(rows.map(row => schoolRoleKey(row.userId, ctx.schoolId))),
      scoped.memberships.listByIds(rows.map(row => schoolMembershipKey(row.userId, ctx))),
      // 【口径统一】（2026-10-29 第十一轮审计 P2-9）
      // 从前这里是 countByStatus：只数「学籍 active」，不排除账号停用 / 已转校的人，
      // 于是同一所学校在首页显示 1200 人、在本页显示 1215 人。改成与名录分页同一套
      // 目录过滤（countDirectory）后，两处数字一致，且仍是一次聚合 RPC。
      scoped.schoolMembers.countDirectory({}),
    ]);
    const collegeNameById = new Map(colleges.map(row => [row.collegeId, row.name]));
    const collegeName = id => collegeNameById.get(id) || '';
    // 账号按在册成员编号批量取，不读全平台 users（2026-10-21 审查 P0-1）。
    const userById = new Map(
      (await ctx.repo.users.listByIds(rows.map(row => row.userId))).map(user => [user._id, user]),
    );
    const roleById = new Map(roles.map(row => [row._id, row]));
    const membershipById = new Map(memberships.map(row => [row._id, row]));
    const members = rows.map(row => ({
      userId: row.userId,
      nickName: (userById.get(row.userId) || {}).nickName || '会员',
      collegeId: row.collegeId || '',
      collegeName: collegeName(row.collegeId),
      managedCollegeId: membershipById.get(schoolMembershipKey(row.userId, ctx))?.status === 'active'
        && membershipById.get(schoolMembershipKey(row.userId, ctx))?.role === 'staff'
        ? membershipById.get(schoolMembershipKey(row.userId, ctx)).collegeId || '' : '',
      managedCollegeName: membershipById.get(schoolMembershipKey(row.userId, ctx))?.status === 'active'
        && membershipById.get(schoolMembershipKey(row.userId, ctx))?.role === 'staff'
        ? collegeName(membershipById.get(schoolMembershipKey(row.userId, ctx)).collegeId) : '',
      permission: permissionOf(
        roleById.get(schoolRoleKey(row.userId, ctx.schoolId)),
        membershipById.get(schoolMembershipKey(row.userId, ctx)),
      ),
      permissionLabel: permissionLabelOf(
        roleById.get(schoolRoleKey(row.userId, ctx.schoolId)),
        membershipById.get(schoolMembershipKey(row.userId, ctx)),
      ),
    }));
    return ok({
      ok: true,
      members,
      total,
      hasMore: Boolean(page.hasMore),
      nextCursor: page.hasMore && rows.length ? rows[rows.length - 1]._id : '',
      grants: readOnly ? [] : grantOptions(ctx),
      readOnly,
      message: '',
    });
  }

  /**
   * 统一「指定权限」入口：一次只改一档，写什么由 permission 决定。
   *   schoolAdmin       → school_roles（校级管理员）
   *   associationLeader → memberships.role='leader'
   *   collegeLeader     → memberships.role='staff' + collegeId
   *
   * 谁能授哪一档由 grantablePermissions 一处决定（平台管理员 / 校级管理员 / 协会
   * 负责人三档，逐级收窄）；跨校浏览一律拒绝——只读不给授权入口。
   *
   * @param {Object} payload { userId, permission, make, collegeId }
   * @param {Object} ctx
   */
  async function grantSchoolPermission(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    if (!GRANT_PERMISSIONS.includes(payload.permission)) return ok(refused('未知的权限类型'));
    if (typeof payload.userId !== 'string' || !payload.userId) return ok(refused('缺少目标会员'));
    if (payload.userId === ctx.actorId) return ok(refused('不能给自己指定权限'));
    if (!canGrantPermission(ctx, payload.permission)) return ok(refused('没有指定该权限的资格'));
    const make = Boolean(payload.make);
    const result = await ctx.repo.transaction(async tx => {
      const fresh = await freshContext(tx, ctx);
      if (!canGrantPermission(fresh, payload.permission)) return refused('没有指定该权限的资格');
      const user = await tx.users.getById(payload.userId);
      if (!user || user.platformStatus !== PLATFORM_STATUS.ACTIVE) return refused('目标账号不可用');
      if (user.platformRole === PLATFORM_ROLE.ADMIN) return refused('不能改变平台管理员的权限');
      const member = await tx.schoolMembers.getById(schoolMemberKey(user._id, fresh.schoolId));
      if (!member || member.status !== SCHOOL_MEMBER_STATUS.ACTIVE) return refused('对方没有本校有效身份');

      if (payload.permission === PERMISSION.SCHOOL_ADMIN) {
        const key = schoolRoleKey(user._id, fresh.schoolId);
        await tx.schoolRoles.set(key, {
          _id: key, userId: user._id, schoolId: fresh.schoolId,
          role: SCHOOL_ROLE.ADMIN, status: make ? 'active' : 'disabled',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      } else if (payload.permission === PERMISSION.ASSOCIATION_LEADER) {
        const key = schoolMembershipKey(user._id, fresh);
        const existing = await tx.memberships.get(key);
        const base = existing && existing.role === 'leader' ? existing : {};
        await tx.memberships.set(key, {
          ...base, _id: key, userId: user._id, schoolId: fresh.schoolId, association: fresh.association,
          role: make ? 'leader' : 'member', collegeId: '', status: make ? 'active' : 'revoked',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      } else {
        // 学院负责人：必须落到本校一个有效学院，且协会负责人无需再指定学院
        const current = await tx.memberships.get(schoolMembershipKey(user._id, fresh));
        if (current && current.status === 'active' && current.role === 'leader') return refused('对方已是协会负责人，无需再指定学院');
        const collegeId = make ? String(payload.collegeId || '') : '';
        if (make) {
          if (!collegeId) return refused('请选择本校有效学院');
          const college = await tx.colleges.getById(collegeKey(fresh.schoolId, collegeId));
          if (!college || college.status !== 'active' || college.schoolId !== fresh.schoolId) return refused('请选择本校有效学院');
        }
        const key = schoolMembershipKey(user._id, fresh);
        await tx.memberships.set(key, {
          _id: key, userId: user._id, schoolId: fresh.schoolId, association: fresh.association,
          role: make ? 'staff' : 'member', collegeId, status: make ? 'active' : 'revoked',
          updatedBy: fresh.actorId, updatedAt: fresh.now,
        });
      }

      await tx.audit.append({
        _id: `grant_${payload.permission}_${user._id}_${make ? 'grant' : 'revoke'}`,
        action: 'grantSchoolPermission', schoolId: fresh.schoolId, association: fresh.association,
        actorId: fresh.actorId, userId: user._id, permission: payload.permission, make, at: fresh.now,
      });
      return { ok: true, account: { userId: user._id, nickName: user.nickName || '' }, message: '' };
    });
    return ok(result);
  }

  /**
   * 修改自己的昵称与头像（协议 2，M3-c）。
   *
   * 【改的是谁，我说了不算】只认 ctx.actorId（由 OpenID 解析而来），payload 里塞
   * 别人的编号也改不到；白名单由 profile.js 的 EDITABLE_FIELDS 把住——实名信息
   * （真名 / 性别 / 学号 / 学院）与角色 / 积分 / 状态等在补丁清洗阶段直接丢掉，
   * 本人改不了。空补丁与非法昵称由 buildProfilePatch 一并挡下。
   *
   * 【为什么不 bumpSeason】昵称 / 头像进了回放数据集，旧栈据此 +1 赛季版本刷新
   * 缓存。学校维度的赛季版本落在 M4，本片只改账号资料，不碰赛季缓存（与 M1-c 同口径）。
   *
   * @param {Object} payload { patch: {nickName?, avatarUrl?} }
   * @param {Object} ctx
   */
  async function updateSchoolProfile(payload = {}, ctx) {
    if (!ctx.actorId) return ok(refused('请先登录'));
    const built = buildProfilePatch(payload.patch);
    if (!built.ok) {
      return ok({ ok: false, account: null, errors: built.errors, firstError: built.firstError });
    }
    const result = await ctx.repo.transaction(async tx => {
      const current = await tx.users.getById(ctx.actorId);
      if (!current || current.platformStatus !== PLATFORM_STATUS.ACTIVE) {
        return { ok: false, account: null, message: '找不到你的账号' };
      }
      const next = { ...current, ...built.patch };
      Object.assign(next, accountDirectoryFields(next));
      await tx.users.set(ctx.actorId, next);
      // 只回必要的展示字段，不下发 openId 等账号隐私。
      return { ok: true, account: { userId: next._id, nickName: next.nickName || '',
        avatarUrl: next.avatarUrl || '' }, message: '' };
    });
    return ok(result);
  }

  return { registerSchoolAccount, applySchoolMembership, reviewSchoolMembership, getMySchoolMembership,
    getSchoolApplications, getSchoolDirectory, getSchoolIdentitySession, getSchoolMembers,
    grantSchoolPermission, updateSchoolProfile,
    // 转校：仅转校申请 + 目标学校审批 + 申请人撤回（原学校无需同意）
    applySchoolTransfer, reviewSchoolTransfer, cancelSchoolTransfer };
}

module.exports = { createSchoolHandlers };
