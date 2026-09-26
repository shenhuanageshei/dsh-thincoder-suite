<!-- doc-shape
-->
# 上游平台问题报告包（2026-09-26 · dsh017 批 28 · US-1）

- 定位：本仓**不可修**的平台侧问题，打包成**自包含**的对外报告——拿到本档（配上 `scripts/repro-platform-issues.ps1`）即可复现，不必再翻会话导出。
- 事实底座：全部现象/证据来自本机实测（2026-09-26），原始记录见 [`docs/dsh017-batch26-design.md`](dsh017-batch26-design.md) §1/§2.5/§8 与 [`docs/dsh017-batch27-design.md`](dsh017-batch27-design.md) §1。
- 复现辅助：`scripts/repro-platform-issues.ps1`（**只读**；A28-6 口径——不改本仓文件/配置/环境；`job_output` 试作业腿走独立临时 `DSH_HOME`；沙箱挂死腿经插件派发 + 独立超时，绝不陪挂）。

## 环境背景（三问题共用的底座）

- 官方桌面版内嵌 DSH `0.1.7-rc.2`（app 侧）；桌面 profile 的 pnpm 虚拟店里另残留 `0.1.7-rc.1` 的 `@deepseek-ai/dsh*` 副本（含 profile 自带的 `dsh-jobs-local` 与 `dsh-tool-jobs`）——版本混杂（skew）是下面问题的放大器，但**不是**根因（问题一的干净移除实验已证伪「rc.1 残留是根因」）。
- 本插件侧的对应姿势：生产契约按 `0.1.7-rc.2` 对齐（批 24–27）；读取面崩坏用自持落盘兜底（D-45）；版本哨兵与九条触点锁见 `lib/contract-baseline.mjs`。

## 问题一：`job_output` 读全文对所有作业都崩（读取面缺陷，平台侧）

**现象**
对**任何**作业调 `job_output` 读全文都报同一个错：`Cannot read properties of undefined (reading 'output')`——平台自产作业与插件自产作业 alike。读得到状态行，读不到正文。

**最小复现（含命令）**
在 DSH 会话里执行（复现脚本 leg 一会打印同样的步骤）：
1. 起一个两秒后台作业：`pwsh` 工具，命令 `Start-Sleep -Seconds 2`，`run_in_background` 置真。
2. 等完成通知后，对该作业 id 调 `job_output`。
3. 预期：报 `Cannot read properties of undefined (reading 'output')`。
产物卫生（A28-6）：该腿请在 `DSH_HOME` 指向独立临时目录的会话里做，或事后精确删除自己产出的报告文件——批 27 清扫只认 `advisor|consult|eng|escalate` 四类 kind，**清不掉**他形态产物。

**排除环境变量的证伪实验（关键的干净复现）**
运行 `scripts/fix-desktop-core-skew.ps1`（最小可证伪口径：只把 profile 自带的 `dsh-jobs-local`（rc.1）与 `dsh-tool-jobs`（rc.1）两份目录移出，备份到 `profiles/desktop/_core-skew-backup-20260926-114225/`，内含两份目录与 `moved-list.txt`），重启桌面版后复测：**`job_output` 依旧崩**（平台自产作业 `pwsh-1` 同错）⇒「profile 自带 rc.1 副本被加载」假设被证伪，读取面缺陷落在**平台自身的包对**（或其间包装器）。回退：`scripts/fix-desktop-core-skew.ps1 -Restore`。

**一手证据**
- 批 26 设计档 §1 实测事实 A（2026-09-26 用户重启后当场复测）：平台自产 `pwsh-22` 与插件自产 `escalate-dsh-1`（约 8.4 秒跑完、`completed`、`delivered`）报**同一个错**。
- 批 26 设计档 §8 环境实验记录：移出 profile 自带副本后仍崩（证据：备份目录 `profiles/desktop/_core-skew-backup-20260926-114225/`；`.pnpm` 内已无匹配脚本正则的 jobs 目录）。
- 字节级明细：本插件 D-45 兜底会把每份报告全文落 `$DSH_HOME/.thincoder/jobs/<jobId>.txt`，并在同目录 `index.jsonl` 逐行记录（jobId、kind、at、bytes、pathForm）——上游取证可直接读该索引拿字节数（本报告不抄数，以索引为准）。

**影响面**
官方读取路径在这套部署上完全不可用：任何会话都拿不到后台作业的正文全文，只能靠状态行 + 各自为政的旁路。本仓的缓解（D-45 自持落盘）覆盖**本插件**派发的四条机制，平台自产作业无人在仓内替它兜底。

**给上游的建议**
- 修读取面对 0.1.7 信封的适配：正文在 `job.result` 与输出环，读取器仍在取旧字段（undefined 后直接读属性 ⇒ 崩）；对 undefined 形态先判空再取。
- 让读取器与生产器**同代**：按运行时版本选择读取路径，或在版本失配时显式报错（而不是 TypeError）。
- 复现入口：本报告「最小复现」两步 + `index.jsonl` 索引。

## 问题二：沙箱拒子进程应报错而非挂起（fail-open by omission，平台侧）

**现象**
dsh 子代理执行子进程（例如 `node --test …` 或 `pytest … > 日志`）时**既不报错也不返回**：日志零字节、约八分钟无输出，最终靠 `dshBackgroundTimeoutMs` 兜底掐死，报告 `status: failed`——而交付本身完整且正确（宿主跑同一条命令 7.24 秒全绿，424 passed / 7 skipped）。

**最小复现（经插件派发 + 独立超时——**不要**在宿主直接跑：宿主进不了子代理沙箱，且真挂住会陪挂）**
1. 从 DSH 会话派发一个带 `check` 命令的 `eng_coder` 作业（或任何插件中介的子代理作业），check 用最便宜命令，例如 `node --check lib/index.mjs`。
2. 给派发一个**独立超时**（`HOST_CHECK_TIMEOUT_MS` 量级 = 120000 毫秒，见 `lib/host-check.mjs`；或插件的后台兜底 `dshBackgroundTimeoutMs`）。
3. 判读：秒级返回且输出全绿 ⇒ 本腿今日不复现；**既不报错也不返回**直到兜底触发、日志零字节 ⇒ 记「**疑似挂住**」（沙箱拒子进程却未 fail-closed）。
4. 宿主对照：同一命令在宿主直接执行 ⇒ 秒级全绿（证明不是命令慢）。

**一手证据**
- 会话 `session-625c6f0d`：`eng-dsh-13` 三阶段文件编辑**全部落地**（最后写入 07:51:33），随后创建验证日志 `.pytest_full.log`——**日志零字节、约八分钟无输出**，兜底掐死，报告 `status: failed`；宿主同命令 7.24 秒全绿。同会话 `eng-dsh-5` 同款失败（三次中两次）。
- 批 26 设计档 §1 实测事实 B 与 §2.5 根因链（三段：平台挂死 ⇒ 任务书免责声明拦不住结构化 check ⇒ 交付完整却记 failed）。
- 因果闭环：批 26 据此把验证门归位（D48-1 执行者归位 / D48-2 宿主验收回执）——机制生效后该面不再咬到本仓，但平台行为本身未变。

**影响面**
每个工程交付的「验证相位」在这套部署上**起跑即死**：要么整轮排障 + 一次重派裁决，要么逼所有机制把 check 全部上收宿主（现在的现实）。任何依赖「子代理能在沙箱里跑命令」的用法都不可用，且**没有任何报错**指向原因。

**给上游的建议**
- **fail-closed**：沙箱拒绝子进程时应**报错**（把拒绝以 EPERM/策略错误形态浮给代理与工具结果），绝不静默挂起——挂起只能靠兜底超时，代价是整轮墙钟。
- 子进程执行加**有界超时 + 显式错误文本**；拒绝事件应进入作业的可观测面（diagnostic/日志），让「疑似挂住」变成「被拒绝」。
- 复现入口：本报告「最小复现」的派发步骤；对照命令给宿主。

## 问题三：advisor 三形态并存（coord 超时 / main 截断 / bce 内联成功），内联条件不明

**现象**
advisor 评审结果在不同会话里以**三种形态**到达：coordination 会话超时、main 会话截断、bce 会话内联成功——「内联」路径存在但**条件不明**，无人能预测下一次评审走哪条路。

**最小复现 / 可查化（先让条件可查）**
批 26 已把「这次正文从哪条通道产出」变成**可查**：`lib/job-outcome.mjs` 的 `pathForm` 枚举（`result` / `ring` / `session-state` / `consult-minutes` / `none`）由收口点按**本次结算实际携带正文的通道**判定，逐行落 `$DSH_HOME/.thincoder/jobs/index.jsonl`。复现 = 攒几次 advisor 评审后看分布：
- 直接读：`$DSH_HOME/.thincoder/jobs/index.jsonl`；
- 或跑 `scripts/repro-platform-issues.ps1`（leg 三会打印 pathForm 分布与目录盘点，只读）。
预期：三种形态各自出现在索引与会话日志里，与「会话类型 × 模型 × 时长」的对应关系即上游要补的文档。

**一手证据**
- 用户报的三形态并存（批 26 设计档 §7 变更记录「用户新报三问题并入」行）。
- 机制锚点：`lib/job-outcome.mjs` 的 `PATH_FORMS` 枚举与 `index.jsonl` 行契约（批 26 §2.1.3 评审 #8 钉死枚举）；收口点按实际通道判定，不由 kind 静态推出。

**影响面**
评审交付的可靠性随**不可见条件**波动：同一条命令有时超时、有时截断、有时内联成功——排障时无法区分「平台行为」与「环境偶然」，只能逐次人肉归因。

**给上游的建议**
- 把「advisor 结果何时内联、何时走作业」的**条件文档化并确定化**（会话类型/模型/时长阈值——现在是三套行为并存且互相不可预测）。
- 在作业元数据里暴露**交付形态**字段（本仓 `pathForm` 已示范了最小可行形态），让调用方一眼可查。
- 对 coord/main 的超时与截断给出可配置且可见的边界（超时阈值、截断长度），而不是隐式发生。

## 复现脚本（`scripts/repro-platform-issues.ps1`）的只读口径（A28-6）

- **不改本仓文件/配置/环境**：只做 `Test-Path`/`Get-Content`/`Get-ChildItem` 一类的只读取证；唯一写动作是 `$env:TEMP` 下的独立临时目录（`job_output` 试作业腿的临时 `DSH_HOME`），脚本结束即自清。
- **绝不陪挂**：沙箱挂死腿**不**由脚本自己执行——脚本打印「经插件派发 + 独立超时」的受助步骤与判读表；超时即记「疑似挂住」并继续。
- 输出一段可直接贴进 issue 的 markdown 报告。
