# thincoder-suite advisor 可配置分层路由与子代理资源策略 — 需求与设计

> 范围说明：本设计在 advisor 分层路由之外，一并承载两项相邻机制（F8 评审通过判定修复、F9 eng_coder 子代理资源与确认策略）——合并入档避免碎片化；F8 流程偏离已登记 METHODOLOGY 文档历史。

- 日期：2026-09-01
- 状态：PROPOSED（待用户发起设计评审）
- 范围：一期 host 机制 + 二期 DSH 设置页 UI
- 关联文档：`../METHODOLOGY.md`（工程工作流）、`README.md`（插件说明）
- 修订历史：
  - 2026-09-01 初稿（F1–F7，T1–T10）
  - 2026-09-01 评审修订（预算模型/成对解析/记忆开关，T 扩至 T17）
  - 2026-09-01 F8 判定修复 hotfix（先行实施并登记）
  - 2026-09-02 F9 加入（子代理资源与确认策略，T18/T19）
  - 2026-09-02 评审修订（reset 对称/engCoderEffort 示例/ε 数值界/T20/T21 错误路径用例）
  - 2026-09-02 一期交付（eng_coder）：8 文件 + test 20 用例全绿；分歧审计（功能 clean，D1 文档状态列已随本表更新、D2 测试脚本字面已注明、D3 legacy 环 N4 警告已补、D4–D6 记录于 §3.7 状态注）

---

## 0. 背景与问题陈述

`advisor` 评审在真实使用中**连续超时**（会话 `session-10501959-4760-4791-b39b-783553943f00` 取证）：

| 时间 | 耗时 | 结果 |
|---|---|---|
| 12:38:55 | 699.4s | review timeout after 600s（2 份文档） |
| 12:50:41 | 657.2s | review timeout after 600s（1 份文档） |
| 13:13:17 | 606.1s | review timeout after 600s |
| 15:28:32 | 229.4s | ✅ 成功并签发 token |

参照会话同一评审成功耗时 436.3s / 399.0s（占 600s 预算约 2/3）。

根因链（已确认，非推测）：

1. **模型选型慢**：`advisor` 路由到 `qax/glm-5.3`（1M 上下文旗舰推理模型），设计评审需多轮 LLM 往返（读全文 → 搜 METHODOLOGY → 出评审表），单轮响应可达数分钟；
2. **预算余量小**：常态 ~400s，贴近 600s 上限，网关负载波动 ~1.5 倍即超时；
3. **预算非硬生效**：`REVIEW_TIMEOUT_MS` 只在工具循环轮次之间检查（`advisor.mjs:206-213`），单次流式调用期间不执行硬截止——4 次超时实际耗时 606~699s 即为证据；90s 看门狗只掐「完全无输出」（`advisor.mjs:157-194`），慢速但持续吐字不受限；
4. **推理档不可控**：插件只读 `provider/model/timeoutMs`，不传 `reasoningEffort`——评审推理预算无法调低。

另发现设计冗余：评审代理会注入 `AGENTS.md`（截断 16K 字符，`advisor-msgs.mjs`），与「独立评审、防锚定」的收敛协议目标相悖，且加大上下文与耗时。评审代理**并不加载 CLAUDE.md**（CLAUDE.md 只进主代理 workspace 上下文）——此前会话中「评审加载 268KB CLAUDE.md」的假设不成立。

---

## 1. 需求（三层）

### 1.1 总体目标

让 thincoder-suite 的 advisor 评审**配置可控、按轮次分层路由、不再因慢模型撞超时**，并最终可在 DSH 设置 UI 中调整；评审质量不因提速而降低（模型本体不变，只调推理预算与路由）。

### 1.2 功能用户故事

- **F1 分层路由**：作为用户，我希望 advisor 首次评审（round 1）用配置的「旗舰组」模型，收敛轮（round 2+）用「快档组」模型，以便关键轮保质量、核销轮提速。
- **F2 推理档可控**：作为用户，我希望两组模型各自可配 `reasoningEffort`（off/low/medium/high/max），以便在不换模型的情况下控制评审耗时。
- **F3 评审记忆开关**：作为用户，我希望评审代理默认**不注入**项目记忆（AGENTS.md），并在需要时显式开启，以保评审独立性。
- **F4 会话级覆盖**：作为用户，我希望能在当前会话临时覆盖 advisor 配置（模型/effort/超时/记忆开关），且优先级高于全局配置；一期通过对话内 `advisor_config` 工具操作。
- **F5 超时硬生效**：作为用户，我希望评审超时真正在预算时刻触发（不再出现 606~699s 超跑），且超时消息告知已完成轮次/已读文件。
- **F6 兼容迁移**：作为用户，我希望已有的 `advisor.provider/model/timeoutMs` 配置无需改动即可继续工作（自动映射为 round1 组）。
- **F7 设置页 UI（二期）**：作为用户，我希望在 DSH 设置面板中可视化编辑 round1/收敛组、记忆开关、consult/escalate 模型池，并可「应用到当前会话」。
- **F8 评审通过判定修复（hotfix 已先行实施）**：作为用户，我希望 advisor 的「裁决通过」启发式只把**未标记已修复的 🔴 行**视为未解决——收敛轮验证表（Severity 列保留原级别 🔴、Status 列标 Fixed）也能正常签发 design token。触发：round 2 复审结论「通过」+ 回显 `[APPROVE:...]` 仍被 `isApprovalVerdict` 的旧规则（任何含 🔴 的行即未通过）误判拒签。
- **F9 eng_coder 子代理资源与确认策略**：作为用户，我希望 eng_coder 子代理有充足的输出预算（不撞 max-tokens）、且不会向用户发起交互确认（不弹窗死等）——实现者子代理需要用户决策时写入交付报告，由主会话转达。触发（2026-09-02 实测两次失败）：① 子代理输出撞 `max-tokens` 上限——`eng.mjs:175` spawn 未传 `maxTokens`，父级也未配置，子代理落 DSH 默认小档；② threat-intel 会话（bc8eca07 取证）执行 `git rebase` 触发确认弹窗，确认 UI 按 agent 路由不冒泡主会话且无超时 → `run.result` 永不落定（该会话无 `approval/asked` 审计记录——弹窗来自 `ask_user_question` 类确认通道而非 approval 服务）。

### 1.3 非功能标准

- **N1** 一期保持 host-only（纯 `.mjs` 零依赖），无 client 构建；二期引入 client bundle 时才增加构建。
- **N2** 不破坏评审收敛协议：5 轮预算、引用验真（`file:line` 机械校验）、响应表协议、design token 签发（`[APPROVE:<code>]` 回显判定）全部保持。
- **N3** 评审质量不降（**范围限定：路由/effort 层面**——模型本体不变，仅推理预算与路由变化）；F3 记忆注入默认关闭是**接受的权衡**（评审以显式 `documents` 为唯一需求来源，独立性优先），由 T17 质量冒烟验证关键缺口仍能被发现。
- **N4** 配置校验失败时 fail-safe：非法 effort/timeout 忽略并提示，不崩溃；未知 provider/model 保持原路由并提示（**一期不做注册表检测**——插件无 provider 清单访问，该子句的检测随二期 UI provider 下拉实现，见 §3.9）。
- **N5** 一期改动仅限插件仓库文件（`lib/`、`cordis.patch.yml` 示例、`README.md`、新增 `docs/`、`test/`）；部署侧 `profile/profiles/web/cordis.patch.yml` 由用户按迁移说明自行更新（设计文档不直接改部署配置）。
- **N6** 配置改动可回退（undo 快照机制覆盖 DSH 配置；插件仓库文件由 git 管理）。

---

## 2. 方案总览

两期交付（用户已确认）：

- **一期（host 机制）**：配置模型升级 + 分层路由 + effort 透传 + 记忆开关 + 会话覆盖 + 超时硬生效 + 旧配置兼容 + `advisor_config` 工具 + 单元测试。改 `cordis.patch.yml` 即生效，立即解决超时。
- **二期（设置页 UI）**：client bundle + `settings.section` 设置页 + host 配置 API + 表单（round1/收敛组/记忆开关/consult 池）+「应用到当前会话」。

---

## 3. 设计 — 一期（host 机制）

### 3.1 配置模型

```yaml
# bundle cordis.patch.yml 示例（本机 profile 配置同样式）
- id: thincoder-suite
  config:
    advisor:
      round1:                    # 首次全量评审（advisorRound == 0）
        provider: qax
        model: glm-5.3
        effort: medium           # 可选 off|low|medium|high|max；缺省不传（适配器默认）
        timeoutMs: 900000        # 缺省 600000
      convergence:               # 收敛轮（advisorRound >= 1，round 2+ 共用）
        provider: qax
        model: glm-5.3-flash
        effort: low
        timeoutMs: 300000
      includeProjectGuide: false # 评审是否注入 AGENTS.md（默认 false）
    engCoderMaxTokens: 65536     # eng_coder 子代理输出预算（可选；缺省 65536，F9）
    engCoderEffort: low          # eng_coder 子代理推理档（可选 off|low|medium|high|max；缺省 low，F9；非法值忽略并警告 N4）
    consultModels: [ ... ]       # 不变
```

- **旧配置兼容**：存在 `advisor.provider` / `advisor.model` / `advisor.timeoutMs` 且无 `advisor.round1` 时，自动视为 round1 组（F6）。
- **默认值（仅 timeoutMs 有代码常量默认）**：round1.timeoutMs 缺省 600000；convergence.timeoutMs 缺省 300000；`effort` 无默认（缺省不传，用适配器默认）；`provider/model` 无默认（走解析链）。**其余字段缺省一律落入 §3.2 解析链继续下探**，不存在"静默用默认值"的中间态。
- **组内缺省回退链**：见 §3.2「模型解析链（单一事实源）」——所有覆盖/回退语义只在那里定义，本节不重复。
- **effort 取值**：仅接受 `off|low|medium|high|max`；其他值忽略并打印警告，不传该字段。

### 3.2 模型解析链与分层路由

**模型解析链（单一事实源）**——所有覆盖/回退语义只在以下一节定义，其他章节一律引用：

1. 会话覆盖 `sessionState.advisorOverride`（字段级）
2. 组字段：`advisor.round1` / `advisor.convergence`（当前轮次对应的组）
3. 旧字段 `advisor.provider/model/timeoutMs`（仅 round1 组；F6 兼容）
4. 主代理路由（`agent.options.provider/model`）
5. 仍无 → 报错「no LLM route available」

- **provider/model 成对约束**：最终选用的 provider 与 model 必须来自**同一解析环**（合并后的组环 / legacy / agent options），禁止跨环混搭。字段级合并（覆盖 ⊕ 全局组，§3.6）发生在**组环内部**，不违反成对约束；仅当合并后的组环 provider/model 任一缺失时，整对下探下一环（legacy → agent options），并输出 N4 风格警告说明被忽略的覆盖字段。
- **成对解析工作示例**：
  | 场景 | 会话覆盖 | 全局组 | 合并后组环 | 结果 |
  |---|---|---|---|---|
  | 只覆盖 provider | `round1.provider = X` | `{provider: A, model: M}` | `{provider: X, model: M}` | 组环 pair 完整 → 用 (X, M) |
  | 只覆盖 model | `round1.model = N` | `{provider: A, model: M}` | `{provider: A, model: N}` | 组环 pair 完整 → 用 (A, N) |
  | 组环缺 provider | `round1.model = N` | `{model: M}`（无 provider） | `{model: N}` | 组环缺 provider → 整对下探 legacy/agent options，N4 警告说明覆盖字段被忽略 |
- **effort/timeoutMs 仍按字段解析**（不要求与模型同环）：上一环提供了该字段即用，否则落到下一环；整组解析为单一 `{ provider, model, effort, timeoutMs }` 后传给工具循环。
- 路由键 = `sessionState.advisorRound`，**缺失/undefined 视为 `0`**：`0` → round1 组；`>= 1` → convergence 组。
- round 2/3/4/5 全部使用 convergence 组（收敛轮语义相同：只核销上轮清单）。
- 路由发生在 `runAdvisorReview` 内（`advisor.mjs`）。

### 3.3 effort 透传

- `collectStream` 调用 `llm.stream` 时，若组配置含合法 `effort`，在 GenerateOptions 中追加 `reasoningEffort: effort`。
- 字段名以 DSH `dsh-llm` GenerateOptions 为准（主代理请求 header 已验证字段名为 `reasoningEffort`；实现时对照 `dsh-llm` 类型定义核对，若名称不同以代码注释记录）。
- 会话级覆盖同样支持 `effort` 覆盖。
- **跨环警告**：effort 允许按字段解析（§3.2），但若 effort 的解析环 ≠ provider/model 的解析环（例如组环回落、effort 来自会话覆盖而模型来自 agent options），输出 N4 风格警告（effort 可能应用于不同 provider 的模型）。

### 3.4 超时硬生效（绝对截止 + idle 看门狗双机制）

**预算模型（一次性定义，F5 语义的唯一来源）**：每次 advisor 调用 = 一轮评审，其硬预算 = **该轮组的 `timeoutMs`**（round1 缺省 600000——继承旧 `REVIEW_TIMEOUT_MS` 语义；convergence 缺省 300000）。`REVIEW_TIMEOUT_MS` 常量**退役**为 round1 默认值来源，不再存在独立的"整体评审预算"。示例 `round1.timeoutMs: 900000` 即 round1 调用最多 900s（非死配置）；每次收敛轮最多 300s。

- **绝对截止（新，解决超跑）**：每次 `llm.stream` 调用开始时挂一个 `setTimeout(deadlineMs)` 截止定时器（**不依赖 chunk 到达**，静默流同样在预算时刻被中止），并在每个 chunk 到达时做墙钟检查双保险；触发即 abort 并返回 timeout。轮内单次调用预算 `deadlineMs = 组 timeoutMs - elapsed`（elapsed = 本轮已耗，含前面多次 LLM 调用与工具执行）——一轮开始于预算尾部时，该次调用最多再跑剩余预算而不是完整 `timeoutMs`。
- **idle 看门狗（保留，stall 检测）**：90s 内无任何 chunk → abort 并重试（现有 `LLM_CALL_STALL_MS` / `STREAM_ATTEMPTS` 机制不变），窗口 clamp 到 `min(90s, deadlineMs)`（`timeoutMs < 90s` 时看门狗不喧宾夺主）。**不再配置化**（YAGNI：绝对截止已覆盖硬超时，idle 仅用于检测挂起）；测试注入缝 = `collectStream` 内部选项参数 `stallMsOverride`（仅测试用，非用户配置，见 §5.1）。
- 每轮循环顶部检查 `elapsed ≥ 组 timeoutMs`（沿用 `advisor.mjs:206-213` 的检查点）。
- **裁决顺序（stall vs timeout）**：**绝对截止优先**——预算到点（`elapsed ≥ 组 timeoutMs`）即返回 timeout（增强消息），无论当前是否处于 stall 重试中；**deadline 计时器跨 stall 重试持续运行**（重试不豁免预算）。stall 错误仅在预算未耗尽且 `STREAM_ATTEMPTS` 重试全部失败时返回（provider_stall 诊断，保持现行为）。
- 效果：单轮调用耗时 ≤ 该轮组 `timeoutMs + ε`（ε = 单次 abort/清理开销），消除 606~699s 超跑（F5）。
- 超时消息（两类结束路径）：
  - **timeout**（绝对截止触发）：增强格式 `Advisor: review timeout after Ns (completed K tool rounds, M files read). Try again with a narrower scope.`——循环内跟踪 `turns` 与已读文件数（工具结果计入 `read` 调用次数）；
  - **stall**（idle 看门狗 + 重试耗尽）：保持 `provider_stall` 诊断消息（不含轮次/文件数——瞬时错误而非预算耗尽，重试仍可能成功）。

### 3.5 评审记忆开关（includeProjectGuide）

- `advisor-msgs.mjs` 的 `buildAdvisorUserMessage`：`includeProjectGuide === false`（默认）时跳过 `injectProjectGuide`，并追加一行说明：
  `(Project guide not injected — review is based on the documents list only. Pass requirement/design docs explicitly via documents=[...].)`
- `true` 时保持现有 16K 截断注入行为。
- 会话级覆盖可临时翻转（F3、F4）。

### 3.6 会话级覆盖（advisorOverride）

- `sessionState` 新增字段 `advisorOverride: { round1?: {provider?, model?, effort?, timeoutMs?}, convergence?: {...}, includeProjectGuide?: boolean }`。
- 合并规则：**字段级浅合并**——会话覆盖的组对象与全局组对象按字段合并（会话只覆盖 effort 也可以），未覆盖字段回落全局。
- 优先级：见 §3.2 模型解析链（单一事实源）（F4）。
- **一期入口：`advisor_config` 工具**（注册于 `lib/index.mjs`，textTool；**线格式 = JSON 对象文本**，工具执行时 `JSON.parse` 参数文本；不做 CLI 字符串解析）：
  - `{ action: "get" }` — 显示当前会话生效配置（覆盖/全局/路由来源逐字段标注）；
  - `{ action: "set", path: "round1.effort", value: "low" }` — 写入 `advisorOverride`；
  - `{ action: "reset", path: "round1" | "convergence" | "includeProjectGuide" | "all" }` — 清除对应会话覆盖（省略 path = "all"，与 set 的 path 枚举对称）；
  - **合法 path 枚举**：`round1.provider|model|effort|timeoutMs`、`convergence.provider|model|effort|timeoutMs`、`includeProjectGuide`；
  - **值转换（coercion）**：`timeoutMs` 收 number（1000~3600000）、`effort` 收枚举 `off|low|medium|high|max`、`includeProjectGuide` 收 boolean、`provider/model` 收 string；
  - **非法输入不变量**：**JSON 解析失败（malformed）**、未知 action/path、类型错误、越界值 → 统一返回错误文本（`advisor_config: invalid input — <原因>`），`advisorOverride` **保持原样不变**（N4）。
- 二期由设置页按钮调用同一 host 逻辑（复用，不重复实现）。

### 3.7 受影响文件（一期）

| 文件 | 状态 | 改动 |
|---|---|---|
| `lib/advisor.mjs` | ✅ 已实施（含 hotfix） | 组配置解析与路由（3.1/3.2）；effort 透传（3.3）；超时硬生效 + 消息增强（3.4）；默认值常量；F8 判定启发式 v3（3.8）；legacy 环 N4 警告补全（分歧审计 D3） |
| `lib/advisor-msgs.mjs` | ✅ 已实施 | 记忆开关（3.5） |
| `lib/state.mjs` | ✅ 已实施 | `advisorOverride` 字段 + `mergeAdvisorGroup` helper（3.6；eng_coder 一期交付写入，其报告"未改动"的陈述不实——git 确认 M） |
| `lib/index.mjs` | ✅ 已实施 | 注册 `advisor_config` 工具（3.6） |
| `lib/eng.mjs` | ✅ 已实施（含 hotfix） | F9：spawn `agentOptions` 显式 `maxTokens` + `reasoningEffort`（枚举校验 N4）+ toolFilter deny `ask_user_question` + 任务书禁破坏性 git（3.10） |
| `cordis.patch.yml` | ✅ 已实施 | 示例配置更新为分组结构 + engCoderMaxTokens/engCoderEffort 注释（F9） |
| `README.md` | ✅ 已实施 | 配置章节更新（分组、effort、记忆开关、advisor_config、engCoderMaxTokens/engCoderEffort）+ 迁移说明 |
| `docs/README.md` | ✅ 已完成 | 文档地图登记（docs/README.md:9 已登记本设计） |
| `METHODOLOGY.md` | ✅ 已完成 | 已建（工程工作流，含 F8 偏离记录与交付记录） |
| `test/advisor-config.test.mjs` | ✅ 已实施 | 单元测试 20 用例（T1–T13/T16/T18–T21），node --test 全绿（~6.5s） |
| `package.json` | ✅ 已实施 | 增加 `"test": "node --test"`（v24 下 `node --test test/` 目录形式报 MODULE_NOT_FOUND，采用等价超集形式，分歧审计 D2） |

> 状态注（2026-09-02 一期交付后）：全部 ✅ 已实施并经分歧审计（功能面 clean）+ node --test 20/20 回归；F8 判定为 v3（severity 单元格锚定）；`mergeAdvisorGroup` 为 dead export（合并逻辑内联于 advisor.mjs，D4 观察——二期扩展时注意双实现漂移，可择机收敛）。交付 code review 三轮收敛（round 1 无 🔴 通过 → round 2 修 iterator 作用域等 → round 3 全 Fixed）；唯一 Deferred：`describeGroup` 不展示 route warnings（🔵，影响有限，get 已 dump 原始配置）。

### 3.8 评审通过判定修复（F8，hotfix 先行）

- **问题**：`advisor.mjs` 的 `isApprovalVerdict` 旧规则 `/\|[^|]*🔴/` 把**任何含 🔴 的表格行**都视为未解决；收敛轮验证表列结构为 `| # | Orig# | File | Severity | Status | Notes |`，Severity 列保留原级别 🔴、Status 列已标 Fixed——导致复审「结论：通过」+ 批准码回显仍被拒签（2026-09-01 实测）。
- **新规则**：逐行检查——行含 🔴 **且行内无修复标记**（`fixed|resolved|addressed|done|corrected|已修复|已解决|已验证|核销`，大小写不敏感）才视为未解决；无未解决 🔴 且结论词非否定语境 → 通过。保守方向不变：拿不准（例如行内出现 🔴 又无任何核销标记）就不签发。
- **实施状态**：已作为 hotfix 直接修改 `lib/advisor.mjs`（用户批准，2026-09-01），并随本期交付一并回归（T16）。
- **v3 修订（2026-09-02 复审后）**：判定只检查 markdown 表格行的 **severity 单元格**（单元格精确等于 `🔴`，允许 `**🔴**` 加粗包裹，`RED_SEVERITY_CELL_RE`）且行内无修复标记——描述/Notes 文本中的 🔴 字样不再参与判定。踩坑记录：v0 任何含 🔴 行 → 收敛轮 Fixed 表误拒；v1 行含 🔴 无修复标记 → "no 🔴" 总结句误拒；v2 只表格行 → 描述引用 "🔴" 字样误拒（2026-09-02 实测）；v3 锚定 severity 单元格，自测 12 用例全绿。
- 本文档中 `advisor.mjs:206-213` 等行号为**取证时快照**，实施以当前文件为准。

### 3.9 不做的（YAGNI 边界）

- 不按 code/design 类型分四组（用户已选轮次分层）；
- 不做收敛组失败自动 fallback 到 round1 组（保持简单：失败重试同组，消息提示可换模型）；
- 一期不做全局配置的 UI 写入（全局仍编辑 `cordis.patch.yml`；二期设置页统一）；
- 不改 consult/escalate 机制本身（仅二期 UI 展示其池）；
- 一期不做「未知 provider/model」注册表检测（插件无 provider 清单访问点；N4 该子句检测随二期 UI 的 provider 下拉一并实现，实现时对照 `settings.yaml` 的 `llm-pi-ai.providers`）。

### 3.10 eng_coder 子代理资源与确认策略（F9）

**max-tokens（输出预算）**：`eng.mjs` 的 `runEngCoder` spawn 时 `agentOptions` 显式携带 `maxTokens` 与 `reasoningEffort`：
- `maxTokens` 取值优先级：`config.engCoderMaxTokens`（新配置项，可选）> 父代理 `agent.options.maxTokens`（继承）> 默认常量 `65536`。
- `reasoningEffort`：固定 `"low"`（可配置 `config.engCoderEffort`，缺省 low）——实现任务是机械执行（读 spec → 写文件 → 跑测试），低推理档把输出预算留给正文；**高推理档的 reasoning 输出计入 token 预算，会把 text 掐断**（2026-09-02 实测：子代理输出仅数十字即 `max-tokens`——glm-5.3 在默认推理档下思考输出吞噬预算；`resolveChildAgentOptions` 不继承父级 effort，必须显式传）。取值枚举 `off|low|medium|high|max`；非法值忽略并警告（N4），回落 `"low"`。
- 背景：DSH `resolveChildAgentOptions` 只在父级已配置时才继承 `maxTokens`（`dsh-subagent/lib/types/child-agent.js:51-62`），且不继承 `reasoningEffort`；当前主会话两者均未配置 → 子代理落适配器默认 → 大任务（读设计文档 + 写多个文件）输出撞 `max-tokens` stopReason（2026-09-02 实测两次）。

**子代理禁止交互确认**：`toolFilter.deny` 增加 `ask_user_question`（及任何向用户发起同步确认的工具）：
- eng_coder 是受 design token 保护的实现者，任务书自足；需要用户决策时写入交付报告的「需主会话确认的决策清单」，由主会话用 `ask_user_question` 转达。
- 背景取证：threat-intel 会话 bc8eca07（2026-09-02）rebase 序列（`ask_user_question` 合并策略/冲突解析 + `git rebase --onto`/`--continue` 工具执行）无 `approval/asked` 审计——弹窗来自 `ask_user_question` 类确认通道；确认 UI 按 agent 路由（子代理发起时主会话无感）且无超时 → `run.result` 永不落定。

**破坏性 git 命令**：toolFilter deny 之外，任务书模板（`buildCoderBrief`）增加固定条款：
`Do NOT run destructive git commands (rebase / reset --hard / clean -f / push --force) — the parent session owns git history operations.`
（实现者只改工作区文件；历史改写归主会话/用户。）

**DSH 层改进（超插件范围，记录为外部依赖，本插件不实现）**：
1. delegation depth>0 的 agent 发起 `ask_user_question`/确认请求 → 自动拒绝，或冒泡到父会话 UI；
2. 所有确认请求加超时（建议 60s 自动拒绝）；
3. 确认弹窗在子代理/非当前会话上下文时于用户当前界面可见提示。
- F9 的 toolFilter 修复不依赖上述改进即可在本插件内消除死等触发面。

---

## 4. 设计 — 二期（DSH 设置页 UI）

> 二期为一期验证后的后续交付；此处记录**已与用户确认的 UI/交互决策**，未决项标注 [OPEN]。

### 4.1 形态与入口

- 注册 DSH 设置面板页：`settings.section` slot（id `thincoder`，order 适中，label「Thincoder」），跟随现有设置 UX（`dsh-client-ui-settings` 契约）。
- 数据面：新增 host 配置 API（`lib/config-api.mjs`）：
  - `GET /api/thincoder/config` → `{ global, sessionOverride, effective, providers }`（providers 来自 `settings.yaml` 的 `llm-pi-ai.providers`，供下拉）；
  - `PUT /api/thincoder/config/global`（写全局默认，持久化到 DSH settings）；
  - `PUT /api/thincoder/config/session`（写当前会话覆盖）/ `DELETE`（恢复默认）。
- client bundle：`package.json` 增加 `dsh.client`（inject: `dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-client-ui-settings` / `dsh-client-ui-primitives`，platform web），构建走 tsdown（参考 `dsh-better-sidebar` 结构）。

### 4.2 表单与交互（已确认）

- 分组卡片：**round1 组**、**收敛轮组**，每组字段：provider（下拉，数据源 providers）、model（下拉，按 provider 过滤）、effort（下拉 off/low/medium/high/max）、timeoutMs（数字输入 1000~3600000）；
- **记忆开关**：`includeProjectGuide` switch（副文案：评审默认不加载项目记忆，需显式传 documents）；
- **consult/escalate 模型池**：可增删列表（provider/model/effort 行）；
- 按钮：**保存全局默认**（写全局，含校验提示）、**应用到当前会话**（写 sessionOverride）、**恢复会话默认**（删除 sessionOverride）；
- 校验：provider/model 必须存在于 `llm-pi-ai.providers`；非法值表单内联报错，不提交（N4 延续）；
- 页面顶部显示当前会话**生效配置**摘要（来源标注：会话覆盖 / 全局 / 主代理路由）。

### 4.3 二期受影响文件（预估）

`package.json`（dsh.client + 构建脚本）、`client/`（新：`settings-page.tsx`、`api.ts`、入口）、`lib/config-api.mjs`（新）、`cordis.patch.yml`（说明）、`README.md`、`test/`。

### 4.4 二期 [OPEN] 项

- 全局默认的持久化目标：DSH settings（`settings.yaml` 域）还是插件自身配置文件？——倾向 DSH settings（设置域原生支持 UI 读写）；**二期设计评审前定案写入**。
- provider 下拉的数据源权限：是否允许非 `llm-pi-ai` provider（如 minimax-cn）？——默认全部列出。
- 是否需要「测试一次评审」按钮（调 advisor 冒烟）？——默认不做（YAGNI），[OPEN] 待用户定。

---

## 5. 测试策略与验收标准

### 5.1 测试策略

- 一期新增 `test/advisor-config.test.mjs`（node:test，零依赖；stub `ctx.llm.stream` 为 async generator 收集 opts/消息，支持注入「静默流」「稳定涓流」两种 chunk 时序以验证 T6/T7）。**T6/T7 等时序用例注入小 timeoutMs（如 200ms）与短 stall 值**，保证 `node --test` 秒级完成，不用生产示例值（300s/900s）；**stall 注入缝 = `collectStream` 内部选项参数 `stallMsOverride`**（§3.4，非用户配置）。
- 冒烟测试：用分层配置真实跑一轮 design review（小文档），验证 round1 用旗舰、收敛轮用快档；**按轮断言**（与 T14 一致）：round1 耗时 < round1.timeoutMs、各收敛轮耗时 < convergence.timeoutMs——多轮总耗时允许 round1.timeoutMs + N×convergence.timeoutMs（无整体评审预算，见 §3.4）。
- 回归：现有工具（eng/eng_coder/escalate/consult）冒烟调用不破坏。

### 5.2 验收标准（T1–T21）

| # | 验收标准 | 验证方式 |
|---|---|---|
| T1 | 旧配置（仅 `advisor.provider/model/timeoutMs`）自动映射 round1，路由与超时生效 | 单元测试 |
| T2 | `advisorRound` 缺失视为 0 → round1 组；=0 → round1；>=1 → convergence 组 | 单元测试 |
| T3 | 组配置 `effort` 合法时 `llm.stream` opts 含 `reasoningEffort`；非法值忽略并警告 | 单元测试（stub 收集 opts） |
| T4 | `includeProjectGuide=false`（默认）user message 不含 `## Project Guide` 段；`true` 时含 | 单元测试 |
| T5 | 会话覆盖字段级合并与优先级正确（按 §3.2 解析链：override > 组字段 > legacy > agent options） | 单元测试 |
| T6 | 静默流两断言：① 注入小 timeoutMs（200ms）→ **绝对截止优先**，约 200ms 返回 timeout（增强消息格式，见 T8）；② 大 timeoutMs + 短 stall 注入（stallMsOverride）→ idle 看门狗中止 → STREAM_ATTEMPTS 重试耗尽 → provider_stall 诊断；两类结束时间均 ≤ min(STREAM_ATTEMPTS×窗口, timeoutMs) + ε | 单元测试（stub 静默流） |
| T7 | 稳定涓流（chunk 间隔 < 看门狗窗口）→ 绝对截止在 timeoutMs 时刻中止，整体耗时 ≤ timeoutMs + 5s（注入 200ms 小预算下实测） | 单元测试（stub 涓流） |
| T8 | timeout 消息（绝对截止触发）包含已完成轮次与已读文件数；stall 错误保持 provider_stall 诊断（不含） | 单元测试 |
| T9 | `advisor_config` get/set/reset 正常路径正确读写会话覆盖并显示生效配置 | 单元测试（同 test/advisor-config.test.mjs，stub 工具上下文执行 advisor_config 逻辑） |
| T10 | `advisor_config` set 非法 path/值类型/越界 → 错误文本且 `advisorOverride` 不变 | 单元测试（同 test/advisor-config.test.mjs，stub 工具上下文） |
| T11 | fallback 链每环：convergence 组缺失 → agent route；全链缺失 → 「no LLM route available」 | 单元测试 |
| T12 | legacy `advisor.*` 与 `round1` 共存：round1 字段优先于 legacy 对应字段 | 单元测试 |
| T13 | 非法 timeoutMs（非数/≤0/超上限）忽略并警告，不崩溃 | 单元测试 |
| T14 | 真实设计评审冒烟（**成功完成轮**）：round1 用旗舰、收敛轮用快档；round1 耗时 < round1.timeoutMs、**收敛轮耗时 < convergence.timeoutMs**（300s 为待校准值；超时轮按 T7 保证 ≤ timeoutMs + 5s） | 手动/冒烟（用户在场） |
| T15 | eng/eng_coder/escalate/consult 工具冒烟不回归 | 手动冒烟 |
| T16 | severity 单元格 = 🔴（允许加粗）且行内无修复标记 → 不签发；severity 非 🔴（含描述文本引用 🔴 字样）或 🔴 行带 Fixed/已修复 → 判定通过并签发 | 单元测试（isApprovalVerdict，v3 语义） |
| T17 | 质量冒烟：已知含 🔴 缺口的文档集 + `includeProjectGuide=false` 跑一次评审 → 🔴 仍被找到（记忆开关不削弱关键发现能力） | 手动/冒烟 |
| T18 | eng_coder spawn 的 `agentOptions` 含 `maxTokens`（≥ engCoderMaxTokens 配置或默认 65536）与 `reasoningEffort: "low"`（或 engCoderEffort 配置值），且 `toolFilter.deny` 含 `ask_user_question` | 单元测试（stub subagents.start 收集 options） |
| T19 | eng_coder 任务书（buildCoderBrief 输出）含「禁止破坏性 git 命令」条款 | 单元测试 |
| T20 | 组环合并后 provider/model 缺失其一 → 整对下探下一环且 N4 警告触发（§3.2 工作示例第 3 行场景） | 单元测试 |
| T21 | effort 解析环 ≠ provider/model 解析环 → N4 跨环警告输出（§3.3） | 单元测试 |

二期验收（**P 系列，P1+，与一期 T 系列不冲突**）：P1 设置页渲染；P2 全局默认读写生效；P3 会话覆盖读写生效；P4 校验拦截（非法 provider/越界值内联报错）；P5 恢复会话默认——随二期实施细化。

---

## 6. 风险与回滚

- **effort 语义因 provider 而异**：`reasoningEffort` 在 qax 网关上的实际效果需冒烟确认；无效时回落「不传」并提示（N4）。
- **收敛轮模型质量与预算**：快档模型评审输出可能略浅——由收敛协议（只核销上轮清单）+ 响应表对账兜底；`convergence.timeoutMs` 示例 300s 低于实测全量评审 399~436s，属**待冒烟校准值**（T14 断言），收敛轮实际不满足时先校准配置，再考虑改回旗舰（纯配置）。
- **一期改动范围**：仅插件仓库；部署配置由用户按迁移说明更新（N5），失败可 git 回退 + undo 快照（N6）。
- **确认死等的 DSH 层根治依赖外部**：子代理确认自动拒绝/超时/弹窗冒泡是 DSH 改进（超插件范围，§3.10）；F9 的 toolFilter 修复在本插件内消除触发面，DSH 层改进作为后续建议跟踪。

---

## 7. 实施确认项（评审 🔵 遗留，实施时逐一核对）

1. `sessionState.advisorRound` 的读取点与缺失语义（§3.2 已定义缺失视为 0）——实施时确认 `runAdvisorReview` 读取路径；
2. `reasoningEffort` 字段名——对照 `dsh-llm` GenerateOptions 类型定义核对；名称不同则以代码注释记录并回落「不传」（N4）；
3. 设计文档中 `advisor.mjs:206-213`、`advisor.mjs:157-194` 等行号为**取证时快照**——实施前对照当前文件实际行号；
4. §3.4 绝对截止的 abort 机制——复用 `collectStream` 现有看门狗的 AbortSignal 通道（combined signal），实施时确认 `llm.stream` 接受 signal 并即刻终止；
5. README.md 迁移说明与 docs/README.md 登记（设计文档 §3.7 声称已写入/已验证）——实施交付时复核两者实际状态；
6. §3.10 `toolFilter.deny` 语义——核对 DSH subagent toolFilter 是否原生支持 deny 列表；若仅支持 allowlist，改为「默认 allow + 显式排除」或任务书条款兜底（git 禁令与禁提问条款已写入 buildCoderBrief，可独立兜底）。
