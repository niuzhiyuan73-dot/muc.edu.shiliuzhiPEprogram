# 中央民族大学石榴籽体育管理小程序 · 第 23 轮全代码只读审查报告

> **审查方式**：全仓只读审查（不修改任何业务代码、测试或冻结文档），覆盖全部前端主包与五大分包（44 页 / 12 组件 / `templates/`）、全部共享服务与纯工具（110+ 服务模块 / 35 工具模块）、唯一云函数 `cloudfunctions/data`（入口、核心路由、限流、双端仓储与适配器）、以及 `tools/` 脚本与配置自举。  
> **重点目标**：① 逐条核查第 10–20 轮（交叉对照第 21–22 轮）发现的问题是否彻底闭环；② 系统性排查全模块代码正确性、潜在缺陷、安全性、性能瓶颈、可维护性与规范一致性；③ 专项梳理**冗余代码**与**过度且不必要的安全性防范**。

---

## 0. 审查基线（代码实测真值）

| 核查项 | 实测结果 |
|---|---|
| 规模真值（`doc-truth.js`） | 页面 **44**（主包 5 + 分包 39：`packageEvent` 5 / `packageMeet` 7 / `packageTeam` 8 / `packageCollege` 8 / `packageMember` 11）；协议 2 action **202**（`IDENTITY` 14 + `SPACE` 119 + `EXCHANGE` 16 + `MEET` 53）；集合 **52**；云端镜像 **100 / 100** |
| 全量 JS 测试（`npm test`） | **205 文件 / 3310 用例**，通过 205 / 失败 0 / 超时 0（24.6s） |
| Python 导入测试（`npm run test:py`） | **36 用例全通过**（2.6s） |
| 云端镜像同步（`npm run check:cloud-sync`） | **一致**（100 个文件逐字节匹配） |
| 敏感信息与文档审计 | `check:secrets` 0 命中；`doc-audit.js` 25 条数字断言 0 差异、0 冻结文档改动、125 条链接全可达 |
| 小程序运行时禁区 | `miniprogram/**` 全部审查文件未见裸写 `process` / `Buffer` / `__dirname` / `__filename` / `require('fs')` |

> [!CAUTION]
> **最重要结论**：尽管本地 3310 条测试全绿，本次审查发现了 **5 个 P0 级缺陷**（其中 2 个在真实微信云端**100% 必现阻断**，因本地单测使用短假 ID 或 mock 门面未能暴露）：
> 1. **真实注册账号 `acc:<40位hex>` 含冒号且长 44 字符**，与运动会主键校验冲突 → **真实微信用户完全无法使用运动会写流程**；
> 2. **云端 `forMeet` 写动作被 `guardWrite` 吞掉 `throwOnRefused` 异常** → **云端 32 个运动会写接口在业务拒绝/失败时全部误报成功或崩溃**；
> 3. **停用平台管理员绕过状态校验**，仍可发布/下架全校公告；
> 4. **12 人单败淘汰赛首轮误命中八强逻辑**，导致名次错乱或完赛后恒返回 `null`；
> 5. **赛季重置后 `applyTrainingFactDelta` 锚点判据过严**，每次 0 分/新会员首次签到均触发 4 表全量重算风暴。

---

## 一、第 10–20 轮发现问题修复闭环核查

共逐条核查了第 10 轮（A/B/C）、第 11 轮（A/B/C）、第 12 轮（A/B）、第 13 轮、第 14 轮、第 15 轮、第 16 轮、第 17 轮（依据 `git show 7a40007`）、第 18 轮、第 19 轮、第 20 轮（并交叉比对第 21–22 轮后续修改）。

### 1.1 各轮闭环总体统计

| 轮次 | 核心主题 | 总体闭环度 | 未完全闭环 / 同类漏修 / 回归条目 |
|---|---|---|---|
| **第 10 轮 A** | 前后端界面契约（11 项） | 10 / 11 完全修复 | #2 学籍与管理学院混用在**团队学院赛**与**身份会话 `canManageCollege`**漏修 |
| **第 10 轮 B** | 信封一致性（5 项 + 暂缓） | 4 / 5 完全修复 | #3 云端 `forMeet` 写拒绝被 `guardWrite` 吞掉异常（**P0 级未闭环**）；`getMySchoolMembership` 仍零业务调用 |
| **第 10 轮 C** | 边界、并发、性能（9 项） | 4 / 9 完全修复 | B-1 训练时间进位漏修；B-3 多处 `userId` 未判长；B-5 零宽字符仅落 `meet-service`；C-2 事务内 `Promise.all` 漏修且 R22 回潮；P-1 运动会 3 处绕过 `loadColleges` |
| **第 11 轮 A** | 前端体验优化 F01–F17 | 全部落地 | 无回归（但引入了少量可精简的过度前端校验，见第三部分） |
| **第 11 轮 B/C** | 只读审计与 P3 补修（13 项） | 9 / 13 完全修复 | P1-2 `readCostOf` 漏降 `userIds` 批读成本；P2-6 mock 端未捕 `SCHOOL_INACTIVE`；P2-7 `match-panel` 翻页缺序号/去重/`syncLiveWatch`；P2-8 `listTeams({mine:true})` 虚拟院队分页跳过第 `limit+1` 条 |
| **第 12 轮 A/B** | 个人体育中心与审计修复 | 主体修复 | 裁判搜索（`event-detail` / `college-event-detail`）缺请求序号与 `try/catch`；`personal-sports-query.js` 含 2 处字段名拼错（`$recordTime` / `$hubEvent.finishTime`） |
| **第 13–15 轮** | 赛季积分物化与 P0–P2 修复 | 13 / 15 完全修复 | **R13 #3** `removeTrainingRegistration` 增量成功后仍误触发全量重算；**R13 #4** 内存端残留死方法 `seasons.update` |
| **第 16 轮** | P3 收尾与写读成本（4 项） | 3 / 4 完全修复 | **R16-3** `removeTrainingRegistration` 实际读成本约 20+ 点（因误触发全量重算），与定价 2 点失真；暂缓 #5 注释未补 |
| **第 17 轮** | 配置自举/脱敏/钩子/竞态（7 项） | 6 / 7 完全修复 | **R17-4** `team-detail` 与 `college-lineup` 漏补请求序号与卸载守卫（仅补了失败清数据与 `safeRouteId`） |
| **第 18 轮** | 读成本/分页/转校窄查/守卫（10 项） | 9 / 10 完全修复 | **R18-2** 内存端 `memoryMatchPage` 漏夹 `PAGE_SIZE - 1`（99）与默认 `limit = 20`；R18-4 静态守卫偏弱（不剥注释、写死 `ctx.repo.`） |
| **第 19 轮** | 聚合/容量/荣誉/名册分页（12 项） | 10 / 12 完全修复 | **R19-3** `applyTrainingFactDelta` 调 `bumpSeasonVersion` 传 `new Date(ctx.now)` 缺 `\|\| Date.now()`；**R19-4 + R22** 回退快照时 `nickOf` 漏收 `userIds` 暴露裸 ID，且 `metadataOnly` 误触发回退；R19-8 `getSchoolMembers` 重复批读 `users` 且只读态白读权限表 |
| **第 20 轮** | 并发/版本/限组见证/观赛预算（9 项） | 5 / 9 完全修复 | **R20-2** `resetMeetDraw` 漏拦胜负项目已判胜场次；**R20-4** `saveMeetSession` 用旧 `meet` 覆写回滚 `contentRevision`，且 `releaseEntry` 20 人撤回超 100 次事务预算；**R20-5** `submitCollegeEntry` 把全部 20 组纳入见证而非仅实际命中组（过度防御）；**R20-9** `team-event-service.toMatchTime` 与训练/学院赛时间仍进位或偏 8 小时 |

### 1.2 第 10–20 轮未完全闭环项核心证据速查

1. **R10B #3（云端高危 P0）**：[school-cloud.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-cloud.js#L34-L52) 与 [school-cloud.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-cloud.js#L249-L250) 中，`forMeet` 传 `{ throwOnRefused: true }` 并在第 47 行抛出 `Error`，但第 50 行对所有写动作无条件执行 `isWrite ? guardWrite(run) : run()`，而 32 个运动会写动作全部登记在 [write.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/write.js#L143-L180) 的 `SCHOOL_WRITE_ACTIONS` 中，异常立刻被 `guardWrite` 吞掉转为 resolve `{ ok: false }`，与 mock 端和 6 个运动会页面的 `try/catch` 完全矛盾。
2. **R10A #2（同类漏修）**：[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L310-L314)、[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L496-L503)、[school-membership-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-membership-service.js#L552-L574) 及 [team-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-service.js#L303) 仍用学籍 `schoolMember.collegeId` 判定 `manageCollege`，导致“学籍在 A 院、授权管理 B 院”的学院负责人会话返回 `canManageCollege: false` 且看不到 B 院石榴籽杯报名入口。
3. **R10C C-2（事务内并发读漏修与回潮）**：[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L3253-L3259)（`liveStatContext` 被 `startTeamLiveScore:3362` 在事务内调用）、[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L1389-L1392)、[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L2002-L2005)、[team-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-service.js#L965-L967)、[meet-context.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-context.js#L58-L75) 以及第 22 轮新增的 [association-group-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/association-group-service.js#L109-L128)（20 路 `Promise.all`）仍在事务内并发点读。
4. **R11B P2-8（分页漏项）**：[team-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-service.js#L293-L333) 在 `mineOnly && offset === 0` 时执行 `page.unshift(collegeTeam)` 使 `page.length` 变为 `limit + 1`，随后用含虚拟行的 `page.length` 计算 `hasMore` 与 `nextOffset`，导致加入 ≥ `limit + 1` 支真实球队时 `rows[limit]` 被永久跳过。
5. **R13 #3 + R16-3（回归/未闭环）**：[association-training-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/association-training-service.js#L774-L784) 中 `removeTrainingRegistration` 保留了 `if (result && result.ok && (pointsChanged || pointsNeedRefresh)) await refreshAfterWrite(ctx)`，导致增量扣分成功后仍多跑一次 4 表全量扫描重算。
6. **R17-4（不完全修复）**：[team-detail.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageTeam/team-detail/team-detail.js#L54-L145) 与 [college-lineup.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageCollege/college-lineup/college-lineup.js#L51-L120) 仅补了 `safeRouteId` 与失败清数据，遗漏了 `loadEpoch` 请求序号与 `onUnload` 隔离。
7. **R18-2（双端分叉）**：[match-list-query.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/match-list-query.js#L75-L87) 的 `memoryMatchPage` 未对齐云端 `PAGE_SIZE - 1`（99）夹取与默认 `limit = 20`（缺省时 `slice(0, NaN)` 返回空数组）。
8. **R19-4 + R22（不完全修复）**：[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L1072) 与 [meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L1161-L1198) 在派生表不完整回退到快照 `doc.rows` 时，未从 `doc.rows` 收集 `userIds` 导致展示裸 `acc:...`；且 `payload.metadataOnly` 将 `selectedRows` 置 `[]` 后反而误触发了 `publishedRowsOf` 的快照回退。
9. **R20-2 / R20-4（不完全修复与回归风险）**：[meet-advance-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-advance-service.js#L982-L990) `resetMeetDraw` 漏查 `own.some(doc => doc.winnerEntryKey)`；[meet-schedule-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-schedule-service.js#L155-L190) `saveMeetSession` 在 `touchEvent` 后用第 155 行旧 `meet` 对象写回 `scheduleRevision + 1`，静默覆盖回滚了 `contentRevision`；[meet-registration-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-registration-service.js#L705-L744) `releaseEntry` 叠加 `touchEvent` 后 20 人团体撤回达 ~115 次事务操作，越过 100 上限。

---

## 二、全模块系统性审查发现（按严重级别）

### 2.1 P0 阻断级缺陷（上线即故障 / 越权 / 数据错乱）

#### [P0-1] 运动会主键校验与真实微信注册账号 ID 格式冲突，导致云端运动会全流程 100% 瘫痪
- **位置**：[school.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/school.js#L214-L220)、[meet-scope.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/meet-scope.js#L115-L120)、[meet-scope.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/meet-scope.js#L177-L247)、[meet-college-lead-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-college-lead-service.js#L38-L47)
- **原因**：真实微信用户主键由 `schoolAccountKey(openId)` 生成，固定形如 `acc:<40位hex>`（**长度 44、含冒号 `:`**）。而 `meet-scope.js` 的 `part()` 严格抛出 `if (text.includes(':')) throw new Error(...)`，并被 `meetInterestKey`、`meetClaimKey`、`meetParticipantCounterKey`、`meetJudgeKey`、`meetScoreKey` 全部调用；`meet-college-lead-service.js` 的 `idOf()` 同时禁止 `:` 且限制 `MAX_ID_LENGTH = 40`。
- **影响**：本地单测使用 `u1` 等无冒号短假 ID 全部通过；真机云端任何真实注册账号在运动会中无法任命学院部长、无法提交/撤回参赛意向、无法被报进正式名单、无法被指派为裁判、无法录分。
- **修复建议**：`meet-scope.js` 对 `userId`/`judgeId` 段使用 `encodeURIComponent`（与 `schoolKey` 保持一致）或允许安全编码段；`meet-college-lead-service.js` 将用户 ID 上限放宽至 ≥ 64 且允许合法 `acc:` 格式，并在 `tests/meet-*.test.js` 加入 `schoolAccountKey('real_openid')` 端到端回归测试。

#### [P0-2] 云端 `forMeet` 写动作被 `guardWrite` 吞掉异常，32 个运动会写接口在拒绝/故障时全部误报成功或崩溃
- **位置**：[school-cloud.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-cloud.js#L34-L52)、[school-cloud.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-cloud.js#L249-L250)、[write.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/write.js#L143-L180)
- **影响**：云端模式下所有运动会写操作遇到权限不足、截止超时、名额超限或网络异常时，都不会进入 6 个运动会页面的 `catch` 分支，导致假成功提示或 `TypeError`。
- **修复建议**：[school-cloud.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-cloud.js#L50) 改为 `return isWrite && !throwOnRefused ? guardWrite(run) : run();`，并在 `tests/school-write-guard.test.js` 补齐 `forMeet` 写拒绝 reject 断言。

#### [P0-3] `school-permission.js` 的 `isPlatformAdminCtx` 漏检停用状态，停用平台管理员仍可发布/下架全校公告
- **位置**：[school-permission.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-permission.js#L70-L72)（对比 [meet-permission.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-permission.js#L33-L35)）、[school-announcement-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-announcement-service.js#L83-L85)、[school-membership-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-membership-service.js#L580)
- **原因**：`school-permission.js` 的 `isPlatformAdminCtx` 仅判 `platformRole === 'admin'` 而未判 `platformStatus === 'active'`；`school-announcement-service.js:84` 又在已包含管理员放行的 `canSchoolAction` 前多写了冗余的 `isPlatformAdminCtx(ctx) ||`，导致被停用的平台管理员直接绕过状态与学校启用检查，发布/下架任意学校公告（且会话也对其下发 `isPlatformAdmin: true`）。
- **修复建议**：在 `school-permission.js:isPlatformAdminCtx` 补齐 `ctx.actor.platformStatus === PLATFORM_STATUS.ACTIVE`，并删除 `school-announcement-service.js:84` 冗余的 `isPlatformAdminCtx(ctx) ||`。

#### [P0-4] 12 人单败淘汰赛首轮误命中八强分支，导致名次错乱或完赛永远返回 `null`
- **位置**：[format-plan.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/format-plan.js#L856-L881)（对比 [draw.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/draw.js#L761-L764)）
- **原因**：12 人单败（16 签位、4 轮空、`totalRounds = 4`）第 1 轮恰好产生 `losers.length === 4, winners.length === 8`。`placementsFromBracket` 仅判 `if (losers.length === 4)` 而漏判 `round === totalRounds - 2 && winners.length === 4`：未开 TOP8 时把 9–12 名错判为并列第 5 名；开 TOP8 时去查不存在的第 2 轮排位赛，导致恒返回 `null` 无法结算名次。
- **修复建议**：改为 `if (round === totalRounds - 2 && winners.length === 4 && losers.length === 4)`。

#### [P0-5] 赛季重置后 `applyTrainingFactDelta` 锚点判据过严，每次 0 分/新会员首签触发 4 表全量重算风暴
- **位置**：[season-points.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/season-points.js#L357-L361)（对比第 175、228 行）
- **原因**：`refreshAssociationPoints` 为省写操作刻意跳过 0 分会员行（其 `anchorOfRow` 保持 `''`）。赛季重置后 `anchor` 非空，所有 0 分会员或新会员本赛季首次确认签到时均因 `'' !== anchor` 命中失败回退，触发 `needsRefresh: true` → 整协会 4 张集合全量读 + 分批回写。一场 50 名新生的训练确认签到 = 50 次全协会整表重算。
- **修复建议**：与 `settledPointsOf:175` 对齐，当 `pointsOfRow(row, association) === 0 && anchorOfRow(row, association) === ''` 时视作合法本赛季 0 分基线直接增量落库。

---

### 2.2 P1 高危缺陷（功能故障 / 越权 / 云端事务与双端契约违背 / 明显性能瓶颈）

#### A. 安全性与权限边界
1. **已结束学院赛小场仍可录分、确认、驳回并推进大场**：[school-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-match-service.js#L697-L702) 的 `finishedEventBlocker` 仅查 `doc.eventId`，未查 `doc.collegeEventId`，[school-college-advance.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-college-advance.js#L48-L69) 同样无终态拦截。
2. **运动会总裁判离校/停用后仍可发布和篡改成绩**：[meet-permission.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-permission.js#L103-L124) 的 `isChiefJudge` / `canPublishMeetResult` 只读 `meet.chiefJudge` 快照，完全未校验 `isActiveActor(ctx)` 与 `isLocalActiveMember(ctx)`。
3. **`withdrawMeetInterest` 事务内未重读身份与运动会状态**：[meet-registration-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-registration-service.js#L345-L363) 缺失 `freshMeetContext` 与 `meet.status` 校验。
4. **转校与授权边界漏洞**：[school-membership-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-membership-service.js#L226-L229) `applySchoolTransfer` 未拦截已被目标校禁用的 `disabled` 会籍；`grantSchoolPermission`（725–763 行）漏检 `primarySchoolId`、撤销 `ASSOCIATION_LEADER` 时可能误撤 `staff`、协会负责人可对校级管理员写入脏 `memberships`。
5. **发布/编辑活动未校验 `audienceGroupIds` 存在性、归属与归档状态**：[association-training-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/association-training-service.js#L470-L582)、[school-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-event-service.js#L602-L624)、[school-college-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-college-service.js#L453-L477) 均只做纯格式校验，未在事务内点读核验小组有效且未归档。
6. **顶层 `liveScores.listByIds` 未内置范围条件且缺 `inTx` 保护**：[cloud-repo.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/adapters/cloud-repo.js#L547-L558) 违背仓储原语必须自带 scope 红线，应迁移至 `forScope(ctx).liveScores.listByIds`。

#### B. 云端事务契约、预算超限与仓储正确性
7. **多处事务内「同集合写后再读不同 doc」及「事务内 `Promise.all` 并发读」（本地全绿、云端炸裂）**：
   - 同集合写后再读不同 doc：[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L906-L923)（`publishMeetResults` 只要 ≥2 学院得分即触发）、[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L994-L1000)（`writeDetailBatch`）、[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L424-L463)、[meet-advance-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-advance-service.js#L196-L221)、[meet-schedule-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-schedule-service.js#L438-L465)、[meet-registration-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-registration-service.js#L629-L646)、[exchange-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/exchange-service.js#L599-L614)。
   - 事务内并发 `Promise.all`：`meet-context.js:58-75`、`team-event-service.js:1389, 2002, 3253`、`team-service.js:965`、`association-group-service.js:109-128`。
8. **5 处批量写单事务操作数越过或逼近 100 上限**：
   - `meet-registration-service.js:705-744`（`releaseEntry` 20 人团体撤回 ≈ 115 次操作）；
   - `exchange-service.js:493-507`（16 人单循环 120 场 / 32 人小组赛 112 场无事务容量拦截）；
   - `team-event-service.js:563-588, 859-869`（`commitEventChange` 导致 10 队循环赛抽签与 12 队结算失败；足球 28 人报名 95–97 次紧贴红线）；
   - `football-match-service.js:106-152`（`related <= 70` 加前后读写达 86–100+ 次）；
   - `meet-advance-service.js:813-854, 991-1024`（`setMeetMatchWinner` / `resetMeetDraw` 缺操作数预检）。
9. **`cloud-repo.js` `cursorCond` 对 `cmd.and(...)` 返回的 `LogicCommand` 做对象展开，第 2 页查询失效**：[cloud-repo.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/adapters/cloud-repo.js#L257-L262) 遇 [scoped-team-reads.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/scoped-team-reads.js#L48-L52) 传入的 `command.and([...])` 时，`{ ...base, ...next }` 会破坏 `LogicCommand` 原型，超 100 条翻页时赛程冲突检测失效；同时 `ids` 未按 100 分片。
10. **`rate-limit.js` `guardDaily` 先累加再判超限，单次高成本拒绝永久锁死当天后续低成本请求**：[rate-limit.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/core/rate-limit.js#L266-L289) 在未通过校验前直接执行 `row.read += readCost` / `row.poll += ...`。
11. **`member-page.js` `readMemberCount` 将未回填脏账号计入关键词总数且不报错**：[member-page.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/adapters/member-page.js#L34-L39)、[member-page.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/adapters/member-page.js#L68-L72) 与 `readMemberPage` 语义分叉，且无关键词时仍投影大字段再丢弃。

#### C. 业务逻辑与数据完整性缺陷
12. **团队循环赛允许平局时，相互战绩把平局误计为 B 队胜场**：[team-standings.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/team-standings.js#L112-L116) 中 `match.winner === null` 落入 `else` 分支归给 `teamB`。
13. **运动会重抽作废场次（`voidedAt`）在 4 处漏过滤，重抽缩减组数后永久卡死晋级与发布**：[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L490-L493)、[meet-score-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-score-service.js#L659-L662)、[meet-advance-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-advance-service.js#L285-L287)、[meet-advance-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-advance-service.js#L492-L495)；且 `resetMeetDraw` 漏拦已判胜场次、未清裁判字段。
14. **篮球单败淘汰赛未打完后续轮次即可提前结算完赛**：[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L2245-L2252) 仅对 `football11` 检查 `planNextRound`。
15. **足球已结束赛事改判未清理 `entry.placement`，且 `footballAudit` 嵌套保存整份历史报告会撞 300KB 上限锁死比赛**：[football-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/football-match-service.js#L156-L160)、[football-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/football-match-service.js#L211)。
16. **个人赛事重抽人数减少时未作废多余旧首轮比赛（残留幽灵场次）**：[school-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-event-service.js#L848-L863)。
17. **审计主键碰撞静默覆写历史留痕（4 处）**：[school-college-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-college-service.js#L1053)（误传 `tie.eventId`）、[association-training-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/association-training-service.js#L686-L694)（重报重置 `revision=1`）、[school-membership-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-membership-service.js#L766)、[exchange-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/exchange-service.js#L454-L455)（同 `next.revision` 连写两条）。
18. **赛季重置与跨赛季边界 4 处缺陷**：`resetSchoolSeason` 存 `Date` 对象而非 ISO 串致 `anchorOf` 双端漂移（[school-rank-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-rank-service.js#L1087-L1090)）；`submitSchoolMatch:565` 用事务外旧 `pairUsage` 误拒新赛季首场；`releasePairUsage:181` 驳回旧赛季比赛扣减新赛季额度；`school-points-service.js:64` 非法 `endedAt` 反而计入新赛季。
19. **个人体育中心聚合字段拼错**：[personal-sports-query.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/personal-sports-query.js#L56) 误写 `$recordTime`（实际为 `$actedAt`）、第 126 行误写 `$hubEvent.finishTime`（实际为 `$hubEvent.finishedAt`）。
20. **`saveMeetSession` 写回旧 `meet` 快照覆写回滚 `contentRevision`**：[meet-schedule-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/meet-schedule-service.js#L155-L190)。

#### D. 前端功能、样式与生命周期高危缺陷
21. **19 个页面/组件在模块加载期解构冻结 `isMock`**：[runtime-mode.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/runtime-mode.js#L68-L75) 的 `isMock` getter 被 `const { isMock } = require(...)` 提前求值，主包 `pages/profile` 及 `events-panel` / `match-panel` / `rank-panel` 在云端真机上会被永久锁死为 `isMock = true`。
22. **个人详情 / 他人主页切项目时曲线、交锋、搭档与战绩全部错位**：[profile-view.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/profile-view.js#L167-L176) 未将 `project` 透传给 `getSchoolMemberProfile`，导致把双打起点与单打历史曲线混拼。
23. **`app.wxss` `--brand-*` 别名受 CSS 自定义属性求值机制影响，协会空间面板换肤失效**：[app.wxss](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/app.wxss#L92-L94) 在 `page` 上声明 `--brand-color: var(--color-primary)` 立即求值为石榴红，子节点 `.assoc-*` 改写 `--color-primary` 不会重新计算 `--brand-color`，致 [association-space-panel.wxss](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/components/association-space-panel/association-space-panel.wxss#L73-L75) 等 7 处永远卡死红色。
24. **编辑“限组训练”静默清空已选小组**：[association-space-panel.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/components/association-space-panel/association-space-panel.js#L1044-L1066) 的 `describeTraining` 丢弃了 `audienceGroupIds`。
25. **石榴籽杯第 2 页起漏行整形**：[cup-home.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageCollege/cup-home/cup-home.js#L386) `loadMore` 未经 `collegeRowsOf()` 直接拼接原始 DTO。
26. **运动会报名/补报窗口提交无时区时间串，云端 UTC 偏移 8 小时**：[meet-detail.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageMeet/meet-detail/meet-detail.js#L378-L410)。
27. **首页加载器吞掉全部失败并写 5 分钟缓存（伪空态）**：[school-home-view.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-home-view.js#L155-L193) 与 [index.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/pages/index/index.js#L248-L280)（同类：`school-college-view.js:934`、`school-event-view.js:463-477`）。
28. **15 处写操作缺 `try/finally` 释放防重锁 + 5 处写入口缺防重拦截**：异常时按钮永久锁死（`event-detail`、`event-placement`、`college-event-detail`、`college-entry-review`、`college-lineup`、`college-match`、`college-placement`、`login`）；缺防重拦截（`match-panel.onConfirm`、`team-detail.onSavePick`、`meet-setup.onSubmit`、`meet-schedule.submitChiefJudge`、`school-identity.submitGrant`）。
29. **未入册用户编辑资料或头像上传失败时静默清空既有头像**：[school-profile-view.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-profile-view.js#L77)、[profile-edit.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageMember/profile-edit/profile-edit.js#L156-L159)。

#### E. 重点性能瓶颈（读放大 / N+1 / 无防抖 / 瀑布流）
30. **服务端高频 N+1 与整表读**：
    - `exchange-service.js:370-398`（`reviewEntrants` 最多 128 人 × 3 串行点读 = 384 RPC）；
    - `school-event-service.js:559-560`（`listSchoolEventSignups` 逐人 `schoolMembers.getById`）；
    - `meet-college-lead-service.js:159-163`、`meet-schedule-service.js:392-397`、`meet-score-service.js:205-210`、`exchange-service.js:655-659` 均在 `for` 循环中串行 `getById`；
    - `school-rank-service.js:686-710`（`getSchoolMemberStats({top:10})` 仍拉全校 `schoolMembers` + 全校 `users`）；
    - `team-event-service.js` 5 个单场接口整表读 `teams.list()`，`getTeamMatchStats` 整表读全届 `entries`/`stats`；`team-profile-data.js:16` 读出无关球队的历届全部比赛；`meet-standing-service.js:53-59` 并发把 `sportsMeetColleges.list()` 重复读两遍；`meet-score-service.js:1141` 在 `limit:10` / `metadataOnly` 时仍全表读数千条 `sportsMeetResultRows`；`association-group-service.js:247` `getAssociationGroup` 整表扫全协会小组成员；`school-college-service.js:359, 389, 645` 整表扫历史学院赛。
    - `cloud-repo.js:34-73`（`loadProfileMatches` 每页多发 2 次无用聚合计数 RPC，最多白发 12 次）；`event-list-page.js:64-74` 无筛选时重复跑 2 次相同 `io.count`。
31. **前端无防抖直发 RPC 与冷启动瀑布流**：
    - `meet-setup.js:357-373` 按键直发写库 `configureMeetEvent`；`meet-college.js:335` 与 `meet-schedule.js:837` 按键直发搜索无防抖无序号；
    - `profile-view.js:295-300` 与 `association-usage.js:49-71` 6 个协会串行 `for ... await`；`school-home-view.js` 3 轮串行 RTT（单次进首页约 16 次云调用）；
    - `pages/association-home` 用 `hidden` 缓存面板，5 个面板 `pageLifetimes.show()` 未检 `active` 导致子页返回惊群刷新；7 个详情页每次 `refresh()` 多串行 1 次 `getSchoolIdentitySession`；`match-entry` 与 `live-score` 连续双查同一场 `getSchoolMatch`。

---

### 2.3 P2 中等缺陷汇总（按域精简罗列）

- **后端正确性与状态机**：
  - `school-rating-service.js:486-488` 结算建档忽略 `initialEloByAssoc[assoc]`；`137, 262-269` 补录已转校者硬编码 `memberStatus: 'active'`；`school-membership-service.js:382` 转回原校不恢复原校评级状态。
  - `school-request.js:129` `getMySportsDashboard` 缺 `!event.schoolId` 拦截；`cloudfunctions/data/index.js:100` 未防 `event = null`；`school-cloud.js:42` 未防 `callFunction` 返回空解构。
  - 多个仓储 `listByEvent` 与云端 `memberships.listByUser` 缺非空字符串守卫；`personal-sports-query.js` 去重保留首条（云端）与末条（内存端）相反。
  - `school-rank-service.js:964` `beatPercent` 未用 `Math.max(total, rank)`；`school-event-service.js:466` `myGroupIds` 未排 `deleted`；`association-group-service.js` 多处写返回硬编码 `joined: false`；4 处游标 `decodeURIComponent` 未 `try/catch` 可致 500；`college-directory.js:63-64` 超上限先 `set` 后 `clear()` 把刚写入项清空；`school-college-service.js:864` `startCollegeTie` 未核 `tie.revision`。
  - `team-event-service.js:1571` 空统计被 `Number('')` 存成 `0`；`football-report.js:94` 仅录直红时 `dismissals` 算成 `null`；`meet-service.js:659` 复配软删除项目致 `eventCount` 失真；`meet-advance.js:169, 487` `heatRank` 错装全局名次、6 队出线未出线名次跳号到第 9；`live-watch.js:67` 指纹漏网球抢七/盘分；`scoped-team-reads.js:42` 与 `football-schedule-service.js:52, 65` 存在 `NaN` 抛 `RangeError` 与严格相等隐患；`football-event-form.js:181` 非法 `presetKey` 抛 `TypeError`。
  - 写接口缺失终态拦截：`withdrawMeetCollegeEntry`（漏拦已抽签）、`openMeetLateWindow`（漏拦草稿/终态）、`setMeetEventProcedure`（漏拦终态）、`publishTeamMatch` / `reviewTeamMatchStats` / `saveTeamMatchStats`（漏拦已取消/已结束）、`grantMeetCollegeLead` / `appointMeetChiefJudge`（漏检主校或账号有效）、`getMeetBracket`（漏拦草稿）、`school-live-service.js:224` 无权返回空列表而非拒绝。
- **前端生命周期、五态与样式**：
  - `team-detail.js:269-283` 归档失败仍强制 `navigateBack()`；`my-team-profile.json` 开启下拉刷新但 `.js` 无 `onPullDownRefresh`；`school-exchange.js:107` `schoolIndex === -1` 崩溃风险。
  - `event-detail.js` 与 `college-event-detail.js` `onUnload` 均漏清 `refereeTimer`；`events-panel` `detached()` 调用不存在的 `this.onUnload`；`team-panel` / `team-events-panel` / `association-space-panel` 卸载未作废在途请求；`live-score.js` `await` 后漏检 `this.destroyed`。
  - 多处页面绕过 `app.setAssociation` 直接调 `scope.setAssociation` 造成 `globalData` 与 `scope` 状态分裂；`pages/association-home` 与 `association-space-panel` 未判 `isMockNow()` 直接读 `school-demo.js`；4 处路由拼 `userId` 漏编码、2 处读路由参数漏解码；4 个表单页重试不复用 `requestId`。
  - 3 处驳回/退回确认按钮（`match-panel`、`college-entry-review`、`member-review`）误用主色 `.btn-primary` 而非危险色 `.btn-danger`。
  - `match-entry.js:209` 全校名录进 `setData`、`match-panel` 100+ 场记录双份进 `setData`、`team-event-detail` 对无直播的 `scheduled` 场次盲目轮询、`team-live-score` 单次判球触发 3 次同步 `wx.setStorageSync`、`football-match` 按键触发深拷贝与多次 `setData`。

---

## 三、专项审查：过度且不必要的安全性防范（重点关注）

以下 10 类实现属于典型的**过度防御 / 防御错位**——不仅没有带来实质安全增益，反而直接造成了**缓存失效、日预算误杀、事务容量腰斩、并发归零、DB 读放大 2–35 倍或代码维护负担飙升**：

| 编号 | 位置 | 过度防御行为 | 实际副作用与建议 |
|---|---|---|---|
| **O-1** | [school-request.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/core/school-request.js#L45-L60)、[school-request.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/core/school-request.js#L159-L167) | **上下文缓存过度失效**：纯比分动作每记一球都调用 `contextCache.invalidateScope`；其余 ~115 个不碰身份/学校/协会表的业务写动作（录分/报名/通知/录成绩等）全部 `invalidateAll()` 清空**跨校**全容器缓存 | 比赛直播期间裁判每记一球就精准打穿所有观赛观众的身份缓存（每人下一次 2s 轮询多发 6 次 DB 点读）；任意学校一次普通写让其他学校全员缓存失效。<br>**建议**：改为显式维护 ~15–20 个会修改上下文表的「身份/范围写动作白名单」才触发失效，纯业务写不失效上下文缓存。 |
| **O-2** | [team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L551-L588)、[team-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-event-service.js#L851) | **`commitEventChange` + `sameRecord` 过度逐条比对与空读**：已有 `event.revision` 版本戳，却仍把全届 `entries`/`matches` 及所有**新建** `writes` 逐条 `getById` + 递归排序 `JSON.stringify` 深比对；足球报名对整条 `event` 做 `sameRecord` | 直接把单事务容量砍半（致 10 队循环赛抽签失败、12 队无法结算），并彻底消灭多队并发报名能力。<br>**建议**：改用 `event.revision` 单点版本核对，删去新增文档空读与全表 `sameRecord`。 |
| **O-3** | [football-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/football-match-service.js#L101-L138)、[football-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/football-match-service.js#L179-L214) | **无条件全届 `related` 锁死 + 事务内外重复 `readTarget`**：为极低概率的「淘汰赛改判翻转胜方」场景，对循环赛/首次发布/驳回全量读入最多 70 场并逐条锁 `revision`；事务外读 6 条后进事务原样再读 6 条 | 读放大 10–35 倍，同届任意两场无关足球赛并发发布必然冲突失败。<br>**建议**：仅在确实发生「已发布淘汰赛胜方翻转」时按需读下游 1–2 场，移除冗余事务外全套 `readTarget`。 |
| **O-4** | [school-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-match-service.js#L536-L573) | **`submitSchoolMatch` 无条件开额外空事务 + 3 遍读 `pairCounts`**：99% 情况下计数文档早已存在，仍每次开启独立事务 `ensurePairCounters` 空跑一遍；主事务内又用事务外旧快照重复跑 `findCappedPairs` | 每场日常录分白白多消耗 1 个完整云数据库事务，还引入了跨赛季误拒 Bug。<br>**建议**：仅当 `pairUsageOf` 发现缺失计数文档时才调 `ensurePairCounters`，删除事务内冗余的旧快照 `findCappedPairs`。 |
| **O-5** | [school-live-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-live-service.js#L86-L200) | **高频判球写接口事务内外双/三重 `guard`**：`recordSchoolRally` 等 4 个写动作在事务外查 `match` + `recordDirOf`，进事务第一行原样再查一遍；`finishSchoolLiveScore:197` 甚至第三次重读并重跑 4 条校验 | 实时计分每记一球白耗 2–3 倍 DB 点读。<br>**建议**：纯参数格式校验留事务外，DB 读取与权限 `guard` 仅在事务内跑一次。 |
| **O-6** | [school-college-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-college-service.js#L501-L554) | **`submitCollegeEntry` 把全部 20 个受众组纳入见证 + 叠放协会级全局删除版本**：不按本次名单实际命中的小组见证，而是全量锁死全部 `availableGroups`，同时仍保留 `schoolAssociation.groupDeletionRevision` 全局比对 | 30 人报名最高耗 90 次事务操作（贴近上限），且赛事内其他 19 个无关小组或本协会任意无关小组被删都会误拒合法提交。<br>**建议**：仅点读核对本次实际命中的 `witnesses` 组，移除冗余的协会级 `groupDeletionRevision` 比对。 |
| **O-7** | [rate-limit.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/core/rate-limit.js#L78-L160) | **读成本表按历史整表读重罚已优化接口**：已改 TopN/分页/批读的 `getSchoolRanking`(30)、`getSchoolMatchEntryContext`(20)、`listSchoolEvents`/`listCollegeEvents`/`listSchoolMatches`(10)、`getMyMeetHonors`(10) 以及 `listSchoolMembers({userIds})`(40)、`getSchoolMemberStats({userIds})`(30) 仍按重成本扣费 | 首页刷新一次扣 120+ 点、启动探测 6 协会扣 180 点，叠加预扣 Bug 极易误杀正常活跃用户。<br>**建议**：按当前真实 RPC 量级重校准成本表并补齐 `userIds` 批读降档。 |
| **O-8** | [school-match-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-match-service.js#L745-L839)、[school-event-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-event-service.js#L494-L933)、[team-service.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/team-service.js#L345-L678)、[school-repository.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/school-repository.js#L120-L139) | **非必要防御性重读与双层封装**：① 非 `ROLE.STAFF` 路径为兼容旧栈 `actor` 盲调 `recordDirOf`/`actorDirectory`（最多多发 7 次点读）；② `getTeam`/`getCollegeTeam` 重复调用 2–3 次整校 `buildDirectory`；③ `buildScoped.write` 非事务路径开事务后读检两遍、`instrumentTransaction` 重复 `stripForStorage`；④ `matchListWhere` 对已落库正常字段加 `$type/$not` 妨碍纯索引覆盖计数；⑤ `meet-service`/`meet-college-lead-service` 读动作重跑无缓存 `buildMeetContext` | 均不提升安全边界，纯消耗云开发 DB 读写配额与 CPU。<br>**建议**：按角色/分支按需读目录、去重 `buildScoped.write` 与重复 `buildDirectory`、放开 `matchListWhere` 冗余 `$type` 过滤。 |
| **O-9** | [detail-experience.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/templates/detail-experience.js#L5)、[form-experience.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/templates/form-experience.js#L47-L63)、[notice-experience.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/templates/notice-experience.js#L27)、[football-match.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageTeam/football-match/football-match.js#L51-L148)、[association-space-panel.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/components/association-space-panel/association-space-panel.js#L469-L1347) 等 10+ 处 | **前端对静态 WXML `dataset` 与纯 UI 折叠态做冗长“防注入白名单/正则/O(N)存在性校验”**：例如仅展开公告正文或切换“更多操作”菜单，先 O(N) 扫描列表；为静态 WXML `data-field` 维护十余份硬编码白名单与正则 | 小程序 WXML 为签名打包产物，且服务端写入全量重验，前端无此类安全攻击面；反而新增字段忘加白名单即静默失效。<br>**建议**：仅保留防空/防越界的最小防御，移除伪安全白名单。 |
| **O-10** | [football-match.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageTeam/football-match/football-match.js#L56-L211)、[school-exchange.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/packageMember/school-exchange/school-exchange.js#L247-L252)、[form-experience.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/templates/form-experience.js#L15-L57)、[school-match-view.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-match-view.js#L40-L43) | **前端全表单 `JSON.stringify` 防篡改指纹 + 算完即丢的旧权限重算**：模态框已阻塞交互且输入已清 review，仍前后全量 `JSON.stringify` 比对；只读审核人点审核前重跑全量报告归一化比对；`school-match-view` 跑完 5 套旧权限公式后下一行立刻用服务端 `dto[key]` 全部覆盖丢弃 | 造成按键卡顿与维护噪音，无实际安全收益。<br>**建议**：用轻量 `dirty` 布尔标记替代 `JSON.stringify` 指纹，彻底删掉 `school-match-view` / `school-event-view` 中被服务端 `can*` 覆盖丢弃的旧权限计算与 `signupsFromSummary` 假数组构造。 |

> [!TIP]
> **反向盲区提示**：与上述过度重读形成反差的是，`association-group-service`、`association-notice-service`、`association-training-service`、`school-event-service`、`school-college-service`、`school-announcement-service` 的多数管理写接口**缺少事务外廉价的内存 `ctx` 权限快拒**，导致无权请求白开一次云数据库事务并重读 6 个文档后才拒。建议统一「事务外 0-IO 快拒 + 事务内 `freshContext` 权威重判」。

---

## 四、专项审查：冗余代码、死代码与规范一致性（重点关注）

### 4.1 模块级与镜像级死代码 / 冗余
1. **`cloudfunctions/data/src/core/idempotency.js`（214 行，生产代码零引用）**：全仓仅 2 个测试文件引用了 `matchNaturalKey`（校验 Python 导入器契约）与 `memberKey`（1 行转发）；其余 7 个协议 1 遗留导出（`announcementNaturalKey` / `eventNaturalKey` / `membershipKey` / `signupNaturalKey` / `collegeEventNaturalKey` / `collegeEntryNaturalKey` / `collegeLineupNaturalKey`）全仓（含测试）零调用。
2. **`miniprogram/services/member-review.js`（436 行，16 个导出）**：协议 1 遗留重灾区，生产代码仅用了 `REVIEW_ACTION` 与 `isGlobalAdminMember`，其余 14 个函数/常量零生产引用。
3. **`miniprogram/utils/interface-view.js` 被无故镜像上云**：[sync-cloud-lib.js](file:///c:/Users/17789/Desktop/石榴籽程序/tools/sync-cloud-lib.js#L48) 把该纯前端展示工具同步到了 `cloudfunctions/data/lib/`，云函数侧 0 处引用；且内部 `errorItems`、`selectedMembers` 无生产调用。
4. **演示/种子数据 ~220KB（4800+ 行）占主包体积 + `school-demo.js` 含 400+ 行死数据**：[school-demo.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-demo.js)（724 行 / 28KB）中 `schoolHome`/`schoolRank`/`schoolMatches`/`schoolEvents` 生产零引用，仅 2 个短工具函数被 3 处引用却拉进全文件；[seed.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/seed.js) 中 `VENUES`、`ANNOUNCEMENT_SEED`、`buildAnnouncements` 为死代码；因 `school-mock-loader.js:30` 静态 `require`，8 个演示/种子文件全量打入 2MB 主包。
5. **孤立接口与死分支 / 死注释**：
   - `getMySchoolMembership`（[school-actions.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/utils/school-actions.js#L33)）：全仓零业务调用；
   - `rate-limit.js:347` `sweep(nowSec)` 为不可达死调用（`lastSweepSec === nowSec` 恒真），且 `SWEEP_THRESHOLD` 注释与实现不符；
   - `team-event-service.js:1175-1179` 为 100% 不可达死分支；`basketball-rules.js:199` 冗余分支；`meet-score-service.js:333` 未使用变量 `assignedInEvent`、`962/1030` 废弃参数 `official`；`meet-standing-service.js:156` 自过滤与未使用导出 `canManageMeet`；
   - `tools/pre-commit-check.cjs:75, 174` 残留已废弃的 `rule.skip` 死逻辑与注释；`tools/sync-cloud-lib.js:23, 130` 注释仍提及已删的 `replay.js` / `index.js`；
   - `association-training-service.js:179, 1025`（`countRegistered`、`returnPendingOnSeasonReset` 未接生产）；
   - 死导入：`association-member-service.js:18-21`、`school-rank-service.js:29`、`rank-view.js:26`、`meet-advance.js:34`、`meet-registration-service.js:36`、`meet-schedule-service.js:28`、`meet-score-service.js:46`、`meet-advance-service.js:32`；
   - 全仓共检出 **140 个全仓（含测试）零引用的导出符号**（含 `utils/constants.js`、`utils/associations.js`、`utils/leaderboard.js`、`services/events-view.js`、`services/event.js`、`services/college-event.js`、`services/profile.js`、`services/auth.js`、`services/live-score.js` 等协议 1 历史导出）。

### 4.2 双端仓储与前后端大面积重复代码
1. **双端仓储重复与死方法**：
   - [school-memory-repo.js](file:///c:/Users/17789/Desktop/石榴籽程序/miniprogram/services/school-memory-repo.js#L103-L415) 手工重写约 300 行 `forScope`/`forMeet`（文件内还把 `owns/checked/write` 抄了两遍），未像 `tests/helpers/memory-repo.js` 一样复用 `school-repository.js`，是双端持续漂移的根因；
   - [cloud-repo.js](file:///c:/Users/17789/Desktop/石榴籽程序/cloudfunctions/data/src/adapters/cloud-repo.js#L283-L383) `readAll` 与 `readWhere` 重复；L614–628 对 18 个集合赋值立刻在 L640 被 `attachSchoolRepository` 覆写；L630–639 与 L741–750 复制了同一段 10 行注释；顶层协议 1 遗留方法（`seasons.update`、`schoolMembers.update`、顶层 `insert`/`update`/`memberships.remove`/`seasons.get`）均无生产调用。
2. **后端服务重复样板**：
   - `freshContext` / `ok` / `refused` / `iso` / `REQUEST_ID_PATTERN` 在 8+ 个 `*-service.js` 逐字重复；
   - `refereeRejection` 在 `school-match-service.js:865` 与 `school-college-service.js:742` 一字不差重复两份；
   - `roundRobinRounds` 在 `utils/standings.js:92` 与 `services/meet-advance.js:251` 重复两份；
   - 东八区格式化、名次中文文案、`compareId`/`compareCode`、`textOf`、学号判重、限组命中检查在多文件重复编写；
   - `services/season.js` 仅包 1 行旧权限判断，被 `resetSchoolSeason` 绕道调用。
3. **前端重复样板与死 UI 代码**：
   - `currentScope()`（16 份）、`showToast()`（23 份）、`currentActorId()`（7 份）、`stopPullDown()`（7 份）、`nextRequestId()`（5 份）、硬编码 `|| 'muc'`（24 处）；
   - `event-detail.js:519-648` 与 `college-event-detail.js:321-451` 整段复制 130 行裁判选择器逻辑（连 `refereeTimer` 泄漏 Bug 都一起复制）；
   - 3 个未绑定事件处理器（`profile.onGoMyTeamProfile`、`meet-setup.onStep`、`college-entry.onToggleMember`）、10 个未使用 WXSS 类、16 处未消费的 `data` 字段（含 `app.globalData.systemInfo` 与恒为 `false` 的 `demoSchool` 分支）。

### 4.3 代码规范一致性缺口
1. **列表接口缺失 `hasMore`**：`listTeamEvents`、`getExchangeEvents`、`listSportsMeets`、`listMeetEntries`、`getMeetStandings`、`getMyMeetHonors`、`listMeetCollegeLeads` 共 7 个列表接口未返回 `hasMore`（违背 `shilzi-cloud-action` 契约）。
2. **样式硬编码规模较大**：全仓仍有 **310 处原始颜色 hex** 与 **20 处硬编码 `font-size`**，集中在 `packageMeet/*.wxss`（130 处）、`cup-home.wxss`（26 处）、`live-score.wxss`（26 处）、`team-live-score.wxss`（14 色 + 15 字号 + 覆写 `.page-container` 与全局 `button`）、`football-event-form.wxss`（10 处）及 `app.wxss` 自身 `.tag-*`/`.pool-tab`。
3. **文案与常量漂移**：`team-service.js:552` 硬编码 `'active'`/`'rejected'`；`meet-score-service.js:406` 提示不存在的「撤回提交」功能；`school-mock.js` 导出散落在文件中段与尾部。

---

## 五、分批整改建议路线

### 第一批（Batch A · 上线阻断级 P0 + 关键安全/事务修补，强烈建议立即修复）
1. **修通云端运动会全流程**：修复 `meet-scope.js` & `meet-college-lead-service.js` 支持 `acc:<40hex>`（P0-1），修复 `school-cloud.js:50` `!throwOnRefused`（P0-2），并补 `schoolAccountKey` 真账号形态与 `CLIENTS.meet` 拒绝用例。
2. **堵住 P0 权限与算法/性能风暴**：修复 `school-permission.js:isPlatformAdminCtx` 补 `platformStatus === ACTIVE` 并简化 `canPublishAnnouncement`（P0-3）；修复 `format-plan.js:856` 12 人单败名次（P0-4）；修复 `season-points.js:357` 放行未物化 0 分行（P0-5）及 `association-training-service.js:784` 去掉 `pointsChanged ||`。
3. **补齐安全与数据底线**：`finishedEventBlocker` 补 `collegeEventId`；`meet-permission.js` 总裁判校验 `isLocalActiveMember`；`withdrawMeetInterest` 补 `freshMeetContext`；`team-standings.js` 修正平局误算 B 队胜；`meet-score-service` / `meet-advance-service` 补 `!doc.voidedAt` 过滤、`resetMeetDraw` 拦已判胜场次、`saveMeetSession` 修复 `contentRevision` 覆盖。

### 第二批（Batch B · 10–20 轮漏网收口、云端事务契约与高优前端缺陷）
1. **云端事务规范与容量**：消除全部「同集合写后再读不同 doc」和事务内 `Promise.all`；修复 `releaseEntry` / `exchange-service` / `commitEventChange` / `football-match-service` 事务容量超限；修复 `cloud-repo.js` `cursorCond` 处理 `LogicCommand`、`liveScores.listByIds` 下沉 `forScope`、`rate-limit.js` `guardDaily` 先判后加。
2. **10–20 轮漏修闭环**：修正团队学院赛与 `getSchoolIdentitySession` 管理学院口径、`listTeams({mine:true})` 虚拟院队分页、`memoryMatchPage` 99 夹取、`meet-score-service` 回退快照昵称与 `metadataOnly`、全仓日期进位与 `meet-detail` UTC+8 偏移、`team-detail` / `college-lineup` / `match-panel` / 裁判搜索请求序号。
3. **前端核心缺陷**：19 处解构 `isMock` 改为 `onLoad` 调 `isMockNow()`；`profile-view` 透传 `project`；修复 `app.wxss` `--brand-*` 换肤失效、编辑限组训练丢组、`cup-home` 翻页整形、首页吞错写空缓存、15 处 `try/finally` 与 5 处防重守卫、头像防清空、3 处按键防抖。

### 第三批（Batch C · 去过度防御、性能治理与减冗重构）
1. **去过度防御（收益最大）**：收敛 `contextCache` 失效至身份/范围写白名单；重校准 `rate-limit` 读成本表；去掉 `submitSchoolMatch` 空跑双事务、`school-live-service` 多重 `guard`、`commitEventChange` 全表 `sameRecord`、`football-match-service` 无条件全届 `related`、`submitCollegeEntry` 过度 20 组见证、非 `STAFF` 无用 `recordDirOf`；精简前端静态 `dataset` 伪安全白名单与 `JSON.stringify` 指纹。
2. **性能与读放大收敛**：消除 `reviewEntrants` / `listSchoolEventSignups` / 运动会 N+1 循环点读、`getSchoolMembers` 双倍读、`meet-standing-service` 双读学院、`profile-view` 6 路串行、工作台隐藏面板 `onShow` 惊群刷新。
3. **减冗与规范收口**：统一内存仓储复用 `school-repository.js`；清理 `idempotency.js` / `member-review.js` / `school-demo.js` 死代码并把 `utils/interface-view.js` 移出云端 `MANIFEST`；抽离前端公共 helper 与裁判选择器组件；修正 3 处危险按钮颜色并分批收敛硬编码色值/字号。

> [!IMPORTANT]
> **上线前必须完成的真机实测项**（本地内存桩无法覆盖）：第 19–22 轮及后续修复涉及的真实云数据库复合索引、数组路径查询（`sports_meet_publications` 的 `rows.userIds`）、`$expr` 聚合执行计划，以及云开发真实事务的并发冲突与单事务串行/先读后写约束，必须在微信云开发真实环境逐链实测。
