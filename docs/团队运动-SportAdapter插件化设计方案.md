# 团队运动 · `SportAdapter` 插件化设计方案

> **文档状态**：设计留存（按「三次法则」，待排球协会或第三个团队运动正式立项时启动实施）
> **代码基线**：`f2ca8fe`（第二十四轮审查补修后） · 关联规划：[系统性架构治理与演进总规划](系统性架构治理与演进总规划.md) · 业务调研：[篮球、足球、排球协会调研与实施规划](篮球足球排球协会-调研与实施规划.md)

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
  // 1. 身份与能力声明
  meta: {
    sportFormat: 'volleyball6',      // 'basketball5' | 'football11' | 'volleyball6'
    supportsLiveScore: true,         // 是否支持实时计分台
    supportsRedraw: true,            // 开赛前是否允许重抽
    allowsDraw: false,               // 循环赛是否允许平局
    defaultMatchTimeFromEvent: true, // 生成赛程时是否继承赛事默认开赛时间
  },

  // 2. 规则快照
  rules: {
    defaultRules(presetKey) {},      // 返回默认规则快照
    normalizeRules(input) {},        // 严格白名单校验与归一化
    formatRules(rules) {},           // 生成前端展示文案
  },

  // 3. 运动级权限差异（消除 L422/L1378 硬编码）
  permissions: {
    canRecord({ manage, captain, isRecorder, match }) {},
    canSeePending({ manage, captain, isRecorder, match }) {},
    canEditLineup({ active, manage, captain, match }) {},
    canEditSchedule({ manage, match }) {},
  },

  // 4. 单场数据结构与结果钩子（消除 L1299/L2234 字段硬编码）
  matchLifecycle: {
    initMatchExtra(event) {},            // 建场次时附带的运动专属字段
    hasActivityOrDraft(match) {},        // 是否已有录分/草稿（用于拦截重抽与结算）
    validateDraft(draft, rules) {},      // 校验单场赛后报告或实时比分合法性
    resolveOutcome(published, rules) {}, // 得出 { scoreA, scoreB, winner, sets? }
  },

  // 5. 积分榜与个人/球队统计
  standings: {
    computeTable(matches, entries, rules, decisions) {},
    validateRankingDecisions(decisions, table) {}, // 如抽签/公平竞赛仲裁校验
    aggregatePlayerStats(publishedMatches) {},     // 个人生涯/赛季累计统计
  },

  // 6. 视图与前端入口映射
  view: {
    decorateMatchView(match, { canSeePending }) {},
    recordPagePath: '/packageTeam/volleyball-match/volleyball-match',
    statColumns: [/* 表头与字段映射，供个人页/球队页动态渲染 */],
  },
};
```

---

## 四、目标目录组织与调用收口

结合三层物理分层后的目录结构：

```
src/shared/sports/
  ├── registry.js          ← 统一注册表，导出 getSportAdapter(associationId, event)
  ├── basketball/          ← 篮球插件（规则、实时计分、排名、统计、视图）
  ├── football/            ← 足球插件（规则、赛后报告、排名、统计、视图）
  └── volleyball/          ← 未来新增排球：仅增此目录 + registry 注册 1 行
```

内核调用收口示例：

```js
const adapter = getSportAdapter(ctx.association, event);
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
   - 录分入口读取 `adapter.view.recordPagePath` 跳转，仅针对差异巨大的录分台按运动独立建页；
   - 个人/球队统计页读取 `adapter.view.statColumns` 动态渲染列。

---

## 六、公共契约测试与实施触发时机

- **公共契约测试**（类比 `cloud-repo-contract.test.js`）：遍历 `registry` 中所有已注册 `SportAdapter`，统一断言：
  1. 6 组必需字段与方法签名齐全；
  2. `normalizeRules` 拒绝未知字段与跨运动字段；
  3. `resolveOutcome` / `computeTable` 返回结构满足通用内核契约；
  4. `hasActivityOrDraft` 在有草稿或已开赛时恒返回 `true`。
- **实施触发时机**：遵守「三次法则」——仅当排球协会（或第三个团队运动）正式立项时，连同拆解 `team-event-service.js` 一并落地，不在此前提前过度抽象。
