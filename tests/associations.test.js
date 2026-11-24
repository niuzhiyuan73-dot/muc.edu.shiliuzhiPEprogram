/**
 * 协会注册表的纯逻辑自检
 * ============================================================
 * 注册表是多协会的唯一真相源：选择页、导航栏标题、主题色、按协会的规则
 * 默认值全从这里取；云端还要用它校验请求里的 association。它一旦有错，
 * 要么页面拿不到协会，要么数据落到不存在的协会名下。
 *
 * 判定全是纯计算（不碰 wx、不碰数据源），能在 Node 里直接跑完。
 * ============================================================
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  allAssociations,
  activeAssociations,
  getAssociation,
  isKnownAssociation,
  defaultAssociationId,
  sportTypeOf,
  isTeamSport,
  capabilitiesOf,
  workbenchTabsOf,
  basketballRulesOf,
} = require('../src/shared/utils/associations.js');
const { ASSOCIATION_STATUS } = require('../src/shared/utils/constants.js');
const { isValidFormat } = require('../src/shared/utils/match-format.js');
const { isValidBasketballRules } = require('../src/shared/utils/basketball-rules.js');
const { isValidFootballRules } = require('../src/shared/utils/football-rules.js');

const DEST_ROOT = path.join(__dirname, '..', 'cloudfunctions', 'data', 'lib');

/* ============================================================
 * 一、清单本身
 * ============================================================ */

test('allAssociations —— 至少登记了三个首批协会，且 id 唯一', () => {
  const list = allAssociations();
  assert.ok(list.length >= 3, '首批至少三个协会');
  const ids = list.map((a) => a.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'id 不能重复');
  // 首批三个必须都在
  for (const id of ['pkb', 'tt', 'bd']) {
    assert.ok(ids.includes(id), `缺少协会 ${id}`);
  }
});

test('每个协会的字段齐全，且规则默认值合法', () => {
  for (const a of allAssociations()) {
    assert.strictEqual(typeof a.id, 'string');
    assert.ok(a.id.length > 0);
    assert.ok(a.name && a.shortName && a.sportName && a.logoGlyph, `${a.id} 缺品牌字段`);
    // 项目名通常三字（匹克球 / 乒乓球 / 羽毛球），但「网球」这类两字项目
    // 同样是合法项目名——窄处徽章按 2–3 字设计，不强制凑成三字。
    assert.ok(
      a.sportName.length >= 2 && a.sportName.length <= 3,
      `${a.id}.sportName 该是 2–3 字项目名`
    );

    // 主题色的四个值都是 #RRGGBB
    for (const key of ['primary', 'primaryDark', 'primaryLight', 'accent']) {
      assert.match(a.theme[key], /^#[0-9A-Fa-f]{6}$/, `${a.id}.theme.${key} 不是颜色`);
    }

    // 运动类型只有两种：球拍运动（个人 + Elo）与团队运动（球队 + 名次统计）。
    assert.ok(['racket', 'team'].includes(a.sportType), `${a.id}.sportType 非法`);

    if (a.sportType === 'team') {
      // 团队运动不挂个人赛制与 Elo，只挂能力组合与规则快照。
      assert.ok(Array.isArray(a.capabilities) && a.capabilities.includes('teams'), `${a.id} 缺组队能力`);
      assert.ok(!a.capabilities.includes('rank'), `${a.id} 团队运动不该有排行榜页签`);
      assert.ok(!a.capabilities.includes('match'), `${a.id} 团队运动不该有个人比赛页签`);
      assert.strictEqual(a.format, undefined, `${a.id} 团队运动不该带个人赛制`);
      assert.strictEqual(a.elo, undefined, `${a.id} 团队运动不该带 Elo 配置`);
      if (a.teamSportFormat === 'football11') {
        assert.ok(isValidFootballRules(a.footballRules), `${a.id}.footballRules 不合法`);
        assert.strictEqual(a.basketballRules, undefined);
      } else assert.ok(isValidBasketballRules(a.basketballRules), `${a.id}.basketballRules 不合法`);
      continue;
    }

    // 规则默认值：默认赛制必须落在可选值里，且选项组要与计分体系对得上。
    // 网球是三层计分（分→局→盘），可变项是「每盘几局」，没有「每局几分」。
    assert.ok(a.capabilities.includes('rank'), `${a.id} 球拍运动该有排行榜页签`);
    assert.ok(Array.isArray(a.format.bestOfOptions));
    assert.ok(isValidFormat(a.format.defaultFormat), `${a.id}.format.defaultFormat 不合法`);
    assert.ok(
      a.format.bestOfOptions.includes(a.format.defaultFormat.bestOf),
      `${a.id} 默认盘制不在 bestOfOptions 里`
    );
    if (a.format.scoring === 'tennis') {
      assert.ok(Array.isArray(a.format.setGamesOptions), `${a.id} 缺 setGamesOptions`);
      assert.ok(
        a.format.setGamesOptions.includes(a.format.defaultFormat.setGames),
        `${a.id} 默认每盘局数不在 setGamesOptions 里`
      );
    } else {
      assert.ok(Array.isArray(a.format.gamePointsOptions), `${a.id} 缺 gamePointsOptions`);
      assert.ok(
        a.format.gamePointsOptions.includes(a.format.defaultFormat.gamePoints),
        `${a.id} 默认分制不在 gamePointsOptions 里`
      );
    }
    assert.strictEqual(typeof a.ratedPairLimit, 'number');
    assert.ok(a.elo && typeof a.elo.initialRating === 'number');
  }
});

test('allAssociations 返回的是副本，外部增删改不动内部清单', () => {
  const before = allAssociations().length;
  const list = allAssociations();
  list.push({ id: 'ghost' });
  assert.strictEqual(allAssociations().length, before, '外部 push 不应改变清单长度');
  assert.strictEqual(isKnownAssociation('ghost'), false);
});

/* ============================================================
 * 二、启用与默认
 * ============================================================ */

test('activeAssociations —— 只返回启用中的协会', () => {
  for (const a of activeAssociations()) {
    assert.strictEqual(a.status, ASSOCIATION_STATUS.ACTIVE);
  }
  assert.ok(activeAssociations().length > 0, '至少要有一个启用协会');
});

test('defaultAssociationId —— 兜底是首个启用协会（匹克球）', () => {
  assert.strictEqual(defaultAssociationId(), 'pkb');
});

/* ============================================================
 * 三、取用与校验
 * ============================================================ */

test('getAssociation —— 取得到，且 id 对得上', () => {
  assert.strictEqual(getAssociation('pkb').id, 'pkb');
  assert.strictEqual(getAssociation('tt').id, 'tt');
});

test('getAssociation —— 未知 id 抛错，不静默退回', () => {
  assert.throws(() => getAssociation('nope'), /未知的协会 id/);
  assert.throws(() => getAssociation(undefined), /未知的协会 id/);
});

test('isKnownAssociation —— 只认注册表里的 id', () => {
  assert.strictEqual(isKnownAssociation('pkb'), true);
  assert.strictEqual(isKnownAssociation('tt'), true);
  assert.strictEqual(isKnownAssociation('nope'), false);
  assert.strictEqual(isKnownAssociation(''), false);
});

/* ============================================================
 * 四、镜像一致性（云端要用同一份清单）
 * ============================================================
 * 逐字节一致性由 cloud-lib-sync.test.js 守卫；这里只确认云端镜像能加载，
 * 且取到的 id 清单与源文件一致。
 */

test('云端镜像能加载，且协会 id 清单与源文件一致', () => {
  const mirror = require(path.join(DEST_ROOT, 'shared', 'utils', 'associations.js'));
  assert.deepStrictEqual(
    mirror.allAssociations().map((a) => a.id),
    allAssociations().map((a) => a.id)
  );
});

/* ============================================================
 * 五、主题配色（界面按协会上色的依据）
 * ============================================================ */

test('各协会主色按约定：匹克球蓝、乒乓深绿 #004D40、羽球紫', () => {
  // 这三个色是产品口径，写死在用例里，改了就该红：绿/橙/蓝等旧配色会被挡下
  assert.strictEqual(getAssociation('pkb').theme.primary, '#1565C0', '匹克球用蓝');
  assert.strictEqual(getAssociation('tt').theme.primary, '#004D40', '乒乓用深绿（RGB 0,77,64）');
  assert.strictEqual(getAssociation('bd').theme.primary, '#6A1B9A', '羽球用紫');
});

test('branding —— 主题类名：已知协会 assoc-<id>，未知与空都落中性', () => {
  const { themeClassOf, NEUTRAL_BRAND } = require('../miniprogram/services/branding.js');
  assert.strictEqual(themeClassOf('tt'), 'assoc-tt');
  assert.strictEqual(themeClassOf('bd'), 'assoc-bd');
  assert.strictEqual(themeClassOf(''), NEUTRAL_BRAND.rootClass);
  assert.strictEqual(themeClassOf('nope'), NEUTRAL_BRAND.rootClass);
  // 中性品牌是石榴红
  assert.strictEqual(NEUTRAL_BRAND.theme.primary.toLowerCase(), '#b23a2e');
});

test('生成的协会主题块与注册表镜像一致，JS 与 CSS 不许分叉', () => {
  const fs = require('node:fs');
  const appCss = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'app.wxss'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'miniprogram', 'styles', 'assoc-theme.wxss'), 'utf8');
  const { NEUTRAL_BRAND } = require('../miniprogram/services/branding.js');
  assert.ok(appCss.includes('@import "styles/assoc-theme.wxss"'), 'app.wxss 必须引入生成的主题样式');

  for (const a of activeAssociations()) {
    const block = css.match(new RegExp(`\\.assoc-${a.id}\\s*\\{([\\s\\S]*?)\\}`));
    assert.ok(block, `assoc-theme.wxss 里缺少 .assoc-${a.id}`);
    assert.ok(
      block[1].toLowerCase().includes(a.theme.primary.toLowerCase()),
      `.assoc-${a.id} 的 --color-primary 未与注册表的 ${a.theme.primary} 对齐`
    );
  }

  // 中性块的主色要与 NEUTRAL_BRAND 一致
  const neutral = appCss.match(/\.assoc-neutral\s*\{([\s\S]*?)\}/);
  assert.ok(neutral, 'app.wxss 里缺少 .assoc-neutral');
  assert.ok(neutral[1].toLowerCase().includes(NEUTRAL_BRAND.theme.primary.toLowerCase()));
});

/* ============================================================
 * 六、运动类型与工作台能力
 * ============================================================
 * 篮球加入后，「每个协会都有排行榜和比赛」不再成立。页签必须按能力生成，
 * 而不是在每个页面里写死四个名字；个人赛录分这类入口也要在后端识别团队
 * 运动并拒绝，不能只靠前端藏按钮。
 * ============================================================ */

test('sportTypeOf / isTeamSport —— 球拍与团队两类，未知 id 按球拍兜底', () => {
  assert.strictEqual(sportTypeOf('pkb'), 'racket');
  assert.strictEqual(sportTypeOf('tn'), 'racket');
  assert.strictEqual(sportTypeOf('bk'), 'team');
  assert.strictEqual(isTeamSport('bk'), true);
  assert.strictEqual(isTeamSport('pkb'), false);
  // 未知 id 兜底成球拍运动：旧数据与旧调用方都按它工作
  assert.strictEqual(sportTypeOf('nope'), 'racket');
  assert.strictEqual(sportTypeOf(''), 'racket');
});

test('capabilitiesOf / workbenchTabsOf —— 团队运动没有排行榜与个人比赛页签', () => {
  assert.deepStrictEqual(capabilitiesOf('pkb'), ['space', 'rank', 'match', 'events']);
  assert.deepStrictEqual(capabilitiesOf('bk'), ['space', 'teams', 'myTeams', 'events']);

  // 页签顺序固定：协会空间 → 组队 → 排行榜 → 比赛 → 赛事
  assert.deepStrictEqual(
    workbenchTabsOf('pkb').map((def) => def.tab),
    ['space', 'rank', 'match', 'events']
  );
  assert.deepStrictEqual(
    workbenchTabsOf('bk').map((def) => def.tab),
    ['space', 'teams', 'myTeams', 'events']
  );
  assert.deepStrictEqual(workbenchTabsOf('bk')[1], { tab: 'teams', label: '组队' });
  // 未知协会给球拍组合，绝不返回空数组（空数组会让工作台一片空白）
  assert.ok(workbenchTabsOf('nope').length > 0);
  // 返回副本：改它不影响注册表
  const tabs = workbenchTabsOf('bk');
  tabs[0].label = '改坏了';
  assert.strictEqual(workbenchTabsOf('bk')[0].label, '协会空间');
});

test('basketballRulesOf —— 团队运动才有规则快照，球拍运动返回 null', () => {
  const rules = basketballRulesOf('bk');
  assert.ok(rules);
  assert.strictEqual(rules.periods, 4);
  assert.strictEqual(rules.rosterMin, 5, '满 5 人即可比赛');
  assert.strictEqual(rules.minOnCourt, 2);

  assert.strictEqual(basketballRulesOf('pkb'), null);
  assert.strictEqual(basketballRulesOf('nope'), null);
  // 返回副本
  rules.periods = 9;
  assert.strictEqual(basketballRulesOf('bk').periods, 4);
});
