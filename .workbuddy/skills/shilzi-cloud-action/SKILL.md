---
name: shilzi-cloud-action
description: 在石榴籽云函数（唯一云函数 cloudfunctions/data）里新增、修改或下线协议 2 action 时使用。覆盖白名单注册收口、四组归属与计数、请求信封与错误码、双端仓储同时改、范围条件必须内置、事务操作数预算、MANIFEST 镜像登记、幂等与限流、索引清单同步、验证路径。触发词：新增接口、加接口、改接口、接口报错、新增 action、加 action、下线接口、删接口、云函数、cloudfunctions、data 云函数、协议 2、protocolVersion、handleSchoolRequest、请求信封、错误码、ok、fail、仓储、repo、仓储原语、双端、内存实现、云端实现、契约测试、cloud-repo-contract、事务、事务预算、100 次操作、批量写、批量加人、幂等、requestId、限流、rate-limit、索引、建索引、分页、hasMore、游标、读放大、下推、整表读、按 id 批量查、listByIds、MANIFEST、镜像同步、sync:cloud、check:cloud-sync、部署云函数、重新部署、action 注册、白名单、pickActions。不适用：只改页面时用 shilzi-page-work。 同样适用于已有接口、共享 services 与 utils 中服务端执行的逻辑、认证授权与隐私、缓存一致性、并发写入、数据库查询、性能安全审查、回填导入、部署配置和故障定位；不要求新增 action 或明确提到云函数。
---

# 云函数 action 施工

前置：先读 `shilzi-construction-guard` 并按任务类型选择基线与验证。后端改动本地全绿不代表云端可用 —— 事务预算、索引、读配额只在云端成立。

## 触发范围

- 新增、修改、下线、解释、审查或排查已有接口，以及 `cloudfunctions/data/**`、两端仓储、被云端加载的共享 `services` / `utils`、数据导入回填与相关部署配置。
- 包括认证授权、跨校或协会隔离、个人信息返回、参数校验、事务与并发、重复请求、缓存一致性、资源消耗、查询索引、分页、批读、镜像及 MOCK / CLOUD 行为差异。
- “普通会员能不能查别人”“数据为何重复”“本地正常云端失败”“接口慢 / 配额高”“审查安全和性能”等均可命中；即使用户只提到前端症状，也根据实际后端调用链触发。
- 只读任务只检查适用约束并报告问题；维护现有接口不要求新增 action，未增加查询或集合时也不要求新增索引或集合。涉及页面使用方式时叠加 `shilzi-page-work`。

## 一、注册面必须按白名单收口

四个处理器文件是**门面**，形态固定：

```js
// cloudfunctions/data/src/core/school-xxx-handlers.js
module.exports = Object.freeze(pickActions(
  [createXxxHandlers({ /* 注入 */ })],
  SCHOOL_XXX_ACTIONS,
));
```

纪律：

1. 新 action 先加进 `miniprogram/utils/school-actions.js` 的对应 `*_ACTIONS` 数组，再写实现。
2. **不要**让 `createXxxHandlers` 多导出的内部函数自动变成可调用 action —— 白名单就是防火墙（只读审计 H1 的结论）。
3. 四组归属与当前计数（数值会变，改完必须重新统计）：

| 组 | 常量 | 领域 |
|---|---|---|
| 会员与身份 | `SCHOOL_IDENTITY_ACTIONS` | 注册、身份、学校会籍 |
| 协会空间与个人赛/团队 | `SCHOOL_SPACE_ACTIONS` | 协会空间、个人赛、球队、训练 |
| 跨校邀请赛 | `SCHOOL_EXCHANGE_ACTIONS` | 与外校交流 |
| 运动会 | `SCHOOL_MEET_ACTIONS` | 校运会全流程 |

真值用命令取，不抄文档：

```bash
node .workbuddy/skills/shilzi-doc-sync/scripts/doc-truth.js
```

## 二、请求与响应信封

客户端固定发：`{ protocolVersion: 2, schoolId, association, action, payload }`。

- `protocolVersion !== 2` 一律拒绝（协议 1 已完全下线）。
- 成功走 `ok(data)`、失败走 `fail(message)`（`src/envelope.js`；**只有 message，没有 code 参数**），**不要抛裸异常**。
  需要按类型区分时给 `Error` 挂 `err.code`（如 `SCHOOL_INACTIVE` / `READ_CAP_EXCEEDED`），
  由入口决定转成业务拒绝还是顶层故障；业务拒绝一律放 `data.ok=false`。
- 业务拒绝用业务文案（「还有 N 场未发布」），技术错误才用通用文案。
- 写操作尽量带 `requestId`（幂等）；已有主记录的更新用记录自身 ID 即可。

## 三、双端仓储必须同时改

| 端 | 文件 |
|---|---|
| 内存（本地 mock / 测试） | `miniprogram/services/school-memory-repo.js` |
| 云端 | `cloudfunctions/data/src/adapters/cloud-repo.js` + `src/school-repository.js` |
| 测试桩 | `tests/helpers/memory-repo.js` |

三处方法面要一致，`tests/cloud-repo-contract.test.js` 会扫「顶层仓储也要有该方法」。运动会等域另有 `meet-repo-contract`。

**命名坑**：带域上下文的原语不要叫 `listByEvent`，会被「顶层仓储也要有」的扫描拦下；按语义叫 `listByProject` / `listBySession`。

## 四、范围条件必须内置（安全红线）

新增仓储原语，**即使按 `_id in (...)` 查，也要把 `schoolId`（及 `association`）拼进查询**。

```js
// 错：把归属校验留给调用方
where({ _id: _.in(ids) })
// 对：原语自带防线
where({ _id: _.in(ids), ...scopeFields })
```

内存端本来就 `owns` 校验；`tests/helpers/memory-repo.js` 的 io 桩也要同步补。

背景：曾有一轮 `byIds` 只在云端按 `_id in` 查，归属校验全压给调用方 —— 这是本项目唯一一次安全级回归，不要重犯。

## 五、事务预算（新增批量入口必查）

单事务 **≤ 100 次操作**。新增批量写之前：

1. 数清每人/每条几次操作（读 + 写 + 计数各算一次）。
2. 定一个业务上限常量（如 `TEAM_ADD_BATCH_MAX = 30`，30 人 = 67 次）。
3. 在**事务开始前**拒绝超限，用业务文案，不要等云端抛错。
4. 补一条预算用例（把上限跑满，断言操作数 < 100）。

事务内需要「新鲜」身份时用 `freshContext`，不要复用事务外的上下文缓存。

## 六、镜像登记

新 `services/*.js` 文件：加进 `tools/sync-cloud-lib.js` 的 `MANIFEST`，然后

```bash
npm run sync:cloud
npm run check:cloud-sync
```

漏了 → 云端 `Cannot find module './xxx.js'`，而本地测试走 `miniprogram` 路径，发现不了。

## 七、读放大与索引

- 禁止「整表读 + 内存过滤」写新查询；下推成带条件的仓储方法。
- 新查询要能在 `docs/数据库索引清单.md` 找到对应索引；没有就补清单条目并在部署说明里点名。
- 列表接口必须返 `hasMore` + 下一页游标（`nextOffset` 或 `nextCursor`，**游标一律用不透明字符串**，不要回对象）；分页游标与 `_.in` 不能混用（`_id > lastId` 与 `_id in (...)` 冲突，`cursorCond` 会抛错）。
- 日预算按「读成本点」计（`core/rate-limit.js` 的 `ACTION_READ_COST`）：新增整表读型 action 要登记成本，否则最贵的接口与点读一个文档同价。
- 聚合能算的别读文档：名次用 `count` / `countAbove`，不要捞全表在应用层排名。

## 八、限流与幂等

- `src/core/rate-limit.js`：写动作按操作者+action 维度限流，阈值改动要有理由。
- `src/core/idempotency.js`：导入等批量入口用它，注意它同时被导入契约测试引用，改动面比看上去大。

## 九、验证路径

```bash
node tools/run-tests.js --filter cloud      # 路由/契约/镜像
node tools/run-tests.js --filter repo       # 仓储契约
npm test                                    # 全量
npm run check:cloud-sync
```

手工确认清单：

- [ ] 新 action 在 `*_ACTIONS` 里，且只这一处注册
- [ ] 双端仓储 + io 桩方法面一致
- [ ] 原语自带范围条件
- [ ] 事务操作数 < 100（有预算用例）
- [ ] 新 services 文件已进 MANIFEST，镜像一致
- [ ] 索引清单已补，部署说明点名
- [ ] 改完提醒：**云函数不随小程序编译更新，必须重新部署 `data`**（漏部署的症状：新接口报「该操作尚未支持学校范围」）
