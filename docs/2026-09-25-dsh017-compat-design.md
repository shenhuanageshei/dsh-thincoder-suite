# 设计：DSH 0.1.7 平台契约兼容修复（D-41 消息模型 · D-42 jobs owner · D-40 home 探测）—— 批 24

- 日期：2026-09-25
- 缺陷登记：[`2026-09-05-defect-registry.md`](./2026-09-05-defect-registry.md)（**D-40** · **D-41** · **D-42**——本批三条同源）
- 需求来源：**实况故障**（用户的另一条工作会话在官方桌面版上 advisor 全灭、token 签不出；两条路由的逐字错误见 §2）。本批是**缺陷修复**，需求层折入本档 §1 与登记表三行，不另立需求档。
- 状态：**已实施并通过全量测试**（计数见 §7）；**★ 改 `lib/**` ⇒ 重启 DSH 后生效**

<!-- doc-shape
anchors: 机验锚
acs: 验收标准
-->

## §1 背景与问题陈述

**用户故事**（本批为缺陷修复，需求层折入此处与登记表三行）：

- **US-1**：advisor 的 dsh 路由在 0.1.7 下能跑完整的工具循环（第一轮读文件、第二轮带上工具结果继续）。
- **US-2**：上下文压缩之后，送出的消息仍然满足平台的协议配对（无孤儿工具结果）。
- **US-3**：全部后台派发在 0.1.7 下能被平台接受（owner 是 id 而不是对象）。
- **US-4**：把这两处改回去，套件必须**变红**（回归锁真的锁住了契约）。
- **US-5**：新增测试档与既有被授权档按仓内登记协议同步登记（零静默扩张）。
- **US-6**：重启桌面版后，真机能跑出一次 advisor 设计评审与一次会诊。

用户在**官方桌面版**（`D:\DSH-Desktop`，内嵌 DSH `0.1.7-rc.2`；home = `C:\Users\magic\.dsh`）上反馈「这个插件目前用不了了」。
现场症状三条，**互相独立**：

1. **advisor 评审全灭**：两条路由都被「入参形状」类错误秒拒——
   - pi-ai 路由（`zai-coding-cn/glm-5.3`）：`400 {"code":"1213","message":"未正常接收到prompt参数。"}`
   - deepseek 路由（`deepseek-official/deepseek-flash`）：`DeepSeek Messages cannot represent user/tool-result content tool-result`
   - 两次 `blocks(text=0, tool-call=0)`、`usage=none` ⇒ **请求从未进入任何模型推理**。
2. **全部后台派发全灭**：`consult_start` 直接回「`jobs.start` 抛出：session "[object Object]" has no live agent (background job owner must be live)」。
3. **设置页保存失败**：无 `DSH_HOME` 的部署上 `saveUserConfig` 返回 false（设置页 500「failed to write user config」）。

**共同点（本批的立项依据）**：三条都不是上游故障、不是限流、不是模型选择、不是网络——而是**插件写的是 DSH 0.1.6 的契约，宿主升到 0.1.7 后契约变了**。
⇒ 换模型救不了、换 provider 救不了、重启也救不了（重启只修好了另一个无关的 `advisor_config set` 挂死）。

## §2 根因（逐字证据：0.1.6 vs 0.1.7 两份源码对照）

### §2.1 D-41：工具结果的消息形状换了，且旧形状的兼容被删除

**0.1.6-alpha.2** 的 `@deepseek-ai/dsh-llm` `createToolResultMessage` 逐字产出：

```js
createUserMessage({
  source: { kind: 'tool', callId: input.callId },
  content: [{ type: 'tool-result', toolCallId: input.callId, content: input.content, isError: input.isError }],
})
```

⇒ **这就是插件 `lib/advisor.mjs` 的 `toolResultMsg` 一直在发的形状**（`role:'user'` + 块内 `tool-result`）。当时它是**正典**，不是错。

**0.1.7-rc.1 / rc.2** 改成**独立 `tool` 角色消息**：

```js
createMessage({ role: 'tool', source: { kind: 'tool', callId: input.callId }, toolCallId: input.callId, content: input.content, isError: input.isError })
```

并**删除了旧形状的兼容**（两处实证）：

- `dsh-llm-pi-ai` 的 `userContent()` 去掉了 `case "tool-result"` ⇒ 落 `default: break` ⇒ **内容静默丢弃**，`textOnlyContext()` 随后推一条**空 user 消息**，而上一轮的 `tool_call` **无人应答** ⇒ 网关按入参非法拒收（1213）；
- `dsh-llm-deepseek` 的 user 分支遇到该块直接 `unsupported(\`user/tool-result content ${block.type}\`)` ⇒ 抛 `UNSUPPORTED_CONTENT`（就是用户看到的逐字文案）。

**触发时机（解释了「为什么看起来像上游故障」）**：第一轮请求只有 system + user，完全正常；模型一旦调用 `read`/`grep`，**第二轮**带上工具结果即炸。

### §2.2 D-42：`jobs.start` 的 owner 参数据型换了

- **0.1.6** 的 `dsh-jobs-local` `start(spec)` 直接把 `spec.owner` 当 owner 桶用（`servesOwner` / `activeJobCount` / `ensureOwnerCleanup` 全吃它）⇒ 传 **Agent 对象**可用；整包内**没有** `resolveOwner`、也**没有** `has no live agent` 这两个字符串。
- **0.1.7** 的 `start(spec)` 首行变成 `const owner = this.resolveOwner(spec.owner)`，而 `resolveOwner` 走 `agents.get(session)`，**注册表按 id 键**（`dsh-agent` 的 `enter()`：`const id = agent.id`，且强制 `id === agent.session.id`）⇒ 传对象必然查空并抛 `session "[object Object]" has no live agent`。
- **平台自己的写法**：`dsh-tool-subagent` 与 `dsh-tool-workflow` 一律传 `parent.id`。
- **插件落点 7 处**（全部 `owner: agent`）：`lib/advisor.mjs` ×2（advisor-codex / advisor-dsh）· `lib/consult.mjs` ×1 · `lib/eng.mjs` ×2（eng-codex / eng-dsh）· `lib/escalate.mjs` ×2（escalate-codex / escalate-dsh）。

### §2.3 D-40：home 兜底探测的特征标记被改名打断

0.1.7 起宿主把 `$DSH_HOME/settings.yaml` 改名为 `settings.yaml.imported`，而 `probeProfileRoot` 的 profile 根特征仍只认旧名 ⇒ 无 `DSH_HOME` 的部署（官方桌面版 app 插件进程）探不到 home。**已在批 23 独立提交 `30d39b1` 修复并登记**；本档只在 §1 保留其上下文（三条同源）。

## §3 方案

### §3.1 D-41 主修（消息形状）

```js
function toolResultMsg(callId, text) {
  return {
    id: uid(), role: "tool",
    toolCallId: callId,
    content: [{ type: "text", text }],
    isError: false,
    source: { kind: "tool", callId },
  }
}
```

### §3.2 D-41 连带 A（压缩的配对守卫必须跟着换判据）

`compactMessages` 原来按 `content[0].type === "tool-result"` 认工具消息、并按「起点落在工具结果上就回退」——形状一变**两条判据全部失效**，压缩后会产出**孤儿 tool 消息**（deepseek 侧抛 `tool result has no matching call`），等于把「每次必炸」变成「压到 20 条以后才炸」，更难查。改为：

```js
const isToolResultMsg = (m) => m?.role === "tool"
let start = messages.length - 20
while (start > 1 && isToolResultMsg(messages[start])) start--        // 回退：把配对的 assistant 收进窗口
while (start < messages.length && isToolResultMsg(messages[start])) start++  // 退化边界：仍落在 tool ⇒ 丢弃
```

**为什么需要第二条 while**：回到 `start === 1` 仍落在 `tool` 上，说明这些 `tool` 的**配对前驱本来就不在数组里**（畸形/伪造输入）——保留任何一条都会让窗口以孤儿开头。**丢弃**是唯一满足协议的选择。
**为什么第一条 while 足够**：消息顺序保证「`tool` 紧跟在带 `tool-call` 的 `assistant` 之后」，因此回退停下的第一个非 tool 消息就是它的配对 assistant（或更早的 user）⇒ 配对完整。

### §3.3 D-41 连带 B（consult 的主历史渲染）

`renderMainHistory` 只放行 `user`/`assistant` 两个角色。0.1.6 时工具结果是 **user 角色**、会渲染成 `[tool result]` 一行；0.1.7 变成 `tool` 角色后被**整条过滤** ⇒ 会诊看到的「主会话历史」从此丢掉工具结果标记。改为放行 `role:'tool'` 并**只渲染 `[tool result]` 标记、不展开 content**（工具输出动辄几十 KB，展开会直接撞 60KB 预算）。

### §3.4 D-42（owner 判据收成单点）

新增叶模块 `lib/job-owner.mjs`：

```js
export function ownerIdOf(agent) {
  for (const candidate of [agent?.id, agent?.session?.id]) {
    if (typeof candidate === "string" && candidate !== "") return candidate
  }
  throw new Error("[thincoder-suite] jobs.start owner 无法解析：agent 既无 id 也无 session.id"
    + "（0.1.7 起平台按 id 查找活代理，传对象必被拒收——D-42）")
}
```

4 档 7 处统一改为 `owner: ownerIdOf(agent)`。
**为什么缺 id 时响亮失败、不静默回落成对象**：对象形态在 0.1.7 下**必然**被平台拒收，静默回落会把「必定失败的派发」伪装成「派发成功」；而抛出的错误在各调用点都由既有的「jobs 缺失 / 派发失败 ⇒ 告警 + 回落同步」分支接住（批 21 FR-3 双通道）⇒ 响亮是安全的。

## §4 受影响文件

| 文件 | 改动 |
|---|---|
| `lib/job-owner.mjs` | **新增**：`ownerIdOf` 单一事实源 |
| `lib/advisor.mjs` | `toolResultMsg` 改判；`compactMessages` 守卫与取文改判 + 退化边界；import `ownerIdOf`；2 处 owner |
| `lib/consult.mjs` | `renderMainHistory` 放行 tool；import；1 处 owner |
| `lib/eng.mjs` | import；2 处 owner |
| `lib/escalate.mjs` | import；2 处 owner |
| `test/dsh017-compat.test.mjs` | **新增**：D41a/D41b/D42a/D42b 四条锁 |
| `test/truncation.test.mjs` | 夹具换形状；T13-boundary 拆成 a/b 两条腿 |
| `test/codex-runner.test.mjs` · `test/consult.test.mjs` | 5 处 owner 期望值改判（授权档） |
| `test/death-provenance.test.mjs` | `AP_TEST_AUTHORIZED` 新增 `test/truncation.test.mjs`（**修改授权**，理由在注释块） |
| `test/guard-e.test.mjs` | T-E19 登记新档 |
| `docs/test-lifecycle.md` | §二 修改授权注记 · §三 两行计数 + 新增一行 · §七 变更记录 |
| `docs/2026-09-17-scope-alignment-design.md` | 两处事实标记按绑定重绑（**新计数行落地的必撞点**，同日同次编辑） |
| `CHANGELOG.md` · `package.json` | 0.29.3 条目 + 计数行 + 版本 |
| `docs/2026-09-05-defect-registry.md` | D-41 / D-42 两行 + 状态行计数 |

## §5 决策记录

| # | 决策 | 理由 |
|---|---|---|
| D24-1 | **直接切到 0.1.7 形状，不做双形状兼容** | advisor 的 `messages` 是**进程内局部数组**（`runAdvisorToolLoop` 内构造、不落盘、不跨进程）⇒ **零历史兼容负担**；兼容旧形状只会把旧契约继续固化在夹具里（本缺陷此前满绿的原因之一正是夹具里抄了一份旧形状） |
| D24-2 | 压缩守卫**同时**加「向前跳过」的退化分支 | 只回退不跳会产出孤儿窗口——把「每次必炸」变成「压到 20 条以后才炸」，是更坏的失败形态 |
| D24-3 | `ownerIdOf` 缺 id **抛**，不回落 | 见 §3.4 |
| D24-4 | consult 渲染只留标记 | 保 60KB 预算 |
| D24-5 | 本条修复**无法**走 advisor 设计评审门（鸡生蛋：被修的正是评审通道）⇒ 以本档 + 全量测试 + 真机复测替代；通道修好后可用 `advisor type=code` 自证 | 记录流程取舍，不静默绕过 |

## §6 锚与判据对照

### §6.1 机验锚（**三要素写全：检索目标 / 谓词 / 期望**）

| 锚 | 检索目标 | 谓词 | 期望 |
|---|---|---|---|
| **A1** | `test/dsh017-compat.test.mjs` 的用例 `D-41a 行为腿` | 走**真实** `runAdvisorToolLoop` 的两轮夹具（第 1 轮产 tool-call、第 2 轮收尾；llm 桩只替网络那一层） | 工具结果消息满足 `role:'tool'` + 消息级 `toolCallId`/`isError`/`source` + `content` 直接是结果块数组；**负控**：全数组内无 `user + tool-result` 残留；**配对链**：每条 tool 的前驱是带同 id tool-call 的 assistant |
| **A2** | `lib/advisor.mjs` 与 `lib/consult.mjs` 的源码字节 | 静态扫描 | advisor 零处 `type: "tool-result"` 构造 · 恰一处 tool 角色构造点 · `keyFiles` 取文按新形状 · 旧嵌套取文清零 · consult 放行 tool 且只留标记 |
| **A3** | `test/truncation.test.mjs` 的用例 `T13-boundary-a` | 窗口起点落在 tool 上 | 回退把**配对的 assistant** 收进窗口，配对 id 一致 |
| **A4** | 同档用例 `T13-boundary-b` | 配对前驱本就不在数组里 | 孤儿 tool **整体丢弃**（保留段零 tool 消息） |
| **A5** | `lib/job-owner.mjs` 的 `ownerIdOf` | 三态入参 | `agent.id` 优先 · 缺 `agent.id` 回落 `session.id` · 空串不算 · 两者皆缺**抛**（不回落成对象） |
| **A6** | `lib/advisor.mjs` · `lib/consult.mjs` · `lib/eng.mjs` · `lib/escalate.mjs` | 静态扫描 | 4 档的 `jobs.start({` 与 `owner: ownerIdOf(agent)` **一一对应**（登记值 7）· 零处 `owner: agent` 直传 · 4 档都从 job-owner 叶模块取 |
| **A7** | `test/guard-e.test.mjs` 的 T-E19 清单 + `test/test-lifecycle.test.mjs` 的台账一致闸 | 档集合双射 | 新档已登记 · 台账 §三 计数等于 fs 实测（新档 4 · truncation 5） |
| **A8** | `test/death-provenance.test.mjs` 的 `AP_TEST_AUTHORIZED` | 授权面字面 | 含 `test/truncation.test.mjs`（D-41 换契约 ⇒ 既有期望值必须翻转） |

### §6.2 验收标准

| # | 验收标准 | 层 | 锚 | US |
|---|---|---|---|---|
| **AC-1** | 工具结果消息满足 0.1.7 的 tool 角色契约；无旧形状残留；工具调用与工具结果配对完整 | T1 | A1 | US-1 |
| **AC-2** | `lib/` 内不再构造旧形状，且压缩取文与 consult 渲染同批对齐新形状 | T1 | A2 | US-1 |
| **AC-3** | 压缩窗口起点落在 tool 上时，回退把配对的 assistant 收进来（不丢弃） | T1 | A3 | US-2 |
| **AC-4** | 配对前驱本就不在数组里时，孤儿 tool 被整体丢弃（绝不产出孤儿窗口） | T1 | A4 | US-2 |
| **AC-5** | `ownerIdOf` 三态正确，且缺 id 时**响亮失败**而非静默回落成对象 | T1 | A5 | US-3 |
| **AC-6** | 4 档 7 处派发点全部走 `ownerIdOf(agent)`，零处直传 Agent 对象 | T1 | A6 | US-3 |
| **AC-7** | 变异自证：把 `toolResultMsg` 退回旧形状 ⇒ A1 红；把一处 owner 退回 `owner: agent` ⇒ A6 红 | T1 | A1 · A6 | US-4 |
| **AC-8** | 登记级联：新档进 T-E19 清单与台账 §三 · truncation 计数 4 → 5 · 授权面新增该档 · README 登记 · 登记表 D-41/D-42 · CHANGELOG 与版本号 | T2 | A7 · A8 | US-5 |
| **AC-9** | 重启桌面版后，真机跑出一次 advisor 设计评审与一次会诊（由用户重启；主会话重启桌面版会杀掉自己） | T3 | — | US-6 |
## §7 验证记录（实施时点实测）

| 项 | 结果 |
|---|---|
| 全量 `node --test` | **522/522 绿**（基线 516 + 本批 6：D-40 的 config-api +1 · 新档 +4 · truncation 2 → 3） |
| `node --check` | 5 个被改 `lib` 档全过 |
| 变异自证（律 3） | 把 `toolResultMsg` 退回旧形状 ⇒ **D41a 必红**；把一处 `owner: ownerIdOf(agent)` 退回 `owner: agent` ⇒ **D42b 必红**（两条都实测，见交付报告） |
| 真机复测 | 桌面版重启后对已合并的 spec 跑一次 design 评审 + 一次 `consult_start`——**重启由用户执行**（主会话重启桌面版会杀掉自己） |

## §8 边界（本批不做）

- **不改 DSH 本体**：这是平台有意的消息模型/契约演进，插件侧适配即可。
- **不做双形状兼容**（见 D24-1）。
- **不碰** codex 路由预算、token 生命周期、D-39 信任栅栏、D-40 的 home 探测（后者已在批 23 独立提交）。
- **不做全平台触点系统扫**（本批只修已实测的两处 + 已修的 D-40）；建议单列一批，把插件所有平台触点对着 0.1.6 / 0.1.7 两份 dsh 包做一次 diff——已知 0.1.7 断裂恰为三处，第四处迟早会来。

## §9 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 首版：D-41 / D-42 根因（两份平台源码逐字对照）· 方案 · 受影响文件 · 决策 D24-1…D24-5 · 验收锚 D41a/D41b/D42a/D42b + T13-boundary-a/b · 实施实测（522/522）。批 23（D-40）同版发布。 |
