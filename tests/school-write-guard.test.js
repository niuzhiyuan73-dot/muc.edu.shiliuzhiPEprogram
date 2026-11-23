/**
 * 学校维度（协议 2）写动作的故障收敛 —— 单元测试
 * ============================================================
 * 要守住的三件事：
 *   1. 门面里每个「非读动作」都在 SCHOOL_WRITE_ACTIONS 里——漏一个，那一页
 *      在云端故障时提交按钮会永久卡死（submitting 停在 true）；
 *   2. 名单里不许混进读动作——多一个，读失败会被收敛成 {ok:false} 伪装成
 *      「没有内容」；
 *   3. requestFor 真的按名单分了流：写动作抛错收敛成 {ok:false}，读动作仍拒绝。
 *
 * 判据「读动作 = get / list 起头」来自 write.js 的说明，本文件双向校验它：
 * 门面里非读动作必须在名单里，名单里不许有读动作。
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { SCHOOL_WRITE_ACTIONS, isSchoolWriteAction } = require('../miniprogram/utils/write.js');
const cloud = require('../miniprogram/services/school-cloud.js');

const SCOPE = { schoolId: 'muc', association: 'pkb' };
const CLIENTS = {
  identity: cloud.forSchoolIdentity(SCOPE),
  space: cloud.forAssociationSpace(SCOPE),
  exchange: cloud.forExchange(SCOPE),
  // 运动会门面不带 association：只传 schoolId（见 meet-scope 的 meetRequestScope）
  meet: cloud.forMeet({ schoolId: SCOPE.schoolId }),
};

/** 读动作判据：学校维度的读动作一律以 get / list 起头（见 write.js 的说明）。 */
const isReadName = (name) => /^(get|list)/.test(name);

function allMethodNames() {
  const names = [];
  for (const [group, api] of Object.entries(CLIENTS)) {
    for (const name of Object.keys(api)) names.push({ group, name });
  }
  return names;
}

describe('学校维度写动作名单 —— 与门面双向对齐', () => {
  test('门面里每个非读动作都在写动作名单里', () => {
    const missing = allMethodNames()
      .filter(({ name }) => !isReadName(name) && !isSchoolWriteAction(name))
      .map(({ group, name }) => `${group}.${name}`);
    assert.deepEqual(missing, [], '这些动作会改数据却没进 SCHOOL_WRITE_ACTIONS，云端故障时页面会卡死');
  });

  test('名单里没有读动作', () => {
    const wrong = SCHOOL_WRITE_ACTIONS.filter(isReadName);
    assert.deepEqual(wrong, [], '读动作不该套写守卫，读失败要能被页面看见');
  });

  test('名单里的名字都是真实门面方法', () => {
    const known = new Set(allMethodNames().map(({ name }) => name));
    const orphan = SCHOOL_WRITE_ACTIONS.filter((name) => !known.has(name));
    assert.deepEqual(orphan, [], '名单里有门面不存在的动作名');
  });

  test('名单没有重复项', () => {
    assert.equal(new Set(SCHOOL_WRITE_ACTIONS).size, SCHOOL_WRITE_ACTIONS.length);
  });
});

describe('requestFor —— 写动作收敛、读动作放行', () => {
  async function withWx(wx, fn) {
    const saved = global.wx;
    if (wx === undefined) delete global.wx; else global.wx = wx;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete global.wx; else global.wx = saved;
    }
  }

  test('云开发未初始化时，写动作返回 {ok:false} 而不是拒绝', async () => {
    await withWx(undefined, async () => {
      const result = await CLIENTS.space.publishSchoolEvent({ title: 'x' });
      assert.equal(result.ok, false, '写动作不该把异常抛给页面');
      assert.match(result.message, /云开发尚未初始化/);
      assert.equal(result.firstError, result.message);
      assert.deepEqual(result.errors, {});
      assert.deepEqual(result.scoreErrors, []);
    });
  });

  test('云开发未初始化时，读动作仍然拒绝（故障不被伪装成空数据）', async () => {
    await withWx(undefined, async () => {
      await assert.rejects(() => CLIENTS.space.listSchoolEvents({}), /云开发尚未初始化/);
    });
  });

  test('callFunction 抛错时，写动作被接住', async () => {
    const wx = { cloud: { callFunction: async () => { throw new Error('云环境未就绪'); } } };
    await withWx(wx, async () => {
      const result = await CLIENTS.exchange.submitExchangeScore({ matchId: 'm1' });
      assert.equal(result.ok, false);
      assert.match(result.message, /云环境未就绪/);
    });
  });

  test('服务端返回 {ok:false} 时，写动作把它变成同形的失败（页面能提示）', async () => {
    const wx = { cloud: { callFunction: async () => ({ result: { ok: false, message: '赛事已结束，不能再改比分' } }) } };
    await withWx(wx, async () => {
      const result = await CLIENTS.exchange.submitExchangeScore({ matchId: 'm1' });
      assert.equal(result.ok, false);
      assert.match(result.message, /已结束/);
    });
  });

  test('成功路径原样透传 data，不被包装', async () => {
    const payload = { ok: true, event: { _id: 'e1' } };
    const wx = { cloud: { callFunction: async () => ({ result: { ok: true, data: payload } }) } };
    await withWx(wx, async () => {
      const result = await CLIENTS.space.publishSchoolEvent({});
      assert.equal(result, payload, '成功结果应当就是服务端返回的那个对象');
    });
  });

  test('读动作成功时同样原样透传', async () => {
    const payload = { ok: true, events: [] };
    const wx = { cloud: { callFunction: async () => ({ result: { ok: true, data: payload } }) } };
    await withWx(wx, async () => {
      const result = await CLIENTS.space.listSchoolEvents({});
      assert.equal(result, payload);
    });
  });

  test('运动会门面（throwOnRefused）写动作遇到业务拒绝或故障时继续抛出异常，不被 guardWrite 吞掉', async () => {
    const refusedWx = {
      cloud: {
        callFunction: async () => ({
          result: { ok: true, data: { ok: false, message: '报名已截止，不能再提交意向' } },
        }),
      },
    };
    await withWx(refusedWx, async () => {
      await assert.rejects(() => CLIENTS.meet.submitMeetInterest({ eventKey: 'e1' }), /报名已截止/);
    });
    await withWx(undefined, async () => {
      await assert.rejects(() => CLIENTS.meet.finishSportsMeet({}), /云开发尚未初始化/);
    });
  });
});
