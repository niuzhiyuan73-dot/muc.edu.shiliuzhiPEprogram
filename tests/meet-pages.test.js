/**
 * B4b：运动会三个页面的装配自检
 * ============================================================
 * 页面问题（require 路径写错、wxml 里 bindtap 指向不存在的方法、页面没注册）
 * 只有在开发者工具里点一遍才会暴露。这里用最小环境把 Page 配置抓下来，
 * 静态比对三件事：
 *   1. 三个页面都在 app.json 注册，且四件套齐备；
 *   2. wxml 里每一个 bind/catch 处理器都在 Page 配置里真实存在；
 *   3. 协会页（tabBar 第 2 页）里有运动会入口，且入口跳的是运动会列表（R01）；
 *   4. 列表页标题就是「历史运动会记录」（R02：只有一个一级标签）。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
// 页面已按域拆进分包，路径一律从 app.json 查，见 helpers/page-registry.js
const { pagePathOf, pageFileOf, isRegistered } = require('./helpers/page-registry.js');
const { instantiate } = require('./helpers/page-harness.js');

const PAGES = ['meet-list', 'meet-detail', 'meet-setup', 'meet-college', 'meet-schedule', 'meet-score', 'meet-standing'];

/** 抓住 Page(配置)：页面文件在 require 时调用 Page()。 */
function loadPage(name) {
  const file = path.join(MINI, pagePathOf(name));
  const saved = { Page: global.Page, wx: global.wx };
  let captured = null;
  global.Page = (config) => { captured = config; };
  global.wx = global.wx || {};
  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    global.Page = saved.Page;
    global.wx = saved.wx;
  }
  assert.ok(captured, `${name} 没有调用 Page()`);
  return captured;
}

/** wxml 里声明的所有事件处理器名（bindtap / catchtap / bindinput …） */
function handlersOf(name) {
  const file = pageFileOf(name, '.wxml');
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of source.matchAll(/(?:bind|catch)[a-z]*="([A-Za-z0-9_]+)"/g)) names.add(match[1]);
  return [...names];
}

test('运动会七个页面都已注册，且 js/json/wxml/wxss 齐备', () => {
  for (const name of PAGES) {
    assert.ok(isRegistered(name), `${name} 未在 app.json 注册（主包或分包）`);
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(pageFileOf(name, `.${ext}`)), `${name}.${ext} 缺失`);
    }
  }
});

test('wxml 里的每个事件处理器都在 Page 配置中', () => {
  for (const name of PAGES) {
    const page = loadPage(name);
    const missing = handlersOf(name).filter((handler) => typeof page[handler] !== 'function');
    assert.deepEqual(missing, [], `${name} 的 wxml 绑定了不存在的方法`);
  }
});

test('列表页标题为「历史运动会记录」，且只有一个一级标签', () => {
  const json = JSON.parse(fs.readFileSync(pageFileOf('meet-list', '.json'), 'utf8'));
  assert.equal(json.navigationBarTitleText, '历史运动会记录');

  // R02：列表页没有 tab 切换控件（不新增一级标签）
  const wxml = fs.readFileSync(pageFileOf('meet-list', '.wxml'), 'utf8');
  assert.equal(/tab-item|tabs|segmented/.test(wxml), false, '列表页不应出现一级标签切换');
});

test('协会页里有运动会入口，与协会并列并跳运动会列表（R01）', () => {
  const wxml = fs.readFileSync(pageFileOf('association', '.wxml'), 'utf8');
  assert.ok(/assoc-item-meet/.test(wxml), '协会网格里没有运动会入口');
  assert.ok(/bindtap="onChooseMeet"/.test(wxml), '运动会入口没有绑定跳转');

  const page = loadPage('association');
  assert.equal(typeof page.onChooseMeet, 'function');
});

test('列表页加载、搜索、分页与详情跳转都接到服务层', () => {
  const page = loadPage('meet-list');
  for (const method of ['reload', 'loadMore', 'onSearch', 'onYearChange', 'onStatusChange', 'onOpenMeet', 'onCreate']) {
    assert.equal(typeof page[method], 'function', `缺少 ${method}`);
  }
  assert.equal(page.data.years[0].value, '', '年份下拉第一项应为「全部年份」');
  assert.equal(page.data.statusOptions[0].value, '', '状态下拉第一项应为「全部状态」');
});

test('详情页与向导页的关键动作存在', () => {
  const detail = loadPage('meet-detail');
  for (const method of ['reload', 'onPublish', 'onDelete', 'onOpenSetup', 'onOpenAtChange', 'onCloseAtChange',
    'onInterest', 'onWithdrawInterest', 'onReview', 'onOpenCollege', 'onOpenSchedule', 'onOpenScore',
    'onOpenStanding']) {
    assert.equal(typeof detail[method], 'function', `详情页缺少 ${method}`);
  }
  const setup = loadPage('meet-setup');
  for (const method of ['loadTemplates', 'onNext', 'onToggleGroup', 'onStep', 'onSubmit', 'onCategoryTap',
    'onMembersInput', 'onLimitInput', 'onToggleMembersUnlimited', 'onToggleLimitUnlimited',
    'pickedFromEvents', 'persist']) {
    assert.equal(typeof setup[method], 'function', `向导页缺少 ${method}`);
  }
  // 带 meetId 进入时应直接落在第二步（继续配置）
  assert.equal(setup.data.step, 1, '无 meetId 时应从第一步开始');

  const college = loadPage('meet-college');
  for (const method of ['reload', 'onOpenEvent', 'onToggleApplicant', 'onSubmitEntry', 'onWithdrawEntry']) {
    assert.equal(typeof college[method], 'function', `学院工作台缺少 ${method}`);
  }

  const schedulePage = loadPage('meet-schedule');
  for (const method of ['reload', 'onSaveSession', 'onRemoveJudge', 'onStartSession',
    'onPublishSchedule', 'onPickSession', 'onOpenProcedure', 'onSaveProcedure', 'onDraw',
    'onProcPickRounds', 'onProcPickFormat', 'onProcInput',
    'onStartDateChange', 'onStartTimeChange',
    // 派裁判（顶部一块）：跨项目 / 跨场次 / 多人
    'onToggleAssignPanel', 'onAssignForEvent', 'assignTargetsOf', 'assignStateOf',
    'onToggleAssignEvent', 'onToggleAssignSession', 'onAssignAll', 'onAssignClear',
    'onAssignKeyword', 'onMoreAssignJudges', 'onToggleAssignJudge', 'onRemoveAssignJudge',
    'onSubmitAssign', 'onOpenChief', 'onPickChief', 'onRevokeChiefJudge']) {
    assert.equal(typeof schedulePage[method], 'function', `赛程编排页缺少 ${method}`);
  }

  const standingPage = loadPage('meet-standing');
  for (const method of ['reload', 'onOpenDetail']) {
    assert.equal(typeof standingPage[method], 'function', `总榜页缺少 ${method}`);
  }

  const scorePage = loadPage('meet-score');
  for (const method of ['reload', 'onOpenSession', 'onSubmitScore', 'onOpenEvent', 'onToggleVoid', 'onPublish',
    // 晋级与判胜留在录分页；分组与签表在赛程编排页
    'onPickRound', 'onAdvance', 'onSetWinner', 'decorateEvent', 'decorateBracket',
    // B9c：录分时在同项目的场次之间切换
    'openSession', 'loadEventSessions', 'onPickScoreSession', 'onNextSession']) {
    assert.equal(typeof scorePage[method], 'function', `录分页缺少 ${method}`);
  }
});


test('底部操作报错弹出可见提示，选择状态可供 WXML 直接索引', () => {
  const {updateMeetPage}=require('../miniprogram/utils/meet-ui.js');
  const previous=global.wx, messages=[];
  global.wx={showModal:opts=>messages.push(opts.content)};
  const page={data:{},setData(values){Object.assign(this.data,values);}};
  try {
    updateMeetPage(page,{error:'晋级容量不足',bulkJudges:['j1','j2']});
    assert.deepEqual(messages,['晋级容量不足']);
    assert.equal(page.data.bulkJudgesSelected.j2,true);
    updateMeetPage(page,{bulkJudges:['j1']});
    assert.equal(page.data.bulkJudgesSelected.j2,undefined);
  } finally {global.wx=previous;}
});


test('录分提交携带代录裁判，并保留其他未提交输入', async () => {
  const config=loadPage('meet-score'), calls=[];
  const page={...config,data:{...config.data,activeSessionKey:'session',scoringJudgeId:'judge',drafts:{a:'12.30',b:'13.40'}}};
  page.setData=values=>Object.assign(page.data,values);
  page.client=()=>({saveMeetJudgeScore:async p=>calls.push(p),submitMeetJudgeScore:async p=>calls.push(p)});
  page.openSession=async()=>{page.data.drafts={a:'12.30',b:''};};
  await page.onSubmitScore({currentTarget:{dataset:{entryKey:'a'}}});
  assert.equal(calls.length,2);
  assert.equal(calls[0].judgeId,'judge');
  assert.equal(calls[1].judgeId,'judge');
  assert.equal(page.data.drafts.b,'13.40');
});

test('WXML 选择状态不使用数组方法，标签正确闭合', () => {
  for(const name of PAGES){
    const source=fs.readFileSync(pageFileOf(name, '.wxml'),'utf8').replace(/<!--[\s\S]*?-->/g,'');
    assert.equal(/\.indexOf\(/.test(source),false,name);
    const stack=[];
    for(const tag of source.matchAll(/<\/?[a-zA-Z][\w-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g)){
      const text=tag[0], type=/^<\/?([\w-]+)/.exec(text)[1];
      if(text.startsWith('</')) assert.equal(stack.pop(),type,name+': '+text);
      else if(!text.endsWith('/>'))stack.push(type);
    }
    assert.deepEqual(stack,[],name);
  }
});


test('派裁判面板：已派裁判带出并计数，候选里不再出现已选的人', () => {
  const page = loadPage('meet-schedule');
  const targets = [{
    eventKey: 'e1', name: '100 米', groupLabel: '男子', entryText: '32 人',
    pendingText: '', sessionCount: 2,
    sessions: [
      { sessionKey: 's1', label: '预赛 第 1 组', judges: [{ judgeId: 'j1', name: '甲' }, { judgeId: 'j2', name: '乙' }, { judgeId: 'j3', name: '丙' }] },
      { sessionKey: 's2', label: '决赛', judges: [] },
    ],
  }];
  const pool = ['j1', 'j2', 'j3', 'j4'].map((id) => ({ userId: id, name: id, collegeName: '' }));

  // 只选第 1 组：3 个已派裁判自动带出，「选裁判」不再是 0
  let state = page.assignStateOf(['s1'], targets, pool, []);
  assert.equal(state.assignJudgeCount, 3);
  assert.equal(state.assignAssignedCount, 3);
  assert.deepEqual(state.assignCandidates.map((row) => row.userId), ['j4'], '已选的人不再出现在候选里');

  // 再加一个 → 4 人；新加的那个可以撤，已派的没有 ×
  state = page.assignStateOf(['s1'], targets, pool, ['j4']);
  assert.equal(state.assignJudgeCount, 4);
  assert.equal(state.assignAssignedCount, 3);
  assert.equal(state.assignCoverage.j4, undefined);

  // 项目行三态：只选了 2 场里的 1 场 = 部分选中
  assert.deepEqual(state.assignEventState.e1, { all: false, some: true, count: 1 });
  state = page.assignStateOf(['s1', 's2'], targets, pool, []);
  assert.deepEqual(state.assignEventState.e1, { all: true, some: false, count: 2 });
});

test('派裁判只列已有场次的项目，并带上报名人数', () => {
  const page = loadPage('meet-schedule');
  const targets = page.assignTargetsOf([
    { eventKey: 'e1', name: '100 米', group: 'male', entryCount: 32, entryUnit: '人', pendingCount: 2, sessions: [{ sessionKey: 's1', displayLabel: '决赛', judges: [] }] },
    { eventKey: 'e2', name: '跳远', group: 'female', entryCount: 8, entryUnit: '人', pendingCount: 0, sessions: [] },
  ]);
  assert.deepEqual(targets.map((row) => row.eventKey), ['e1'], '没有场次的项目不该出现在派裁判列表里');
  assert.equal(targets[0].entryText, '32 人');
  assert.equal(targets[0].pendingText, '2 待审');
});

test('三个运动会页面只注册一次卸载处理，并取消待发请求和卸载后的更新', async () => {
  const [schedule, college, setup] = ['meet-schedule', 'meet-college', 'meet-setup'].map(name => {
    const source = fs.readFileSync(pageFileOf(name, '.js'), 'utf8');
    assert.equal([...source.matchAll(/^\s*onUnload\s*\(/gm)].length, 1, name);
    return instantiate(loadPage(name));
  });
  const calls = [];
  const candidates = async ({ keyword }) => { calls.push(keyword); return { items: [] }; };
  schedule.client = college.client = () => ({ listMeetJudgeCandidates: candidates });
  setup.persist = async () => { calls.push('save'); };
  setup.data.picked = [{ key: 'event', members: 2 }];

  schedule.onAssignKeyword({ detail: { value: 'assign' } });
  schedule.onChiefKeyword({ detail: { value: 'chief' } });
  college.onLeadKeyword({ detail: { value: 'lead' } });
  await setup.applyChange(0, { members: 3 }, { debounce: true });
  for (const page of [schedule, college, setup]) {
    page.onUnload();
    assert.equal(page.unloaded, true);
    page.setData = () => calls.push('setData');
    page.update({ busy: false });
  }

  await new Promise(resolve => setTimeout(resolve, 425));
  assert.deepEqual(calls, []);
});

test('meet-detail 发布报名与开放补报窗口的提交格式与服务端校验一致', async () => {
  const detail = instantiate(loadPage('meet-detail'));
  const meetService = require('../src/server/services/meet-service');
  const regService = require('../src/server/services/meet-registration-service');
  const { createSchoolMemoryRepo } = require('../miniprogram/services/school-memory-repo');
  const { buildMeetContext } = require('../src/server/services/meet-context');

  const repo = createSchoolMemoryRepo({
    schools: [{ _id: 'muc', schoolId: 'muc', name: '中央民族大学', status: 'active' }],
    users: [{ _id: 'adm1', openId: 'adm1', platformRole: 'admin', platformStatus: 'active', primarySchoolId: 'muc' }],
    schoolMembers: [{ _id: 'sm:muc:adm1', schoolId: 'muc', userId: 'adm1', collegeId: 'c01', status: 'active' }],
  });
  const now = new Date('2026-11-16T00:00:00Z');
  const ctxOf = (meetId = '') => buildMeetContext({ repo, actorId: 'adm1', scope: { schoolId: 'muc', meetId }, now });
  const created = await meetService.createSportsMeet({
    name: '页面报名发布验证', year: 2026, startDate: '2026-11-20', endDate: '2026-11-21',
  }, await ctxOf());
  const meetId = created.data.meet.meetId;
  await meetService.configureMeetEvent({ templateId: 'sprint-100m', group: 'male', perCollegeLimit: 4 }, await ctxOf(meetId));

  detail.data.schoolId = 'muc';
  detail.data.meetId = meetId;
  detail.data.openAt = '2026-11-01';
  detail.data.closeAt = '2026-11-18';
  detail.data.lateStartDate = '2026-11-19';
  detail.data.lateStartTime = '08:00';
  detail.data.lateEndDate = '2026-11-19';
  detail.data.lateEndTime = '20:00';
  detail.reload = async () => {};
  detail.client = () => ({
    publishMeetRegistration: async (payload) => {
      const res = await meetService.publishMeetRegistration(payload, await ctxOf(meetId));
      if (!res.ok) throw new Error(res.message);
      return res.data;
    },
    openMeetLateWindow: async (payload) => {
      const res = await regService.openMeetLateWindow(payload, await ctxOf(meetId));
      if (!res.ok) throw new Error(res.message);
      return res.data;
    },
  });

  await detail.onPublish();
  assert.equal(detail.data.error, '');
  assert.equal(detail.data.notice, '报名已发布');

  await detail.onSubmitLateWindow();
  assert.equal(detail.data.error, '');
  assert.equal(detail.data.notice, '补报窗口已开放');
});

