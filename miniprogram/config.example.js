/**
 * 部署配置（示例）
 * ============================================================
 * 复制本文件为同目录下的 `config.js`，再填自己的值。
 * `config.js` 已列入 .gitignore：环境 ID 属账号级信息，只留本地，不入库。
 *
 * 【CLOUD_ENV_ID 为什么留空】
 * 云开发环境 ID 是账号级的，写死在仓库里只对一个人有效，因此模板留空，
 * 由每个开发者在本地 config.js 填自己的值（该文件已 gitignore，不入库）。
 *
 * 【留空会怎样】
 * 留空时启动会进入 MOCK 模式（见 app.js 的 initDataSource）。G2b 之后
 * Mock/Seed 实现已剥离到包外的 src/mock/，真机若未注入 provider，首次
 * 读取会在 loadSchoolMock() 抛错——MOCK 模式仅供测试环境通过注入运行，
 * 不再是可完整演示的兜底。开发/预览真机前务必填入自己的环境 ID。
 *
 * 【上线前要做的事】
 * 1. 在微信开发者工具里开通云开发，拿到环境 ID（形如 xxx-1a2b3c）；
 * 2. 把它填到下面；
 * 3. 部署 cloudfunctions/data（详见 cloudfunctions/README.md）。
 * ============================================================
 */

/** 云开发环境 ID。留空将进入 MOCK 模式（需注入 provider，真机不可用） */
const CLOUD_ENV_ID = '';

module.exports = { CLOUD_ENV_ID };
