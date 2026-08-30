# EpochGuard 并行 Session 执行与验收流程

> 状态：执行中——阶段 8/9 已完成，阶段 9/9 Release Verification 进行中
> 当前集成基线：`epochguard/staging@f096edd`
> 冻结合同：`epochguard-contract-v7`，`schemaVersion=1`
> 产品设计来源：[`EPOCHGUARD_FINAL_DESIGN.md`](./EPOCHGUARD_FINAL_DESIGN.md)  
> 本文档范围：定义任务编排、审核、校验、测试和合并流程，并记录实际执行证据。当前已具备双场景生产 Service、正式 HTTP 接线和嵌入式 Session Safety Dashboard；WSL 与 controlled-HTTP 浏览器门已通过，真实 Ark 生命周期和最终发布门完成前仍不是最终端到端比赛演示。

---

## 1. 目标

在不破坏官方 Starter Kit 的前提下，将 EpochGuard 实现拆分为多个可在独立 Git worktree 中并行开发的可视化 Codex Session，同时将合同裁决、差异审核、测试重跑、真实 Ark 验证和最终放行集中在当前 Session。

核心目标：

1. 最大化可用的并行开发时间；
2. 避免多个 Session 同时修改共享合同和热点入口文件；
3. 保证所有安全结论来自同一个合并后的候选 SHA；
4. 确保 Dashboard 是后端权威状态的证据面，不成为第二套安全逻辑；
5. 在真实 Ark/Codex Run 之前，用确定性测试尽早消除合同、并发和状态机缺陷。

---

## 2. Session 术语

| 术语 | 含义 |
| --- | --- |
| 当前 Session | 本 Codex 任务，只负责规划、合同裁决、审核、校验、测试、接受或退回提交 |
| 执行 Session | 用户批准后新建的可视化 Codex 任务，在独立 worktree 中实现一个明确模块 |
| 业务 Session | EpochGuard 运行时的 `EpochSession`，与 Codex 执行 Session 不是同一概念 |
| staging | 当前 Session 维护的集成分支，只接收通过审核的单职责提交 |
| contract digest | 冻结合同的版本摘要，用于防止执行 Session 静默改变共享状态、API 或 Snapshot 语义 |

---

## 3. 总体并行模型

推荐使用 **1 个中央控制 Session + 10 个可视化执行 Session**。不一次性全部启动，而是先冻结合同，再进入并行波。

```text
当前 Session：规划 / 合同裁决 / 审核 / 合并 / 测试
                             |
                             v
                 EG-00 合同与 Starter 接缝
                             |
                 合同审核、测试、合入 staging
                             |
                             v
  +----------------- 第一并行波 -----------------+
  | EG-01 Store        EG-02 World / Evidence             |
  | EG-03 Decision     EG-04 Refresh / Effect Gate        |
  | EG-05 Diagnostic   EG-06 Real Run Adapter             |
  | EG-07 Dashboard Preview                               |
  +--------------------------------------------------------+
                             |
                  中央审核并按依赖合入
                             |
                             v
                 EG-08 Coordinator + Routes
                             |
                             v
                 EG-09 唯一生产接线
                             |
                             v
        当前 Session：WSL / Ark / Dashboard / 安全验收
```

### 3.1 为什么不立即全开

`epochguard/types.ts`、`app.ts`、`index.ts`、`App.tsx` 和 `api.ts` 是高冲突热点。如果没有先冻结合同和文件所有权，执行 Session 会各自发明状态、错误体和 DTO，并行的收益将被合并返工抵消。

---

## 4. Gate 0：并行开工前的必要条件

### 4.1 共同基线完成记录

Gate 0 已完成：

1. 原始官方 Starter 基线：`8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`；
2. 设计与流程共同基线：`475cb93e832f56219bb4bdfdefff3d6aac1e7784`；
3. 可视化灰度与执行任务登记基线：`c6e07b85baf56b59e44d0b728fd1d0ef5c0e5f9d`；
4. `epochguard/staging` 只接收经中央审核的提交；EG-00～EG-09 使用独立 worktree 与独立分支；
5. 当前已验收集成基线为 `f096edd8dec452f8ebf0dc5368a54d0e98be6c17`。

### 4.2 当前集成测试事实

在 `f096edd` 上已验证：

- Dual Scenario + App：**45/45 PASS**；全部 EpochGuard：**330/330 PASS**；App + EpochGuard 组合：**336/336 PASS**；
- 全工作区 TypeScript 检查、Web 与 Server production build：**PASS**；
- Windows 全 Server：**359/360**；唯一失败仍是 Container Runner 测试硬编码 `/tmp/codex-home`，且已在父提交独立复现；
- WSL2 Ubuntu 24.04、Node `v22.22.3`、npm `10.9.8` 的干净克隆完成 `npm ci`、typecheck、build 和全 Server **360/360 PASS**；
- 精确 SHA 的 controlled-HTTP 浏览器门通过：生产无 Mock/Preview 接线、会话连续、busy 恢复、clear fail-closed、pending 防重入、localStorage 降级以及 390px/长文本布局均通过；
- 真实 `ARK_API_KEY` / `ARK_MODEL` 的模型生命周期仍是最终发布前 Go/No-Go，不能由 controlled HTTP 证据替代。

### 4.3 EG-00 必须冻结的合同

1. 权威 Zod Schema 及其推导的 TypeScript 类型；
2. Action 与 Role Query 的 canonicalization 及 Golden Hash；
3. Session、Attempt、Assignment、Decision、Validation、Permit、Effect 状态；
4. `FailureCode`、Diagnostic kind/stage 和闭合枚举；
5. 九个公开错误的精确状态码和 strict 响应体：`STALE_VIEW`、`ALREADY_REOBSERVING`、`AGENTS_BUSY`、`MISSING_ACTION_FIELDS`、`SESSION_NOT_FOUND`、`UNSUPPORTED_SCHEMA`、`PROJECTION_MISMATCH`、`UNSTABLE_WORLD`、`ROLE_PROFILE_MISMATCH`；
6. `ArtifactRef.kind` 及每种引用的解析目标；
7. `SessionDashboardSnapshot` 与运行时 decoder；
8. Normal / Impossible 固定 fixture manifest；
9. `contractVersion + contractDigest`；
10. 新旧 Store 记录的 nullable/default 兼容行为。

v7 只在既有七种公开错误之外新增两种 canonical 409：`UNSTABLE_WORLD` 精确携带 opaque-or-null `sessionId` 与非负整数 `actualWorldHead`；`ROLE_PROFILE_MISMATCH` 精确携带 `role` 与 `agentId`。原七种错误的字段、状态码和固定消息保持不变。

### 4.4 已批准并冻结的 P0 语义

1. **同一组 Role Agent 冲突：**两个业务 Session 同时使用同一组三个 Role Agent 时，第二个在 dispatch 前返回 `409 AGENTS_BUSY`；P0 不实现排队，不留下部分 Assignment。
2. **幂等范围：**P0 只承诺同一 `Session + Action` 内 exactly-once；跨 Session 的业务去重不在本次比赛范围内，必须在文案和测试中如实标明。

以上两项已由用户批准并冻结；任何改变都必须先修订合同、重新计算 digest 并重跑 Gate A。

---

## 5. 文件所有权规则

### 5.1 绝对单 Owner 文件

| 文件 | 唯一 Owner |
| --- | --- |
| `apps/server/src/epochguard/types.ts` | EG-00 |
| `apps/web/src/epochguard/contracts.ts` | EG-00 |
| `apps/server/src/types.ts` | EG-00 |
| `apps/server/src/agent-service.ts` | EG-00 |
| `apps/server/src/workspace.ts` | EG-00 |
| `apps/server/src/app.ts` | EG-09 |
| `apps/server/src/index.ts` | EG-09 |
| `apps/server/src/app.test.ts` | EG-09 |
| `apps/server/src/epochguard/dual-scenario-service.ts` | EG-09 |
| `apps/server/src/epochguard/dual-scenario-service.test.ts` | EG-09 |
| `apps/web/src/App.tsx` | EG-09 |
| `apps/web/src/api.ts` | EG-09 |
| `apps/web/src/main.tsx` | EG-09 |
| `apps/web/src/styles.css` | EG-09 |

### 5.2 所有执行 Session 默认禁止修改

- `apps/server/src/store.ts`；
- `apps/server/src/codex-runner.ts`；
- `apps/server/src/container-codex-runner.ts`；
- `apps/server/src/runner-factory.ts`；
- `apps/server/src/config.ts`；
- Docker / ECS / Terraform / deployment 文件；
- `.env` 和任何真实密钥；
- `docs/EPOCHGUARD_FINAL_DESIGN.md` 和本文档。

如果某模块无法在 allowlist 内完成，必须停止并提交 Contract/Boundary Change Request，不得“顺手修改”。

---

## 6. 执行工作包

### 6.1 EG-00 —— Contracts & Starter Seams

**目标**

建立所有并行模块共享的稳定合同，并仅对 Starter 完成必要的三处接缝。

**允许修改**

```text
apps/server/src/epochguard/types.ts
apps/web/src/epochguard/contracts.ts
apps/server/src/types.ts
apps/server/src/agent-service.ts
apps/server/src/agent-service.test.ts
apps/server/src/workspace.ts
apps/server/src/workspace.test.ts
apps/server/src/epochguard/contracts.test.ts
```

**交付**

- 闭合 Schema、错误和状态枚举；
- Action/Query Golden Vector；
- Normal/Impossible Snapshot Golden Fixture；
- `AgentRun.threadId: string | null`；
- Run 完成时固化 threadId；
- `WorkspaceManager.writeEvidencePackAtomic()`；
- `WorkspaceManager.readAgentsMdDigest()`；
- `contractVersion + contractDigest`。

**验收**

- Starter 现有行为不变；
- 旧 Run 记录的 threadId 可以安全默认为 null；
- Pack 路径不能逃逸 Agent workspace；
- digest 读取实际磁盘上的 `AGENTS.md`；
- 其他执行 Session 可在不改合同的情况下编译。

### 6.2 EG-01 —— EpochStore

**允许修改**

```text
apps/server/src/epochguard/epoch-store.ts
apps/server/src/epochguard/epoch-store.test.ts
```

**交付**

- 独立 `data/epochguard.json`；
- 单 Node 进程、单 Writer 队列；
- `snapshot()` 和串行 `mutate()`；
- 临时文件 + rename 原子替换；
- 每次成功 mutation 递增 `snapshotRevision`；
- 写盘失败不发布新内存状态。

**验收**

- 20 次并发 mutation 无丢失；
- 失败后队列可继续工作；
- 重启后 JVC、NoCutProof、RefreshPlan 等可按 ID 恢复；
- 不宣称支持多进程或多服务副本共享同一 JSON。

### 6.3 EG-02 —— World, Receipt & Evidence

**允许修改**

```text
apps/server/src/epochguard/world-ledger.ts
apps/server/src/epochguard/fixtures.ts
apps/server/src/epochguard/receipt-issuer.ts
apps/server/src/epochguard/evidence-pack-writer.ts
apps/server/src/epochguard/*对应单测
```

**交付**

- 18→19→20→21 权威 World Commit；
- 半开区间版本；
- 服务端签发的 Observation Receipt；
- 可确定性重建的 canonical Evidence Pack；
- Assignment-scoped 不可覆盖路径；
- `actionHash/queryHash/evidencePackHash` Golden Tests。

**验收**

- 同值消失后恢复仍生成新 ResourceVersion；
- 同一输入重建产生字节级一致结果；
- workspace Pack 被篡改不能改变服务端重建结果；
- Refresh 不覆盖首次 Pack。

### 6.4 EG-03 —— Decision, Normalization & Joint Validity

**允许修改**

```text
apps/server/src/epochguard/decision-parser.ts
apps/server/src/epochguard/joint-validity-validator.ts
apps/server/src/epochguard/*对应单测
```

**交付**

- 恰好一个 Marker Envelope；
- Zod `.strict()` 和无尾随自由文本；
- Assignment/Run/Agent/Role/Receipt/nonce 绑定校验；
- Assignment 单次消费；
- Joint Validity Certificate；
- No-Cut Proof 与确定性 witness；
- Historical-stale 与 current-head fence。

**验收**

- WC-01～WC-04；
- 错误 nonce、跨 Role/Action/Session/Run 重放全部 fail closed；
- `L=21`、`U=20`，witness 指向 old Budget 和 permitted Policy；
- 未知或裁剪的 World history 返回 `HISTORY_UNVERIFIABLE`。

### 6.5 EG-04 —— Refresh Planner & Effect Gate

**允许修改**

```text
apps/server/src/epochguard/refresh-planner.ts
apps/server/src/epochguard/effect-gate.ts
apps/server/src/epochguard/*对应单测
```

**交付**

- 最小 `refreshSet(H)`；
- 绑定 base session revision/head/dependency set/active decision IDs 的 RefreshPlan；
- RefreshPlan 单次 CAS 领取；
- Effect Gate 完整重验；
- Permit 消费与 Effect append 同 mutation；
- 同 Session+Action 的并发 Commit 返回同一 Effect。

**验收**

- Failure fixture 只刷新 Budget；
- 两个同 RefreshPlan 请求只创建一个 Assignment/Attempt/Run；
- 两个并发 Commit 的 effect count 始终为 1；
- 验证后、Commit 前 head 前进时，Session 必须持久化进入终态 `COMMIT_RACE`，写入 `TRANSIENT_RACE / COMMIT` Diagnostic 且 effect=0；P0 不在原 Session 内自动回到 `VALIDATING`，恢复方式为 reset 后新建 Session，前端不得自动重放 Commit；
- Action/Permit/JVC/dependency/head 任一不符都 effect=0。

### 6.6 EG-05 —— Diagnostics & Single Snapshot Projection

**允许修改**

```text
apps/server/src/epochguard/safety-diagnostics.ts
apps/server/src/epochguard/session-view-builder.ts
apps/server/src/epochguard/*对应单测
```

**交付**

- SafetyDiagnostic 与 ArtifactRef 因果链；
- 只从一次 `EpochStore.snapshot()` 构造 Dashboard Snapshot；
- `activeDecision` 与 `inFlightAttempt` 分离；
- 服务端派生的 Gate、L/U、witness、refresh owner 和 effect count；
- 脱敏、闭合状态和未知 Schema fail closed。

**验收**

- collecting / ready / no-cut / reobserving / deny / committed / failed 全状态 Golden Tests；
- 新 Run 不会与旧 active Decision 混搭；
- proofId 不随 GET 改变；
- Snapshot 不含 API Key、绝对路径、完整 Prompt、环境变量或未脱敏输出。

### 6.7 EG-06 —— Role Profiles & Real Run Adapter

**允许修改**

```text
apps/server/src/epochguard/role-profiles.ts
apps/server/src/epochguard/run-observer.ts
apps/server/src/epochguard/*对应单测
```

**交付**

- 三个专用 Role Agent 的幂等初始化；
- Role Registration 和 Profile digest；
- 窄 `AgentPort/StorePort/WorkspacePort` 依赖注入接口；
- dispatch-bind-poll；
- AgentAttempt 与 terminal Run Evidence 镜像；
- dispatch 前和接受输出前两次 digest 复核；
- 依真实时间区间决定 `CONCURRENT/SEQUENTIAL_FALLBACK`。

**验收**

- 三个 Role 使用三个不同 Agent/Run ID；
- 任一 Run 失败时 join fail closed；
- Assignment 只能绑定一次；
- Profile 在 dispatch 后被修改时输出不能被接受；
- 不采信 LLM 自报的 runId；
- 没有真实时间重叠时不写 `CONCURRENT`。

### 6.8 EG-07 —— Session Safety Dashboard Preview

**允许新建**

```text
apps/web/src/epochguard/session-source.ts
apps/web/src/epochguard/decode-snapshot.ts
apps/web/src/epochguard/useEpochGuardSession.ts
apps/web/src/epochguard/EpochGuardDashboard.tsx
apps/web/src/epochguard/EpochGuardDashboard.css
apps/web/src/epochguard/preview/mock-snapshots.ts
apps/web/src/epochguard/preview/MockSessionSource.ts
apps/web/src/epochguard/preview/PreviewApp.tsx
apps/web/src/epochguard/preview-main.tsx
apps/web/epochguard-preview.html
```

`apps/web/src/epochguard/contracts.ts` 由 EG-00 独占，EG-07 只读。

**明确禁止**

```text
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/types.ts
apps/web/src/styles.css
apps/web/src/main.tsx
apps/web/package.json
package-lock.json
apps/server/**
docs/**
```

**交付**

- 注入式 `EpochGuardSessionSource`；
- Mock 与 HTTP 共用的 Snapshot decoder；
- collecting、normal-ready、normal-released、impossible-blocked、refreshing-budget、recovered-deny、run-failed、unsupported/stale Mock Snapshot；
- 1080p 主视图和窄屏布局；
- `requestGeneration + sessionId + revision` 防晚到响应；
- stale/command pending/unknown Schema 时关闭操作。

Preview 必须常驻显示：

```text
MOCK DATA PREVIEW — NOT A REAL AGENT RUN
```

**前端不得实现**

- `actionHash`、Receipt 有效性、L/U、witness、Gate、Permit、Effect count 或 refresh owner 的安全计算；
- 通过 `/world`、`/runs`、`/effects` 等调试接口拼状态；
- 409 后自动重放 Refresh/Commit；
- 收到 mutation 200 后不等下一个 GET 就显示成功；
- 在生产 App 中静默退回 Mock Source。

**验收**

- Normal / Impossible / Recovered 分别显示 `1/0/0`；
- Refresh 期间旧 Decision 与新 Attempt 分离；
- 旧 Session/旧 generation/低 revision 响应不回退 UI；
- 一个 `aria-live="polite"`、原生 `<details>`、明显 focus、不只用颜色；
- CSS 类使用 `eg-` 前缀并限定在 Dashboard 容器；
- Web typecheck/build 通过；
- Preview 的 Network 不请求 `/api/epochguard/*`。

### 6.9 EG-08 —— EpochGuard Service & Routes

**前置依赖**

EG-01～EG-06 公开接口全部审核通过并合入 staging。

**允许修改**

```text
apps/server/src/epochguard/epochguard-service.ts
apps/server/src/epochguard/routes.ts
apps/server/src/epochguard/epochguard-service.test.ts
apps/server/src/epochguard/routes.test.ts
```

**交付**

- `initialize/createSession/getSnapshot/refresh/commit`；
- 三 Role Run 的 `roles.map(...dispatchBindPoll)` + `Promise.allSettled()`；
- 自动 Validation；
- Refresh 三段事务；
- Session CAS；
- 正式 API：

```text
POST /api/epochguard/sessions
GET  /api/epochguard/sessions/:id
POST /api/epochguard/sessions/:id/refresh
POST /api/epochguard/sessions/:id/commit
```

- development/test-only API：

```text
POST /api/epochguard/demo/reset
GET  /api/epochguard/world
GET  /api/epochguard/effects/:campaignId
```

**验收**

- Normal 确定性链路产生一个 Effect；
- Impossible 首轮 3 ALLOW 被 No-Cut 阻断，只刷新 Budget，最终 DENY/effect=0；
- 模型等待不在 Store mutation 内；
- production 不存在 demo reset；
- Refresh/Commit body 不接受 agentId/head/Receipt/Permit/effect count 等可信字段；
- 不存在公开 `/validate` 路由。

### 6.10 EG-09 —— Production Integration

**前置依赖**

EG-07 和 EG-08 已通过中央审核并合入 `e6e58ba`；EG-09 最初从该精确 SHA 激活，随后纳入 `ff663db` 的 UUID 投影边界修复，并以 `f096edd` 完成中央审核与合入。

**唯一允许修改热点文件的 Session**

```text
apps/server/src/index.ts
apps/server/src/app.ts
apps/server/src/app.test.ts
apps/server/src/epochguard/dual-scenario-service.ts
apps/server/src/epochguard/dual-scenario-service.test.ts
apps/web/src/App.tsx
apps/web/src/api.ts
apps/web/src/styles.css
apps/web/src/main.tsx（仅确有必要时）
```

**交付**

- 使用两个独立 EpochStore 与两个 EpochGuardService 隔离 Normal / Impossible 场景，并由一个 composite 协调共享 Role Agent；
- 首次启动只创建三个 Role Agent；双库注册复制、身份一致性、场景分区、重复 Session 和跨库活跃状态均 fail closed；
- 所有异步 mutation 使用同一全局串行队列，GET/refresh/commit 每次扫描持久 Store，不依赖内存 Session 路由表；
- 注册 EpochGuard routes；
- 保持 Starter 认证和现有 API 行为；
- `Agent Chat / Session Safety` 模式切换；
- 真实 HTTP SessionSource；
- 保留 activeEpochSessionId 和冻结 assignment；
- 真实 Snapshot 替换 Mock Source；
- Mock Preview 不进入生产路径。

**验收**

- 现有 Chat/Agent CRUD 回归通过；
- EpochGuard API 仍处于 Bearer 认证边界；
- production 仅四条正式 EpochGuard API，reset/world/effects/validate/debug 均为 JSON 404；
- 两场景持久化文件严格分区，并发 Create 在任何第二组 dispatch 前得到唯一成功者；
- Chat/Safety 往返不丢 Session；
- 真实后端 Snapshot 是 Dashboard 唯一数据源；
- Web/Server typecheck 和 build 通过。

---

## 7. 当前 Session 的责任

当前 Session 是中央 Control Plane，不编写产品功能。

### 7.1 负责

1. 维护设计文档、本流程和任务状态表；
2. 创建 staging 基线和可视化执行 Session；
3. 冻结文件 allowlist、合同 digest 和依赖顺序；
4. 审核执行 Session 的差异、测试和风险报告；
5. 将通过的单职责 commit 合入 staging；
6. 在同一 staging SHA 上重跑模块、集成、并发、幂等和 Badcase 测试；
7. 在 WSL 运行最终全量检查；
8. 持有真实凭据并运行 Ark Gate；
9. 使用合并后前后端进行 Dashboard 浏览器验收；
10. 决定接受、退回、重开原 Owner 或暂停依赖模块。

### 7.2 不负责

- 在审核过程中顺手修改产品实现；
- 为失败的执行 Session 补写其模块功能；
- 把执行分支上的测试结果当作最终权威结果；
- 使用 FakeRunner 结果代替真实 Ark/Codex 验收；
- 在没有用户批准的情况下扩大 P0 范围。

---

## 8. 执行 Session 交付模板

每个执行 Session 必须在完成时提供：

```text
Session ID / 标题:
Work package:
Base SHA:
Contract version/digest:
Commit SHA:

Modified files:
- ...

Delivered behavior:
- ...

Tests added:
- ...

Commands executed:
- ...

Results:
- ...

Evidence type:
- Deterministic fixture / ControlledRunner / FakeRunner / Real Ark

Known risks or unresolved items:
- ...

Contract or boundary change requested:
- None / ...
```

执行 Session 不得只说“测试通过”，必须给出精确命令、结果和证据类型。

---

## 9. Contract / Boundary Change Request

发现合同或文件边界不足时，执行 Session 立即停止越界修改，并提交：

```text
Requested by:
Blocked work package:
Current contract version/digest:

Observed problem:

Why the current allowlist/contract cannot satisfy the design:

Smallest proposed change:

Affected work packages:

Migration/golden-test impact:

Can work continue without this change? Yes / No
```

由当前 Session 做出一个决定：

- 拒绝并要求在现有边界内实现；
- 批准并交回 EG-00 Owner 更新合同；
- 将请求降级为 Stretch；
- 暂停受影响的执行 Session。

合同变更后必须升级 version/digest，更新 Golden Tests，并要求受影响 worktree 从新 staging SHA 重放或 rebase。

---

## 10. 合并与审核流程

### 10.1 执行分支进入 staging 前

1. 检查 base SHA 与 contract digest；
2. 执行 `git diff --name-only <base>..<commit>`；
3. 验证所有修改都在 allowlist 内；
4. 检查没有 `.env`、密钥、真实 Store、workspace、完整模型输出或敏感日志；
5. 重跑该模块目标测试；
6. 检查没有 `.only`、`.skip`、放宽断言或为过测试而改 oracle；
7. 审核边界：UI 没有安全计算，ViewBuilder 没有跨 Store 即时 join，Agent 输出没有获得 Publish capability；
8. 通过后才合入 staging。

### 10.2 推荐合入顺序

```text
EG-00 Contracts
  -> EG-01 EpochStore
  -> EG-02 World/Evidence
  -> EG-03 Decision/Validity
  -> EG-04 Refresh/Gate
  -> EG-06 Run Adapter
  -> EG-05 Diagnostics/Snapshot
  -> EG-08 Service/Routes
  -> EG-07 Dashboard Preview
  -> EG-09 Production Integration
```

EG-01～EG-07 可以同时开发，但必须按上述顺序逐个审核并合入，不能一次性合并后再猜测哪个模块引入问题。

### 10.3 问题回退

中央审核发现问题后：

1. 不在 staging 上直接修产品代码；
2. 记录失败的候选 SHA、测试 ID 和实际结果；
3. 将问题退回原 Owner Session；
4. Owner 提交新 commit；
5. 重新执行该模块门和受影响的下游门。

---

## 11. 中央测试门

### 11.1 Gate A：合同门

- Zod/TS 合同闭合；
- contract digest 与 Golden Vector 一致；
- 错误体、ArtifactRef 和 Snapshot decoder 可执行；
- 两项 P0 语义已获得用户批准；
- 所有执行 Session 基于同一个 contract SHA。

### 11.2 Gate B：确定性模块门

- WC-01～WC-04；
- IN-01/02；
- RC-01/02；
- RA-01；
- AH-01；
- DP-01；
- EG-01/02；
- RF-01；
- DS-01/03；
- 并发测试使用独立临时数据目录，不得多测试服务共享一个 JSON Store。

### 11.3 Gate C：并发、幂等与 Badcase 门

必须阻断合并的用例：

1. 两个同 Commit 同时进入，返回同一 `effectId`，Ledger 仅一条，Permit 只消费一次；
2. 验证后暂停 Commit，推进 head 再释放，必须持久化终态 `COMMIT_RACE`、写入 `TRANSIENT_RACE / COMMIT` Diagnostic 且 effect=0；只能 reset 后新建 Session，前端不得自动重放 Commit；
3. 两个请求同时领取一个 RefreshPlan，只有一个 Assignment/Attempt/Run；
4. Assignment/Decision 重复消费不能创建第二个 Certificate；
5. 任一 Run 失败后无 Permit、无 Effect；
6. 16 KiB 内 malformed output 可从脱敏 Artifact 重放同一 Parser 失败；超限仅保存长度和 digest；
7. Diagnostic 至少精确覆盖：

```text
AR-02 -> SYSTEM_FAILURE / RUN
DP-01 -> PARSE or COMPOSE
WC-02 -> EXPECTED_BLOCK / VALIDATE
EG-02 -> TRANSIENT_RACE / COMMIT
```

8. 所有 Diagnostic ArtifactRef 可解析；
9. 同一 Role Agent triple 的并发业务 Session 符合 Gate 0 冻结的冲突策略；
10. 不同 Agent triple 的并发 Session 不会串 Attempt、Receipt、Validation、Diagnostic 或 Effect。

### 11.4 Gate D：Dashboard 投影门

- 浏览器只消费单一 Session Snapshot；
- 浏览器不计算 L/U、witness、Gate 或 refresh owner；
- Normal / Impossible / Recovered 分别显示 effect `1/0/0`；
- 所有面板的 snapshotRevision/sessionRevision 一致；
- active Decision 与 in-flight Attempt 不混搭；
- 旧 Session、旧 generation、低 revision 不回退画面；
- stale、unknown Schema、command pending 时所有 mutation 禁用；
- Snapshot 不含密钥、绝对路径、完整 Prompt 或未脱敏 rejected output；
- 1080p 和窄屏人工/截图验收通过；
- Mock Preview 不得作为比赛中间件或真实 Run 证据。

### 11.5 Gate E：真实 Ark/Codex Run

最终权威结果只能由当前 Session 在同一候选 staging SHA 上重新生成。

1. 单 Role smoke：真实 Run ID、严格 Envelope、无秘密泄露；
2. 三 Role spike：不同 Agent/workspace/thread/Run ID，3/3 可解析；
3. 根据真实起止时间决定 `CONCURRENT`；无重叠时必须显示 `SEQUENTIAL_FALLBACK`；
4. Normal：三个真实 Run → current-valid → Commit → effect=1；
5. Impossible：三个真实 ALLOW → No-Cut → effect=0；
6. 只重跑 Budget 并返回 DENY，最终 effect 仍为 0；
7. manifest 中所有 applicable required fixture 进入分母，missing 直接使 Evaluation Gate 失败；
8. 证据绑定 Git SHA、model、runner/profile/prompt/rule/fixture digest、Run/Assignment ID、时间和 usage。

### 11.6 Gate F：Release

需同时满足：

- WSL/Linux `npm run check` 通过；
- 清洁克隆可重现；
- 无密密、真实 Store、workspace 或敏感日志；
- 所有 P0 required fixture 运行；
- invalid effect=0；
- 并发 Commit effect count=1；
- 双 Refresh 不产生第二个 Run；
- Normal/Impossible/Recovered 的 Dashboard 与后端分别为 `1/0/0`；
- 最终演示不使用 FakeRunner 伪装真实 Run。

---

## 12. 默认测试命令

执行 Session 可使用目标命令，但不能把它们作为最终放行证据。

```bash
npm run typecheck
npm run test -w @launchpad/server
npm exec -w @launchpad/server -- vitest run src/epochguard
npm run typecheck -w @launchpad/web
npm run build -w @launchpad/web
npm run build
```

当前 Web workspace 没有正式行为测试配置。P0 默认不新增 Playwright/Testing Library 依赖，使用：

- 纯 Controller/reconciliation 测试；
- `react-dom/server` 静态标记校验；
- Web typecheck/build；
- 独立 Mock Preview；
- 当前 Session 的真实浏览器和截图验收。

最终命令必须在 WSL/Linux 候选 SHA 上运行：

```bash
npm run check
```

真实 Ark 测试必须使用独立显式命令或环境开关，不进入默认无网络的确定性单测。

---

## 13. 不进入 P0 的范围

所有执行 Session 均不得主动增加：

- SSE / WebSocket；
- 新 Router、Redux、D3 或 Dashboard Builder；
- 多 Session BI、趋势、筛选或导出；
- 向量长期记忆或用户画像；
- 通用 Skills Registry；
- 自然语言 Action 入口或 LLM Query Rewrite；
- 自动多轮 Refresh；
- 跨 Session 业务幂等（除非用户在 Gate 0 改变决策）；
- 多进程/多副本 JSON Store；
- Runner 接口改造；
- ECS/Terraform 重构；
- 通用 Agent Observability 产品；
- 用 Mock 或静态 UI 代替真实 Middleware 路径。

---

## 14. 时间编排

| 阶段 | 预估关键路径 | 说明 |
| --- | ---: | --- |
| Gate 0 + EG-00 | 2～3 小时 | 冻结合同，完成 Starter seam |
| EG-01～EG-07 并行波 | 5～8 小时 | 最多 7 个可视化 Session 同时执行 |
| 中央审核与分步合入 | 3～5 小时 | 边合入边重跑目标测试 |
| EG-08 | 5～7 小时 | 协调器、路由、确定性 E2E |
| EG-09 | 3～5 小时 | 唯一生产接线 |
| WSL / Ark / Dashboard 中央验收 | 8～12 小时 | 可与后期修复循环交错 |

预计关键路径约 23～35 小时。时间不足时优先保留真实 Run、Receipt、Validator、Effect Gate、两个场景和单 Snapshot Dashboard，依照最终设计文档的降级阶梯删减视觉扩展。

---

## 15. 状态表

### 15.0 九阶段进度

| 阶段 | 状态 | 证据 |
| --- | --- | --- |
| 1 Contract | COMPLETE | `0d677a2` / `c4927e4`，v7 合同 28/28 |
| 2 Store | COMPLETE | `a7ba259` / `b5576dc` |
| 3 World / Evidence | COMPLETE | `1ff733d` / `9b14f0c` |
| 4 Decision / Joint Validity | COMPLETE | `4f80a20` / `77e0ce9` |
| 5 Refresh / Effect Gate | COMPLETE | `e651618` / `16c03d9` |
| 6 Diagnostics / Snapshot / Run Adapter | COMPLETE | `c49fc7f`、`6df7feb` / `82a4f8e`、`7b81d68` |
| 7 Coordinator / Routes | COMPLETE | `c091886` / `e6e58ba`，EpochGuard 286/286 |
| 8 Dashboard + Production Integration | COMPLETE | `f096edd` 已合入；双场景生产接线、正式四 API、Dashboard 与 controlled-HTTP 浏览器门通过 |
| 9 WSL / Real Ark / Browser / Release | IN_PROGRESS | 精确 SHA 的 WSL 全量 360/360 与 controlled-HTTP 浏览器门完成；真实 Ark 和最终发布材料仍待完成 |

| ID | 名称 | 状态 | Base SHA | Commit SHA | 中央门 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| CONTROL | 规划/审核/测试 | ACTIVE | `f096edd` | `f096edd` | — | 阶段 8/9 COMPLETE；阶段 9/9 IN_PROGRESS；负责真实 Ark、发布材料、最终浏览器与仓库放行 |
| EG-CANARY | 可视化 Session 只读灰度 | ACCEPTED | `475cb93` | — | Visibility / Read-only | 可视化机制通过；worktree 隔离未通过 |
| EG-00 | Contracts & Starter Seams | MERGED | `7b81d68` | `0d677a2` | Gate A **PASS** | v7 合同已由 `c4927e4` 合入 |
| EG-01 | EpochStore | MERGED | `e5f0b3a` | `a7ba259` | Gate B Store **PASS** | 已合入 `epochguard/staging@b5576dc` |
| EG-02 | World / Receipt / Evidence | MERGED | `e5f0b3a` | `1ff733d` | Gate B World/Evidence **PASS** | 已合入 `epochguard/staging@9b14f0c` |
| EG-03 | Decision / Joint Validity | MERGED | `e5f0b3a` | `4f80a20` | Gate B Decision/Validity **PASS** | 最新接缝修复已由 `77e0ce9` 纳入中央历史 |
| EG-04 | Refresh / Effect Gate | MERGED | `e5f0b3a` | `e651618` | Gate B/C Refresh/Effect **PASS** | 最新接缝修复已由 `16c03d9` 纳入中央历史 |
| EG-05 | Diagnostics / Snapshot | MERGED | `e5f0b3a` | `c49fc7f` | Gate B/D Projection **PASS** | 最新接缝修复已由 `82a4f8e` 纳入中央历史 |
| EG-06 | Role Profiles / Run Adapter | MERGED | `e5f0b3a` | `6df7feb` | Gate B/E Run Adapter **PASS** | 最新接缝修复已由 `7b81d68` 纳入中央历史 |
| EG-07 | Dashboard Preview | MERGED | `e5f0b3a` | `bac3f6d` | Gate D Preview **PASS** | 浏览器验收通过；由 `cb09293` 合入，仍是 network-free Mock Preview |
| EG-08 | Coordinator / Routes | MERGED | `c4927e4` | `c091886` | Gate B/C **PASS** | 由 `e6e58ba` 合入；恢复闭包、canonical HTTP 与后台 owner 门通过 |
| EG-09 | Production Integration | MERGED | `ff663db` | `f096edd` | Gate B/D/F **PASS** | 双场景生产接线、真实默认 UUID 门、正式四 API 与 Dashboard 已合入 staging |

状态只使用：

```text
NOT_STARTED
RUNNING
NEEDS_INPUT
READY_FOR_REVIEW
CHANGES_REQUESTED
ACCEPTED
MERGED
BLOCKED
```

### 15.1 EG-CANARY 灰度记录

| 字段 | 结果 |
| --- | --- |
| 可视化任务 | `EG-CANARY 可视化 Session 灰度测试` |
| Thread ID | `01a04cf8-2aa7-7f73-8ce2-27c7fc72cf2b` |
| 仓库 | `<workspace>/volc-agent-launchpad` |
| 基线 | `epochguard/staging@475cb93` |
| 文档可见性 | 最终设计与并行流程文档均可读 |
| 工作包识别 | EG-00～EG-09 共 10 个，批准清单与激活顺序均可见 |
| 读写结果 | 执行前后 Git 工作区均干净，未留下文件变更 |
| 可视化 Session 结论 | **PASS** |
| worktree 隔离结论 | **NOT PASSED / NOT TESTED**：任务与当前 Session 共享 checkout |

原因：Codex 当时保存的项目根是非 Git 的 `<workspace>` 父目录；真正的仓库位于子目录 `volc-agent-launchpad`。因此该次灰度任务只能使用本地共享 checkout。

晋升条件：在启动正式 EG-00 前，必须将 `volc-agent-launchpad` 子仓库单独保存为 Codex Git 项目，然后再创建一个只读 worktree 灰度任务，确认：

1. 新任务的 `git worktree list` 显示不同绝对路径；
2. 主 checkout 与灰度 worktree 的 Git 状态互不影响；
3. 灰度任务能读取 `epochguard/staging@475cb93` 或其后续已批准基线；
4. 只有 worktree 灰度通过后，EG-00 才可以进入 `RUNNING`。

后续处置：由于 Codex 项目注册暂未能直接选择子仓库，中央 Session 在 `<workspace>/.epochguard-worktrees` 手动维护 EG-00～EG-09 十个正式注册 Git worktree 和独立分支。每个可视化任务都必须在任何命令前核对自己的绝对 worktree 路径、分支和基线；中央抽查已证明十个正式 worktree 均为不同绝对路径、不同分支。遗留的 `eg-00-v5` 不属于正式 EG-00～EG-09 注册表，不能作为交付证据。

工作树的创建、路径/分支/基线校准、初始化失败、锁冲突和损坏恢复统一由中央 Session 负责。执行 Session 只报告故障并停止写入，不得自行重建、移动、删除 worktree，也不得切换到共享 checkout。此前失败的异步 fork 未形成正式任务或 Git worktree，已废弃；当前所有正式执行任务的阶段均以下方注册表为准。

### 15.2 可视化执行 Session 注册表

| ID | Thread ID | Branch | Worktree | 当前阶段 |
| --- | --- | --- | --- | --- |
| EG-00 | `01a04d0c-953a-78e3-a118-0822248058b4` | `epochguard/eg-00-contracts` | `.epochguard-worktrees/eg-00` | MERGED / CONTRACT V7 / GATE A PASS |
| EG-01 | `01a04d0c-9c28-7ec3-83d1-29404eec12dc` | `epochguard/eg-01-store` | `.epochguard-worktrees/eg-01` | MERGED / GATE B STORE PASS |
| EG-02 | `01a04d0c-a19c-7a61-a104-dfde763c48de` | `epochguard/eg-02-evidence` | `.epochguard-worktrees/eg-02` | MERGED / GATE B WORLD-EVIDENCE PASS |
| EG-03 | `01a04d0c-a7a7-7742-80f2-7d8414726909` | `epochguard/eg-03-validity` | `.epochguard-worktrees/eg-03` | MERGED / GATE B DECISION-VALIDITY PASS |
| EG-04 | `01a04d0c-ad8e-7e10-a74e-e3b97f8414f6` | `epochguard/eg-04-gate` | `.epochguard-worktrees/eg-04` | MERGED / GATE B-C REFRESH-EFFECT PASS |
| EG-05 | `01a04d0c-b41b-7621-8890-ae88ddeaa17c` | `epochguard/eg-05-snapshot` | `.epochguard-worktrees/eg-05` | MERGED / GATE B-D PROJECTION PASS |
| EG-06 | `01a04d0c-ba9a-75d0-8b42-3c1fe87973ca` | `epochguard/eg-06-run-adapter` | `.epochguard-worktrees/eg-06` | MERGED / GATE B-E RUN ADAPTER PASS |
| EG-07 | `01a04d0c-bff2-7670-b5a3-dce3c6a66246` | `epochguard/eg-07-dashboard` | `.epochguard-worktrees/eg-07` | MERGED / GATE D PREVIEW PASS |
| EG-08 | `01a04d0c-c522-72d2-8db5-9c92c7042784` | `epochguard/eg-08-service-routes` | `.epochguard-worktrees/eg-08` | MERGED / GATE B-C PASS |
| EG-09 | `01a04d0c-caae-7e72-9c22-696dcfe0c9ad` | `epochguard/eg-09-integration` | `.epochguard-worktrees/eg-09` | MERGED / GATE B-D-F PASS |

### 15.3 EG-00 / Gate A 验收记录

| 字段 | 结果 |
| --- | --- |
| 合同提交 | `0d677a22107786308865de647354f5e3a30ee094` |
| staging 合并提交 | `c4927e49379d0f321a642c8900f32ff852173cc3` |
| 合同版本 | `epochguard-contract-v7`，`schemaVersion=1` |
| 合同摘要 | `sha256:4dfbeb9e55de7ca17a19f5fb8f99494b17e441af0f877767027284d3ae646361` |
| 合同测试 | **28/28 PASS** |
| 当前中央 EpochGuard | `f096edd` 上 **330/330 PASS**；App + EpochGuard **336/336 PASS** |
| 当前 Windows Server | **359/360**；唯一失败为既知 POSIX `/tmp/codex-home` 路径断言 |
| 当前 WSL2 Server | 干净克隆、`npm ci` 后 **360/360 PASS** |
| 构建门 | 全工作区 typecheck、Web/Server production build **PASS** |
| v7 独立审核 | Server/Web 版本、digest、九种错误、strict schema、状态码、四个 Golden Snapshot hash 完全对称；三路 digest 复算一致 |
| Gate A | **PASS** |

v6 的 8,118 个 mutation candidates、479 个标注 snapshots、17,356 次 decoder 调用属于历史合同证据，不能冒充 v7 的当前统计。已知非 Gate A 阻断项仍是 Windows 上单个测试硬编码 POSIX `/tmp` 路径；依赖审计需在发布门前单独跟踪，不得与合同语义正确性混为一项。

### 15.4 EG-01 / EpochStore 验收记录

| 字段 | 结果 |
| --- | --- |
| 模块提交 | `a7ba2596319da6636270a90ae59d7728f1f5e7f1` |
| staging 合并提交 | `b5576dc21fe65ec63dbc8a9b65218b93e476d3e8` |
| 变更边界 | 1 个线性提交；只新增 `epoch-store.ts` 与 `epoch-store.test.ts` |
| 中央聚焦测试 | Contracts + EpochStore **33/33 PASS** |
| 构建门 | Server typecheck / build **PASS** |
| 独立边界审核 | 模块提交未修改合同；随后已在 `c4927e4` 的 v7 合同下完成中央回归；allowlist、提交拓扑、公开 API、初始化闭合均 **PASS** |
| 独立故障矩阵 | 64 路并发、10 次失败队列、callback/write/rename/serialization 故障、alias 隔离、损坏文件与重启恢复均 **PASS** |
| Gate B Store 子项 | **PASS** |

验收边界：EpochStore 只承诺单 Node 进程内的单 writer JSON 持久化，不宣称支持多进程或多服务副本共享同一文件。全量 Windows Server 的既知 POSIX `/tmp/codex-home` 断言仍单独跟踪，不归因于 EG-01。

### 15.5 EG-02 / World、Receipt 与 Evidence 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `914d4465ec74349aba34d1c2b364c248c154e436` |
| 安全修复提交 | `1ff733d45d18f44d52627160395c4d6994e0d498` |
| staging 合并提交 | `9b14f0c9838f49c0b32cbe52c7c145662852e849` |
| 变更边界 | 2 个线性提交；只新增 EG-02 allowlist 内 4 个实现文件及 4 个测试文件 |
| 中央累计测试 | Contracts + EpochStore + World/Fixture/Receipt/Evidence **54/54 PASS** |
| 构建门 | Server typecheck / build **PASS** |
| 资源完整性 | 所有公开 resolver 与 Evidence Pack 构建路径均重算 canonical value hash；返回对象与持久历史无 alias |
| 写入前门 | 错误、占位或陈旧 Evidence Pack hash 在首次 workspace write 前拒绝；测试确认零写入 |
| 独立复核 | Resolver value-only tamper、嵌套 alias、Pack hash/no-write、合同与 allowlist 均 **PASS** |
| Gate B World/Evidence 子项 | **PASS** |

验收边界：本子项证明确定性 WorldLedger、Receipt 与 canonical Evidence Pack 的本地安全语义；真实 Run 绑定、联合验证和协调器端到端门仍分别由 EG-06、EG-03 与 EG-08 承担，不能以本记录替代 Gate E 或完整 Gate B/C。

### 15.6 EG-03 / Decision 与 Joint Validity 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `467e15d059e8f1f52d00ff0cb265f119329da99a` |
| 拒绝产物修复 | `2ce27440b9ac0df2bdbf6ce904cd634705620f94` |
| 脱敏重放修复 | `4d6e9b5b3fc25f148791696a568ff66e8e0dc20a`、`2fe94c41080f376347da9078edce558bb108d197`、`fe8a15ffb1a638a57353e1c41ebf35a94187d82c` |
| PGP 格式 hotfix | `ee86f754729f91d842469c263badc5ab3810d1a7` |
| 最终接缝修复 | `4f80a20b2897e67dead782670542c0cd75d2ff24` |
| staging 合并提交 | `8fc3bb4`、`c5818f8`、`77e0ce9` |
| 变更边界 | 始终只修改 EG-03 allowlist 内 4 个实现/测试文件；模块分支未修改合同，随后已在 `c4927e4` 的 v7 合同下完成中央回归 |
| 中央累计测试 | 首次合并 **80/80 PASS**；第一波后 hotfix 累计 **236/236 PASS** |
| 构建门 | 全工作区 typecheck；Web/Server production build **PASS** |
| Decision 绑定 | Session、Action、Assignment、Role、Receipt、nonce、Attempt output digest 与冻结 Registration 全部从权威记录闭合 |
| 拒绝事务 | ≤16 KiB 生成确定、幂等、非扩张且可重放同一 Parser failure 的脱敏 Artifact；超限仅保存长度与摘要；均不消费 Assignment、不建 Decision、不移动 active pointer |
| Joint Validity | 三 Role、当前 head、L/U、canonical witness、No-Cut 与 current-head coverage 均 fail closed |
| 独立复核 | 格式矩阵、PGP/私钥/JSON 结构、空值 continuation、16 KiB 边界、scope/clean 均 **PASS** |
| Gate B Decision/Validity 子项 | **PASS / MERGED** |

### 15.7 EG-04 / Refresh Planner 与 Effect Gate 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `fc8f465b5321a6d331809a5c52e1057aa4d728f8` |
| 闭包修复提交 | `c72319f626ee4f048ea24141a025db696bf3535c`、`27fcbc2383e1d77effb17c07df3a4a610ae7f685`、`247f11fc01348e529c9fa96b173b8f58b63e2673`、`63a8ee68af86eed219741b4d86f0bca6042852c9` |
| 最终接缝修复 | `e65161847b52c1af8bc555b1a5ed39c98dffd4f1` |
| staging 合并提交 | `5109ecb1653179e2bfe2db6bbf56f8cf99a082c1`、`16c03d9` |
| 变更边界 | 只修改 EG-04 allowlist 内实现/测试文件；模块分支未修改合同，随后已在 `c4927e4` 的 v7 合同下完成中央回归 |
| 中央累计测试 | Contracts + EG-01～04 **164/164 PASS** |
| 构建门 | 全工作区 typecheck；Web/Server production build **PASS** |
| Refresh | AVAILABLE/CLAIMED/COMPLETED、Session pointer、revision/head/dependency/Decision/Proof 与 Assignment/Attempt/Run 全闭合；合法 COLLECTING/终态重试保持幂等 |
| Effect | 首次与 lost-response retry 均重验 Permit/JVC/Validation/Run/Registration/ResourceVersion；并发 Commit exactly-once |
| Fail-closed | future head、ghost Plan、重复/影子 Registration、witness 坍缩、READY 残留 active 状态及非法 Attempt lifecycle 均拒绝 |
| 独立复核 | 状态机静态审查、111/111 聚焦回归、scope/contracts/clean 均 **PASS** |
| Gate B/C Refresh/Effect 子项 | **PASS / MERGED** |

### 15.8 EG-05 / Diagnostics 与 Single Snapshot Projection 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `eeec63e2f23bd66f80072bd8761bb7eb012934e7` |
| 因果/展示修复 | `ad625df603dfb763b7ef6166efc5c218a9f4c87b`、`1c8ae447a03fdde9c6c72ca0368cf81b3a0a44f5`、`592408173b206949c8fdc2e33000b5f7c4e72537`、`0a824b4fc21d7896f418c423c41d1f21dbd226dd` |
| 最终接缝修复 | `c49fc7f07305bbf0e684feda1ac68932ec534384` |
| staging 合并提交 | `e5f5f676830205a18d9f88aa2a6ffd8c36c9feaf`、`82a4f8e` |
| 变更边界 | 只修改 EG-05 allowlist 内实现/测试文件；模块分支未修改合同，随后已在 `c4927e4` 的 v7 合同下完成中央回归 |
| 中央累计测试 | Contracts + EG-01～06 **235/235 PASS** |
| 构建门 | 全工作区 typecheck；Web/Server production build **PASS** |
| 单快照纪律 | Store 只读取一次并立即深拷贝；active Decision 与 in-flight Attempt 独立投影；Effect count 按 Session 派生 |
| 因果闭包 | NO_CUT、COMMIT_RACE、CONSISTENT_DENY、HISTORICAL_STALE 的 ArtifactRef、Validation/JVC/Permit/Receipt/RefreshPlan 与冻结 Agent 均验证 |
| 展示边界 | 自由文本不输出敏感格式、路径、Prompt、环境值或无标签 32/40/64 位 opaque hex；结构化 ID/digest 按字段保留 |
| 独立复核 | 生命周期、幂等、reason-specific 因果链、展示字段、70/70 聚焦回归与 scope/clean 均 **PASS** |
| Gate B/D Projection 子项 | **PASS / MERGED** |

### 15.9 EG-06 / Role Profiles 与 Run Adapter 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `cc2855c9d598a0d6ef78f59c46260a34b134120a` |
| Join / failure 修复 | `2e844e28611383426d8a6320f619b8fa18cbd78b` |
| Timestamp 合同修复 | `5e4a5db3c6fa88ba9c3073cff52a65fb6e38a149` |
| 最终接缝修复 | `6df7febfd5d7212f5cc25284a446300b4f5352a9` |
| staging 合并提交 | `1e1dce5da80a23d59888978a11e7e605e4b55f69`、`7b81d68` |
| 变更边界 | 只修改 EG-06 allowlist 内实现/测试文件；模块分支未修改合同，随后已在 `c4927e4` 的 v7 合同下完成中央回归 |
| 聚焦测试 | Contracts + Run Adapter **55/55 PASS** |
| 构建门 | Server typecheck / build **PASS** |
| Run 绑定 | Role profile、Assignment、Attempt、Run、兄弟任务终止和并发 Store mutation 均闭合 |
| 时间边界 | 所有 Run 时间统一使用冻结 `TimestampSchema`；合同不接受的时间不会进入 Attempt，恢复事务仍可提交 Assignment `REJECTED` |
| 独立复核 | 静态审查与合成回归均 **PASS**；4 文件 allowlist、合同与工作树 clean |
| Gate B/E Run Adapter 子项 | **PASS / MERGED** |

### 15.10 EG-07 / Dashboard Preview 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始模块提交 | `3a4c55b2efda9376c7986c1b0d6eb82d2339d965` |
| 逻辑修复提交 | `d92000688ee1b943d9a32eb1e92187a793e79924` |
| 404 修复提交 | `bac3f6d92f2c9740291461133d56b38ea8c3528d` |
| staging 合并提交 | `cb09293` |
| 变更边界 | 3 个线性提交；恰好只新增 EG-07 allowlist 内 10 个 Web Preview 文件 |
| 静态门 | 候选分支的 v6 Contracts **27/27 PASS** 为历史证据；合入 v7 后 Contracts **28/28 PASS**，Web typecheck / production build **PASS** |
| 投影纪律 | 单一 frozen Snapshot；前端不计算 L/U、witness、Gate、Effect count 或 refresh owner |
| Fail-closed | 首次 body-less typed 404、unsupported schema、projection mismatch、stale/command pending 均禁用 mutation；404 清空可执行 Snapshot |
| Refresh owner | 严格从 `snapshot.refreshPlan.agentIds` 映射当前 Agent 卡；P0 Preview 为 Budget-only |
| 浏览器桌面门 | Normal Commit `0→1`；Impossible `effect=0`；Recovered DENY `effect=0`；首次 404 显示 `Actions disabled` |
| 浏览器窄屏门 | 390×844 的顶部、Agent 卡、No-Cut/Effect Gate、Refresh 与 Ledger 分段截图均可读，页面无整体横向溢出 |
| 截图证据 | `<local-audit-root>/eg07-bac3f6d`（本地验收产物，不随公开仓库提交） |
| Gate D Preview 子项 | **PASS / MERGED** |

非阻断可用性提示：窄屏 Preview 的场景选择器和 interval table 使用局部横向滚动；测试控件高度约 27～31 px，满足最小点击目标但低于舒适的 44 px 触控建议。它们不改变 Dashboard 安全投影或 Gate D P0 结论，生产接线后的最终屏幕仍需在 EG-09 候选 SHA 上复验。

### 15.11 EG-08 / Coordinator 与 Routes 验收记录

| 字段 | 结果 |
| --- | --- |
| 初始协调器与路由 | `1b28d0552a338371f1795c7346c9c772023a0228` |
| 重启稳定态修复 | `c0c6123e624e105051e3b40128a499cc750aa3f4` |
| 非阻塞 Create | `884d091525761b76d6e926534a118c136a36d97c` |
| v7 合同合并 | `e72933199a03af29f51e44e18740412564cf1672` |
| canonical HTTP 修复 | `a4e365682abd8aab6e17c5ed17e6dec9a7836cc1` |
| 恢复与 owner 闭包 | `3da8ac1`、`55a7100`、`94a227c`、`c091886ee2a611dac3859a83f6f4bca3ce79ce95` |
| staging 合并提交 | `e6e58ba399a97a396b69056423fbf432594d0c8b` |
| Create 行为 | 先返回权威 `DISPATCHING` Snapshot；模型 Run 在 service-owned background task 中继续，Dashboard 可轮询 queued/running/validating |
| 冷启动恢复 | 稳定可操作态原样保留；真实 in-flight Attempt/Assignment/CLAIMED Plan/ISSUED Permit 在单次 Store mutation 内闭合；非法 Plan/Permit 正反组合原子拒绝 |
| 后台失败 | 持久化失败重试一次；持续失败仅上报固定 `code + sessionId` 并保留 fail-closed owner latch；已落盘终态不执行冗余闭合 |
| HTTP 门 | v7 canonical errors；客户端 Zod=400；未知内部错误脱敏 500；production 仅四条正式 API，不存在 `/validate` 或 debug route |
| Commit race | `COMMIT_RACE` 为终态，写入 `TRANSIENT_RACE / COMMIT`，effect=0；reset 后可新建 Session |
| 聚焦测试 | Service **30/30 PASS**；全部 EpochGuard **286/286 PASS** |
| 全量门 | typecheck / build **PASS**；Windows Server **311/312**，唯一失败为既知 `/tmp/codex-home` 平台断言 |
| Gate B/C | **PASS / MERGED** |

### 15.12 EG-09 / Production Integration 验收记录

| 字段 | 结果 |
| --- | --- |
| UUID 投影边界修复 | `ff663db90496e35db012d53d964da37451b903ac`；只放行结构化系统 ID 中的合法 UUID，未知高熵值、错误 digest、嵌入 UUID 与敏感文本继续 fail closed |
| Production Integration | `f096edd8dec452f8ebf0dc5368a54d0e98be6c17`；父提交精确为 `ff663db`，严格修改 8 个批准文件 |
| staging 合入 | `epochguard/staging@f096edd8dec452f8ebf0dc5368a54d0e98be6c17`，已推送 submission remote |
| 双场景服务 | Normal / Impossible 使用独立 Store、共享三 Role Agent 与全局 mutation queue；冷启动按双 Store 扫描路由，结构冲突 fail closed |
| 真实默认 ID 门 | `session_<UUID-v4>`；并发 Create 恰好一路成功、一路 canonical `AGENTS_BUSY`，总 dispatch=3，失败分区零 Assignment |
| Production HTTP | 仅 `POST sessions`、`GET session`、`POST refresh`、`POST commit` 四条正式 API；均在 Bearer 边界内，debug/dev 路由为 canonical 404 |
| Web | 使用真实 HTTP Source；跨 Chat/Safety 与 reload 保持 Session；busy 恢复只 GET 不重放 mutation；clear、Abort、pending 与 localStorage 均 fail closed |
| 自动化门 | Dual + App **45/45**；EpochGuard **330/330**；App + EpochGuard **336/336**；typecheck/build **PASS** |
| 平台门 | Windows Server **359/360**，唯一失败为父提交已有 `/tmp` 基线；WSL2 干净克隆 Server **360/360 PASS** |
| 浏览器门 | 精确 SHA controlled-HTTP 验收通过：390×844、1000 字符文本、单纵向滚动、生产无 Mock/Preview、无 P0/P1 |
| 独立终审 | Server、测试矩阵、Web 三路 **ACCEPT**；P0=0，P1=0；Web 记录一个非阻断 P2：极端永久挂起请求需刷新恢复 |
| Gate B/D/F | **PASS / MERGED**；真实 Ark 模型生命周期归阶段 9 单独放行 |

---

## 16. 用户批准清单

在任何执行 Session 被创建前，需要用户确认：

- [x] 接受“1 个中央 Session + 10 个执行 Session”的编排；
- [x] 接受 EG-00 完成并审核后才启动第一并行波（EG-00～EG-09 已完成并合入）；
- [x] 接受每个执行 Session 使用独立 worktree；
- [x] 接受文件 allowlist 和唯一 Owner 制度；
- [x] 接受同 Role Agent triple 冲突时 `409 AGENTS_BUSY` 的 P0 策略；
- [x] 接受 P0 exactly-once 范围为同一 `Session + Action`；
- [x] 接受 Dashboard Session 先做隔离 Preview，再由 EG-09 完成真实生产接线；
- [x] 接受当前 Session 只做裁决、审核、合并和验收，不代写产品功能；
- [x] 接受任一 invalid effect、required fixture missing、重复 Effect/Refresh Run、Snapshot 混搭或 FakeRunner 伪装都阻断发布。

---

## 17. 已执行至 EG-09 的批准后激活顺序

1. [x] 当前 Session 创建 `epochguard/staging` 并提交设计/流程文档；
2. [x] 记录共同 base SHA；
3. [x] 创建并验收 **EG-00 Contracts & Starter Seams**；
4. [x] 重跑 Gate A 并合入 staging；
5. [x] 从冻结 staging 创建 EG-01～EG-07；
6. [x] 执行 Session 使用标准交付模板提交；
7. [x] 当前 Session 按第 10.2 节顺序审核和合入 EG-01～EG-08；
8. [x] EG-01～EG-06 稳定后激活 EG-08；
9. [x] EG-07/08 稳定并合入后，以 `e6e58ba` 激活 EG-09；
10. [ ] EG-09 候选已合入，Gate B～F、WSL 与 controlled-HTTP 浏览器门已通过；真实 Ark 与最终发布浏览器门仍待完成；
11. [ ] 全部通过后才将 staging 晋升为最终候选版本。
