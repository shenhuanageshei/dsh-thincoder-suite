# thincoder 吸收清单（43 批次档全量、可追溯）

- 日期：2026-09-12
- 来源：**会诊 id 1**（4 模型并发，**2 份有效回复**：glm-5.3 + deepseek-v4-pro；gpt-6-astra / kimi-k3 超时）。
  两份独立读完 43 档全文并各自给出分类 —— 本档是**合并 + 父侧逐条核验**的产物。
- 定位：这是「**吸收面的单一事实源**」——批次排序、优先级、以及「哪些明确不做」都以本档为准。
- 上游：`D:\workspace\thincoder`（v0.12.61，43 份 `docs/batches/*.md`）
- 我方：`dsh-thincoder-suite`（DSH cordis 插件，非 TUI/VSC）

## §0 口径与可信度声明（先读）

1. **两份报告在主要结论上收敛**（120K 预算、CJK 估算、METHODOLOGY 退役、abort 溯源、豁免+三护栏成对、公共层去重），但在**批次排序**与**少数细节**上分歧 —— 分歧处本档已标明并给出父侧裁定。
2. **父侧对高影响条目逐条回代码核验**，发现报告有**至少一处误报**（见 §4 陷阱栏第 1 条：写门禁判据）。**报告的「我们现状」列不可全信**，凡涉及安全/门禁/数据面的结论，落地前须再核。
3. 报告给的行号**不完全准确**（我实测 `advisor.mjs:44` 正确、但 METHODOLOGY 处数被低估：报告称 5-7 处，**实测 19 处**）。本档的行号以**父侧实测**为准。
4. 上游 43 档里，**约 20 档对我方是 T-ONLY**（TUI / VSC 扩展 / provider 传输 / 批次档工具载体）——不是价值判断，是宿主不同构的硬裁剪。

---

## §1 实测痛点（优先级最高 —— 我们自己有证据）

| # | 问题 | 我方证据（父侧实测） | 上游对应 | 价值 |
|---|---|---|---|---|
| P1 | **评审上下文预算写死 120K** | `lib/advisor.mjs:44` `MAX_CONTEXT_TOKENS = 120_000`；`:1032/:1034` 消费 | ADVISOR-CONTEXT-BUDGET（第 25 批） | **高** |
| P2 | **CJK 估算低估 3-4×** | `lib/advisor.mjs:820-821` `JSON.stringify(...).length / 4` | VSC-REVIEW-ASYNC-SWEEP B4 | **高** |
| P3 | **五轮上限误杀设计评审 + 失败可无限重试** | `lib/advisor.mjs:1372`「code 与 design 共享预算」；失败不烧轮次 | REVIEW-ATTENTION G1 + run.mjs 豁免 | **高** |
| P4 | **METHODOLOGY.md 写死在产品提示词（19 处）** | `advisor-msgs.mjs` **8 处** + `advisor-design.md` **2 处** + `engineering.md` **9 处** | PORTABILITY FR11 | **高** |
| P5 | **abort 死亡归因不全** | `eng.mjs:667` `"eng_coder aborted."`、`:737` `detail:"aborted"`；D-28 曾因此**试 21 次才诊断出** | ABORT-PROVENANCE（第 24 批） | **高** |
| P6 | **裁决表三值词表撒谎** | `discipline.md:4` / `engineering.md:218` / `index.mjs:790` / `README.md:51` | PROMPT-REVIEW-ORDER（第 9 批） | **高**（批 3 在途） |
| P7 | **「猜评审员散文」的启发式判定** | `lib/advisor.mjs:741` `isApprovalVerdict`，三版踩坑 + 20+ 边界断言 | 全线机械可判化 | **高**（批 3 在途） |

---

## §2 全量对照表（43 档）

> 「我们现状」列**已按父侧核验修正**；未核验处标「未核实」。

| 批次档 | 它做了什么 | 我们现状 | 可移植性 | 建议批次 | 价值 |
|---|---|---|---|---|---|
| ENGINEERING-MODE | 工程模式定性 + 批次档六段 + batchDoc 门禁 + 失败路径 11 条 | PARTIAL：流程已备；无批次档体系 | 载体 T-ONLY；**失败路径 11 条 PORTABLE** | 批 11（只取语义） | 中 |
| ENG-DESIGNER | eng-designer 角色 + 文档更新纪律 D1–D7 + V1/V2 校验 | MISSING（角色）/ D1–D7 未成文 | NEEDS-ADAPT | 批 11（只取 D1–D7） | 中 |
| MODEL-SELECTION | 模型清单运行期拉取、删候选白名单 | 不适用（宿主管） | T-ONLY | — | 低 |
| BATCH-SEGMENT-TOOL | 批次档段写入工具（无路径参数/段白名单/剥凭证） | MISSING（无载体） | T-ONLY | — | 低 |
| VSC-MIRROR | 三批机制搬 VSC + 两层验收 | 不适用 | T-ONLY | — | 低 |
| DEEPSEEK-V41-FLASH | MODEL_SPECS 数据 | ALREADY-HAVE（effort 枚举已覆盖） | T-ONLY | — | 低 |
| SUBAGENT-TAIL | TUI 嵌套行并入父块 | 不适用 | T-ONLY | — | 低 |
| **POOL-LEDGER** | 台账指针化 + 触发字段 + 老化 + 机检 | PARTIAL（登记表 30 条，无指针/触发/老化） | NEEDS-ADAPT | 批 11 | 中 |
| SETTINGS-NULL-DEFAULT | null 默认值类型校验失效修复 | 该 bug 类不存在；**但 D-31 同族** | NEEDS-ADAPT | 并入 D-31 批 | 中 |
| MECH-DEBT-SWEEP | F16 sync 记账 + 宽度豁免 + parseValue 统一 | PARTIAL（记账谓词我们已有单点） | PORTABLE（F16） | 已覆盖 | 低 |
| **PORTABILITY** | 去本仓绑定：conventions 单一权威、METHODOLOGY 退役、提示词去指涉 | **MISSING（同族缺陷原样在）**：见 §1 P4 | **PORTABLE** | **批 7** | **高** |
| NORMAL-MODE-AUDIT | 普通模式审计 + 会话上下文轮退役 | ALREADY-HAVE（结论参考） | PORTABLE（结论） | — | 低 |
| **ABORT-PROVENANCE** | abort trigger×layer 标注 + deathLine 合成 | PARTIAL（D-28 修一半；eng/escalate 仍裸报） | **PORTABLE** | **批 8** | **高** |
| ACP-CHANNEL-FIXES | ACP 通道修整 | 不适用 | T-ONLY | — | 低 |
| **ADVISOR-CONTEXT-BUDGET** | 预算按模型窗口派生（判死=窗×0.8） | **MISSING（同一 bug 原样）**：见 §1 P1 | **PORTABLE** | **批 5** | **高** |
| ADVISOR-BUDGET-VSC-MIRROR | 上行的 VSC 镜像 | 同上 | T-ONLY（其设计档是批 5 最佳参考） | — | 低 |
| ARROW-EDITING | TUI 输入框竖移 | 不适用 | T-ONLY | — | 低 |
| **COMMON-LAYER** | 提示词公共层 4→10 节 + 同句上移删源 | **PARTIAL**：10 单体文件无公共层；**已有重复症状**（`engineering.md:173-174` 重复标题） | **PORTABLE** | **批 9** | **高** |
| DOC-HYGIENE | 文档卫生 6 条 | PARTIAL（无机械检查） | NEEDS-ADAPT（V1 段引用可解析起步） | 批 11 | 中 |
| HOME-EXPANSION | `~` 展开单点 | MISSING（无适用字段） | T-ONLY | — | 低 |
| INPUT-FIXES-SMALL | TUI await 缺失 + IME | 不适用 | T-ONLY | — | 低 |
| **PROMPT-REVIEW-ORDER** | 严格序 + 四值词表（Dispatched） | **MISSING**：见 §1 P6 | **PORTABLE** | **批 3（在途）** | **高** |
| PROVIDER-HEADERS | 静态头铺通路 | 不适用 | T-ONLY | — | 低 |
| **REVIEW-ATTENTION** | G1 失败三振护栏（N=3）+ G2 UI 态 | **G1 MISSING**：见 §1 P3 | G1 **PORTABLE**；G2 T-ONLY | **批 4** | **高** |
| **REVIEW-CHAIN-GUARDS** | A 未完成不签发 · B 信号自愈+启动断言 · C cite 候选链 · D 预算硬墙+0.75 提示 · E 冻结窗口 | PARTIAL：A/B/C 已有强形态；**D 半有**；**E 未核实** | PORTABLE（D、E） | **批 6** | **高** |
| ROLE-REDEFINITION | 主代理=PM / eng-designer=唯一写稿人 | PARTIAL（无独立 designer） | NEEDS-ADAPT | 批 9 可选件 | 中 |
| SPAWN-QUEUE-DISCIPLINE | 「提交即走」提示词句 | PARTIAL（单 spawn 架构无此痛点） | PORTABLE（若将来并行） | 暂不立项 | 低 |
| STOP-HOOK | 回合结束钩子 | 不适用（宿主管） | T-ONLY | — | 低 |
| **TEST-LIFECYCLE** | 测试三层制（单元退役/集成常驻/生产收编）+ 发布门 | **MISSING**：275 单测同一寿命层，无退役机制 | **PORTABLE**（理念+处置行） | **批 10** | 中高 |
| TUI-SELECTION | picker 渲染 | 不适用 | T-ONLY | — | 低 |
| TURN-ACROSS-SEGMENTS | turn 跨段累计 | 不适用 | T-ONLY | — | 低 |
| VSC-ACTIVITY-REGION-RESTORE | 活动区回摆收口 | 不适用 | T-ONLY | — | 低 |
| **VSC-ASYNC-PARITY** | 中止可见通知 + `discarded` 墓碑终态 | PARTIAL（job 有 done/cancel；无 discarded 区分） | PORTABLE（墓碑思想） | 批 6 顺带 | 中 |
| VSC-ASYNC-VISIBILITY | 池可查可取消 | ALREADY-HAVE 大部分（jobs 句柄+通知） | T-ONLY | — | 低 |
| VSC-GUARD-COMPLETION | 守卫收尾（启动断言直达调用方） | PARTIAL | PORTABLE（一条纪律句） | **批 6 顺带**（2026-09-12 对齐：原记「批 3 附带」，但权威排序 §6 的批 3 行不含它，且批 3 已定为纯评审协议三件；按 §7 规则在此记一行变更理由） | 中 |
| VSC-GUARD-MIRROR | 第 11 批 VSC 镜像 | 同 REVIEW-CHAIN-GUARDS | T-ONLY | — | 低 |
| VSC-INDEX-PERCEPTION | 向量索引 6 条 | 不适用 | T-ONLY | — | 低 |
| VSC-MIRROR-SWEEP | 群 A 镜像 13 项 | 不适用 | T-ONLY | — | 低 |
| **VSC-REVIEW-ASYNC-SWEEP** | 含 **B4 `estimateTokens` CJK 加权（双端）** | **B4 MISSING**：见 §1 P2 | **PORTABLE**（B4） | **批 5** | **高** |
| VSC-WEBVIEW-ESCAPE | 行内代码转义 | 不适用 | T-ONLY | — | 低 |
| WEBSEARCH-PROVIDER-KEY | 死键移除 | 精神已内化（D-22/D-30） | T-ONLY | — | 低 |
| PORTABILITY-VSC-MIRROR | 可移植性 VSC 镜像 | 同 PORTABILITY | T-ONLY | — | 低 |

> 说明：43 档中**约 20 档为 T-ONLY**（TUI / VSC / provider 传输 / 批次档载体）。这不是「没价值」，而是**宿主不同构**——我方是 DSH 插件，UI/传输/回合生命周期由宿主提供。

---

## §3 跨批主题（上游系统性方向 —— 两份报告独立收敛）

1. **把纪律升为机械事实**：一段一作者 → 段白名单工具；未完成 → 谓词不签发；不手工管队列 → 调度器。**上游最大的单一方向 = 父侧临场判断逐项被机械守卫取代**。我方当前大量靠提示词纪律（前缀判据、启发式判通过、无失败护栏）—— 正处这条线的起点。
2. **失败与死亡的确定性**：预算从硬编码 → 窗口派生；死亡从 `aborted` 坍缩 → trigger×layer 标注；失败从静默 → 可见降级句。**与我方 D-28/D-01 实测痛同族。**
3. **提示词拼装化**：单体文件 → 公共层 + 角色层 + 纪律层；词表/时序/判定规则逐条钉死 + 锚测试。我方 10 单体文件且有重复标题，**正在这条线的起点**。
4. **文档与台账的机器一致性**：段引用可解析 / 计数枚举 / 指针不悬空 / 写后回读。
5. **测试生命周期分层** + 每批收口核测试去留。
6. **每项机制变更自带回归锁 + 反向控制**（修前红可复现 / 摘除后转红）。

---

## §4 上游反转 / 撤回与陷阱（**照抄会退步**）

| # | 反转/撤回 | 我们的处境 |
|---|---|---|
| 1 | **写门禁判据「收紧为 `^src/` 前缀」** | ⚠️ **陷阱，勿照抄**。父侧实测：我方 `isProductCode` 当前对 `packages/app/src/a.mjs`、`lib/a.mjs` 均返回 **true（真阳性，拦得住）**；那条 `^src\//` 判断是**冗余死代码**（兜底已覆盖）。**若照抄上游的收紧动作，才会引入绕过** |
| 2 | design token HMAC 签名 + 密钥链：加 → **删** | ✅ 已跟（D-30）—— 勿再捡回 |
| 3 | 5 轮上限：共享 → 设计豁免 → **补三振护栏** | ❌ 两半都未跟 —— **必须成对吸收**（中间态=无限重评） |
| 4 | 600s 绝对墙钟：作语义 → **废除** | ⚠️ 我方保留为 DSH 平台事实（已用 jobs 后台化规避）—— **不再写死任何新墙钟** |
| 5 | METHODOLOGY.md：设计门禁 → **从产品提示词退役** | ❌ 未跟（我方 **19 处**）—— 吸收的是「退役」终态 |
| 6 | 本仓工具名进产品提示词 → **FR13 全删** | ⚠️ 需自查（未点名本仓脚本，但 METHODOLOGY 同族） |
| 7 | 测试「模块下次触碰顺退」→ **被用户否决** | ❌ 未跟 —— 采纳的是「批次收口时处置（有台账）」 |
| 8 | `Fixed` 保「已改完」语义 + 补 `Dispatched`（**否决了改语义**） | ⚠️ 批 3 若图省事改语义 = 吸收了被否决的分支 |
| 9 | providers[].models[] 候选白名单：建 → **整删** | N/A（我方无此面）；教训：**人工维护的清单必漂移** |
| 10 | 会话上下文轮：设计在案 → **退役** | N/A；教训：设计与实现矛盾的机制应退役留痕（我方 D-25 已用此形态） |
| 11 | 修正轮 ⇄ 批准时序：临场「严格序」→ **落成规则** | ❌ 未跟 —— 批 3 在途 |
| 12 | 活动区：加 → 删 → **恢复（但禁复活旧补丁链）** | N/A；教训：**恢复要干净机制，不复活动补丁链** |
| 13 | 死事件/死键：声明 → **除名** | ✅ 精神已内化（D-22 cleanCwdRoot、D-30 密钥链） |
| 14 | issue 断言可能 stale，**不得按 issue 原文实现** | ⚠️ 通用守则（我方 D-30 也踩过：报告称 client.js 在清单内，实际不在） |

---

## §5 明确不吸收（及理由）

1. **VSC 全家族**（8 档）：我方是 DSH **单仓**插件，无 webview/双仓——「双端镜像」模式不适用；其可移植内核已在对位批次计入，镜像批本身零增量。
2. **provider / 传输 / 模型层**（MODEL-SELECTION、DEEPSEEK-V41-FLASH、PROVIDER-HEADERS、HOME-EXPANSION、WEBSEARCH-PROVIDER-KEY、STOP-HOOK、ACP-CHANNEL-FIXES）：全是 DSH 平台职责面，照抄等于在不拥有的层造机制。
3. **TUI 家族**（ARROW-EDITING、TUI-SELECTION、SUBAGENT-TAIL、INPUT-FIXES-SMALL、TURN-ACROSS-SEGMENTS、REVIEW-ATTENTION G2）：DSH GUI 提供我方 UI。
4. **批次档载体机制**（BATCH-SEGMENT-TOOL、batchDoc 门禁、六段档工具面）：上游仓内工作流；**其行为纪律**（一段一作者/写后回读/核销同步清单）可在提示词层少量吸收，工具不搬。
5. **独立 eng-designer 子代理角色**：工作流重设计，我方单会话形态**无实测痛点**，收益未证、成本高。只顺手吸收「内容权=主代理」一句口径。
6. **文档机器检查器**（check-doc-width V1–V3 / check-ledger）：我方 repo 几十文件，建检查器是过度投资；背后纪律随批 11 以提示词级补。
7. **POOL-LEDGER 机检三件套 / SPAWN-QUEUE-DISCIPLINE**：待条目量或并行架构出现再评估。

---

## §6 建议批次排序（父侧裁定，附分歧说明）

排序依据：**实测痛 > 上游已落地决策未跟 > 能力缺口 > 纯跟随**。

| 批 | 内容 | 依据 | 两份报告是否一致 |
|---|---|---|---|
| **批 3（在途）** | 四值词表 + VERDICT 并存 + 判定规则 R1–R7e | 实测痛 P6/P7 | ✅ 一致 |
| **批 4** | 设计评审豁免 5 轮上限 **+ 三振护栏（成对）** | 实测痛 P3 + 陷阱 #3 | ✅ 一致 |
| **批 5** | 120K → 窗口派生 **+ CJK 估算（必须同批）** | 实测痛 P1/P2 | ✅ 一致 |
| **批 6** | 评审链守卫 D/E + abort 溯源 + discarded 墓碑 | 实测痛 P5 + 能力缺口 | ⚠️ glm 将 abort 溯源放批 6，deepseek 放批 8 —— 父侧取**批 6**（与守卫同族、都是「让失败可判」）。**2026-09-12 追加**：VSC-GUARD-COMPLETION（守卫收尾纪律句，原 §2 记「批 3 附带」）随批 3 定型为「纯评审协议三件」而改挂此处（变更理由已按 §7 规则记录）。**2026-09-13 追加（拆批，按 §7 规则记理由）**：本行原含四件，经**批 6 会诊 id 1 两份独立裁定**后重新拆分——**批 6 = 守卫 D 余项 + 四家族 abort 溯源 + 裸 abort 灭绝**（会诊两份**一致**指出我方 per-call 硬墙**早已存在**，本批只换判定，故体量缩为「换判定 + 两个小件」）；**批 6b = 守卫 E（在途窗口冻结 + 预闸 + 结算侧指纹兜底）**，**排在批 4 之后**（其「被审文件集」键与批 4 折入的 D-35 `designDocKey` **同族**——先落批 4 才不出现同一把键实现两遍，D-35 的教训镜像）；**discarded 墓碑** → **缓议**（我方**零消费者**：无 dependsOn 调度、无 status 单查、无 digest 自动注入通道；事后查询由 DSH 平台 job 注册表承担；最小形态已登记备将来） |
| **批 7** | 可移植性三件（METHODOLOGY 退役 / 提示词去本仓引用 / 判据单一权威） | 实测痛 P4（**19 处**） | ⚠️ glm 排批 8、deepseek 排批 7 —— 父侧取**批 7**（有实测痛，应前于纯能力缺口） |
| **批 8** | 提示词公共层（裁减版） | 能力缺口 + 去重 | ⚠️ glm 排批 7、deepseek 排批 9 —— 父侧取**批 8**。**2026-09-13 追加（订正本行内部矛盾，按 §7 规则记理由）**：本行原文写作「提示词公共层（裁减版）+ **D1–D7 文档纪律**」，但 **§2 的 ENG-DESIGNER 行明写 D1–D7 归「批 11（只取 D1–D7）」**——同一份档内两处冲突。父侧裁定**以 §2 为准**：**D1–D7 留在批 11**，本行移除该半件（批 8 = 纯提示词公共层）。该冲突曾被抄进交接页 §1 的批 8 行，同日一并订正 |
| **批 9** | 测试生命周期三层 + 发布门 + `verify` 宿主侧执行评估 | 能力缺口 | ⚠️ 分歧最大（glm 中高 / deepseek 中）—— 父侧取**批 9**，因 275 测试且持续增长 |
| **批 10** | 台账纪律（指针/触发字段/核销清单）+ D-31 静默丢弃 | 能力缺口 | 仅供参考 |
| **不立项** | §5 全部 | 宿主不同构或无实测痛 | — |

### 两份报告的分歧与裁定

| 分歧点 | glm-5.3 | deepseek-v4-pro | 父侧裁定 |
|---|---|---|---|
| abort 溯源批次 | 批 6 | 批 8 | **批 6** —— 与评审链守卫同族（都是把静默失败变可见），同批做省一次评审 |
| METHODOLOGY 退役批次 | 批 8 | 批 7 | **批 7** —— 它有**实测痛**（19 处写死），应前于纯能力缺口 |
| 测试生命周期价值 | 中高 | 中 | **采 glm** —— 275 用例并在增长，无退役机制会单调膨胀 |
| 写门禁判据 | 未列 | 列为「同款绕过缺陷」 | **判 deepseek 误报**（父侧实测真阳性），改记入 §4 陷阱栏 |
| 公共层价值 | 高 | 中 | **中** —— 我方仅 10 文件，收益低于上游 15 文件规模 |

---

## §7 本档的使用方式

- **排序变更以本档为准**：任何批次的范围/顺序调整，改本档并在 §6 记一行变更理由。
- **落地前再核**：报告给出的「我们现状」在**安全 / 门禁 / 数据 / 凭证**面上**必须再核一次**（本次已抓到一处误报）。
- **反向也成立**：本档列出的「不吸收」不是永久结论 —— 若将来出现实测痛，回到 §2 重新评估。
