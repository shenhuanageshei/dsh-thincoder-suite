# 需求：到点必落账（看门狗硬结算）

- 日期：2026-10-22
- 设计档：[`2026-10-22-forced-settle-design.md`](./2026-10-22-forced-settle-design.md)
- 设计输入：用户 2026-10-22 裁定「看门狗硬结算 按你建议」；现场证据见下方前置事实
- 成文流程：**豁免留痕**——按用户 2026-10-22 的直接裁定走「单点修复」简化流程（不另开会诊）；理由：症状与根因已由现场账本与 `path:line` 钉死，无需要外部意见的分支裁决点
- 设计评审：轮 1 **FAIL**（🔴1 · 🟡3 · 🔵5，九条全改 + 自查补第 10 条）→ 轮 2 **PASS**（design token 已签发，有效至 2026-10-29）

<!-- doc-shape
count-marks: 条|处
-->

## 前置事实（2026-10-22 实测，带 `path:line`）

- 会诊的等待点：`lib/consult.mjs:1343` `const result = await run.result`；逐模型结算在 `settleChild`（`lib/consult.mjs:930`，`session.pending--` 在 `lib/consult.mjs:947`）；整轮结算的前置条件写在 `lib/consult.mjs:490` 的 JSDoc（`pending === 0 || stopped`）。
- 会诊看门狗：`lib/consult.mjs:1166` 的 `setTimeout` 到点只做 `ctrl.abort(...)`，没有任何结算动作。
- eng_coder 后台：`lib/eng.mjs:1768` 的兜底 `setTimeout` 到点只 `ctrl.abort`；静默看门狗回调在 `lib/eng.mjs:1748-1753`，同样只调 `cancelJob`；等待点是 `lib/eng.mjs:1838`。
- eng_coder 同步路径：`lib/eng.mjs:1953` 的截止只 abort，等待点 `lib/eng.mjs:2000`。
- escalate 后台：`lib/escalate.mjs:514` 的兜底只 abort，等待点 `lib/escalate.mjs:539`；同步路径 `lib/escalate.mjs:629` / `lib/escalate.mjs:653`。
- 会诊账本（`C:\\Users\\huangchaowen\\.dsh\\.thincoder\\consult-ledger.jsonl`，2026-10-22 读取）：119 次 `started`，其中能读到结算事件的 109 次、**只有 `started` 的 10 次**；`#108` 从 05:58 跑到 07:26（88.8 分钟）直到手动停；另有 6 次**准点 30.0 分钟**结算。
- 用户配置（`C:\\Users\\huangchaowen\\.dsh\\.thincoder\\config.json`）：`consultTimeoutMs=1800000`、`dshBackgroundTimeoutMs=1800000`、advisor 两档 `timeoutMs=1800000`。

## 一、总目标

让「到点」等于「落账」：本批覆盖 会诊、eng_coder、escalate 三条 dsh 子代理路径的五个等待点；其中任何一个在预算到点并经过宽限后，**必须**产出一个结算结果，而且这个结果**不依赖被中止方是否响应**。

判据一句话：把平台子代理换成「永不 settle 的假对象」，会诊、后台任务与同步任务仍能在「预算 + 宽限」内落账，且文案如实说明「未响应 abort」。

## 二、用户故事

- **US-1 到点必落账**：作为使用者，我设了 30 分钟预算，就应当在 30 分钟加宽限内拿到结果或超时结论，而不是无限期地「看上去还在跑」。
- **US-2 不误杀**：正常返回的任务行为与文案**逐字不变**；宽限计时器在正常路径上从未启动。
- **US-3 只扣一次**：结算账目（会诊的 `pending` 计数、账本事件、job outcome）在任意竞态下恰好发生一次。
- **US-4 诚实文案**：强制结算的结论必须写明「未响应 abort，可能仍在后台运行」；不得声称已终止一个我们无法终止的进程。
- **US-5 可观测**：强制结算在会诊账本上可区分（加性字段），事后能统计「平台不响应 abort」的发生率。
- **US-6 不扩散**：不新增用户可配键；不新增中止写点；不碰 `lib/eng.mjs` 被 T-AP7 冻结的 `setTimeout` 字面。

## 三、非功能标准

- **兼容性**：正常路径的输出文本、job outcome、账本事件保持逐字不变（加性字段除外）。
- **资源**：宽限计时器 `unref()`，结算后 `clearTimeout`；不引入常驻轮询。
- **可测性**：全部截止逻辑走可注入的定时器与时钟，测试用假计时器驱动，零真实等待。
- **失败方向**：结算优先（fail-open），但绝不伪造回复内容；读不到真实结果就写「无回复 / 超时」。
- **诚实性**：文档与返回文案不得把「发了 abort」写成「已终止」。

## 四、本批不做（非目标）

- **不杀进程**：平台没有提供终止子代理的接口，本批不做「假装能杀」的任何实现。
- **不新增用户可配键**：宽限值固定，不进入配置白名单三面。
- **不覆盖 codex 子进程路径**：那条路径已有 `exit` 事件与 `kill`，不在本批射程。
- **不覆盖 advisor 的 dsh 派发面**：advisor 走进程内工具循环，自带 deadline 定时器（`lib/advisor.mjs:1359`），不是子代理 `await`，不在本批射程。
- **不改平台**：本批只改本插件，平台侧对 abort 的响应语义不变。
- **不处理宿主崩溃**：2026-10-22 的原生崩溃另行取证，本批不把它当作已确诊的因果。
