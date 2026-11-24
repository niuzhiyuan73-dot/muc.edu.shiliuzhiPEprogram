/**
 * 测试环境自动注入本地模拟仓储提供器（配合 T-03 客户端 Mock 剥离）。
 * 由 tools/run-tests.js (--require) 与 tests/helpers/page-harness.js 加载。
 */
const { registerMockProvider } = require('../../miniprogram/services/school-mock-loader.js');

registerMockProvider(() => require('../../src/mock/school-mock.js'));
