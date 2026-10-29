/** 学校身份演示仓储。写事务排队，草稿提交/回滚，读写均复制对象。 */
const { schoolScope, SCHOOL_MEMBER_STATUS } = require('../utils/school.js');
const { MEET_COLLECTIONS, meetScope } = require('../utils/meet-scope.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const { memoryMatchPage } = require('./match-list-query');
const { attachTeamReads, fieldValues } = require('./scoped-team-reads.js');
const { memoryDirectoryPage, memoryDirectoryCount } = require('./account-directory.js');
const { memoryPersonalPage } = require('./personal-sports-query.js');
const { attachOverviewReads, memoryOverviewIO } = require('./school-overview-reads.js');
const { pageOfCollection } = require('./event-list-page.js');
/**
 * 带 eventId 的「从属集合」：按赛事取子集用 listByEvent（条件查询 + 索引），
 * 不整表读完再内存过滤。顶层与 forScope 两处都要提供，方法面与云端
 * （cloud-repo.js / school-repository.js）逐字一致，由契约测试守住。
 */
const EVENT_SCOPED = ['matches', 'eventSignups', 'collegeEntries', 'ties', 'lineups',
  // 团队运动：报名 / 比赛 / 统计同样按赛事取子集（与云端 school-repository.js 一致）
  'teamEventEntries', 'teamMatches', 'teamMatchStats'];
const KEYS = ['users', 'schools', 'schoolAssociations', 'colleges', 'schoolMembers', 'schoolRoles', 'memberships', 'studentIdClaims', 'auditLogs',
  'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
  'associationGroups', 'associationGroupMembers',
  'associationNotices', 'associationTrainings', 'trainingRegistrations',
  'announcements',
  'events', 'eventSignups', 'matches', 'liveScores',
  'collegeEvents', 'collegeEntries', 'ties', 'lineups',
  // M4：赛季文档（每范围一份，_id 由 scopeKey 组成，跨范围读不到也改不掉）
  'seasons',
  // 交手名额计数：每对每赛季一条，_id 由 scope + 赛季号 + 两人编号组成
  'pairCounts',
  // 会员评级表：每「学校 + 协会 + 用户 + 池」一条，_id 由 memberRatingKey 组成
  'memberRatings',
  // 结算序号计数：每「学校 + 协会」一条，_id 由 ratingSeqKey 组成
  'ratingCounters',
  // 团队运动（篮球/足球/排球）：球队 / 队员 / 赛事 / 报名 / 比赛 / 统计，
  // 与个人赛彻底分开，按「学校 + 协会」归属（与云端 SCOPED 同口径）
  'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
  // 运动会：学校级业务，与协会无关。12 个集合一律以 schoolId + meetId 归属，
  // 范围校验走 forMeet（与云端 attachSchoolRepository 同口径）。
  ...MEET_COLLECTIONS,
  // 学院部长授权：学校级常设角色，一院一条。
  'sportsMeetCollegeLeads'];

function createSchoolMemoryRepo(seed = {}) {
  let state = Object.fromEntries(KEYS.map(key => [key, new Map((seed[key] || []).map(doc => [doc._id, clone(doc)]))]));
  let queue = Promise.resolve();
  const build = (getState, inTx) => {
    const repo = {};
    repo.personalSports = { readPage: async (source, auth, query) => {
      if (inTx) throw new Error('事务内不允许个人体育查询');
      return memoryPersonalPage(key => [...getState()[key].values()].map(clone), source, auth, query);
    } };
    for (const key of KEYS) {
      repo[key] = {
        getById: async id => clone(getState()[key].get(id) || null),
        set: async (id, doc) => { getState()[key].set(id, clone({ ...doc, _id: id })); },
        list: async () => {
          if (inTx) throw new Error('事务内不可查询集合');
          return [...getState()[key].values()].map(clone);
        },
      };
    }
    repo.memberships.get = repo.memberships.getById;
    // 按一批 userId 取账号：与云端 listByIds 同口径（云端非事务走 `_.in` 批查、
    // 事务内退化为逐条点读；这里两者都是点取）。业务用它替掉「读全平台 users
    // 再建 Map」——users 是平台级集合，全表读会随别校用户增长而变慢
    // （2026-10-21 审查 P0-1）。
    repo.users.listByIds = async ids => {
      const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id))];
      return uniq
        .map(id => getState().users.get(id))
        .filter(Boolean)
        .map(clone);
    };
    // 同一 OpenID 可能留下两条账号（旧协议 `u_…` 与协议 2 `acc:…`）。这里与
    // 云端适配器同口径：按 _id 升序取定，让「解析到哪一条」确定、可复现
    // （见 2026-10-16 只读审计 H5 / P1）。
    repo.users.getByOpenId = async openId => (await repo.users.list())
      .filter(user => user.openId === openId)
      .sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))[0] || null;
    repo.audit = { append: async entry => {
      if (!entry._id) throw new Error('审计记录缺少 ID');
      await repo.auditLogs.set(entry._id, entry);
    } };
    // 受范围限制的集合：与云端 attachSchoolRepository 的 SCOPED_COLLECTIONS 对齐
    // （由 tests/for-scope-contract.test.js 守护）。两端必须逐字一致——原先云端多一个
    // `rankings` 并作为例外列在契约测试里；Elo 改为逐场结算后它已无任何读写，已删除。
    const SCOPED = [
      'exchangeEvents', 'exchangeInvitations', 'exchangeSignups', 'exchangeMatches',
      'colleges', 'schoolMembers', 'schoolRoles', 'schoolAssociations', 'memberships',
      'matches', 'events', 'eventSignups', 'announcements',
      'collegeEvents', 'collegeEntries', 'ties', 'lineups', 'liveScores', 'seasons',
      'associationGroups', 'associationGroupMembers',
      'associationNotices', 'associationTrainings', 'trainingRegistrations',
      'pairCounts', 'memberRatings', 'ratingCounters',
      // 团队运动：按「学校 + 协会」双维度归属
      'teams', 'teamMembers', 'teamEvents', 'teamEventEntries', 'teamMatches', 'teamMatchStats',
      // 学院部长授权：学校级（只按 schoolId 判归属，见 SCHOOL_SCOPED）
      'sportsMeetCollegeLeads',
    ];
    // 只按学校（不带协会）判归属的集合：学院目录 / 身份 / 校级角色是学校级的。
    // `announcements` 2026-10-18 起也归到这一档：公告只有管理员能发，且发的是
    // 全校信息，不该因为发布时正停在哪家协会而只在那家协会可见。
    const SCHOOL_SCOPED = ['colleges', 'schoolMembers', 'schoolRoles', 'sportsMeetCollegeLeads', 'announcements'];
    // 按赛事取子集用 listByEvent（清单见文件顶部的 EVENT_SCOPED）
    repo.forScope = input => {
      const scope = schoolScope(input);
      const result = { scope };
      for (const key of SCOPED) {
        const expected = SCHOOL_SCOPED.includes(key)
          ? { schoolId: scope.schoolId }
          : { schoolId: scope.schoolId, association: scope.association };
        const owns = doc => Boolean(doc) && Object.keys(expected).every(field => doc[field] === expected[field]);
        const checked = doc => {
          for (const field of Object.keys(expected)) {
            if (doc[field] !== undefined && doc[field] !== expected[field]) {
              throw new Error('不能写入其他学校或协会的数据');
            }
          }
          return { ...doc, ...expected };
        };
        const write = async (id, doc, mode) => {
          if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
          if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
          const patch = checked(doc);
          const current = await repo[key].getById(id);
          if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
          if (current && mode === 'insert') throw new Error('记录已存在');
          if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
          const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
          await repo[key].set(id, next);
          return next;
        };
        result[key] = {
          list: async () => (await repo[key].list()).filter(owns),
          getById: async id => {
            const doc = await repo[key].getById(id);
            return owns(doc) ? doc : null;
          },
          set: (id, doc) => write(id, doc, 'set'),
          insert: doc => write(doc._id, doc, 'insert'),
          update: (id, patch) => write(id, patch, 'update'),
        };
        // 按赛事取子集：与云端 listByEvent 同口径（WHERE eventId = ?）。
        // 云端若不用条件查询，就是整表翻页后内存过滤——比赛一多，打开一次详情
        // 要读十几页 RPC，叠上每日读配额会撑不住（见 docs/数据库索引清单.md）。
        if (EVENT_SCOPED.includes(key)) {
          result[key].listByEvent = async eventId => (await repo[key].list())
            .filter(doc => owns(doc) && doc.eventId === eventId);
        }
        // 批量点取（与云端 listByIds 同口径）：赛事列表标「我报名了没」、
        // 名录页给每一行算权限标签，都可以一页只发一次调用（2026-10-22 H-3／H-5）。
        // `owns` 校验是这条路径的安全底线：主键可能来自调用方。
        if (EVENT_SCOPED.includes(key) || key === 'schoolRoles' || key === 'memberships'
          || key === 'schoolMembers' || key === 'memberRatings') {
          result[key].listByIds = async ids => {
            if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
            const uniq = [...new Set((Array.isArray(ids) ? ids : [])
              .filter(id => typeof id === 'string' && id))];
            const out = [];
            for (const id of uniq) {
              const doc = await repo[key].getById(id);
              if (owns(doc)) out.push(doc);
            }
            return out;
          };
        }
        // 名册分页 / 按状态计数 / 按学号取（2026-10-26 第四轮审查 P-2 / P-3 / P-7）：
        // 与云端同一套语义（`_id` 游标 + 多取一条判 hasMore），两端口径分叉会让
        // 「本地能翻页、云端翻不动」变成只在真机出现的毛病。
        if (key === 'schoolMembers') {
          result[key].listByStatus = async (status, options = {}) => {
            if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
            if (typeof status !== 'string' || !status) return { rows: [], hasMore: false };
            const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
            const afterId = typeof options.afterId === 'string' ? options.afterId : '';
            const rows = (await repo[key].list())
              .filter(doc => owns(doc) && doc.status === status
                && (!options.collegeId || doc.collegeId === options.collegeId)
                && (!afterId || String(doc._id) > afterId))
              .sort((a, b) => String(a._id).localeCompare(String(b._id)));
            return { rows: rows.slice(0, limit).map(clone), hasMore: rows.length > limit };
          };
          result[key].countByStatus = async status => (await repo[key].list())
            .filter(doc => owns(doc) && doc.status === String(status || '')).length;
          result[key].listByStudentId = async studentId => {
            if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
            if (typeof studentId !== 'string' || !studentId) return [];
            return (await repo[key].list())
              .filter(doc => owns(doc) && doc.studentId === studentId).map(clone);
          };
        }

        // 本赛季的比赛（`matchTime >= sinceIso`）：与云端 listSince 同口径。
        // 模拟端在内存里按 ISO 串比较——与云端字符串范围比较等价。
        if (key === 'matches') {
          result[key].listPage = async options => {
            if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
            const page = memoryMatchPage([...getState().matches.values()], scope, options);
            return { ...page, rows: page.rows.map(clone) };
          };
          result[key].listSince = async sinceIso => (await repo[key].list())
            .filter(doc => owns(doc) && (!sinceIso || String(doc.matchTime || '') >= sinceIso));
          // 「我的比赛（本赛季）」：与云端 listMineSince 同口径（2026-10-23 第三轮 X-7）。
          // 云端是「teamA / teamB 两支等值查询 + 按 _id 去重」（数组字段不能一条查完）；
          // 内存里一次过滤即等价——等值对数组字段就是「包含」。
          result[key].listMineSince = async (userId, sinceIso) => {
            if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
            if (typeof userId !== 'string' || !userId) return [];
            return (await repo[key].list()).filter(doc => owns(doc)
              && (!sinceIso || String(doc.matchTime || '') >= sinceIso)
              && ((doc.teamA || []).includes(userId) || (doc.teamB || []).includes(userId)));
          };
        }
        // 按人反查：与云端 listByUser 同口径（缺 userId 时返回空数组，
        // 不退化成整表读）。训练报名见 H-2，小组成员见 H-3，评级见方案 A 第 2 步
        // （个人主页要「我在这几个池里的评级」，不必读全范围）。
        if (key === 'trainingRegistrations' || key === 'associationGroupMembers' || key === 'memberRatings') {
          result[key].listByUser = async userId => {
            if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
            if (typeof userId !== 'string' || !userId) return [];
            return (await repo[key].list()).filter(doc => owns(doc) && doc.userId === userId);
          };
        }
        // 按训练取报名：与云端 listByTraining 同口径（缺 trainingId 返回空数组）。
        if (key === 'trainingRegistrations') {
          result[key].listByTraining = async trainingId => {
            if (inTx) throw new Error('事务内不允许条件读取（trainingRegistrations），请改用 getById');
            if (typeof trainingId !== 'string' || !trainingId) return [];
            return (await repo[key].list()).filter(doc => owns(doc) && doc.trainingId === trainingId);
          };
        }
        // 评级表的下推读（2026-10-23 方案 A 第 2 步）：与云端
        // memberRatings.listTop / countRanked 同口径。
        //
        // 【为什么门槛是 matchCount > 0】榜单只展示上过场的人（buildRows 同口径）。
        // 【为什么排序只到 elo + wins】名次由调用方用同一个比较器重算（胜率是派生
        // 字段，不进索引）。这里保持与数据库排序一致，免得「取哪一批」在两端分叉。
        if (key === 'memberRatings') {
          const matchesRanked = ({ pool, gender = null, memberStatus = SCHOOL_MEMBER_STATUS.ACTIVE, minElo = null, missingProfile = false }) => doc =>
            owns(doc)
            && (!pool || doc.pool === pool)
            && Number(doc.matchCount || 0) > 0
            && (missingProfile
              ? doc.memberStatus === undefined
              : (!memberStatus || doc.memberStatus === memberStatus)
                && (!gender || doc.gender === gender)
                && (minElo === null || minElo === undefined || Number(doc.elo) > Number(minElo)));
          result[key].listTop = async (options = {}) => {
            if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
            const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100));
            const hit = matchesRanked(options);
            return (await repo[key].list())
              .filter(hit)
              .sort((a, b) => Number(b.elo) - Number(a.elo)
                || Number(b.wins || 0) - Number(a.wins || 0)
                || String(a._id).localeCompare(String(b._id)))
              .slice(0, limit);
          };
          result[key].countRanked = async (options = {}) => {
            if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
            const hit = matchesRanked(options);
            return (await repo[key].list()).filter(hit).length;
          };
        }
      }
      attachTeamReads(result, {
        inTx, command: { in: values => ({ values }), and: parts => ({ parts }),
          gte: low => ({ low }), lte: high => ({ high }) },
        query: async (key, where) => [...getState()[key].values()]
          .filter(doc => (where.parts || [where]).every(part => Object.entries(part).every(([field, value]) =>
            fieldValues(doc, field).some(item => value && value.values ? value.values.includes(item)
              : value && value.low !== undefined ? item >= value.low
                : value && value.high !== undefined ? item <= value.high : item === value))))
          .map(clone),
        byIds: async (key, ids, fields) => [...new Set(ids)].map(id => getState()[key].get(id))
          .filter(doc => doc && Object.entries(fields).every(([field, value]) => doc[field] === value)).map(clone),
      });
      const overview = memoryOverviewIO(key => [...getState()[key].values()].map(clone));
      attachOverviewReads(result, { inTx, ...overview });
      // 赛事 / 学院赛列表：与云端同一份下推实现（2026-10-29 第十二轮审计）。
      for (const listKey of ['events', 'collegeEvents']) {
        if (!result[listKey]) continue;
        result[listKey].listPage = options => {
          if (inTx) throw new Error(`事务内不允许分页读取（${listKey}），请改用 getById`);
          return pageOfCollection(overview, scope, listKey, options);
        };
      }
      result.schoolMembers.listDirectoryPage = async options => {
        if (inTx) throw new Error('事务内不允许查询会员目录');
        return memoryDirectoryPage([...getState().schoolMembers.values()], [...getState().users.values()], scope, options);
      };
      // 与 listDirectoryPage 同一套过滤的计数（2026-10-29 第十一轮审计 P2-9）。
      result.schoolMembers.countDirectory = async options => {
        if (inTx) throw new Error('事务内不允许查询会员目录');
        return memoryDirectoryCount([...getState().schoolMembers.values()], [...getState().users.values()], scope, options);
      };
      if (!inTx) result.transaction = fn => repo.transaction(tx => fn(tx.forScope(scope)));
      return result;
    };
    // 运动会范围：{schoolId, meetId}，**不含 association**。与云端 forMeet 同口径，
    // 由 tests/meet-repo-contract.test.js 逐集合/逐方法守护两端一致。
    repo.forMeet = input => {
      const scope = meetScope(input);
      const expected = { schoolId: scope.schoolId, meetId: scope.meetId };
      const result = { scope };
      for (const key of MEET_COLLECTIONS) {
        const owns = doc => Boolean(doc) && Object.keys(expected).every(field => doc[field] === expected[field]);
        const checked = doc => {
          for (const field of Object.keys(expected)) {
            if (doc[field] !== undefined && doc[field] !== expected[field]) {
              throw new Error('不能写入其他学校或其他运动会的数据');
            }
          }
          return { ...doc, ...expected };
        };
        const write = async (id, doc, mode) => {
          if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
          if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');
          const patch = checked(doc);
          const current = await repo[key].getById(id);
          if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
          if (current && mode === 'insert') throw new Error('记录已存在');
          if (!current && mode === 'update') throw new Error('记录不存在或不属于当前范围');
          const next = { ...(mode === 'update' ? current : {}), ...patch, _id: id };
          await repo[key].set(id, next);
          return next;
        };
        result[key] = {
          list: async () => (await repo[key].list()).filter(owns),
          getById: async id => {
            const doc = await repo[key].getById(id);
            return owns(doc) ? doc : null;
          },
          set: (id, doc) => write(id, doc, 'set'),
          insert: doc => write(doc._id, doc, 'insert'),
          update: (id, patch) => write(id, patch, 'update'),
        };
        // 运动会录分页的两个下推（与云端 forMeet 同口径，2026-10-23 H-9）：
        // 本场次的报名按编号批读、成绩按 sessionKey 取，不再读一届全部。
        // 报名 / 场次 / 意向 / 成绩 / 发布快照 / 指派 / 结果行按「本项目」取：
        // 与云端 listByProject 同口径（第五轮 B 把七项统一）。
        if (key === 'sportsMeetEntries' || key === 'sportsMeetSessions' || key === 'sportsMeetInterests'
          || key === 'sportsMeetScores' || key === 'sportsMeetPublications'
          || key === 'sportsMeetJudgeAssignments' || key === 'sportsMeetResultRows') {
          result[key].listByProject = async projectKey => {
            if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
            if (typeof projectKey !== 'string' || !projectKey) return [];
            return (await repo[key].list()).filter(doc => owns(doc) && doc.eventKey === projectKey);
          };
        }
        if (key === 'sportsMeetScores' || key === 'sportsMeetJudgeAssignments') {
          result[key].listBySession = async sessionKey => {
            if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
            if (typeof sessionKey !== 'string' || !sessionKey) return [];
            return (await repo[key].list()).filter(doc => owns(doc) && doc.sessionKey === sessionKey);
          };
        }
        if (key === 'sportsMeetJudgeAssignments') {
          result[key].listByJudge = async judgeId => {
            if (inTx) throw new Error('事务内不允许条件读取（sportsMeetJudgeAssignments），请改用 getById');
            if (typeof judgeId !== 'string' || !judgeId) return [];
            return (await repo[key].list()).filter(doc => owns(doc) && doc.judgeId === judgeId);
          };
        }
        // 按人反查（2026-10-23 第三轮 X-9）：与云端 forMeet 同口径。
        // 意向按 `userId`、名单按 `userIds`（数组），缺参返回空数组不退化成整表读。
        if (key === 'sportsMeetInterests' || key === 'sportsMeetEntries') {
          const actorField = key === 'sportsMeetEntries' ? 'userIds' : 'userId';
          result[key].listByUser = async userId => {
            if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
            if (typeof userId !== 'string' || !userId) return [];
            return (await repo[key].list()).filter((doc) => {
              if (!owns(doc)) return false;
              const value = doc[actorField];
              return Array.isArray(value) ? value.includes(userId) : value === userId;
            });
          };
        }
      }
      if (!inTx) result.transaction = fn => repo.transaction(tx => fn(tx.forMeet(scope)));
      return result;
    };
    // 运动会集合的按校列举（列本届清单用；与云端同口径）
    for (const key of MEET_COLLECTIONS) {
      repo[key].listBySchool = async schoolId => (await repo[key].list())
        .filter(doc => doc.schoolId === schoolId);
    }
    // 学校级集合的按校列举（与云端 attachSchoolRepository 的 listBySchool 对齐）
    for (const key of SCHOOL_SCOPED) {
      repo[key].listBySchool = async schoolId => (await repo[key].list())
        .filter(doc => doc.schoolId === schoolId);
    }
    // 实时比分：一场一条，_id = 'ls_' + matchId。轮询按编号批量读
    // （与云端 liveScores.listByIds 同口径；逐条点读在轮询里要几十个 RTT）。
    repo.liveScores.listByIds = async ids => {
      const uniq = [...new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id))];
      return uniq.map(id => getState().liveScores.get(id)).filter(Boolean).map(clone);
    };
    repo.exchangeSignups.listByEvent = async eventId => (await repo.exchangeSignups.list()).filter(doc => doc.eventId === eventId);
    repo.exchangeMatches.listByEvent = async eventId => (await repo.exchangeMatches.list()).filter(doc => doc.eventId === eventId);
    // 顶层同样按赛事取子集：业务里既有 ctx.repo.forScope(...).matches.listByEvent，
    // 也有直接 ctx.repo.matches.listByEvent 的写法，两处都要有（与云端同口径）。
    for (const key of EVENT_SCOPED) {
      repo[key].listByEvent = async eventId => (await repo[key].list()).filter(doc => doc.eventId === eventId);
    }
    repo.exchangeInvitations.listByScope = input => repo.forScope(input).exchangeInvitations.list();
    return repo;
  };
  const repo = build(() => state, false);
  repo.transaction = fn => {
    const task = queue.then(async () => {
      // 【为什么只浅拷贝 Map，不再深拷贝整个库（2026-10-20 性能修正）】
      // 这里原先是 `new Map([...state[key]].map(([id, doc]) => [id, clone(doc)]))`
      // ——每个事务先把 52 个集合、约两千条文档整份深拷贝一遍。而 build() 的
      // 三个读写入口**本来就各自克隆**：getById 交出去的是副本、set 落进去的是
      // 副本、list 返回的也是副本。也就是说，事务只需要隔离「写」；「读」的
      // 隔离已经由那三处保证了，深拷贝这一层是重复劳动。
      //
      // 实测代价：page.test.js 的 292 条用例共耗 267s CPU，其中 clone 一项占
      // 47.5%（127s），加上它触发的 GC 后内存仓储占 67.7%。成因是库里 61%
      // 是从不被这些用例触碰的运动会演示数据（1202 条），每次都陪着一块儿拷。
      //
      // 浅拷贝为什么等价：doc 一旦从 Map 取出就已是对副本的再克隆，调用方怎么
      // 改都碰不到库里的原件；任何写入都必须经过 set()，而 set() 存的是
      // `clone({...doc, _id: id})`，只会写进 scratch 这张新 Map。所以回滚
      // （丢掉 scratch）依然完整，提交（state = scratch）依然是整批替换。
      // 前提是没有任何代码绕过 set 直接改 Map —— 本文件与全仓都没有这种写法。
      const scratch = Object.fromEntries(KEYS.map(key => [key, new Map(state[key])]));
      const result = await fn(build(() => scratch, true));
      state = scratch;
      return result;
    });
    queue = task.catch(() => {});
    return task;
  };
  return repo;
}

module.exports = { createSchoolMemoryRepo };
