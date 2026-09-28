# 会诊纪要 —— consult #2（原始层，机制落盘）

- 日期：2026-09-28
- 会诊 id：2
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
- 平台 job：consult-1
- 结果：2/4 交付（其中 2 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #2 finished — 2 of 4 replied (2 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #2 finished — 2 of 4 replied (2 failed)]
effective: 2 of 4 (2 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
job: consult-1
minutes: docs/consult-minutes/2026-09-28-consult-2-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — 子代理面不可诊断（no diagnostic, and the child session log gave no turn/end reason — 本部署无法取得该证据：子会话 id / 会话档 / 解压任一不可得）)

[2] zai-coding-cn:glm-5.3 — ok
# 会诊意见：D-45 `job_output` 读取面（@dsh-external/dsh-thincoder-suite）

## 0. 可验证性边界（先声明）

我这侧的执行环境拿不到用户机的 `D:\DSH-Desktop-Official\...app.asar` 与 `C:\Users\magic\.dsh`（路径在本机均不存在，当前用户也不同）。因此本意见的源码层断言全部建立在**仓内文档已引的行号坐标**上（`dsh-tool-jobs/lib/index.js:100-132`、`:206-227`；`dsh017-full-alignment-design.md` §2.1 的两代逐字对照；`dsh-jobs-local/lib/index.js:176`、`:428-436`）。下面每个结论都配了「在你机上把它变成测量」的实验——E0 存在的目的就是把我的推理重新钉回真机源码。

## 1. 先把崩溃行读准：报错文本本身已是硬证据

`Cannot read properties of undefined (reading 'output')` 的形状可以反解崩溃点。若崩点真在 `read.job.output.spillPaths` 链上：

- 崩在第三段（`read.job.output` 为 undefined）⇒ 报错属性名应是 **`'spillPaths'`**；
- 实报 **`'output'`** ⇒ undefined 的基座是「被读 `output` 的那个对象」，即 **`read.job` 本身就是 undefined**。

**推论：运行时 read() 返回的信封里根本没有 `job` 字段**——不是 `job` 在而 `output` 缺，也不是 spill 没触发。合上登记表「readBody 期望 `{ chunks, lossy, result?, job }`」：**读的一方假设信封带 `job`，产的一方没带**。这一步同时排除两个候选：不是「输出太小没 spill」（那会报 `'spillPaths'`），不是「作业查不到」（unknown id 报干净错误、job_list 正常）。

## 2. 三个问题的直接回答

**Q1（形状由谁补齐）——服务侧信封组装，不是 spec.run 生产者。** 信封 `{ chunks, lossy, result?, job }` 由 jobs 服务栈组装（dsh-jobs 的 `read()` / dsh-jobs-local 的 produce 面）；`job` 是服务内部记录的引用，生产者（插件）无论怎么写都够不到这一层——插件可写的只有环（`handle.append`）与 `outcome.result`，批 25（D-46）已对齐，而崩点在这两者之后。佐证：平台自产 `pwsh-*` 同错（其生产面也是平台代码）。所以「生产者 vs 读取侧」二分里，责任面收窄为：**服务侧 produce/read 没附 `job` × 读取侧 readBody 无守卫解构**，二者必居其一或兼有——E0/E2 判。

**Q2（两代混装残余）——批 26 的证伪实验没有证完。** 审计 ④ 自己记着：脚本正则只匹配 `dsh-(jobs-local|tool-jobs)`，**`@deepseek-ai+dsh-jobs@0.1.7-rc.1` 仍留在 .pnpm**。所以那次实验证伪的只是「顶层两份 rc.1 副本被加载」，**没有**证伪「read() 的实现来自 rc.1 残量或其它 skew 向量」（如：其它 link 插件的 node_modules、hoisted 顶层的别名）。`nodeLinker=hoisted` 下 .pnpm 理论上是死重量——但这是假设不是测量，E1 一次探针、零重启就能把它变成测量。同时要如实说：即便 E1 证明全是 app.asar rc.2 在跑，rc.2 内部不一致（dsh-jobs 的 read 不带 `job` vs dsh-tool-jobs 假设带）完全可能——rc 通道上「job_output 读已结算本地作业」这条链上游未必整链测过。

**Q3（是否纯读取侧、无法绕开）——不是无法绕开。** `ctx.get("jobs")` 拿到的是服务单例对象；插件侧对实例做**加法式**包装（只在 `env.job === undefined` 时补最小 `job`），平台包文件零改动。能否读通取决于 readBody 有无 chunks/result 兜底——E0 读源码即知，E3 实测即证。另有相邻路径：插件自注册 `job_body` 工具直接 `svc.read(jobId)` 渲染 `result ?? chunks.join("")`——read() 本身显然活着（崩点在它返回之后的解构），这给模型一个一等公民读取通道，与 D-45 落盘互为冗余（一个读活信封、一个读盘，后者不依赖 DSH_HOME 可解析）。

## 3. 判定实验（按成本排序；E0/E1/E2 均不需重启）

**E1 运行时模块普查（先做，最便宜）**——在插件 `enter()` 或临时调试面里：

```js
const svc = ctx.get("jobs")
try { await svc.read("probe-nonexistent-xyz") } catch (e) { dump(e.stack) }   // 服务内部抛错，栈帧 = 实际加载模块的绝对路径
```

判读：栈帧全落在 `...\app.asar\node_modules\@deepseek-ai\...` ⇒ 读取路径无活 skew，Q2 对「read 实现」闭案；任何帧落在 profile 或其它插件 node_modules ⇒ skew 活着，E4 就是修法。

**E2 信封实测（判 Q1 的哪一侧）**——起 2s pwsh 后台作业，completed 后：

```js
const env = await svc.read("pwsh-N")
dump({ keys: Object.keys(env ?? {}), hasJob: !!env?.job, jobKeys: env?.job && Object.keys(env.job),
       types: { chunks: typeof env?.chunks, result: typeof env?.result, lossy: typeof env?.lossy } })
```

三种判读：① keys ≈ `[chunks, lossy, result]`、无任何 job 形键 ⇒ produce 根本不附记录；② 有 `record`/`meta` 等同义键而无 `job` ⇒ **字段名不匹配**（两包各说各话）；③ 有 `job` ⇒我对崩溃行的重建错了，E0 升为必做。

**E0 抽 app.asar 源码当 ground truth（宿主侧一条命令）**——`npx @electron/asar extract`（到 %TEMP%）取 `@deepseek-ai/{dsh-tool-jobs,dsh-jobs,dsh-jobs-local,dsh-output-retention}` 的 package.json + lib/index.js：① 钉死四包版本（问题陈述里 0.0.1-rc.3 / rc.1 / rc.2 三个版本号都出现过，值得实测归一）；② readBody 原文与守卫有无；③ read()/produce 在什么条件下附 `job`（例如仅在 spill 发生时）。②+③ 直接判责任侧，并给上游报告行级证据。

**E3 补偿包装（THE bypass 实验，紧跟 E2）**——`enter()` 时早装（早于任何 job_output 调用）：

```js
const svc = ctx.get("jobs")
const orig = svc.read.bind(svc)
svc.read = async (...a) => {
  const env = await orig(...a)
  if (env && typeof env === "object" && env.job === undefined) {
    env.job = env.record ?? { output: { spillPaths: [] } }   // 变体按 E2 的判读选
  }
  return env
}
```

同会话：pwsh 后台 2s → 完成后调 `job_output`。读通 ⇒ 绕开成立（包装常设化：只在缺失时补、触发 warn 一行、平台修好后自动退化为 no-op）；不崩但正文空 ⇒ readBody 硬依赖 `job.output` 拼正文 ⇒ 此路到头，D-45 落盘维持主位；仍原错 ⇒ 工具另持捕获引用 ⇒ 结构性不可行，如实登记。另注意：若 E0 发现 readBody 有 0.1.6 兼容分支（如 `read.text`），wrapper 可改为 `result → text` 映射——E2 的 keys 告诉你映射什么。

**E4 残余清场（仅当 E1 指向 profile 路径）**——app 关闭时把 .pnpm 的 `@deepseek-ai+dsh-jobs@0.1.7-rc.1*` 及一切 jobs 族 rc.1 残量移出+备份（沿用 `fix-desktop-core-skew.ps1` 可回退口径、扩其正则），重启复测。这同时补齐批 26 审计 ④ 留下的口子。

**E5（可选）条件性探针**——大输出作业（pwsh 生成 ~1MB 文本）再 job_output：若大作业能读、小作业崩 ⇒ `job.output`/spill 是条件性的，定性改「非 spill 路径无守卫」；30s 作业**运行中**调 job_output：若运行中能读、结算后崩 ⇒ `job` 只在活作业信封上存在、settle 时被剥掉——两条都是给上游的行级证据。旁证：平台工具族确有「大输出落盘+回指针」的 spill 机制（本会话我的 glob 结果就被 spill 到 `Temp\dsh-spill-*\` 只回指针），spillPaths 与此同族，大输出腿有现实依据。

## 4. 判定表

| 观察 | 结论 | 动作 |
|---|---|---|
| E1 全 app.asar 帧 | read 路径无活 skew | Q2 归档为「已测量不成立」；焦点回 Q1 |
| E1 有 profile/他插件帧 | 残余 skew 是活因 | E4 清场+复测；上游报告改写 |
| E2 无任何 job 形键 | produce 不附记录 | E3 变体 A；上游报「信封缺 job」 |
| E2 有 record 等同义键 | 字段名不匹配 | E3 变体 B（`job ??= record`）；上游报「字段名不对齐」 |
| E3 读通 | 绕开成立 | 包装常设化；D-45 落盘降为第二通道 |
| E3 空正文 | readBody 硬依赖 job.output | 维持 D-45 主位；可选 job_body 工具 |
| E3 仍原错 | 工具另持引用 | 该绕法结构性不可行，登记收案 |

## 5. 风险与边界（若 E3 常设化）

依赖「工具每次调用经 `ctx.get("jobs").read` 属性读取」这一未文档化行为——enter() 早装可覆盖属性读取型，覆盖不了注册时捕获函数引用型（E3 结果本身就是检验）；只加不改、平台修复后自动 no-op、触发时 warn 一行（仿 `warnedNoHome` 闩）。这与批 30 §2.0 已登记的「穿类型读具体类」同类事实 API 依赖：换平台版本时它是第一复核点。最后：E0+E2 能把上游报告从现象级（「读取面崩」）升级到行级（「readBody 于 lib/index.js:Lx 无守卫读 `read.job.output`；实测信封 keys=[…]（rc.2 app.asar）」）——值得随判定实验一起进 `upstream-2026-09-26-platform-issues.md` 的增补。

[3] kimi-api:kimi-k3 — ok
取证完成。我把 npm 上**全部已发布世代**的生产者/读者源码逐一读过（0.0.1-rc.3、0.1.6-alpha.2、0.1.7-alpha.1、0.1.7-rc.1、0.1.7-rc.2 的 dsh-jobs-local；0.0.1-rc.3、0.1.7-rc.1、0.1.7-rc.2 的 dsh-tool-jobs；以及 npm CLI 与 web-app 的依赖钉版），结论可以先给，再给判定实验。

```dsh-ui
{"gap": 14, "items": [{"content": "**症状组合（工具能注册 + job_list 正常 + job_output 抛 read.job 缺）在任何已发布包的组合下都不可能出现。** 在线的那个 ctx.jobs 不是 npm 上任何一代 dsh-jobs-local——它是桌面 bundle 内部的实现/代理（或 read 记录被中间层重塑时丢了 job 字段）。这解释了为什么清包类实验全部无效：病根不在 profile，也不在 npm 可见的包对里。", "title": "结论（一句话）", "tone": "error", "type": "callout"}, {"columns": ["世代", "read() 返回形状", "events 面", "与 tool-jobs 0.1.7 配对"], "rows": [["dsh-jobs-local ≤0.1.6（含 0.0.1-rc.3）", "{ text, snapshot }", "无（只有 onJobDone）", "加载期即崩：apply() 先调 ctx.jobs.events.subscribe，undefined.subscribe 抛错 ⇒ 三个工具根本不会注册"], ["dsh-jobs-local 0.1.7-alpha.1 / rc.1 / rc.2", "{ chunks, lossy, result?, job: view(job) }（view 恒含 output）", "有", "完全正常：readBody 的 read.job.output.spillPaths ?? [] 必然成立"], ["你机器上的现场", "read 存在、read.job 缺失（chunks/lossy 求值通过后才抛 'output'）", "有（工具已注册是铁证）", "—— 无已发布版本满足这一组合"], ["npm CLI @deepseek-ai/dsh@0.1.7-rc.2", "dsh-jobs-local 与 dsh-tool-jobs 双双钉死 0.1.7-rc.2", "—", "匹配对，纸面上无此 bug；dsh-web-app 只依赖 reader，provider 由宿主组合注入"], "type": "table"}], "title": "世代矩阵：谁附 job、谁有 events"}
```

## 三个子问题的直接回答

**1. record 的形状由谁补齐？** —— 生产者侧的 `read()`。0.1.7 代 `LocalJobRegistry.readJob()` 末尾显式返回 `{ chunks, lossy, ...result?, job: this.view(job) }`，而 `view()` 无条件带 `output: { total, earliest, spillPaths? }`（[rc.2 源码](https://unpkg.com/@deepseek-ai/dsh-jobs-local@0.1.7-rc.2/lib/index.js)、[rc.1 源码](https://unpkg.com/@deepseek-ai/dsh-jobs-local@0.1.7-rc.1/lib/index.js)，两代逐字节同形）。读取侧 [readBody](https://unpkg.com/@deepseek-ai/dsh-tool-jobs@0.1.7-rc.2/lib/index.js) 只对 `spillPaths` 做了 `?? []` 防御，对 `read.job` 本身零防御。settle 的 outcome `{status, detail, result}` 是另一条路，与 read 记录无关——不存在「produce 返回形 vs payload 解构」的灰色地带，责任 100% 在生产者的 read。

**2. 两代混装残余？** —— **逻辑上排除**。rc.1/rc.2 任意混装都安全（两代都附 job、都有 events）；≤0.1.6（含 0.0.1-rc.3）若真在线，tool-jobs 在 apply() 阶段就死在 `events.subscribe`，`job_output`/`job_list` 根本不会存在——与「工具在、job_list 正常、unknown job 报得干净」直接矛盾。所以不必再为 D-45 做任何清包动作，profile 残余与这个崩法无关。

**3. 读取侧字段名不匹配？** —— 也不是。readBody 与 0.1.7 生产者严格对齐；npm CLI 的 [package.json](https://unpkg.com/@deepseek-ai/dsh@0.1.7-rc.2/package.json) 钉的是匹配对。唯一自洽的剩余解释是：**桌面 bundle（app.asar）里给 tool-jobs 供 jobs 的那个实现/代理是 app 内部件**——它转发了 events/attachController/list/get/kill/wait（所以加载与 job_list 全通），唯独 `read()` 的返回没有 `job`（手搓适配器按旧契约 `{text, snapshot}` 转发、或代理 DTO 白名单漏了 job 字段，都会精确产生这个报错）。「平台自产与插件自产作业同错」也自洽：崩在消费侧，与谁生产的作业无关。

## 除落盘外，有没有让 job_output「读通」的路径？—— 有，而且不用修平台

`read` 记录里**缺的是 `job` 视图，`chunks`/`lossy` 大概率在**（报错点在第三参求值，前两参已安全通过）。插件自己持有 `ctx.jobs`（它能 start 作业），完全可以**绕过 job_output 工具、进程内直接调 `ctx.jobs.readAt(id, from)`（非消费型绝对偏移读）或 `ctx.jobs.read(id, ownerId)`**，拿 chunks 自拼全文。优先级建议：**落盘兜底（现有）> readAt 自读（不耗模型游标）> read 自读（会推进 modelCursor，与未来的平台修复冲突）**。旁证通道：浏览器侧 [dsh-api-job-controller](https://unpkg.com/@deepseek-ai/dsh-api-job-controller@0.1.7-alpha.1/lib/index.js) 的 `job.follow` 流只走 `readAt` + `get`，从不经过 `read()`——若 GUI 会话头的 jobs 面板能看到后台作业输出，readAt 链路就是通的。

## 判定实验（按一锤定音程度排序）

```dsh-ui
{"gap": 12, "items": [{"steps": [{"desc": "插件侧加一个临时诊断工具（link 挂载重启即生效），dump：ctor=jobs.constructor.name、hasEvents、hasReadAt、readSrc=jobs.read.toString().slice(0,300)，再对一个 completed 作业直接 ctx.jobs.read(id, ownerId) 打印 Object.keys。一次调用区分全部分支（判读表见下）。", "title": "P1 进程内探针（决定性，不改平台）"}, {"desc": "桌面 GUI 会话头的 jobs 面板（dsh-client-ui-jobs 走 api-job-controller 的 readAt 流）能否看到 pwsh 后台作业的输出？能看到 ⇒ readAt 链路通 ⇒ 插件自读方案成立。", "title": "P2 GUI 旁证（零成本）"}, {"desc": "复制 app.asar 到临时目录后 npx @electron/asar extract，grep 桌面组合里 jobs 的提供者（重点：是否存在手搓 jobs 适配器/代理、其 read 是否漏 job）。注意：本会话的 read 工具读 asar 内文件抛 \"Cannot mix BigInt and other types\"（连 package.json 都抛）——主会话别再依赖它，走 extract。", "title": "P3 asar 取证（纯读、可回退）"}, {"desc": "npm i -g @deepseek-ai/dsh@0.1.7-rc.2 后用同一 profile 起 dsh web，起后台作业再 job_output：读得回 ⇒ 桌面 bundle 特有缺陷实锤；同错 ⇒ 回头查 profile 是否还有未发现的 jobs 提供者。", "title": "P4 对照实验（判别桌面特有）"}], "type": "steps"}, {"columns": ["P1 观察", "判定", "下一步"], "rows": [["ctor=LocalJobRegistry 且 keys 含 job", "生产者无恙，崩在 tool 与 registry 之间的组装层", "P3 定位 app 内部 reshape 点"], ["ctor=LocalJobRegistry 但 keys=[text,snapshot]", "版本悖论（此版本不可能有 events），asar 内容与 npm 不一致", "P3 对照 asar 内包版本"], ["ctor≠LocalJobRegistry（Proxy/facade/未知类）", "app 内部代理实锤，本机不可修", "readSrc 截屏 + P3 证据，上行报上游"], ["keys 含 chunks（不论 job 在否）", "插件自读路径通", "把 readAt 自读实现为第二兜底（read 自读会耗游标，慎用）"]], "type": "table"}], "title": "判定实验与判读矩阵"}
```

## 对仓内文档的两处订正建议

1. `docs/job-output-fallback.md` §1 的「读的一方与被读的一方不是同一代代码」应收紧为：**在线实现不在 npm 已发布世代谱系内**——rc.1/rc.2 混装已证安全，「不同代」假设覆盖不了「工具有 events 面但 read 缺 job」这一矛盾组合。
2. D-45 登记表可补一行：批 26 的「干净移除仍崩」结论现在有了机理支撑——崩点在桌面 bundle 内部件，profile 侧任何清理都够不着；落盘兜底维持「唯一在仓答案」的定性不变，但 P1/P2 若证实 readAt 通，可把「插件进程内 readAt 自读」登记为第二兜底（注意 read 自读会推进 modelCursor，别用）。

[4] deepseek-official:deepseek-v4-pro — failed
(consultation failed: consultation timed out after 30min (consultTimeoutMs))
```

## §2 逐问裁定（主代理写）

> 纪律：每条意见**恰一条处置**（采纳 / 不采纳〔必附理由〕/ 待定）。本节所有「父侧实测」均由主代理本机工具取得，零重启、零改平台包；读数与命令见 §2.1。

### §2.0 处置总表

| # | 席位 | 状态 | 处置 | 理由（一句话） |
|---|---|---|---|---|
| [1] | opencode-go-plan:mimo-v2.6-pro | failed（无内容） | **不采纳** | 无意见可裁——子代理面不可诊断（`child ended: error`，无 diagnostic、无 turn/end 原因）；**不补位**（R-43：交付数 ≠ 有效数） |
| [2] | zai-coding-cn:glm-5.3 | ok | **部分采纳**（§1 采纳 · Q2/E1·E4 不采纳 · E3 待定） | 崩溃行反解正确且被父侧独立证实；但「残余 skew 未证完」被父侧读数否定 |
| [3] | kimi-api:kimi-k3 | ok | **部分采纳**（结论采纳 · 机理不采纳 · readAt 待定） | 「在线实现不符任何可达源码」被父侧 asar 取证支持；但「asar 里不是真包」被证伪 |
| [4] | deepseek-official:deepseek-v4-pro | failed（超时） | **不采纳** | 无意见可裁——`consultation timed out after 30min`（`consultTimeoutMs=1800000`）；不补位 |

**有效数 2 / 交付数 2 / 失败数 2**。

### §2.1 父侧独立回盘实测（本机，零重启、零改平台包）

| # | 读数 | 落点 / 手段 | 结论 |
|---|---|---|---|
| M1 | asar `dsh-jobs-local@0.1.7-rc.2` 的 `readJob()`（`:598-610`）逐字返回 `{chunks, lossy, …result?, job: this.view(job)}`；`view()`（`:569-589`）的 `output` 恒在 | 直接解包 `app.asar` 取 `lib/index.js` | **打包生产者附 `job`** |
| M2 | asar `dsh-tool-jobs@0.1.7-rc.2` 的 `readBody(read)`（`:216-222`）只读 `read.chunks` / `read.lossy` / `read.job.output.spillPaths ?? []` | 同上 | 崩点唯一候选 = `:217` |
| M3 | 全 asar **7535** 个 `.js` 扫描：`job_output` 注册点恰 **1** 处；`LocalJobRegistry` 恰 **1** 处；`.job.output` 消费点恰 **3** 处 | 自写 asar 扫描器 | 无重复注册、无第二实现 |
| M4 | 被移出的 `dsh-jobs-local@0.0.1-rc.3`：`read()`（`:187-196`）返回 `{text, snapshot}`；`events` 命中 0、`subscribe` 命中 0、`attachController` 命中 2 | 读 profile 备份目录副本 | 形状**吻合观测错误**，但**无法注册工具** ⇒ 排除 |
| M5 | 运行时：未知 id → 干净 `unknown job X`；已完成作业 / 运行中作业 / `wait:true` → **同错** | `job_output` 四次调用 | 崩点在「查到作业之后」的读路径，且与结算无关 |
| M6 | `.pnpm` 内 jobs 族目录 **0**；`C:\Users\huangchaowen\node_modules` 存在但**无** `@deepseek-ai`；磁盘可达的 `dsh-jobs-local` 仅 profile 备份目录 / `dsh-browser` 店 / `rollbacks` 归档（均不在解析路径） | 磁盘扫描 | 残余 skew 与祖先遮蔽**均不成立** |

**★ M1 × M5 的张力（本轮最重要的新事实）**：打包源码**正确**，运行时**不正确** ⇒ 差异产生在「包 → 工具」之间，而不是「包写错了」。

### §2.2 逐条主张处置

**来自 [2] glm-5.3**

| 主张 | 处置 | 父侧裁定依据 |
|---|---|---|
| §1 报错形状反解：`read.job` 本身 undefined（否则属性名会是 `'spillPaths'`） | **采纳** | 与 `readBody` 逐字对读成立，且参数求值序独立证实：`read.chunks` / `read.lossy` 先求值不抛 ⇒ `read` 是非空对象、`read.job` 缺失。**这是本次会诊最有用的一条**，一次性排除「输出太小没 spill」与「作业查不到」两候选 |
| §2 Q1 服务侧信封组装、生产者 `spec.run` 够不着 | **采纳** | 与 asar 取证一致：信封由 `readJob()` 组装，插件侧只写环与 `outcome.result` |
| §2 Q2「批 26 的证伪没证完，`.pnpm` 的 `dsh-jobs@0.1.7-rc.1` 仍可能在线」 | **不采纳**（**有据否定**） | 三条读数：① 本机 `.pnpm` 内 jobs 族目录数 = **0**；② profile 用 `nodeLinker: hoisted`，`.pnpm` 不在解析路径上（其 `pnpm-workspace.yaml` 自述如此）；③ 祖先 `C:\Users\huangchaowen\node_modules` 存在但**无 `@deepseek-ai` 作用域**。⇒ E4「清场」为**空操作**，跳过 |
| §3 E1/E2/E3（判定实验） | **待定** | 三条都需在 link 挂载的插件里加临时诊断工具 + 重启桌面版，属**用户决策**，本轮不擅自实施（见 §5） |
| §3 E5 运行中调 `job_output` | **采纳（已实测执行）** | 父侧已跑：运行中（`pwsh-37`，未结算）与已完成（`pwsh-4`）**同错** ⇒ 「`job` 只在活作业信封上存在、settle 剥离」这一支**被否定** |

**来自 [3] kimi-k3**

| 主张 | 处置 | 父侧裁定依据 |
|---|---|---|
| 结论：在线实现**不在 npm 已发布世代谱系内**，profile 侧任何清理都够不着它 | **采纳**（方向对） | 父侧独立得到同一结论的更强形式：asar 内**打包源码是对的**，运行时**却不对** ⇒ 差异产生在「包 → 工具」之间，清 profile 确实够不着。这也与批 26「干净移除后仍崩」自洽 |
| 机理：桌面 bundle 里另有**app 内部件/代理**替代了包（手搓适配器白名单漏 `job`） | **不采纳**（**举证否定**） | ① `desktop-runtime.json` 与 `/dsh/package.json` 都把 `@deepseek-ai/dsh-jobs-local` 钉在 **0.1.7-rc.2**，`dsh-base` 的 `jobs` 行按名挂载它；② 全 asar 7535 个 `.js` 扫描：`LocalJobRegistry` 命中**恰 1 处**（`dsh-jobs-local/lib/index.js:828` 的导出），`spillPaths` 命中的宿主产物恰 3 处（tool-jobs:217 / tool-bash:473 / tool-pwsh:444）；③ profile 全部插件 + 本仓扫描：「第二个 jobs 提供者」命中 **0**。⇒ 「另有内部实现」这一形态未被证据支持 |
| 排除 ≤0.1.6（含 0.0.1-rc.3）：其 `apply()` 会在 `events.subscribe` 阶段死掉，工具根本不会注册 | **采纳**（父侧独立复核通过） | 直接读被移出的 `dsh-jobs-local@0.0.1-rc.3`：`events` 命中 0、`subscribe` 命中 0，而 `attachController` 命中 2 ⇒ 装上它会死在 `dsh-tool-jobs` 的 `ctx.jobs.events.subscribe(...)`（:263）**之前**，`job_output`/`job_list` 不会存在。工具**存在** ⇒ 该支**可闭案** |
| 替代读法：进程内 `ctx.jobs.readAt(id, from)` 自读（非消费型），优于 `read` 自读（会推进 `modelCursor`） | **待定**（方向认可，未实施） | 举证边界如实：断言「`chunks` 大概率在」**未被本轮证实**——`readAt` 走 `ring.readFrom`，其返回形含 `chunks`/`lossy` 但**无 `job`**，与观测错误**完全吻合**，因此「在线 `read` 实为 ring 增量」是一条真实候选，但同样属待验假设（§5-A2） |
| 仓内文档两处订正建议 | **采纳** | 见 §3 裁定 F-3 |

## §3 分歧与父侧裁定（主代理写）

两席对「谁负责」的**分歧不冲突、但各自不完整**，父侧以本机 asar 取证收敛到第三条：

| 争点 | [2] glm 说 | [3] kimi 说 | **父侧裁定** |
|---|---|---|---|
| read 记录为何缺 `job` | 服务侧 produce/read × 读取侧无守卫解构，二者必居其一，**E0/E2 判** | 在线 provider 是 **app 内部件**，不属任何已发布世代 | **两说都未被本轮证据支持到定案**：**打包源码本身正确**（`readJob()` 逐字返回 `job: this.view(job)`），**运行时却缺 `job`** ⇒ 矛盾落在**包与工具之间的某一层**。glm 的「两侧必居其一」正确但未定哪一侧；kimi 的「不属已发布世代」正确，但「asar 里不是真包」被否定。**新事实**：这不是「上游包写错了」，而是**同一份正确源码在运行时未生效** |
| profile 残余是否活因 | 未证完，E1/E4 判 | 逻辑上排除 | **父侧裁定：对「本崩溃」排除，对「consult 拒发」保留**。两者的确是两个缺陷：本崩溃与 profile 无关（批 26 实验 + 本轮读数双重否定）；但**同一 profile 遮蔽确实曾使 `ctx.jobs` 整体为 null**，那是 consult 拒发的真因，已由父侧修复并经真机复验 |

**父侧裁定 F-1（登记面）**：D-45 的定性「平台自身读法缺陷，本仓不可修」**维持**；但描述面需升级一条——**不再是「读取侧无守卫 / 世代错配」这个层次**，而是「打包源码正确而运行时未生效」。这条对上游报告是**决定性**的：它能排除「上游把包写错了」这一整个方向。

> **★★ 2026-09-28 当晚推翻（见 §7）**：这条裁定**错误**。「打包源码正确而运行时未生效」的矛盾**不在包与工具之间**，而是**本机第三方插件 `@dsh-external/dsh-task-status` 在中间把 `ctx.jobs.read` 换掉了**——它是**插件**，既不属平台包，也不在 asar 里，所以上文所有「平台侧」推理的搜索空间**从一开始就漏掉了它**。**平台侧无缺陷。**

**父侧裁定 F-2（不动平台包）**：仍然**不**改平台包、不做 E3 常设化包装（新增对未文档化属性读的依赖，风险与收益不匹配）。**既有落盘兜底维持唯一在仓答案**，且在本次真机验证中**实际生效**（`consult-1.txt` 18023 字节被完整读回）。

**父侧裁定 F-3（文档订正 · 采纳 kimi 建议但收紧措辞）**：`docs/job-output-fallback.md` §1 的「读的一方与被读的一方不是同一代代码」应收紧为 **「运行时行为与任何一份可达源码（asar 打包 0.1.7-rc.2 / npm 已发布世代）均不一致」**；「不同代」假设**已由本轮全盘否定**（0.0.1-rc.3 因无 `events` 被排除、rc.1/rc.2 与 asar 均附 `job`）。

## §4 教训（主代理写）

1. **「报错文本本身是硬证据」被低估了。** [2] 仅凭错误属性名就把崩溃点从「spill 未触发」收窄到「`read.job` 缺失」，父侧复核成立。**属性名反解**应进父侧工具箱（成本≈0，收益=砍掉一半候选）。
2. **清包类实验必须移动「解析真正走的那条路」。** 批 26 移的是 `.pnpm`（`hoisted` 布局下是死重量），没移顶层 `node_modules`——**实验做对了方向、做错了位置**，因而得出「不是 profile 副本」的错误结论。本轮把位置找对后，同一动作**立刻**修好了 `ctx.jobs`。
3. **一次会诊只答一个问题。** 本轮简报把「consult 拒发」与「job_output 崩」当成一件事的两面带进去，导致两席各答一半；父侧回盘才发现**是两个独立缺陷**，且其中一个**本轮已修好**。下次简报应在标题层就把症状拆开。
4. **「打包源码是权威」这句话在本部署不成立。** 读通 asar 源码（`readJob` 附 `job`）本应结案，实际却与运行时相反——**源码取证不能替代运行时取证**。这正是两席都要求 E1/E2 的原因，父侧当时**没有**执行就写纪要，属**父侧欠账**（§5-A2）。
5. **失败席位如实登记，不补位、不猜测其意见**（2 席失败：1 无诊断、1 超时）。

## §5 不可验清单（主代理写）

| # | 不可验项 | 为什么（举证边界） | 下一步 |
|---|---|---|---|
| A2 | 在线 `ctx.jobs` 的身份与 `read()` 的真实返回形 | 需在进程内取值；本会话无 `run_code` / 无 cordis 自省工具；会话事件日志只存**渲染后的错误文本**（已实测：本轮 5 条 `tool/result` 错误事件均无堆栈） | **E1/E2**：在 link 挂载的 `lib/index.mjs` 加**临时**诊断工具，dump `ctx.get("jobs").constructor.name` + `svc.read("<不存在 id>")` 的栈帧 + 一个真作业 `svc.read(id)` 的 `Object.keys`。**需改插件 + 重启桌面版 ⇒ 用户决策**（改完即撤） |
| A3 | E3 补偿包装能否读通 | 依赖 A2 的判读（变体 A/B 取决于信封里有没有同义键） | 同上；父侧**倾向不做**（F-2） |
| A4 | `job_output` 在**非桌面**宿主（npm CLI `@deepseek-ai/dsh@0.1.7-rc.2`）上是否同样崩 | 本机未装 npm CLI 版；且会污染 profile 解析面 | kimi 的 P4 对照实验，**本轮不执行**（代价 > 收益） |
| A5 | 上游该不该修、怎么修 | 平台包在仓外，本仓不可改 | ~~以 F-1 的新定性 + 本轮行级证据提上游~~ **★ 2026-09-28 当晚作废：平台无缺陷，无需提上游；改为向插件作者 `vlln/dsh-task-status` 提 issue（见 §7）** |

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-28 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-28 | **主代理补写 §2–§5**：处置 [1] 不采纳 / [2] 部分采纳 / [3] 部分采纳 / [4] 不采纳；父侧零重启实测 6 条读数（asar 源码取证 · 全 asar 7535 个 `.js` 扫描 · 0.0.1-rc.3 闭案 · 运行中作业同错 · `.pnpm` 零命中 · 祖先 node_modules 无 `@deepseek-ai`）；裁定 F-1/F-2/F-3；不可验 A2–A5 |
| 2026-09-28（当晚） | **追加 §7 收尾更正：F-1 被推翻。** 父侧用**零重启热探针**（往 profile 的 `cordis.patch.yml` 热插一个探针插件）拿到运行时真相：`ctx.jobs` 实例上多出一个**自有的** `read`（绑定函数），`read()` 返回 `{ text, snapshot }`（0.1.6 旧契约），而 `readAt()` 仍返回 `{ chunks, next, lossy }`。真因 = **第三方插件 `@dsh-external/dsh-task-status` 的镜像补丁**。该插件已卸载，`job_output` 即时恢复。**平台侧无缺陷**；落盘兜底降为附加保险。 |

## §7 收尾更正（2026-09-28 当晚 · 主代理写）

### §7.1 结论反转

本轮 §3 的 F-1/F-2/F-3 与 §4 教训 4 都建立在「打包源码正确、运行时却缺 `job`，矛盾在**平台**的某一层」之上。**该前提错误。**

**真因**：本机 profile 装着的**第三方插件** `@dsh-external/dsh-task-status`（上游 `vlln/dsh-task-status`，未适配 0.1.7）在 `apply()` 里给 `ctx.jobs.read` 打镜像补丁：

```js
rawRead = ctx.jobs.read.bind(ctx.jobs)      // ← 实例上从此多出一个【自有的】read（绑定函数）
ctx.jobs.read = (id, caller) => {
  const result = rawRead(id, caller)        // 真 read 返回 { chunks, lossy, result?, job }
  accumulate(id, result?.text)              // 按 0.1.6 的 result.text 取值 ⇒ 新版没有 ⇒ 恒空
  return { text, snapshot: result.snapshot } // ← chunks / job 被整个丢弃
}
```

⇒ 平台的 `dsh-tool-jobs` 读 `read.job.output.spillPaths` 时 `read.job === undefined` ⇒ 抛 `Cannot read properties of undefined (reading 'output')`。同一条链亦解释 `dsh-tool-pwsh` promoted 分支的 `reading 'filter'`（读 `read.chunks`）。**两条症状同源。**

### §7.2 取证方式（本轮 A2 的正确解法）

A2 当初被判为「需改插件 + 重启桌面版 ⇒ 用户决策」。**实际不需要重启**：profile 的 `cordis.patch.yml` 是**热重载**的（`dsh.profile.patchReload: live`），且 loader 接受**绝对路径**作为插件名 ⇒ 热插一个只读探针插件，把 `ctx.jobs` 的运行时读数写到盘上即可（读完即撤）。**成本远低于当初的估计——这是本轮最该记的方法论收获。**

探针读数（逐字）：

```text
js.constructor.name                  = LocalJobRegistry
Object.keys(js)                      = [..., "read"]          ← 自有 read 遮蔽原型方法
String(js.read)                      = "function () { [native code] }"
Object.keys(js.read(id, owner))      = ["text", "snapshot"]   ← 旧契约
Object.keys(js.readAt(id, 0, owner)) = ["chunks", "next", "lossy"]  ← 正常
```

### §7.3 逐条订正

| 原结论 | 订正 |
|---|---|
| §3 F-1「平台自身读法缺陷，本仓不可修」 | **作废**：平台侧无缺陷；真因是第三方插件。 |
| §3 F-2「落盘兜底维持**唯一在仓答案**」 | 落盘兜底**保留为附加保险**（它本就不假设读取面健康）。 |
| §3 F-3「运行时行为与任何一份**可达**源码均不一致」 | **收紧的事实成立**（当时确实对不上），但**原因是搜索空间没覆盖插件**——「可达源码」的清单里从来没有 profile 插件。 |
| §4 教训 4「源码取证不能替代运行时取证」 | **仍然成立，且本轮再次验证**：正是运行时探针（而非任何源码）结的案。 |
| §5 A5「提上游」 | **作废**：改向插件作者提 issue。 |
| §5 A2/A3/A4 | **关闭**：A2 已由热探针完成；A3/A4 失去前提。 |

### §7.4 处置（已执行）

1. 卸载该插件：移除 profile 的 `file:` 依赖、`dsh.profile.bundles` 条目、`node_modules` 实体、`.modules.yaml` 条目与 `pnpm-lock.yaml` 三处；备份在 `profiles/desktop/_task-status-uninstall-20260928/`。
2. 实测：卸载后 `job_output` 与 promoted 读取**立刻恢复**（同机同日，未重启、未改平台包）。
3. 上游同款告警：`@vlln/dsh-task-status@0.3.1`（npm）该段代码**逐字未改**，另有两处 0.1.7 失配（`jobs.list(agent)` / `snapshot.ownerSession`）⇒ **换上游源同样会复现**；已拟 issue。
4. 本仓文档同步更正：登记表 D-45 · `job-output-fallback.md`（整档更正）· `upstream-2026-09-26-platform-issues.md` 问题一**撤回** · `README.md` 已知未决转「已收口」· 批 26/28 设计档与结项页加更正 · `CHANGELOG.md` 追加勘误。
