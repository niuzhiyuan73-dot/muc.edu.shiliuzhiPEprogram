/**
 * 切片 P-01：协会注册表模块化 + 主题单一真值 + 消除 team-service 运动硬编码
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  allAssociations,
  getAssociation,
  isTeamSport,
  sportKeyOf,
  themeVarsOf,
  validateAssociationPlugin,
  registerAssociationPlugin,
  unregisterAssociationPlugin,
  SPORT_TYPE,
  CAPABILITY,
} = require('../src/shared/associations/registry.js');
const legacyAssociations = require('../src/shared/utils/associations.js');
const { ASSOCIATION_STATUS } = require('../src/shared/utils/constants.js');
const branding = require('../miniprogram/services/branding.js');

describe('P-01 协会插件注册表与声明完整性', () => {
  test('全部内置协会顺序、id、sportKey 唯一且通过插件契约校验', () => {
    const list = allAssociations();
    assert.deepEqual(list.map(a => a.id), ['pkb', 'tt', 'bd', 'tn', 'bk', 'fb']);
    assert.equal(new Set(list.map(a => a.sportKey)).size, list.length, '每个协会必须拥有唯一 sportKey');
    for (const plugin of list) {
      const check = validateAssociationPlugin(plugin);
      assert.equal(check.ok, true, `${plugin.id}: ${check.message}`);
    }
    // 兼容旧路径转发完全一致
    assert.deepEqual(legacyAssociations.allAssociations().map(a => a.id), ['pkb', 'tt', 'bd', 'tn', 'bk', 'fb']);
    assert.equal(legacyAssociations.sportKeyOf('fb'), 'football');
  });

  test('sportKeyOf 返回准确运动标识，未知协会不兜底成具体运动', () => {
    assert.equal(sportKeyOf('pkb'), 'pickleball');
    assert.equal(sportKeyOf('tt'), 'table_tennis');
    assert.equal(sportKeyOf('bd'), 'badminton');
    assert.equal(sportKeyOf('tn'), 'tennis');
    assert.equal(sportKeyOf('bk'), 'basketball');
    assert.equal(sportKeyOf('fb'), 'football');
    assert.equal(sportKeyOf('unknown_assoc'), '');
  });

  test('动态注册与注销协会插件：拒绝非法结构/重名，合法插件可被查询与主题生成', () => {
    assert.throws(() => registerAssociationPlugin({ id: 'bad' }), /缺少有效字段/);
    assert.throws(() => registerAssociationPlugin({
      ...getAssociation('bk'),
      id: 'bk',
      sportKey: 'volleyball',
    }), /已存在/);
    assert.throws(() => unregisterAssociationPlugin('pkb'), /内置协会不可注销/);

    const vbPlugin = {
      id: 'vb_test',
      name: '中央民族大学排球协会',
      shortName: '民大排球',
      sportName: '排球',
      sportKey: 'volleyball',
      logoGlyph: '排',
      logoIcon: '/assets/assoc/vb.png',
      theme: {
        primary: '#1E88E5',
        primaryDark: '#1565C0',
        primaryLight: '#E3F2FD',
        accent: '#FDD835',
      },
      sportType: SPORT_TYPE.TEAM,
      teamSportFormat: 'volleyball6',
      rulesKey: 'volleyballRules',
      // 团队运动必须带规则快照，否则契约拒绝（P-01 修复后）
      volleyballRules: { sportFormat: 'volleyball6', sets: 3, pointsPerSet: 25 },
      capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS, CAPABILITY.MY_TEAMS, CAPABILITY.EVENTS],
      status: ASSOCIATION_STATUS.ACTIVE,
    };

    try {
      registerAssociationPlugin(vbPlugin);
      assert.equal(isTeamSport('vb_test'), true);
      assert.equal(sportKeyOf('vb_test'), 'volleyball');
      assert.match(themeVarsOf('vb_test'), /--color-primary:#1E88E5;/);
      assert.match(themeVarsOf('vb_test'), /--brand-color:#1E88E5;/);
    } finally {
      assert.equal(unregisterAssociationPlugin('vb_test'), true);
    }
    assert.equal(sportKeyOf('vb_test'), '');
  });
});

describe('P-01 主题单一真值与代码边界守卫', () => {
  test('插件契约按运动类型校验规则快照：缺 format / elo / teamSportFormat / 规则快照均被拒', () => {
    const base = {
      id: 'x_test', name: '测试协会', shortName: '测试', sportName: '测试',
      logoGlyph: '测', logoIcon: '/assets/assoc/x.png', sportKey: 'x_sport',
      theme: { primary: '#123456', primaryDark: '#123456', primaryLight: '#abcdef', accent: '#123456' },
      capabilities: [CAPABILITY.SPACE], status: ASSOCIATION_STATUS.ACTIVE,
    };
    const racket = {
      ...base, sportType: SPORT_TYPE.RACKET,
      format: { defaultFormat: {} }, elo: { initial: 1450 }, ratedPairLimit: 15,
    };
    assert.equal(validateAssociationPlugin(racket).ok, true);
    assert.match(validateAssociationPlugin({ ...racket, format: undefined }).message, /format.defaultFormat/);
    assert.match(validateAssociationPlugin({ ...racket, elo: undefined }).message, /elo/);
    assert.match(validateAssociationPlugin({ ...racket, ratedPairLimit: 0 }).message, /ratedPairLimit/);

    const team = {
      ...base, sportType: SPORT_TYPE.TEAM,
      teamSportFormat: 'handball7', rulesKey: 'handballRules', handballRules: { sportFormat: 'handball7', periods: 2 },
    };
    assert.equal(validateAssociationPlugin(team).ok, true);
    assert.match(validateAssociationPlugin({ ...team, teamSportFormat: undefined }).message, /teamSportFormat/);
    assert.match(validateAssociationPlugin({ ...team, handballRules: undefined }).message, /规则快照/);
    // 动态注册也走同一契约：无规则快照的团队插件不得混入注册表
    assert.throws(() => registerAssociationPlugin({ ...team, id: 'bad_team', handballRules: undefined }), /规则快照/);
  });

  test('契约拒绝非法 id、重复 sportKey 与空规则快照', () => {
    const base = {
      id: 'vb_contract', name: '测试排球', shortName: '排球', sportName: '排球',
      logoGlyph: '排', logoIcon: '/assets/assoc/vb.png', sportKey: 'volleyball_contract',
      theme: { primary: '#123456', primaryDark: '#123456', primaryLight: '#abcdef', accent: '#123456' },
      sportType: SPORT_TYPE.TEAM, teamSportFormat: 'volleyball6',
      rulesKey: 'volleyballRules', volleyballRules: { sportFormat: 'volleyball6', sets: 3, pointsPerSet: 25 },
      capabilities: [CAPABILITY.SPACE, CAPABILITY.TEAMS], status: ASSOCIATION_STATUS.ACTIVE,
    };
    assert.match(validateAssociationPlugin({ ...base, id: '../evil id' }).message, /id 非法/);
    assert.match(validateAssociationPlugin({ ...base, sportKey: 'Bad Sport' }).message, /sportKey 非法/);
    assert.throws(() => registerAssociationPlugin({ ...base, sportKey: 'basketball' }), /sportKey 已存在/);
    assert.match(validateAssociationPlugin({ ...base, volleyballRules: {} }).message, /规则快照/);
    assert.match(validateAssociationPlugin({ ...base, rulesKey: 'fooRules' }).message, /规则快照/);
    assert.throws(() => registerAssociationPlugin({
      ...base, rulesKey: 'basketballRules', basketballRules: getAssociation('bk').basketballRules,
    }), /规则快照 sportFormat/);
    assert.match(validateAssociationPlugin({
      ...base, volleyballRules: { sets: 3 },
    }).message, /规则快照 sportFormat/);
  });

  test('宿主页面根容器挂载内联主题变量，动态协会免手改 app.wxss 也能拿到主题色', () => {
    const homeJs = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'association-home', 'association-home.js'), 'utf8');
    const homeWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'pages', 'association-home', 'association-home.wxml'), 'utf8');
    const mineJs = fs.readFileSync(path.join(ROOT, 'miniprogram', 'packageMember', 'my-sports', 'my-sports.js'), 'utf8');
    const mineWxml = fs.readFileSync(path.join(ROOT, 'miniprogram', 'packageMember', 'my-sports', 'my-sports.wxml'), 'utf8');
    assert.match(homeJs, /themeStyle:\s*themeStyleOf\(id\)/, '协会工作台须按当前协会生成内联主题变量');
    assert.match(homeWxml, /style="\{\{themeStyle\}\}"/, '工作台根容器须挂内联主题变量');
    assert.match(mineJs, /themeStyle:\s*currentThemeStyle\(\)/, '我的体育须按当前协会生成内联主题变量');
    assert.match(mineWxml, /style="\{\{themeStyle\}\}"/, '我的体育根容器须挂内联主题变量');

    // 动态协会的主题串由 registry 生成（两端模块实例互相独立，测试只校验生成能力）。
    const vb = registerAssociationPlugin({
      id: 'vb_wxss_test', name: '排球', shortName: '排球', sportName: '排球',
      logoGlyph: '排', logoIcon: '/assets/assoc/vb.png', sportKey: 'volleyball_test',
      theme: { primary: '#1E88E5', primaryDark: '#1565C0', primaryLight: '#E3F2FD', accent: '#FDD835' },
      sportType: SPORT_TYPE.TEAM, teamSportFormat: 'volleyball6', rulesKey: 'volleyballRules', volleyballRules: { sportFormat: 'volleyball6', sets: 3 },
      capabilities: [CAPABILITY.SPACE], status: ASSOCIATION_STATUS.ACTIVE,
    });
    try {
      const { themeVarsOf } = require('../src/shared/associations/registry.js');
      assert.match(themeVarsOf(vb.id), /--color-primary:#1E88E5;/, '动态协会的主题串须由其 theme 生成');
    } finally {
      assert.equal(unregisterAssociationPlugin(vb.id), true);
    }
    // 已登记协会的内联变量串（页面实际取值路径）
    assert.match(branding.themeStyleOf('pkb'), /--color-primary:#1565C0;/);
  });

  test('生成的 .assoc-<id> 与协会插件 theme 逐色一致，branding.themeStyleOf 输出一致', () => {
    const appWxss = fs.readFileSync(path.join(ROOT, 'miniprogram', 'app.wxss'), 'utf8');
    assert.match(appWxss, /@import\s+"styles\/assoc-theme\.wxss"/, 'app.wxss 必须引入生成的主题样式');
    const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram', 'styles', 'assoc-theme.wxss'), 'utf8');
    for (const assoc of allAssociations()) {
      const re = new RegExp(`\\.assoc-${assoc.id}\\s*\\{([\\s\\S]*?)\\}`, 'i');
      const match = wxss.match(re);
      assert.ok(match, `assoc-theme.wxss 缺少 .assoc-${assoc.id}`);
      const body = match[1].toLowerCase();
      assert.ok(body.includes(`--color-primary: ${assoc.theme.primary.toLowerCase()};`), `${assoc.id} primary 不一致`);
      assert.ok(body.includes(`--color-primary-dark: ${assoc.theme.primaryDark.toLowerCase()};`), `${assoc.id} primaryDark 不一致`);
      assert.ok(body.includes(`--color-primary-light: ${assoc.theme.primaryLight.toLowerCase()};`), `${assoc.id} primaryLight 不一致`);
      assert.ok(body.includes(`--color-accent: ${assoc.theme.accent.toLowerCase()};`), `${assoc.id} accent 不一致`);
      assert.ok(body.includes(`--brand-color: ${assoc.theme.primary.toLowerCase()};`), `${assoc.id} brand-color 不一致`);
      assert.ok(body.includes(`--brand-dark: ${assoc.theme.primaryDark.toLowerCase()};`), `${assoc.id} brand-dark 不一致`);
      assert.ok(body.includes(`--brand-soft: ${assoc.theme.primaryLight.toLowerCase()};`), `${assoc.id} brand-soft 不一致`);

      const style = branding.themeStyleOf(assoc.id);
      assert.ok(style.includes(`--color-primary:${assoc.theme.primary};`));
    }
    assert.ok(branding.themeStyleOf('').includes(`--color-primary:${branding.NEUTRAL_BRAND.theme.primary};`));
  });

  test('team-service.js 已彻底消除 football11 / football 二元硬编码', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'server', 'services', 'team-service.js'), 'utf8');
    assert.equal(src.includes('football11'), false, 'team-service.js 不得再出现 football11 硬编码');
    assert.equal(/===\s*'football'/.test(src), false, 'team-service.js 不得再出现 === \'football\' 硬编码');
  });
});
