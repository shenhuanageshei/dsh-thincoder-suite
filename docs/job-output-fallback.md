# 后台作业全文读不回：现象、真因、现状

- 日期：2026-09-25（**2026-09-28 更正定性**）
- 性质：**常设运维说明（非批次档）**——记录一次「作业读不回」事件的现场、绕行方式与**最终真因**，供本机（及同类部署）的**任何会话直接照用**
- 适用：DSH 0.1.7-rc.2 桌面版（`$DSH_HOME` = `C:\Users\huangchaowen\.dsh`）；其它版本先复现再照用
- 相关批次：**批 26（D-45）已交付**——全文现在落在 `$DSH_HOME/.thincoder/jobs/<jobId>.txt`（并追加 `index.jsonl` 记 `pathForm`）

## §0 结论（2026-09-28，先读这一节）

**平台侧无缺陷。** 真因是本机 profile 装着的**第三方插件** `@dsh-external/dsh-task-status`（上游 `vlln/dsh-task-status`，未适配 0.1.7）：它在 `apply()` 里给 `ctx.jobs.read` 打**镜像补丁**，把 0.1.7-rc.2 的返回 `{ chunks, lossy, result?, job }` 拆开后**只回吐 0.1.6 的 `{ text, snapshot }`**（`text` 还恒空——它按已不存在的 `result.text` 取值）。下游遂崩：

| 下游 | 读到什么 | 报什么 |
|---|---|---|
| `@deepseek-ai/dsh-tool-jobs` 的 `readBody` | `read.job.output.spillPaths`，而 `read.job` 是 `undefined` | `Cannot read properties of undefined (reading 'output')` |
| `@deepseek-ai/dsh-tool-pwsh` 的 promoted 分支 | `ringDelta(read.chunks)`，而 `read.chunks` 是 `undefined` | `Cannot read properties of undefined (reading 'filter')` |

**取证方式**：往 profile 的 `cordis.patch.yml` **热插一个探针插件**（该档 `patchReload: live`，且 loader 接受绝对路径作插件名）——**零重启**拿到运行时读数：

```text
js.constructor.name                   = LocalJobRegistry
Object.keys(js)                       = [..., "read"]          ← 实例上多出一个自有 read（绑定函数），遮蔽原型方法
String(js.read)                       = "function () { [native code] }"
Object.keys(js.read(id, owner))       = ["text", "snapshot"]   ← 0.1.6 旧契约
Object.keys(js.readAt(id, 0, owner))  = ["chunks", "next", "lossy"]  ← 未受影响，且拿得到真实 chunks
```

**处置**：已卸载该插件（移除 profile 的 `file:` 依赖、`dsh.profile.bundles` 条目、`node_modules` 实体、`.modules.yaml` 条目与 `pnpm-lock.yaml` 三处；备份在 `profiles/desktop/_task-status-uninstall-20260928/`）。**卸载后 `job_output` 与 promoted 读取立刻恢复**（同机同日实测读到完整正文，未重启、未改平台包）。

**上游同款**：`@vlln/dsh-task-status@0.3.1`（npm）该段代码**逐字未改**，且另有 `jobs.list(agent)`（应传 session id）与 `snapshot.ownerSession`（0.1.7 里叫 `owner`）两处失配 ⇒ 换上游源同样会复现，且在 0.1.7 上任务面板本就基本为空。**建议先别装。**

**批 26 的落盘兜底仍然有效**，但它的定位从「唯一在仓的答案」降为**附加保险**——它不再有「平台随时会坏」这个前提。

## §1 现象（逐字，留档）

调 `job_output({ job_id })` 读任何后台作业，抛：

```text
Cannot read properties of undefined (reading 'output')
```

截至 2026-09-25 的**四次**复现：`advisor-dsh-1` · `advisor-dsh-3`（advisor 评审）· `consult-1`（会诊）· **`pwsh-315`（平台自己的后台 pwsh 作业）**。

**★ 另更正一处我自己的错**：早前把 `job_list()` 也算作一次「复现」是**我的调用姿势错误**——它不带参数调用，在 Code-Mode 边界就被拒（报的是另一条 `binding arguments must be lossless JSON`），与本缺陷无关；用 `job_list({})` 调用**完全正常**。

**★ 作业本身是成功的**：派发成功、跑完、完成通知也照常到达——坏的只有「读全文」这一条路径。

## §2 当时的定性（★ 2026-09-28 已作废，仅留档）

2026-09-25 的两次核查先后给出过两个错误定性，这里保留原文以便看清推理是在哪一步偏的：

1. **「本机两代 core 包不配对」**——依据是 profile 的 pnpm 店里残留 39 个 `0.1.7-rc.1` 的 core 包，而 app 里是 rc.2。⇒ 2026-09-26 的**最小可证伪实验**（干净移出 profile 自带的 `dsh-jobs-local` / `dsh-tool-jobs` 后重启）**仍崩** ⇒ 该假设被证伪。
2. **「平台自身的读法缺陷，本仓不可修」**——在实验 1 证伪后所下的结论。⇒ **2026-09-28 被运行时探针推翻**：reader 与 writer 同代（`@deepseek-ai/dsh@0.1.7-rc.2` 同时钉 `dsh-jobs-local` 与 `dsh-tool-jobs`），崩的原因是有第三方插件**在中途把 `read` 换掉了**。

**教训**：两次都停在「静态面 + 环境面」的推理上，没有去问**运行时的那个对象到底长什么样**。热插探针的成本很低，应该更早用。

## §3 逐机制绕行（留档：兜底仍在，降为附加保险）

| 机制 | 全文落在哪 | 怎么读 |
|---|---|---|
| **advisor**（`type=code` / `type=design`） | `$DSH_HOME/.thincoder/session-state.json` → `sessions[<会话 id>].lastAdvisorOutput` | 读该 JSON，取对应会话的 `lastAdvisorOutput`。**已验证**：2026-09-25 的两次评审全文都是这样拿到的 |
| **consult**（会诊） | `docs/consult-minutes/<日期>-consult-<id>-minutes.md` | 直接读纪要文件。台账 `$DSH_HOME/.thincoder/consult-ledger.jsonl` 的 `settled` 行带 `minutesPath`（机制在 settle 时**先落盘、再让作业完成**） |
| **eng_coder / escalate**（后台路径） | `$DSH_HOME/.thincoder/jobs/<jobId>.txt`（批 26 起） | 读该文件；`index.jsonl` 有索引 |

## §4 eng_coder / escalate 的交付报告落盘（批 26 已补）

批 26 起 `lib/job-outcome.mjs` 在**收口点**把四类机制的作业正文统一写盘到 `$DSH_HOME/.thincoder/jobs/<jobId>.txt`，并追加 `index.jsonl`（`jobId` / `kind` / `at` / `bytes` / `pathForm`）。⇒ 原 §4 的「交付报告读不到」缺口**已闭合**。

## §5 撞上时不要做什么

- **不要判作业失败**——它是成功的；也不要重试派发（重复消耗预算与评审轮次）。
- **不要另找地方猜**：先照 §0 查「有没有插件在改 `ctx.jobs`」；再照 §3 找。

## §6 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-25 | 首版：三次复现 · 两条已验证绕行 · eng/escalate 落盘缺口 · 三条应急 · 永久修法指向批 25（D-45） |
| 2026-09-25 | **二次核查订正**：复现改为四次（补 `advisor-dsh-3` 与**平台自产的 `pwsh-315`**）· 定性改为「机制在、是本机两代 core 包不配对」· 撤掉误记的 `job_list()` 一次 · 永久修法补第 3 条 |
| 2026-09-28 | **定性更正（第三次，最终）**：真因是第三方插件 `@dsh-external/dsh-task-status` 的 `jobs.read` 镜像补丁。新增 §0（结论 + 运行时探针读数 + 处置 + 上游同款告警），§2 转为留档并加教训，§4 按批 26 已闭合改写，§5 增加「先查有没有插件在改 `ctx.jobs`」。**「平台侧缺陷」的定性全部撤回。** |
