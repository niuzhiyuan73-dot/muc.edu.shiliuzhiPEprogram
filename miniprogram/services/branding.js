/**
 * 协会品牌
 * ============================================================
 * 「按协会套品牌」只有两处落点：导航栏标题与颜色、页面根节点的主题类
 * （app.wxss 里的 .assoc-<id> 覆盖 CSS 变量）。把这两处收在这一个模块里，
 * 免得每个页面各写一遍 setNavigationBarTitle，改配色时到处翻。
 *
 * 【为什么首页是「中性品牌」】
 * 首页展示的是全部协会的公告与赛事（见 home-view），它不属于任何一个协会，
 * 因此不套协会品牌，用一份中性外观（石榴籽）。其余按协会切换的页面才套。
 *
 * 【为什么 wx 调用要判存在】
 * 本模块也要能在 Node 测试里 require（brandOf 是纯计算）。真机上 wx 一定在，
 * 测试环境里没有——判一下即可，纯计算部分照常可测。
 * ============================================================
 */

const { getAssociation: lookup, isKnownAssociation } = require('../shared/utils/associations.js');
const scope = require('./association-scope.js');

/**
 * 中性品牌：首页与导航栏的兜底外观。首页是跨协会的，不套任何协会品牌。
 * 图标字取「籽」（石榴籽），主色取石榴红。
 */
const NEUTRAL_BRAND = {
  id: '',
  name: '中央民族大学石榴籽体育管理小程序',
  shortName: '石榴籽体育管理',
  logoGlyph: '籽',
  theme: {
    primary: '#B23A2E',
    primaryDark: '#8E2C23',
    primaryLight: '#F7E9E7',
    accent: '#C9A227',
  },
  // 页面根节点挂这个类，app.wxss 的 .assoc-neutral 覆盖 CSS 变量为中性配色
  rootClass: 'assoc-neutral',
};

/**
 * 把一个协会条目的品牌字段整理成界面要用的形状。
 *
 * 空 id（首页、无启用协会）与未知 id 一律退回**中性品牌**，绝不悄悄拿默认
 * 协会的品牌顶上——那会让「不属于任何协会的首页」或「请求带错 id」显示成
 * 某个协会的外观，是错上错。
 *
 * @param {string} id 协会 id
 * @returns {Object} { id, name, shortName, logoGlyph, theme, rootClass }
 */
function brandOf(id) {
  if (!id || !isKnownAssociation(id)) {
    return { ...NEUTRAL_BRAND, theme: { ...NEUTRAL_BRAND.theme } };
  }
  const assoc = lookup(id);

  return {
    id: assoc.id,
    name: assoc.name,
    shortName: assoc.shortName,
    logoGlyph: assoc.logoGlyph,
    theme: { ...assoc.theme },
    // 页面根节点挂这个类，app.wxss 的 .assoc-<id> 就会覆盖 --color-primary 等变量
    rootClass: `assoc-${assoc.id}`,
  };
}

/** 把品牌刷到导航栏上。Node 环境无 wx，静默跳过，只返回品牌数据 */
function paint(brand) {
  if (typeof wx !== 'undefined') {
    if (typeof wx.setNavigationBarTitle === 'function') {
      wx.setNavigationBarTitle({ title: brand.shortName });
    }
    if (typeof wx.setNavigationBarColor === 'function') {
      // frontColor 只能是 #ffffff / #000000；协会主色都偏深，配白字
      wx.setNavigationBarColor({ frontColor: '#ffffff', backgroundColor: brand.theme.primary });
    }
  }
  return brand;
}

/** 套某个协会的品牌（导航标题 + 颜色） */
function applyBranding(id) {
  return paint(brandOf(id));
}

/** 刷回中性品牌（首页用）。等价于 applyBranding('')，单独留个名字表意更清楚。 */
function resetBranding() {
  return paint(brandOf(''));
}

/**
 * 按「当前全局协会」刷导航栏品牌，供随协会切换的页面在 onShow 里调用
 * （排行榜 / 比赛 / 赛事）。「取当前协会」各处写法一致，收在这里免得每页
 * 抄一遍 getApp() 的兜底。Node 测试里没有 getApp 时退回中性品牌即可。
 *
 * @returns {Object} 生效的品牌数据
 */
function applyCurrentBranding() {
  const app = typeof getApp === 'function' ? getApp() : null;
  const id = app && typeof app.getAssociation === 'function' ? app.getAssociation() : '';
  return applyBranding(id);
}

/**
 * 协会 id → 页面根节点要挂的主题类名（app.wxss 的 .assoc-<id>）。
 * 未知 / 空 id 一律落到中性类——与 brandOf 同一口径，绝不悄悄套别的协会。
 *
 * @param {string} id
 * @returns {string} 如 'assoc-pkb' / 'assoc-neutral'
 */
function themeClassOf(id) {
  return brandOf(id).rootClass;
}

/**
 * 当前全局协会对应的主题类名，供随协会切换的页面在装载/显示时写进 data，
 * WXML 里挂在页面根容器上（`class="page-container {{themeClass}}"`），
 * 于是子节点上的 var(--color-primary) 等自动变成该协会的配色。
 *
 * @returns {string}
 */
function currentThemeClass() {
  return themeClassOf(scope.getAssociation());
}

module.exports = {
  NEUTRAL_BRAND,
  brandOf,
  applyBranding,
  applyCurrentBranding,
  resetBranding,
  themeClassOf,
  currentThemeClass,
};
