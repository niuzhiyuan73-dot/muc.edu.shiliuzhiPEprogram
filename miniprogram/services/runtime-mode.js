/**
 * 运行模式（本地模拟数据 / 真实云端）
 * ============================================================
 * 「这次跑的是本地模拟数据，还是真实云端」只有一个开关，它属于整个客户端的
 * 运行状态：app.js 在 onLaunch 里按云环境是否就绪拨一次；学校维度
 * （school-identity）与各页面据此决定取模拟仓储还是云端仓储。
 *
 * 【为什么单列一个模块，而不是继续放在数据源门面里】
 * 这个开关原先长在协议 1 的数据源门面（services/index.js）里。协议 1 已定
 * 「完全下线」，门面本身要删；但运行模式是两个栈共用的运行状态，不能跟着门面
 * 陪葬——否则删门面就会连带打断学校维度自己的 mock / cloud 判定。
 * 因此 P10 把它搬到这里独立存在（协议 1 门面已随之删除）。
 *
 * @see docs/隐患与未定产品决策-2026-10-16.md §三 P10
 * ============================================================
 */

const { DATA_SOURCE } = require('../shared/utils/constants.js');

const KNOWN_SOURCES = Object.values(DATA_SOURCE);

/** 当前模式标识。默认本地模拟数据：换机器、无云环境也能完整演示。 */
let current = DATA_SOURCE.MOCK;

/**
 * 当前模式标识。
 * @returns {string} DATA_SOURCE.MOCK | DATA_SOURCE.CLOUD
 */
function getDataSource() {
  return current;
}

/**
 * 切换运行模式。由 app.js 在启动时按云环境是否可用决定调用。
 * @param {string} name DATA_SOURCE.MOCK | DATA_SOURCE.CLOUD
 * @returns {string} 切换后的标识
 * @throws {Error} 未知模式
 */
function setDataSource(name) {
  if (!KNOWN_SOURCES.includes(name)) {
    throw new Error(`未知的数据源：${name}`);
  }
  current = name;
  return current;
}

/**
 * 此刻是否为本地模拟数据。用于界面水印与「演示口径」提示。
 * @returns {boolean}
 */
function isMockNow() {
  return current === DATA_SOURCE.MOCK;
}

/** 复位为默认（本地模拟）。测试与冷启动重来用。 */
function resetDataSource() {
  current = DATA_SOURCE.MOCK;
}

module.exports = {
  DATA_SOURCE,
  getDataSource,
  setDataSource,
  isMockNow,
  resetDataSource,
};

/**
 * isMock 保留为 getter，兼容既有写法（页面里常 `const { isMock } = require(...)`）。
 * 用 getter 而非普通属性：普通属性在模块加载时求值一次，改了模式也不会变。
 */
Object.defineProperty(module.exports, 'isMock', {
  enumerable: true,
  get: isMockNow,
});
