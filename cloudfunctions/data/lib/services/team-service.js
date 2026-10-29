/**
 * 团队运动：球队与队员（篮球/足球/排球共用）
 * ============================================================
 * 球队不是「一次填几个名字」，而是长期存在、有人进出、有队长的实体。三份名单
 * 必须分开（见 docs/篮球协会-需求与实施规划.md §4.2）：
 *
 *   长期球队成员   teams / team_members        —— 本文件负责
 *   赛事报名名单   team_event_entries.roster   —— 赛事批次负责，锁定后成快照
 *   单场出场名单   team_matches.rosters        —— 录分批负责
 *
 * 本文件只管第一份。历史成绩只认快照，所以队员退队、改名、换号都不会回写
 * 已经发生的比赛——这也是「不要拿球队成员表当报名表」的原因。
 *
 * 【权限】
 *   · 建队：在册会员申请，协会负责人及以上审核（学生不能自助开队）；
 *   · 入队：本人申请 / 队长审批；邀请方式首版不做；
 *   · 队长：只能管自己这支队的队员与交接，**不因此获得协会管理权限**；
 *   · 协会负责人 / 校级管理员：可审核建队、可接管任何一支队、可归档。
 *
 * 【并发与幂等】
 *   · 建队用「创建人 + 请求编号」派生稳定 teamId，重试同一请求返回同一支队；
 *   · 队员关系主键是 teamId + userId，重复申请是幂等的，人数最多变一次；
 *   · 同范围不允许重名：写入前比对现有队名。并发建同名队仍可能同时通过，
 *     校园规模下接受这个窗口（不引入队名占位文档，避免把占位混进球队列表）。
 * ============================================================
 */

const { canManageAssociationSpace, canParticipateInAssociation, canReadAssociationSpace } = require('./association-space-permission.js');
const { buildDirectory } = require('./school-actor.js');
const { buildSchoolContext } = require('./school-context.js');
const { canSchoolAction } = require('./school-permission.js');
const { teamKey, teamMemberKey, collegeTeamKey, schoolMemberKey, schoolKey } = require('../utils/school.js');
const {
  TEAM_STATUS, TEAM_STATUS_LABEL, TEAM_TYPE, TEAM_TYPE_LABEL,
  TEAM_MEMBER_STATUS, TEAM_MEMBER_STATUS_LABEL,
} = require('../utils/constants.js');
const { sportTypeOf, allAssociations, SPORT_TYPE } = require('../utils/associations.js');
const { teamSportStrategyFor } = require('../utils/team-sport-rules.js');

const ok = data => ({ ok: true, data });
const refused = (message, extra = {}) => ({ ok: false, message, ...extra });

const NAME_MIN = 2;
const NAME_MAX = 20;
const TEAM_LIST_LIMIT = 100;

/**
 * 一次最多挑几名队员进院队。
 *
 * 【为什么必须有上限】（2026-10-22 大用户量复查 H-8）
 * `addCollegeTeamMembers` 在**一个事务**里按人点读 + 写入：每人 2 个操作
 * （`teamMembers.getById` 判重 + `set` 落库），固定开销约 8 个（身份上下文 6、
 * 球队 1、队头计数 1）。云端事务预算约 100（`cloud-repo.js` 的
 * TX_OPERATION_BUDGET），所以 46 人左右就会抛「事务读写总操作预算不足：
 * 请缩小本次处理范围」——纯开发者文案，学院负责人只会看到「服务异常」。
 *
 * 【为什么是 30】足球院队 11 人制满编 23 人，篮球 12~15 人，一次挑满整队都在
 * 这个数以内（留了余量给「补招几个人」）。要更多人请分几次挑——**队伍总人数
 * 不受这个限制**，这里限制的只是单次请求。
 */
const TEAM_ADD_BATCH_MAX = 30;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** 是否为团队项目协会。个人赛协会不该被这套接口服务。 */
function assertTeamSport(ctx) {
  return sportTypeOf(ctx.association) === 'team';
}

/** 文本字段裁剪：去空白 + 长度检查 */
function textOf(value, max) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return { ok: false, message: '请填写球队名称' };
  if (text.length > max) return { ok: false, message: `球队名称不超过 ${max} 个字` };
  return { ok: true, value: text };
}

/** 只认本范围的球队文档；跨校/跨协会读到也当不存在 */
function inScope(doc, ctx) {
  return Boolean(doc) && doc.schoolId === ctx.schoolId && doc.association === ctx.association;
}

/** 从目录里取昵称，取不到退回编号（宁可显示编号，也不要 undefined） */
function nameOf(dir, userId) {
  const found = (dir.members || []).find(user => user._id === userId);
  return (found && (found.nickName || found.realName)) || userId || '';
}

/** 队员是否在队（ACTIVE） */
function isActiveMember(row) {
  return Boolean(row) && row.status === TEAM_MEMBER_STATUS.ACTIVE;
}

/** 是不是学院代表队（系统预置、一院一队、无队长） */
function isCollegeTeam(team) {
  return Boolean(team) && team.type === TEAM_TYPE.COLLEGE;
}

/**
 * 能不能管这支院队：该校该院的学院负责人，以及协会负责人 / 校管。
 *
 * 与「队长」无关——院队没有队长，多个负责人各管各的会造成队长反复交接，
 * 所以管理权直接挂在角色上（`canSchoolAction('manageCollege')` 已是既有口径，
 * 与学院赛交名单同一把尺子）。
 */
function canManageCollegeTeam(ctx, team) {
  if (!isCollegeTeam(team) || !team.collegeId) return false;
  return canSchoolAction(ctx, 'manageCollege', {
    schoolId: ctx.schoolId, association: ctx.association, collegeId: team.collegeId,
  });
}

/** 院队显示名：读时按学院目录现拼，学院改名自动跟随（不把名字当真相存下来） */
function collegeTeamNameOf(dir, collegeId) {
  const name = dir.collegeNameById(collegeId);
  return name ? `${name}代表队` : '';
}

/**
 * 由球队编号反查学院编号。
 *
 * 院队编号是 `teamKey` 派生的指纹，不可逆；但学院目录只有二十来条，
 * 逐条算一遍比在库里另存一张映射表更省事，也不会出现「映射表过期」。
 */
function collegeIdOfTeamId(dir, teamId, ctx) {
  const target = String(teamId || '');
  if (!target) return '';
  const hit = (dir.colleges || []).find(row => collegeTeamKey(row.collegeId, ctx) === target);
  return hit ? hit.collegeId : '';
}

/**
 * 派生一条院队（不落库）。
 *
 * 「系统预置」的语义是「不需要任何人创建，它就该在」。所以读路径（我的球队、
 * 报名候选）用派生对象，写路径（挑人、报名）才在 `ensureCollegeTeam` 里落库。
 * 这样新库里一条记录都没有时，负责人也不会看不到自己的院队。
 */
function virtualCollegeTeam(ctx, dir, collegeId, memberCount = 0) {
  const name = collegeTeamNameOf(dir, collegeId);
  if (!name) return null;
  const strategy = teamSportStrategyFor(ctx.association);
  return {
    _id: collegeTeamKey(collegeId, ctx),
    schoolId: ctx.schoolId,
    association: ctx.association,
    sport: strategy && strategy.sportFormat === 'football11' ? 'football' : 'basketball',
    name,
    college: dir.collegeNameById(collegeId),
    collegeId,
    type: TEAM_TYPE.COLLEGE,
    status: TEAM_STATUS.ACTIVE,
    // 院队不设队长，管理权挂在学院角色上
    captainId: '',
    memberCount,
    createdAt: null,
  };
}

/**
 * 按球队编号取院队，缺失时就地补建。
 *
 * 给「报名」用：新库里院队还没落库时，报名不能因为「球队不存在」被挡回去——
 * 编号本身就是「它该存在」的凭证。学院编号从目录反查，补建仍是幂等的那一条。
 */
async function resolveCollegeTeam(teamId, ctx, readyDir) {
  // 调用方手里已经有目录时直接复用：`getTeam` 在同一请求内先读了一次，
  // 不为「补建院队」再读一遍整校名册（2026-10-29 第十一轮审计 P3-11）。
  const dir = readyDir || await buildDirectory(ctx);
  const collegeId = collegeIdOfTeamId(dir, teamId, ctx);
  if (!collegeId) return { ok: false, message: '学院代表队不存在' };
  const team = await ensureCollegeTeam(ctx, collegeId, dir);
  if (!team) return { ok: false, message: '学院代表队初始化失败，请稍后重试' };
  return { ok: true, team, dir };
}

/** 队长或协会管理者；院队没有队长，管理权看学院角色 */
function canManageTeam(ctx, team, actorId) {
  if (!team) return false;
  if (isCollegeTeam(team)) return canManageCollegeTeam(ctx, team) || canManageAssociationSpace(ctx);
  if (team.captainId === actorId) return true;
  return canManageAssociationSpace(ctx);
}

/** 列表行 / 详情用的球队视图。布尔量在这里算好，模板不写业务判断。 */
function teamView(team, { dir, actorId, manage, membership, memberCount }) {
  const active = isActiveMember(membership);
  const collegeTeam = isCollegeTeam(team);
  return {
    teamId: team._id,
    name: team.name,
    // 队名首字做占位「队徽」：在服务端算好，模板不写下标取值
    initial: String(team.name || '?').slice(0, 1),
    sport: team.sport || (teamSportStrategyFor(team.association)?.sportFormat === 'football11' ? 'football' : 'basketball'),
    college: team.college || '',
    collegeId: team.collegeId || '',
    type: collegeTeam ? TEAM_TYPE.COLLEGE : TEAM_TYPE.FREE,
    typeLabel: collegeTeam ? TEAM_TYPE_LABEL[TEAM_TYPE.COLLEGE] : TEAM_TYPE_LABEL[TEAM_TYPE.FREE],
    /** 院队：系统预置，队员由学院负责人挑选，不能申请、不能转让、不能归档 */
    isCollegeTeam: collegeTeam,
    status: team.status,
    statusLabel: TEAM_STATUS_LABEL[team.status] || team.status,
    captainId: team.captainId,
    captainName: nameOf(dir, team.captainId),
    // 人数来自 team_members（在队状态），不是球队文档上的字段。
    // 以前读 team.memberCount，库里从来没有这个字段，列表里永远是「0 人」。
    memberCount: Number(memberCount != null ? memberCount : team.memberCount) || 0,
    createdAt: team.createdAt || null,
    isMine: active,
    isCaptain: !collegeTeam && team.captainId === actorId,
    canManage: manage,
    /** 能不能点「申请加入」：正常状态、非本队成员、也没有待审申请；院队一律不能申请 */
    canApply: !collegeTeam && team.status === TEAM_STATUS.ACTIVE && !active
      && !(membership && membership.status === TEAM_MEMBER_STATUS.PENDING),
    /** 待审申请标记：队长/管理员在详情里要能看到并审批 */
    pending: !collegeTeam && Boolean(membership) && membership.status === TEAM_MEMBER_STATUS.PENDING,
    membershipStatus: membership ? membership.status : '',
    membershipLabel: membership ? (TEAM_MEMBER_STATUS_LABEL[membership.status] || '') : '',
  };
}

/** 队员行（详情页名单） */
function memberRow(row, dir) {
  return {
    userId: row.userId,
    name: nameOf(dir, row.userId),
    role: row.role,
    roleLabel: row.role === 'captain' ? '队长' : '队员',
    status: row.status,
    statusLabel: TEAM_MEMBER_STATUS_LABEL[row.status] || '',
    joinedAt: row.joinedAt || null,
  };
}

/** 读一支队并过范围校验 */
async function loadTeam(repo, ctx, teamId) {
  if (!teamId || typeof teamId !== 'string') return null;
  const team = await repo.teams.getById(teamId);
  return inScope(team, ctx) ? team : null;
}

/** 本范围的队员关系，按队分组，避免 N 次点读 */
async function membershipMap(repo) {
  const rows = await repo.teamMembers.list();
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.teamId)) map.set(row.teamId, []);
    map.get(row.teamId).push(row);
  }
  return map;
}

/* ============================================================
 * 读
 * ============================================================ */

/**
 * 球队列表。
 * @param {Object} payload { keyword?, mine? }
 * @param {Object} ctx
 */
async function listTeams(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const dir = await buildDirectory(ctx);
  const manage = canManageAssociationSpace(ctx);
  const repo = ctx.repo.forScope(ctx);
  const [teams, members] = await Promise.all([repo.teams.list(), repo.teamMembers.list()]);

  const keyword = String(payload.keyword || '').trim().toLowerCase();
  const mineOnly = payload.mine === true;
  const byTeam = new Map();
  for (const row of members) {
    if (!byTeam.has(row.teamId)) byTeam.set(row.teamId, []);
    byTeam.get(row.teamId).push(row);
  }

  const rows = teams
    // 院队不进展台：二十来个学院就是二十来行，会把「自由组队」整块淹掉。
    // 院队从石榴籽杯页与我的球队进（见 getCollegeTeam）。
    .filter(team => !isCollegeTeam(team))
    .filter(team => team.status !== TEAM_STATUS.ARCHIVED || manage)
    // 待审/未通过的队只给管理者看，学生看不到别人还没过审的申请
    .filter(team => team.status === TEAM_STATUS.ACTIVE || manage)
    .filter(team => !keyword || String(team.name || '').toLowerCase().includes(keyword))
    .map(team => {
      const rowsOfTeam = byTeam.get(team._id) || [];
      const membership = rowsOfTeam.find(row => row.userId === ctx.actorId);
      const memberCount = rowsOfTeam.filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE).length;
      return teamView(team, { dir, actorId: ctx.actorId, manage, membership, memberCount });
    })
    .filter(view => !mineOnly || view.isMine || view.isCaptain)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));

  // 【分页契约】（2026-10-29 第十一轮审计 P2-8）
  // 从前直接 `slice(0, 100)`：第 101 支球队静默消失，返回体里也没有 hasMore/total，
  // 页面连「还有更多」都无从判断。这里按 offset 切片并回传三者，与赛事/名录的
  // 口径一致（offset + nextOffset，而不是再造一套 cursor）。
  const limit = Number.isInteger(payload.limit) && payload.limit > 0
    ? Math.min(payload.limit, TEAM_LIST_LIMIT) : TEAM_LIST_LIMIT;
  const offset = Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0;
  const total = rows.length;
  const page = rows.slice(offset, offset + limit);

  // 我的球队：本院用户自动含本院院队（无需加入），排在自由球队之前。
  // 组队列表本身仍不列院队——那会把自由组队淹掉；但「我的球队」里少了院队，
  // 院队详情就没有入口，负责人挑人只能靠报名面板兜着（2026-10-20 修复）。
  if (mineOnly) {
    const myCollegeId = dir.collegeIdOf(ctx.actorId);
    if (myCollegeId) {
      const teamId = collegeTeamKey(myCollegeId, ctx);
      const count = members
        .filter(row => row.teamId === teamId && row.status === TEAM_MEMBER_STATUS.ACTIVE).length;
      const collegeTeam = virtualCollegeTeam(ctx, dir, myCollegeId, count);
      const hitKeyword = Boolean(collegeTeam)
        && (!keyword || String(collegeTeam.name).toLowerCase().includes(keyword));
      // 院队是虚拟行：只在第一页插到最前面，否则会跟着每一页重复出现
      if (collegeTeam && hitKeyword && offset === 0) {
        page.unshift({
          ...teamView(collegeTeam, {
            dir, actorId: ctx.actorId, manage: canManageTeam(ctx, collegeTeam, ctx.actorId),
            membership: null, memberCount: count,
          }),
          // 本院即代表本院出战，不要求先被挑进队：我的球队里它恒算「我的」
          isMine: true,
          mineLabel: '本院',
        });
      }
    }
  }

  return ok({
    ok: true, teams: page, canManage: manage,
    // total 只数真实球队；院队是虚拟行（一个学院一支、没有落库记录），不计入
    total,
    hasMore: offset + page.length < total,
    nextOffset: offset + page.length,
    message: '',
  });
}

/**
 * 球队详情：球队信息 + 队员名单。
 * 待审申请只有队长与管理者看得到；普通队员只看到在队的人。
 */
async function getTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const dir = await buildDirectory(ctx);
  let team = await loadTeam(ctx.repo.forScope(ctx), ctx, payload.teamId);
  // 院队是惰性预置的：编号能对上学院目录就先补建再读。
  // 少了这一步，「我的球队」里点进院队会先被 getTeam 报「球队不存在」。
  if (!team) {
    const ensured = await resolveCollegeTeam(payload.teamId, ctx, dir);
    if (ensured.ok) team = ensured.team;
  }
  if (!team) return ok(refused('球队不存在，或不在本协会'));

  const manage = canManageTeam(ctx, team, ctx.actorId);
  const rows = (await ctx.repo.forScope(ctx).teamMembers.list()).filter(row => row.teamId === team._id);
  const membership = rows.find(row => row.userId === ctx.actorId);

  const visible = rows
    .filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE
      || (manage && row.status !== TEAM_MEMBER_STATUS.LEFT))
    .map(row => memberRow(row, dir))
    .sort((a, b) => {
      if (a.role !== b.role) return a.role === 'captain' ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    });

  return ok({
    ok: true,
    team: teamView(team, { dir, actorId: ctx.actorId, manage, membership }),
    members: visible,
    pendingCount: rows.filter(row => row.status === TEAM_MEMBER_STATUS.PENDING).length,
    message: '',
  });
}

/* ============================================================
 * 写
 * ============================================================ */

/**
 * 学生申请建队。
 * 队名同范围唯一；创建人自动成为队长；队伍初始为「待审核」。
 */
async function createTeamApplication(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canParticipateInAssociation(ctx)) return ok(refused('只有本协会在册会员可以申请建队'));

  const name = textOf(payload.name, NAME_MAX);
  if (!name.ok) return ok(refused(name.message));
  if (name.value.length < NAME_MIN) return ok(refused(`球队名称至少 ${NAME_MIN} 个字`));
  const token = payload.requestId;
  if (typeof token !== 'string' || !REQUEST_ID_PATTERN.test(token)) return ok(refused('建队请求编号无效'));
  const college = String(payload.college || '').trim();

  const teamId = teamKey(`${ctx.actorId}|${token}`, ctx);
  // 重名检查放在事务外：内存仓储与云端仓储都不允许事务内整表查询。
  // 代价是两个人同时提交同名队可能都通过（校园规模下接受这个窗口，
  // 见文件头「并发与幂等」）。
  const existingTeam = await ctx.repo.forScope(ctx).teams.getById(teamId);
  if (inScope(existingTeam, ctx)) {
    return ok({ ok: true, teamId, message: '' });
  }
  const teams = await ctx.repo.forScope(ctx).teams.list();
  if (teams.some(team => inScope(team, ctx)
    && team.status !== TEAM_STATUS.ARCHIVED
    && String(team.name || '').trim() === name.value)) {
    return ok(refused('同协会已有同名球队，请换一个名字'));
  }

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canParticipateInAssociation(fresh)) return refused('只有本校在册会员可以操作');

    // 事务内只写：先点读确认没有被并发请求抢先建出来（同编号重试的幂等）
    const again = await tx.teams.getById(teamId);
    if (inScope(again, fresh)) return { ok: true, teamId, message: '' };

    const now = fresh.now;
    await tx.teams.set(teamId, {
      _id: teamId, schoolId: fresh.schoolId, association: fresh.association,
      sport: teamSportStrategyFor(fresh.association)?.sportFormat === 'football11' ? 'football' : 'basketball',
      name: name.value, college,
      captainId: fresh.actorId, status: TEAM_STATUS.PENDING,
      memberCount: 1, revision: 1, requestId: token,
      createdBy: fresh.actorId, createdAt: now, updatedAt: now,
    });
    await tx.teamMembers.set(teamMemberKey(teamId, fresh.actorId), {
      _id: teamMemberKey(teamId, fresh.actorId),
      schoolId: fresh.schoolId, association: fresh.association,
      teamId, userId: fresh.actorId, role: 'captain', status: TEAM_MEMBER_STATUS.ACTIVE,
      joinedAt: now, updatedAt: now,
    });
    return { ok: true, teamId, message: '' };
  });
  return ok(result);
}

/**
 * 审核建队申请。
 * 通过 → ACTIVE；退回 → REJECTED（可改名后重新申请，不物理删除）。
 */
async function reviewTeamApplication(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canManageAssociationSpace(ctx)) return ok(refused('只有协会负责人及以上可以审核建队'));

  const approve = payload.approve === true;
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canManageAssociationSpace(fresh)) return refused('当前已无审核建队权限');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (team.status !== TEAM_STATUS.PENDING) return refused('这支球队不在待审核状态');

    const now = fresh.now;
    await tx.teams.set(team._id, {
      ...team,
      status: approve ? TEAM_STATUS.ACTIVE : TEAM_STATUS.REJECTED,
      reason: approve ? '' : String(payload.reason || '').trim().slice(0, 100),
      revision: Number(team.revision || 1) + 1,
      reviewedBy: fresh.actorId, reviewedAt: now, updatedAt: now,
    });
    return { ok: true, teamId: team._id, status: approve ? TEAM_STATUS.ACTIVE : TEAM_STATUS.REJECTED, message: '' };
  });
  return ok(result);
}

/** 本人申请入队。重复申请幂等；被拒/离队后可重新申请。 */
async function applyToJoinTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));
  if (!canParticipateInAssociation(ctx)) return ok(refused('只有本协会在册会员可以加入球队'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canParticipateInAssociation(fresh)) return refused('只有本校在册会员可以操作');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (isCollegeTeam(team)) return refused('学院代表队由学院负责人挑选队员，不能自行申请');
    if (team.status !== TEAM_STATUS.ACTIVE) return refused('这支球队当前不接受入队申请');

    const key = teamMemberKey(team._id, fresh.actorId);
    const existing = await tx.teamMembers.getById(key);
    if (isActiveMember(existing)) return { ok: true, status: TEAM_MEMBER_STATUS.ACTIVE, message: '你已在这支球队中' };
    if (existing && existing.status === TEAM_MEMBER_STATUS.PENDING) {
      return { ok: true, status: TEAM_MEMBER_STATUS.PENDING, message: '' };
    }
    const now = fresh.now;
    await tx.teamMembers.set(key, {
      _id: key, schoolId: fresh.schoolId, association: fresh.association,
      teamId: team._id, userId: fresh.actorId, role: 'member',
      status: TEAM_MEMBER_STATUS.PENDING, note: String(payload.note || '').trim().slice(0, 60),
      joinedAt: existing && existing.joinedAt ? existing.joinedAt : null,
      updatedAt: now,
    });
    return { ok: true, status: TEAM_MEMBER_STATUS.PENDING, message: '' };
  });
  return ok(result);
}

/**
 * 审批入队申请（队长 / 协会管理者）。
 * 通过时人数 +1；退回不改人数。
 */
async function reviewTeamMember(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const approve = payload.approve === true;
  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (!canManageTeam(fresh, team, fresh.actorId)) return refused('只有队长或协会负责人可以审批入队');

    const key = teamMemberKey(team._id, payload.userId);
    const row = await tx.teamMembers.getById(key);
    if (!row || row.teamId !== team._id) return refused('找不到这条入队申请');
    if (row.status !== TEAM_MEMBER_STATUS.PENDING) return refused('这条申请已经处理过了');

    const now = fresh.now;
    await tx.teamMembers.set(key, {
      ...row,
      status: approve ? TEAM_MEMBER_STATUS.ACTIVE : TEAM_MEMBER_STATUS.REJECTED,
      joinedAt: approve ? now : null,
      reviewedBy: fresh.actorId, reviewedAt: now, updatedAt: now,
    });
    if (approve) {
      await tx.teams.set(team._id, {
        ...team, memberCount: (Number(team.memberCount) || 0) + 1, revision: Number(team.revision || 1) + 1,
        updatedAt: now,
      });
    }
    return { ok: true, userId: payload.userId, status: approve ? 'active' : 'rejected', message: '' };
  });
  return ok(result);
}

/**
 * 本人退队。
 * 队长不能直接退：队里还有人时必须先交接，只剩自己时可以归档。
 */
async function leaveTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (team.captainId === fresh.actorId) {
      return refused('队长不能直接退队：请先转让队长，或直接归档这支球队');
    }
    const key = teamMemberKey(team._id, fresh.actorId);
    const row = await tx.teamMembers.getById(key);
    if (!isActiveMember(row)) return refused('你不在队中');

    const now = fresh.now;
    await tx.teamMembers.set(key, { ...row, status: TEAM_MEMBER_STATUS.LEFT, leftAt: now, updatedAt: now });
    await tx.teams.set(team._id, {
      ...team, memberCount: Math.max(0, (Number(team.memberCount) || 1) - 1), revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, message: '' };
  });
  return ok(result);
}

/** 转让队长（队长本人或协会管理者）。目标必须是在队成员。 */
async function transferTeamCaptain(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (isCollegeTeam(team)) return refused('学院代表队没有队长，不需要转让');
    if (!canManageTeam(fresh, team, fresh.actorId)) return refused('只有队长或协会负责人可以转让队长');
    if (team.status === TEAM_STATUS.ARCHIVED) return refused('已归档的球队不能转让队长');

    const targetKey = teamMemberKey(team._id, payload.userId);
    const target = await tx.teamMembers.getById(targetKey);
    if (!isActiveMember(target)) return refused('只能把队长转给在队队员');
    if (target.userId === team.captainId) return refused('他已经是队长了');

    const now = fresh.now;
    const currentKey = teamMemberKey(team._id, team.captainId);
    const current = await tx.teamMembers.getById(currentKey);
    if (current) {
      await tx.teamMembers.set(currentKey, { ...current, role: 'member', updatedAt: now });
    }
    await tx.teamMembers.set(targetKey, { ...target, role: 'captain', updatedAt: now });
    await tx.teams.set(team._id, {
      ...team, captainId: target.userId, revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, captainId: target.userId, message: '' };
  });
  return ok(result);
}

/** 归档球队（= 解散，不物理删除）。历史比赛与统计仍可查。 */
async function archiveTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async tx => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    if (!canReadAssociationSpace(fresh)) return refused('账号或本校身份已失效');

    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (isCollegeTeam(team)) return refused('学院代表队由系统预置，不能归档');
    if (!canManageTeam(fresh, team, fresh.actorId)) return refused('只有队长或协会负责人可以归档球队');
    if (team.status === TEAM_STATUS.ARCHIVED) return { ok: true, message: '' };

    const now = fresh.now;
    await tx.teams.set(team._id, {
      ...team, status: TEAM_STATUS.ARCHIVED,
      archivedBy: fresh.actorId, archivedAt: now,
      revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, message: '' };
  });
  return ok(result);
}

/* ---------------- 学院代表队（系统预置） ---------------- */

/**
 * 学院代表队。
 *
 * 【为什么不让学生建、也不给申请入口】
 * 石榴籽杯是「按学院分」的比赛，一个学院在一个项目里只可能有一支代表队。
 * 让它由学生自由组建，就会冒出「法院一队 / 法院二队」「同名两队」这类分支，
 * 一院一队也就无从保证。所以院队由系统按学院目录**预置**（编号确定性派生），
 * 队员由**学院负责人挑选**（选了即入队），成员可以自己退出，但没有申请入口。
 *
 * 【为什么成员照旧落 team_members 表】
 * 院队成员是「真的被选进这支队伍的人」，不是「全院会员的投影」：
 * 负责人挑人 = 一次真实的授权，落表之后报名选人、出场名单、我的球队
 * 全都沿用现有那一套，不需要为院队再写一遍。
 */

/** 本协会里属于该学院的在册会员（院队候选池：负责人从这里挑人） */
async function collegeCandidates(ctx, collegeId, dir) {
  const memberships = await ctx.repo.forScope(ctx).memberships.list();
  const inCollege = new Set(memberships
    .filter(row => row.status === 'active' && row.collegeId === collegeId)
    .map(row => row.userId));
  const platformActive = new Set(dir.activeMemberIds || []);
  return (dir.members || [])
    .filter(user => inCollege.has(user._id) && platformActive.has(user._id))
    .map(user => ({ userId: user._id, name: user.nickName || user.realName || user._id }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));
}

/**
 * 取（必要时就地补建）某学院的院队。
 *
 * 幂等：编号由学院编号派生，并发补建时后到的请求读到先到的那条，不会建出两支。
 * 名字不写进判定依据——它每次按学院目录现算，学院改名自动跟随。
 */
async function ensureCollegeTeam(ctx, collegeId, dir) {
  const teamId = collegeTeamKey(collegeId, ctx);
  const current = await ctx.repo.forScope(ctx).teams.getById(teamId);
  if (inScope(current, ctx)) return current;
  const name = collegeTeamNameOf(dir, collegeId);
  if (!name) return null;

  const created = await ctx.repo.transaction(async (tx) => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    const again = await tx.teams.getById(teamId);
    if (inScope(again, ctx)) return again;
    const now = fresh.now;
    const doc = {
      _id: teamId, schoolId: fresh.schoolId, association: fresh.association,
      sport: teamSportStrategyFor(fresh.association)?.sportFormat === 'football11' ? 'football' : 'basketball',
      name,
      college: dir.collegeNameById(collegeId),
      collegeId,
      type: TEAM_TYPE.COLLEGE,
      status: TEAM_STATUS.ACTIVE,
      // 院队不设队长：多个负责人都能管，靠角色判权（见 canManageCollegeTeam）
      captainId: '',
      memberCount: 0,
      revision: 1,
      createdBy: fresh.actorId || '',
      createdAt: now, updatedAt: now,
    };
    await tx.teams.set(teamId, doc);
    return doc;
  });
  return created || null;
}

/**
 * 本院院队：视图 + 名单 + 候选池。
 *
 * 【为什么它同时是「读」和「建」】
 * 院队不需要任何人创建，用户第一次点进来时它就该在。所以这里在缺失时就地补建
 * （幂等、只写一条）。为它单开一个「初始化」管理动作，反而会让新学院、新学校
 * 出现「页面空着但没人知道要点一下初始化」的状态。
 */
async function getCollegeTeam(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const dir = await buildDirectory(ctx);
  const mine = dir.collegeIdOf(ctx.actorId);
  // 三种入口：按学院编号（杯赛页）、按球队编号（球队详情）、不传（本人学院）
  let collegeId = String(payload.collegeId || '');
  if (!collegeId && payload.teamId) {
    const found = await ctx.repo.forScope(ctx).teams.getById(String(payload.teamId));
    if (inScope(found, ctx) && isCollegeTeam(found)) collegeId = found.collegeId || '';
    // 还没落库的院队：编号由学院目录派生，反查一次照样能进（补建交给下面的 ensure）
    if (!collegeId) collegeId = collegeIdOfTeamId(dir, payload.teamId, ctx);
  }
  if (!collegeId) collegeId = mine;
  if (!collegeId) return ok(refused('你还没有归属学院，暂时没有学院代表队'));
  if (!dir.collegeNameById(collegeId)) return ok(refused('学院不存在'));

  const team = await ensureCollegeTeam(ctx, collegeId, dir);
  if (!team) return ok(refused('学院代表队初始化失败，请稍后重试'));

  const rows = (await ctx.repo.forScope(ctx).teamMembers.list()).filter(row => row.teamId === team._id);
  const manage = canManageTeam(ctx, team, ctx.actorId);
  const membership = rows.find(row => row.userId === ctx.actorId);
  const active = rows.filter(row => isActiveMember(row));
  const members = active.map(row => memberRow(row, dir))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN'));

  return ok({
    ok: true,
    team: teamView(team, { dir, actorId: ctx.actorId, manage, membership, memberCount: active.length }),
    members,
    collegeId,
    collegeName: dir.collegeNameById(collegeId),
    isMyCollege: collegeId === mine,
    /** 只有学院负责人（及以上）能挑人 */
    canPickMembers: manage,
    /** 候选池：本学院在该协会的在册会员，标记是否已在队 */
    candidates: manage
      ? (await collegeCandidates(ctx, collegeId, dir)).map(row => ({
        ...row, inTeam: active.some(member => member.userId === row.userId),
      }))
      : [],
    message: '',
  });
}

/**
 * 负责人挑人进队（选了即入队，无需对方同意）。
 *
 * 校验放在事务外（云开发事务内不允许整表查询会员）；写入在事务内逐人点读确认，
 * 重复挑人幂等。极端情况下「刚退会就被挑进来」的窗口极小，且下次退会清理会带走。
 */
async function addCollegeTeamMembers(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const repo = ctx.repo.forScope(ctx);
  const team = await repo.teams.getById(payload.teamId);
  if (!inScope(team, ctx)) return ok(refused('球队不存在，或不在本协会'));
  if (!isCollegeTeam(team)) return ok(refused('只有学院代表队可以这样添加队员'));
  if (!canManageTeam(ctx, team, ctx.actorId)) return ok(refused('只有本学院负责人可以挑选队员'));

  const wanted = Array.isArray(payload.userIds)
    ? [...new Set(payload.userIds.map(id => String(id || '').trim()).filter(Boolean))]
    : [];
  if (wanted.length === 0) return ok(refused('请选择要加入的队员'));
  // 上限在进入事务前判：超限的请求不该先花掉一次身份解析和一整套候选人读取
  if (wanted.length > TEAM_ADD_BATCH_MAX) {
    return ok(refused(`一次最多添加 ${TEAM_ADD_BATCH_MAX} 名队员，请分几次挑`));
  }

  const dir = await buildDirectory(ctx);
  const allowed = new Set((await collegeCandidates(ctx, team.collegeId, dir)).map(row => row.userId));
  const outside = wanted.filter(id => !allowed.has(id));
  if (outside.length > 0) return ok(refused('只能挑选本学院的在册会员'));

  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    const current = await loadTeam(tx, fresh, payload.teamId);
    if (!current) return refused('球队不存在，或不在本协会');
    if (!canManageTeam(fresh, current, fresh.actorId)) return refused('当前已无挑选队员的权限');

    const now = fresh.now;
    let added = 0;
    for (const userId of wanted) {
      const key = teamMemberKey(current._id, userId);
      const row = await tx.teamMembers.getById(key);
      if (isActiveMember(row)) continue;
      await tx.teamMembers.set(key, {
        ...(row || {}),
        _id: key, schoolId: fresh.schoolId, association: fresh.association,
        teamId: current._id, userId,
        // 院队没有队长，负责人以「教练/管理」身份留在名单里也只是一个普通队员位
        role: 'member',
        status: TEAM_MEMBER_STATUS.ACTIVE,
        source: 'picked',
        joinedAt: now, leftAt: null, updatedAt: now,
      });
      added += 1;
    }
    if (added > 0) {
      await tx.teams.set(current._id, {
        ...current, memberCount: (Number(current.memberCount) || 0) + added, revision: Number(current.revision || 1) + 1, updatedAt: now,
      });
    }
    return { ok: true, added, message: '' };
  });
  return ok(result);
}

/** 「本学院在该协会的在册会员」——院队挑人、学院赛报名的共用候选池 */
async function collegeMemberCandidates(ctx, collegeId) {
  if (!collegeId) return [];
  const dir = await buildDirectory(ctx);
  return collegeCandidates(ctx, collegeId, dir);
}

/** 负责人把队员移出学院队（与「本人退队」是两条路，权限不同） */
async function removeCollegeTeamMember(payload = {}, ctx) {
  if (!ctx.actorId) return ok(refused('请先登录'));
  if (!canReadAssociationSpace(ctx)) return ok(refused('账号或本校在册会员身份已失效，无权访问本协会'));
  if (!assertTeamSport(ctx)) return ok(refused('该协会不是团队项目'));

  const result = await ctx.repo.transaction(async (tx) => {
    const fresh = await buildSchoolContext({ repo: tx, actorId: ctx.actorId,
      scope: { schoolId: ctx.schoolId, association: ctx.association }, now: ctx.now });
    const team = await loadTeam(tx, fresh, payload.teamId);
    if (!team) return refused('球队不存在，或不在本协会');
    if (!isCollegeTeam(team)) return refused('只有学院代表队可以这样移除队员');
    if (!canManageTeam(fresh, team, fresh.actorId)) return refused('只有本学院负责人可以移除队员');

    const key = teamMemberKey(team._id, String(payload.userId || '').trim());
    const row = await tx.teamMembers.getById(key);
    if (!isActiveMember(row)) return refused('他不在学院队里');
    const now = fresh.now;
    await tx.teamMembers.set(key, { ...row, status: TEAM_MEMBER_STATUS.LEFT, leftAt: now, updatedAt: now });
    await tx.teams.set(team._id, {
      ...team, memberCount: Math.max(0, (Number(team.memberCount) || 1) - 1), revision: Number(team.revision || 1) + 1, updatedAt: now,
    });
    return { ok: true, message: '' };
  });
  return ok(result);
}

/* ---------------- 会员离开学校时的球队清理 ---------------- */

/** 有球队的协会 id。足球、排球接进来时这里不用改——按 sportType 取的 */
function teamAssociationIds() {
  return allAssociations()
    .filter(item => item.sportType === SPORT_TYPE.TEAM)
    .map(item => item.id);
}

/**
 * 把某个会员从「某校所有球队」里摘掉。
 *
 * 【为什么需要它】
 * 转校只改 `school_members` 与 `memberships`，球队是另一套表。不清的话，
 * 一个已经转走的人仍然挂在校队的名单里，甚至还是队长——报名时会被算进
 * 人数、锁定名单时会被拍进快照，等于让一个不属于本校的人上了场。
 *
 * 【队长走了怎么办】
 * 优先把队长交给「最早入队的在队队员」；一个在队队员都不剩就把球队归档。
 * 不让「有队没队长」这种状态存在——那样报名、审批、归档都会卡住。
 *
 * 【为什么不在调用方的事务里做】
 * 内存与云端仓储都不允许事务内整表查询。所以先在外面把要改的行读出来，
 * 再按球队开启事务。事务内重读成员与学校身份，名单变化时重新取候选，
 * 不把事务外的旧快照写回。每批最多检查 20 个候选，控制事务操作预算。
 *
 * @param {Object} repo 未绑定范围的仓储（ctx.repo）
 * @param {Object} params
 * @param {string} params.schoolId 要清理的学校
 * @param {string} params.userId
 * @param {string} [params.now]
 * @param {string} [params.actorId]
 * @returns {Promise<{detached:number, captainMoved:number, archived:number}>}
 */
async function detachUserFromTeams(repo, { schoolId, userId, now, actorId } = {}) {
  const summary = { detached: 0, captainMoved: 0, archived: 0 };
  if (!repo || !schoolId || !userId) return summary;
  for (const association of teamAssociationIds()) {
    const scoped = repo.forScope({ schoolId, association });
    const mine = (await scoped.teamMembers.listByUser(userId)).filter(row => row.status === TEAM_MEMBER_STATUS.ACTIVE);
    for (const row of mine) {
      let completed = false;
      for (let attempt = 0; attempt < 3 && !completed; attempt++) {
        const snapshot = await scoped.teams.getById(row.teamId);
        if (!snapshot) {
          const detached = await repo.transaction(async root => {
            const tx = root.forScope({ schoolId, association });
            if (await tx.teams.getById(row.teamId)) return null;
            const current = await tx.teamMembers.getById(row._id);
            if (!current || current.status !== TEAM_MEMBER_STATUS.ACTIVE) return 0;
            await tx.teamMembers.set(current._id, { ...current, status: TEAM_MEMBER_STATUS.LEFT, leftAt: now, updatedAt: now });
            return 1;
          });
          if (detached === null) continue;
          summary.detached += detached;
          completed = true;
          break;
        }
        const stamp = team => JSON.stringify([team.revision, team.captainId, team.memberCount, team.updatedAt, team.status]);
        const candidates = (await scoped.teamMembers.listByTeams([row.teamId]))
          .filter(item => item.userId !== userId && item.status === TEAM_MEMBER_STATUS.ACTIVE)
          .sort((a, b) => String(a.joinedAt || '').localeCompare(String(b.joinedAt || ''))
            || String(a.userId).localeCompare(String(b.userId)));
        // Each transaction checks at most 20 candidates (3 point reads each), below 100 operations.
        for (let offset = 0; offset < Math.max(1, candidates.length); offset += 20) {
          const batch = candidates.slice(offset, offset + 20);
          const last = offset + 20 >= candidates.length;
          const result = await repo.transaction(async root => {
            const tx = root.forScope({ schoolId, association });
            const team = await tx.teams.getById(row.teamId);
            const current = await tx.teamMembers.getById(row._id);
            if (!team || !current) return { done: true };
            if (stamp(team) !== stamp(snapshot)) return { retry: true };
            const active = current.status === TEAM_MEMBER_STATUS.ACTIVE;
            if (!active && team.captainId !== userId) return { done: true };
            let next = null;
            if (team.captainId === userId) {
              for (const candidate of batch) {
                const member = await tx.teamMembers.getById(candidate._id);
                if (!member || member.status !== TEAM_MEMBER_STATUS.ACTIVE || member.teamId !== team._id) continue;
                const [account, schoolMember] = await Promise.all([
                  root.users.getById(member.userId), root.schoolMembers.getById(schoolMemberKey(member.userId, schoolId)),
                ]);
                if (account && account.platformStatus === 'active' && account.primarySchoolId === schoolId
                    && schoolMember && schoolMember.userId === member.userId && schoolMember.schoolId === schoolId
                    && schoolMember.status === 'active') { next = member; break; }
              }
              if (!next && !last) return { scanNext: true };
            }
            if (active) await tx.teamMembers.set(current._id, {
              ...current, status: TEAM_MEMBER_STATUS.LEFT, leftAt: now, updatedAt: now,
            });
            const patch = { ...team, revision: Number(team.revision || 1) + 1,
              memberCount: Math.max(0, Number(team.memberCount || 0) - Number(active)),
              updatedBy: actorId, updatedAt: now };
            let moved = 0, archived = 0;
            if (team.captainId === userId) {
              if (next) {
                patch.captainId = next.userId;
                await tx.teamMembers.set(next._id, { ...next, role: 'captain', updatedAt: now });
                moved = 1;
              } else {
                Object.assign(patch, { status: TEAM_STATUS.ARCHIVED, captainId: '', archivedAt: now, archivedReason: 'captain-left' });
                archived = 1;
              }
            }
            await tx.teams.set(team._id, patch);
            await root.audit.append({ _id: schoolKey('team-detach', team._id, userId, String(now || '')),
              action: 'detachUserFromTeams', schoolId, association, userId, actorId,
              teamId: team._id, detached: Number(active), captainMoved: moved, archived, at: now });
            return { done: true, detached: Number(active), moved, archived };
          });
          if (result.retry) break;
          if (result.done) {
            summary.detached += result.detached || 0;
            summary.captainMoved += result.moved || 0;
            summary.archived += result.archived || 0;
            completed = true;
            break;
          }
        }
      }
      if (!completed) throw new Error('球队名单正在变化，请重试球队清理');
    }
  }
  return summary;
}

module.exports = {
  listTeams,
  getTeam,
  createTeamApplication,
  reviewTeamApplication,
  applyToJoinTeam,
  reviewTeamMember,
  leaveTeam,
  transferTeamCaptain,
  archiveTeam,
  detachUserFromTeams,
  // 学院代表队（系统预置）：读、挑人、移除
  getCollegeTeam,
  addCollegeTeamMembers,
  removeCollegeTeamMember,
  collegeMemberCandidates,
  // 给「报名」用：按编号取院队，缺失时就地补建（见 resolveCollegeTeam）
  resolveCollegeTeam,
};
