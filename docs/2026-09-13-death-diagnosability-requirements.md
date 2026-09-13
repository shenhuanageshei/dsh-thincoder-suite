# 需求：死亡可诊断（守卫 D 判定换血 + 四家族 abort 溯源 + 裸 abort 灭绝）—— 批 6

- 日期：2026-09-13
- 批次：批 6（批次排序见 [`2026-09-12-absorption-inventory.md`](./2026-09-12-absorption-inventory.md) §6；上游来源 = `REVIEW-CHAIN-GUARDS` 守卫 D / §14.6 + `ABORT-PROVENANCE` §20）
- 设计输入：**会诊 id 1**（2 模型并发，**两份均交付**：deepseek-v4-pro / glm-5.3）
- 设计档：[`2026-09-13-death-diagnosability-design.md`](./2026-09-13-death-diagnosability-design.md)
- 状态：**设计待评审**

---

## §0 会诊汇总（纪律要求：会诊结果落档，含分歧与父侧裁定）

### §0.1 模型结果

| 模型 | 结果 | 贡献 |
|---|---|---|
| deepseek-official:deepseek-v4-pro | ✅ 交付 | 范围裁定（6a = D 余项 + 溯源 / 6b = 守卫 E / 墓碑出批）+ 站点清单 + 层映射表 + 逃生门文案 |
| zai-coding-cn:glm-5.3 | ✅ 交付 | 同向裁定 + **两处前提纠错**（见 §0.2）+ **结算侧指纹兜底**（守卫 E 的补强，见 §0.5）+ 实施序四步 |

### §0.2 会诊对我方勘察的两处**前提纠错**（父侧已回代码核验，属实）

| # | 我方勘察原话（错） | 事实（两家独立得出同一结论） |
|---|---|---|
| 1 | 「守卫 D 缺 **per-call 硬墙**」 | **不成立**——`collectStream` 早已是逐调用硬墙：每次 chat 前重算剩余预算（`deadlineMs: timeoutMs - elapsed`）、不依赖 chunk 到达的绝对截止定时器、chunk 墙钟双检、`AbortSignal.any([用户信号, 看门狗信号])`。**真正缺的是「墙怎么判定」**（见 P2）→ 本批体量从「加机制」缩为「换判定 + 两个小件」 |
| 2 | 「5 个 settle 家族」 | **4 个**——我方无 `subagent.mjs`、不包 subagent 工具（eng/escalate/consult 各自经 `ctx.subagents.start` 派生，子代理死因经宿主模块的 catch 站点表达） |

> 父侧纪律：**勘察错误必须落档**（本表即留痕）。两条都是「把上游的形状套到我方」的产物，正是本批要修的同一类病（凭形状推测而不回代码核验）。

### §0.3 分歧与父侧裁定

| # | 争点 | v4-pro | glm-5.3 | 父侧裁定 |
|---|---|---|---|---|
| 1 | 守卫 E 的**逃生门** | 「我方**没有** cancel 等价物，不能照抄上游 `action:'cancel'` 文案（否则撒谎）」 | 「我方**有**等价物——DSH 主代理原生 **`job_kill`**」 | **采纳 glm**。父侧核验：`job_kill` 确实在主代理工具表上（v4-pro 只枚举了**插件自有的 8 个工具**，漏了平台工具——同 §0.2 的病）。拒绝文案必须给出路，且出路是真的 |
| 2 | 守卫 E 要不要**结算侧兜底** | 未提 | **必须补**：预闸拦不住 bash/file_ops 写，而我方**没有**上游那种基于变更日志的 `reviewIsStale`；修法 = design PASS 时在 finalize 内**重算文档集指纹**，失配则不签发 + 注明 | **采纳 glm**（架构差异推导出的一件，非照抄）。这是「两个半件合成完整守卫」的第二半；**F17 型漏洞**（令牌指纹 = 派发前快照）由此闭合 |
| 3 | 拆批形态 | 6a（D 余项 + 溯源）/ 6b（守卫 E） | 批 6（D 余项 + 溯源）/ 批 7（守卫 E，排在批 4 落地后） | **实质一致，取 6a/6b 命名**（保留既有 7/8/9/10 编号，避免全表重排）：**批 6 = D 余项 + 溯源**；**批 6b = 守卫 E**，**排在批 4 落地之后**（两家同指：守卫 E 的「被审文件集」键与批 4 折入的 `designDocKey` 同族，先落批 4 才不会同一把键实现两遍——D-35 的教训镜像） |
| 4 | 墓碑 | 不建（无消费者） | 不建；**登记最小形态**（`clearInFlightJob` 时槽位转单槽终态回显 `lastSettled`，防「取消后立即重派 → 晚到的旧完成通知被误读为新任务的产物」） | **两家一致：出批缓议**；**登记 glm 的最小形态**（骑在 6b 的槽位载荷扩容上，真出现消费者再建） |

### §0.4 父侧补充裁定

| # | 裁定 | 理由 |
|---|---|---|
| P-a | 载体 = **结构化 `err.abortInfo`**（`{trigger, layer, detail}`），**不做 message 内嵌** | 上游 D-24-2 同裁；message 内嵌会被既有 `startsWith("Advisor:")` / fixture 断言撞上（零回归不可保） |
| P-b | **原 message 前缀逐字保留**，死亡行只追加后缀 | `completed` 判定 = `startsWith("Advisor:")`；`extractUnfixedIssues`、prior、既有 fixture 全锚它 |
| P-c | `trigger` 五值**必须含 `unknown` 且是显式告警态** | 「归不了因」正是今天最难查的形态（600s 静默）；静默回落 = 本批白做 |
| P-d | **分类在 abort 写点闭包内 latch**，不在结算处从错误对象倒推 | 竞态实据（两家各自给出）：子代理可能以 resolve（`stopReason=aborted`）而非 reject 结束；错误对象里没有「谁按下的」 |
| P-e | 本批**只加诊断载荷，不改机制本体** | 「何时 abort / 谁有权 abort」零改；判据 = 零新增 `abort()` 写点、零定时器时长/条件变更 |

### §0.5 出批与缓议（如实登记）

| 件 | 去向 | 理由 |
|---|---|---|
| **守卫 E**（在途窗口冻结 + 预闸拦截 + 结算侧指纹兜底） | **批 6b**（排批 4 落地后） | 写面正确性特性、新增用户可见拒绝面；键与批 4 的 `designDocKey` 同族 |
| **墓碑** | **缓议**（登记最小形态） | 我方**零消费者**（无 dependsOn 调度、无 status 单查、无 digest 自动注入通道）；事后查询由 DSH 平台 job 注册表承担 |

---

## §1 总目标（一句话）

让**每一种死亡自证来源**——「哪一层按下的（provider / agent / settle）+ 因为什么（user / timeout / cancel / stop / unknown）」
在一次工具返回里可判；顺带把守卫 D 最后两块补齐（**墙判定绑信号状态**而非文本嗅探、预算将尽的**一次性可见提示**）。

---

## §2 背景与问题

| # | 问题 | 根因 | 证据（as-of 批 5 交付后） |
|---|---|---|---|
| **P1** | **死因坍缩**：四个家族把不同死因写成同一句通用文案，没有任何站点能四分辨 | 每个 catch 站点只透传一句话；内部的「谁按下的」在裸 `abort()` 处就已丢失 | eng `"eng_coder aborted."`（3 处，其中一处 `detail:"aborted"` 是**纯丢失点**）· escalate `"escalate (tag) aborted."`（3 处）· advisor `"Advisor: interrupted."`（4 处）+ dsh job catch 把 AbortError 变成 `"Advisor: review failed — The operation was aborted"` · consult 最好也只有两分（`timedOut` 布尔） |
| **P2** | **墙判定靠自由文本嗅探** | 循环 catch 用 `/deadline reached/.test(e.message)` 把超时从 interrupted 里分出来 | 适配器以**无该字样**的 AbortError 抛出时（实据：`Promise.race` 里 iterator 拒绝抢先）→ 被误判 `interrupted` + **丢掉超时统计尾** |
| **P3** | **预算将尽可能完全静默** | 无任何中途提示 | `advisor` 组 `timeoutMs` 可配到 1h——静默烧 45min 比烧 7.5min 更痛 |
| **P4** | **超时尾统计不全** | 现有尾只有 `completed R tool rounds, F files read` | 缺「工具调用数 / 是否产出过评审正文 / 预算值与配置键」——用户拿到超时后无法判断「该收窄还是该加预算」 |
| **P5** | **五处裸 `abort()`**（写点不带 reason） | 同一 controller 有多个写者，其中若干不传 reason → 下游无法分辨谁按下的 | eng / escalate 的 `forwardSignal`、consult 的 forward 与 stop 循环（**F-AP2 同款**） |
| **P6** | 「取消后立即重派 → 晚到的旧完成通知被误读为新任务的产物」 | 在飞槽位清除即失忆 | 登记为**缓议**（§0.5）——真出现消费者再建 |

**P1 的实证**：`consult.mjs` 的注释自认——「2026-09-08 生产：**20 次失败全被读成「aborted 无死因」**」（D-28 当时试了 21 次才诊断出来）。这不是推测，是既有事故的机制成因。

---

## §3 功能用户故事

| # | 用户故事 | 判定句（可机验） |
|---|---|---|
| **US-1** | 作为排障的我，任何 abort/超时死亡都要能一眼看出**哪一层 + 什么原因** | 四家族各构造 user / timeout / cancel / crash 四种死亡 → 报告尾部含正确的 `abort(<trigger>@<layer>:<detail>)`；**归不了因时必须显式 `unknown@…`**，不得静默回落成通用文案 |
| **US-2** | 作为用户，我不希望这次改动**动到任何既有文案的前缀** | 既有 `startsWith("Advisor:")` / `"eng_coder aborted."` / `"escalate (…) aborted."` 前缀**逐字保留**（后缀只追加）；既有 fixture 全绿 |
| **US-3** | 作为排障的我，预算到点被中止时要能分辨**是预算还是用户取消** | 适配器以**不带 `deadline reached` 字样**的 AbortError 抛出 → 仍判**超时尾**（前缀逐字 `Advisor: review timeout after `）；用户真取消 → 逐字 `"Advisor: interrupted."` |
| **US-4** | 作为跑长预算评审的人，我希望预算将尽时**看得见一次**提示 | 同一场评审跨过阈值只提示**一次**（纯函数可测）；提示文本**不进**返回正文/prior |
| **US-5** | 作为拿到超时的用户，我希望知道**下一步该做什么** | 超时尾含 `rounds / tool calls / review text produced: yes\|no` 统计 + 预算值与配置键 + 两条出路（收窄 / 加预算） |

---

## §4 非功能标准

| # | 标准 | 判定 |
|---|---|---|
| **N-1** | **零回归**：前缀逐字、既有 fixture 全绿 | 既有断言零修改即全绿 |
| **N-2** | **不改机制本体** | diff 内**零新增** `abort()` 写点；零定时器时长/条件变更；仅新增 reason 载荷与 catch 侧分类；`grep '\.abort()' lib/` → 0 命中（裸写点灭绝） |
| **N-3** | **单一词汇表** | `lib/abort-provenance.mjs` 是唯一实现；`grep abortInfo` 的 import 全指向它（无第二套 trigger/layer 字面） |
| **N-4** | 零新依赖、零新文件（除新模块与新测档） | — |
| **N-5** | 提示文本**不污染**返回正文与 prior | 提示走 `messages` 注入；`looksLikeReview` 启发式与 prior 存储不受影响 |

---

## §5 边界与登记面

**本批不做**：① 守卫 E（→ 批 6b）；② 墓碑（→ 缓议）；③ 不改「何时 abort / 谁有权 abort」；④ 不改 `dshBackgroundTimeoutMs` 兜底语义（与 per-call 墙是**两层不同故障面**：兜底管挂死/活性，墙管预算/公平）；⑤ 不动批 4 与其折入的 D-35；⑥ 不动 `conventions` 单一权威谓词（属可移植性批）。

**登记面**：

| # | 登记项 | 说明 |
|---|---|---|
| A-1 | 墓碑最小形态（缓议） | `clearInFlightJob` 时槽位转单槽终态回显 `lastSettled: {jobId, mechanism, terminal, at}`；真出现消费者再建 |
| A-2 | 守卫 E 的两半（批 6b） | 预闸（拦 write/edit）+ **结算侧指纹兜底**（拦 bash/file_ops 等预闸覆盖不到的面） |
| A-3 | 我方**没有** digest 自动注入通道 | 死亡行的**消费者**是主代理（工具返回尾部）与 `job_output`；无「注入即消费」语义 |
| A-4 | 勘察前提纠错留痕 | §0.2 两条（per-call 墙已存在 / 4 家族而非 5）——防后续批次重复造墙或漏改家族 |
