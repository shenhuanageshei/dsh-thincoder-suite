# 批 45 需求：DSH 0.2.2-rc.1 适配与能力验证

<!-- doc-shape
count-marks: 项|处|条|档|版|组
-->

> **状态**：**设计评审 PASS**（2026-11-06）· **已实施**（批 45；设计档见 [2026-11-06-platform-022-adaptation-design.md](2026-11-06-platform-022-adaptation-design.md)）
> **日期**：2026-11-06
> **触发**：桌面版 DSH 自动更新 **0.2.1-rc.2 → 0.2.2-rc.1**（`contractWatch` 实测：`platformVersion=0.2.2-rc.1`、`versionSource=package-json`、`versionEvidence` 指向 `dsh-app-boot/package.json`）

---

## §一 总目标（不变式）

> **平台换版之后，本插件仍要"把话说清楚"**：既能正常跑，又能在契约漂移时**自己发现并说出来**。

本批**不改任何用户可见行为**，只让「验证基线」与「探测能力」跟上新平台。

---

## §二 背景与问题（三层，各带一手证据）

### §2.1 发生了什么

桌面版 DSH 于 2026-11-06 自动更新到 `0.2.2-rc.1`。本批开工前做了一次**逐包比对**（来源：npm 拉取 `@deepseek-ai/dsh@0.2.1-rc.2` 的 125 个平台包与 `0.2.2-rc.1` 的 130 个平台包 tarball，全部解包后逐文件比对）：

| 读数 | 值 | 来源 |
|---|---|---|
| 有差异的包 | **130**（旧 125 + 新 5） | 全目录递归比对 |
| 其中**有真实代码变更** | **71** | 排除 `package.json` 后的 `lib/*.js` 差异 |
| 只有元数据变更 | **59** | `package.json` 版本号 / `locale/*.json` |

### §2.2 三个具体问题

**问题一：版本哨兵开始报警（可见噪音）**

- 现象：每次装配打印一条「平台版本与本仓验证基线不一致」。
- 根因：`lib/contract-baseline.mjs:50` `PLATFORM_VERSION_BASELINE = "0.2.1-rc.2"`，`:53` `BASELINE_RECORDED_AT = "2026-09-30"`——**这两行没跟上平台**。
- 性质：**有意设计**（只警告不阻断，D28-1），不是缺陷；缺的是"把基线抬上去"这个动作。

**问题二：版本探测源③ 静默失效（真实漂移）**

- 现象：`contractWatch` 的 `versionSource` 落在 `package-json`（源④），而源③（平台服务 `pluginManager`）本该可用。
- 根因（两版源码逐字对照）：
  - `@deepseek-ai/dsh-plugin-manager@0.2.1-rc.2`：`listBundles() { const manifest = …; … return … }` —— **同步返回数组**
  - `@deepseek-ai/dsh-plugin-manager@0.2.2-rc.1`：`listBundles() { return Promise.resolve(this.readBundles().map(…)) }` —— **返回 Promise**
  - 本仓 `lib/contract-baseline.mjs:162` 是同步取值、`:163` 用 `Array.isArray()` 判断 ⇒ 拿到 Promise ⇒ 判失败 ⇒ 回落到源④。
- 性质：**读数仍正确**（源④ 直读 `app-boot/package.json`），但**四源钉死链断了一级**，且失败只写一行 note，无人可见。

**问题三：触点锁的盲区（防偏离失效）**

- 现象：`contractWatch` 报 **10/10 锁全绿**（`ps1`…`ps10`），却没有抓到问题二。
- 根因：十条锁**一律按源码文本求值**（`lib/contract-baseline.mjs` 头注释与 `LOCK_IDS` 注释都写明了这个口径）——它们能验「字面在场 + 命中数」，**验不了「运行时返回形状」**。
- 性质：这是**方法学层面的盲区**，必须用**行为锁**（fixture 驱动、可变异证伪）补，而不是再加一条文本锁。

### §2.3 能力面的现状（本次核查结论，作为本批的输入事实）

对三条主链的宿主底座逐条比对（平台侧 tarball 全解包，比对 `lib/types/*.d.ts` 声明 + `lib/index.js` 实现）：

| 能力 | 依赖的宿主面 | 0.2.2-rc.1 状态 |
|---|---|---|
| advisor | `ctx.llm.stream` / `resolveModelInfo` / `listProviders` | 签名逐字同 |
| advisor | `ctx.jobs.start` / `read` | `dsh-jobs-local` 的 `lib/index.js` 两侧 **SHA256 相同**（`CECDC8A7…AFBED34`） |
| 会诊 consult | `ctx.subagents.getProvider` / `prepareContinuable` / `startActivation` | 签名逐字同 |
| 会诊 consult | `ctx.get("agentPresets")` | 包仅元数据变更 |
| 飞刀 escalate | `ctx.subagents` + `ctx.jobs` | 同上 |

**结论**：三条主链的底座**没有断**。但"声明相同"不等于"真能跑通"——本批要求**真跑一遍**（见 US-6）。

---

## §三 用户故事

| 编号 | 故事 | 验收要点 |
|---|---|---|
| **US-1** | 作为维护者，我要让版本哨兵在 `0.2.2-rc.1` 上**静默**，而不是每次装配都喊一次。 | `evaluateVersionSentinel` 在真机/夹具下 `status==="match"`、`warnings` 为空 |
| **US-2** | 作为维护者，我要让版本探测源③**重新可用**（平台服务可读时优先于源④），这样四源钉死链才名副其实。 | 假 `pluginManager` 返回 Promise 数组 ⇒ `source==="plugin-manager"` |
| **US-3** | 作为维护者，我要一条**能抓住这类漂移的锁**——"声明说返回数组、运行时给了 Promise"必须能红。 | 把修复摘掉 ⇒ 新锁必红（变异自证） |
| **US-4** | 作为维护者，我要文档与事实同批更新：兼容矩阵、README 门槛、CHANGELOG、文档地图。 | 五处指针可解析、计数与实测一致 |
| **US-5** | 作为用户，我要 **advisor 评审**在新平台上真跑一次并给出判定。 | 设计评审本身即真跑，结果落档 |
| **US-6** | 作为用户，我要 **会诊**与**飞刀**在新平台上各真跑一次（不是"签名相同"的推断）。 | 会诊有纪要落盘；飞刀有交付报告 |

---

## §四 非功能标准

| 编号 | 标准 | 判据 |
|---|---|---|
| **N-1** | 不改任何用户可见行为 | 除版本读数与告警文案外，工具描述/返回值/门禁判定零变化 |
| **N-2** | 全量套件保持绿 | `node --test` 全绿（本批开工前实测 **678/678**，来源：本次 `npm test` 输出尾部计数） |
| **N-3** | 只读纪律不变 | 版本探测链仍是零网络、零子进程、零真实 LLM（`dsh017-batch28-design.md`：§2.2 的四源口径） |
| **N-4** | 不引入未处理拒绝 | `runVersionSentinel` 改异步后，装配期调用点必须 `.catch`，不得产生 `unhandledRejection` |
| **N-5** | 文档卫生五条 | 见根 [AGENTS.md](../AGENTS.md)：§五「五条文档卫生」（计数与列表同改 / 指针可解析 / 写后回读 / 状态行同步 / 描述面一致） |
| **N-6** | 不新增依赖 | `package.json#dependencies` 零变化 |

---

## §五 边界与登记面

### §5.1 本批明确不做

1. **不改 `peerDependencies`**（用户决策 **UD-3**）：`^0.2.1-rc.2` 在带 `includePrerelease` 的判定下**已放行** `0.2.2-rc.1`（实测：平台 `evaluatePluginCompatibility` 用的正是 `semver.satisfies(v, range, { includePrerelease: true })`）；只有到 `0.3.0` 才拦。
2. **不采用新平台能力**（用户决策 **UD-2**）：`ToolsService.restrict()` · 工具注册的 `when` 步级激活条件 · `agent.model.current()/select()` —— 没有需求驱动。
3. **不改任何功能行为**：advisor / 会诊 / 飞刀 / eng / 台账 的判定逻辑零改动。
4. **不新增文本锁**：见 §2.3 问题三，文本锁补不上这个盲区。

### §5.2 登记面（已知但不做）

| 编号 | 内容 | 理由 |
|---|---|---|
| **R-45-1** | `dsh-plugin-manager` 在 0.2.2 新增 `readBundles()` / `listVersions()` / `updateBundle()` / `readBundleDetail()` 四个公开面 | 本仓只消费 `listBundles()`；新面等有需求再接 |
| **R-45-2** | 平台新增包：`dsh-official-bundles` · `dsh-experimental-liveshare` · `dsh-personalized-recommendations` · `dsh-experimental-forge-bundle` · `dsh-tool-testkit` | 与本插件无消费关系 |
| **R-45-3** | `dsh-agent` 把「按请求覆盖路由」的水位标了 `@deprecated`（改用 `agent.model.select()` + `AgentOptions.maxTokens`） | 本仓**只读取** `session.requestHeader()`，从不注册该水位 |
| **R-45-4** | `GenerateOptions` 在 0.2.2 变成泛型（`LlmRequestPurposeMap` 可扩展 `purpose`） | 运行时 `purpose` 零校验（实测 `dsh-llm/lib/index.js` 两次扫描命中数均为 0），纯类型面 |
| **R-45-5** | 平台新口径 `engines.dsh`（写了它就**独自决定**、忽略 `peerDependencies`）暂不采用 | 与现有 peer 声明**功能等价**（两者都放行 `0.2.2-rc.1`），但切换会同时改动「闸门口径」与「文档口径」两处，收益为零；等 `0.3.0` 真正需要换档时再一次性改（设计档：§四 D3 的被否决备选 B6） |
| **R-45-6** | 代码评审 🔵②：`test/contract-baseline.test.mjs` 的 T-45a 只断言 `source`/版本，未逐字落 AC-10 要求的子断言「evidence **不含**『未返回数组』」 | 等价承重成立（摘 `await` ⇒ 落 unknown 分支 ⇒ source 断言即红，宿主的变异 M1 已实证），**非假腿**；纯字面覆盖缺口，建议随下次测试收口批补一行 `assert.ok(!…evidence.includes("未返回数组"))` |
| **R-45-8** | **验收期新发现**（非本批引入）：`lib/escalate.mjs:216` / `:282` 仍是 `env.userMessage \|\| env.diagnostics` **二选一** —— 与批 30 在 `lib/consult.mjs:1251-1252` 修掉的 **D-58 / 锚 A30-9③ 同型**。codex 失败时 `userMessage` 在场 ⇒ **exit code 与 stderr 尾部被吞**，现场无法判根因 | 今天验飞刀时就撞上了：只拿到「codex 进程失败（非零退出且无有效输出）」，看不到 exit 值与 stderr。建议照 consult 口径改为「`userMessage` + `diagnostics` **一并显示**」 |
| **R-45-7** | 代码评审 🔵③：同档 `:477` 的断言消息写「批 34 的 11 → 15」，而权威登记口径是**批 36** | **仅影响失败时的诊断文案**，不影响任何判定；改消息即可，与 `REGISTRATION_SURFACE_BASELINE` 注释同口径 |

### §5.3 扫过的面 / 排除的面（否定性结论的前提）

- **扫过的面**：`@deepseek-ai/dsh@0.2.1-rc.2` 与 `0.2.2-rc.1` 的**全部平台包**（125 / 130 个，tarball 全解包，含 `lib` · `lib/types` · `locale`）；本仓 `lib/**` 的 `ctx.*` 与事件名消费点。
- **被排除的面**：① 第三方插件（如 `@deepseek-ai/dsh-subagent-codex` · `dsh-team-link` 等 profile 内非平台包）——它们不由本仓维护；② `app.asar` 内的桌面壳代码（Electron 主进程），不属于 DSH 平台包；③ 客户端渲染的实际像素（需人眼看 GUI）。
- **因此**：本档所有「没有变化」的结论，只相对于上述扫过的面成立。

---

## §六 与既有文档的关系

- 平台契约矩阵与「换版标准动作」：见 [dsh017-program-closeout.md](dsh017-program-closeout.md)：§「平台换契约时的标准动作」。
- 版本哨兵与四源读取链的设计出处：见 [dsh017-batch28-design.md](dsh017-batch28-design.md)：§2.2。
- 版本来源扩源（源③/源④）的补记：见 [dsh017-batch29-design.md](dsh017-batch29-design.md) 与 [2026-10-18-session-handover.md](2026-10-18-session-handover.md)。
- 本批设计：见 [2026-11-06-platform-022-adaptation-design.md](2026-11-06-platform-022-adaptation-design.md)。
