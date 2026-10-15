# 设计：codex app-server 通道（新 runner kind）—— 批 33 · 设计档

- 日期：2026-10-14
- 需求档：[`2026-10-14-codex-app-server-requirements.md`](./2026-10-14-codex-app-server-requirements.md)
- 状态：**待用户发起设计评审**（工程模式：设计评审由用户发起，本档写完即停）

<!-- doc-shape
count-marks: 项|处|条|档|值|步|腿
-->

## §1 背景

**本批之前**，插件的 codex 用法只有一条通道：`lib/codex-adapter.mjs` 直接 spawn `codex exec --json …`（历史口径——本批新增第二条通道后该句不再成立，故加时限）（B6/B7：无 shell、任务文本走 stdin）。2026-10-12 起本机该通道在**需要执行命令**的任务上必挂；2026-10-13 定位到两处 CLI 侧原因（联网子系统 + Windows 执行助手 `[windows] sandbox = "elevated"`），2026-10-14 复测仍挂（详见 §2）。用户裁定走 **B 路线**：改用平台自带的 codex provider。

## §2 问题（现象 + 根因，带证据）

| # | 读数 | 说明 |
|---|---|---|
| E1 | `codex exec` + 工具任务：`exec_command failed: CreateProcess { message: "Rejected(\"Failed to create unified exec process: helper_unknown_error: setup refresh had errors\")" }` | Windows 执行助手起不来（与 `~/.codex/config.toml` 的 `[windows] sandbox = "elevated"` 吻合；**本轮按用户要求不动该配置**） |
| E2 | 同通道 stderr 反复 `codex_models_manager: failed to refresh available models: request timed out` + `rmcp: http/request failed … chatgpt.com/backend-api/ps/mcp` | 联网子系统降级；加本机代理（7897）后**能跑完一轮**（123s, code=OK）但工具仍失败 ⇒ 网络半通、助手仍断 |
| E3 | `codex app-server --stdio` 冒烟（2026-10-14）：`initialize` 返回 `{"id":1,"result":{"userAgent":"dsh-smoke/0.162.1 (Windows 10.0.26200; x86_64)…","codexHome":"C:\\Users\\<user>\\.codex"}}`，进程存活 15s，另有服务端通知 `remoteControl/status/changed` | **平台那条传输面（app-server）在本机可用** |
| E4 | 本机已装配 `@deepseek-ai/dsh-subagent-codex@0.0.1-rc.1`（profile `package.json` L9 声明 + `cordis.patch.yml` L12 insert 行；注释指向 `.agent-presets/thincoder-eng/agent.cordis.yml` 的 `tool-subagent-codex`） | 提供方注册名 = **`codex`** |

**根因一句话**：不是插件适配器的缺陷，是 `codex exec` 子进程通道在本机**执行面**不可用；而平台提供的 app-server 通道**可用**，且它本来就是「无人值守委托」的形态。

## §3 目标 / 非目标

**目标**：新增可选通道 `runner.kind = "codex-app-server"`，用于 **consult 与 advisor 的 codex 行**；失败可诊断；配置面可辨、可回退（US-1…US-6）。

**非目标**（本批不做，逐条给理由）：
1. **不覆盖 eng_coder / escalate**：它们要写工作区，而该通道无人值守时对审批**一律拒绝/cancel**（README 逐字）⇒ 放进去等于必然失败。
2. **不做行级 `model` / `effort` 透传**：平台 provider 只接受**文本块序列**（不声明 `agentOptions` 能力；多传会被平台 `assertCapabilities` 拒绝）⇒ 该通道的模型由**本机 Codex 配置**（`~/.codex/config.toml`）决定；行里写了 `model`/`effort` 必须**如实告知「本通道不消费」**（US-5），不得静默忽略。
3. **不自动改道**：`codex-cli` 的名字继续表示 `codex exec`（名实相符、可并存）。
4. **不动 `~/.codex/config.toml`**（用户明确要求）。

## §4 决策与理由

| # | 决策 | 为什么 | 被否决的备选 |
|---|---|---|---|
| **D1** | **新增 runner kind** `codex-app-server`（与 `codex-cli` 并列） | 能力更窄（审批必拒）⇒ 不能悄悄顶替；显式选择可回退、可并存、失败面可归因 | ①自动改道（名实不符、回退靠改代码）；②换掉 `codex-cli` 语义（破坏既有配置与测试期望） |
| **D2** | 适用面限定 **consult + advisor** 的 codex 行 | 两者都是**只读分析**；eng/escalate 要写 ⇒ 见非目标 1 | 全覆盖：会在写任务上必然失败，且掩盖真实原因 |
| **D3** | 请求**只发** `prompt / parent / signal`（+ `label`） | 平台 provider 不声明任何可选能力；`assertCapabilities` 对 `agentOptions`/`toolFilter`/`persona`/`maxDepth` 直接拒（N-1；`dsh-subagent:3174-3195` 为能力闸、`:3120-3124` 为 label 进 descriptor） | 传 `persona` 求「像我们的子代理」：被能力闸拒（`label` 不受闸、照传） |
| **D4** | 失败面**原样上浮**平台错误（`codexErrorInfo` / stopReason 映射） | 平台已把 `contextWindowExceeded`→`max-tokens`、其余失败→`error`、本地取消→`aborted`；插件沿用既有 envelope 语义（N-2），不新增枚举（映射出处：provider 包 `README.zh.md`「启动与所有权」节 + `lib/index.js` 的 `codexErrorInfo` 判定） | 自造错误码：与既有 envelope 冲突 |
| **D5** | 池预检（D-59）对本 kind **只做「提供方是否装配」的判读**，不做 CLI 目录/档位判定 | 本通道不消费 `model`/`effort` ⇒ 既有预检的两条判据对它无意义；而「provider 是否注册」只能运行期知道 ⇒ **fail-open + 诊断** | 照搬 CLI 预检：误拦 |
| **D6** | 本批**不升**第 10 条契约锁（R-62-4 与批次解耦） | 本批新增的 `subagents.start("codex", …)` 调用点只发 `prompt/parent/signal/label` ⇒ 键集合本就 ⊆ 九键并集（D6 的**判据本身**成立）；但**机械覆盖有一处已知缺口**（批 33 实施期实测并已登记）：既有 **ps5** 锁的扫描面是 `consult.mjs`/`eng.mjs`/`escalate.mjs` 里 `ctx.subagents.start("spawn", {…})` 的**字面**调用点（含调用点计数 = 6），新腿既不在那三个文件、也不是 `"spawn"` 字面调用 ⇒ **ps5 不扫它**。故本批由 `test/codex-runner.test.mjs` 的**逐字键集合夹具腿**承担该判据（见 §8），ps5 六调用点计数**保持不动**（不破既有锁）。R-62-4 涉及 `session.requestHeader` 与九→十级联，独立成批更干净 | 混批：让本批的评审面被 R-62-4 的矩阵改动淹没 |

## §5 方案（FR-1…FR-5）

```mermaid
flowchart TD
  A["consult 行 / advisor 组<br/>runner.kind ?"] -->|codex-app-server| B["FR-2/FR-3 通道分派<br/>ctx.subagents.start(\"codex\", {prompt, parent, signal})"]
  A -->|codex-cli（不变）| C["既有 codex exec 通道"]
  B --> D{"提供方是否装配？"}
  D -->|未注册 / 能力拒| E["FR-5 失败面：原样点名<br/>（provider 名 + 平台原文）"]
  D -->|已装配| F["等到轮次终局<br/>last phase=final_answer 取正文"]
  F -->|completed| G["settle：正文入 digest / 评审"]
  F -->|error / max-tokens / aborted| E
  E --> H["US-3 可诊断：结论 + 原因 + 通道名"]
```

- **FR-1 配置面**：`normalizeRunnerValue` 接受 `codex-app-server`（字符串简写与对象两形态）；`RUNNER_VALUE_HINT` 与设置页/`advisor_config` 的白名单、`coerceValue` 报错文案同批同步（N-5）。
- **FR-2 consult 分派**：`lib/consult.mjs` 的 codex 行分支按 `runner.kind` 走两条腿；app-server 腿**只发** `prompt/parent/signal/label`，不建 `-o` 临时文件、不走 `codex exec` argv。
- **FR-3 advisor 分派**：advisor 的 codex 行（组 runner / 会话覆盖 runner）同规则；`runner.kind="codex-app-server"` 时不再要求 `codexCli.executable` 探测（那是 CLI 通道的前提）。
- **FR-4 配置告知**：行里存在 `model`/`effort` 而 kind 为 app-server ⇒ **用户可见面**（该行展示标签 / digest 行 / 设置页提示）**各给一句**「本通道不消费 model/effort，模型由本机 Codex 配置决定」——**不进外发 prompt**（那会白烧 token 且用户看不见）。
- **FR-5 失败面与证据**：把平台返回的 stopReason / `codexErrorInfo` 原文带进行级失败行；**不得**再出现「不可诊断」这类空话（对照 consult 现行缺口 R-63）。

## §6 机制伪代码（前置 / 后置）

```js
/** @pre  runner 已归一化；kind === "codex-app-server"
 *  @pre  ctx.subagents 可用（否则 fail-closed 返回具名原因）
 *  @post 只发 {prompt, parent, signal, label}——**绝不**带 agentOptions/toolFilter/persona/maxDepth/outputSchema
 *  @post 返回值 { ok, text, stopReason, errorInfo }：platform 失败原样上浮，不吞；**本通道不提供 `usage`**（provider 不回显）⇒ 行渲染不得留空占位 */
async function runCodexAppServerRow(deps, { taskText, parent, signal, label }) → { ok, text, stopReason, errorInfo }

/** @pre  row.runner.kind === "codex-app-server"
 *  @post 输出的展示标签 = "codex-app-server:<model|default>"（model 只用于**标签**，不参与请求） */
function codexAppServerRowLabel(runner, globals) → string
```

## §7 状态与 schema

- **新增配置值**：`runner.kind ∈ { "codex-cli", "codex-app-server" }`（闭集；非法值拒绝并列出合法集）。
- **无新增持久化**：不建临时文件（`-o` 那一套不进本通道）；不写新 store。
- **谁写谁读**：`normalizeRunnerValue` 写归一结果 → consult/advisor 读；设置页与 `advisor_config` 读同一白名单。

## §8 防偏离（机械验证）

| 类型 | 断言 |
|---|---|
| 行为（夹具腿） | stub `ctx.subagents.start`：kind=app-server ⇒ **收到且仅收到** `prompt/parent/signal/label`（键集合**逐字**断言，多一个键即红）；kind=codex-cli ⇒ 走旧 argv 腿（零漂移） |
| 行为 | 提供方未注册（stub 抛 `NO_PROVIDER`）⇒ 行级失败行**点名 provider 名与平台原文**，且**不**出现「不可诊断」字样 |
| 行为（负向） | **eng/escalate 行**配 `kind="codex-app-server"` ⇒ **本地具名 fail-closed 拒绝**（不派发；报「本通道只读、不可用于写任务」+ 指引改回 `codex-cli`）——对应 §9 的守卫行 |
| 负向锁 | `lib/**` 内**新调用点**的 `subagents.start` 键集合 ⊆ 九键并集（**判据口径**与 `contract-baseline` 的锁 ps5 相同，但**覆盖面已订正**：ps5 的正则只匹配**字面量** `ctx.subagents.start("spawn", {`，而本腿是**变量 provider + 动态请求** ⇒ **ps5 扫不到本腿、并不覆盖新调用点**；该判据改由**本批新档内的键集合逐字断言腿**承担——断言 app-server 腿**收到且仅收到**四键 `prompt` / `parent` / `signal` / `label`，多一键即红，见本表首行与 §4 D6） |
| 负向断言 | app-server 腿**独立成档** `lib/codex-app-server.mjs`（与 CLI 腿同档会让整档 grep 恒红）⇒ grep **只扫该档**：不得出现 `-o` / `--json` / `codexCli.executable` |
| 文档卫生（N-5/N-6 的**可 grep 谓词**） | `grep -c codex-app-server README.md` ≥ 1（配置字段清单含新 kind）· 设置页文案档含「只读」字样 ≥ 1 · 结项页矩阵行含新 kind · 全库 grep「codex 只有一条通道」⇒ **命中只允许**出现在带「本批之前」限定的历史口径句（§1 已加限定；本行是谓词定义、按惯例自带一次命中——实现该谓词时须把它排除，或用 §1 的限定句形状匹配） |

## §9 边界

| 边界 | 处置 |
|---|---|
| 平台未装配该 provider | **fail-closed**：具名原因（provider 名 + 平台原文）+ 指引（换回 `codex-cli`），不静默降级 |
| 行里写了 `model`/`effort` | 不消费，但**如实告知**（FR-4）——不静默忽略 |
| 任务需要写文件/执行命令 | 平台无人值守**一律拒绝** ⇒ 轮次失败；文档与设置页写明「只读定位」（N-6） |
| `contextWindowExceeded` | 平台映射 `max-tokens` ⇒ 插件沿用既有失败语义，带原文 |
| 取消/中止 | 平台本地取消 → `aborted` ⇒ 归因走既有 `abort-provenance` 词汇表 |
| 超时 | consult 的 `consultTimeoutMs` 与 advisor 组 `timeoutMs` **照旧生效**（经共用的 `signal` 中止）⇒ 平台把本地取消映射为 `aborted`，归因走既有词汇表 |
| eng/escalate 行被配上本 kind | **具名 fail-closed 拒绝**（与 B2/B3 同款）：「本通道只读、不可用于写任务」+ 指引改回 `codex-cli`（§8 有负向腿） |
| 空/畸形 `prompt` | 请求前本地校验（非空文本块），失败即回，不下发 |
| 平台换代 | 该通道依赖 provider 注册名 `codex`；换版时由 `contractWatch` 的版本哨兵先告警（**九锁测不到它**——见 §4 D6 与本批订正后的文档口径） |

## §10 受影响文件与验收

| 文件 | 改动 |
|---|---|
| `lib/codex-adapter.mjs` | `normalizeRunnerValue` 接受新 kind；`RUNNER_VALUE_HINT` 同步 |
| **`lib/codex-app-server.mjs`（新档）** | app-server 腿独立成档（= §8 grep 的作用域）：`runCodexAppServerRow` + 标签函数 |
| `lib/consult.mjs` | codex 行按 kind 分派两条腿 |
| `lib/advisor.mjs` | codex 行分派同规则（含 app-server 腿的墙钟与失败面归一） |
| `lib/index.mjs` | 设置页/`advisor_config` 白名单与提示同批；**eng 档位（`codexCli.engCoderRunner`）的具名拒绝**（配置面 + 工具入口两道） |
| **`lib/escalate.mjs`** | **写任务守卫**（**实施后追认**：该档原不在本清单内，实施者为落该守卫而改，经**用户裁定**认可后补入本表；守卫本体见 §9 守卫行）：escalate 行配本 kind ⇒ 本地具名 fail-closed 拒绝（该腿的「档位」= `consultModels` 的行 runner，只有 escalate 自己看得到） |
| `lib/client.js` | 设置页下拉与提示（runner 下拉增新 kind + 只读/不消费告知） |
| `test/codex-runner.test.mjs`（并入既有块） | §8 的行为腿与负向腿 |
| `docs/`（结项页矩阵行 · README 配置字段） | 通道清单同批同步；runner kind 的枚举处**加指向本设计档的前向指针** |

**验收**：US-1…US-6 各 ≥1 腿（正常 / 边界 / 错误三态）；N-1…N-6 各有机械判据；`node --test` 顶层计数按本仓惯例（新腿并入既有块 ⇒ 计数不变）。

## §11 变更记录

- 2026-10-14 初稿（工程模式：待用户发起设计评审）。
- 2026-10-14 评审轮 1（`VERDICT: FAIL`，1🔴+6🟡+4🔵）→ **11 条全按建议收口**（本档 + 需求档同批）：N-1 采纳 `+label` 并附平台 file:line · app-server 腿独立成档 · 常量名统一 · 补超时/eng 守卫两行 · N-5/N-6 落可 grep 谓词 · FR-4 改为用户可见面 · 平台断言补引用 · 禁用清单补 `outputSchema` · README 前向指针 · 返回形状注 `usage` 不可得。
- 2026-10-14 **实施期同步（批 33 落地）**：① §4 D6 与 §8 负向锁行**订正覆盖面**——ps5 的扫描面是 `"spawn"` 字面调用点（六处，计数不变），新腿不在其内，逐字键集合判据由夹具腿承担；② §10 受影响文件表**补 `lib/escalate.mjs`**（写任务守卫的落点，见 §9 守卫行）并注明 eng 守卫落在 `lib/index.mjs`；③ §12 登记三条遗留（`lib/state.mjs` 的注释枚举 · ps5 扫描面 · 两处状态行）。
- 2026-10-14 **父侧验收修复轮（F2 两处补正，均经用户裁定）**：① §10 受影响文件表内 `lib/escalate.mjs` 行补注「**实施后追认**」——该档原不在清单内，实施者为落**写任务守卫**（§9 守卫行）而改，事后经用户裁定认可补入；② §8 负向锁行**订正误述**——该行原以「判据同 ps5」表述，会被读成「**ps5 覆盖新调用点**」，**不成立**（ps5 的正则只匹配字面量 `ctx.subagents.start("spawn", {`，新腿是**变量 provider + 动态请求**）⇒ 改为由**本批新档内的键集合逐字断言腿**（四键 `prompt` / `parent` / `signal` / `label`）承担。

## §12 遗留（与批次解耦）

- **R-62-4**（升第 10 条契约锁）：已由用户裁定**升**，独立成批（见 §4 D6）；登记表与本文档不代其落终态。
- **R-63**（consult 失败取证腿取不到可读档）：本批 FR-5 覆盖其中的 app-server 腿；`codex-cli` 腿的同类缺口另登记。
- **R-33-1**（批 33 实施期登记）：`lib/state.mjs:51` 的注释仍把 runner 字符串简写枚举成「"dsh"/"codex-cli"」——新 kind 之后该枚举不完整（**注释级漂移，零行为影响**）。该档不在本批授权写域内 ⇒ 未动；建议随下一批顺手补齐或由父侧裁定。
- **R-33-2**（批 33 实施期登记）：ps5 锁的扫描面不含本腿（见 §4 D6）。若后续要求「新调用点也进机械锁」，需扩 `lib/contract-baseline.mjs` 的 `lockPs5` 文件/谓词面并同步上调调用点计数（本批**刻意不动**该锁：改它会牵动契约矩阵，属独立批次的事）。
- **R-33-3**（批 33 实施期登记）：**状态行漂移（域外未动）**——本档档头仍写「状态：**待用户发起设计评审**」、`docs/README.md` 的本档摘要行同样写「待用户发起设计评审」，而 §11 已记录评审轮 1 与收口。两处在批 33 授权写域内只有本档 ⇒ 两行**同改**才不制造新的不一致，故本批**两处都不动**，登记待父侧随下一批顺手同步（建议值：「已实施（批 33），评审沿革见 §11」）。
