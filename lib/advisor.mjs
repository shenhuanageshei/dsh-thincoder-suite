// advisor.mjs — advisor 工具本体：LLM 评审循环 + 收敛协议入口 + design token 生命周期。
// 移植自 thincoder advisor/run.mjs（工具循环/上限/超时/压缩）+ agent-tools/advisor.mjs
//（token 签发与校验）。DSH 适配：LLM 调用走 ctx.llm.stream（GenerateOptions 原生支持
// tools），消息形状为 DSH Message（content 块数组）。
// design token 协议 v2（DESIGN-advisor-token-protocol-fix.md）：token 每评审会话只铸造
// 一次；评审轮只展示 8 位批准码 [APPROVE:<8hex>]（token 本体不进提示词）；签发判定 =
// 裁决通过 ∧ 批准码回显命中，宿主校验命中后自行注入完整 token。
//
// 可配置分层路由（docs/2026-09-01-advisor-config-design.md §3.1–§3.6）：
// - 路由键 = sessionState.advisorRound（缺失视为 0）：0 → round1 组；>= 1 → convergence 组；
// - provider/model 成对解析链（§3.2 单一事实源）：合并后组环（会话覆盖 ⊕ 组字段）→
//   legacy advisor.provider/model（仅 round1，F6）→ 主代理 agent.options → no route；
//   整对下探，禁止跨环混搭；effort/timeoutMs 按字段解析（不要求与模型同环）；
// - effort 透传 reasoningEffort（字段名已对照 dsh-llm GenerateOptions 类型定义核对：
//   call-config.d.ts:19 reasoningEffort?: ReasoningEffortId —— 名称一致，§7 确认项 2）；
// - 预算模型（§3.4）：每轮硬预算 = 该轮组 timeoutMs（round1 缺省 600000 —— REVIEW_TIMEOUT_MS
//   退役为默认值来源；convergence 缺省 300000）。绝对截止（每次 llm.stream 挂 deadline
//   定时器 + chunk 墙钟双检查）优先于 idle 看门狗（90s，窗口 clamp 到 min(90s, deadlineMs)）；
//   裁决顺序：预算到点即 timeout（增强消息，含轮次/已读文件数），stall 仅在预算未耗尽且
//   STREAM_ATTEMPTS 重试全败时返回 provider_stall 诊断。
// D-30（FR-T1/T2）：token 两段化 + 密钥链整体切除后，本模块的 crypto 面只剩 randomUUID
// （token 铸造与续期都要用）；SHA-256（审批码派生 FR-T3 / 文档集指纹 FR-T5）经 doc-hash.mjs
// 单点实现取用，本模块不再 import 任何摘要 API。
import { randomUUID } from "node:crypto"
import { sessionState, engEffective, viewOfSessionState } from "./state.mjs"
import { advisorToolSchemas, advisorToolImpls } from "./readonly-tools.mjs"
import { saveTokenRecord, removeTokenRecord } from "./token-store.mjs"
import { sha256Hex, computeDocHash, normalizeDocPath } from "./doc-hash.mjs"
import { saveSessionState } from "./session-store.mjs"
import { effectiveGlobalConfig, resolveDshBackgroundTimeoutMs } from "./config-store.mjs"
// R5 §7.2（D-27）：resolveDshBackgroundTimeoutMs 经本文件再导出（定义单一事实源在
// config-store.mjs——effectiveGlobalConfig 姊妹 helper；escalate/eng 后续微轮与 advisor
// 同从 advisor.mjs 取该兜底解析，对齐 resolveCodexBudgetCapMs 的消费拓扑先例）。
export { resolveDshBackgroundTimeoutMs }
import { normalizeRunnerValue, resolveCodexCliGlobals, runCodexTask } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"
// 批 6（FR-AP5）：死亡溯源唯一词汇表（trigger/layer 字面只在该模块定义——N-3）
import { timeoutError, annotateAbort, deathLine, abortTag, hostAbortSource } from "./abort-provenance.mjs"
import {
  buildAdvisorSystemPrompt, buildAdvisorUserMessage, appendCitationReport,
  extractUnfixedIssues,
} from "./advisor-msgs.mjs"

export const MAX_ADVISOR_ROUNDS = 5     // 机械收敛上限：第 6 次调用零 LLM 直接拒
const MAX_ADVISOR_TURNS = 100           // 工具轮硬上限（runaway-loop 守卫）
// 上下文窗口预算（2026-09-13 批 5，D-CB8）：**旧的 120K 写死常量已整体退役**（不留别名——防双源
// 漂移；机验锚 = 本符号在 lib/ 递归扫描零命中）——两档改由模型窗口派生（advisorContextBudget，
// 见下方）。0.8/0.8 比例保留，但旧注释的「防进程 OOM」归因已删（量级错误：1M tokens ≈ 8MB
// 字符串，与 V8 堆差两个数量级）。头寸的真实用途四项：① 输出预算（输入输出同窗，
// advisor.maxOutputTokens 默认 16384、可配 65536）② 估算器看不见的 system prompt + tools schema
// ③ 分词漂移 ④ 压缩后增长走廊。

// ————————————— codex runner 平台墙钟与智能回落（二期评审反馈，2026-09-04） —————————————
// DSH 平台对单次同步工具调用有 600s 墙钟（实证：advisor 调用 600000ms 整被
// "wall-clock ceiling reached" 截断，与 thincoder 预算无关）。因此：
// ① codex 评审预算 >540s 一律截到 540s（留 60s 余量给 envelope 返回）——超出部分
//    永远跑不完，截断并告警比无声被平台杀死诚实；
// ② 连续 2 次 codex 失败（TIMEOUT/PROCESS_ERROR/NO_OUTPUT/RUNNER_UNAVAILABLE）→
//    下一轮自动回落 dsh 路由一轮（响亮告警，非静默）；回落成功后计数清零、codex 下轮
//    重试。回落失败不清零（R3 D-07 顺序修正——旧代码在回落执行前清零致 codex↔dsh 无界
//    交替），连续 2 次回落失败硬停（双路由诊断 + 修正指引，不再交替重试——D-裁决-3）。
const CODEX_FAILURE_FALLBACK_THRESHOLD = 2
// 连续失败计数：会话级内存态（不落盘；会话销毁即弃——失败计数不是需要持久化的状态）
const codexFailureCount = new Map() // sessionId → 连续失败次数

// ————————————— R3 §5.1（D-07 / D-裁决-3）：回落封顶与硬停 —————————————
// 计数器语义（设计 §5.1 精确版）：
// - codexFailureCount：codex 路由失败 +1、任一路由成功清零、回落轮结果产出后才执行
//   delete（顺序修正：旧代码在回落执行前 delete——回落失败后计数已清，codex↔dsh 无界
//   交替；新语义下回落失败不清零 → 下一调用直接再进回落轮，连续 2 次回落失败即硬停）；
// - fallbackFailureCount：回落轮失败 +1（含「回落 dsh 路由不可达」形态）、任一路由成功清零；
// - 两计数器独立于 advisorRound（失败不烧轮次）；任何组合的零进度循环在「连续 2 次回落
//   失败」硬停处终止（不再交替重试，D-裁决-3）；
// - 硬停状态（advisorHardStops）需显式动作解除：armed 后同会话后续 advisor 调用持续返回
//   硬停指引而非静默重试，直到配置变更（路由指纹失配自动解除）或会话重置（D-22 清理组）。
const FALLBACK_HARD_STOP_THRESHOLD = 2
const fallbackFailureCount = new Map() // sessionId → 连续回落失败次数
const codexLastFailure = new Map()     // sessionId → 最近一次 codex 失败码（硬停诊断「最近失败码」）
const fallbackLastFailure = new Map()  // sessionId → 最近一次回落失败原因（硬停诊断用）
const advisorHardStops = new Map()     // sessionId → { fingerprint, at }（armed 硬停状态）

/** 任一路由成功 / 会话销毁 → 回落自愈状态全部清零（双计数器 + 最近失败码 + 硬停——硬停防御性同清）。 */
function resetRouteFailureState(sid) {
  codexFailureCount.delete(sid)
  fallbackFailureCount.delete(sid)
  codexLastFailure.delete(sid)
  fallbackLastFailure.delete(sid)
  advisorHardStops.delete(sid)
}

/**
 * R2 §4.5（D-22）：codexFailureCount 会话销毁清理（index.mjs session/disposed 既有清理组
 * 接线——与 clearCodexThread 同生命周期语义：会话死即弃，防进程级滞留跨会话误回落）。
 * R3 §5.1（D-07）：清理范围扩展到回落计数/最近失败码/硬停状态（同一生命周期语义——
 * 硬停随会话重置解除；index.mjs 挂点零改动）。
 * R3 code review 收尾 ③（R4 折入，设计 §6.5）：更名 clearAdvisorRouteFailureState——名称与
 * 实际清理范围对齐（双计数器/最近失败码/硬停，非仅 codex 计数）；旧名保留为导出别名
 * （index.mjs D-22 挂点与既有测试零改动）。
 */
export function clearAdvisorRouteFailureState(sessionId) {
  resetRouteFailureState(String(sessionId ?? ""))
}

/** 旧名兼容别名（R3 code review 收尾 ③）：与新名同一函数引用——既有挂点/测试零改动。 */
export const clearCodexFailureCount = clearAdvisorRouteFailureState

// ————————————— 批 4 §5.3–§5.5：设计评审三振结算护栏（成对吸收的另一半） —————————————
// 存在理由（设计档 §1 成对性）：cap 只对 code 生效后（D-G1），design 侧唯一的界 = **结算健康度**。
// 「跑得通但产不出可用结算」这一类不烧轮次（verdictPassed 才推进 advisorRound）⇒ cap 永不触发；
// 同一文档集连续三次无可用结算 → 后续同键发起被拒（零 LLM、零状态变更）。
//
// 键 = **纯路径形状**（D-G3）：normalizeDocPath → 去重 → 排序 → join("\n")；**只取本次调用的
// documents**；空文档集 → 哨兵键 "empty"（D-G3：空集照计，否则留一个无上界缺口）。
// **绝不用 computeDocHash（内容绑定）**：一次空白编辑即可洗白计数（绕过面）；且 D-30 的 token
// 指纹是**另一条语义**（那里「文档变了 = 新授权对象」）——两处不得统一（防未来「顺手修一致」）。
//
// 载体 = **会话级内存** Map（D-G4，照抄 codexFailureCount/advisorHardStops 先例与成文理由：
// 失败计数不是需要持久化的状态）。落盘会制造两条上游明令禁止的解除轴（重启复活 / TTL 自动
// 解除），故**不进** session-state.json 白名单。清理**只**挂 session/disposed（D-G9：与硬停轴
// 正交、不可自解除；**不挂** resetRouteFailureState——那是「路由成功即复位」语义，会破坏
// 「垃圾结算不清零」）。
export const DESIGN_STRIKE_LIMIT = 3
const designSettlementStrikes = new Map() // sessionId → Map(docKey → { count, kinds: [≤3], lastAt })

/**
 * 设计评审作用域键（D-G3：**纯路径形状**，键的唯一实现来源 = doc-hash.normalizeDocPath）。
 * 不折叠大小写（对齐 normalizeDocPath 与 D-30 指纹的既有裁定 G-4：同文件两种大小写 = 两个键）。
 * 该函数同时是**三振计数键**与**链作用域键**（D-G13/N-7：同一语义只有一处实现）。
 * @param {unknown} documents
 * @returns {string} 归一化路径表 join("\n")；空集 → 哨兵 "empty"
 */
export function designDocKey(documents) {
  const list = (Array.isArray(documents) ? documents : []).filter(d => typeof d === "string" && d.trim() !== "")
  if (list.length === 0) return "empty" // 哨兵（D-G3：空集照计）
  return [...new Set(list.map(normalizeDocPath))].sort().join("\n")
}

/**
 * 链作用域键的**持久化表示**（§12 FR-G9 / N-7 —— 与计数器键同一把键的等值形态）。
 *
 * 为什么不是 `designDocKey(documents)` 原文落盘：本仓既有硬约束 **AC-20**
 *（`test/session-state.test.mjs`，属「既有测试零修改」面，不得改）规定会话状态镜像
 * `session-state.json` 里**一个字都不得出现**被绑定的文档路径（D-30 同源纪律：文档路径/指纹
 * 与 token 同域，会话状态镜像只做第二存储）。而 raw docKey **就是**归一化绝对路径表 ⇒ 原样落盘
 * 直接违反该既有断言（实测：AC-20 转红于 `绑定路径不得出现`）。
 *
 * 故落盘值 = `sha256Hex(designDocKey(documents))`：**派生自同一实现**（D-G13 不新造第二种键——
 * 键的派生只有 `designDocKey` 一处），语义恰是等值判定（本字段唯一消费者 = `chainKeyChanged`
 * 的比较），**往返同值**（AC-G11 ②）。内存态与恢复态**一律**用同一 digest 形态（混用会让重启后
 * 的等值判定永久失配 = 每次重启都误判「换了文档集」）。
 * 计数器的键仍是 raw docKey（D-G3 不变，且拒绝串要展示**归一文档集**——见 settlementGuardText）。
 * @param {unknown} documents
 * @returns {string} sha256 hex
 */
export function designChainKey(documents) {
  return sha256Hex(designDocKey(documents))
}

/**
 * 该会话该文档集已有的连败计数（**纯读**——预检用，零副作用）。未记录 → 0。
 * @param {string} sid
 * @param {string} docKey
 * @returns {number}
 */
export function designStrikes(sid, docKey) {
  return designSettlementStrikes.get(String(sid ?? ""))?.get(docKey)?.count ?? 0
}

/** 会话销毁清理（index.mjs session/disposed 挂点，与 clearCodexFailureCount 并排）。 */
export function clearDesignSettlementStrikes(sid) {
  designSettlementStrikes.delete(String(sid ?? ""))
}

/**
 * 结算打点（§5.4 计数触发面）。`kind === null` ⇒ **可用判决** ⇒ 复位该键（§5.4 复位面）；
 * 否则 +1（kinds 只留最近 3 —— 拒绝串要展示「最近三次的失败 kind」）。
 * 非 design 调用传 docKey=null（调用方以 reviewType 为门）——本函数零副作用直接返回。
 * @param {string} sid
 * @param {string|null} docKey
 * @param {string|null} kind
 */
export function recordDesignSettlement(sid, docKey, kind) {
  if (!docKey) return
  const key = String(sid ?? "")
  let m = designSettlementStrikes.get(key)
  if (kind === null) {
    m?.delete(docKey) // 可用判决 → 复位（无记录时无事发生）
    return
  }
  if (!m) { m = new Map(); designSettlementStrikes.set(key, m) }
  const e = m.get(docKey) ?? { count: 0, kinds: [], lastAt: 0 }
  e.count += 1
  e.kinds = [...e.kinds, kind].slice(-3)
  e.lastAt = Date.now()
  m.set(docKey, e)
}

/** 前缀表（D-G5 契约面：顺序有意义——先匹配者胜）。 */
const SETTLEMENT_PREFIXES = [
  ["Advisor: context window limit reached", "context_limit"],
  ["Advisor: stopped after", "turn_cap"],
  ["Advisor: review timeout after", "timeout"],
  ["Advisor: review failed (empty response", "empty"],
  ["Advisor: interrupted.", "interrupted"],
]

/**
 * 结算 kind 归类（FR-G5；**机械事实优先，散文只做兜底**，D-G5）。
 * 前缀表 = 本插件**自产串**的契约（与 finalize 的 startsWith("Advisor:") 同族）——改文案即红。
 * kindHint（站点机械事实）优先：stale / token_persist_failed / backstop→timeout 由调用点直传。
 * 不以 "Advisor:" 开头 = 完成态，返回 null（由调用方按可用判决另行判定）。
 * @param {unknown} text
 * @param {string} [kindHint]
 * @returns {string|null}
 */
export function classifySettlement(text, kindHint) {
  if (kindHint) return kindHint
  const t = String(text ?? "").trimStart()
  for (const [p, k] of SETTLEMENT_PREFIXES) if (t.startsWith(p)) return k
  return t.startsWith("Advisor:") ? "review_failed" : null
}

/**
 * 七 kind 的可行动指引（§5.5 + §13 #7：**允许统一兜底句式，但七 kind 必须全覆盖**）。
 * 顺序 = 计数面 §5.4 的枚举顺序（稳定，可断言）。
 *
 * 批 6b（守卫 E / D-E8）：**保持七行不扩**——守卫 E 的「签发前指纹失配（漂移）」**不属**计数面：
 * 七 kind 无一例外是**管线自身**的故障（其指引全是「改我方配置/参数/路由」），而漂移是管线
 * **工作正常**（PASS + 回显命中）而外部改了文件。把外部失误计成管线失败，会让本表的「最近三次
 * kind」诊断面指向**错误的修法**（与批 6 全批在修的「把不同死因坍缩成一句话」同族）。漂移分支
 * 因此早返回、对 `recordDesignSettlement` 零调用，**不**新增第 8 kind、**不**复用 `stale`
 *（后者的机械定义是「job 完成但 finalize 被跳过（代际失配）」，与 finalize **内部**的漂移是两回事）。
 * 防将来「顺手修一致」把漂移塞进计数面。
 */
const SETTLEMENT_KIND_GUIDANCE = [
  ["timeout", "raise advisor.round1/convergence.timeoutMs or switch the runner"],
  ["context_limit", "narrow the document set or configure advisor.contextTokens"],
  ["empty", "raise advisor.maxOutputTokens or switch the model"],
  ["turn_cap", "narrow the review scope (the tool-round cap was hit)"],
  ["stale", "confirm no concurrent writer touched this session's state, then re-issue"],
  ["token_persist_failed", "check that $DSH_HOME/.thincoder is writable"],
  ["review_failed", "read this round's diagnostic msg (switch route/model if needed)"],
]

/**
 * 护栏拒绝串（D-G7/D-G8 + §5.5 钉死形状；P-a：第一行即结论，诊断后置）。
 * 必备六项：计数 `N/3` · 归一文档集 · 最近三次 kind · **不可自解除**声明 · **唯一出口 = 新会话**
 * · **防乒乓**行（+ 按 kind 可行动指引）。`"Advisor:"` 前缀 = finalize 的 completed 判定的
 * 机械契约（即使被误送进 finalize 也天然是失败态：不写 prior、不推进轮次、不签发）。
 * 不做 unfixed 提取（P-b：被护栏挡住的 doc-set 按定义没有可用 prior）。
 * @param {string} sid
 * @param {string} docKey
 * @returns {string}
 */
export function settlementGuardText(sid, docKey) {
  const entry = designSettlementStrikes.get(String(sid ?? ""))?.get(docKey)
  const count = entry?.count ?? 0
  // 批 4 评审微修 #4：**展示**封顶——count 无内部封顶（在飞 job 晚 settle 可推进到 4、5…），
  // 而护栏串的语义是「已到上限」，`4/3` 这种显示会自相矛盾。**内部计数仍是真实 count**（只改展示），
  // 在飞晚结算不改变「已到上限」的表述。既有断言以 `3/3` 为准，保持绿。
  const shownCount = Math.min(count, DESIGN_STRIKE_LIMIT)
  const kinds = Array.isArray(entry?.kinds) ? entry.kinds : []
  const docs = docKey === "empty" ? [] : String(docKey).split("\n")
  let text = "Advisor: design review blocked by the settlement guard ("
    + shownCount + "/" + DESIGN_STRIKE_LIMIT + " for this document set).\n"
  text += "\nDocument set (normalized):\n"
  text += docs.length > 0
    ? docs.map(d => "- " + d).join("\n") + "\n"
    : "- (none — empty document set; the guard counts the empty set as its own scope)\n"
  text += "\nRecent settlement failures (oldest → newest): "
    + (kinds.length > 0 ? kinds.join(" → ") : "(none recorded)") + "\n"
  text += "\nThis guard cannot be cleared inside this session — editing the documents, changing advisor\n"
  text += "config, or reverting files does NOT reset it. Only a new session starts a fresh count.\n"
  text += "\nWhat to do (by failure kind — the recent kinds above are the ones that count):\n"
  for (const [k, g] of SETTLEMENT_KIND_GUIDANCE) {
    text += "- " + k + " → " + g + (kinds.includes(k) ? "  ← seen in this document set" : "") + "\n"
  }
  text += "\nIf you were sent here by an eng_coder renewal refusal (\"documents changed — re-run the design review\"):\n"
  text += "the exit is a NEW SESSION — do not retry in this one.\n"
  return text
}

/**
 * R3 §5.1（D-07）：advisor 路由配置指纹（硬停解除判据——「配置变更」）。覆盖双路由解析的
 * 全部输入：advisor 组配置（含 legacy / 组内 runner / provider/model/effort/timeoutMs）⊕
 * codexCli 全局节 ⊕ 会话覆盖 ⊕ 主代理路由。任一变更（advisor_config set/reset、全局设置页
 * 保存、agent 路由变化）→ 指纹失配 → 硬停自动解除。
 */
function advisorRouteFingerprint(config, override, agentOpts) {
  try {
    return JSON.stringify({
      advisor: config?.advisor ?? null,
      codexCli: config?.codexCli ?? null,
      override: override ?? null,
      agent: { provider: agentOpts?.provider ?? null, model: agentOpts?.model ?? null },
    })
  } catch { return "unserializable" } // 病态不可序列化配置：恒等指纹（硬停持续——诚实保守）
}

/** 回落轮失败 +1 并记录最近失败原因（硬停诊断用）。返回新计数（封顶 99）。 */
function bumpFallbackFailure(sid, reason) {
  const n = Math.min((fallbackFailureCount.get(sid) ?? 0) + 1, 99)
  fallbackFailureCount.set(sid, n)
  fallbackLastFailure.set(sid, String(reason ?? "").slice(0, 200))
  return n
}

/**
 * R3 §5.1（D-07 / D-裁决-3）：硬停文本——「双路由皆不可用」+ 配置诊断（codex 路由与 dsh
 * 回落路由各自状态、最近失败码）+ 修正指引（网络/代理、runner 切换、provider 检查）+
 * 解除方式。arm 时与 held 时共用（held 期间路由指纹未变，诊断等价；路由按当前
 * advisorRound 现解析——诊断保持新鲜）。
 */
function fallbackHardStopText(sid, { config, override, agentOpts, advisorRound }) {
  const route = resolveAdvisorRoute({ config, override, agentOpts, advisorRound })
  const fbRoute = resolveAdvisorRoute({ config, override, agentOpts, advisorRound, ignoreRunner: true })
  const lines = [
    "Advisor: 回落硬停——codex 与 dsh 双路由皆不可用（连续 " + FALLBACK_HARD_STOP_THRESHOLD
      + " 次回落失败，D-裁决-3：自愈循环终止，不再交替重试）。",
    "",
    "双路由配置诊断：",
  ]
  if (route.ok && route.runner?.kind === "codex-cli") {
    lines.push("- codex 路由: runner=codex-cli" + (route.model ? " model=" + route.model : "")
      + "，timeoutMs=" + route.timeoutMs + " —— 连续失败 " + (codexFailureCount.get(sid) ?? 0)
      + " 次，最近失败码: " + (codexLastFailure.get(sid) ?? "未知"))
  } else if (route.ok) {
    lines.push("- codex 路由: 当前组未配 codex runner（走 " + route.provider + ":" + route.model
      + "）—— 硬停源于回落轮连续失败")
  } else {
    lines.push("- codex 路由: 路由解析失败（provider/model 解析链耗尽）")
  }
  if (fbRoute.ok) {
    lines.push("- dsh 回落路由: " + fbRoute.provider + ":" + fbRoute.model + " —— 回落轮连续失败 "
      + (fallbackFailureCount.get(sid) ?? 0) + " 次，最近失败: " + (fallbackLastFailure.get(sid) ?? "未知"))
  } else {
    lines.push("- dsh 回落路由: 不可用（组内未配 provider/model、无 legacy、主代理无默认路由）")
  }
  lines.push(
    "",
    "修正指引：",
    "1. 网络/代理：检查出网与代理配置（codexCli.proxyMode/proxyUrl、环境代理变量）——TIMEOUT/PROCESS_ERROR 的常见根因；",
    "2. runner 切换：codex 持续不可用可把 advisor 组 runner 改回 dsh（或清空 runner 走 provider/model）；",
    "3. provider 检查：确认 dsh 回落路由的 provider/model 在运行时可用（advisor_config set round1.provider/round1.model，或全局设置页）。",
    "",
    "硬停解除：变更 advisor 相关配置（advisor_config set/reset 或全局设置页保存）或重置会话后自动恢复；配置未变更前，本会话后续 advisor 调用将持续返回本指引（不静默重试）。",
  )
  return lines.join("\n")
}

/**
 * R3 §5.1（D-07 / D-裁决-3）：武装硬停（记录路由指纹供「配置变更」解除判据）并返回硬停
 * 文本。armed 后同会话后续 advisor 调用在 runAdvisorReview 入口被 held（见入口检查）。
 */
function armFallbackHardStop(sid, ctx) {
  advisorHardStops.set(sid, {
    fingerprint: advisorRouteFingerprint(ctx.config, ctx.override, ctx.agentOpts),
    at: Date.now(),
  })
  console.warn("[thincoder-suite] advisor 回落硬停（连续 " + FALLBACK_HARD_STOP_THRESHOLD
    + " 次回落失败——codex 与 dsh 双路由皆不可用，自愈循环终止；配置变更或会话重置后恢复）")
  return fallbackHardStopText(sid, ctx)
}

// ————————————— 预算模型（docs/2026-09-01-advisor-config-design.md §3.4） —————————————
const REVIEW_TIMEOUT_MS = 600_000               // 退役常量：现在是 round1 组 timeoutMs 的缺省值来源
const CONVERGENCE_TIMEOUT_DEFAULT_MS = 300_000  // convergence 组 timeoutMs 缺省值
/** timeoutMs 合法区间（导出：config-store/API 校验与工具 coercion 的单一事实源，评审 #5）。 */
export const ADVISOR_TIMEOUT_MIN_MS = 1000
export const ADVISOR_TIMEOUT_MAX_MS = 3_600_000
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"]
const LLM_CALL_STALL_MS = 90_000        // idle 看门狗窗口（不再配置化，YAGNI，§3.4）
const STREAM_ATTEMPTS = 3               // 看门狗 stall 时的单调用重试次数（瞬时 provider 挂起自愈）
// D-01 热修正式化（R1 §3.6，2026-09-05 热修 8192→16384 的配置化收口）：单次 LLM 输出预算
// 可配 advisor.maxOutputTokens（缺省 16384；合法 4096..65536）。三面白名单同步（N-5/US-10）：
// index.mjs PUT 校验 ⊕ config-store.mjs merge 白名单 ⊕ 本模块运行时读取（越界回落缺省+告警）。
export const ADVISOR_MAX_OUTPUT_TOKENS_MIN = 4096
export const ADVISOR_MAX_OUTPUT_TOKENS_MAX = 65536
export const ADVISOR_MAX_OUTPUT_TOKENS_DEFAULT = 16384
const LLM_MAX_TOKENS = ADVISOR_MAX_OUTPUT_TOKENS_DEFAULT // 缺省值来源（运行时经 resolveAdvisorMaxOutputTokens 读取配置）

// ————————————— 批 5：评审上下文预算跟随模型窗口（FR-CB1/FR-CB2） —————————————
// 窗口来源 = 三级链（docs/2026-09-13-context-budget-design.md D-CB1）：手配 advisor.contextTokens
// > 运行时权威 llm.resolveModelInfo(...).context.contextWindow > 保守兜底 131072。逐级 fail-open。
// 两档比例式（D-CB3）：limit = floor(窗口 × 0.8)（判死线）· compactAt = floor(limit × 0.8)
//（本地压缩触发）——**两次 floor**，逐值由 §5.2 表钉死。
export const CONTEXT_FALLBACK_WINDOW_TOKENS = 131_072 // 保守兜底（= 2^17；非 DSH 声明缺省 262144，理由 D-CB2）
export const CONTEXT_LIMIT_RATIO = 0.8                // 判死线 = 窗口 × 0.8
export const COMPACT_TRIGGER_RATIO = 0.8              // 压缩触发 = 判死线 × 0.8
export const ADVISOR_CONTEXT_TOKENS_MIN = 16_384
export const ADVISOR_CONTEXT_TOKENS_MAX = 4_194_304

// 默认 TTL 7d（D-30 / FR-T4）：TTL 只是**陈旧度护栏**，不再是「短生命周期凭证」式的安全边界
// （D-30 已删除签名腿与密钥链——见 §2.3 威胁模型；授权与时限解耦，文档集未变即可续期 FR-T5）。
// profile 配置 engTokenTtlMs 可覆盖（D-29 已把该键并入 user 层白名单，值域 10min..30d）——
// 实际常量与解析函数见下方 design token 段的 TOKEN_TTL_DEFAULT_MS / resolveEngTokenTtlMs。

// ————————————— D-30（FR-T2）：旧密钥链（D-25）已整体删除 —————————————
// 旧 D-25 密钥链（密钥文件路径解析 / 密钥解析 / 进程内单例 / 公开默认值回落）随签名腿一并删除。
// 删除依据（需求档 §2.3，会诊判定 + 父侧回代码核实）：门禁刻意 fail-open（eng.mjs:167）→ 它是
// 纪律护栏而非安全边界；真正挡住伪造的是记录**全等匹配**（eng.mjs）；密钥与 token 镜像同目录
// （能写后者者几乎必然能读前者，Windows 上 0600 权限近似 no-op）；净效果为负（密钥链换来启动
// 全量作废 + 一条独立运维失效轴，防伪造增量 ≈ 0）。上游 thincoder 已独立得出同判并删除签名段。
// 删除后的两处静默（设计评审 #9）已在别处显式处理：
//   ① 旧密钥环境变量变为无声 no-op → index.mjs 启动路径打印**一次性弃用告警**；
//   ② 磁盘上 `.thincoder/` 内的旧密钥文件成孤儿 → **声明不清理、留档**（删除属破坏性动作，
//      不在本批范围；README 注明其已被弃用）。

// ————————————— 组配置解析辅助（§3.1/§3.2/§3.3） —————————————
// 校验 helper 导出（评审 #5：消除 dead-export 双实现）——host API（config PUT 端点/表单校验）
// 复用本组导出，不重写；数值边界（ADVISOR_TIMEOUT_MIN/MAX_MS）与 effort 枚举同源导出。

/** effort 只认枚举 off|low|medium|high|max。 */
export function isValidEffort(v) { return typeof v === "string" && EFFORT_LEVELS.includes(v) }
/** timeoutMs 只认 1000..3600000 的有限数字。 */
export function isValidTimeoutMs(v) {
  return typeof v === "number" && Number.isFinite(v)
    && v >= ADVISOR_TIMEOUT_MIN_MS && v <= ADVISOR_TIMEOUT_MAX_MS
}
/** provider/model 字段只认非空字符串（注册表检测在二期 API/UI，§3.9）。 */
export function isModelField(v) { return typeof v === "string" && v.trim() !== "" }
/** engCoderMaxTokens 只认正整数（U3：非正整数 → 表单内联报错；运行期解析仍接受正有限数，N4 宽容）。 */
export function isValidEngCoderMaxTokens(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && Number.isInteger(v)
}
/** advisor.maxOutputTokens 只认 4096..65536 整数（D-01/R1 §3.6：PUT 校验与运行时回落共用单一事实源）。 */
export function isValidAdvisorMaxOutputTokens(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
    && v >= ADVISOR_MAX_OUTPUT_TOKENS_MIN && v <= ADVISOR_MAX_OUTPUT_TOKENS_MAX
}

/**
 * 运行时解析 advisor.maxOutputTokens（§3.6）：未配 → 缺省 16384；越界/非法 → 回落缺省并
 * console.warn 响亮告警（N4 先例：非法配置值不砖化评审，回落+可见）。
 * @param {object} config — 生效全局配置（effectiveGlobalConfig 输出）
 * @returns {number} 生效的单次 LLM 输出预算
 */
export function resolveAdvisorMaxOutputTokens(config) {
  const adv = (config && typeof config.advisor === "object" && !Array.isArray(config.advisor)) ? config.advisor : {}
  const raw = adv.maxOutputTokens
  if (raw === undefined || raw === null) return LLM_MAX_TOKENS
  if (isValidAdvisorMaxOutputTokens(raw)) return raw
  console.warn("[thincoder-suite] advisor.maxOutputTokens " + JSON.stringify(raw)
    + " 非法（需要 " + ADVISOR_MAX_OUTPUT_TOKENS_MIN + ".." + ADVISOR_MAX_OUTPUT_TOKENS_MAX + " 的整数）——回落缺省 " + LLM_MAX_TOKENS)
  return LLM_MAX_TOKENS
}

/**
 * 预算派生（FR-CB2，纯函数，可直测）：窗口 → { limit, compactAt, window }。
 * 两次 floor（先 limit 后 compactAt）——与「先派生上限再乘比例」的既有结构同形；设计 §5.2
 * 钉死两次 floor（与 floor(w × 0.64) 在 131072 上差 1 token：83885 vs 83886，由 AC-CB1 锁定）。
 * 非法/非正窗口 → 回落兜底窗派生（不抛——N-3 fail-open）。
 * @param {number} windowTokens — 模型窗口（tokens）
 * @returns {{ limit: number, compactAt: number, window: number }}
 */
export function advisorContextBudget(windowTokens) {
  const w = (Number.isFinite(windowTokens) && windowTokens > 0)
    ? Math.floor(windowTokens) : CONTEXT_FALLBACK_WINDOW_TOKENS
  const limit = Math.floor(w * CONTEXT_LIMIT_RATIO)
  const compactAt = Math.floor(limit * COMPACT_TRIGGER_RATIO)
  return { limit, compactAt, window: w }
}

/** advisor.contextTokens 只认 16384..4194304 整数（FR-CB5：PUT 校验与运行时解析共用单一事实源）。 */
export function isValidAdvisorContextTokens(v) {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
    && v >= ADVISOR_CONTEXT_TOKENS_MIN && v <= ADVISOR_CONTEXT_TOKENS_MAX
}

/**
 * 运行时解析 advisor.contextTokens（FR-CB5）：未配（键不存在/null）→ null（下探 L2）；
 * 越界/非法 → console.warn + 视为未配（**不是**直接落兜底——用户的意图是「给它一个窗口」，
 * 配置打错时权威值比猜值更可信，设计 §5.1）。
 * @param {object} config — 生效全局配置（effectiveGlobalConfig 输出）
 * @returns {number|null} 手配窗口；null = 未配或非法
 */
export function resolveAdvisorContextTokens(config) {
  const adv = (config?.advisor && typeof config.advisor === "object" && !Array.isArray(config.advisor))
    ? config.advisor : {}
  const raw = adv.contextTokens
  if (raw === undefined || raw === null) return null
  if (isValidAdvisorContextTokens(raw)) return raw
  console.warn("[thincoder-suite] advisor.contextTokens " + JSON.stringify(raw)
    + " 非法（需要 " + ADVISOR_CONTEXT_TOKENS_MIN + ".." + ADVISOR_CONTEXT_TOKENS_MAX + " 的整数）——忽略并下探运行时窗口")
  return null
}

/**
 * 窗口解析链（FR-CB1，异步旁路，fail-open）：L1 手配 → L2 运行时权威 → L3 保守兜底。
 * 与 resolveSupportedEffort 同源同缝（同一 llm 句柄 / 同一路由对象；解析为进程内调用）。
 * 任一层的失败都不抛出（N-3）：命中失败 → console.warn + 非空 note（post-finalize 后缀用）。
 * @param {object|null} llm — ctx.llm 运行时服务
 * @param {string} provider
 * @param {string} model
 * @param {object} config — 生效全局配置
 * @returns {Promise<{ window: number, source: "config"|"runtime"|"fallback", note: string|null }>}
 */
export async function resolveAdvisorContextWindow(llm, provider, model, config) {
  // L1 手配（命中即止；非法值已在上游告警并返回 null → 下探 L2）
  const cfgWin = resolveAdvisorContextTokens(config)
  if (cfgWin !== null) return { window: cfgWin, source: "config", note: null }

  // L3 兜底出口（元数据不可得的三种成因 + 门面构建）
  const bud = advisorContextBudget(CONTEXT_FALLBACK_WINDOW_TOKENS)
  const fail = (reason) => {
    const note = "评审上下文窗口 = " + CONTEXT_FALLBACK_WINDOW_TOKENS + "（保守兜底；原因：" + reason + "）"
      + "——压缩触发 " + bud.compactAt + " / 判死 " + bud.limit
      + "。若该模型窗口更大，请在设置页配置 advisor.contextTokens。"
    console.warn("[thincoder-suite] " + note)
    return { window: CONTEXT_FALLBACK_WINDOW_TOKENS, source: "fallback", note }
  }

  // L2 运行时权威（适配器最终值：覆盖 settings.yaml 查不到的内置路由）
  if (!llm || typeof llm.resolveModelInfo !== "function") return fail("llm 运行时不可用/无 resolveModelInfo")
  if (!provider || !model) return fail("provider/model 未知")
  let info = null
  try { info = await llm.resolveModelInfo(provider, model) }
  catch (e) { return fail("元数据查询失败：" + (e?.message ?? String(e))) }
  const w = info?.context?.contextWindow
  if (!Number.isInteger(w) || w <= 0) return fail("适配器未提供 context.contextWindow")
  return { window: w, source: "runtime", note: null }
}

/**
 * 会话级覆盖的合法组内字段（advisor_config 工具校验用，§3.6）。
 * R4 §6.2（D-13）：增 runner——与 apply-session（index.mjs validateAdvisorGroup/sanitizeGroup
 * 一期已接受）和 session-store 持久化白名单三面同步（校验走 normalizeRunnerValue）。
 */
export const ADVISOR_OVERRIDE_GROUP_PATHS = ["provider", "model", "effort", "timeoutMs", "runner"]

/**
 * 路由键 → 组名（§3.2）：sessionState.advisorRound 缺失/undefined 视为 0 → round1；
 * >= 1 → convergence（round 2/3/4/5 全用同一组）。
 */
export function advisorGroupKey(advisorRound) {
  return (Number(advisorRound) || 0) >= 1 ? "convergence" : "round1"
}

/**
 * 组配置解析（§3.2 单一事实源 + §3.6 字段级浅合并 + §3.3 effort 按字段解析）。
 * 解析链：合并后组环（会话覆盖 ⊕ 组字段）→ legacy advisor.*（仅 round1，F6）→ 主代理路由。
 * - provider/model 成对约束：最终 pair 必须来自同一解析环，禁止跨环混搭；合并后组环缺
 *   provider 或 model 时整对下探下一环（会话覆盖字段被忽略时输出 N4 警告，T20）；
 * - effort/timeoutMs 按字段解析（不要求与模型同环）；非法值（effort 非枚举 / timeoutMs
 *   非 1000..3600000 数）忽略并警告（N4，T3/T13）；effort 与模型环不一致时 N4 跨环警告（T21）；
 * - timeoutMs 缺省：round1 600000（REVIEW_TIMEOUT_MS 退役来源）/ convergence 300000。
 * @returns {ok:true, groupKey, provider, model, pairSource, effort, effortSource,
 *          timeoutMs, timeoutSource, warnings} | {ok:false, groupKey, warnings}
 */
export function resolveAdvisorRoute({ config, override, agentOpts, advisorRound, ignoreRunner }) {
  const warnings = []
  const warn = (m) => warnings.push("advisor config warning: " + m)
  const groupKey = advisorGroupKey(advisorRound)
  const advisorCfg = (config && typeof config === "object" && config.advisor
    && typeof config.advisor === "object") ? config.advisor : {}
  const overrideG = (override && typeof override === "object" && override[groupKey]
    && typeof override[groupKey] === "object") ? override[groupKey] : {}
  const globalG = (advisorCfg[groupKey] && typeof advisorCfg[groupKey] === "object")
    ? advisorCfg[groupKey] : {}
  // legacy advisor.provider/model/timeoutMs 只在 round1 生效（F6 兼容，§3.1）
  const legacy = groupKey === "round1" ? advisorCfg : null
  const agent = (agentOpts && typeof agentOpts === "object") ? agentOpts : {}

  // —— 合并后组环字段（字段级：override 有效则用，否则 global；非法值忽略并警告）——
  const eff = {}        // 合并后组环的有效字段
  const effSource = {}  // 每个字段的环内来源（session override | global config）
  const validOf = (key) => key === "effort" ? isValidEffort
    : key === "timeoutMs" ? isValidTimeoutMs
    : key === "runner" ? ((v) => normalizeRunnerValue(v).ok)
    : isModelField
  const expected = (key) => key === "effort"
    ? "one of off|low|medium|high|max"
    : key === "timeoutMs"
      ? "a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS
      : key === "runner"
        ? "\"codex-cli\" or an object { kind: \"codex-cli\", model?, effort?, sandbox?, timeoutMs?, proxy?, agentsMd? }"
        : "a non-empty string"
  for (const key of ["provider", "model", "effort", "timeoutMs", "runner"]) {
    const ok = validOf(key)
    const ro = overrideG[key]
    const rg = globalG[key]
    if (ro !== undefined && ro !== null) {
      if (ok(ro)) { eff[key] = ro; effSource[key] = "session override" }
      else warn("ignoring invalid session override " + groupKey + "." + key + " = "
        + JSON.stringify(ro) + " (expected " + expected(key) + ")")
    }
    if (eff[key] === undefined && rg !== undefined && rg !== null) {
      if (ok(rg)) { eff[key] = rg; effSource[key] = "global config" }
      else warn("ignoring invalid " + groupKey + "." + key + " = " + JSON.stringify(rg)
        + " (expected " + expected(key) + ")")
    }
  }

  // —— codex runner 分支（一期 codex-runner）：runner.kind=codex-cli 时整组走 codex 子进程，
  // 不要求 llm-pi-ai 的 provider/model 成对（model 缺省回落 codexCli.model 或 codex 自身默认）。
  // ignoreRunner=true（智能回落）时跳过本分支走既有链。runner 生效但组内显式配了
  // provider/model → 告警（用户反馈的 UX 陷阱：改 provider/model 以为切回 glm，实际被 runner 覆盖）。
  let runner = null, runnerSource = null
  if (eff.runner !== undefined && !ignoreRunner) {
    const nr = normalizeRunnerValue(eff.runner)
    if (nr.ok) { runner = nr.runner; runnerSource = effSource.runner ?? null }
  }
  if (runner && runner.kind === "codex-cli") {
    if (eff.provider !== undefined || eff.model !== undefined) {
      warnings.push("runner=codex-cli 生效中——组内 provider/model（"
        + [eff.provider, eff.model].filter(Boolean).join(":")
        + "）被忽略：codex 行不走 HTTP 路由；要切回 glm 等 dsh 模型，请把 runner 改回 dsh 或清空")
    }
    // R1 code review 折入（R2 §4.5）：resolveCodexCliGlobals 的 warnings 并入 route.warnings
    //（手编 config 的非法 codexCli 值在 codex 路由下运行时同样响亮告警——此前该分支只取
    // model 字段，非法值静默；warnings 经 runAdvisorReview 的 console.warn + warnPrefix 上浮）
    const cg = resolveCodexCliGlobals(config)
    for (const w of cg.warnings) warnings.push(w)
    const codexModel = runner.model ?? cg.globals.model
    const rEffort = runner.effort !== undefined
      ? runner.effort
      : (eff.effort !== undefined ? eff.effort : null)
    const rEffortSource = rEffort === null
      ? null
      : (runner.effort !== undefined ? "codex runner" : (effSource.effort ?? null))
    // timeout：runner.timeoutMs > 组环 > legacy(round1) > 缺省
    let timeoutMs, timeoutSource
    if (runner.timeoutMs !== undefined && isValidTimeoutMs(runner.timeoutMs)) {
      timeoutMs = runner.timeoutMs; timeoutSource = "codex runner"
    } else if (eff.timeoutMs !== undefined) {
      timeoutMs = eff.timeoutMs; timeoutSource = effSource.timeoutMs ?? null
    } else if (legacy && legacy.timeoutMs !== undefined && legacy.timeoutMs !== null && isValidTimeoutMs(legacy.timeoutMs)) {
      timeoutMs = legacy.timeoutMs; timeoutSource = "legacy advisor.*"
    } else {
      timeoutMs = groupKey === "convergence" ? CONVERGENCE_TIMEOUT_DEFAULT_MS : REVIEW_TIMEOUT_MS
      timeoutSource = "default"
    }
    return {
      ok: true, groupKey, provider: "codex-cli", model: codexModel, pairSource: "codex runner",
      effort: rEffort, effortSource: rEffortSource,
      timeoutMs, timeoutSource,
      runner, runnerSource, warnings,
    }
  }

  // —— provider/model 成对解析（整对下探，禁止跨环混搭）——
  let provider = null, model = null, pairSource = null
  if (eff.provider !== undefined && eff.model !== undefined) {
    provider = eff.provider; model = eff.model
    pairSource = effSource.provider === effSource.model
      ? effSource.provider
      : "session override + global config"
  } else {
    const mergedPartial = eff.provider !== undefined || eff.model !== undefined
    const overridePartial = overrideG.provider !== undefined || overrideG.model !== undefined
    if (mergedPartial && overridePartial) {
      // 组环合并后缺 provider/model 其一 → 整对下探；会话覆盖字段被忽略（§3.2 工作示例第 3 行，T20）
      const dropped = ["provider", "model"].filter(k =>
        overrideG[k] !== undefined && overrideG[k] !== null)
      warn("session override fields " + groupKey + "." + dropped.join("/")
        + " cannot be applied — merged " + groupKey
        + " group has no complete provider/model pair; the whole pair falls through the resolution chain")
    }
    if (legacy) {
      const lp = legacy.provider, lm = legacy.model
      if (lp !== undefined && lp !== null && !isModelField(lp))
        warn("ignoring invalid legacy advisor.provider = " + JSON.stringify(lp) + " (expected a non-empty string)")
      if (lm !== undefined && lm !== null && !isModelField(lm))
        warn("ignoring invalid legacy advisor.model = " + JSON.stringify(lm) + " (expected a non-empty string)")
      if (isModelField(lp) && isModelField(lm)) {
        provider = lp; model = lm; pairSource = "legacy advisor.*"
      } else if (isModelField(agent.provider) && isModelField(agent.model)) {
        provider = agent.provider; model = agent.model; pairSource = "agent route"
      }
    } else if (isModelField(agent.provider) && isModelField(agent.model)) {
      provider = agent.provider; model = agent.model; pairSource = "agent route"
    }
  }
  if (provider === null || model === null) {
    return { ok: false, groupKey, warnings }
  }

  // —— effort（按字段解析；缺省不传，用适配器默认）——
  const effort = eff.effort !== undefined ? eff.effort : null
  const effortSource = eff.effort !== undefined ? effSource.effort : null
  if (effort !== null && pairSource !== "session override" && pairSource !== "global config"
    && pairSource !== "session override + global config") {
    // §3.3 跨环警告：effort 的解析环（组环）≠ provider/model 的解析环（T21）
    warn("effort " + JSON.stringify(effort) + " (from " + effortSource
      + ") applies to a provider/model pair resolved from " + pairSource
      + " — the effort ring differs from the model ring (effort may target a different model's reasoning profile)")
  }

  // —— timeoutMs（按字段解析：组环 → legacy → 缺省）——
  let timeoutMs = eff.timeoutMs
  let timeoutSource = eff.timeoutMs !== undefined ? effSource.timeoutMs : null
  if (timeoutMs === undefined && legacy && legacy.timeoutMs !== undefined && legacy.timeoutMs !== null) {
    if (isValidTimeoutMs(legacy.timeoutMs)) {
      timeoutMs = legacy.timeoutMs
      timeoutSource = "legacy advisor.*"
    } else {
      warn("ignoring invalid legacy advisor.timeoutMs = " + JSON.stringify(legacy.timeoutMs)
        + " (expected a number in " + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS + ")")
    }
  }
  if (timeoutMs === undefined) {
    timeoutMs = groupKey === "convergence" ? CONVERGENCE_TIMEOUT_DEFAULT_MS : REVIEW_TIMEOUT_MS
    timeoutSource = "default"
  }

  return {
    ok: true, groupKey, provider, model, pairSource,
    effort, effortSource,
    timeoutMs, timeoutSource,
    warnings,
  }
}

/**
 * 评审记忆开关（§3.5）：includeProjectGuide 解析——会话覆盖 > 全局组 > 缺省 false。
 */
export function resolveIncludeProjectGuide({ config, override }) {
  const advisorCfg = (config && typeof config === "object" && config.advisor
    && typeof config.advisor === "object") ? config.advisor : {}
  if (override && typeof override.includeProjectGuide === "boolean") {
    return { value: override.includeProjectGuide, source: "session override" }
  }
  if (typeof advisorCfg.includeProjectGuide === "boolean") {
    return { value: advisorCfg.includeProjectGuide, source: "global config" }
  }
  return { value: false, source: "default" }
}

// ————————————— advisor_config 工具（§3.6，一期入口） —————————————

const GROUP_PREFIXES = ["round1", "convergence"]
const isGroupFieldPath = (path) => {
  const [prefix, field] = String(path).split(".")
  return GROUP_PREFIXES.includes(prefix) && ADVISOR_OVERRIDE_GROUP_PATHS.includes(field)
}

function overrideGroupObj(state, prefix) {
  if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
    state.advisorOverride = {}
  }
  if (!state.advisorOverride[prefix] || typeof state.advisorOverride[prefix] !== "object") {
    state.advisorOverride[prefix] = {}
  }
  return state.advisorOverride[prefix]
}

function coerceValue(path, field, value) {
  // 返回 { ok:true, value } | { ok:false, reason }
  const reason = (m) => ({ ok: false, reason: m })
  if (path === "includeProjectGuide") {
    return typeof value === "boolean" ? { ok: true, value }
      : reason("value for includeProjectGuide must be a boolean")
  }
  switch (field) {
    case "provider":
    case "model":
      return (typeof value === "string" && value.trim() !== "")
        ? { ok: true, value }
        : reason("value for " + path + " must be a non-empty string")
    case "effort":
      return (typeof value === "string" && EFFORT_LEVELS.includes(value))
        ? { ok: true, value }
        : reason("value for " + path + " must be one of " + EFFORT_LEVELS.join("|"))
    case "timeoutMs":
      return (typeof value === "number" && Number.isFinite(value)
        && value >= ADVISOR_TIMEOUT_MIN_MS && value <= ADVISOR_TIMEOUT_MAX_MS)
        ? { ok: true, value }
        : reason("value for " + path + " must be a number in "
          + ADVISOR_TIMEOUT_MIN_MS + ".." + ADVISOR_TIMEOUT_MAX_MS)
    case "runner": {
      // R4 §6.2（D-13 三面同步）：runner 校验走 normalizeRunnerValue（与 resolveAdvisorRoute /
      // PUT 白名单同源）——字符串简写（"dsh"|"codex-cli"）或对象皆可；存归一化结构（解析链
      // 再消费）。"dsh" = 显式切回 dsh 路由（回落硬停修正指引 2 的「改回 dsh」通道）。
      const nr = normalizeRunnerValue(value)
      if (!nr.ok) {
        return reason("value for " + path + " must be \"dsh\"|\"codex-cli\" or a codex runner object "
          + "{ kind, model?, effort?, sandbox?, timeoutMs?, idleTimeoutMs?, proxy?, agentsMd? } — " + nr.errors.join("; "))
      }
      return { ok: true, value: nr.runner }
    }
    default:
      return reason("unknown field")
  }
}

function describeGroup(groupKey, config, override, agentOpts, advisorRound) {
  const r = resolveAdvisorRoute({ config, override, agentOpts, advisorRound })
  if (!r.ok) {
    return "  " + groupKey + ": no LLM route available (provider/model resolution chain exhausted)"
  }
  const effortLine = r.effort !== null
    ? "effort: " + JSON.stringify(r.effort) + " (source: " + r.effortSource + ")"
    : "effort: (not set — adapter default)"
  return "  " + groupKey + ":\n"
    + "    provider: " + r.provider + " (source: " + r.pairSource + ")\n"
    + "    model: " + r.model + " (source: " + r.pairSource + ")\n"
    + "    " + effortLine + "\n"
    + "    timeoutMs: " + r.timeoutMs + " (source: " + r.timeoutSource + ")"
}

/**
 * advisor_config 工具执行（§3.6）。textTool，参数线格式 = JSON 对象文本，JSON.parse 解析；
 * malformed / 未知 action/path / 类型错 / 越界 → 统一 "advisor_config: invalid input — <原因>"，
 * sessionState.advisorOverride 保持原样（N4）。全局写入经二期设置页 config API
 * （PUT /thincoder-suite/api/config → config.json user 层，见 docs/2026-09-02-settings-ui-design.md §3.2）。
 * @param text 工具参数文本（JSON 对象）
 * @param deps { config, agentOpts, state, sessionId? } — state 含可变 advisorOverride
 */
export function runAdvisorConfigTool(text, deps) {
  const state = deps?.state ?? {}
  // 二期（docs/2026-09-02-settings-ui-design.md §3.6-1）：config 来源统一走 effectiveGlobalConfig
  // ——get 显示/解析的「全局 advisor config」= entry base ⊕ config.json user 层（每次调用时读，
  // 保存即生效，U5）；set/reset 只动会话覆盖（state），与本行无关。
  const effectiveCfg = effectiveGlobalConfig(deps?.config, { cwdHint: deps?.cwdHint })
  const invalid = (reason) => "advisor_config: invalid input — " + reason

  let req
  try {
    req = JSON.parse(String(text ?? "").trim() || "{}")
  } catch (e) {
    return invalid("malformed JSON: " + (e?.message ?? String(e)))
  }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return invalid("request must be a JSON object")
  }
  const action = req.action
  if (action !== "get" && action !== "set" && action !== "reset") {
    return invalid("unknown action " + JSON.stringify(action) + " (expected get|set|reset)")
  }

  if (action === "get") {
    const override = state.advisorOverride ?? null
    const includeProjectGuide = resolveIncludeProjectGuide({ config: effectiveCfg, override })
    const lines = [
      "advisor_config (session " + (deps?.sessionId ?? "?") + "):",
      "session override: " + (override ? JSON.stringify(override) : "(none)"),
      "global advisor config: " + JSON.stringify(effectiveCfg.advisor ?? {}),
      "includeProjectGuide: " + includeProjectGuide.value + " (source: " + includeProjectGuide.source + ")",
      "effective route:",
      describeGroup("round1", effectiveCfg, override, deps?.agentOpts, 0),
      describeGroup("convergence", effectiveCfg, override, deps?.agentOpts, 1),
    ]
    return lines.join("\n")
  }

  if (action === "set") {
    const path = req.path
    const value = req.value
    if (typeof path !== "string" || path === "") {
      return invalid("set requires a path (round1|convergence . provider|model|effort|timeoutMs|runner, or includeProjectGuide)")
    }
    if (path !== "includeProjectGuide" && !isGroupFieldPath(path)) {
      return invalid("path " + JSON.stringify(path)
        + " is not settable (expected round1|convergence . provider|model|effort|timeoutMs|runner, or includeProjectGuide)")
    }
    const [prefix, field] = path === "includeProjectGuide" ? [] : path.split(".")
    const c = coerceValue(path, field ?? null, value)
    if (!c.ok) return invalid(c.reason)
    if (path === "includeProjectGuide") {
      if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
        state.advisorOverride = {}
      }
      state.advisorOverride.includeProjectGuide = c.value
    } else {
      overrideGroupObj(state, prefix)[field] = c.value
    }
    return "advisor_config: set " + path + " = " + JSON.stringify(c.value)
      + " (session override updated)"
  }

  // reset（省略 path = all，与 set 的 path 枚举对称）
  const path = req.path === undefined || req.path === null ? "all" : req.path
  if (path !== "round1" && path !== "convergence" && path !== "includeProjectGuide" && path !== "all") {
    return invalid("path " + JSON.stringify(path)
      + " is not resettable (expected round1|convergence|includeProjectGuide|all)")
  }
  if (!state.advisorOverride || typeof state.advisorOverride !== "object") {
    return "advisor_config: reset " + path + " — session override cleared (nothing to reset)"
  }
  if (path === "all") {
    state.advisorOverride = null
  } else {
    delete state.advisorOverride[path]
    if (Object.keys(state.advisorOverride).length === 0) state.advisorOverride = null
  }
  return "advisor_config: reset " + path + " — session override cleared"
}

// ————————————— design token（D-30：两段 uuid:expiresAt，无签名腿） —————————————
// 协议（对齐上游 thincoder design-token.mjs：「uuid:expiresAt，exact slot match + TTL only」）：
// token = "<uuid>:<expiresAt>"，恰好两段，无签名段——授权由**记录全等匹配**承担（eng.mjs 的
// token !== state.designToken），TTL 只是陈旧度护栏。旧三段式的迁移见 FR-T9（形状检测 + 诚实指引，
// **不做**旧格式兼容验签：保留旧通道等于保留伪造面，先例 = v2 废除 [DESIGN-TOKEN:...] 回显）。

/** 默认 TTL 7d（FR-T4；导出供测试与文档单一引用）。 */
export const TOKEN_TTL_DEFAULT_MS = 7 * 24 * 3600 * 1000

/**
 * 当前生效 TTL：config.engTokenTtlMs（D-29 覆盖链，值域校验在 config-store）> 默认 7d。
 * 铸造（generateDesignToken）与续期（renewDesignToken，FR-T5）共用本函数——TTL 语义单点。
 * @param {object} [config] — 生效全局配置
 * @returns {number} 毫秒
 */
export function resolveEngTokenTtlMs(config) {
  return Number.isFinite(config?.engTokenTtlMs) && config.engTokenTtlMs > 0
    ? config.engTokenTtlMs
    : TOKEN_TTL_DEFAULT_MS
}

// 导出供测试直接驱动（对齐既有导出缝先例）：D-29 需要断言「user 层生效配置真的决定 token
// 有效期」，只有驱动真实铸造路径才能锁住消费点形态。
export function generateDesignToken(config) {
  const uuid = randomUUID()
  const expiresAt = Date.now() + resolveEngTokenTtlMs(config)
  return uuid + ":" + expiresAt
}

/**
 * token 形状（FR-T1 / FR-T9）："two-part" = 现行两段式；"legacy" = 旧三段式（D-25 HMAC 签名腿
 * 时代签发，升级后在途一次性失效）；"malformed" = 其余（含非字符串/空串）。
 * @param {unknown} token
 * @returns {"two-part"|"legacy"|"malformed"}
 */
export function designTokenShape(token) {
  if (typeof token !== "string" || token === "") return "malformed"
  const parts = token.split(":").length
  if (parts === 3) return "legacy"
  return parts === 2 ? "two-part" : "malformed"
}

/**
 * 可区分的校验失败原因（FR-T9）。`validateDesignToken` 保持既有布尔契约（N6：eng.mjs 调用形态
 * 不变），本函数供调用方给出**诚实**的排障文案（旧版本令牌 ≠ 已过期 ≠ 畸形）。
 * @param {unknown} token
 * @returns {"missing"|"legacy"|"malformed"|"expired"|null} null = 通过
 */
export function designTokenFailureReason(token) {
  if (!token || typeof token !== "string") return "missing"
  const shape = designTokenShape(token)
  if (shape === "legacy") return "legacy"
  if (shape !== "two-part") return "malformed"
  const exp = tokenExpiryMs(token)
  if (exp === null) return "malformed" // expiresAt 非数
  if (Date.now() > exp) return "expired"
  return null
}

/** 校验：形状（恰好两段）+ expiresAt 有限 + 未过期，全 fail-closed（畸形串一律不通过）。 */
export function validateDesignToken(token) {
  return designTokenFailureReason(token) === null
}

/**
 * 续期（FR-T5）：**同一 uuid** + expiresAt = now + 当前生效 TTL。
 * 仅由 eng.mjs 的过期子分支在「文档集指纹与签发时一致」时调用（落点决策 D1）；本函数只做
 * 形状改写（token 格式知识单点在 advisor.mjs），不碰 state/磁盘（那是调用方的同步责任）。
 * @param {string} token — 过期 token（取其第 0 段 uuid）
 * @param {object} [config] — 生效全局配置（决定 TTL）
 * @returns {string} 新令牌串
 */
export function renewDesignToken(token, config) {
  const uuid = String(token ?? "").split(":")[0]
  return uuid + ":" + (Date.now() + resolveEngTokenTtlMs(config))
}

/**
 * 批准码派生（R2 修订 / FR-T3）：code = sha256(uuid).hex.slice(0, 8)，uuid = token 第 0 段。
 * 无状态、可重算、不新增存储字段——安全性不依赖密钥（D3）：uuid 由宿主 randomUUID() 生成且
 * **从不进提示词**（批准前 LLM 全程不见 token），故 sha256(uuid) 对主代理同样不可预测。
 * 每评审会话只铸造一次 designToken（存 sessionState.pendingDesignToken），因此每轮
 * （round 1 与收敛轮）的 Approval Signal 展示同一个 code；宿主校验 [APPROVE:<code>] 回显
 * 命中后自行注入完整 token。
 * 放在本模块（token 语义单一归属，D10：不为可读性做跨模块搬运）并由 advisor-msgs.mjs 反向
 * import——环状依赖是有意的且安全：双方仅在函数体内使用对方绑定（Node ESM 活绑定延迟求值；
 * 本插件纯 .mjs 免构建，无打包器改写），切勿在任何一侧的模块顶层使用对方绑定。
 */
export function designApprovalCode(designToken) {
  return sha256Hex(String(designToken ?? "").split(":")[0]).slice(0, 8)
}

/**
 * [APPROVE:<code>] 批准码回显的弹性匹配（允许独立行/代码块/空白包裹）。
 * 旧格式 [DESIGN-TOKEN:<67 字符 token>] 回显路径已废除（v2 干净切换：保留旧格式
 * 等于保留钓鱼通道）——任何 [DESIGN-TOKEN:...] 回显一律不触发签发，与未回显同待遇。
 */
const makeApprovalCodeRegex = (code, flags = "") => {
  const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp("(?:^|\\s|`|\\*)\\[APPROVE:\\s*" + escaped + "\\s*\\](?:\\s|$|`|\\*)", flags + "ms")
}

/**
 * 「裁决通过」启发式判定（R2 + R3.1 修订 + v3 单元格锚定，docs/2026-09-01-advisor-config-design.md §3.8）：
 * ① 无「未解决」🔴 行：只检查 markdown 表格行中 severity 单元格精确 = 🔴（允许 ** 加粗包裹）
 *   的行，且行内无修复标记（Fixed/Resolved/已修复/已解决/已验证/核销等）才视为未通过；
 *   描述/Notes 文本中的 🔴 字样不参与判定（v3 踩坑记录见下）；
 * ② 输出含通过性结论词（通过 / 批准 / approved，忽略大小写），且该词不在否定语境
 *   （不/未/非/没/难以/无法 + 通过|批准，或 not/never + approved——“未通过”、
 *   "not approved" 不算通过）。任一条件不满足 → 按未通过处理（拿不准就不签发）。
 * 注意：结论词清单与 Approval Signal 措辞是配套设计——消息构建（advisor-msgs.mjs）
 * 明确要求通过时「state that the design is approved」，以可靠命中本启发式。
 * 该启发式与 [APPROVE:<code>] 回显是 AND 关系，两者都命中才签发。
 * v3 踩坑记录：v0 任何含 🔴 行 → 收敛轮 Fixed 表误拒；v1 行含 🔴 无修复标记 → "no 🔴"
 * 总结句误拒；v2 只表格行 → 描述文本引用 "🔴" 字样（如 T17 措辞）误拒（2026-09-02 实测）。
 */
const APPROVAL_VERDICT_RE = /((?:不|未|非|没|难以?|无法|未能|没能|没法|不能|不得|不可|不予|未曾|拒绝|驳回|尚不|暂不|没有|不曾|不会|不再)(?:[\u4e00-\u9fa5])?|(?:not|never|no|cannot|can'?t|won'?t|doesn'?t|isn'?t|aren'?t)\s+(?:\w+\s+)?)?(通过|批准|\bapproved\b)/gi
const RESOLVED_MARK_RE = /(?:fixed|resolved|addressed|done|corrected|已修复|已解决|已验证|核销)/i
/** 未解决标记：否定/待定语境下的修复词不算已修复（"not done"、"pending"、"未修复"、"仍…"）。 */
const UNRESOLVED_MARK_RE = /(?:not\s+(?:fixed|done|resolved|addressed|corrected|verified)|unfixed|未修复|尚未修复|仍未|pending|仍\s*(?:未|没有))/i
/** severity 单元格以 🔴 开头（允许 ** 加粗与 "🔴 Critical"/"🔴(must fix)" 后缀）；限短单元格（≤16）避免描述列误伤。 */
const RED_SEVERITY_CELL_RE = /^\s*(?:\*\*)?🔴(?:\*\*)?(?=\s|\(|$)/
export function isApprovalVerdict(text) {
  const s = String(text ?? "")
  for (const line of s.split("\n")) {
    if (!/^\s*\|/.test(line)) continue
    const cells = line.split("|").map(c => c.trim())
    const hasRedSeverity = cells.some(c => c.length <= 16 && RED_SEVERITY_CELL_RE.test(c))
    if (hasRedSeverity && (!RESOLVED_MARK_RE.test(line) || UNRESOLVED_MARK_RE.test(line))) return false
  }
  APPROVAL_VERDICT_RE.lastIndex = 0
  let m
  while ((m = APPROVAL_VERDICT_RE.exec(s)) !== null) {
    if (!m[1]) return true // 至少存在一个非否定语境的结论词
  }
  return false
}

// ————————————— 批 3（FR-1）：VERDICT 契约 + 「必须修复」标记 —————————————
// docs/2026-09-12-review-protocol-design.md §4.1 / §4.3 / §5.1。三条新正则集中定义，
// 只由 parseVerdict / hasUnresolvedBlockingRow 消费（**唯一调用方**：下方 finalize 的 design 分支）。
/** VERDICT 行**存在性**过滤器：行首（可含前导空白）+ 大小写不敏感 + 容忍 `**` 只包裹关键字。
 *  刻意**不**容忍 `**VERDICT**: PASS`（关键字被 `**` 包住却把冒号留在外面）——那种形态不命中
 *  本过滤器 → 走回落路径（设计档 §8 显式标注的容忍边界，方向安全）。 */
const VERDICT_LINE_PRESENCE_RE = /^\s*(?:\*\*)?VERDICT\s*:/i
/** VERDICT 行**完整契约**（决策 D-c 容忍面：前导空白 / **成对** `**` 包裹 / 恰好一个尾句号 /
 *  CRLF），且**只容忍格式**：多行、错位、错值一律 INVALID（不放宽语义）。
 *  **收紧（批 3 分歧审计 🟡 #2，N6「放宽项不得放宽到接受错误值」）**——容忍面**不缩小**合法的
 *  `VERDICT: PASS.` 与 `**VERDICT: PASS**`，只拒掉三类**不该接受**的形态：
 *   ① 尾句号必须**紧跟**取值：`VERDICT: PASS   .   ` 不再接受（`\.?` 前不允许空白）；
 *   ② `**` 必须**成对**：`**VERDICT: PASS`（缺尾）与 `VERDICT: PASS**`（缺首）均判 INVALID(bad-value)；
 *   ③ `VERDICT: PASS..` 继续拒绝（仍恰好一个尾句号）。
 *  写法 = 两条互斥分支（正则在 JS 里无法表达「配对」的回引条件），取值落在 `m[1] ?? m[2]`：
 *  带 `**` 的分支要求**首尾都有** `**`；不带 `**` 的分支要求**首尾都没有**。 */
const VERDICT_LINE_RE = /^\s*(?:\*\*VERDICT\s*:\s*(PASS|FAIL)\.?\s*\*\*|VERDICT\s*:\s*(PASS|FAIL)\.?)\s*$/i
/** 「必须修复的 🟡」严重度单元格字面量（决策 D-b）：`🟡 must-fix`，容忍加粗与括号变体
 *  （先例：既有夹具里已有 `🔴(must fix)` 形态）。**必须逐单元格匹配**——本正则带 `^\s*`
 *  行首锚定，拿整行（表格行以 `|` 开头）去匹配永不命中。 */
const MUST_FIX_RE = /^\s*(?:\*\*)?🟡(?:\*\*)?\s*\(?\s*must[ -]?fix\b/i
/** severity 单元格（🔴）长度上限：避免描述列误伤（既有语义，**不动**）。 */
const RED_CELL_MAX = 16
/** must-fix 单元格长度上限（评审 #3 收口，fail-open 角落）。
 *  旧实现与 🔴 共用 16，但 `**🟡** (must fix)`（加粗 + 括号组合）的 UTF-16 长度 = 17，
 *  在匹配之前就被长度护栏挡掉 → must-fix **静默漏判**（fail-open：可能错发凭证，方向错误）。
 *  放宽到 24 仍远低于真实描述列宽度；且放宽**只对以 🟡 开头的严重度单元格生效**
 *  （MUST_FIX_RE 自带 `^\s*(?:\*\*)?🟡` 锚定），普通长描述单元格仍不误判。 */
const MUST_FIX_CELL_MAX = 24

/**
 * 解析评审员的 VERDICT 收尾行（FR-1，设计档 §5.1）。
 *
 * 前置：`result` 可为**任意值**（内部 `String(result ?? "")`，不要求字符串）。
 * 后置：**纯函数、无副作用、不抛**。返回四形态之一——
 *   `{kind:"pass"}` / `{kind:"fail"}` / `{kind:"invalid", reason}` / `{kind:"absent"}`。
 *   保证 `kind==="pass"` ⟹ 该行是**最后一行非空内容**且取值恰为 `PASS`
 *   （大小写 / `**` 包裹 / 一个尾句号 / CRLF 容忍后）。
 *   **绝不**在 `kind==="absent"` 之外返回 absent（D-f：显式 verdict 畸形不回落）。
 * @param {unknown} result
 * @returns {{kind:"pass"|"fail"|"absent"}|{kind:"invalid", reason:"duplicate"|"misplaced"|"bad-value"}}
 */
export function parseVerdict(result) {
  const lines = String(result ?? "").split("\n")
  const hits = lines.filter(l => VERDICT_LINE_PRESENCE_RE.test(l))
  if (hits.length === 0) return { kind: "absent" }
  if (hits.length > 1) return { kind: "invalid", reason: "duplicate" }
  const lastNonEmpty = [...lines].reverse().find(l => l.trim() !== "")
  if (hits[0] !== lastNonEmpty) return { kind: "invalid", reason: "misplaced" }
  const m = hits[0].match(VERDICT_LINE_RE)
  if (!m) return { kind: "invalid", reason: "bad-value" }
  return { kind: (m[1] ?? m[2]).toLowerCase() }
}

/**
 * 阻塞行扫描（FR-1，决策 D-a + D-b，设计档 §4.3 / §5.1）。
 *
 * 一行阻塞 **当且仅当**它的**严重度单元格**是 🔴 **或** `🟡 must-fix`，**且**该行不带已解决标记。
 * **必须先抽取单元格再匹配**（与既有 `isApprovalVerdict` 内 `RED_SEVERITY_CELL_RE` 的消费
 * 管线同款）：① 滤出表格行 → ② `split("|")` → ③ `trim()` → ④ 逐单元格 `test()`。
 * 拿整行做 `MUST_FIX_RE.test(line)` 会**永不命中**（真实表格行以 `|` 开头），
 * 那会让 must-fix 检测对真实表格静默失效（fail-open）。
 *
 * 前置：`text` 可为任意值。后置：**纯函数、无副作用、不抛**；`true` 当且仅当存在上述行。
 * 长度护栏按标记分设（评审 #3 收口）：🔴 ≤ `RED_CELL_MAX`（16，与既有 `isApprovalVerdict` 同款）；
 * `🟡 must-fix` ≤ `MUST_FIX_CELL_MAX`（24，容纳 `**🟡** (must fix)` 这类 17 字符的加粗+括号组合）。
 * 方向：**宁可误判 true**（fail-closed，多发一轮评审）**不可误判 false**（错发凭证）。
 * @param {unknown} text
 * @returns {boolean}
 */
export function hasUnresolvedBlockingRow(text) {
  const s = String(text ?? "")
  for (const line of s.split("\n")) {
    if (!/^\s*\|/.test(line)) continue // ① 只认表格行
    const cells = line.split("|").map(c => c.trim()) // ②③ 拆单元格
    const blocking = cells.some(c => // ④ 逐单元格匹配：🔴 ≤16（既有）/ 🟡 must-fix ≤24（评审 #3 放宽）
      (c.length <= RED_CELL_MAX && RED_SEVERITY_CELL_RE.test(c))
      || (c.length <= MUST_FIX_CELL_MAX && MUST_FIX_RE.test(c)))
    if (blocking && (!RESOLVED_MARK_RE.test(line) || UNRESOLVED_MARK_RE.test(line))) return true
  }
  return false
}

/**
 * FR-4（D-33）判定失败**可见**：六类情形的可区分诊断文案（设计档 §4.4）。
 * **N7：任何「未签发」路径都必须点名原因** —— 静默即缺陷。
 * 唯一的静默路径是「absent + 回落判通过 + 回显有效」= 正常签发（在拿到诊断前就 return 了）。
 */
const VERDICT_DIAG = {
  /** `pass` + 存在未解决阻塞行（D-a/D-b）：verdict 与表格自相矛盾。 */
  contradiction: "\n\n评审未签发：verdict 为 PASS，但评审表格中仍存在未解决的阻塞行"
    + "（严重度单元格为 🔴 或 `🟡 must-fix`）——verdict 与表格矛盾，请重跑评审",
  /** `pass`（无阻塞行）但批准码校验失败 / `absent` 回落判通过但批准码校验失败——**既有措辞逐字保留**。 */
  echo: "\n\n评审通过但批准码校验失败——请重跑评审（本轮 token 未签发）",
  /** `fail`：评审员显式判定不通过。 */
  fail: "\n\n评审未签发：评审员判定为不通过（`VERDICT: FAIL`），既有签发已撤销",
  /** `invalid`：显式 verdict 畸形（不回落，D-f）——点名格式与原因。 */
  invalidHead: "\n\n评审未签发：VERDICT 行格式非法（原因：",
  invalidTail: "）——末行必须恰为 `VERDICT: PASS` 或 `VERDICT: FAIL`（英文关键字，不翻译），请重跑评审",
  /** `absent` + 回落判定为不通过：**D-33 的正解**——用户由此知道不是「评审没过」，
   *  而是「说了通过但宿主没认出来」（AC-V19/AC-V20）。 */
  absentFail: "\n\n评审未签发：未给出 VERDICT 行；回落启发式判定为不通过。"
    + "注意：这**不等于**评审员判了不通过——常见情形是评审员表达了通过但宿主未识别其通过措辞"
    + "（回落启发式只认「通过 / 批准 / approved」等固定词）。"
    + "请重跑评审并要求评审员在**末行**给出 `VERDICT: PASS`（英文关键字，不翻译）。",
  /** `absent` + 回落判不通过 **但本轮已有有效令牌**（FR-6 守卫 / A 方案 / 2026-09-12）：
   *  只诊断、不撤销 —— 一次「看不懂」不该销毁既得的有效授权（D-34 的危害本体）。
   *  与 `absentFail` **可区分**：后者表示确实撤销了。文案同样受 AC-V20 约束
   *  （必须明说「评审员表达了通过但宿主未识别」、不得写「评审未通过」、显式排除误解、给出补救动作）。 */
  absentFailKept: "\n\n本轮评审未签发新令牌：未给出 VERDICT 行；回落启发式判定为不通过。"
    + "注意：这**不等于**评审员判了不通过——常见情形是评审员表达了通过但宿主未识别其通过措辞"
    + "（回落启发式只认「通过 / 批准 / approved」等固定词）。"
    + "**本会话已有一枚有效令牌，因此本次判定未撤销既有签发**——沿用该令牌即可继续开工。"
    + "请重跑评审（末行给出 `VERDICT: PASS`，英文关键字不翻译）以获取新令牌。",
}
/** `parseVerdict` 的 invalid 原因 → 人话（诊断必须可区分，N7）。 */
const VERDICT_INVALID_REASON_LABEL = {
  duplicate: "末尾出现多行 VERDICT 行",
  misplaced: "VERDICT 行不是最后一行非空内容",
  "bad-value": "取值不是 PASS / FAIL",
}
const verdictInvalidDiag = (reason) =>
  VERDICT_DIAG.invalidHead + (VERDICT_INVALID_REASON_LABEL[reason] ?? String(reason)) + VERDICT_DIAG.invalidTail

/**
 * `expiresAt` 段的严格形态（分歧审计 B2 / D-30 补丁）：**整段**必须是 1..15 位纯 ASCII 数字。
 * 上限 15 位 = 999_999_999_999_999 ms（约公元 33658 年），远超任何合法 TTL——位数封顶同时
 * 保证 Number(seg) 必为安全整数（消除「超长数字串 → 1e21 仍 finite」的漏洞）。
 */
const EXPIRY_SEGMENT_RE = /^\d{1,15}$/

/** token 第二段 expiresAt（毫秒时间戳）；畸形 → null。expiryLabel 与 F10 落盘共用同一
 *  解析路径（docs/2026-09-02 §5 确认项 4——避免重复实现）。
 *  **严格整数段**（审计 B2）：此前用 `Number.parseInt` 会**截断**尾随垃圾——`"<uuid>:<exp>xyz"`
 *  被解析成 `exp`，令 `validateDesignToken` 对畸形串返回 true，与本函数上方
 *  「畸形串一律不通过」的契约及设计档「expiresAt 有限」矛盾（父侧实测复现）。故改为整段
 *  正则匹配：尾随垃圾 / 前导空白 / 前导 `+` / 浮点 / 科学计数 / 超长数字串 / 空段 一律 null。 */
export function tokenExpiryMs(token) {
  if (typeof token !== "string") return null
  const seg = token.split(":")[1]
  if (typeof seg !== "string" || !EXPIRY_SEGMENT_RE.test(seg)) return null
  return Number(seg)
}

/**
 * token 有效期显示（D-30 / FR-T6 / AC-25）：TTL > 24h 时「HH:MM」无意义（7d 令牌会显示成
 * 某个今天/昨天的钟点），改显示**日期**；≤ 24h 保持 HH:MM。
 * 签发消息（advisor 批准返回）与 eng_coder 续期回执共用本函数——显示规则单点。
 * @param {string} token
 * @param {number} [now]
 * @returns {string}
 */
export function expiryLabel(token, now = Date.now()) {
  const exp = tokenExpiryMs(token)
  if (exp === null) return "??"
  const d = new Date(exp)
  const pad = (n) => String(n).padStart(2, "0")
  if (exp - now > 24 * 3600 * 1000) {
    return String(d.getFullYear()).padStart(4, "0") + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate())
  }
  return pad(d.getHours()) + ":" + pad(d.getMinutes())
}

// ————————————— DSH 消息构造 —————————————

const uid = () => "adv-" + randomUUID()

function userMsg(text) {
  return { id: uid(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } }
}
function assistantMsg(blocks, provider, model) {
  return {
    id: uid(), role: "assistant",
    content: blocks.filter(b => b.type === "text" || b.type === "tool-call"),
    source: { kind: "model", provider, model },
  }
}
function toolResultMsg(callId, text) {
  return {
    id: uid(), role: "user",
    content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }], isError: false }],
    source: { kind: "tool", callId },
  }
}

// ————————————— 上下文压缩（本地裁剪，无 LLM 摘要） —————————————

/**
 * 单串估算（FR-CB4，私有）：ASCII 码元 4 个 ≈ 1 token（ceil），非 ASCII 码元 1 个 ≈ 1 token。
 * 逐消息 sum 形状与旧式同构——纯 ASCII 与旧式 `ceil(len/4)` **逐值相等**（N-2 零回归）；
 * CJK 由旧式低估 ~4× 修正为 1 token/汉字（§5.4 表）。
 * 口径登记：星平面字符（emoji）按 UTF-16 码元计 2（与上游同口径，R-1 本批不改）。
 */
function estimateText(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

function estimateTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateText(JSON.stringify(m.content ?? [])), 0)
}

/**
 * 压缩：保首条 user + 最近 20 条，中间以本地摘要替换（对齐 thincoder run.mjs）。
 * 边界守卫：窗口起点若落在 tool-result 上会制造孤儿 tool 消息（违反协议配对），
 * 向前回退到非 tool-result 消息为止。
 * D 复核（docs/2026-09-02-session-state-stages-design.md §4 小改进）：keyFiles **去重 +
 * 上限 15**（原只留 5 且不去重——中段被压缩后评审易重复读已查文件浪费回合；确定性零成本）。
 * 导出供 T13 单测直测（行为对 ≤20 条消息为零变更——messages.length <= 20 早退）。
 */
export function compactMessages(messages) {
  if (messages.length <= 20) return
  const first = messages[0]
  let start = messages.length - 20
  while (start > 1 && messages[start] && messages[start].role === "user"
    && messages[start].content?.[0]?.type === "tool-result") start--
  const recent = messages.slice(start)
  const old = messages.slice(1, start)
  const toolCount = old.filter(m => m.content?.[0]?.type === "tool-result").length
  const keyFiles = [...new Set(
    old
      .filter(m => m.content?.[0]?.type === "tool-result")
      .map(m => (m.content[0].content?.[0]?.text ?? "").split("\n")[0]?.slice(0, 50))
      .filter(Boolean),
  )].slice(0, 15)
  const filesPart = keyFiles.length > 0 ? " Key files examined: " + keyFiles.join(", ") : ""
  const summary = "[Context compacted] Earlier exploration: " + toolCount + " tool calls completed." + filesPart
  messages.splice(0, messages.length, first, userMsg(summary), ...recent)
}

// ————————————— 流收集（绝对截止 + idle 看门狗双机制，§3.4） —————————————

// 单次 LLM 调用的 chunk 级看门狗（thincoder 有 per-request FETCH_TIMEOUT；DSH
// GenerateOptions 无超时字段，挂起的请求会把循环卡到天荒地老——循环顶的整体
// 超时检查在 await 期间永远不执行。看门狗把挂起变成可诊断的错误）。
//
// §3.4 双机制：
// - 绝对截止：每次调用挂一个 setTimeout(deadlineMs) 截止定时器（不依赖 chunk 到达，
//   静默流同样在预算时刻被中止），并在每个 chunk 到达时做墙钟检查双保险；触发即 abort
//   （批 6 FR-AP2/FR-AP3：reason 带 abortInfo{trigger:"timeout",layer:"agent"} + 点火 latch
//   `deadlineLatch.fired`——上层按**机械事实**判 timeout，不再嗅探 message 文本）；
// - idle 看门狗：watchdogMs 内无任何 chunk → abort（reason 含 "llm call stalled" → 上层按
//   stall 重试），窗口 clamp 到 min(watchdogMs, deadlineMs)——timeoutMs 小于看门狗窗口时
//   看门狗不喧宾夺主。stallMsOverride 仅测试注入缝（§5.1，非用户配置）。
async function collectStream(llm, streamOpts, cfg = {}) {
  const { watchdogMs = LLM_CALL_STALL_MS, stallMsOverride = null, deadlineMs = null, deadlineLatch = null } = cfg
  const blocks = []
  let finish = null
  const wd = new AbortController()
  let wdTimer = null
  const deadlineAt = Number.isFinite(deadlineMs) && deadlineMs > 0 ? Date.now() + deadlineMs : null
  const wdWindow = Number.isFinite(stallMsOverride) && stallMsOverride > 0
    ? stallMsOverride
    : (deadlineAt !== null ? Math.min(watchdogMs, deadlineMs) : watchdogMs)
  const stallError = () => new Error(
    "llm call stalled " + Math.round(wdWindow / 1000) + "s without a chunk (provider or adapter hang)")
  // 批 6 FR-AP2/FR-AP3：截止原因带结构化溯源（trigger=timeout / layer=agent——per-call deadline
  // 定时器是我方自持定时器，§12 #3）。文本主体逐字同既有（diagnostics 消费者零改动）。
  const deadlineError = () => timeoutError(
    "advisor review deadline reached after " + Math.round(deadlineMs / 1000) + "s (review budget exhausted)",
    "agent", "review budget exhausted")
  // FR-AP2 latch：判定绑**机械事实**（截止定时器/墙钟双检真的点火过），不再嗅探 error 文本（D-AP7）。
  // latch 对象由调用方持有（同一在飞调用的循环 catch 读它）——写点闭包内 latch、结算处读 latch（D-AP4）。
  const markDeadlineFired = () => { if (deadlineLatch) { deadlineLatch.fired = true; deadlineLatch.trigger = "timeout" } }
  const abortWith = (err) => { clearTimeout(wdTimer); try { wd.abort(err) } catch { /* 已中止 */ } }
  const arm = () => {
    clearTimeout(wdTimer)
    if (deadlineAt !== null && Date.now() >= deadlineAt) { markDeadlineFired(); abortWith(deadlineError()); return }
    const windowMs = deadlineAt !== null
      ? Math.max(1, Math.min(wdWindow, deadlineAt - Date.now()))
      : wdWindow
    wdTimer = setTimeout(() => {
      if (deadlineAt !== null && Date.now() >= deadlineAt) { markDeadlineFired(); abortWith(deadlineError()); return }
      abortWith(stallError())
    }, windowMs)
    wdTimer.unref?.()
  }
  let deadlineTimer = null
  let iterator = null // round2 #2：外提使 finally 可关闭流（try 内声明的 iterator 在 finally 不可见）
  try {
    arm()
    // 绝对截止定时器：独立于 chunk 到达与看门狗重试，预算到点即中止（§3.4）
    if (deadlineAt !== null) {
      deadlineTimer = setTimeout(() => { markDeadlineFired(); abortWith(deadlineError()) }, deadlineMs)
      deadlineTimer.unref?.()
    }
    const combined = streamOpts.signal ? AbortSignal.any([streamOpts.signal, wd.signal]) : wd.signal
    iterator = llm.stream({ ...streamOpts, signal: combined })[Symbol.asyncIterator]()
    const stallP = new Promise((_, reject) => {
      wd.signal.addEventListener("abort", () => reject(wd.signal.reason ?? stallError()), { once: true })
    })
    stallP.catch(() => {}) // 兜底：看门狗迟到 reject 不成为 unhandled rejection（code review #2）
    while (true) {
      const step = await Promise.race([iterator.next(), stallP])
      if (step.done) break
      // chunk 墙钟双检查（绝对截止不依赖看门狗时序）
      if (deadlineAt !== null && Date.now() >= deadlineAt) {
        markDeadlineFired()
        const de = deadlineError()
        abortWith(de)
        throw de
      }
      arm()
      const chunk = step.value
      if (chunk?.type === "block-end") blocks.push(chunk.block)
      else if (chunk?.type === "finish") finish = chunk
    }
    return { blocks, finish }
  } finally {
    clearTimeout(wdTimer)
    if (deadlineTimer) clearTimeout(deadlineTimer)
    // 关闭流自身也要有界：async generator 挂在内层 await 时 .return() 永不落定，
    // 无界 await 会让看门狗在清理阶段被击穿。给关闭 2s，超时放弃（残留连接交给 OS/网关回收）。
    let closeP = Promise.resolve()
    try { closeP = Promise.resolve(iterator.return?.()).catch(() => {}) } catch { /* 同步抛出：无可关闭 */ }
    await Promise.race([closeP, new Promise(r => setTimeout(r, 2000))])
  }
}

// ————————————— 工具循环（预算硬生效） —————————————

function classifyStreamError(msg) {
  return /rate limit|429/i.test(msg) ? "rate limit"
    : /timeout/i.test(msg) ? "timeout"
    : /network|ECONNREFUSED/i.test(msg) ? "network"
    : /context length/i.test(msg) ? "context_too_long"
    : /stalled/.test(msg) ? "provider_stall"
    : "unknown"
}

// ————————————— D-18/D-01 结构化观测（R1 诊断层） —————————————

/**
 * 流结束观测行（N-2：finish.reason.kind + failure.message + block 计数 + finish 携带的
 * usage——失败可归因，不单独依赖单一信号）。流结束即 console.warn 留档；失败/空响应
 * 文本追加本行（D-18）。
 */
function streamObservationLine(finish, blocks) {
  const textBlocks = blocks.filter((b) => b && b.type === "text").length
  const toolBlocks = blocks.filter((b) => b && b.type === "tool-call").length
  const kind = finish?.reason?.kind ?? null
  const parts = [
    "finish=" + (kind === null ? "null" : String(kind)),
    "blocks(text=" + textBlocks + ",tool-call=" + toolBlocks + ")",
  ]
  const failureMsg = finish?.reason?.failure?.message
  if (typeof failureMsg === "string" && failureMsg !== "") {
    parts.push("failure.message=" + JSON.stringify(failureMsg.slice(0, 200)))
  }
  const usage = finish?.usage
  parts.push("usage=" + (usage !== undefined && usage !== null ? JSON.stringify(usage) : "none"))
  return "[thincoder-suite] stream observation: " + parts.join(" | ")
}

/**
 * D-01 空响应/错误无消息分类行（R1 观测 + R3 重试适用域判定）。
 * 三形态区分（登记表 D-01：finish null / stop 零块 / error 无 message）+ finish=length
 * 显式分类（生产复现根因：maxTokens 在推理阶段耗尽 → length 零文本块）。非基础设施
 * 形态（本函数所有空产出形态——error 提前返回不达）触发 R3 自动重试一次（D-裁决-1）。
 */
function emptyResponseClassification(finish, blocks, maxTokens) {
  if (!finish || !finish.reason) {
    return "finish-null（流结束未收到 finish 事件——传输层或适配器中断，无 finish 观测可归因）"
  }
  const kind = finish.reason.kind
  if (kind === "stop") {
    return "stop-zero-text-blocks（finish=stop 且零文本块——模型真空输出或推理吞尽输出预算，检查 advisor.maxOutputTokens=" + maxTokens + "）"
  }
  if (kind === "length") {
    return "length（输出 token 预算耗尽——推理烧光 maxTokens=" + maxTokens + " 后零正文；上调全局配置 advisor.maxOutputTokens）"
  }
  if (kind === "error") {
    const msg = finish.reason.failure?.message
    return (typeof msg === "string" && msg !== "")
      ? "error（" + String(msg).slice(0, 120) + "）"
      : "error-no-message（错误形态但无诊断信息——provider 错误面缺 failure.message）"
  }
  return String(kind) + "（非预期 finish 形态，零文本产出）"
}

/**
 * 批 6 FR-AP4（D-AP9）0.75 预算提示判定——**纯函数**（无状态、无 IO、可机测三态）。
 * 语义：预算已用 ≥75% 且本场尚未提示过 → true（每场至多一次；`alreadyNudged` 由调用方持有）。
 * 与 token/上下文预算无关（提示是**墙钟维**——两套诊断不搅浑，§5.3）。
 * @param {number} elapsedMs 已用墙钟
 * @param {number} totalMs 本轮组预算（advisor 组 timeoutMs）
 * @param {boolean} alreadyNudged 本场是否已提示过
 * @returns {boolean}
 */
export function shouldBudgetNudge(elapsedMs, totalMs, alreadyNudged) {
  return !alreadyNudged && Number.isFinite(totalMs) && totalMs > 0 && elapsedMs >= totalMs * 0.75
}

/**
 * 工具循环（单轮评审）。
 * @param deps { llm, stallMs? } — stallMs 非用户配置（内部/测试注入缝）
 * @param opts { provider, model, effort?, system, firstUserText, cwd, signal, timeoutMs,
 *              sessionId, stallMsOverride? } — stallMsOverride 仅测试注入（§5.1）
 * 预算模型（§3.4）：timeoutMs = 该轮组 timeoutMs（resolveAdvisorRoute 输出）。
 * 绝对截止优先于 stall：预算到点（elapsed >= timeoutMs）即返回 timeout（增强消息，
 * 含已完成轮次/已读文件数），无论是否处于 stall 重试中；deadline 计时器跨 stall 重试
 * 持续运行（每次尝试用剩余预算重算 deadlineMs，重试不豁免预算）。stall 错误仅在预算
 * 未耗尽且 STREAM_ATTEMPTS 重试全败时返回（provider_stall 诊断，保持现行为）。
 * 空响应重试（R3 D-01/D-裁决-1）：非基础设施形态空产出自动重试一次（复用 messages、
 * 与 stall 通道独立计数）；再空 → "Advisor:" 前缀失败（不烧轮次/不写 prior）。
 */
export async function runAdvisorToolLoop(deps, opts) {
  const { provider, model, system, firstUserText, cwd, signal, timeoutMs, sessionId } = opts
  const effort = isValidEffort(opts.effort) ? opts.effort : null // N4 兜底（非法 effort 回落不传）
  // §3.6：单次 LLM 输出预算（调用方传 effectiveGlobalConfig 解析值；缺省回落 LLM_MAX_TOKENS）
  const maxTokens = (Number.isFinite(opts.maxTokens) && opts.maxTokens > 0) ? Math.floor(opts.maxTokens) : LLM_MAX_TOKENS
  // 批 5 FR-CB3 / D-CB6：预算在 while 轮次外一次性派生；循环只吃 opts.contextTokens
  //（缺省静默落兜底窗——测试直调本函数时无路由上下文；生产侧「忘了传」由两处接线的源码级锁兜住）
  const budget = advisorContextBudget(
    (Number.isFinite(opts.contextTokens) && opts.contextTokens > 0)
      ? opts.contextTokens : CONTEXT_FALLBACK_WINDOW_TOKENS)
  const impls = advisorToolImpls(cwd)
  const tools = advisorToolSchemas()
  const messages = [userMsg(firstUserText)]
  let turns = 0           // 已开始的 LLM 工具轮（runaway 守卫）
  let roundsDone = 0      // 已完成（产出 tool calls 并执行完毕）的轮
  let filesRead = 0       // 已成功执行的 read 调用次数（§3.4 超时消息用）
  let toolCallsDone = 0   // 批 6 FR-AP6：已执行的工具调用总数（超时尾三要素之一）
  let reviewTextProduced = false // 批 6 FR-AP6：是否产出过评审正文（超时尾三要素之一）
  let budgetNudged = false // 批 6 FR-AP4（D-AP9）：0.75 提示**每场至多一次**
  // 批 6 FR-AP2：截止点火 latch——写点（collectStream 的截止定时器/墙钟双检）置位，
  // 结算处（本函数 catch 与返回形态判定）读它（D-AP4：不在结算处从错误对象倒推）。
  const deadlineLatch = { fired: false, trigger: null }
  // D-01（R3 / D-裁决-1）：空响应自动重试资格——非基础设施形态每次空产出重试一次
  //（有产出的轮重置资格；与 stall 重试通道（STREAM_ATTEMPTS）独立计数，互不挤占）。
  let emptyRetryArmed = true
  const startTime = Date.now()
  const budgetSeconds = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs / 1000) : 0
  const timeoutMsg = () => "Advisor: review timeout after "
    + Math.max(0, Math.round((Date.now() - startTime) / 1000))
    + "s (completed " + roundsDone + " tool rounds, " + filesRead
    + " files read). Try again with a narrower scope."
    // 批 6 FR-AP6（§12 #1）：以上前缀**逐字保留、一个字符都不动**；以下是**纯追加**——三要素统计
    // ＋预算值与配置键＋两条出路（US-5 是「含」式判定，追加即满足；既有断言零修改）。
    + " · tool calls: " + toolCallsDone
    + " · review text produced: " + (reviewTextProduced ? "yes" : "no")
    + " · budget: " + budgetSeconds + "s（advisor 组 timeoutMs）——收窄范围重发，或上调该组 timeoutMs。"

  while (true) {
    if (signal?.aborted) {
      // 批 6 FR-AP5：原 message 逐字 + 溯源后缀（layer settle = 宿主面信号；信号自带标注时用其层）
      return deathLine(annotateAbort(new Error("Advisor: interrupted."), signal, "settle", "caller signal abort"), signal)
    }
    if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
    // 批 6 FR-AP4（D-AP9）：预算跨过 75% 时**每场至多一次**提示——纯函数判定 + 循环顶检查；
    // 注入走 messages（**模型面**），**不进返回正文、不进 prior**（N-5：返回文本由各 return 逐字决定）。
    const elapsedMs = Date.now() - startTime
    if (shouldBudgetNudge(elapsedMs, timeoutMs, budgetNudged)) {
      budgetNudged = true
      messages.push(userMsg("[thincoder-suite] 评审预算已用 75%（"
        + Math.round(elapsedMs / 1000) + "s / " + budgetSeconds + "s）——可收窄范围或上调 advisor 组 timeoutMs。"))
    }
    if (++turns > MAX_ADVISOR_TURNS) {
      return "Advisor: stopped after " + MAX_ADVISOR_TURNS + " tool rounds — the review appears to be looping. You may retry with a narrower scope."
    }
    const currentTokens = estimateTokens(messages)
    if (currentTokens > budget.compactAt) {
      compactMessages(messages)
      if (estimateTokens(messages) > budget.limit) {
        return "Advisor: context window limit reached (" + estimateTokens(messages) + " tokens). Review incomplete — too many tool calls. Try a narrower scope."
      }
    }

    // sessionId/purpose/maxTokens 对齐生态先例（dsh-session-title-llm）：
    // llm/stream 中间件按 sessionId 归因，裸调用有挂起风险
    const stallCfg = deps.stallMs
    const stallMs = Number.isFinite(stallCfg) && stallCfg > 0 ? stallCfg : LLM_CALL_STALL_MS
    const streamOpts = {
      provider, model, system, messages, tools, signal,
      ...(sessionId ? { sessionId } : {}),
      purpose: "thincoder-advisor",
      maxTokens,
      ...(effort ? { reasoningEffort: effort } : {}), // §3.3 effort 透传（字段名以 dsh-llm GenerateOptions 为准）
    }
    let result = null
    let lastErr = null
    for (let attempt = 1; attempt <= STREAM_ATTEMPTS; attempt++) {
      // 预算到点检查（跨 stall 重试的 backoff 睡眠期间同样生效——重试不豁免预算）
      if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
      try {
        result = await collectStream(deps.llm, streamOpts, {
          watchdogMs: stallMs,
          stallMsOverride: opts.stallMsOverride,
          deadlineMs: timeoutMs - (Date.now() - startTime), // 轮内剩余预算（§3.4）
          deadlineLatch, // 批 6 FR-AP2：截止点火 latch（写点闭包内置位，本处结算读）
        })
        lastErr = null
        break
      } catch (e) {
        // 批 6 FR-AP3（D-AP7）：判定绑**信号状态 / latch 机械事实**——旧版对错误 message 做
        // deadline-reached 正则匹配的文本嗅探已整行删除（该正则只可能匹配我方自产 reason，
        // 而适配器以**无声样** AbortError 抛出时会被误判 interrupted 并丢超时统计尾）。
        // 裁决顺序不变：**绝对截止优先于 interrupted**（§3.4）。
        if (deadlineLatch.fired || e?.abortInfo?.trigger === "timeout") return timeoutMsg()
        if (e?.name === "AbortError" || signal?.aborted) {
          // 批 6 FR-AP5 归因源优先级：错误自带标注（我方写点/结算侧）→ 调用方信号 → 适配器自产
          // AbortError（**provider 面**，无声样 → 显式 `unknown@provider`，不静默回落成通用文案）
          const src = e?.abortInfo ? e : (signal?.aborted ? signal : e)
          const layer = e?.abortInfo?.layer ?? (signal?.aborted ? "settle" : "provider")
          return deathLine(annotateAbort(new Error("Advisor: interrupted."), src, layer, "stream aborted"), src)
        }
        const msg = e?.message ?? String(e)
        lastErr = e
        // 仅看门狗 stall 走重试：失败调用没有产出可用内容，messages 原样复用
        if (!/stalled/.test(msg)) break
        if (attempt < STREAM_ATTEMPTS) {
          if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
          await new Promise(r => setTimeout(r, 1000 * attempt))
        }
      }
    }
    if (lastErr) {
      // 预算耗尽优先于 stall 诊断（§3.4 裁决顺序）
      if (Date.now() - startTime >= timeoutMs) return timeoutMsg()
      const msg = lastErr?.message ?? String(lastErr)
      const errorType = classifyStreamError(msg)
      const retryAdvice = errorType === "rate limit" ? "Wait a moment and retry. Consider using a cheaper model for advisor."
        : errorType === "timeout" ? "The model took too long. Try with a narrower scope."
        : errorType === "context_too_long" ? "Reduce the scope (fewer files/paths) or use a model with larger context window."
        : errorType === "provider_stall" ? "The provider stream stalled after " + STREAM_ATTEMPTS + " attempts. Retry the advisor call, or configure a different advisor provider/model."
        : "You may retry or proceed to verify manually."
      return "Advisor: review failed (" + errorType + ") — " + msg + ". " + retryAdvice
    }

    const { blocks, finish } = result
    // 批 6 FR-AP6：超时尾三要素之二——「是否产出过评审正文」（本轮流出现过非空文本块）
    if (blocks.some(b => b?.type === "text" && String(b.text ?? "").trim() !== "")) reviewTextProduced = true
    // D-18：流结束结构化观测——console.warn 留档（每轮流结束都记录，含成功轮：观测连续性）
    const obsLine = streamObservationLine(finish, blocks)
    console.warn(obsLine)
    const reason = finish?.reason
    if (reason?.kind === "aborted") {
      // 批 6 FR-AP3 **返回形态同判**（§5.2 图 2 E 节点）：子代理/流可能以 resolve
      //（`reason.kind === "aborted"`）而非 reject 结束——此时错误对象里没有「谁按下的」，
      // 必须读 latch（D-AP4）。
      //
      // ⚠ 批 6 修复轮（审计 🟡 #2）：下面这行**是防御式的，当前不可达**——「复合信号已中止且
      // 用户信号未中止」需要看门狗/截止定时器点火，而 wd.signal 一旦 abort，collectStream 的
      // stallP（`wd.signal.addEventListener("abort", () => reject(...))`）**恒先 settle**
      // ⇒ 走的是抛错形态（上方 catch 的 `deadlineLatch.fired` 分支），本行永不执行。
      // 正臂不可达 = 设计口径问题（父侧在设计档修正块中修正 AC-AP3 的判据，不在本档改）；
      // 本分支的**负臂**（用户信号变体：signal.aborted ⇒ 逐字 interrupted + settle 溯源）
      // 是可达且被 T-AP3(c) 实证的。保留本行 = 未来若 stallP 让位（无竞态）仍能正确判定。
      if (!signal?.aborted && deadlineLatch.fired) return timeoutMsg()
      const layer = signal?.aborted ? "settle" : "agent" // 未中止信号 = 我方看门狗/未知写点
      return deathLine(annotateAbort(new Error("Advisor: interrupted."), signal, layer, "stream ended aborted"), signal)
    }
    if (reason?.kind === "error") {
      const failure = reason.failure ?? {}
      const hasMsg = typeof failure.message === "string" && failure.message !== ""
      // D-01 观测（R1）：error 无 message 形态的分类行 + 观测字段（返回语义不变，重试留 R3）
      const clsLine = hasMsg ? "" : "[thincoder-suite] empty-response classification: "
        + emptyResponseClassification(finish, blocks, maxTokens) + "\n"
      // 批 6 FR-AP5（**P1 的第三个站点**——需求档 §2 P1 点名的那条 `Advisor: review failed —
      // The operation was aborted`，原设计 §5.1 的 advisor 站点清单**漏列**了它）：error 形态的
      // **中止**失败同样必须自证来源，不得静默回落成通用文案（§8.2）。判据是**结构**（调用方信号
      // 状态 / 失败对象自带 Abort|Timeout 名），**不做文本嗅探**（D-AP7 的同一纪律）。
      // 非中止的普通 provider 错误**零改动**：deathLine 对无标注且非 Abort/Timeout 名的输入
      // 逐字返回原 message（D-AP5 / AC-AP5），返回串与改动前逐字节相同。
      const body = "Advisor: review failed — " + (failure.message ?? "unknown provider error")
      const failErr = new Error(body)
      if (typeof failure.name === "string" && failure.name !== "") failErr.name = failure.name
      const layer = signal?.aborted ? "settle" : "provider" // 宿主信号面 / 适配器自产面（D-AP3）
      const line = deathLine(failErr, signal?.aborted ? signal : null, layer)
      return line + "\n" + clsLine + obsLine
    }

    const toolCalls = blocks.filter(b => b.type === "tool-call")
    const text = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("")
    if (toolCalls.length === 0) {
      const body = text.trim()
      if (body) return body
      // D-01（R3 / D-裁决-1）：空响应自动重试一次。适用形态 = R1 分类中的非基础设施
      // 形态（finish-null / stop 零文本块 / length / 非预期 finish 形态的零产出）；
      // 基础设施形态不走空重试——error（含无 message）在上方 reason.kind 检查处提前
      // 返回，stall 走看门狗 STREAM_ATTEMPTS 通道（既有失败路径）。
      // 重试 = 复用 messages 重新发起同一调用（同 stall 重试通道语义）、独立计数（不占
      // STREAM_ATTEMPTS）；continue 回循环顶 → 预算/turns 守卫照常生效（重试不豁免预算）。
      if (emptyRetryArmed) {
        emptyRetryArmed = false
        console.warn("[thincoder-suite] advisor 空响应（"
          + emptyResponseClassification(finish, blocks, maxTokens) + "）——自动重试一次（复用 messages，D-01/D-裁决-1）")
        continue
      }
      // 再空 → "Advisor:" 前缀的可归因失败（分类 + 观测字段 + 重试标记）：不烧轮次、
      // 不写 prior（finalize completed 判定按前缀失败——空响应占位文本自 R1 起即带前缀，
      // R3 将措辞收敛为显式失败语义）。
      return "Advisor: review failed (empty response — 重试一次仍空)。\n"
        + "[thincoder-suite] empty-response classification: " + emptyResponseClassification(finish, blocks, maxTokens)
        + "\n" + obsLine
    }

    messages.push(assistantMsg(blocks, provider, model))
    for (const tc of toolCalls) {
      toolCallsDone++ // 批 6 FR-AP6：超时尾「tool calls」统计（执行即计入，成败均计）
      let resultText = null
      let args = {}
      try { args = JSON.parse(tc.arguments || "{}") }
      catch (e) { resultText = "Error: invalid JSON in tool arguments: " + e.message }
      if (resultText === null) {
        const impl = impls.get(tc.name)
        if (!impl) {
          resultText = "Error: unknown tool \"" + tc.name + "\". Available: " + [...impls.keys()].join(", ")
        } else {
          try { resultText = String(await impl(args)) }
          catch (e) { resultText = "Error (execution_error): " + (e?.message ?? String(e)) }
        }
      }
      // 超时消息的「已读文件数」：read 工具调用成功执行即计入（§3.4）
      if (tc.name === "read" && resultText !== null && !String(resultText).startsWith("Error")) {
        filesRead++
      }
      messages.push(toolResultMsg(tc.id, resultText))
    }
    roundsDone++ // 本工具轮（产出 tool calls 并执行完毕）完成
    emptyRetryArmed = true // 有产出的轮 → 重置空响应重试资格（D-01：每次空产出可重试一次）
  }
}

// ————————————— 评审入口 —————————————

/**
 * F12（§2.3）写点 helper：语义转换点落盘（advisor 完成分支轮次推进 / F11 类型切换重置）。
 * viewOfSessionState 组装白名单视图 → saveSessionState（原子写 + 截断/封顶净化 + 孤儿清扫，
 * 内部 fail-safe：任何失败仅 warn 不抛——评审/签发流程不依赖持久化成功，内存态兜底）。
 * storPathOverride = opts 注入缝（对齐 F10 saveTokenRecord 先例，测试用临时目录）。
 */
function persistSessionState(agent, state, opts) {
  try {
    saveSessionState(
      agent.session.id,
      sessionStateViewWithGeneration(state), // R2 §4.4（D-10）：generation 随 F12 视图持久化
      opts?.storPathOverride,
      agent.session?.header?.cwd,
    )
  } catch { /* N3 fail-safe：写盘故障不击穿评审流程（save 内部已 warn） */ }
}

function isDocFile(p) {
  const norm = String(p).replace(/\\/g, "/")
  if (norm.startsWith("docs/")) return true
  return /\.(md|markdown|mdx|txt|rst|adoc)$/i.test(norm)
}

// ————————————— R2 §4.1 共享 jobs 派发模式（escalate/eng codex 整体复制本模块先例） —————————————
// 平台契约（登记表「平台契约要点」）：jobs.start(spec) 返回 branded string `<kind>-N`（非对象）；
// 完成通知只含一行指针（全文经 job_output 读取，保尾截断）；cancel → hooks.cancel → ctrl.abort；
// run() 内无墙钟（jobs 免疫 600s——预算由 run() 自有 watchdog 生效）。

/** UI-2（设计 §7）：后台派发返回文本的接续指令——句柄之外的唯一承诺（D-09：不承诺通知含全文）。 */
export const JOBS_CONTINUATION_INSTRUCTION =
  "等待完成通知后再继续；长任务勿用 job_output wait 阻塞等待（平台等待上限 600s）——完成通知只含一行指针，全文经 job_output 读取。"

/**
 * codexCli.budgetCapMs 解析（未配/非法 → 540000，低于平台 run_code 默认墙钟 600s 留
 * envelope 返回余量）。R2 抽共享：advisor/escalate/eng 三处派发判定与钳制告警的单一实现。
 */
export function resolveCodexBudgetCapMs(config) {
  const cc = (config && typeof config === "object" && config.codexCli
    && typeof config.codexCli === "object") ? config.codexCli : {}
  const v = cc.budgetCapMs
  return Number.isInteger(v) && v > 0 ? v : 540000
}

/** ctx.jobs 服务懒取（缺失/宿主未装配 → null；调用方走同步钳制降级 + 响亮告警）。 */
export function getJobsService(deps) {
  try { return deps?.ctx?.get?.("jobs") ?? null } catch { return null }
}

/**
 * 派发返回文本（UI-2）：机制前缀 + job 句柄 + 预算 + 接续指令。D-05：jobs.start 返回
 * branded string——直接渲染（非对象无 .id；异常形态回落 "?" 而非崩溃）。
 * R5（§7.1/§7.2，D-27）机制名泛化：escalate/eng codex 后台派发（R2）与三条后台 dsh 路径
 * （advisor dsh 循环自动派发 / escalate·eng background=true）共用本 helper——前缀/预算由
 * 调用方传入（导出别名 codexJobsDispatchReply 保留——既有消费点/测试零改动，导出兼容）。
 * D-16（R2 §4.5）：派发时 budgetCapMs ≥ 600000 输出一次不变式提醒（「确认已同步提高平台
 * maxWallMs 且 cap < wall」——插件读不到 maxWallMs〔平台唯一消费者无注入面〕，只能提醒
 * 不可强制；登记表 D-16 标注不可完全强制）。dsh 路径不传 budgetCapMs（无 codex wall-clock
 * 绑定语境——兜底 deadline 由 dshBackgroundTimeoutMs 表达，见 §7.2）。
 * @param {{prefix: string, jobId: string, budgetMs: number, budgetCapMs?: number, detail?: string}} p
 */
export function jobsDispatchReply(p) {
  const id = typeof p.jobId === "string" && p.jobId !== "" ? p.jobId : "?"
  let text = p.prefix + " started as background job " + id
    + "（预算 " + Math.round(p.budgetMs / 1000) + "s" + (p.detail ? " · " + p.detail : "") + "）。"
    + JOBS_CONTINUATION_INSTRUCTION
  if (Number.isFinite(p.budgetCapMs) && p.budgetCapMs >= 600000) {
    const reminder = "不变式提醒（D-16）：budgetCapMs=" + p.budgetCapMs
      + " ≥ 600000——确认已同步提高平台 run_code maxWallMs 且 budgetCap < maxWallMs；"
      + "否则 jobs 缺失时的同步降级路径仍会在平台墙钟处被截断"
    text += "\n\n[thincoder-suite] " + reminder + "。"
    console.warn("[thincoder-suite] " + reminder)
  }
  return text
}

/** 旧名兼容别名（R5 机制名泛化）：与新名同一函数引用——既有消费点/测试零改动。 */
export const codexJobsDispatchReply = jobsDispatchReply

// ————————————— R2 §4.3（D-06）：single-flight 在飞表（复合键 sessionId + mechanism） —————————————
// 每机制独立单飞槽位：同会话 advisor 在飞不阻塞 escalate/eng 派发，反之亦然（US-4/N-3 的
// per-session-**per-mechanism** 语义；平台每 owner 10 job 上限不是替代）。命中 → 拒绝并
// 告知在飞 job id 与接续方式；settle 时清除（done 回调成功/失败两分支都清——cancel/abort
// 经平台 cancel 链路同样落 done settle，槽位必然释放）。
const inFlightJobs = new Map() // "sessionId:mechanism" → { jobId, mechanism, reviewType, docSet }

const inFlightKeyOf = (sessionId, mechanism) => String(sessionId ?? "") + ":" + mechanism

/**
 * 派发前检查在飞槽位（advisor/escalate/eng codex 派发路径共用）。
 * @returns {string|null} 命中 → 拒绝文本（含在飞 job id 与接续方式）；未命中 → null
 */
export function checkInFlightJob(sessionId, mechanism) {
  const existing = inFlightJobs.get(inFlightKeyOf(sessionId, mechanism))
  if (!existing) return null
  return "Error: 该会话已有在飞的 " + existing.mechanism + " 后台任务（job " + existing.jobId
    + "）——等待完成通知后再继续（完成通知只含一行指针，全文经 job_output 读取；长任务勿用 "
    + "job_output wait 阻塞等待）。本次请求未派发。"
}

/**
 * jobs.start 成功后登记槽位（与 start 同一同步块——单线程无竞态窗口）。
 * 批 6b（守卫 E，设计档 §6.1 / D-E16）：第四参 `payload` 为本批扩容载荷（**位置参数**、
 * 缺省 `{}`）——既有 **6** 个三参调用点（advisor ×2 / eng ×2 / escalate ×2——分歧审计 F3
 * 订正：原文误记「5 个」且漏了 `escalate.mjs` 的第二处 `:536`）因此**零改动**仍合法。
 * `reviewType: "design"` 时必须传 `docSet`（登记时对 `state.pendingDocPaths` 的 **`.slice()`
 * 快照**，见 D-E3——槽位是窗口作用域的不可变权威，绝不持有活引用）；其余机制不传。
 * @param {Record<string, unknown>} [payload]
 */
export function setInFlightJob(sessionId, mechanism, jobId, payload) {
  const p = payload && typeof payload === "object" ? payload : {}
  inFlightJobs.set(inFlightKeyOf(sessionId, mechanism), {
    jobId: String(jobId ?? "?"),
    mechanism,
    reviewType: typeof p.reviewType === "string" ? p.reviewType : null,
    docSet: Array.isArray(p.docSet) ? p.docSet.slice() : [], // ★拷贝：不持有活引用
  })
}

/**
 * 守卫 E（预闸）只读访问器（批 6b 设计档 §6.1 / D-E5）：扫**全表**找武装中的 design 冻结窗口。
 * 扫全表而非键查：子代理 `session.id` ≠ 父 ⇒ 键查必然 miss，而子代理恰是典型漂移向量。
 * 多条 design 槽位同时武装 → 全部并入（文档级并集语义；窗口有界、并发度低）。
 * 本函数是槽位读取的**唯一**面（预闸不直接摸 Map）。
 * @returns {{jobIds: string[], docSet: string[]}|null} 无武装窗口 → null（窗口判定区，不可抛）
 */
export function designFreezeSet() {
  const jobIds = []
  const docSet = new Set()
  for (const slot of inFlightJobs.values()) {
    if (slot?.reviewType !== "design") continue
    if (!Array.isArray(slot.docSet) || slot.docSet.length === 0) continue
    jobIds.push(slot.jobId)
    for (const d of slot.docSet) docSet.add(d)
  }
  return jobIds.length > 0 ? { jobIds, docSet: [...docSet] } : null
}

/** done settle（成功/失败/中止皆算 settle）时清除槽位。 */
export function clearInFlightJob(sessionId, mechanism) {
  inFlightJobs.delete(inFlightKeyOf(sessionId, mechanism))
}

// ————————————— R2 §4.4（D-10）：advisorGeneration 代际检查 —————————————
// sessionState.advisorGeneration（整数，随 F12 视图持久化）。语义转换点 +1：eng 交付重置、
// F11 类型切换、config apply-session 变更；job 派发时捕获代际，finalize 应用前校验——
// 不匹配 → 丢弃状态变更 + 完成通知注明（晚到的完成不得复活已被重置的状态，N-3）。

/** 生效代际（未设/非法 → 0）。 */
export function advisorGenerationOf(state) {
  const v = state?.advisorGeneration
  return Number.isInteger(v) && v >= 0 ? v : 0
}

/** 代际 +1（语义转换点调用）。返回新代际。 */
export function bumpAdvisorGeneration(state) {
  state.advisorGeneration = advisorGenerationOf(state) + 1
  return state.advisorGeneration
}

/**
 * F12 视图 + advisorGeneration + lastDesignDocKey：这两个条件字段不在 viewOfSessionState 七字段
 * 视图内——经本 helper 在调用侧拼入（session-store.normalizeRestored 白名单收口）。**所有**
 * saveSessionState 写点统一经此组装：saveSessionState 是整条目替换写，任一写点漏带
 * generation 即丢代际（D-10 守卫弱化为仅内存态）；同理漏带 lastDesignDocKey 即丢链作用域键
 * （批 4 §12 —— 重启后同一文档集被误判为新链，收敛轮提示词 + 跨文档 prior 污染复活）。
 */
export function sessionStateViewWithGeneration(state) {
  const s = (state && typeof state === "object") ? state : {}
  const out = { ...viewOfSessionState(s), advisorGeneration: advisorGenerationOf(s) }
  // 批 4 §12（FR-G9/N-7）：lastDesignDocKey 白名单字段（可选——键不存在时不引入，
  // 键集兼容既有断言；空串同「无值」）。
  if (typeof s.lastDesignDocKey === "string" && s.lastDesignDocKey !== "") {
    out.lastDesignDocKey = s.lastDesignDocKey
  }
  return out
}

function withTime(prompt) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local"
  return prompt + "\n\nCurrent time: " + new Date().toLocaleString("sv-SE") + " (" + timeZone + ")."
}

/**
 * 运行一次 advisor 评审（收敛协议入口 + 分层路由）。
 * @param deps  { llm } — 宿主 LlmRuntime
 * @param opts  { agent, config, signal, reviewType, documents, paths, configDefaultEngineering,
 *               storPathOverride? } — storPathOverride = F10 存储路径注入缝（测试用临时目录，
 *               对齐 stallMsOverride 先例，非用户配置；缺省走 token-store 的 DSH_HOME 解析）
 * @returns 评审文本（错误/上限消息以 "Advisor:" 前缀返回；例外：single-flight 在飞拒绝
 *   〔checkInFlightJob 命中——入口/派发点二次检查两处〕以 "Error:" 前缀返回——属工具级
 *   并发错误而非评审失败，不进入 finalize completed 判定的 "Advisor:" 语义域
 *   〔R3 code review 收尾 ④（R4 折入）注记：JSDoc 补例外，无行为变化〕）
 */
export async function runAdvisorReview(deps, opts) {
  const { agent, signal } = opts
  // 二期（docs/2026-09-02-settings-ui-design.md §2/§3.6-1）：config 消费点统一合并 user 层——
  // 生效全局 = entry base ⊕ config.json user 层（每次评审调用时读，保存即生效 U5；
  // config.json 缺失/损坏 → 无 user 层回落 base，N3）。agent session cwd 作路径探测起点。
  const config = effectiveGlobalConfig(opts.config ?? {}, { cwdHint: agent?.session?.header?.cwd })
  const state = sessionState(agent.session.id)
  const sid = agent.session.id
  // R3 §5.4（D-06 同步路径单飞扩展）：single-flight 检查提前到 advisor 机制全部入口——
  // 同会话 advisor 后台 job 在飞期间任何新调用被拒（含 ≤cap 同步调用 / dsh 主路径 /
  // 智能回落轮；拒绝文本含在飞 job id 与接续指引），关闭轮次/prior 双写窗口。派发点的
  // 二次检查保留：入口 → jobs.start 之间的 await 窗口（effort 解析等）内仍可能被他方
  // 派发占位。
  const inFlightAtEntry = checkInFlightJob(sid, "advisor")
  if (inFlightAtEntry) return inFlightAtEntry
  // R3 §5.1（D-07 / D-裁决-3）硬停 held 检查：armed 状态下同会话后续 advisor 调用持续返回
  // 硬停指引而非静默重试（不烧轮次/不跑任何路由——held 判定先于全部状态变更）；advisor
  // 相关配置已变更（路由指纹失配）→ 自动解除恢复常规执行。会话重置经 D-22 清理组
  //（clearCodexFailureCount 已扩展清硬停状态）解除。
  const hsEntry = advisorHardStops.get(sid)
  if (hsEntry) {
    if (advisorRouteFingerprint(config, state.advisorOverride ?? null, agent.options ?? {}) !== hsEntry.fingerprint) {
      advisorHardStops.delete(sid)
      resetRouteFailureState(sid)
      console.warn("[thincoder-suite] advisor 回落硬停解除——advisor 相关配置已变更（路由指纹失配），恢复常规执行")
    } else {
      return fallbackHardStopText(sid, {
        config, override: state.advisorOverride ?? null, agentOpts: agent.options ?? {},
        advisorRound: state.advisorRound,
      })
    }
  }
  // ————————————— 批 4 三振结算护栏预检（FR-G2/D-G2；**必须零副作用**，N-1） —————————————
  // 位置是本批的**硬纪律**（D-G2）：晚于 single-flight / 硬停 held（更早的停机轴，且硬停自带
  // 指纹自愈），**先于 F11 类型切换 / 链重置**——后者会改 advisorRound/prior/代际并落盘，
  // 预检放在它们之后就不再是零副作用（被拒的发起会把在途的 code 评审序列重置掉，P4）。
  // 同类纪律的第二个对象（§13 #5）：**三振预检先于链重置**——被拒时不得写 lastDesignDocKey、
  // 不得重置（下面 needReset 分支根本不会执行到）。
  // 计数键只取本次调用的 documents（D-G3）；空集走哨兵 "empty"。
  const reviewTypeEarly = opts.reviewType === "design" ? "design" : "code"
  const docKeyEarly = reviewTypeEarly === "design" ? designDocKey(opts.documents) : null
  const chainKeyEarly = reviewTypeEarly === "design" ? designChainKey(opts.documents) : null
  if (reviewTypeEarly === "design" && designStrikes(sid, docKeyEarly) >= DESIGN_STRIKE_LIMIT) {
    // 零 LLM（不进路由/不进工具循环）、零状态变更（下面任何写点都未执行）——"Advisor:" 前缀。
    return settlementGuardText(sid, docKeyEarly)
  }
  // ——————————— 批 4 评审微修 #1：设计文档合法性校验**前移**到链重置之前 ———————————
  // 原位置在本函数后段（链重置 / 落盘**之后**）：写法上「先摧毁在途链，再被拒」——用户对文档集 A
  // 已收敛到 round 3，一次手滑把 ["docs/a.md","src/typo.mjs"] 发进 design 评审 ⇒ `chainKeyChanged`
  // 成立 ⇒ A 的 prior 被清空**且已落盘**，随后调用才因非法文档被拒；而 D-G10 把「非法文档」定性为
  // **预检类拒绝**（零 LLM、调用方**立即可自纠**）——后置顺序让「立即可自纠」事实上不成立。
  // 前移后本判定**纯读、零状态变更**（不写 lastDesignDocKey、不重置、不落盘）：在**三振预检之后**
  // （D-G2 钉死的是三振预检先于链重置，这是同一条纪律的另一个对象，位置关系不变）、链重置之前。
  // 谓词与错误文案与原文**逐字一致**（既有断言不得转红）；自足取自 opts.reviewType / opts.documents
  // （不为此把后面的 `const documents` 声明上移）。
  if (reviewTypeEarly === "design" && Array.isArray(opts.documents)) {
    const invalid = opts.documents.filter(d => !isDocFile(String(d)))
    if (invalid.length > 0) {
      return "Advisor: design review documents must be in docs/ directory or be recognized doc files. Invalid: " + invalid.join(", ")
    }
  }
  const reviewType = opts.reviewType === "design" ? "design" : "code"
  // F11（2026-09-02 reviewType 隔离）：code ↔ design 切换 → 重置轮次与 prior——
  // 轮次上限自批 4 起只剩 code 一侧（D-G1），但**类型切换仍然重置**轮次与 prior：
  // 新设计文档评审必须从 round 1 开始，不得携带 code 评审的 prior（实测事故：code review 3 轮后
  // 发起 design 评审走了收敛轮，扩展文档未被 round 1 评审）。
  // F12（§2.3 写点表）：类型切换重置也是语义转换点——重置为 0/清 prior 同样落盘
  // （否则重启后恢复出切换前的旧轮次/prior，跨类型污染复活）。
  // §12（D-35/FR-G9，本批折入）：设计评审链是**文档集级**而非会话级——换一份文档集仍沿用会话
  // 轮次 ⇒ 第二份文档拿到收敛轮提示词（只验证、不找新问题）且 prior 是**另一份文档**的发现，
  // 据此铸出的令牌声称覆盖的文档从未被真正评审（静默）。修法 = 链作用域键 = designDocKey 的
  // 同一把键；`lastDesignDocKey` 存在且 ≠ 本次 docKey ⇒ **等价于类型切换**。
  // §13 #9 钉死：FR-G9 与 F11 **合成单一重置谓词**（`needReset`），重置动作**各只执行一次**
  // （round=0 / prior=null / 代际+1 / 落盘）——否决两条独立分支各重置一遍。
  // 比较对象 = **持久化表示**（designChainKey，见其 JSDoc：AC-20 禁 raw 路径入镜像）。
  const typeSwitched = state.lastReviewType && state.lastReviewType !== reviewType
  const prevDocKey = state.lastDesignDocKey ?? null
  const chainKeyChanged = reviewType === "design" && prevDocKey !== null && prevDocKey !== chainKeyEarly
  const needReset = Boolean(typeSwitched) || chainKeyChanged
  if (needReset) {
    state.advisorRound = 0
    state.lastAdvisorOutput = null
    bumpAdvisorGeneration(state) // R2 §4.4（D-10）：语义转换点，代际 +1（在飞 advisor 结果按旧类型解析，晚到即弃）
  }
  state.lastReviewType = reviewType
  // 链作用域键写点：随本次判定写内存；换集/首写都要落盘（否则重启后失配 —— §12「必须落盘」）。
  const chainKeyWritten = reviewType === "design" && prevDocKey !== chainKeyEarly
  if (reviewType === "design") state.lastDesignDocKey = chainKeyEarly
  if (needReset || chainKeyWritten) persistSessionState(agent, state, opts)
  const documents = Array.isArray(opts.documents) ? opts.documents : null
  const paths = Array.isArray(opts.paths) && opts.paths.length > 0
    ? opts.paths
    : (state.touchedFiles?.length ? [...state.touchedFiles] : null)

  if (reviewType !== "design" && !paths && !documents) {
    return "Advisor: no review scope specified. Provide paths (files/directories to review) or documents (acceptance criteria context)."
  }
  // design 的文档合法性校验已前移到链重置之前（批 4 评审微修 #1）——此处不再重复：后置校验
  // 会在拒绝之前先执行链重置/落盘，破坏 D-G10 对预检类拒绝「零状态变更、调用方立即可自纠」的定性。

  // 机械收敛上限（第 6 次零 LLM 直接拒）——**本批 D-G1：cap 只对代码评审生效**（design 豁免）；
  // 豁免的只是「第 6 次拒绝」这一轴（D-G11：轮次照增、提示词轮换与落盘零改），design 侧改由
  // 上面的三振结算护栏兜底（成对吸收：只豁免 = 撤掉唯一的界；只护栏 = P1 误杀原样保留）。
  // 消息体（含 unfixed 提取与三条 Options）**逐字节不动** —— code 路径契约，§8.1 零改面。
  if (reviewType !== "design" && (state.advisorRound || 0) >= MAX_ADVISOR_ROUNDS) {
    const unfixed = extractUnfixedIssues(state.lastAdvisorOutput)
    let message = "Advisor: convergence cap reached after " + MAX_ADVISOR_ROUNDS + " rounds.\n"
    if (unfixed.length > 0) {
      message += "\nUnresolved issues from prior rounds:\n" + unfixed.map(i => "- " + i).join("\n") + "\n"
    } else {
      message += "\nAll prior issues appear resolved.\n"
    }
    message += "\nOptions:\n1. Accept current state and proceed\n2. Manually review specific concerns with read/grep\n3. Start a new session to reset the advisor"
    return message
  }

  const agentOpts = agent.options ?? {}
  const cwd = agent.session?.header?.cwd || process.cwd()

  // 无 prior 且本 run 无代码变更 → 重置轮次预算（对齐 thincoder 2026-08-05 决策）。
  // 先于路由解析执行：重置后 advisorRound=0 → round1 组（§3.2 路由键语义）
  const hasPrior = (state.advisorRound || 0) > 0 && state.lastAdvisorOutput
  if (!hasPrior && !(state.mutatedThisRun ?? false)) state.advisorRound = 0

  // 分层路由（§3.1/§3.2）：组配置解析 + 会话覆盖（§3.6）→ legacy → 主代理路由
  const override = state.advisorOverride ?? null
  const route = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: state.advisorRound })
  for (const w of route.warnings) console.warn("[thincoder-suite] " + w)
  // code review #3：N4 配置警告随工具返回文本带出（主会话可见；不进 lastAdvisorOutput，避免污染 prior 原文）
  const warnPrefix = route.warnings.length > 0
    ? "⚠️ [thincoder-suite] advisor configuration warnings:\n" + route.warnings.join("\n") + "\n\n"
    : ""
  if (!route.ok) {
    return warnPrefix + "Advisor: no LLM route available — configure advisor.round1 / advisor.convergence (or legacy advisor.provider / advisor.model) in the plugin config, or run from a session with a default model route."
  }

  // R2：designToken 每评审会话只铸造一次——首次 design 评审铸造后存 sessionState，
  // 整个 advisor 调用序列（round 1 与收敛轮）复用同一 token → 每轮 Approval Signal
  // 展示同一批准码。存量 token 失效（过期/畸形）时重铸，否则长会话将永远签不出有效 token。
  let designToken = null
  // 批 6b（守卫 E，设计档 §6.1 C5 / D-E6）：**闭包捕获**的铸造对。声明在 `if (reviewType ===
  // "design")` 块**之外**——块内 `const` 在块外（jobs 派发点）不可见；语义与设计档伪代码
  // 逐字等价：捕获时点 = 铸造块末尾（`computeDocHash` 之后），此后 finalize 与两个派发点
  // 一律只读捕获值，**绝不回读活 state 的并集快照**（机验锚 A1）。
  let castDocPaths = []
  let castDocHash = null
  if (reviewType === "design") {
    if (!state.pendingDesignToken || !validateDesignToken(state.pendingDesignToken)) {
      state.pendingDesignToken = generateDesignToken(config)
      state.pendingDocPaths = [] // 重铸 = 新评审会话：文档集并集从本轮重新起算
    }
    // D-30（FR-T5）：快照时点 = 令牌铸造时（决策 D5），快照内容 = **历轮文档集之并集**（设计评审 #2）。
    // 授权语义覆盖「讨论中出现的全部文档」：首铸轮绑 [A]、后续轮并入 [B,C] 时 B/C 也被绑进指纹，
    // 否则 B/C 漂移而续期仍放行（收窄攻击面见 AC-19/AC-27）。**绝不使用 eng_coder 的 args.docs**
    // （那是任务书的阅读清单，由主代理控制，不是评审范围）。
    // 空文档集 → 不写 docHash（决策 D6：空集 hash 恒等，会让续期护栏真空为真）；任一文档读不到
    // （computeDocHash ok:false）→ 同样不写（N3 fail-closed：续期一律拒绝）。
    const union = [...(Array.isArray(state.pendingDocPaths) ? state.pendingDocPaths : []), ...(documents ?? [])]
    const dh = computeDocHash(union)
    state.pendingDocPaths = dh.docPaths
    state.pendingDocHash = dh.ok && dh.docPaths.length > 0 ? dh.hash : null
    // 批 6b（守卫 E，D-E6）：铸造块末尾立即捕获本轮冻结副本 + 指纹基准。
    castDocPaths = [...state.pendingDocPaths] // 本轮冻结副本（值拷贝——不持有活引用）
    castDocHash = state.pendingDocHash
    designToken = state.pendingDesignToken
  }
  const history = (() => { try { return agent.session?.deriveMessages?.() ?? [] } catch { return [] } })()
  const engineering = engEffective(state, opts.configDefaultEngineering)
  const includeProjectGuide = resolveIncludeProjectGuide({ config, override }).value

  const system = withTime(buildAdvisorSystemPrompt(state, reviewType))
  const userText = buildAdvisorUserMessage({
    cwd, history, state, reviewType, designToken, documents, paths, engineering, includeProjectGuide,
  })

  // —— 结果收尾抽为闭包（评审反馈落地）：同步/异步（jobs 后台）路径共用同一 finalize，
  // 保证 completed 判定/轮次推进/prior/design token「恰好一次」且两路语义不漂移。 —————————————
  // 批 4（D-G5）：第二参数 `kindHint` = **站点机械事实**（stale / timeout-from-backstop /
  // codex TIMEOUT 信封），优先于前缀表归类；其余形态由 classifySettlement 按自产串前缀表兜底。
  const finalize = (result, kindHint) => {
    let final = result
    const completed = !String(result).trimStart().startsWith("Advisor:")
    if (completed) {
      // R3 §5.1（D-07）：任一路由成功 → 双计数器/最近失败码/硬停状态全部清零（正向清零）。
      // 成功清零与轮次推进同点（finalize 恰好一次）——回落轮的 delete 因此天然满足「回落轮
      // 结果产出后才执行」（旧代码在回落执行前 delete 的顺序错误就此消除：回落失败不清零
      // → 下一调用直接再进回落轮，连续 2 次回落失败即硬停）。
      resetRouteFailureState(sid)
      final = appendCitationReport(result, cwd)
      const trimmed = final.trim()
      const looksLikeReview = /\|.*\|.*\|/.test(trimmed) || trimmed.length >= 200
      if (looksLikeReview) state.lastAdvisorOutput = final
      state.advisorRound = (state.advisorRound || 0) + 1
      // F12（§2.3 写点表）：完成分支轮次推进后写盘（advisorRound/lastAdvisorOutput/
      // lastReviewType 原子组——§2.1：单存轮次会恢复出「无 prior 的收敛轮」；touchedFiles
      // 若有并入同样被本视图覆盖）。失败仅 warn（N3：丢=回内存行为）。
      persistSessionState(agent, state, opts)
    }

    if (reviewType === "design") {
      // R2 签发判定：裁决通过（isApprovalVerdict 启发式）∧ [APPROVE:<code>] 回显命中，
      // 缺一不可。code 展示在每轮 Approval Signal（token 本体不进提示词），宿主校验
      // 命中后自行注入完整 token；非通过轮的任何 code 回显忽略（不签发不报错）；
      // 旧格式 [DESIGN-TOKEN:...] 路径已废除，与未回显同待遇。
      const code = designToken ? designApprovalCode(designToken) : null
      // FR-1（设计档 §5.4，最小 diff）：VERDICT 优先，启发式退回**回落**角色（D-h 不扩词表）——
      //   pass    → 还需**无未解决阻塞行**（D-a/D-b：verdict 与表格矛盾时不得签发）
      //   absent  → 回落 isApprovalVerdict（N1：无 VERDICT 行时逐字节等价于今日）
      //   fail/invalid → 一律 false（D-f：显式 verdict 畸形**不回落**）
      const verdict = parseVerdict(result)
      const verdictPassed = completed && (
        verdict.kind === "pass" ? !hasUnresolvedBlockingRow(result)
          : verdict.kind === "absent" ? isApprovalVerdict(result)
            : false
      )
      const echoOk = Boolean(designToken && result && verdictPassed && code
        && makeApprovalCodeRegex(code).test(result))
      if (echoOk) {
        // ★守卫 E 兜底（批 6b §6.2 / D-E7）：签发前重算并集指纹。纯读判定，**先于一切状态写点**
        //（`state.designToken` / `saveTokenRecord`）——否则需要事后回滚 = 复制批 4 撤销路径。
        // 基准 = **闭包捕获**的铸造对（D-E6），绝不读活 state 上的 pending 文档快照（机验锚 A1）。
        // `warnPrefix` 是本 finalize 闭包**外层**的既有局部量（路由解析处定义），逐字沿用。
        // `fresh` 只算一次（下分支复用它的 missing 清单——**不要重复调用**，那是多余的 N 次 fs 读）。
        const fresh = castDocHash === null ? null : computeDocHash(castDocPaths)
        const drifted = fresh !== null && (!fresh.ok || fresh.hash !== castDocHash)
        if (drifted) {
          // D-E9：复位轮次 —— 漂移内容从未被评审，绝不能让下一轮以「收敛轮」提示词 + 已失效
          // prior 去只验证不找新问题（那是真实的放行面）。**不** bumpAdvisorGeneration（D-E9）。
          state.advisorRound = 0
          state.lastAdvisorOutput = null
          persistSessionState(agent, state, opts)
          console.warn("[thincoder-suite] 守卫 E：签发前文档集指纹失配（冻结 " + castDocPaths.length
            + " 份文档）——本次不签发。")
          const cleanDrift = String(result).replace(makeApprovalCodeRegex(code, "g"), "").trim()
          const missList = !fresh.ok && Array.isArray(fresh.missing) && fresh.missing.length > 0
            ? "\nUnreadable (deleted / renamed / permission):\n" + fresh.missing.map(p => "- " + p).join("\n")
            : ""
          // D-E8：**早返回** —— 绕过下方通用计振尾（对该打点函数零调用；既不加 1 也不复位）。
          return warnPrefix + cleanDrift
            + "\n\n[thincoder-suite] guard E: the reviewed document set changed while the review was in flight — "
            + "no designToken was issued for this round." + missList
            + "\nThe other clauses hold: the existing token (if any) is NOT revoked, this round does NOT count "
            + "against the settlement guard, and the round counter has been reset."
            + "\nOption: make sure the documents are stable, then re-issue advisor(type='design') for a full re-review."
        }
        state.designToken = designToken
        // F10：签发落盘（docs/2026-09-02 §2.1 写入时序，state.designToken = designToken 之后、
        // 返回前）——token 持久化为第二存储（重启后 eng_coder 仍可用）。saveTokenRecord 内部
        // mkdir/读写失败仅 console.warn 不抛（N2 fail-safe：签发不依赖持久化成功，内存态兜底）；
        // expiresAt 取 token 第二段（tokenExpiryMs，与 expiryLabel 同解析路径）。
        // 批 4 §5.4（P3 漏洞 ②）：返回值**必须接住**（现状被丢弃）——它是「凭证落盘失败」这一
        // 计数形态的唯一机械事实来源。**不改** token 生命周期（铸造/续期/撤销零改，只接住返回值）。
        const persisted = saveTokenRecord(agent.session.id, {
          token: designToken,
          issuedAt: Date.now(),
          expiresAt: tokenExpiryMs(designToken),
          // D-30（FR-T5/FR-T8）：文档集指纹随签发落盘——它是**续期判定的唯一输入**（token-store
          // 保存路径已补字段，清扫规则对「过期但带 docHash」的记录保留 30d）。空文档集时
          // pendingDocHash === null → token-store 不写该字段（旧记录亦无此字段：读得动、按
          // 「无法续期」处理，N7）。
          // 批 6b（D-E6）：喂料换**闭包捕获值**（不是活 state）——稳定时与今日逐字节等值，而
          // 正确性不再依赖「窗口内无第二写点」这一不变式（读活版将来会静默退化成自比恒真）。
          docHash: castDocHash,
          docPaths: castDocPaths,
        }, opts.storPathOverride, agent.session?.header?.cwd)
        // 批 4 §5.4 复位面（FR-G6）：可用判决 = pass ∧ 回显 ∧ **落盘成功** → 复位该键。
        // §13 #6 口径收紧：`token_persist_failed` **仅当** verdictPassed ∧ echoOk ∧ persisted === false
        //（本分支即此态）；**其余非可用态一律 review_failed**（下面的非签发分支打点）。
        recordDesignSettlement(sid, docKeyEarly, persisted === true ? null : "token_persist_failed")
        const clean = String(result).replace(makeApprovalCodeRegex(code, "g"), "").trim()
        return warnPrefix + clean + "\n\nApproved. Pass this exact token to eng_coder (designToken parameter): " + designToken
          + "\n（有效至 " + expiryLabel(designToken) + "，TTL engTokenTtlMs）"
      }
      // FR-5（D-i / D-34）撤销**收紧** + FR-6 守卫（方案 A / 2026-09-12）—— 只有「明确的否定裁决」
      // 或「猜是没过、且没有可保的授权」才撤销，且**永不静默**（N7）。三种情形（设计档 §4.5）：
      //   ① verdict 显式 FAIL（`kind === "fail"`）→ **仍撤销**：评审员**明说**未通过，不是猜测，
      //      故**不受守卫影响**（拿明确裁决去保住旧授权才是错的）。
      //   ② 无 VERDICT 行 且 回落启发式为假（`heuristicFail`）→ 这是宿主**看不懂**的结果，
      //      故先问一句「有没有值得保的授权」：`state.designToken` **存在且有效** → **不撤销**、
      //      只诊断（守卫命中）—— 一次「看不懂」不该销毁既得的有效授权（D-34 的危害本体）；
      //      无有效令牌 → 撤销（D-33 的 fail-closed 语义原样保留：判不准时不该拿着旧令牌开工）。
      //      守卫查的是**有效**而非「存在」：已过期/畸形的令牌本就不能用，不构成要保的授权。
      //   ③ verdict PASS 但回显缺失/不符 → **不撤销**：回显是**签发时**的门禁，不构成作废
      //      **已签发**凭证的理由（一次「忘带回显」不该升级为丢掉已有授权）。
      // 收紧前是 `if (completed)` —— 它覆盖**每一个完成但未签发的 design 轮**（含 ②③），于是
      // 「成功签发之后的后续轮」只消一次启发式 miss 就会被清掉（D-33 现场即如此）。
      // 守卫值必须在**任何 state 变更之前**求值（下面的 `state.designToken = null` 是唯一写点）。
      const explicitFail = verdict.kind === "fail"
      const heuristicFail = verdict.kind === "absent" && !isApprovalVerdict(result)
      const heuristicFailGuarded = heuristicFail
        && Boolean(state.designToken) && validateDesignToken(state.designToken)
      // 「本轮撤不撤销、因何撤销」**只算一次**（单一事实源）：撤销动作（state + 磁盘 + warn 留痕）
      // 与下方的诊断文案都从 `revokeReason` 派生 —— 杜绝「真撤销了、诊断却说未撤销」这类两支漂移（N7）。
      // null = 不撤销；非 null = 撤销原因（同时充当留痕标签）。
      const revokeReason = explicitFail ? "VERDICT: FAIL" // ① 明说
        : heuristicFail && !heuristicFailGuarded ? "无 VERDICT 行且回落判定为不通过" // ② 猜（守卫未命中）
          : null // absent 守卫命中 / invalid / pass 侧回显问题 → 一律不撤销
      if (completed && revokeReason) {
        state.designToken = null // 评审没过 → 撤销既有签发（pendingDesignToken 保持：下轮同一批准码）
        // 评审 #2：磁盘同步撤销，防重启后复活。**撤销必须留痕**（D-34 可观测性）：布尔返回值
        // 此前被直接丢弃，「令牌为什么没了」成了排查时最耗时的一步。
        const removed = removeTokenRecord(agent.session.id, opts.storPathOverride, agent.session?.header?.cwd)
        console.warn("[thincoder-suite] advisor design token 撤销（"
          + revokeReason + "，session " + agent.session.id + "）——磁盘记录"
          + (removed ? "已删除" : "**删除失败**：内存态已撤销，但重启后该记录可能经续期回填路径复活"))
      }
      // —— 批 4 §5.4 结算打点（**非签发路径**；设计评审的计数面，code 评审 docKey=null 天然跳过）——
      // 复位面（D-G6）：**显式 `VERDICT: FAIL` 也是可用判决** → 复位。它与同一分支里 token 被
      // 撤销是**两条正交轴**（FAIL 同时撤销 token 是本分支既有语义）——注释钉死，防将来「修一致」
      // 把它们合并（合并会让 FAIL 不再复位 = 正常收敛循环被误计为「无结算」）。
      // 计数面/不计数面：不以 "Advisor:" 开头 = 完成态但**无可用判决**（verdict absent/invalid、
      // pass 但阻塞行矛盾/回显缺失、looksLikeReview === false）→ review_failed；`interrupted`
      // （用户主动中断，US-4）→ **不计**；其余失败 settlement 按前缀表/站点 hint 归类。
      if (completed && explicitFail) recordDesignSettlement(sid, docKeyEarly, null)
      else if (!completed) {
        const kind = classifySettlement(result, kindHint)
        if (kind && kind !== "interrupted") recordDesignSettlement(sid, docKeyEarly, kind)
      } else recordDesignSettlement(sid, docKeyEarly, "review_failed")
      if (result) {
        let out = String(result)
        // FR-4（D-33）：六类可区分诊断（设计档 §4.4）。此前诊断被 `verdictPassed` 门住 →
        // 「评审员表达了通过但宿主没识别」这一整类**完全静默**（用户只看到下游的「从未签发」）。
        const diagnosis = !completed ? null // 失败轮（Advisor: 前缀）不是评审结论 → 维持既有行为
          : verdict.kind === "pass" ? (hasUnresolvedBlockingRow(result) ? VERDICT_DIAG.contradiction : VERDICT_DIAG.echo)
            : verdict.kind === "fail" ? VERDICT_DIAG.fail
              : verdict.kind === "invalid" ? verdictInvalidDiag(verdict.reason)
                // absent：回显有效的那一支已在上面 return（正常签发），走到这里必是回显缺失/不符
                : isApprovalVerdict(result) ? VERDICT_DIAG.echo
                  // 与撤销动作**同源**（`revokeReason`）：非空 = 真撤销了 → 撤销支文案；
                  // 为空 = FR-6 守卫把「猜出来的不通过」拦下了（已有有效令牌）→「未撤销」文案。
                  // 两条诊断必须可区分（N7 / AC-V23 ③），故不可共用同一常量。
                  : revokeReason ? VERDICT_DIAG.absentFail : VERDICT_DIAG.absentFailKept
        if (diagnosis) out += diagnosis
        const body = out.trim() || "Advisor: design review did not pass."
        return warnPrefix + body
      }
    }
    return warnPrefix + final
  }

  // §3.6 maxOutputTokens 运行时读取（effectiveGlobalConfig 已合并 user 层；越界回落缺省+告警）
  const advisorMaxTokens = resolveAdvisorMaxOutputTokens(config)
  // D-02 L1（R1）：codex 行 effort 收口——resolveAdvisorRoute 输出（runner.effort ?? 组 effort）
  // → buildCodexArgs 之前统一走 resolveCodexRowEffort（codex models catalog 校验，最近支持档
  // 回落 / off→不传 / 目录未命中→透传+告警）。codexRunner 在下方 codex 分支解析后生效。
  let codexRunner = route.runner
  let codexEffNote = null
  const runTask = (timeoutMs, signal) => runCodexTask(deps, {
    taskText: "You are performing an independent review. Follow the review protocol below exactly.\n\n"
      + "=== REVIEW PROTOCOL (system instructions) ===\n" + system + "\n\n"
      + "=== REVIEW REQUEST (user message) ===\n" + userText,
    cwd,
    sandbox: "read-only",
    timeoutMs,
    runner: codexRunner,
    config,
    signal,
  })

  let result
  try {
    // —— 智能回落（二期评审反馈）：codex runner 连续 2 次失败 → 本轮自动回落 dsh 路由
    // 一轮（响亮告警非静默；回落成功后计数清零、codex 下轮重试——网络类瞬态故障可自愈）。
    // 预算上限 codexCli.budgetCapMs（默认 540000）须低于 run_code maxWallMs——用户提墙钟
    // 时同步上调（另一会话 40 分钟预算反馈：截断 + 告警比无声被平台墙钟杀死诚实）。
    const failCount = codexFailureCount.get(sid) ?? 0
    const codexWanted = route.runner && route.runner.kind === "codex-cli"
    // 预算上限 codexCli.budgetCapMs（R2 抽共享 resolveCodexBudgetCapMs——escalate/eng 同源）
    const budgetCap = resolveCodexBudgetCapMs(config)
    // 批 4 §5.4（D-G5）：codex 失败信封的**机械事实**归类——`TIMEOUT` 信封按 `timeout` 计振
    //（默认兜底会把 "Advisor: review failed (codex-cli TIMEOUT)" 归成 review_failed，与 dsh 路径
    // 的 review timeout 口径分裂）；`ABORTED` 信封（codex-adapter 的中止信号结算）按 **`interrupted`**
    // 归类 —— 那是**用户主动中断**（US-4：不计振），不归类会让 "Advisor: review failed (codex-cli
    // ABORTED)" 落进前缀表兜底 `review_failed` ⇒ 把用户的中断计成一次连败（与 dsh 路径
    // `runAdvisorToolLoop` 返回 "Advisor: interrupted." 的口径分裂，§5.4 第 11 行）。
    // `interrupted` 由 finalize 的结算打点**显式豁免**（`kind !== "interrupted"` 才 +1）——
    // 与 classifySettlement 对 "Advisor: interrupted." 的语义同一条纪律。
    // 其余 code 保持默认归类（不改任何既有 code 路径语义）。
    const codexSettlementHint = (env) => !env?.ok
      ? (env?.code === "TIMEOUT" ? "timeout" : env?.code === "ABORTED" ? "interrupted" : undefined)
      : undefined

    // —— 智能回落（R3 §5.1 D-07 精确计数器语义）：codex 连续 2 次失败 → 本轮自动回落 dsh
    // 路由（响亮告警非静默）。回落轮失败不清零 codex 计数（旧代码在回落执行前 delete——
    // 顺序修正为「结果产出后、仅成功时」经 finalize completed 分支 resetRouteFailureState）
    // → 下一调用直接再进回落轮；连续 2 次回落失败 → 硬停（双路由诊断，不再交替重试）。
    if (codexWanted && failCount >= CODEX_FAILURE_FALLBACK_THRESHOLD) {
      const fbRoute = resolveAdvisorRoute({ config, override, agentOpts, advisorRound: state.advisorRound, ignoreRunner: true })
      // 评审教训（附录 D.3）：失败/通知文本放后缀——"Advisor:" 必须是失败结果的第一个 token
      if (!fbRoute.ok) {
        // 回落路由不可达 = 回落失败（D-07：任何零进度组合同经「连续 2 次回落失败」硬停终止）
        const fbFails = bumpFallbackFailure(sid, "回落 dsh 路由不可用（组内未配 provider/model、无 legacy、主代理无默认路由）")
        if (fbFails >= FALLBACK_HARD_STOP_THRESHOLD) {
          return armFallbackHardStop(sid, { config, override, agentOpts, advisorRound: state.advisorRound })
        }
        return "Advisor: codex runner 连续 " + failCount + " 次失败，且回落 dsh 路由不可用（组内未配 provider/model、无 legacy、主代理无默认路由）。请修正配置。"
          + "\n[thincoder-suite] 回落失败 " + fbFails + "/" + FALLBACK_HARD_STOP_THRESHOLD
          + "——再失败一次将硬停整个自愈循环（D-07/D-裁决-3）。"
      }
      // 评审反馈：回落模型的 effort 按其实际档位校验/回落（resolveSupportedEffort）
      // D-17：回落轮预算钳制（与 codex 路径对称——超 budgetCap 部分在平台墙钟内跑不完）
      const effRes = await resolveSupportedEffort(deps.llm ?? null, fbRoute.provider, fbRoute.model, fbRoute.effort ?? undefined)
      // 批 5 FR-CB7：回落轮同样解析窗口（与 effort 同缝同点——同一 llm 句柄 / 同一路由对象）
      const winRes = await resolveAdvisorContextWindow(deps.llm ?? null, fbRoute.provider, fbRoute.model, config)
      const fbTimeout = Math.min(fbRoute.timeoutMs, budgetCap)
      const fbCapNote = fbRoute.timeoutMs > budgetCap
        ? "\n\n[thincoder-suite] warning: 回落轮预算 " + fbRoute.timeoutMs + "ms 已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台 run_code 墙钟内；镜像 codex 同步路径钳制）"
        : ""
      const fb = await runAdvisorToolLoop(deps, {
        provider: fbRoute.provider, model: fbRoute.model, effort: effRes.effort ?? undefined,
        system, firstUserText: userText, cwd, signal, timeoutMs: fbTimeout,
        sessionId: sid, maxTokens: advisorMaxTokens, contextTokens: winRes.window,
      })
      const fbCompleted = !String(fb).trimStart().startsWith("Advisor:")
      let fbFailNote = ""
      if (!fbCompleted) {
        // 回落轮失败 +1（codex 计数不清零——任一路由成功才清零）：回落轮连败可累积到硬停
        const fbFails = bumpFallbackFailure(sid, String(fb).split("\n")[0].slice(0, 200))
        if (fbFails >= FALLBACK_HARD_STOP_THRESHOLD) {
          // 连续 2 次回落失败 → 硬停：双路由诊断 + 修正指引（armed——后续调用入口 held）
          return armFallbackHardStop(sid, { config, override, agentOpts, advisorRound: state.advisorRound })
        }
        // R3 code review 收尾 ①（R4 折入，设计 §6.5）：回落失败计数后缀——与「回落路由不可达」
        // 路径对齐（连败进度可见：用户可预期再失败一次即硬停）。
        fbFailNote = "\n[thincoder-suite] 回落失败 " + fbFails + "/" + FALLBACK_HARD_STOP_THRESHOLD
          + "——再失败一次将硬停整个自愈循环（D-07/D-裁决-3）。"
      }
      // D-17/D-19 截断告警与机制性后缀在 finalize 之后追加：插件元数据不参与 completed 判定/
      // prior 存储（looksLikeReview 启发式不该被后缀推过 200 字符阈值；prior 只存评审正文）
      return finalize(fb)
        + (effRes.note ? "\n\n[thincoder-suite] " + effRes.note : "")
        + (winRes.note ? "\n\n[thincoder-suite] " + winRes.note : "")
        + fbFailNote
        + "\n\n[thincoder-suite] warning: codex runner 连续 " + failCount + " 次失败——本轮已自动回落 dsh 路由（"
        + fbRoute.provider + ":" + fbRoute.model + "）；回落成功后计数清零、下一轮重试 codex，回落连续失败 "
        + FALLBACK_HARD_STOP_THRESHOLD + " 次将硬停（D-07）。"
        + fbCapNote
    }

    if (codexWanted) {
      // D-02 L1：codex 行 effort 解析（resolveAdvisorRoute 输出 → buildCodexArgs 之前）。
      // route.effort = runner.effort ?? 组环 effort——解析结果写回传给 runCodexTask 的 runner
      //（组 effort 因此对 codex 行真正生效，消灭「组 effort 被 runner 静默丢弃」的旧漂移）；
      // off → null（不传）；note 尾部并入结果（附录 D.3 规则）。
      if (route.effort !== null && route.effort !== undefined) {
        const effRes = await resolveCodexRowEffort(
          deps,
          { ...route.runner, model: route.model },
          route.effort,
          resolveCodexCliGlobals(config).globals,
        )
        codexRunner = { ...route.runner, effort: effRes.effort ?? undefined }
        codexEffNote = effRes.note
      }
      // 预算 > budgetCap：同步跑会被平台 run_code 墙钟（默认 600s）砍掉 → 派后台 job
      //（ctx.jobs 已装配时零成本；finalize 在 done settle 前执行——轮次推进/prior/token
      // 恰好一次；完成通知由平台唤醒主代理，无需轮询）。jobs 缺失 → 同步降级（预算截为
      // budgetCap 并响亮告警，绝不无声）。
      if (route.timeoutMs > budgetCap) {
        // D-06（§4.3）：single-flight 派发前检查（复合键 sessionId+mechanism——advisor 槽位）
        const inFlight = checkInFlightJob(sid, "advisor")
        if (inFlight) return inFlight
        const jobs = getJobsService(deps)
        if (jobs && typeof jobs.start === "function") {
          // D-10（§4.4）：派发时捕获代际——finalize 应用前校验（不匹配 → 丢弃状态变更 + 注明）
          const genAtDispatch = advisorGenerationOf(state)
          const ctrl = new AbortController()
          try {
            const started = jobs.start({
              kind: "advisor-codex",
              label: "codex review (" + (route.model ?? "default") + ", " + Math.round(route.timeoutMs / 1000) + "s)",
              outputLimitBytes: 131072,
              owner: agent,
              run: () => {
                const done = runTask(route.timeoutMs, ctrl.signal).then((env) => {
                  clearInFlightJob(sid, "advisor")
                  // D-19（R3 §5.3）：机制性后缀（effort note）在 finalize 之后追加——
                  // lastAdvisorOutput 只存评审正文（prior 纯净化）；返回文本照常带后缀。
                  const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
                  let result
                  if (env.ok && env.text) {
                    // R3 §5.1（D-07）：任一路由成功清零（含回落计数/硬停——语义：运行确实发生）
                    resetRouteFailureState(sid)
                    result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
                  } else {
                    const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
                    codexFailureCount.set(sid, newCount)
                    codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
                    const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
                      ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
                      : ""
                    const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
                    // 失败结果 "Advisor:" 开头（附录 D.3 规则）
                    result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
                  }
                  // D-10（§4.4）：finalize 应用前代际校验——不匹配 → 丢弃状态变更（轮次推进/
                  // prior/token 一律不并入），评审原文仍可读 + 完成通知注明
                  if (advisorGenerationOf(state) !== genAtDispatch) {
                    // 批 4 §5.4「陈旧结算」形态：**job 完成**但 finalize 被跳过（代际失配弃置）——
                    // 绕过 finalize 的结算点**必须显式打点**（否则永不计数）。docKey=null 时无副作用。
                    // 🔵 #3：stale 的 §5.4 定义是「job **完成**但 finalize 被跳过」——**失败**的 job
                    // 不属该形态（否则兜底超时的 job 恰好同时换代也会被记成 stale）。失败形态按本
                    // 路径**既有归类**记账：codex TIMEOUT→timeout、用户中断 ABORTED→interrupted（0）、
                    // 其余→review_failed（同一 classifySettlement + codexSettlementHint 组合）。
                    if (env.ok && env.text) recordDesignSettlement(sid, docKeyEarly, "stale")
                    else {
                      const kind = classifySettlement(result, codexSettlementHint(env))
                      if (kind && kind !== "interrupted") recordDesignSettlement(sid, docKeyEarly, kind)
                    }
                    return {
                      status: env.ok ? "completed" : "failed",
                      detail: env.ok ? "review delivered (stale generation)" : ("codex-cli " + env.code),
                      output: result + effNote + "\n\n[thincoder-suite] 状态代际已变更（dispatch 时 " + genAtDispatch
                        + " → 当前 " + advisorGenerationOf(state) + "），本轮结果不并入会话状态（原文可读）。",
                    }
                  }
                  // finalize 在 done settle 前执行：轮次推进/prior/token 恰好一次
                  return { status: env.ok ? "completed" : "failed", detail: env.ok ? "review delivered" : ("codex-cli " + env.code), output: finalize(result, codexSettlementHint(env)) + effNote }
                }, (e) => {
                  clearInFlightJob(sid, "advisor")
                  // 批 4 §5.4：**异常捕获点**同样是结算落定点（绕过 finalize 的形态必须显式打点）。
                  const msg = String(e && e.message ? e.message : e)
                  recordDesignSettlement(sid, docKeyEarly, "review_failed")
                  // 批 6 FR-AP5：中止类拒绝带溯源（detail = 机器短标签 abortTag；output = 死亡行）。
                  // 非中止错误**零改动**（abortTag → null，deathLine 逐字返回原 message——D-AP5）。
                  // 批 6 修复轮（审计 #3 / D-AP3 + §5.1 图 1 W2）：本控制器另一写者是**宿主 job kill**
                  //（hooks.cancel 的 cancel 回调把平台形状的 reason 原样落到 ctrl 上，未打标）——该面归
                  // `cancel@settle`，不得回落成 `unknown@agent`；我方自持写点带标注时归因不变。
                  const line = "Advisor: review failed — " + msg
                  const hostSrc = hostAbortSource(ctrl.signal)
                  const tag = abortTag(hostSrc ?? e, ctrl.signal, "agent")
                  return {
                    status: "failed",
                    detail: tag ?? msg,
                    output: tag ? deathLine(line, hostSrc ?? e, "agent") : line,
                  }
                })
                done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
                return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
              },
            })
            setInFlightJob(sid, "advisor", started, {
              reviewType, // "design" | "code"
              docSet: reviewType === "design" ? castDocPaths : [], // 守卫 E 冻结集（D-E3/D-E4）
            })
            // D-05：jobs.start 返回 branded string——直接渲染（旧代码取 .id 落空恒显 "?"）。
            // D-09（UI-2）：句柄 + 接续指令——完成通知只含一行指针，全文经 job_output 读取
            //（保尾），不承诺「通知含评审全文」。D-16：budgetCapMs ≥ 600000 时附不变式提醒。
            // R4 收尾 #4（code review 跟进）：N4 配置警告（warnPrefix）并入派发返回文本——
            // 与同步路径（finalize 尾 warnPrefix + final）可见性一致；此前 jobs 路径只在
            // console.warn 留档，工具返回文本里不可见。warnPrefix 为空串时行为不变。
            return warnPrefix + codexJobsDispatchReply({
              prefix: "Advisor: codex review",
              jobId: started,
              budgetMs: route.timeoutMs,
              budgetCapMs: budgetCap,
              detail: "模型 " + (route.model ?? "codex 默认"),
            })
          } catch (e) {
            console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e && e.message ? e.message : String(e)) + "）——回落同步执行（预算按 budgetCap 截断）")
          }
        }
        // jobs 设施缺失 → 同步降级（预算截为 budgetCap，响亮告警——绝不无声延长）
        console.warn("[thincoder-suite] ctx.jobs 不可用——codex 评审预算 " + route.timeoutMs + "ms 截为 " + budgetCap + "ms 同步执行（建议装配 dsh-jobs-local + dsh-tool-jobs）")
        const env = await runTask(Math.min(route.timeoutMs, budgetCap), signal)
        const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
        let result
        if (env.ok && env.text) {
          // R3 §5.1（D-07）：任一路由成功清零
          resetRouteFailureState(sid)
          result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
        } else {
          const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
          codexFailureCount.set(sid, newCount)
          codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
          const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
            ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
            : ""
          const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
          // 失败结果必须以 "Advisor:" 开头（不烧轮次、不存 prior；附录 D.3 规则）
          result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
        }
        // D-19（R3 §5.3）：机制性后缀（截断告警 / effort note）在 finalize 之后追加——
        // lastAdvisorOutput 只存评审正文（prior 纯净化）；返回文本照常带后缀（可见性不变）。
        return finalize(result, codexSettlementHint(env))
          + (env.ok ? "\n\n[thincoder-suite] warning: 预算已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台墙钟内）" : "")
          + effNote
      }
      // 预算 ≤ budgetCap → 同步执行（现行为）
      const env = await runTask(route.timeoutMs, signal)
      const effNote = codexEffNote ? "\n\n[thincoder-suite] " + codexEffNote : ""
      let result
      if (env.ok && env.text) {
        // R3 §5.1（D-07）：任一路由成功清零
        resetRouteFailureState(sid)
        result = env.text // 纯正文（机制后缀在 finalize 后追加——D-19）
      } else {
        const newCount = Math.min((codexFailureCount.get(sid) ?? 0) + 1, 99)
        codexFailureCount.set(sid, newCount)
        codexLastFailure.set(sid, env.code) // D-07：最近失败码（硬停诊断用）
        const fallbackNote = newCount >= CODEX_FAILURE_FALLBACK_THRESHOLD
          ? "\n[thincoder-suite] codex runner 已连续 " + newCount + " 次失败——下一轮 advisor start 将自动回落 dsh 路由一轮"
          : ""
        const partial = env.text ? "\n--- partial output (not counted as a review) ---\n" + env.text.slice(0, 2000) : ""
        result = "Advisor: review failed (codex-cli " + env.code + ") — " + (env.userMessage || env.diagnostics || "unknown error") + partial + fallbackNote
      }
      // D-19（R3 §5.3）：机制性后缀（effort note）在 finalize 之后追加——prior 只存评审正文
      return finalize(result, codexSettlementHint(env)) + effNote
    }

    // dsh 主路径（R5 §7.1，D-27）：route.timeoutMs > budgetCapMs 且 ctx.jobs 可用 → 自动派
    // 后台 job（与 codex 分支完全对称）——run() 内跑完整 runAdvisorToolLoop（纯进程内
    // llm.stream 调用，无子进程），route.timeoutMs 在 job 内**全额生效**（job 内预算不钳制——
    // run() 无墙钟，D-17 钳制只适用于同步路径）；finalize 在 done 内恰好一次（单飞槽位
    // advisor / 代际捕获校验 / prior·token 语义全套复用 R2 codex 模式）。≤cap / jobs 缺失 /
    // 派发抛错 → 同步执行（D-17 钳制与告警保留——它保护的就是墙钟内的同步路径）。本路径同受
    // dshBackgroundTimeoutMs 兜底（§7.2：挂起的 llm.stream 到点 abort + 超时信封，job 不永悬）。
    // 评审反馈：dsh 主路径的 effort 同样按模型实际档位校验/回落
    const effRes = await resolveSupportedEffort(deps.llm ?? null, route.provider, route.model, route.effort ?? undefined)
    // 批 5 FR-CB7：窗口解析（与 effort 同缝同点；每次评审解析一次——D-CB5）
    const winRes = await resolveAdvisorContextWindow(deps.llm ?? null, route.provider, route.model, config)
    // FR-CB6：兜底 note 并入既有机制后缀变量 dshEffNote（post-finalize 追加；不新增第三个后缀变量）
    const dshEffNote = (effRes.note ? "\n\n[thincoder-suite] " + effRes.note : "")
      + (winRes.note ? "\n\n[thincoder-suite] " + winRes.note : "")
    const loopOpts = {
      provider: route.provider, model: route.model, effort: effRes.effort ?? undefined,
      system, firstUserText: userText, cwd, sessionId: sid, maxTokens: advisorMaxTokens,
      contextTokens: winRes.window,
    }
    if (route.timeoutMs > budgetCap) {
      // D-06（§4.3）：single-flight 派发前二次检查（入口检查之后到 jobs.start 之间的
      // await 窗口——effort 解析等——内仍可能被他方派发占位；advisor 槽位）
      const inFlight = checkInFlightJob(sid, "advisor")
      if (inFlight) return inFlight
      const jobs = getJobsService(deps)
      if (jobs && typeof jobs.start === "function") {
        // D-10（§4.4）：派发时捕获代际——finalize 应用前校验（不匹配 → 丢弃状态变更 + 注明）
        const genAtDispatch = advisorGenerationOf(state)
        const ctrl = new AbortController()
        try {
          const started = jobs.start({
            kind: "advisor-dsh",
            label: "dsh review (" + route.provider + ":" + route.model + ", " + Math.round(route.timeoutMs / 1000) + "s)",
            outputLimitBytes: 131072,
            owner: agent,
            run: () => {
              // R5 §7.2 挂死兜底：dshBackgroundTimeoutMs 到点 abort（挂起的 llm.stream 不永悬
              // job）——超时信封（partial 保留）附在 outcome；取消经 hooks.cancel → ctrl.abort
              const backstopMs = resolveDshBackgroundTimeoutMs(config)
              let backstopTimer = null
              let backstopFired = false
              if (Number.isFinite(backstopMs) && backstopMs > 0) {
                backstopTimer = setTimeout(() => {
                  backstopFired = true
                  console.warn("[thincoder-suite] dsh 后台评审超兜底截止（dshBackgroundTimeoutMs=" + backstopMs
                    + "）——abort 挂起的 llm 流（job 永悬防护，R5 §7.2）")
                  try { ctrl.abort(timeoutError("dsh background backstop deadline reached", "agent", "dshBackgroundTimeoutMs")) } catch { /* already aborted */ }
                }, backstopMs)
                backstopTimer.unref?.()
              }
              const done = (async () => {
                try {
                  // job 内预算不钳制：route.timeoutMs 全额生效（run() 无墙钟；D-17 只护同步）
                  const loop = await runAdvisorToolLoop(deps, { ...loopOpts, signal: ctrl.signal, timeoutMs: route.timeoutMs })
                  const completed = !String(loop).trimStart().startsWith("Advisor:")
                  // D-10（§4.4）：finalize 应用前代际校验——不匹配 → 丢弃状态变更（轮次推进/
                  // prior/token 一律不并入），评审原文仍可读 + 完成通知注明（R2 codex 同款：
                  // 代际不匹配即**不调 finalize**——finalize 会推进轮次/写 prior/可能签发 token，
                  // 调用即违背「不并入」语义；原文经 raw loop 文本保留）
                  if (advisorGenerationOf(state) !== genAtDispatch) {
                    // 批 4 §5.4「陈旧结算」形态：**job 完成**但 finalize 被跳过（代际失配弃置）。
                    // 🔵 #3：失败形态**不属** stale（§5.4 的定义就是「job 完成」）——按 finalize
                    // 路径的同一归类记账：兜底截止（backstopFired 机械事实）→ timeout、用户中断
                    // → interrupted（0）、其余按前缀表 → review_failed。
                    if (completed) recordDesignSettlement(sid, docKeyEarly, "stale")
                    else {
                      const kind = classifySettlement(loop, backstopFired ? "timeout" : undefined)
                      if (kind && kind !== "interrupted") recordDesignSettlement(sid, docKeyEarly, kind)
                    }
                    return {
                      status: completed ? "completed" : "failed",
                      detail: completed ? "review delivered (stale generation)" : "dsh review failed (stale generation)",
                      // raw loop 文本直出（不调 finalize——轮次/prior/token 零并入，D-10）
                      output: loop + dshEffNote + "\n\n[thincoder-suite] 状态代际已变更（dispatch 时 " + genAtDispatch
                        + " → 当前 " + advisorGenerationOf(state) + "），本轮结果不并入会话状态（原文可读）。",
                    }
                  }
                  const backstopNote = backstopFired
                    ? "\n\n[thincoder-suite] 超 dshBackgroundTimeoutMs=" + backstopMs
                      + "ms 兜底截止——挂起的评审流已中止（job 不永悬；partial 如上文原文）"
                    : ""
                  // 批 4 §5.4（P3 漏洞 ① / D-G5）：**内部兜底截止按 `timeout` 计**，用 `backstopFired`
                  // 这个**机械事实**直传 hint——**不做串面猜**（否则「挂起→兜底杀→重试→再挂」永久
                  // 豁免：兜底 abort 以 "Advisor: interrupted." 面世，会被 interrupted 豁免漏掉）。
                  return {
                    status: completed ? "completed" : "failed",
                    detail: completed ? "review delivered" : "dsh review failed",
                    output: finalize(loop, backstopFired ? "timeout" : undefined) + dshEffNote + backstopNote,
                  }
                } catch (e) {
                  // 兜底 deadline / cancel 的 reject 兜底（runAdvisorToolLoop 内部已把常规失败转
                  // 字符串——此处只接异常形态：不可达/解析失败等）
                  const msg = String(e && e.message ? e.message : e)
                  // 批 4 §5.4：**异常捕获点**显式打点（绕过 finalize）。兜底已触发 → 机械事实是
                  // timeout；否则 review_failed。
                  recordDesignSettlement(sid, docKeyEarly, backstopFired ? "timeout" : "review_failed")
                  // 批 6 FR-AP5：中止类带溯源（非中止错误零改动——D-AP5）
                  // 批 6 修复轮（审计 #3）：宿主 job kill 的 cancel 回调面归 `cancel@settle`（同 codex job 分支）
                  const line = "Advisor: review failed — " + msg
                  const hostSrc = hostAbortSource(ctrl.signal)
                  const tag = abortTag(hostSrc ?? e, ctrl.signal, "agent")
                  return {
                    status: "failed",
                    detail: tag ?? msg,
                    output: (tag ? deathLine(line, hostSrc ?? e, "agent") : line) + dshEffNote,
                  }
                } finally {
                  if (backstopTimer) clearTimeout(backstopTimer)
                  clearInFlightJob(sid, "advisor") // settle（成功/失败/中止）双分支清除槽位
                }
              })()
              done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
              return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
            },
          })
          // D-06：登记槽位（settle 时经 done 清除）；D-05：branded string 直接渲染；
          // UI-2（D-09）：句柄 + 接续指令——完成通知只含一行指针，全文经 job_output 读取
          // 批 6b（守卫 E，§6.1 派发点）：第四参载荷 = 本轮在审文档集（design 才武装窗口；D-E3）
          setInFlightJob(sid, "advisor", started, {
            reviewType,
            docSet: reviewType === "design" ? castDocPaths : [],
          })
          return warnPrefix + jobsDispatchReply({
            prefix: "Advisor: dsh review",
            jobId: started,
            budgetMs: route.timeoutMs,
            detail: "dsh 路由 " + route.provider + ":" + route.model + " · job 内预算不钳制（挂死兜底 dshBackgroundTimeoutMs）",
          })
        } catch (e) {
          // R5 §7.1 派发降级：jobs.start 抛错 / 派发失败 → 同步 + 钳制 + 响亮告警（不静默吞）
          console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e && e.message ? e.message : String(e))
            + "）——dsh 评审回落同步执行（预算按 budgetCap 截断，D-17）")
        }
      } else {
        // jobs 设施缺失 → 同步降级（D-17 钳制，响亮告警——绝不无声延长）
        console.warn("[thincoder-suite] ctx.jobs 不可用——dsh 评审预算 " + route.timeoutMs + "ms 截为 "
          + budgetCap + "ms 同步执行（建议装配 dsh-jobs-local + dsh-tool-jobs 走后台全预算派发）")
      }
    }
    // —— ≤ budgetCap 或 jobs 缺失/派发失败：同步执行（> cap 时钳制 + 尾部告警，绝不无声）——
    // D-17：dsh 主路径预算钳制（与 codex 路径对称——超 budgetCap 部分在平台墙钟内跑不完）
    const dshTimeout = Math.min(route.timeoutMs, budgetCap)
    const dshCapNote = route.timeoutMs > budgetCap
      ? "\n\n[thincoder-suite] warning: 评审预算 " + route.timeoutMs + "ms 已按 codexCli.budgetCapMs=" + budgetCap + "ms 截断执行（平台 run_code 墙钟内；镜像 codex 同步路径钳制）"
      : ""
    const loop = await runAdvisorToolLoop(deps, { ...loopOpts, signal, timeoutMs: dshTimeout })
    // D-17 截断告警在 finalize 之后追加：插件元数据不参与 completed 判定/prior 存储。
    // D-19（R3 §5.3）：effort note 同为机制性后缀——一并移到 finalize 之后（prior 只存
    // 评审正文；looksLikeReview 启发式不再被后缀推过 200 字符阈值——设计 §5.3 收口）。
    return finalize(loop)
      + dshEffNote
      + dshCapNote
  } catch (e) {
    // 批 4 §5.4：最外层**异常捕获点**也是结算落定点（绕过 finalize）。
    // `interrupted`（用户主动中断，US-4）**不计振**；其余按 review_failed 计（这些是「跑得通但
    // 产不出可用结算」的循环本体——P2 无上界的那一类）。
    if (e?.name === "AbortError" || signal?.aborted) {
      // 批 6 FR-AP5：原 message 逐字 + 溯源后缀（归因源优先级同循环 catch）
      const src = e?.abortInfo ? e : (signal?.aborted ? signal : e)
      const layer = e?.abortInfo?.layer ?? (signal?.aborted ? "settle" : "provider")
      return warnPrefix + deathLine(annotateAbort(new Error("Advisor: interrupted."), src, layer, "outer catch abort"), src)
    }
    recordDesignSettlement(sid, docKeyEarly, "review_failed")
    return warnPrefix + "Advisor: review failed — " + (e?.message ?? String(e))
  }
}

