/** 页面入口，每次创建客户端时固定数据源、学校与演示身份。 */
// 运行模式取自 runtime-mode，而非旧数据源门面（协议 1 已定完全下线）。
// 从前这里 require 门面的 isMockNow，删门面就会连带打断本模块的 mock / cloud
// 判定——这正是 P10 第 3 步必须先解开的硬耦合点。
const { isMockNow } = require('./runtime-mode.js');
const cloud = require('./school-cloud.js');
// 演示仓储惰性加载：数据源为 cloud 时完全用不上，别让每次冷启动都付那 400ms
// （见 school-mock-loader.js 与 2026-10-16 只读审计 H7）。
const { loadSchoolMock } = require('./school-mock-loader.js');
module.exports = {
  forSchoolIdentity: scope => (isMockNow() ? loadSchoolMock() : cloud).forSchoolIdentity(scope),
  /**
   * 协会空间门面：管理员评级调整（adjustMemberRating）属协会空间 action 组，
   * 身份门面不含它。身份页在保留原身份客户端的同时按需取这一个写接口。
   */
  forSpace: scope => (isMockNow() ? loadSchoolMock() : cloud).forAssociationSpace(scope),
  isMockNow,
  getDemoActors: () => isMockNow() ? loadSchoolMock().DEMO_ACTORS.map(actor => ({ ...actor })) : [],
  getDemoActor: () => isMockNow() ? loadSchoolMock().getDemoActor() : '',
  setDemoActor(id) {
    if (!isMockNow()) throw new Error('云端不可切换模拟身份');
    loadSchoolMock().setDemoActor(id);
  },
  /** 模拟「新微信号」（仅本地演示）：拨到尚无账号的 OpenID，用于注册闭环演示。 */
  simulateNewWechat(openId) {
    if (!isMockNow()) throw new Error('云端不可模拟微信身份');
    return loadSchoolMock().simulateNewWechat(openId);
  },
};
