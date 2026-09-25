# 会诊纪要 —— consult #6（原始层，机制落盘）

- 日期：2026-09-25
- 会诊 id：6
- 模型：zai-coding-cn:glm-5.3
- 平台 job：consult-1
- 结果：1/1 交付（其中 1 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #6 finished — 1 of 1 replied (0 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #6 finished — 1 of 1 replied (0 failed)]
effective: 1 of 1 (0 failed · 0 without content)
models: zai-coding-cn:glm-5.3
job: consult-1
minutes: docs/consult-minutes/2026-09-25-consult-6-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] zai-coding-cn:glm-5.3 — ok
```schemaJson
{
  "componentName": "Page",
  "state": {},
  "methods": {},
  "children": [
    {
      "componentName": "TinyCard",
      "props": { "title": "批 24 双补丁评审结论（D-41 消息形状 · D-42 jobs owner · 提交 5100367）——两处根因判定成立，补丁完整，无返工缺口" },
      "children": [
        {
          "componentName": "Text",
          "props": { "style": "font-size:13px;line-height:1.9;display:block;margin-bottom:12px;", "text": "评审方法：不是只读设计档——直接逐字核对了两份平台源码（0.1.6-alpha.2 备份树 D:/DSH-Portable/.nm-broken-20260923-102653 与桌面版 0.1.7-rc.2 树各 5 个包）、实跑 9/9 锁测试（node --test dsh017-compat + truncation 全绿）、并对 compactMessages 另跑 1025 个对抗用例 + 1 组负控。以下逐条只给有据判断。" }
        },
        { "componentName": "h3", "props": {}, "children": "1. 两处根因判定：均成立，可排除他因" },
        {
          "componentName": "TinyGrid",
          "props": {
            "columns": [
              { "title": "根因", "field": "k", "width": 90 },
              { "title": "两版源码逐字证据", "field": "v" }
            ],
            "data": [
              { "k": "D-41", "v": "0.1.6 dsh-llm createToolResultMessage 确为 createUserMessage + content:[{type:tool-result, toolCallId, content, isError}]（备份树 L94-107 逐字吻合）；0.1.7 改 role:tool 消息级 toolCallId/isError（L101-112）。pi-ai 0.1.6 userContent 有 case tool-result（L1206）⇒ 0.1.7 全文零处 tool-result、default:break 静默丢弃 ⇒ 空 user + 无人应答的 tool_call ⇒ 上游 400 code 1213，与现场逐字一致。deepseek 0.1.6 L2261 显式转换 user 内 tool-result 块 ⇒ 0.1.7 L1581 只放行 text/image、其余 unsupported(user/tool-result content …)，报错文案与现场逐字一致。" },
              { "k": "D-42", "v": "0.1.6 dsh-jobs-local start(spec) 直接以 spec.owner 为桶（L131-137），全包无 resolveOwner、无 has no live agent 字符串（已验证不存在）；0.1.7 首行 resolveOwner→agents.get(id)（L412-413、L527-533）。注册表两版都按 id 键（enter() 两版逐字相同、均强制 id===session.id）——变的是消费方：0.1.6 的 ensureOwnerCleanup 要求传对象本体（agents.get(owner.id)===owner），0.1.7 要求传 id，契约反转。平台自家 dsh-tool-subagent 同版本同步把 owner: parent 改 parent.id（L541，同款修复）。现场 session [object Object] 与抛错模板逐字吻合。" },
              { "k": "排除他因", "v": "第一轮（仅 system+user）能成功产出 tool-call（失败行的 blocks(text=0,tool-call=0) 是第二轮请求被拒后的观测）⇒ 密钥/网络/模型均无辜；两条路由报错形态不同（静默丢弃 vs 显式 unsupported）但根同一处，正是「换模型/换 provider 均无效」的解释。判定：非别的原因。" }
            ]
          }
        },
        { "componentName": "h3", "props": {}, "children": "2. 目标形状逐字正确；同族消费点排查完毕，无漏改" },
        {
          "componentName": "TinyGrid",
          "props": {
            "columns": [
              { "title": "检查项", "field": "k", "width": 170 },
              { "title": "结论", "field": "v" }
            ],
            "data": [
              { "k": "字段层级对照", "v": "平台 0.1.7 产出 = { role:tool, source:{kind:tool,callId}, toolCallId, content:结果块数组, isError }；插件 toolResultMsg 逐字段同构。消费侧实证：deepseek L1661-1666 直接读消息级 toolCallId/isError、input() 映射 text 块；pi-ai toolResultOf L1163-1174 读 toolCallId/isError、flattenText 取 text 块（插件 content=[{type:text,text}] 两边都吃）。brand id 非适配器要求，自产 id 无碍。" },
              { "k": "pi-ai toolName 依赖", "v": "toolResultOf 用 toolNames.get(toolCallId) 回落 unknown——名字表由历史中 assistant 的 tool-call 块填充；插件先 push assistantMsg（含 tool-call 块）再 push toolResultMsg，配对前驱在数组内 ⇒ 不触发 unknown。闭环成立。" },
              { "k": "compactMessages 取文", "v": "keyFiles 读 content[0].text（新形状）；全 lib/ 仅剩这一处嵌套取文且已是新形状，旧嵌套取文（content[0].content[0].text）清零（grep 实证）。" },
              { "k": "consult renderMainHistory", "v": "放行 role:tool 且只留 [tool result] 标记（L557-561），正确。consult.mjs L543 messageText 的 case tool-result 成为防御性死代码（0.1.7 宿主不再产 user+tool-result 块）——无害残留，可留可删，不构成缺陷。" },
              { "k": "assistant 侧", "v": "tool-call 块（type/id/name/arguments）两版形状一致，第一轮解析本来就工作；无需改动，也未改。" }
            ]
          }
        },
        { "componentName": "h3", "props": {}, "children": "3. 两条守卫充分性：证明 + 1025 例实测 + 负控，结论为充分" },
        {
          "componentName": "Text",
          "props": { "style": "font-size:13px;line-height:1.9;display:block;margin-bottom:8px;", "text": "无条件部分（不依赖输入）：双循环结束后 messages[start] 必为非 tool 或 start===数组尾 ⇒ recent 头永不为 tool；产出的新数组 = [first, summary(user), ...recent]，而 first 的生产不变量已核实（runAdvisorToolLoop 初始化 const messages = [userMsg(firstUserText)]，compactMessages 全库唯一生产调用点 L1517）⇒ 窗口头永远不是 tool。配对完整性（条件于生产者不变量：tool 紧跟其 assistant 或同 assistant 的兄弟 tool——唯一写点 L1652-1672 按此构造）：若某保留 tool 的配对 assistant 被前缀切走，则 assistant+1..i 必全为 tool，会使 messages[start] 为 tool，与头非 tool 矛盾 ⇒ 配对必在窗内。压缩只做前缀切割，不可能制造窗中孤儿。" }
        },
        {
          "componentName": "TinyGrid",
          "props": {
            "columns": [
              { "title": "验证", "field": "k", "width": 170 },
              { "title": "结果", "field": "v" }
            ],
            "data": [
              { "k": "锁测试", "v": "D-41a/D-41b/D-42a/D-42b + T13/T13-boundary-a/b + T17/F12-32K 共 9/9 绿（本轮实跑）。" },
              { "k": "对抗用例（本次新增）", "v": "1025 例全过：合法历史（21..60 条 × 25 种随机种子，1-2 个 tool-call/assistant 混排）、孤儿头部（messages[1..k] 全为配对不在数组的幽灵 tool，k=1..8）、全 tool 退化（结果仅剩 [first, summary]，窗口零 tool）。断言：窗口头非 tool 且每条保留 tool 的配对 assistant 在窗内。" },
              { "k": "负控（第二循环必要性）", "v": "删掉向前跳过循环、构造 len=41 且窗口起点落进幽灵 tool 区（1..25）：旧守卫实测产出以 tool 开头的孤儿窗口；现守卫丢弃全部 25 条幽灵、头部为 user。第二循环必要且充分。" },
              { "k": "残余（理论）", "v": "窗中畸形序列（如 asst(X) 后接 asst(Y) 再 tool(X)）不被修复——但生产者单一写点构造期即配对、不可能产出；且 deepseek 连续 wire-user 合并使 tool 结果与后随 user 文本同帧也不破坏 pending 检查。非缺陷。" }
            ]
          }
        },
        { "componentName": "h3", "props": {}, "children": "4. ownerIdOf 缺 id 时抛（不回落成对象）：取舍正确" },
        {
          "componentName": "Text",
          "props": { "style": "font-size:13px;line-height:1.9;display:block;", "text": "0.1.7 resolveOwner 对任何查不到的键必抛——对象形态 100% 被拒，静默回落等于把「必失败」伪装成「已派发」，正是 D-42 原故障的隐形变体。安全性实证：全部 7 处调用点都被既有 try/catch 接住且行为正确——advisor/eng/escalate 走告警 + 回落同步（批 21 FR-3 双通道），consult 走响亮报错 + 台账 disposed 行（子代理在 run() 内才起、preflight 在 run() 前 ⇒ 零部分派发，L882-927 已核对 ownerIdOf 在 try 块内）。抛出点与其它 jobs.start 失败同面同处理，响亮即安全。id 优先、session.id 兜底亦与平台 id===session.id 强制一致。" }
        },
        { "componentName": "h3", "props": {}, "children": "5. 第三处断裂：已审计触点内未发现新的；第三处就是 D-40（已修）" },
        {
          "componentName": "TinyGrid",
          "props": {
            "columns": [
              { "title": "触点（逐项两版 diff）", "field": "k", "width": 200 },
              { "title": "结论", "field": "v" }
            ],
            "data": [
              { "k": "settings.yaml 改名", "v": "即第三处断裂 = D-40（批 23 已修）；home 目录实测存在 settings.yaml.imported，与设计档描述一致。" },
              { "k": "ctx.subagents.start(spawn)", "v": "dsh-tool-subagent 两版 lib 仅 L541 一处差异（owner: parent → parent.id，其自身的 D-42 同款修复）；dsh-subagent 服务 start(name, request) 签名与 spawn provider 两版相同。请求形状（prompt/toolFilter）未变。" },
              { "k": "llm.stream GenerateOptions", "v": "provider/model/system/messages/tools/signal/sessionId/purpose/maxTokens/reasoningEffort 两版一致；第一轮本就能跑通。" },
              { "k": "jobs spec.run() 契约", "v": "0.1.7 改为 spec.run(handle) 新传 { id, append, updateProgress }——插件零参闭包自然忽略、返回 { cancel, done } 的消费方式两版相同（0.1.7 L437/L448 实证）。向后兼容，非断裂；handle 的进度 API 插件未用（可作后续增强项）。" },
              { "k": "session/agent 形状", "v": "dsh-agent enter() 两版逐字相同；session.header.cwd / delegationDepth / agentPreset 两版均在，插件 20+ 处使用全部安全。" }
            ]
          }
        },
        {
          "componentName": "Text",
          "props": { "style": "font-size:13px;font-weight:bold;line-height:1.9;display:block;margin-top:12px;", "text": "总判定：① 根因两处均成立、非他因；② 目标形状逐字正确、同族消费点无漏改（consult L543 为无害死代码）；③ 两条守卫经证明 + 1025 例 + 负控确认充分（第二循环必要）；④ ownerIdOf 响亮失败取舍正确且落地安全；⑤ 未发现第四处断裂——run(handle) 新参数为兼容性增量而非破坏，建议仍按设计档 §8 单列一批做全触点系统 diff 以绝后患。批 24 可保持现状，无需返工。" }
        }
      ]
    }
  ]
}
```
```

## §2 逐问裁定（**主代理写**）

> 口径：每条意见**恰一条处置**——采纳 / 不采纳（附理由）/ 待定。

| # | 意见（来源：glm-5.3 回复） | 处置 | 理由 |
|---|---|---|---|
| 1 | 两处根因判定均成立、可排除他因（并给出两版源码的逐字行号） | **采纳** | 与父侧独立校验一致（两份平台树 + 现场逐字报错）。它另补出一条比设计档 §2.2 更精确的说明：**0.1.6 的 `ensureOwnerCleanup` 要求传对象本体、0.1.7 要求传 id——契约是「反转」而不是「新增」**，平台自家 `dsh-tool-subagent` 在同一版本内同步把 `owner: parent` 改成 `parent.id`。该措辞已入 §4 教训行 |
| 2 | 目标形状逐字正确；同族消费点排查完毕、无漏改 | **采纳** | 消费侧逐行核对（deepseek 取消息级 `toolCallId`/`isError`；pi-ai `toolResultOf` 同取 + `flattenText`）**外加一条父侧未做的闭环论证**：pi-ai 的 `toolNames` 名字表由历史里 assistant 的 tool-call 块填充，而插件先 push assistant（含 tool-call）再 push 工具结果 ⇒ 不会触发 unknown。父侧无补充 |
| 3 | `lib/consult.mjs:543` 的 `case "tool-result"` 是防御性死代码，可留可删 | **不采纳（保留）** | 判「死代码」的前提（0.1.7 宿主不再产该形状）只对**新建会话**成立：0.1.6 时代创建、升级后继续跑的会话，其 durable 消息仍是旧形状，而 `renderMainHistory` 渲染的正是**调用方近期历史** ⇒ 该分支是**跨版本读取兼容**，删掉会让这些会话的工具结果静默渲染成空串。保留成本是一行 `case`，删除是净负 |
| 4 | 两条守卫充分：给出证明 + 1025 例对抗 + 1 组负控 | **采纳** | 它做了父侧**没做**的更强变异：删掉第二个 `while` 循环后，旧守卫实测产出以 tool 开头的孤儿窗口 ⇒ **第二循环的「必要性」被独立证实**（父侧此前只证了「现状正确」）。验收锚 A4 的判据由此加固，见 §4 教训 ② |
| 5 | `ownerIdOf` 缺 id 时抛（不回落成对象）的取舍正确、落地安全 | **采纳** | 它补查了父侧未逐处展开的一点：consult 的 `ownerOf` 调用在 `try` 块内、子代理只在 `run()` 内才起 ⇒ **零部分派发**；其余三档走批 21 的「告警 + 回落同步」双通道 |
| 6 | 未发现第四处断裂；第三处即 D-40（已修）；建议单列一批做全触点系统 diff | **采纳（登记为后续批次）** | 它逐项 diff 了五个触点：settings 改名（= D-40）· `subagents.start(spawn)`（两版仅 owner 一处差异）· `llm.stream` 的 GenerateOptions（字段集一致）· `jobs` 的 `spec.run()`（见 #7）· agent/session 形状（`enter()` 两版逐字相同）。结论与父侧设计档 §8「建议单列一批做全平台触点 diff」一致 ⇒ 按建议登记，**不在本批扩范围** |
| 7 | `jobs` 的 `spec.run(handle)` 在 0.1.7 会新传 `{ id, append, updateProgress }`，插件零参闭包未使用 | **采纳为登记项（不改）** | 属**能力增量**而非断裂：`run()` 返回 `{ cancel, done }` 的消费方式两版一致，零参闭包自然忽略新参数。进度上报（`updateProgress`）登记为后续可选增强，本批不做（YAGNI） |

## §3 分歧与父侧裁定（**主代理写**）

**唯一分歧 = 意见 #3**（「死代码」判定）。父侧裁定：**保留该分支**，并把它的定性从「死代码」改写为「**跨版本读取兼容**」——理由见 §2 #3。其余六条无分歧，全部采纳。

**计数纪律（R-19）**：评审自报「9/9 锁测试 · 1025 例对抗 · 1 组负控」。父侧**只复跑了自己的两份数字**——`node --test` **522/522** 与两组变异（旧形状 ⇒ D-41a/D-41b 红；一处 owner 退回 ⇒ D-42b 红）；评审的 1025 例与负控脚本**未随纪要交付**，按「评审自报、父侧未复现」口径入册（见 §5）。

## §4 教训（**主代理写**）

1. **「契约反转」比「契约删除」更难自查。** D-42 的表层现象是「平台新增了一句检查」，实质是 owner 的**期望类型反了**（0.1.6 要对象本体、0.1.7 要 id），而平台自家调用点在同一版本内同步改了口径 ⇒ **照抄旧版本行为在这里恰好是错的**。下次遇到平台小版本升级，优先 diff **平台自家调用点**，而不是只 diff 插件自己。
2. **会诊能读到两台机器的源码树时，它的价值从「第二意见」升级为「独立复算」。** 本轮它自己跑了 1025 例对抗与一组负控，抓出的不是缺陷而是**「我的锚不够强」**：A4 原先只证明「现状正确」，没证明「删掉第二循环会红」。⇒ **验收锚默认应包含「删掉它会不会红」**（这正是仓内律 3 的精神，本次由外部独立兑现）。
3. **平台读取路径失效会让「完成通知 + 全文另读」协议静默降级。** 本轮 `job_output` 对两个作业都抛 `Cannot read properties of undefined`（platform/harness 侧，非本插件），靠插件自持的落盘兜住（advisor 的 `session-state.json` / consult 的纪要）。⇒ 「凡后台作业必须在盘上留全文」应由各机制各自为政升级为**显式契约**。

## §5 不可验清单（**主代理写**）

- 评审的 **1025 例对抗脚本与负控脚本未随纪要交付**，父侧无法复跑 ⇒ 数字采信自报。
- 评审对备份树 `.nm-broken-20260923-102653` 的**具体行号**（L94-107 / L412-413 等）父侧未逐条复读；本机确有同族兄弟目录（`.nm-broken-20260923-102653` / `-104713` / `-105929`），路径真实性已核、行号未核。
- 「会诊子代理是否完整读取了 documents 里的设计档」不可验（只读工具无回执）。
- `job_output` 平台缺陷的**根因**不可验：不在本仓代码面，本批只登记现象与两次复现（advisor-dsh-1 · consult-1）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-09-25 | 父侧补写裁定层 §2–§5：7 条意见（采纳 6 · 不采纳 1）· 唯一分歧裁定 · 计数纪律 · 三条教训 · 四项不可验 |
