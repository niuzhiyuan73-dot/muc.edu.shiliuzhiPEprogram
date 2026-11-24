/**
 * 演示仓储的惰性加载器（生产包剥离本地 Mock 版）
 * ============================================================
 * 生产小程序包不再打包 `src/mock/*` 与任何服务端逻辑。
 * 若运行在本地模拟模式（未配置 CLOUD_ENV_ID），需由测试入口或
 * 开发者注入 `registerMockProvider(fn)`；未注册时明确提示配置云环境。
 * ============================================================
 */

let provider = null;
let cached = null;

/**
 * 注册模拟仓储提供器（供测试框架及开发工具调用）。
 * @param {Function} fn 返回 school-mock 导出的工厂函数
 */
function registerMockProvider(fn) {
  if (typeof fn !== 'function') {
    throw new Error('registerMockProvider 需要传入函数');
  }
  provider = fn;
  cached = null;
}

/**
 * 取得演示仓储模块（首次调用才真正加载）。
 * @returns {Object} `src/mock/school-mock.js` 的导出
 */
function loadSchoolMock() {
  if (cached) return cached;
  if (typeof provider !== 'function') {
    throw new Error('客户端已剥离本地模拟数据，请在 miniprogram/config.js 配置云环境 CLOUD_ENV_ID');
  }
  cached = provider();
  return cached;
}

module.exports = { loadSchoolMock, registerMockProvider };
