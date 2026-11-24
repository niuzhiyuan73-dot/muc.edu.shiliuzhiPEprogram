# 团队运动 · `SportAdapter` 插件化设计方案

> **文档状态**：已实施（P-02～P-04，含复核补修）。后续排球等新团队运动按本契约扩展。
> **代码基线**：`8554062`（P-02 契约与双插件） / `bcccd68`（P-03 服务端接线）；关联规划：[系统性架构治理与演进总规划](系统性架构治理与演进总规划.md) · 业务调研：[篮球、足球、排球协会调研与实施规划](篮球足球排球协会-调研与实施规划.md)

---

## 一、现状与痛点

当前仓库已在 [team-sport-rules.js](../miniprogram/utils/team-sport-rules.js) 建立了第一版简化策略分派（`STRATEGIES`），覆盖规则校验、积分榜计算以及 `supportsLiveScore` / `supportsMatchData` 两个布尔开关。

但除此之外，[team-event-service.js](../miniprogram/services/team-event-service.js)（3,589 行 / 178.9 KB）内仍硬编码了 **28 处**按 `football11` / `basketball` 判断的 `if/else` 分支，主要集中在四类差异：

| 差异维度 | 典型代码位置（`f2ca8fe`） | 现状表现 |
|---|---|---|
| **录分与看板权限** | `L422 / L428 / L1378 / L1382` | 篮球允许队长录分与看待审，足球只允许管理员或指定记录员 |
| **赛程与重抽约束** | `L1247 / L1297` | 足球生成赛程时不继承赛事开赛时间且禁止重抽，篮球允许重抽 |
| **单场数据字段耦合** | `L1299 / L2234 / L3134` | 篮球使用 `liveScore` + `team_match_stats`，足球使用 `footballDraft` / `footballPublished` / `footballLineups` |
| **结算仲裁与视图** | `L252 / L2247 / L2287` | 足球结算需拦截 `footballDraft`、支持 `rankingDecisions` 仲裁，视图拼装 `footballMatchView` |

如果不做插件化收口，接入排球（局分制、无平局、发/扣/拦/失误统计）时这 28 处分支将演变为三路 `if/else`，极易引发跨运动回归缺陷。

---

## 二、核心边界：通用赛事内核 vs `SportAdapter` 插件

1. **通用团队赛事内核（不认识任何具体运动）**
   - 负责所有团队运动完全一致的流程骨架：建赛、报名/审核/锁名单、签表生成（单败/循环/小组+淘汰）、排期与时间/场地/裁判冲突检测、状态机流转、版本栅栏与审计落库。
2. **运动插件 `SportAdapter`（每种运动一个独立模块）**
   - 只负责该运动独有的规则快照、权限差异、单场草稿/结果校验、积分榜排名、个人统计聚合与前端录分入口映射。

---

## 三、`SportAdapter` 六组标准契约接口

零框架，纯 JS 冻结对象（与仓库现有风格一致）：

```js
const SportAdapterContract = {
  // 1. 身份与能力声明（全部布尔标志都是内核实际读取的开关）
  meta: {
    sportFormat: 'volleyball6',      // 'basketball5' | 'football11' | 'volleyball6'
    sportKey: 'volleyball',
    supportsLiveScore: true,         // 是否支持实时计分台
    supportsMatchData: true,         // 是否支持录分/统计/名单
    supportsRedraw: true,            // 开赛前是否允许重抽
    allowsDraw: false,               // 循环赛是否允许平局
    defaultMatchTimeFromEvent: true, // 生成赛程时是否继承赛事默认开赛时间
    defaultDurationMinutes(rules, format) {}, // 单场默认时长
    schedulePeopleSource: 'membership', // 'membership' | 'school'
    requiresStrictRulesOnEntry: false,
    requiresWinnerOnElimSettle: false,
    sharedEliminationRank: false,
    supportsRankingDecisions: false,
    strictEntryRosterCheck: false,
  },

  // 2. 规则快照与前端预设
  rules: {
    defaultPresetKey: 'fivb-bo5',
    presetOptions: [{ key: 'fivb-bo5', label: '五局三胜' }], // 可选；建赛页据此渲染
    defaultRules(presetKey) {},      // 返回默认规则快照
    normalizeRules(input) {},        // 严格白名单校验与归一化
    formatRules(rules) {},           // 生成前端展示文案
  },

  // 3. 运动级权限差异
  permissions: {
    canRecord({ manage, captain, isRecorder, match }) {},
    canSeePending({ manage, captain, isRecorder, match }) {},
    canSetLineup({ active, manage, captain, match }) {},
    canEditSchedule({ manage, eventActive, match }) {},
  },

  // 4. 单场数据结构与结果钩子
  matchLifecycle: {
    initMatchExtra(event) {},            // 建场次时附带的运动专属字段
    hasActivityOrDraft(match) {},        // 是否已有录分/草稿（用于拦截重抽与结算）
    validateBeforeSettle(matches) {},    // 结算前拦截（如待审核报告）
    validateRankingDecisions(payload, event, ctx) {}, // 抽签/公平竞赛仲裁校验
    validateEntryPayload(payload, event) {},          // 报名名单校验
    decorateMatchView(match, { canSeePending }) {},
  },

  // 5. 积分榜与名次
  standings: {
    computeTable({ entries, matches, rules, rankingDecisions }) {},
    adjustEliminationPlacements(placements, matches) {},
  },

  // 6. 视图与前端入口映射
  view: {
    eventFormMode: 'volleyball',
    recordPageUrl(matchId, { lineup }) {},
    liveScorePageUrl(matchId) {},
    recordHintText: '',
    statColumns: [{ key: 'spikes', label: '扣球' }], // 单场统计录入
    profileStatColumns: [{ key: 'spikes', label: '扣球' }], // 个人档案
    playerStatColumns: [{ key: 'spikes', label: '扣球' }], // 赛事球员榜，可省略并复用 statColumns
  },
};
```

P-02（`8554062`）落地六组契约、双适配器和服务端注册表。默认钩子工厂 `createSportAdapter` 由 P-03（`bcccd68`）新增，通用服务在 P-03 接入适配器查询和动作分派。当前实现以 `src/shared/sports/contract.js` 为准。

---

## 四、目标目录组织与调用收口

结合三层物理分层后的目录结构：

```
src/shared/sports/
  ├── registry.js          ← 按协会取 getSportAdapterFor(associationId, event)，按格式取 getSportAdapter(sportFormat)
  ├── basketball/          ← 篮球插件（规则、实时计分、排名、统计、视图）
  ├── football/            ← 足球插件（规则、赛后报告、排名、统计、视图）
  └── volleyball/          ← 未来新增排球：仅增此目录 + registry 注册 1 行
```

内核调用收口示例：

```js
const adapter = getSportAdapterFor(ctx.association, event);
if (!adapter) return ok(refused('赛事运动规则与协会不符'));
if (!adapter.meta.supportsRedraw && existingMatches.length) {
  return ok(refused('当前赛制不允许重抽，请核对现有签表或重建赛事'));
}
const canRecord = adapter.permissions.canRecord({ manage, captain, isRecorder, match });
```

---

## 五、数据库字段与前端适配收敛

1. **单场数据字段收敛**：
   - `team_matches` 顶层保留通用字段：`scoreA / scoreB / winner / status / revision / sportFormat`；
   - 运动专属草稿与发布明细统一收口为 **`match.sportDraft`** 与 **`match.sportPublished`**，由对应 `adapter` 读写校验；若在上线后实施，老足球插件兼容读取存量 `footballDraft` / `footballPublished` 字段，免除全量数据迁移。
2. **前端按声明驱动**：
   - 赛事列表、报名、审核、签表、赛程、球队管理 100% 复用通用页面；
   - 录分入口调用 `adapter.view.recordPageUrl(matchId, options)`。
   - 单场统计按 `statColumns` 录入，团队成绩档案按 `profileStatColumns` 展示，赛事球员榜按 `playerStatColumns` 展示。省略球员榜声明时复用 `statColumns`，列键与服务端返回的 `<key>Text` 对应。
   - 团队协会的规则快照必须由 `rulesKey` 指向，快照的 `sportFormat` 与协会的 `teamSportFormat` 一致。协会与适配器配对时同时匹配运动格式和 `sportKey`。

---

## 六、公共契约测试与实施触发时机

- **公共契约测试**（类比 `cloud-repo-contract.test.js`）：遍历 `registry` 中所有已注册 `SportAdapter`，统一断言：
  1. 6 组必需字段与方法签名齐全；
  2. `normalizeRules` 拒绝未知字段与跨运动字段；
  3. `validateBeforeSettle` / `computeTable` / `adjustEliminationPlacements` 返回结构满足通用内核契约；
  4. `hasActivityOrDraft` 在有草稿或已开赛时恒返回 `true`。
- **实施触发时机**：已提前实施（P-02/P-03/P-04），后续排球等新团队运动直接复用本契约；不再等待“第三个运动”触发。
