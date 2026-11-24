/** 统一受范围学校仓储内核（云端与内存端共用唯一源头）。 */
const { schoolScope, SCHOOL_MEMBER_STATUS } = require('../../shared/utils/school.js');
const { MEET_COLLECTIONS, meetScope } = require('../../shared/utils/meet-scope.js');
const { attachTeamReads, unique } = require('./scoped-team-reads.js');
const { attachOverviewReads } = require('./school-overview-reads.js');
const { pageOfCollection } = require('./event-list-page.js');
const { applyPatch, assertPatchScopeSafe, isPartialUpdateEnabled } = require('./patch-utils.js');

// 集合清单与本地模拟仓储共用一份（src/server/services/school-collections.js）。
const {
  SCHOOL_ONLY, EVENT_SCOPED, SCOPED_COLLECTIONS, SCHOOL_COLLECTIONS,
} = require('./school-collections.js');

/**
 * 通用「受范围仓储」。
 *
 * 协会维度与运动会维度只有 `expected` 字段不同（前者 schoolId+association，
 * 后者 schoolId+meetId），读写校验、事务内点读、局部更新、事务包装完全一致。
 */
function buildScoped(repo, io, inTx, options) {
  const { keys, scope, expectedOf, surfaceOf, mismatchMessage } = options;
  const result = { scope };

  const READ_PAGE_SIZE = 100;
  const readUpTo = async (key, where, size, afterId) => {
    const out = [];
    let cursor = typeof afterId === 'string' ? afterId : '';
    while (out.length < size) {
      const want = Math.min(size - out.length, READ_PAGE_SIZE);
      const cond = { ...where };
      if (cursor) cond._id = io.cmd.gt(cursor);
      const rows = await io.top(key, cond, [{ field: '_id', direction: 'asc' }], want);
      if (!rows || rows.length === 0) break;
      out.push(...rows);
      cursor = rows[rows.length - 1]._id;
      if (rows.length < want) break;
    }
    return out;
  };

  for (const key of keys) {
    const expected = expectedOf(key);
    const owns = (doc) => doc && Object.keys(expected).every((field) => doc[field] === expected[field]);
    const checked = (doc) => {
      for (const field of Object.keys(expected)) {
        if (doc[field] !== undefined && doc[field] !== expected[field]) throw new Error(mismatchMessage);
      }
      return { ...doc, ...expected };
    };

    const write = async (id, doc, mode) => {
      if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('记录内容必须为对象');
      if (doc._id !== undefined && doc._id !== id) throw new Error('记录 ID 不一致');

      if (!inTx) {
        return repo.transaction((tx) => (mode === 'insert'
          ? surfaceOf(tx, scope)[key].insert(doc)
          : surfaceOf(tx, scope)[key][mode](id, doc)));
      }

      if (mode === 'update') {
        assertPatchScopeSafe(doc, expected, mismatchMessage, id);
        const current = await io.read(key, id);
        if (!current || !owns(current)) throw new Error('记录不存在或不属于当前范围');
        const cleanPatch = {};
        for (const [k, v] of Object.entries(doc)) {
          if (k === '_id' || v === undefined) continue;
          cleanPatch[k] = v;
        }
        const next = { ...applyPatch(current, cleanPatch), ...expected, _id: id };
        if (isPartialUpdateEnabled() && typeof io.update === 'function') {
          await io.update(key, id, cleanPatch, next);
        } else {
          await io.set(key, id, next);
        }
        return next;
      }

      const patch = checked(doc);
      const current = await io.read(key, id);
      if (current && !owns(current)) throw new Error('记录不存在或不属于当前范围');
      if (current && mode === 'insert') throw new Error('记录已存在');
      const next = { ...patch, _id: id };
      await io.set(key, id, next);
      return next;
    };

    result[key] = {
      list: () => repo[key].listByScope(scope),
      getById: async (id) => {
        const doc = await io.read(key, id);
        return owns(doc) ? doc : null;
      },
      set: (id, doc) => write(id, doc, 'set'),
      insert: (doc) => write(doc && doc._id, doc, 'insert'),
      update: (id, patch) => write(id, patch, 'update'),
      remove: async (id) => {
        if (!id || typeof id !== 'string') throw new Error('缺少记录 ID');
        const current = await io.read(key, id);
        if (!owns(current)) throw new Error('记录不存在或不属于当前范围');
        await io.remove(key, id);
      },
    };

    if (EVENT_SCOPED.includes(key)) {
      const scopeFields = SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association };
      result[key].listByEvent = (eventId) => io.query(key, { ...scopeFields, eventId });
      result[key].listByIds = (ids) => io.byIds(key, ids, scopeFields);
    }

    if (key === 'sportsMeetEntries' || key === 'sportsMeetSessions' || key === 'sportsMeetInterests'
      || key === 'sportsMeetScores' || key === 'sportsMeetPublications'
      || key === 'sportsMeetJudgeAssignments' || key === 'sportsMeetResultRows') {
      result[key].listByProject = (projectKey) => {
        if (typeof projectKey !== 'string' || !projectKey) return Promise.resolve([]);
        return io.query(key, { ...expected, eventKey: projectKey });
      };
    }
    if (key === 'sportsMeetScores' || key === 'sportsMeetJudgeAssignments') {
      result[key].listBySession = (sessionKey) => {
        if (typeof sessionKey !== 'string' || !sessionKey) return Promise.resolve([]);
        return io.query(key, { ...expected, sessionKey });
      };
    }
    if (key === 'sportsMeetJudgeAssignments') {
      result[key].listByJudge = (judgeId) => {
        if (typeof judgeId !== 'string' || !judgeId) return Promise.resolve([]);
        return io.query(key, { ...expected, judgeId });
      };
    }

    if (key === 'schoolMembers' || key === 'schoolRoles' || key === 'memberships'
      || key === 'memberRatings' || key === 'liveScores') {
      const scopeFields = key === 'memberships' || key === 'memberRatings' || key === 'liveScores'
        ? { schoolId: scope.schoolId, association: scope.association }
        : { schoolId: scope.schoolId };
      result[key].listByIds = async (ids) => {
        if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
        if (key === 'liveScores' && repo[key] && typeof repo[key].listByIds === 'function') {
          const rows = await repo[key].listByIds(ids);
          return (rows || []).filter((doc) => owns(doc));
        }
        return io.byIds(key, ids, scopeFields);
      };
    }

    if (key === 'schoolMembers') {
      result[key].listByStatus = async (status, options = {}) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        if (typeof status !== 'string' || !status) return { rows: [], hasMore: false };
        const limit = Math.max(1, Math.min(Number(options.limit) || 50, 200));
        const afterId = typeof options.afterId === 'string' ? options.afterId : '';
        const where = { schoolId: scope.schoolId, status };
        if (typeof options.collegeId === 'string' && options.collegeId) where.collegeId = options.collegeId;
        const rows = await readUpTo('schoolMembers', where, limit + 1, afterId);
        return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
      };
      result[key].countByStatus = (status) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        return io.count('schoolMembers', { schoolId: scope.schoolId, status: String(status || '') });
      };
      result[key].listByStudentId = (studentId) => {
        if (inTx) throw new Error('事务内不允许条件读取（schoolMembers），请改用 getById');
        if (typeof studentId !== 'string' || !studentId) return Promise.resolve([]);
        return io.query('schoolMembers', { schoolId: scope.schoolId, studentId });
      };
    }
  }

  if (result.matches) {
    result.matches.listPage = (options) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      return io.matchPage(scope, options);
    };
    result.matches.listSince = (sinceIso) => {
      const where = { schoolId: scope.schoolId, association: scope.association };
      if (typeof sinceIso === 'string' && sinceIso) where.matchTime = io.cmd.gte(sinceIso);
      return io.query('matches', where);
    };
    result.matches.listMineSince = (userId, sinceIso) => {
      if (inTx) throw new Error('事务内不允许条件读取（matches），请改用 getById');
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      const where = { schoolId: scope.schoolId, association: scope.association };
      if (typeof sinceIso === 'string' && sinceIso) where.matchTime = io.cmd.gte(sinceIso);
      return Promise.all([
        io.query('matches', { ...where, teamA: userId }),
        io.query('matches', { ...where, teamB: userId }),
      ]).then((rows) => unique(rows.flat()));
    };
  }

  if (result.memberships) result.memberships.listCollegeMembers = (collegeId) => {
    if (inTx) throw new Error('事务内不允许学院候选查询');
    if (typeof collegeId !== 'string' || !collegeId) return Promise.resolve([]);
    return io.query('memberships', {
      schoolId: scope.schoolId, association: scope.association, collegeId, status: 'active',
    });
  };

  for (const key of ['trainingRegistrations', 'associationGroupMembers', 'memberRatings', 'ratingAdjustments']) {
    if (!result[key]) continue;
    result[key].listByUser = (userId) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      return io.query(key, { schoolId: scope.schoolId, association: scope.association, userId });
    };
  }

  for (const key of ['sportsMeetInterests', 'sportsMeetEntries']) {
    if (!result[key]) continue;
    const actorField = key === 'sportsMeetEntries' ? 'userIds' : 'userId';
    result[key].listByUser = (userId) => {
      if (inTx) throw new Error(`事务内不允许条件读取（${key}），请改用 getById`);
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      return io.query(key, { ...expectedOf(key), [actorField]: userId });
    };
  }

  if (result.sportsMeetPublications) {
    result.sportsMeetPublications.listByParticipant = (userId) => {
      if (inTx) throw new Error('事务内不允许条件读取（sportsMeetPublications），请改用 getById');
      if (typeof userId !== 'string' || !userId) return Promise.resolve([]);
      return io.query('sportsMeetPublications', { ...expectedOf('sportsMeetPublications'), 'rows.userIds': userId });
    };
  }

  if (result.trainingRegistrations) {
    result.trainingRegistrations.listByTraining = (trainingId) => {
      if (inTx) throw new Error('事务内不允许条件读取（trainingRegistrations），请改用 getById');
      if (typeof trainingId !== 'string' || !trainingId) return Promise.resolve([]);
      return io.query('trainingRegistrations', {
        schoolId: scope.schoolId, association: scope.association, trainingId,
      });
    };
  }

  if (result.associationGroupMembers) {
    result.associationGroupMembers.listByGroup = (groupId) => {
      if (inTx) throw new Error('事务内不允许条件读取（associationGroupMembers），请改用 getById');
      if (typeof groupId !== 'string' || !groupId) return Promise.resolve([]);
      return io.query('associationGroupMembers', {
        schoolId: scope.schoolId, association: scope.association, groupId,
      });
    };
  }

  if (result.memberRatings) {
    const rankedWhere = ({
      pool, gender = null, memberStatus = SCHOOL_MEMBER_STATUS.ACTIVE, minElo = null,
      missingProfile = false,
    }) => {
      const where = {
        schoolId: scope.schoolId,
        association: scope.association,
        matchCount: io.cmd.gt(0),
      };
      if (pool) where.pool = pool;
      if (missingProfile) {
        where.memberStatus = io.cmd.exists(false);
        return where;
      }
      if (memberStatus) where.memberStatus = memberStatus;
      if (gender) where.gender = gender;
      if (minElo !== null && minElo !== undefined) where.elo = io.cmd.gt(minElo);
      return where;
    };
    result.memberRatings.listTop = (options = {}) => {
      if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
      const limit = Math.max(1, Math.min(Number(options.limit) || 10, 100));
      return io.top('memberRatings', rankedWhere(options), [
        { field: 'elo', direction: 'desc' },
        { field: 'wins', direction: 'desc' },
        { field: '_id', direction: 'asc' },
      ], limit);
    };
    result.memberRatings.countRanked = (options = {}) => {
      if (inTx) throw new Error('事务内不允许条件读取（memberRatings），请改用 getById');
      return io.count('memberRatings', rankedWhere(options));
    };
  }

  if (!inTx) result.transaction = (fn) => repo.transaction((tx) => fn(surfaceOf(tx, scope)));
  attachTeamReads(result, { inTx, query: io.query, byIds: io.byIds, command: io.cmd });
  attachOverviewReads(result, { inTx, top: io.top, count: io.count, command: io.cmd });

  if (result.schoolMembers) {
    result.schoolMembers.listDirectoryPage = (options) => {
      if (inTx) throw new Error('事务内不允许查询会员目录');
      return io.memberPage(scope, options);
    };
    result.schoolMembers.countDirectory = (options) => {
      if (inTx) throw new Error('事务内不允许查询会员目录');
      if (!io.memberCount) throw new Error('会员目录计数适配器未接入');
      return io.memberCount(scope, options);
    };
  }

  for (const key of ['events', 'collegeEvents']) {
    if (!result[key]) continue;
    result[key].listPage = (options) => {
      if (inTx) throw new Error(`事务内不允许分页读取（${key}），请改用 getById`);
      return pageOfCollection(io, scope, key, options);
    };
  }

  return result;
}

function attachSchoolRepository(repo, io, inTx) {
  repo.personalSports = {
    readPage: (source, auth, query) => {
      if (inTx) throw new Error('事务内不允许个人体育查询');
      if (!io.personalPage) throw new Error('个人体育查询适配器未接入');
      return io.personalPage(source, auth, query);
    },
  };

  for (const key of SCHOOL_COLLECTIONS) {
    repo[key] = {
      getById: (id) => io.read(key, id),
      set: (id, doc) => io.set(key, id, doc),
      list: () => io.query(key, {}),
      ...(typeof io.remove === 'function' ? { remove: (id) => io.remove(key, id) } : {}),
      ...(typeof io.update === 'function' ? { update: (id, patch, fallback) => io.update(key, id, patch, fallback) } : {}),
    };
  }

  for (const key of SCOPED_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = schoolScope(input);
      return io.query(key, SCHOOL_ONLY.includes(key) ? { schoolId: scope.schoolId } : scope);
    };
  }

  for (const key of SCHOOL_ONLY) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  for (const key of MEET_COLLECTIONS) {
    repo[key].listBySchool = (schoolId) => io.query(key, { schoolId: String(schoolId || '') });
  }
  for (const key of MEET_COLLECTIONS) {
    repo[key].listByScope = (input) => {
      const scope = meetScope(input);
      return io.query(key, { schoolId: scope.schoolId, meetId: scope.meetId });
    };
  }

  repo.exchangeSignups.listByEvent = (eventId) => io.query('exchangeSignups', { eventId });
  repo.exchangeMatches.listByEvent = (eventId) => io.query('exchangeMatches', { eventId });

  repo.forScope = (input) => {
    const scope = schoolScope(input);
    return buildScoped(repo, io, inTx, {
      keys: SCOPED_COLLECTIONS,
      scope,
      expectedOf: (key) => (SCHOOL_ONLY.includes(key)
        ? { schoolId: scope.schoolId }
        : { schoolId: scope.schoolId, association: scope.association }),
      surfaceOf: (tx, next) => tx.forScope(next),
      mismatchMessage: '不能写入其他学校或协会的数据',
    });
  };

  repo.forMeet = (input) => {
    const scope = meetScope(input);
    return buildScoped(repo, io, inTx, {
      keys: MEET_COLLECTIONS,
      scope,
      expectedOf: () => ({ schoolId: scope.schoolId, meetId: scope.meetId }),
      surfaceOf: (tx, next) => tx.forMeet(next),
      mismatchMessage: '不能写入其他学校或其他运动会的数据',
    });
  };

  return repo;
}

module.exports = {
  SCHOOL_COLLECTIONS,
  SCOPED_COLLECTIONS,
  MEET_COLLECTIONS,
  attachSchoolRepository,
};
