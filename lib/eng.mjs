// eng.mjs — 工程模式：enter/exit 翻转 + 写门禁 + eng_coder + designToken 生命周期。
// 移植自 thincoder eng 体系。DSH 映射：
// - 提示词切换：agent 作用域 systemPrompt.section（enter 注册 / exit 释放）
// - 写门禁：tools/pre-execute waterfall（无 token 写产品代码 → deny）
// - designToken：advisor(design) 裁决通过 ∧ 批准码回显命中时签发（协议 v2）
//   → eng_coder spawn 时机械校验 → 不消费（多次 spawn OK）
// - token 拒绝消息三态（R3）：never issued / expired / mismatch——排障信号各不相同
//   D-30 扩展：expired 一态细分为「可续期（自动顺延）」「文档已变更」「无法续期」「旧版本令牌」
//   四路（FR-T5/FR-T6/FR-T9），排障文案必须说清是哪一种。
// - eng_coder 返回 → 重置 advisor 轮次预算（交付 code review 必然发生）
// F12（docs/2026-09-02-session-state-stages-design.md §2.3）：eng enter/exit 翻转与 eng_coder
// 交付后写盘（session-state.json——engineering/advisorRound 等跨重启恢复）。
// F13（§3.1/§3.2/§3.3）：eng_coder 可选 stages 结构化参数——阶段化任务书（统一编号四段渲染
// + 阶段纪律 + stage 状态表前置指令 + 预算将尽条款 + 漂移探测 + 渲染前防御校验）；stages 缺省时
// buildCoderBrief 输出逐字节等于现行（T9 fixture 锁死）。
// R3 §5.4 补丁轮（D-06 同步路径单飞扩展）：机制入口（授权门禁之后、任何 spawn/
// runCodexTask 之前）checkInFlightJob——同会话 eng_coder 在飞（>cap job 或任何已占位
// 形态）期间任何新调用（codex ≤cap 同步/dsh 子代理路径）被拒；jobs 派发点二次检查保留。
// R5 §7.2（D-27）+ 批 21（FR-1①/D21-1）：dsh 子代理路径的 background 三态——省略/true ⇒
// 派后台 job〔kind eng-dsh，免平台墙钟：run() 闭包内 ctx.subagents.start + await run.result、
// dshBackgroundTimeoutMs 兜底 deadline abort + 超时信封 partial 保留、cancel → 子代理 abort〕；
// 批 21 起省略即后台（默认翻转：与 codex 后端按预算默认后台的既有现实拉齐——同步路径只剩
// 显式 false 与 jobs 缺失/派发失败回落两种到达方式）。显式 false ⇒ 强制同步快路径（DP-1
// 方案 A budgetCap 内部截止 + 响亮告警，R2 §4.2）。jobs 缺失/派发失败 ⇒ 告警 + 回落同步
// （批 21 FR-3：告警双通道——console.warn + 随工具返回文本可见，文案逐字节保持现状）。
// codex 后端（engCoderRunner=codex-cli）同接受 background（显式 true = 强制后台派发；
// 该判定批 21 零改动——codex 行为零漂移）。
import { ENGINEERING, ENG_CODER_PERSONA } from "./prompts.mjs"
import { sessionState, engEffective } from "./state.mjs"
import { validateDesignToken, designTokenFailureReason, designTokenShape, renewDesignToken, expiryLabel, EFFORT_LEVELS, tokenExpiryMs, resolveCodexBudgetCapMs, getJobsService, jobsDispatchReply, codexJobsDispatchReply, checkInFlightJob, setInFlightJob, clearInFlightJob, bumpAdvisorGeneration, sessionStateViewWithGeneration, resolveDshBackgroundTimeoutMs, PLATFORM_RUN_CODE_WALL_MS } from "./advisor.mjs"
import { parseTouchedFiles, codexFailureAdvisory } from "./escalate.mjs"
import { loadTokenRecord, saveTokenRecord } from "./token-store.mjs"
import { computeDocHash, normalizeDocPath } from "./doc-hash.mjs"
// 批 7（D-P9/D-P10）：写门禁的产品代码判据 = path-kind.mjs 的单一权威（本文件只做薄转发）
import { isProductCodePath } from "./path-kind.mjs"
// D-42：jobs.start 的 owner 判据单一事实源（0.1.7 起平台按 id 查活代理，传对象必查空）
import { ownerIdOf } from "./job-owner.mjs"
// D-46（0.1.7 输出环契约）：outcome 的单点收口（append + result/output 别名）——见 lib/job-outcome.mjs
import { jobOutcome } from "./job-outcome.mjs"
// 批 6（FR-AP5/FR-AP6）：死亡溯源唯一词汇表（trigger/layer 字面只在该模块定义——N-3）
import { abortError, timeoutError, annotateAbort, deathLine, abortTag, hostAbortSource } from "./abort-provenance.mjs"
import { saveSessionState } from "./session-store.mjs"
import { runCodexTask, resolveCodexCliGlobals, CODEX_TASK_PREAMBLE } from "./codex-adapter.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "./effort-resolve.mjs"
// 批 26 / D48-2 ⊕ D48-5（分歧审计 ②-D2 裁定）：宿主验收回执的**执行面**抽成 leaf 模块
// lib/host-check.mjs——其 setTimeout 与子进程调用点随迁：T-AP7 对四机制文件的定时器字面锁
// 因此零改动可满足（eng.mjs 不再持有新定时器字面）；stage-gate T-SG4 的 lib/** 执行面计数
// 基线 2 不变，第二处落在该 leaf 模块（决策 D26-5 有意改锁的同一处执行面，只是落点换成 leaf）。
// 宿主进程可直接执行而 dsh 子代理沙箱实测「起跑即挂死」。deps.hostCheckOpts = A26-8 测试
// 注入缝（{ timeoutMs, spawnImpl }——生产路径不传，行为与注入前逐字一致）。
import { runHostStageChecks } from "./host-check.mjs"
// 批 29 / US-1（D29-2 · D29-6）：静默看门狗住**新叶子模块** lib/silence-watchdog.mjs——轮询定时器
// 与到点判定一律不进本文件（批 26 已证：本文件再加定时器/写点 ⇒ 撞 T-AP7 结构上不可满足）。
// 本文件**只 import 使用**：仍只有 backstopMs / budgetCap 两个 setTimeout（一字未动）、
// 中止写点数仍为 5（到点中止由**既有**取消写点执行，不新造中止闭包、不新增写点）。
import { resolveEngSilenceAbortMs, createSilenceWatchdog, attachRunHeartbeat, watchJobHandle, silenceMinutesLabel } from "./silence-watchdog.mjs"

const ENG_SECTION_NAME = "thincoder:engineering"
const ENG_SECTION_ORDER = 3500 // 外部插件有限值区间（3000–4000）

// —— F9 子代理资源（§3.10）：engCoderMaxTokens 缺省 65536；effort 枚举与 advisor 单一事实源（评审 #6）——
const ENG_CODER_MAX_TOKENS_DEFAULT = 65536
/** `engCoderEffort` 的**默认值与回落目标的唯一事实源**（批 14 / D14-1 · P1+P2）。
 *  `medium` 的枚举依据（会诊 v4-pro 提供，父侧复核形式）：**as-of 批 14（2026-09-16）**，
 *  `low` 曾是唯一在一切非退化支持集上都可能被 `nearestEffort` 静默落到 `off` 的程度档——
 *  本部署实测形状 `{off,high,max}` 恰是它的中招形状。**批 19（2026-09-17）根修后该中招形状
 *  不复存在**：`off` 退出距离竞争，回落只在力度域内进行（退化兜底与显式 `off` 关不掉 ⇒ 省略
 *  的语义见 `effort-resolve.mjs` 头注释）⇒ 本常量的「回落安全」理由自此成为历史记述；
 *  `medium` 缺省维持不变（现行理由：推理档再高只是白白吞噬输出预算）。改这一个常量即同时改
 *  **默认值**与**回落目标**（P2 的隐式耦合由此消除）。 */
const ENG_CODER_EFFORT_DEFAULT = "medium"
const ENG_CODER_EFFORT_LEVELS = new Set(EFFORT_LEVELS)
// 平台单次调用的墙钟（批 14 / FR-4 · D14-6；批 26 搭车①升为 advisor.mjs 的**共享常量**——
// eng/escalate 同步快路径与 advisor 的 D-16 提醒同一事实源）：**平台事实的常数，不是用户可配项**
// ⇒ 不进任何配置键、不改 schema。插件读不到平台的 `maxWallMs`，故此常数只用于
// 「已达/超过该墙钟」的**前置告警**（告警 fail-open：不改任何返回路径）。

/** 写工具集合（pwsh/run_code 不拦——间接写靠流程纪律，thincoder 同款）。
 * 批 6b（守卫 E / D-E2 / N-3）：升为 export 供预闸复用——**单一实现**，禁第二份字面量副本。 */
export const WRITE_TOOLS = new Set(["write", "edit"])

/**
 * 产品代码判定 —— **对 `path-kind.isProductCodePath` 的薄转发**（批 7 D-P9/D-P10）。
 * 判据本体（「这个路径是文档还是代码」）只有一处实现（`lib/path-kind.mjs`）；本函数只保留
 * 名字与 export，因为 `guard-e.test.mjs` 的 `WRITE_GATE_FIXTURE` 锁着 `makeWriteGate` 函数体的
 * **可执行行**（批 12 起注释层不入锁）——跨模块搬家不得改动该夹具的可执行行。
 * 批 7 同时删掉了原先的「根 src/ 快路径」分支（D-P11：对代码扩展名是冗余死代码，
 * 对文档扩展名是唯一矛盾源）。
 */
export function isProductCode(p) {
  return isProductCodePath(p)
}

/** 从工具参数提取目标路径（write/edit 的 file_path）。
 * 批 6b（守卫 E / D-E2 / N-3）：升为 export 供预闸复用——**单一实现**，禁第二份副本。 */
export function targetPathOf(name, args) {
  const a = args ?? {}
  return typeof a.file_path === "string" ? a.file_path
    : typeof a.path === "string" ? a.path
    : null
}

/**
 * 注册 agent 作用域 engineering section（enter 时）。返回 disposer。
 * agent.ctx 是 agent-scoped Context——section 只影响该 agent 的系统提示词装配。
 */
export function attachEngineeringSection(agent) {
  if (!agent?.ctx?.systemPrompt?.section) return null
  return agent.ctx.systemPrompt.section({
    name: ENG_SECTION_NAME,
    order: ENG_SECTION_ORDER,
    text: ENGINEERING,
  })
}

/**
 * eng enter/exit 翻转。返回结果文本。
 * F12（§2.3 写点表）：翻转后写盘（engineering tri-state 落盘——恢复显式值延续用户当时意图；
 * 停机期间改了 config 默认 → 恢复显式值胜出，tri-state 优先级已内建）。
 * @param opts { storPathOverride?: string } — F12 存储路径注入缝（测试用临时目录，
 *        缺省走 session-store 的 DSH_HOME 解析；cwdHint 取 agent.session.header.cwd）
 */
export function engineeringToggle(agent, action, opts) {
  const state = sessionState(agent.session.id)
  if (action === "enter") {
    state.engineering = true
    if (!state.engSection) {
      try { state.engSection = attachEngineeringSection(agent) } catch { state.engSection = null }
    }
    persistSessionState(agent, state, opts) // F12（§2.3）：翻转后写盘
    return "Engineering mode ON — you are now the architect: clarify requirements, write design docs in docs/, and WAIT for the user to initiate the design review (advisor type='design'). Implementation goes through eng_coder with a design token. Use eng(action='exit') to leave."
  }
  if (action === "exit") {
    state.engineering = false
    try { state.engSection?.() } catch { /* already disposed */ }
    state.engSection = null
    persistSessionState(agent, state, opts) // F12（§2.3）：翻转后写盘
    return "Engineering mode OFF — standard workflow restored."
  }
  return "Error: action must be 'enter' or 'exit'."
}

/**
 * F12（§2.3）写点 helper：语义转换点落盘。viewOfSessionState 组装白名单视图 →
 * saveSessionState（原子写 + 净化 + 孤儿清扫，内部 fail-safe：任何失败仅 warn 不抛——
 * 翻转/交付流程不依赖持久化成功，内存态兜底）。storPathOverride 优先取 opts（deps）注入缝。
 */
function persistSessionState(agent, state, opts) {
  try {
    saveSessionState(
      agent.session.id,
      sessionStateViewWithGeneration(state), // R2 §4.4（D-10）：generation 随 F12 视图持久化
      opts?.storPathOverride,
      agent.session?.header?.cwd,
    )
  } catch { /* N3 fail-safe：写盘故障不击穿工具流程（save 内部已 warn） */ }
}

/**
 * D-20 交付簿记（codex/dsh × 同步/后台 四路共用单一实现——D-26-⑥ 单一事实源纪律）：
 * 仅成功分支调用恰好一次。子交付 → 重置 advisor 预算（交付 code review 必然发生）：
 * advisorRound=0 + lastAdvisorOutput=null；R2 §4.4（D-10）：eng 交付重置 = 语义转换点，
 * advisorGeneration +1（晚到的在飞 advisor 结果经 finalize 代际校验丢弃，不复活已重置的
 * 轮次/prior）；touched 合并 + mutatedThisRun 置位；F12（§2.3 写点表）：交付后写盘（同一
 * 视图落盘；touchedFiles 去重封顶 200 由 session-store 净化链兜底）。失败仅 warn（N3：
 * 丢=回内存行为，重启后恢复上一写点状态）。
 */
function deliverBookkeeping(state, agent, deps, outputText) {
  state.advisorRound = 0
  state.lastAdvisorOutput = null
  bumpAdvisorGeneration(state)
  const touched = parseTouchedFiles(outputText)
  if (touched.length > 0) {
    const merged = new Set([...(state.touchedFiles ?? []), ...touched])
    state.touchedFiles = [...merged]
  }
  state.mutatedThisRun = true
  persistSessionState(agent, state, deps)
}

// ————————————— 批 9：阶段门（D9-9 / D9-10 / US-8 / US-9） —————————————

/** 阶段表扫描窗（§9 边界 3：契约要求表在报告**最前**，超窗即违约 ⇒ UNDECLARED）。 */
const STAGE_TABLE_SCAN_CHARS = 4000

/** 横幅通道（N4 `warnPrefix` 先例：console.warn + 随工具返回文本带出）。 */
function stageGateBanner(msg) {
  console.warn("[thincoder-suite] " + msg)
  return "[thincoder-suite] " + msg + "\n\n"
}

/**
 * D-54：列名归一——去 `**粗体**` 与反引号包裹 + 两侧空白 + 统一小写（大小写不敏感口径）。
 */
function normalizeStageHeader(cell) {
  return String(cell ?? "").replace(/[*`]/g, "").trim().toLowerCase()
}

/**
 * D-54：三列的**别名表**——列位**不再固定**，中文表头与「多一列」形都按名定位。
 * 匹配用**包含**语义 ⇒ 契约表头 `Status (passed/failed/skipped)` / `check summary`
 * 照旧命中；纯符号别名（`#`）例外，必须整格相等，否则会吞掉正文里含 `#` 的非阶段列。
 */
const STAGE_COL_NAMES = {
  stage: ["stage", "阶段", "#", "步骤"],
  status: ["status", "状态", "结果"],
  summary: ["summary", "摘要", "证据", "说明"],
}
const STAGE_EXACT_ALIAS = new Set(["#"])

/** D-54：按名定位一列（找不到 ⇒ -1）。 */
function locateStageColumn(headerCells, names) {
  for (const name of names) {
    const exact = STAGE_EXACT_ALIAS.has(name)
    const i = headerCells.findIndex((c) => (exact ? c === name : c.includes(name)))
    if (i >= 0) return i
  }
  return -1
}

/** D-54：三列全定位到才给出列位；否则给出**缺失列清单**（含候选别名，供横幅诊断）。 */
function locateStageColumns(headerCells) {
  const cols = {}
  const missing = []
  for (const key of Object.keys(STAGE_COL_NAMES)) {
    const i = locateStageColumn(headerCells, STAGE_COL_NAMES[key])
    if (i < 0) missing.push(key + "（" + STAGE_COL_NAMES[key].join("/") + "）")
    else cols[key] = i
  }
  return missing.length > 0 ? { missing } : { cols }
}

/**
 * D-54：状态词表（中英 · 大小写不敏感 · 容忍粗体/代码记号）。
 * 英文按**词边界**取（`passed（已提交 5f2a56b7）` 这类后缀注释照旧命中）；中文按**首词**取
 * （`✅ 通过` 命中，而 `未通过` 这类否定形**不**判通过——§9 边界 2：宁可响亮，不猜）。
 * 返回英文规范词（passed/failed/skipped/done），供下游按既有三态判定。
 */
const STAGE_STATUS_CJK = [["failed", "失败"], ["skipped", "跳过"], ["passed", "通过"], ["done", "完成"]]
function parseStageStatus(raw) {
  const cell = normalizeStageHeader(raw)
  const ascii = /\b(failed|skipped|passed|done)\b/.exec(cell)
  if (ascii) return ascii[1]
  const cjk = cell.replace(/^[^\p{L}\p{N}]+/u, "")
  for (const [canonical, word] of STAGE_STATUS_CJK) if (cjk.startsWith(word)) return canonical
  return null
}

/** D-54：诊断摘要——把一行/一表的格子压成**有界**单行文本（横幅不因报告行很长而爆炸）。 */
function briefStageCells(parts) {
  const s = parts.map((c) => String(c ?? "")).join(" | ")
  return s.length > 120 ? s.slice(0, 120) + "…" : s
}

/**
 * 解析交付报告**头部**的阶段状态表。**纯解析**：不 spawn、不读盘、不改 state。
 *
 * D-54（本专项）：旧实现把「表在报告最前」写成「表头**恰 3 列** + 列名逐字 stage / status / summary」
 * 与「数据行**恰 3 格**」——真实报告常用**中文表头**（`| 阶段 | 状态 | 检查摘要 |`）或**多一列**
 * （`| Stage | Status | check summary | Files |`）⇒ 谓词恒 null ⇒ 恒假阳性（一个恒假阳性的门
 * 等于没有门）。现在：表头接受 **≥3 列**并按名**定位**三列（别名表见 STAGE_COL_NAMES）；数据行接受
 * **≥3 格**，按定位到的列取 stage / status / summary；stage 格仍需**有数字**（沿用 \d+ 口径），status 格走
 * parseStageStatus（中英词表）。**检测力不退化**：扫描窗 STAGE_TABLE_SCAN_CHARS 与「≥1 数据行」两条不变，
 * 无表照旧判 UNDECLARED（§9 边界 2 的取向：宁可响亮，不猜）。
 *
 * @returns {object} rows 非空 = 可解析；issue.kind === "missing" = **找不到带头行**（沿用旧文案）；
 *   issue.kind === "unparsable" = **带头行在场但列位 / 状态词不可解析**（D-54 诊断分岔，detail
 *   记下它**实际看到**的那一行，供横幅点名）。
 */
function parseStageTable(head) {
  const lines = head.split(/\r?\n/)
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim())
  const isRow = (l) => /^\s*\|/.test(l)
  const isAlign = (l) => cells(l).every((c) => /^:?-+:?$/.test(c))
  const unparsable = (detail) => ({ rows: null, issue: { kind: "unparsable", detail } })

  // ① 先找「三列**全定位**」的表（列位按名定位，不要求位置固定；也不要求对齐行在场——与旧实现同宽容度）
  let noData = null
  for (let k = 0; k < lines.length; k++) {
    if (!isRow(lines[k]) || isAlign(lines[k])) continue
    const located = locateStageColumns(cells(lines[k]).map(normalizeStageHeader))
    if (located.missing) continue
    const cols = located.cols
    const rows = []
    for (let j = k + 1; j < lines.length; j++) {
      if (!isRow(lines[j])) break
      if (isAlign(lines[j])) continue
      const c = cells(lines[j])
      const seen = briefStageCells(c)
      if (c.length < 3 || Math.max(cols.stage, cols.status, cols.summary) >= c.length) {
        return unparsable("第 " + (j + 1) + " 行格数不足（实际「" + seen + "」）")
      }
      const n = Number((String(c[cols.stage]).match(/\d+/) ?? [])[0])
      if (!Number.isFinite(n)) return unparsable("第 " + (j + 1) + " 行的阶段格无数字（实际「" + seen + "」）")
      const status = parseStageStatus(c[cols.status])
      if (status === null) {
        return unparsable("第 " + (j + 1) + " 行的状态格不可识别（实际「" + seen
          + "」；词表 passed/failed/skipped/通过/失败/跳过/完成/done）")
      }
      rows.push({ n, status, summary: String(c[cols.summary]) })
    }
    if (rows.length === 0) {
      if (noData === null) noData = unparsable("表头「" + briefStageCells(cells(lines[k])) + "」之后零数据行")
      continue
    }
    return { rows, issue: null }
  }
  if (noData !== null) return noData

  // ② 三列定位不到 ⇒ 再判「带头行到底在不在场」：含任一列别名，或「行 + 对齐行」的表头形态。
  //    D-54 ④ 的判据分岔：找到 ⇒ 报「表在场但列位/状态词不可解析」并带上**实际看到的表头**。
  for (let k = 0; k < lines.length; k++) {
    if (!isRow(lines[k]) || isAlign(lines[k])) continue
    const headerCells = cells(lines[k]).map(normalizeStageHeader)
    const hasAlias = Object.keys(STAGE_COL_NAMES).some((key) => locateStageColumn(headerCells, STAGE_COL_NAMES[key]) >= 0)
    const next = lines[k + 1]
    const shaped = next !== undefined && isRow(next) && isAlign(next)
    if (!hasAlias && !shaped) continue
    const located = locateStageColumns(headerCells)
    return unparsable("表头实际为「" + briefStageCells(cells(lines[k])) + "」；缺列 "
      + (located.missing ?? []).join("、"))
  }

  // ③ 找不到带头行 ⇒ **沿用旧文案**（表缺失 / 超窗）；检测力不退化
  return { rows: null, issue: { kind: "missing" } }
}

/**
 * 阶段门（批 9 / D9-9、D9-10）：解析交付报告**头部**的阶段状态表，不合格时产出一条**响亮横幅**
 * ——**可见，但不阻断**（否决 v4-pro 的「跳过簿记」：簿记描述磁盘上真实发生了什么，跳过它会让评审链
 * 看不见真实变更 ⇒ 制造更糟的静默）。
 *
 * ★ 三条硬约束（§8.1 零改面）：
 *   ① **纯解析、零 exec**：本函数不 spawn 任何进程（锚 N5：`lib/**` 里那个子进程模块名的**字面量**
 *      全库计数自批 26 D48-2 起的新基线为 **2**——codex 适配器 + `lib/host-check.mjs` 的宿主验收
 *      执行面〔D48-5 leaf 模块；决策 D26-5 有意改锁〕；故本注释仍**刻意不写出那个字面量**，
 *      否则注释自己就把计数撞多）。
 *   ② **不改簿记语义**（D9-10）：横幅只加在交付文本**前部**，报告正文一字不改；
 *      `deliverBookkeeping` 的调用点、参数、语义零变化。
 *   ③ **未带 `stages` ⇒ 不核验**（§9 边界 1）：自由文本段检测不可靠，明言放弃；该路径已有
 *      F13 漂移警告（`STAGE_DRIFT_RE`）兜底。
 *
 * 上游对照：verify 是**声明式**门禁（passed→allowed / failed→blocked / skipped→needs a summary），
 * 但上游**明言**把工程模式排除在机械完成侧守卫之外（`src/agent/completion.mjs:70-74` / `:118-122`）
 * ⇒ 本仓取「可见不阻断」，与 flow-driven review 的先例一致。
 *
 * @param {object[]|null|undefined} stages 本次派遣的阶段列表（缺省 / 空 ⇒ 返回空串）
 * @param {string} outputText 子代理交付报告原文
 * @returns {string} 横幅（含尾随空行）或空串——**调用点把它置于交付文本最前**
 */
export function stageGateNote(stages, outputText) {
  if (!Array.isArray(stages) || stages.length === 0) return ""
  const head = String(outputText ?? "").slice(0, STAGE_TABLE_SCAN_CHARS)
  const parsed = parseStageTable(head)
  if (parsed.issue !== null) {
    // D-54 ④ 诊断分岔：**找不到带头行**与**表在场但列位/状态词不可解析**是两回事——后者要点名
    // 「门实际看见了什么」；两条都仍走 stageGateBanner（console.warn + 前缀返回文本）。
    const reason = parsed.issue.kind === "missing"
      ? "报告未以阶段状态表开头（表缺失 / 超出前 " + STAGE_TABLE_SCAN_CHARS + " 字符扫描窗）"
      : "阶段表在场但列位或状态词不可解析（" + parsed.issue.detail + "）"
    return stageGateBanner("stage verification: UNDECLARED — " + reason)
  }
  const rows = parsed.rows
  const bad = rows.filter((r) => r.status === "failed")
  const noReason = rows.filter((r) => r.status === "skipped" && r.summary.trim() === "")
  if (bad.length === 0 && noReason.length === 0) return ""
  const parts = []
  if (bad.length > 0) parts.push("FAILED stage " + bad.map((r) => r.n).join(","))
  if (noReason.length > 0) parts.push("skipped without a summary " + noReason.map((r) => r.n).join(","))
  return stageGateBanner("stage verification: " + parts.join(" · "))
}

/**
 * 写门禁判定（tools/pre-execute waterfall 的一环）。
 * 规则：eng ON && 主代理（depth 0）&& 无有效 designToken
 * && 工具 ∈ {write, edit} && 目标 isProductCode → deny + 指引。其余 → next()。
 * ★ 批 10（D-36）：内存态为空时**显式读盘回退腿**（三态路由）——决策 D10-13…D10-15，
 *   完整论证（含对既有裁定 D1 的**明示推翻**）见 `docs/2026-09-13-ledger-discipline-design.md` §10。
 * @param {() => boolean} getConfigDefault — engineering 缺省（会话无覆盖时）
 * @param {string} [storPathOverride] — 令牌盘路径注入缝（测试用临时 DSH_HOME，对齐既有 `storPathOverride`
 *   先例）。**可选第二参、向后兼容**：既有调用形态 `makeWriteGate(() => …)` 零改动。
 */
export function makeWriteGate(getConfigDefault, storPathOverride) {
  return async (exec, next) => {
    try {
      const name = exec?.name
      if (!WRITE_TOOLS.has(name)) return await next()
      const agent = exec?.agent
      if (!agent?.session) return await next()
      // 只拦主代理（depth 0）；子代理是受启动校验保护的实现者（eng_coder 链）
      const depth = agent.session.header?.delegationDepth ?? 0
      if (depth > 0) return await next()
      const state = sessionState(agent.session.id)
      if (!engEffective(state, getConfigDefault())) return await next()
      // 有效 token：state 一致 + 形状/过期校验（D-30：两段式，无签名腿）
      if (state.designToken && validateDesignToken(state.designToken)) return await next()
      const target = targetPathOf(name, exec?.arguments)
      if (!target || !isProductCode(target)) return await next()
      // ————— 批 10（D-36）回退腿：**仅内存态为空时**读盘（六条件 a–f，设计档 §6.3）—————
      // ★ 层级区分（D10-15 / 边界 7）：**读盘失败 ≠ 门禁故障** ⇒ 一律按「无记录」**拒**，
      //   **绝不**落入下方「门禁自身故障 → 放行」的 catch（fail-open）——两者方向相反、**不同层**。
      // ★ **承重层 = 内层**（批 10 分歧审计 #8 **订正**：此前口径「外层 catch 承载 fail-closed」**已推翻**）：
      //   真保证 fail-closed 的是 `loadTokenRecord` **自身**的 fail-safe（缺失/损坏/不可读 → null ⇒
      //   三态 "missing" ⇒ 拒）——实测**删掉内层 fail-safe ⇒ 11 条用例转红**（宿主 = 无第二层的调用点，
      //   如 `eng_coder` 的读盘路径）；**本门禁内实测差异 = 0**（下一行的 catch 同样归零到 null，
      //   故 T-TF2/T-TF4 保持绿）。⇒ 下一行括的这层是**第二层纯防御**：本实现下**走不到**
      //   （`loadTokenRecord` 不抛），但**非装饰**——它归零的方向与下方 fail-open 的 catch **相反**。
      let diskRec = null
      if (!state.designToken) {
        try { diskRec = loadTokenRecord(agent.session.id, storPathOverride, agent.session?.header?.cwd) } catch { diskRec = null }
      }
      const diskToken = diskRec && typeof diskRec.token === "string" && diskRec.token !== "" ? diskRec.token : null
      // ★ **显式三态路由**（设计评审 #3：不得用单 `if` 落穿——那会让过期盘记录拿到「没有令牌」文案）：
      //   valid ⇒ 放行并回填；expired ⇒ 走既有 expired 文案；missing ⇒ 走既有 no-token 文案。
      // ★ **交付评审 #4 订正**：盘记录 `token` **非空但形状不可解析**（畸形串 / 旧版式 /
      //   `expiresAt` 段不可解析）时路由为 **missing**——**只有「真过期」才归 expired**，与
      //   `loadTokenRecord` 对畸形记录的 fail-safe **同向**（判据 = 「这枚凭证**不可用**」，
      //   不是「这枚凭证**过期了**」）。旧写法把**一切**校验失败都归 "expired"
      //   （`validateDesignToken(…) ? "valid" : "expired"`），而 `tokenExpiryMs(畸形串)` 为 null
      //   ⇒ `gateExpired` 为假 ⇒ 渲染 **no-token 文案**：**态与文案不符**（拒绝方向不变，但诊断
      //   在骗人）；第二段恰可解析为**过去时间戳**的畸形串更会渲染出**假的**「expired at …」。
      //   ★ 失败原因取**单一权威** `designTokenFailureReason`（token 形状知识不在此复制第二份；
      //   `validateDesignToken` 即其「原因 === null」）。
      const diskState = !state.designToken
        ? (diskToken === null ? "missing"
          : (validateDesignToken(diskToken) ? "valid"
            : (designTokenFailureReason(diskToken) === "expired" ? "expired" : "missing")))
        : null
      if (diskState === "valid") {
        // (e) 回填 state（避免每次写操作重复读盘）+ (d) 落**一行可见日志**——把 D1 反对的「静默」
        //     改成「可审计」（决策 D10-13：推翻的是路径，不是终态）。
        state.designToken = diskToken
        console.warn("[thincoder-suite] gate: design token restored from token-store (session "
          + agent.session.id + ", expires "
          + new Date(typeof diskRec.expiresAt === "number" && Number.isFinite(diskRec.expiresAt)
            ? diskRec.expiresAt : (tokenExpiryMs(diskToken) ?? Date.now())).toISOString() + ")")
        return await next()
      }
      // D-30 / FR-T6：令牌**已过期**时不得再说「先写设计文档」（误导——文档早就写完了）。
      // 指向真实出路：再调一次 eng_coder 走续期（文档未变则自动顺延，无需重评）。
      // 本门禁**绝不执行续期**（AC-21 [负]）：续期落点是 eng_coder 的过期子分支（决策 D1）
      // ——门禁契约是 fail-open 的纪律护栏，续期判定必须 fail-closed，两者语义互斥。
      // ★ (b) 判据与内存路径**完全同构**：盘记录过期 ⇒ 置起同一个 `gateExp` 输入，使既有 expired
      //   文案**原样复用**（不新造第二条文案）。
      // ★ **docHash 不进门禁判据**（D10-14）：内存路径今天也不查 ⇒ 盘路径查会造成两路径判据不一
      //   （那才是真的不一致）；「文档被改后令牌是否失效」是另一个命题，若做须两路径同做、另立批次。
      const gateExp = state.designToken ? tokenExpiryMs(state.designToken)
        : (diskState === "expired" ? tokenExpiryMs(diskToken) : null)
      const gateExpired = gateExp !== null && Date.now() > gateExp
      return {
        kind: "deny",
        reason: gateExpired
          ? "denied: engineering mode is ON and the current design token expired at " + new Date(gateExp).toLocaleString()
            + " — call eng_coder again with your token: if the design document set is unchanged the token is renewed automatically (no re-review); if it changed, re-run the design review. Docs (*.md under docs/ or at the root) stay writable."
          : "denied: engineering mode is ON and no design token — write the design document first, have the user initiate advisor(type='design'), then implement via eng_coder (the designToken parameter). Docs (*.md under docs/ or at the root) stay writable.",
      }
    } catch {
      return await next() // 门禁自身故障 → 放行（fail-open 只在此处：门禁 bug 不能瘫痪整个会话）
    }
  }
}

/**
 * 守卫 E 预闸（批 6b 设计档 §6.3 / D-E1/D-E11/D-E12）：窗口内冻结**正在被评审的文档**。
 * 与 `makeWriteGate` **刻意不同**的三点：
 *   ① **fail 朝向**——已确认窗口内 fail-closed（判定异常 ⇒ deny）；写门禁无条件 fail-open；
 *   ② **depth 不豁免**——全深度拦截（被审文档的写入权与写入者身份无关；子代理是典型漂移向量）；
 *   ③ **不查 `engEffective`**——窗口完整性不变式与主代理模式无关（加模式门会造出「标准模式下
 *      评审窗口无冻结」的静默洞）。
 * 结构化保证（D-E11）：**窗口判定区在 `try` 之外**（纯模块态、不可抛），`try` 只包目标解析/
 * 归一/成员判定 ⇒ `catch → deny` 在结构上只可能发生在「窗口已确认」之后。
 * @param {() => ({jobIds: string[], docSet: string[]}|null)} getFreezeSet — 槽位只读访问器
 *   （`advisor.mjs` 的 `designFreezeSet`；预闸不直接摸槽位表）
 */
export function makeDocFreezeGate(getFreezeSet) {
  return async (exec, next) => {
    // ① 名字门（**先于**注册表扫描）——绝大多数工具调用在此零成本返回，且使「注册表读取故障」
    //    的影响面被收窄到 write/edit 之内。
    if (!WRITE_TOOLS.has(exec?.name)) return await next()
    // ② 窗口判定区：在 try **之外**，纯模块态、不可抛（D-E11 的结构性保证）
    let freeze
    try { freeze = getFreezeSet() } catch (e) {
      // 注册表读取故障 ⇒ 窗口**未被确认** ⇒ 无可护之物 ⇒ 放行，但**必须 warn**
      //（D-E11 / N-4 / AC-E8 三处均要求「放行 + warn」——静默 fail-open 不可接受）
      console.warn("[thincoder-suite] 守卫 E 预闸：" + (e?.message ?? String(e)))
      return await next()
    }
    if (!freeze) return await next()
    const frozen = new Set(freeze.docSet)
    // ③ 判定区：try 内，抛异常 = fail-closed（deny）
    try {
      const target = targetPathOf(exec?.name, exec?.arguments)
      if (!target) return { kind: "deny", reason: frozenReason(freeze, null, "unresolvable target") }
      // D-47：归一基座 = 会话 cwd（与 D-44 同款来源与线程化点：agent.session.header.cwd；在 exec.agent
      // 上取与 makeWriteGate/D-36 的 loadTokenRecord 同款）。不传基座 ⇒ normalizeDocPath 退化成
      // process.cwd()（宿主进程的 cwd 是 profile 目录），相对路径 target 归一后对不上任何冻结项
      // ⇒ **静默放行**（fail-open）——A26-3 的回归锁钉的正是这一格。
      const norm = normalizeDocPath(target, exec?.agent?.session?.header?.cwd)
      if (!frozen.has(norm)) return await next()
      return { kind: "deny", reason: frozenReason(freeze, norm, null) }
    } catch (e) {
      return { kind: "deny", reason: frozenReason(freeze, null, "gate internal error: " + (e?.message ?? e)) }
    }
  }
}

/** 拒绝文案（D-E5：四条必备——在飞 job id / 归一路径 / settle 自释放 / `job_kill` 逃生门；
 * D-E13：前缀 `"frozen: "` 与写门禁 `"denied: "` **不混用**——两态出路完全不同）。 */
function frozenReason(freeze, target, err) {
  return "frozen: " + (freeze.docSet.length) + " document(s) are frozen while a design review is in flight"
    + " (job " + freeze.jobIds.join(", ") + ").\n"
    + (target ? "Target: " + target + "\n" : "")
    + (err ? "Reason: " + err + "\n" : "")
    + "Frozen document set (normalized):\n" + freeze.docSet.map(d => "- " + d).join("\n") + "\n"
    + "Options: (1) wait for the completion notice, then read it with job_output; "
    + "(2) escape early with " + freeze.jobIds.map(id => "job_kill " + id).join(" 或 ")
    + " — the slot releases on settle.\n"
    + "Note: editing a reviewed document now would in any case make this round fail the "
    + "settlement-side fingerprint re-check, so it cannot buy a token."
}

// ————————————— 批 29 / US-1（D29-1）：工具面禁执行（执行类工具名解析） —————————————
//
// 平台契约事实（2026-09-26 取证，设计 §2.1）：dsh-tools 的 restrict(filter) =「allow (keep only)
// / deny (remove)」；**未注册的工具名会被响亮拒绝**（不是静默忽略）⇒ 名字必须取自平台**实际注册
// 面**：取不到清单 ⇒ **如实标注「未生效」**（A29-2），**不得**凭猜下发 deny。
// 证据口径（A29-1 评审 #2）：平台回显的生效清单 = **强证**；只有派发载荷 = **弱证**（断言里必须区分）。

/** eng_coder 子会话的**既有** deny 基线（逐字保留：既有行为零漂移，批 29 只在其后追加执行类）。 */
const ENG_CODER_DENY = ["escalate", "consult_start", "consult_stop", "eng", "eng_coder", "ask_user_question"]

/**
 * D10 审计：工具面禁执行「未生效」标注的**一次闩**。
 * ★ 按 `ctx` **对象**记忆：生产路径全程是同一个 ctx ⇒ 等价「每进程一条」（机制态稳定，不该每次
 *   派发都刷一条）；测试夹具每次新建 ctx ⇒ **每个用例都能独立看到自己的首条标注**（无需测试缝）。
 *   非对象 ctx 无法记忆 ⇒ 退回模块级布尔（同样只报一次，绝不退化成每次派发都报）。
 */
const EXEC_DENY_WARN_LATCHED = new WeakSet()
// 假设如实写明（交付码评 #6）：本闩以 **deps.ctx 对象**为键，假定的前提是「生产路径全程同一个 ctx」。
// 若平台实际按每次派发发新 ctx，本闩退化为「每次派发一条 warn」——**仅噪声，零行为影响**（可接受）。
let execDenyWarnLatchedGlobal = false
/** @returns {boolean} true = 本 ctx 已经报过（调用方据此跳过标注） */
function execDenyWarnLatched(ctx) {
  const key = (ctx && typeof ctx === "object") ? ctx : null
  if (!key) {
    if (execDenyWarnLatchedGlobal) return true
    execDenyWarnLatchedGlobal = true
    return false
  }
  if (EXEC_DENY_WARN_LATCHED.has(key)) return true
  EXEC_DENY_WARN_LATCHED.add(key)
  return false
}

/**
 * 「执行类工具」名判据（命令 / shell / spawn 类）。★ 它只是**谓词**——成员必须来自平台实际注册面
 * （见 resolveExecToolDeny）；谓词未列出的执行类工具名不会被禁（覆盖面边界，如实登记）。
 * ★ **平台保留名必须排除（D1，2026-09-26 取证）**：`run_code` 是 PTC 呈现传输的保留名——
 *   `dsh-tools/lib/index.js:2905` 对 restrict()（含 `toolFilter.deny` 这条同路）命名它**直接抛错**
 *   （`cannot name reserved PTC mode presentation transport "run_code"; restrict end-capability
 *   tools instead`），未注册名同样抛错（`:2908`）⇒ 一旦把它推进 deny，**整个派发被打断**，
 *   比「拦不住」更糟。它也不在 `view().restrictableNames` 里（保留名由 `:2979` 另行注入
 *   `visible`），故 D2 的求交同样不会放行它。
 */
// 过匹配边界（交付码评 #2 如实注明）：成员里的 task / process / terminal 是**语义族名**，
// 若某部署恰有同名**非执行类**工具，会被一并加入 deny（子代理少一个辅助工具；证据 warn 可见）。
// 取舍：宁可过匹配（少个工具、看得见）也不漏匹配（留一条执行通路）。
const EXEC_TOOL_RE = /^(?:pwsh|powershell|bash|sh|zsh|cmd|shell|exec|spawn|run_terminal|terminal|process|task)$/i

/** 注册表读取面归一（数组 / Map / 普通对象 / 带 name 的对象数组；取不到 ⇒ null）。 */
function normalizeToolNames(raw) {
  if (!raw) return null
  if (Array.isArray(raw)) {
    const names = raw.map((e) => (typeof e === "string" ? e : (e && typeof e.name === "string" ? e.name : null)))
      .filter((n) => typeof n === "string" && n !== "")
    return names.length > 0 ? names : null
  }
  if (raw instanceof Map) {
    const keys = [...raw.keys()].filter((k) => typeof k === "string" && k !== "")
    return keys.length > 0 ? keys : null
  }
  if (typeof raw === "object") {
    const keys = Object.keys(raw).filter((k) => k !== "")
    return keys.length > 0 ? keys : null
  }
  return null
}

/** 回显面归一（**只认数组 / Map**——普通对象（工具实现表）不作数，免得把载荷或实现表误报成强证）。 */
function normalizeEchoNames(raw) {
  if (!raw) return null
  if (Array.isArray(raw)) {
    const names = raw.map((e) => (typeof e === "string" ? e : (e && typeof e.name === "string" ? e.name : null)))
      .filter((n) => typeof n === "string" && n !== "")
    return names.length > 0 ? names : null
  }
  if (raw instanceof Map) {
    const keys = [...raw.keys()].filter((k) => typeof k === "string" && k !== "")
    return keys.length > 0 ? keys : null
  }
  return null
}

/**
 * 名字集合归一（**Set / Map / 数组 / 普通对象**）：`view()` 返回的是 Set
 * （`dsh-tools/lib/index.js:2968-2969`），既有候选读取面可能是数组 / Map / 普通对象 ⇒ 一并容忍；
 * 取不到名字 ⇒ null。
 */
function normalizeNameCollection(raw) {
  if (!raw) return null
  if (Array.isArray(raw)) return normalizeToolNames(raw)
  if (raw instanceof Map) return normalizeToolNames([...raw.keys()])
  if (typeof raw === "object" && typeof raw[Symbol.iterator] === "function") {
    const names = [...raw].filter((n) => typeof n === "string" && n !== "")
    return names.length > 0 ? names : null
  }
  return normalizeToolNames(raw)
}

/**
 * 平台公开读取面 `view(scope)` 的 `restrictableNames`（D2，2026-09-26 本机取证）。
 * ★ 为什么只认它：`dsh-tools/lib/index.js:2959-2984` 的 `view(scope)` 返回
 *   `{ visible, knownNames, restrictableNames }`，而 `restrict()` 校验的名域**恰是**
 *   `restrictableNames`（`:2906-2908` 逐名 unknown 报错）——`knownNames` 多出「本层自有注册」与
 *   保留传输名 `run_code`，两者都不该被命名（`run_code` 一命名即抛错，见 EXEC_TOOL_RE 注释）。
 *   `scope` 可省（`:2956` 文档：「undefined for the global view」）⇒ 无参调用即全局视图。
 * @returns {string[]|undefined} 该面可用 ⇒ 名字数组（**可能为空**）；无该面 / 形状不符 ⇒ undefined
 */
function readRestrictableViewNames(svc) {
  if (typeof svc.view !== "function") return undefined
  let v = null
  try { v = svc.view() } catch { return undefined }
  if (!v || typeof v !== "object") return undefined
  const raw = v.restrictableNames
  if (raw === undefined || raw === null) return undefined
  return normalizeNameCollection(raw) ?? []
}

/**
 * 注册面读取（**名字 + 来源**；来源只用于诊断与断言，不改变判据）。
 * @returns {{names: string[]|null, source: "view.restrictableNames"|"registry-probe"|null}}
 */
function readRegisteredToolNameSurface(ctx) {
  let svc = (ctx && typeof ctx === "object" && ctx.tools) ? ctx.tools : null
  if (!svc && ctx && typeof ctx.get === "function") {
    try { svc = ctx.get("tools") } catch { svc = null }
  }
  if (!svc || typeof svc !== "object") return { names: null, source: null }
  // D2：平台公开读取面**优先**——它才是 restrict() 的合法名域；有它就不再退回落魄的候选面探测
  const viaView = readRestrictableViewNames(svc)
  // 批 29 / US-4 🔵(a)：**面可用但名集为空**（`view().restrictableNames` 是个空集）与**面不可用**
  // 是两种不同形态，必须可分辨——原写法把空集也折成 null ⇒ caller 只能说「读取面不可用」，
  // 归因不清。这里**保留空数组**（source 仍标 view.restrictableNames），由 resolveExecToolDeny
  // 按 `names === null` / `names.length === 0` 分开归因；两条路的 applied 都是 false（都不假装拦住）。
  if (viaView !== undefined) return { names: viaView, source: "view.restrictableNames" }
  for (const key of ["list", "names", "all", "entries", "snapshot", "toolNames"]) {
    const fn = svc[key]
    if (typeof fn !== "function") continue
    try {
      const got = normalizeToolNames(fn.call(svc))
      if (got) return { names: got, source: "registry-probe" }
    } catch { /* 该面不可用 ⇒ 试下一面 */ }
  }
  if (typeof svc.keys === "function") {
    try {
      const got = normalizeToolNames([...svc.keys()])
      if (got) return { names: got, source: "registry-probe" }
    } catch { /* 同上 */ }
  }
  return { names: null, source: null }
}

/**
 * 平台**实际注册面**的工具名清单（探测；取不到 ⇒ null）。
 * ★ 平台包在 asar 内、本机无法取证注册表 API 的确切形状 ⇒ 显式探测若干候选读取面，
 * **一个都不成立就诚实地返回 null**（caller 按 A29-2 标注「未生效」）——**绝不**退化成硬编码
 * 名单（那会在未注册该名的部署上被平台响亮拒绝，直接打断 eng_coder 派发）。
 * ★ D2：**首选平台公开面 `view(scope).restrictableNames`**（上一版的 7 个候选名在本机平台上
 * **一个都不存在** ⇒ 生产恒未生效）；候选面仅为旧形态兜底。
 * @param {{tools?: object, get?: Function}|null|undefined} ctx 插件上下文
 * @returns {string[]|null} 名域可用 ⇒ 名字数组（**可能为空**——「面可用但可限制名集为空」是与
 *   「面不可用（null）」不同的形态，由 resolveExecToolDeny 分开归因，批 29 / US-4 🔵(a)）；
 *   一个读取面都不成立 ⇒ null。
 */
export function collectRegisteredToolNames(ctx) {
  return readRegisteredToolNameSurface(ctx).names
}

/**
 * 执行类禁用面解析（派发前调用一次）：**只挑平台返回面里在册的**执行类工具名，追加进既有 deny 基线。
 * ★ 名字只可能来自平台返回面（优先 `view().restrictableNames`）⇒ 下面这一次过滤**同时就是**
 *   「与 restrictableNames 求交」：既不碰保留传输名（`run_code`，一命名即抛错），也不发未注册名
 *   （平台 `restrict()` 会响亮拒绝）。
 * @param {object} ctx 插件上下文（探测注册面）
 * @param {string[]} [baseDeny] 既有 deny 基线（缺省 ENG_CODER_DENY）
 * @returns {{deny: string[], applied: boolean, execNames: string[], source: string|null, reason: string|null}}
 *   applied:false ⇒ deny 仍是**逐字基线**（未下发任何执行类名）且 reason 说明为何未生效——
 *   caller 必须**如实标注「未生效」**（A29-2）。**批 29 / US-4 🔵(a)**：reason 把两种归因分开写
 *   ——「读取面不可用」（探测全败：拿不到名域，连本部署有没有执行类工具都不知道）与「面可用但
 *   可限制名集为空」（名域真存在但是空集：平台侧本就无工具可禁）——两者的诊断价值不同，
 *   混成一句会让读者以为是同一种环境故障。
 */
export function resolveExecToolDeny(ctx, baseDeny) {
  const base = Array.isArray(baseDeny) ? [...baseDeny] : [...ENG_CODER_DENY]
  const surface = readRegisteredToolNameSurface(ctx)
  if (surface.names === null) return { deny: base, applied: false, execNames: [], source: surface.source, reason: "读取面不可用：取不到平台工具名清单（注册表读取面探测全败）" }
  if (surface.names.length === 0) return { deny: base, applied: false, execNames: [], source: surface.source, reason: "面可用但可限制名集为空：view().restrictableNames 是空集——本部署没有可下发的工具名" }
  const exec = surface.names.filter((n) => EXEC_TOOL_RE.test(n))
  if (exec.length === 0) return { deny: base, applied: false, execNames: [], source: surface.source, reason: "注册面里没有命中执行类谓词的工具名" }
  const deny = [...base]
  for (const n of exec) if (!deny.includes(n)) deny.push(n)
  return { deny, applied: true, execNames: exec, source: surface.source, reason: null }
}

/**
 * 平台**回显的生效工具清单**（A29-1 的**强证**）；平台不回显 ⇒ null（弱证：只有派发载荷）。
 * ★ 只认**子会话生效面**（toolNames / tools / allowedTools / effectiveTools）；spec / toolFilter 属
 * **请求侧**，是载荷而非回显 ⇒ 不算强证。
 * @param {object|null|undefined} run ctx.subagents.start 的返回对象
 * @returns {string[]|null}
 */
export function readEffectiveToolEcho(run) {
  if (!run || typeof run !== "object") return null
  for (const key of ["toolNames", "tools", "allowedTools", "effectiveTools"]) {
    const got = normalizeEchoNames(run[key])
    if (got) return got
  }
  return null
}

/**
 * 执行类禁用面的**证据口径**（A29-1）：强证 = 平台回显生效清单；弱证 = 只有派发载荷。
 * @returns {{evidence: "platform-echo"|"dispatch-payload", effective: string[]|null}}
 */
export function execDenyEvidence(run) {
  const echo = readEffectiveToolEcho(run)
  return echo ? { evidence: "platform-echo", effective: echo } : { evidence: "dispatch-payload", effective: null }
}

// ————————————— eng_coder —————————————

// ————————————— F13 阶段化任务书（§3.1/§3.2/§3.3） —————————————

/** §3.1 漂移探测正则（verbatim）：stages 缺省但 task 匹配 → 前缀警告（N4 先例，不阻塞）。 */
const STAGE_DRIFT_RE = /stage|阶段\s*\d/i
/** §3.1/§8：阶段数上限（schema maxItems 10 拒 + description 引导 2–8 个可自查交付增量）。 */
export const STAGES_MAX = 10

/**
 * stages 渲染前防御校验（设计 §7 实施确认项 5：host tool schema 对嵌套数组 items 的
 * required/minLength/minItems 强制力未证实 → 代码级兜底；schema 层另有同款约束，双保险）。
 * 每项必须 { goal: 非空 string, files: ≥1 个非空 string[], acceptance: 非空 string,
 * check: 非空 string }——required + minLength 1（空串/空数组不通过，评审 #13：不存在
 * 「缺段渲染」歧义）；超 10 项拒。通过时返回净化副本（字段照抄、files 复制）。
 * @returns {{ok: true, stages: object[]}|{ok: false, error: string}}
 */
export function validateStages(stages) {
  if (!Array.isArray(stages)) {
    return { ok: false, error: "stages must be an array of { goal, files, acceptance, check } objects" }
  }
  if (stages.length === 0) {
    return { ok: false, error: "stages must contain at least one stage" }
  }
  if (stages.length > STAGES_MAX) {
    return { ok: false, error: "stages supports at most " + STAGES_MAX + " stages (got " + stages.length + ")" }
  }
  const norm = []
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    const p = "stages[" + i + "]"
    if (!st || typeof st !== "object" || Array.isArray(st)) {
      return { ok: false, error: p + " must be an object with goal/files/acceptance/check" }
    }
    const clean = {}
    for (const f of ["goal", "acceptance", "check"]) {
      if (typeof st[f] !== "string" || st[f].trim() === "") {
        return { ok: false, error: p + "." + f + " must be a non-empty string" }
      }
      clean[f] = st[f]
    }
    // D48-1：checkMode 可选枚举（"subagent" | "host"）。出现时必须是两值之一——拒绝而非静默丢
    //（与 required 字段的防御姿态一致；schema 层另有同款 enum 双保险）。不出现时**不写键**
    //（净化副本形状与既有 deepEqual 用例兼容）。缺省值是「路径语境」（dsh=host / codex=subagent），
    // 由 runEngCoder 的 stagesWithModeDefault 在渲染/验收前填——不属阶段数据本身。
    if (st.checkMode !== undefined && st.checkMode !== null) {
      if (st.checkMode !== "subagent" && st.checkMode !== "host") {
        return { ok: false, error: p + '.checkMode must be "subagent" or "host"' }
      }
      clean.checkMode = st.checkMode
    }
    if (!Array.isArray(st.files) || st.files.length === 0) {
      return { ok: false, error: p + ".files must be a non-empty array of file paths" }
    }
    const files = []
    for (const fp of st.files) {
      if (typeof fp !== "string" || fp.trim() === "") {
        return { ok: false, error: p + ".files entries must be non-empty strings" }
      }
      files.push(fp)
    }
    clean.files = files
    norm.push(clean)
  }
  return { ok: true, stages: norm }
}

/**
 * F13 Staged execution 块渲染（§3.1/§3.2/§3.3，stages 存在时插入 Docs 段之后）：
 * - 纪律段（§3.1）：按序执行；stage N 自查不过不得进入 N+1；阶段内只动本阶段 files
 *   （文档同步例外）；跨阶段文件需求 = STOP 上报；同一阶段第二次真修后仍失败 → STOP（§3.2：
 *   check 失败 ≠ 立即停——阶段内有限自修是自查的意义；硬停条件）；
 * - 预算将尽条款（§3.3-3）：意识到输出预算将尽 → 立即停止开启新阶段、跑完当前阶段 check、
 *   以 stage 表开头收尾；
 * - stage 状态表前置指令（§3.1）：| Stage | Status (passed/failed/skipped) | check summary |
 *   置于报告最前——F9 max-tokens 掐断事故的生存性设计：输出被掐也保住分类账；Touched files
 *   被掐丢可从表内 Files 列重建；
 * - 逐阶段四段（§3.1 统一编号）：### Stage N — goal / Files / Acceptance / check。第四段标签按
 *   checkMode 取值：subagent 态 = 既有的「Self-check:」（逐字节不变）；host 态 = D29-3 的
 *   「Host check (宿主验收清单——由宿主执行，你不要执行；宿主用):」+ 命令行后的宿主用注记。
 * 单次 spawn 跑完全部阶段（§3.2 有意设计——docs 只读一遍、上下文延续、失败报告天然定位；
 * 每阶段一 spawn 的被否方案有隐性耦合：每次 spawn 触发 advisorRound 清零 + touchedFiles
 * 合并（本模块交付后重置逻辑）——勿改 per-stage）。
 */
function renderStagesBlock(stages) {
  // D48-1：checkMode 生效值在此解析。直呼 buildCoderBrief（测试/旧调用）未填 checkMode ⇒ 按
  // "subagent" 渲染——既有字节面零漂移；dsh/codex 路径的缺省由 stagesWithModeDefault 预填。
  const effMode = (st) => (st && (st.checkMode === "host" || st.checkMode === "subagent")) ? st.checkMode : "subagent"
  const anyHost = stages.some((s) => effMode(s) === "host")
  const lines = [
    "## Staged execution",
  ]
  if (!anyHost) {
    lines.push(
      "Execute the stages in order: stage N's self-check must pass before you enter stage N+1. Within a stage, touch only that stage's files (keeping the docs listed above in sync is the only exception). If a change outside the current stage's file list becomes necessary, STOP and report it.",
      "A failed self-check means fix-and-retry within the stage (re-run the check after fixing — the context is still warm). If a stage's check still fails after a second genuine fix attempt, STOP: never advance a failing stage.",
      "Budget survival clause: the moment you notice the output budget is nearly exhausted, stop opening new stages, finish the current stage's self-check, and close out with the stage status table at the top of your report.",
      "Your report MUST START with the stage status table (before any other content), one row per stage: | Stage | Status (passed/failed/skipped) | check summary |. If you stop on a failed stage, follow the table with the failure detail: the check command verbatim, its output tail, and your hypothesis. If the Touched files line gets cut off, the table's Files columns are the recovery source.",
    )
  } else {
    // D48-1：host 态阶段的任务书**不得出现「跑它」语义**（实测同一会话两次都没拦住）——
    // 阶段门文案同步改为「本阶段不要求你执行命令」，验证门归位到宿主（A26-6/AC-7）。
    lines.push(
      "Execute the stages in order: finish stage N completely before you enter stage N+1. Within a stage, touch only that stage's files (keeping the docs listed above in sync is the only exception). If a change outside the current stage's file list becomes necessary, STOP and report it.",
      "验证命令不归你执行（本阶段不要求你执行命令）：凡标注「由宿主执行」的 check 命令（宿主验收清单；宿主用），由宿主在交付后执行并把验收回执写进交付报告——你只负责把命令原样报回（报告的 check summary 列），不要执行任何验证/测试命令。A stage whose edits you could not complete is failed in your table; if a stage still cannot be completed after a second genuine fix attempt, STOP: never advance a failing stage.",
      "Budget survival clause: the moment you notice the output budget is nearly exhausted, stop opening new stages, finish the current stage's edits, and close out with the stage status table at the top of your report.",
      "Your report MUST START with the stage status table (before any other content), one row per stage: | Stage | Status (passed/failed/skipped) | check summary |. For host-executed checks put the command verbatim in the check summary and attest your own edits; if you stop on a failed stage, follow the table with the failure detail and your hypothesis. If the Touched files line gets cut off, the table's Files columns are the recovery source.",
    )
  }
  lines.push("")
  for (let i = 0; i < stages.length; i++) {
    const st = stages[i]
    lines.push("### Stage " + (i + 1) + " — " + st.goal)
    lines.push("Files:")
    for (const f of st.files) lines.push("- " + f)
    lines.push("Acceptance:")
    lines.push(st.acceptance)
    // D29-3（AC-3）：check 的语义 = **宿主验收清单**。host 态改用 Host check 标签（该态**不得**再出现
    // 「Self-check」字样，也不得出现暗示子代理自验的措辞）；非 host 态保持既有「Self-check:\n<命令>」
    // 四段形态**逐字节不变**（T10 与 T9 的字节面依赖它）。
    const hostMode = effMode(st) === "host"
    lines.push(hostMode ? "Host check (宿主验收清单——由宿主执行，你不要执行；宿主用):" : "Self-check:")
    lines.push(st.check)
    if (hostMode) {
      // 注记放在命令行**之后**（「宿主用」紧邻命令串；子代理侧保持「Self-check:\n<命令>」的既有四段形态）
      lines.push("验证命令（由宿主执行，你只负责原样报回；宿主用）——本阶段不要求你执行命令；宿主将在交付后执行该命令并把验收回执写入交付报告。")
    }
    lines.push("")
  }
  return lines
}

/**
 * 批 11（设计档 §6.2）：失败后缀块 —— 出口边界后处理。
 * ★ 位置契约：必须落在阶段门函数体切片（阶段门函数 → makeWriteGate）**之外**——该切片受
 *   `test/stage-gate.test.mjs` 的**四标识符禁用检查**覆盖；**逐字节锁的区间是
 *   `[makeWriteGate, WG_END)`，从该切片结束处才开始——两者不重叠**。真正约束 helper 位置的
 *   活断言在 `test/doc-hygiene.test.mjs`。
 * ★ 不改 deathLine（R0 档）：块只**追加**在既有失败字串之后，既有断言全是 `includes`。
 * ★ 字节雷区：本块**不含**设计档 §6.2 点名的两个禁字面（见 `test/codex-runner.test.mjs`
 *   的逐字反向谓词；裸词 `Touched` 不禁），也不引入阶段门字样。
 * ★ 适用边界：只罩**终态执行失败**（codex 两路非零退出 / reject · dsh 两路兜底超时 /
 *   stopReason 非 completed / abort / 泛错 / failed-to-start）；**不罩**预检拒绝
 *   （task 缺失 / token 门 / in-flight 单飞——工作未发生，自带补救指引、无菜单）。
 *   两类**靠返回点位置区分**（预检发生在 spawn 之前），**绝不用内容判据**。
 */
const FAILURE_OPTIONS_BLOCK = [
  "",
  "--- eng_coder 执行已停止 —— **不自动重派**，由用户裁决。---",
  "报告须含：崩在哪一步（见上方 detail）/ 工作区已改了什么（见上方 partial 与 Touched advisory）/ 任务哪部分未动。",
  "可选项：",
  "  ① 原样重派（同 token，若仍有效 —— 自报阶段失败那一类 token 未消费）",
  "  ② 带半成品继续（先核对 partial 与工作区实况）",
  "  ③ 清理工作区后重来（必要时 git 回滚）",
  "  ④ 改道（换执行通道或策略）",
  "  ⑤ 作废本链",
].join("\n")

/** 出口边界后处理 wrapper：把失败后缀块**追加**在既有失败字串之后（一次定义，逐返回点调用）。 */
function failStop(text) {
  return String(text) + "\n" + FAILURE_OPTIONS_BLOCK
}

// ————————————— 批 26 / D-48：验证门归位（checkMode）+ 宿主验收回执 + 兜底信封可操作化 —————————————
// 根因（设计档 §2.5）：dsh 子代理执行子进程会「起跑即挂死」（既不报错也不返回，实测两次），
// 而结构化 stages[].check + 阶段门语义一直在推它去跑 ⇒ 编辑全部落地、验证相位挂死。
// 修法四条中的三条落在本文件：D48-1 执行者归位（stages[].checkMode，dsh 路径缺省 host）·
// D48-2 宿主验收回执（交付后宿主侧按 check 跑一遍，回执进交付报告与落盘文件；执行面见
// lib/host-check.mjs——本文件只持调用侧）·
// D48-3 兜底信封附 check 命令原文 + 取证指路（dshBackgroundTimeoutMs 掐死时一眼可见怎么验收）。

/**
 * D48-1：checkMode 的**路径缺省**（dsh 路径 = "host"、codex 路径 = "subagent"）。validateStages
 * 只做枚举校验、不填缺省——「谁来跑验证」是执行路径的语境，不是阶段数据本身；显式传入的
 * checkMode 永远优先（两条路径都尊重）。无 stages / 空表原样返回。
 */
function stagesWithModeDefault(stages, defaultMode) {
  if (!Array.isArray(stages) || stages.length === 0) return stages
  return stages.map((s) => (s && s.checkMode !== undefined && s.checkMode !== null) ? s : { ...s, checkMode: defaultMode })
}

/** stages 的 check 命令原文块（D48-3：兜底信封自带，宿主一条命令即可验收，不必翻会话导出）。 */
function stageCheckCommandsBlock(stages) {
  const rows = (Array.isArray(stages) ? stages : [])
    .map((s, i) => ({ n: i + 1, cmd: s && typeof s.check === "string" ? s.check.trim() : "" }))
    .filter(({ cmd }) => cmd !== "")
    .map(({ n, cmd }) => n + ". " + cmd)
  if (rows.length === 0) return ""
  return "\n\nstages 的 check 命令原文（宿主可直接执行）：\n" + rows.join("\n")
}

/** D48-3 取证指路句：本次是人肉翻会话导出才查清挂死根因（A26-7），这句话把它变成一眼可见。 */
const DSH_SANDBOX_FORENSICS =
  "\n[thincoder-suite] 取证指路（D-48）：若上方输出为空且验证类日志 0 字节 ⇒ 高度疑似沙箱禁子进程" +
  "（起跑即挂死，既不报错也不返回）⇒ 请宿主执行上述 check 命令验收交付；本报告已附改动文件清单（Touched）。"

/**
 * eng_coder 任务书（对齐 thincoder：Docs involved + 文件清单 + 验收标准 + token 走参数）。
 * F13（§3.1）：第三个参数 stages（可选结构化阶段列表）——**stages 缺省时输出逐字节等于现行**
 * （T9 fixture 回归锁死：现行 brief 是三个历史交付共同依赖的契约，parseTouchedFiles 从尾部
 * 解析的尾行约定不动）；有 stages 时在 Docs 段后插入 renderStagesBlock（其余行零改动）。
 */
export function buildCoderBrief(task, docs, stages) {
  const lines = [
    "# Implementation Task (engineering workflow)",
    task,
    "",
  ]
  if (docs && docs.length > 0) {
    lines.push("## Docs involved (read them ALL in full before coding)")
    for (const d of docs) lines.push("- " + d)
    lines.push("")
  }
  if (stages && stages.length > 0) {
    lines.push(...renderStagesBlock(stages))
  }
  lines.push(
    "Implement to the full design — no silent degradation. If a stated design element is missing from the docs above, note it in your report; do not invent.",
    "Do not modify any file not listed in the design.",
    "Do NOT run destructive git commands (rebase / reset --hard / clean -f / push --force) — the parent session owns git history operations.",
    "Do NOT ask the user questions (ask_user_question is disabled for you). If a user decision is needed, list it under 'Decisions needed from the parent session' in your report.",
    "",
    "Your last message IS the report the parent sees. Make it complete:",
    "1. What you changed and why",
    "2. The path of every file you touched",
    "3. How you verified (checks/tests run, with results)",
    "4. Any deviations from the design or items worth follow-up",
    "",
    "END the report with one line exactly in this format (comma-separated relative paths, or 'none'):",
    "Touched files: <paths>",
  )
  return lines.join("\n")
}

/**
 * 执行一次 eng_coder 派遣。
 * @param deps { ctx, agent, config, signal, configDefaultEngineering, storPathOverride?, hostCheckOpts? }
 *              — storPathOverride = F10/F12 存储路径注入缝（测试用临时目录，非用户配置；
 *                缺省走 token-store/session-store 的 DSH_HOME 解析）
 *              — hostCheckOpts = A26-8 宿主验收注入缝 { timeoutMs?, spawnImpl? }（原样透传
 *                lib/host-check.mjs；测试用零真进程/毫秒级超时；缺省 = 真实执行面）
 * @param args { task, designToken, docs?, stages?, background? } — background 为 dsh 子代理后台执行开关
 */
export async function runEngCoder(deps, args) {
  const { ctx, agent, signal } = deps
  const config = (deps?.config && typeof deps.config === "object") ? deps.config : {}
  const state = sessionState(agent.session.id)
  const task = String(args?.task ?? "").trim()
  if (!task) return "Error: task is required."
  const docs = Array.isArray(args?.docs) ? args.docs.filter(d => typeof d === "string" && d.trim()) : []

  // 警告通道（F9 先例 + F13 复用）：console.warn + 随工具返回文本带出（主会话可见）。
  // 提前到 token 校验之前——F13 漂移警告要能附着在早期拒绝返回上。
  const warnings = []
  const warn = (m) => {
    console.warn("[thincoder-suite] " + m)
    warnings.push("[thincoder-suite] warning: " + m)
  }
  const warnPrefix = () => warnings.length > 0 ? warnings.join("\n") + "\n\n" : ""

  // F13（§3.1）：stages 结构化参数——渲染前防御校验（实施确认项 5：host schema 对嵌套 items
  // 的 required/minItems 强制力未证实，代码级兜底；schema 层另有同款约束，双保险）。
  let stages = null
  if (args?.stages !== undefined && args?.stages !== null) {
    const v = validateStages(args.stages)
    if (!v.ok) return "Error: invalid stages — " + v.error
    stages = v.stages
  }
  // F13 漂移探测（§3.1，verbatim /stage|阶段\s*\d/i）：stages 缺省但 task 文本疑似描述阶段
  // → 前缀警告（N4 先例：警告不阻塞执行，主代理可见后可改用 corrected stages 重派）。
  if (!stages && STAGE_DRIFT_RE.test(task)) {
    warn("task text mentions stages (stage/阶段 N) but no structured stages parameter was passed — pass stages=[{ goal, files, acceptance, check }] to get the ordered host acceptance checklist (宿主验收清单——由宿主执行，你不要执行) in the brief")
  }

  // 会话级前置检查：工程模式 OFF → 直接拒（D-30 批 2 代码评审 #3：本检查**先于** token 校验/
  // 续期块）。此前它排在续期副作用之后——eng OFF 的会话调 eng_coder 虽被拒，其令牌却已被顺延
  // 并落盘（「被拒绝的调用产生了状态与磁盘变更」）。前置后：被拒 = 零副作用（state/磁盘一字未改）。
  if (!engEffective(state, deps.configDefaultEngineering)) {
    return warnPrefix() + "Error: engineering mode is OFF — eng_coder is the engineering-workflow implementer. Use eng(action='enter') first."
  }

  // token 机械校验：与状态一致 + 形状/过期有效（不符即拒——spawn 时刻的授权门禁）。
  // R3 三态拒绝：never issued（本会话 state.designToken 为空）/ expired（token 第二段
  // expiresAt 已过）/ mismatch（其余不一致，保持现行文案）。
  // D-30（FR-T5）把 expired 一态扩为**四路判定**：可续期（文档集指纹未变 → 同 uuid 顺延）/
  // 文档已变更（拒绝）/ 无法续期（无记录或无指纹）/ 旧版本令牌（三段式，FR-T9）。续期落点
  // 定在此处（决策 D1：天然 fail-closed、有工具结果通道回传新串、重启回填路径正好汇入、
  // 变异发生在同步预派发段无并发续期竞态）。
  // 判序：先看会话有无签发记录，再看存量 token 是否过期（过期优先于不一致——即使回传
  // 正确 token 也已失效，出路是续期或重评）。
  let token = args?.designToken
  // F10（docs/2026-09-02 §2.1 读取时序）：内存态无 token（重启后）→ 查磁盘——本 sessionId
  // 有签发记录即回填 state.designToken，由下方既有三态校验统一裁决（有效 → 放行并维持回填；
  // 过期 → expired 提示；与回传 token 不一致 → mismatch 提示）。loadTokenRecord 内部 try/catch：
  // 文件缺失/损坏/不可读 → null（fail-safe，评审 #1），落入三态拒绝不崩溃。
  if (!state.designToken) {
    const rec = loadTokenRecord(agent.session.id, deps.storPathOverride, agent.session?.header?.cwd)
    // 回填收窄为「传入 token === 盘上记录 token」（分歧审计 D1）：错 token 不回填——**这条收窄
    // 本批一字未动**（错 token 回填会让 state 持有一枚并非调用方所持的凭证）。
    // ★ 批 10（D-36）**翻案说明（旧理由已作废；防下轮审计把本修复当回归抓出来）**：D1 当时还写了
    //   「避免盘上有效 token 经一次调用就驻留 state、从而**间接**打开主代理写门禁」——它护的是
    //   「**静默 + 间接**」的能力提升。本批让**写门禁自己**在内存态为空时**显式**读盘
    //   （`makeWriteGate` 的回退腿）：**终态相同、路径不同**，且**留痕**（`gate: design token
    //   restored from token-store`）⇒ 可审计性高于现状；能力层面「回填路径**早已存在**」
    //   （主代理本可读盘、带原值调 eng_coder 触发回填）⇒ 内存态从来不是能力边界、只是摩擦。
    //   完整论证（信任边界 / 纪律不变式 / 能力边界三层）见
    //   `docs/2026-09-13-ledger-discipline-design.md` §10「推翻 D1」专节。
    //   过期记录经 token 全等仍进三态 expired。
    if (rec && token && token === rec.token) {
      state.designToken = rec.token
    } else if (rec && token) {
      // 评审 #4：盘上有签发记录但传入 token 不匹配 → mismatch 文案（比 never-issued 信息更准）
      return warnPrefix() + "Error: invalid design token — it does not match the latest issued record for this session. Re-run the design review to mint a fresh token."
    } else if (rec && !token) {
      return warnPrefix() + "Error: design token was issued in this session but was not provided this time（本会话已签发但本次未传 token）— pass the designToken from the PASSED advisor(type='design') review."
    }
  }
  if (!token || token !== state.designToken || !validateDesignToken(token)) {
    if (!state.designToken) {
      return warnPrefix() + "Error: no design token issued in this session（从未签发）— run advisor(type='design') first (the user initiates it)."
    }
    const expiresAt = tokenExpiryMs(state.designToken) // 评审 #5：与 advisor.mjs tokenExpiryMs 单一事实源
    const expiredAt = expiresAt !== null && Date.now() > expiresAt
    const expiredText = "Error: design token expired at " + new Date(expiresAt ?? Date.now()).toLocaleString()
      + " (TTL engTokenTtlMs)"
    if (!expiredAt) {
      // —— 未过期但校验不通过：三种可区分来源（D-30 / FR-T6 文案区分） ——
      // 判序（D-30 批 2 代码评审 #2）：
      // ① 形状不兼容**优先**于 SUPERSEDED——它比「被续期取代」更具体，且三段式旧令牌不可能
      //    来自本会话的续期（续期保持同一两段式 uuid）。检测面与过期子分支同款（state 与传入
      //    串两侧都看）：只查 state 会让「state 已是续期后的两段式、传入的是旧三段式」拿不到
      //    AC-24 要求的「旧版本令牌」文案。
      if (designTokenShape(state.designToken) === "legacy" || designTokenShape(token) === "legacy") {
        return warnPrefix() + "Error: this is a **legacy (three-part) design token** issued by an older version of this plugin"
          + "（旧版本令牌：形状已不兼容，现行格式为两段式 uuid:expiresAt）— such a token cannot be renewed or accepted."
          + " Re-run the design review once to mint a fresh token."
      }
      // ② SUPERSEDED 收紧为「传入串与 state.designToken **同 uuid** 且传入已过期」（评审 #2）：
      //    不校验同 uuid 时，一枚从未签发过的过期垃圾串会被误报「已被本次会话的续期取代」
      //    （实际什么都没发生过）。不同 uuid 的过期串回落到下方的 mismatch 文案（仍拒绝，
      //    无安全影响——只是不再给出虚假因果）。
      const passedExp = typeof token === "string" ? tokenExpiryMs(token) : null
      const sameUuid = typeof token === "string" && typeof state.designToken === "string"
        && token.split(":")[0] === state.designToken.split(":")[0]
      if (passedExp !== null && Date.now() > passedExp && sameUuid) {
        // AC-18：同会话两个 eng_coder 用同一过期令牌——第一个已续期，第二个手里是被取代的旧串
        return warnPrefix() + "Error: the design token you passed has been SUPERSEDED by a renewal in this session"
          + "（已被本次会话的续期取代）— the token was renewed when an earlier eng_coder call used the expired one."
          + " Use the NEW token returned by that eng_coder call (re-renew it the same way if you lost it)."
      }
      return warnPrefix() + "Error: invalid or missing design token — eng_coder requires the token issued by a PASSED advisor(type='design') review. Run the design review first (the user initiates it), then pass its token verbatim."
    }
    // ————— 过期子分支（FR-T5 四路判定；决策 D1 的落点） —————
    // ① 旧三段式令牌（FR-T9）：形状检测给出**可区分**的诚实指引；不做旧格式兼容验签（决策 D8——
    //    保留旧通道等于保留伪造面，先例 = v2 废除 [DESIGN-TOKEN:...] 回显）。此路同时说明
    //    「无法续期」，避免与②③文案混淆。
    if (designTokenShape(state.designToken) === "legacy" || designTokenShape(token) === "legacy") {
      return warnPrefix() + expiredText + " — it is a **legacy (three-part) design token** issued by an older version"
        + "（旧版本令牌：形状已不兼容，现行格式为两段式 uuid:expiresAt，且旧签名腿已删除）——无法续期。"
        + " Re-run the design review once to mint a fresh token."
    }
    // ② 读盘记录：续期的唯一素材来源（token + 签发时绑定的文档集指纹）。无记录 → 无法续期
    //    （重启后回填路径也汇入此处：回填后的 token 已过期 → 本分支查盘续期，即头号场景 AC-14）。
    const rec = loadTokenRecord(agent.session.id, deps.storPathOverride, agent.session?.header?.cwd)
    const recHash = rec && typeof rec.docHash === "string" && rec.docHash !== "" ? rec.docHash : null
    if (!rec || !recHash) {
      return warnPrefix() + expiredText + " — it cannot be renewed automatically: this session's issued record carries"
        + " no design-document fingerprint（无法续期：该次评审未绑定文档集，或记录来自升级前的旧版本）"
        + " — re-run the design review to mint a fresh token."
    }
    // ③ 重算文档集指纹（doc-hash.mjs 单点实现，与签发时同一函数）。fail-closed（N3）：
    //    任一文档缺失/不可读 → 视为「已变更」→ 拒绝（不 spawn、不改 state、不写盘）。
    //     D-44：显式传**会话 cwd** 作基座（叶子模块不猜 process.cwd()——那是 profile 目录）。记录里的
    //     docPaths 本是归一后的绝对路径，传基座是零行为变更的加固（旧版本/手改记录若含相对路径也能读对）。
    const dh = computeDocHash(Array.isArray(rec.docPaths) ? rec.docPaths : [], agent.session?.header?.cwd)
    if (!dh.ok) {
      return warnPrefix() + expiredText + " — it cannot be renewed: the design document set is no longer readable"
        + "（文档不可读/缺失：" + dh.missing.join(", ") + "）——按「已变更」处理（fail-closed）。"
        + " Re-run the design review."
    }
    // ③b 记录不完整（D-30 批 2 代码评审 #4）：有 docHash 却缺/空 docPaths（手改或损坏的盘上
    //     记录）——此时重算的是**空条目集**的摘要（doc-hash.mjs:61），与 recHash 必然不等，
    //     旧判序会把它归到「文档已变更」（误导：根本没有文档集可比）。归到与「无指纹」同源的
    //     「无法续期（记录不完整）」文案，AC-12 的可区分性才在畸形形态下同样成立。
    //     方向不变：仍拒绝（fail-closed），只是诊断文案归对类。正常路径不可达（advisor 只在
    //     docPaths 非空时写 docHash；token-store 保存面同步约束）。
    if (dh.docPaths.length === 0) {
      return warnPrefix() + expiredText + " — it cannot be renewed automatically: this session's issued record carries"
        + " a design-document fingerprint but no document path list（无法续期：记录不完整——有指纹但缺文档集路径表，"
        + "无法判断文档是否变更）— re-run the design review to mint a fresh token."
    }
    if (dh.hash !== recHash) {
      return warnPrefix() + expiredText + " — the design document set has CHANGED since the review approved it"
        + "（文档已变更，续期被拒）— 涉及文档集：[" + dh.docPaths.join(", ") + "]."
        + " Re-run the design review to re-approve the current documents."
    }
    // ④ 指纹一致 → 续期：**同一 uuid** + expiresAt = now + 当前生效 TTL；内存与磁盘同步；
    //    新令牌串必须回传（旧串在下一次调用即 mismatch）。持久化失败仅告警（N2 fail-safe：
    //    内存继续服务，续期不因写盘失败而失效）。
    const fresh = renewDesignToken(state.designToken, config)
    state.designToken = fresh
    token = fresh
    const saved = saveTokenRecord(agent.session.id, {
      token: fresh,
      issuedAt: Date.now(),
      expiresAt: tokenExpiryMs(fresh),
      docHash: recHash,
      docPaths: dh.docPaths,
    }, deps.storPathOverride, agent.session?.header?.cwd)
    if (!saved) {
      warn("design token renewed in memory but FAILED to persist to the token store"
        + "——本次续期只存活于本进程（重启后需重跑设计评审）")
    }
    // 新令牌串经 warnPrefix 通道带出（F9 先例：console.warn + 随工具返回文本可见）——成功路径
    // 有多个返回点（codex 同步/后台、dsh 同步/后台），走统一前缀才**绝不丢**回执。
    warnings.push("[thincoder-suite] design token RENEWED (same uuid, new expiry " + expiryLabel(fresh)
      + ") — the design document set is unchanged, so no re-review was needed.\n"
      + "**Replace the copy you hold** — the previous token is now invalid; pass this exact token to the next eng_coder call:\n"
      + fresh)
  }

  // R3 §5.4（D-06 同步路径单飞扩展，补丁轮）：single-flight 检查提前到 eng 机制全部入口
  //（codex ≤cap 同步 / dsh 子代理路径）——同会话 eng_coder 后台 job 在飞（>cap job 或任何
  // 已占位形态）期间任何新调用被拒（R2 同款拒绝文本，含在飞 job id 与接续指引），关闭
  // 轮次/prior 双写窗口。派发点二次检查保留（下方 codex jobs 分支）：入口 → jobs.start
  // 之间的 await 窗口（effort 解析等）内仍可能被他方派发占位。
  const inFlightAtEntry = checkInFlightJob(agent.session.id, "eng")
  if (inFlightAtEntry) return warnPrefix() + inFlightAtEntry

  const agentOpts = agent.options ?? {}
  // F9：显式子代理资源——maxTokens 与 reasoningEffort 必须显式传（DSH resolveChildAgentOptions
  // 只在父级已配置时才继承 maxTokens，且不继承 effort；缺失会落适配器默认→reasoning 吞噬
  // 输出预算→text 被 max-tokens 掐断，实测见 docs/2026-09-01-advisor-config-design.md §3.10）。
  // N4 校验（§3.10、评审 #7）：engCoderMaxTokens 非法（非有限正数）→ 警告并回落默认 65536；
  // engCoderEffort 非枚举 → 警告并回落 ENG_CODER_EFFORT_DEFAULT（批 14：默认值与回落目标同源）；
  // 警告 console.warn + 随工具返回文本带出（主会话可见）。
  const cfgMax = config.engCoderMaxTokens
  let engCoderMaxTokens
  if (cfgMax === undefined || cfgMax === null) {
    // §3.10 取值优先级：engCoderMaxTokens > 父代理 maxTokens（继承）> 默认 65536
    engCoderMaxTokens = Number.isFinite(agentOpts.maxTokens) && agentOpts.maxTokens > 0
      ? agentOpts.maxTokens
      : ENG_CODER_MAX_TOKENS_DEFAULT
  } else if (typeof cfgMax === "number" && Number.isFinite(cfgMax) && cfgMax > 0) {
    engCoderMaxTokens = cfgMax
  } else {
    // 评审 #5：非法配置值回落父级有效 maxTokens（保持 §3.10 优先级链），无父级才落默认
    warn("invalid engCoderMaxTokens " + JSON.stringify(cfgMax)
      + " (expected a finite positive number) — falling back to parent maxTokens or default " + ENG_CODER_MAX_TOKENS_DEFAULT)
    engCoderMaxTokens = Number.isFinite(agentOpts.maxTokens) && agentOpts.maxTokens > 0
      ? agentOpts.maxTokens
      : ENG_CODER_MAX_TOKENS_DEFAULT
  }
  // 批 14（FR-1 / D14-1）：三处同源——初值与 else 分支的回落目标**都引用常量**，
  // 「回落 = 初值」的隐式耦合（P2）由此消除：改常量即同时改默认值与回落目标。
  let engCoderEffort = ENG_CODER_EFFORT_DEFAULT
  const effCfg = config.engCoderEffort
  if (effCfg !== undefined && effCfg !== null) {
    // 评审 #4：任何非 undefined/null 的非法值（含非字符串类型）都警告
    if (typeof effCfg === "string" && ENG_CODER_EFFORT_LEVELS.has(effCfg)) {
      engCoderEffort = effCfg
    } else {
      warn("invalid engCoderEffort " + JSON.stringify(effCfg)
        + " (expected one of off|low|medium|high|max) — falling back to \""
        + ENG_CODER_EFFORT_DEFAULT + "\"")
      engCoderEffort = ENG_CODER_EFFORT_DEFAULT   // ★ 显式赋值（不靠初始化值间接达成）
    }
  }
  // —— T2.2：codex runner 后端（codexCli.engCoderRunner === "codex-cli"）——
  // 8.4 三边界落地：① 写权限治理后移（codex 沙箱 workspace-write 限定写入范围 + 反套娃
  // 前缀 + 交付评审照常 + Touched files 对账——DSH 写门禁管不到子进程内部）；② idle 活性
  // 信号替代纯墙钟（长实现任务不误杀）；③ 验证证据 = 任务书强制验证命令/结果 + 报告留档。
  // F9 maxTokens 不适用（codex 自管预算）；effort 复用 engCoderEffort（off → 不传）。
  // D-02 L1（R1）：codex 分支 effort 走 resolveCodexRowEffort（codex models catalog）；
  // 下方 resolveSupportedEffort（dsh 侧，按父代理路由模型）只在 dsh 分支执行——
  // 消除「codex 分支跑 dsh 解析产生误导告警」的旧缺陷（登记表 D-02：eng:385/:399）。
  // R2 §4.1（D-03/D-20）：预算 > budgetCap 且 ctx.jobs 可用 → jobs 后台派发（owner 绑定
  // agent、cancel 走 ctrl.abort、run() 内全预算 + 自有 watchdog）；≤ cap 或 jobs 缺失 →
  // 同步钳制 + 响亮告警。交付簿记（轮次重置/mutatedThisRun/touched 合并 + F12 落盘）在
  // 任务完成回调的成功分支恰好一次（D-20：失败交付不销毁评审预算、不断言可能不存在的
  // 变更——partial 内 Touched 行仅 advisory 解析，D-11）。
  const cliCfg = (config.codexCli && typeof config.codexCli === "object") ? config.codexCli : {}
  if (cliCfg.engCoderRunner === "codex-cli") {
    const globalRes = resolveCodexCliGlobals(config)
    for (const warning of globalRes.warnings ?? []) warn(warning)
    const globals = globalRes.globals
    const runner = {
      kind: "codex-cli",
      model: (typeof cliCfg.model === "string" && cliCfg.model.trim() !== "") ? cliCfg.model.trim() : null,
    }
    const effRes = await resolveCodexRowEffort(deps, runner, engCoderEffort, globals)
    if (effRes.note) warn(effRes.note)
    const effRunner = { ...runner, effort: effRes.effort ?? undefined }
    // D48-1：codex 路径缺省 checkMode = "subagent"（显式传入的 host 态阶段照常被尊重——
    // 任务书标注「由宿主执行」，交付后由 runHostStageChecks 验收）。
    const codexStages = stagesWithModeDefault(stages, "subagent")
    const brief = CODEX_TASK_PREAMBLE + "\n\n" + buildCoderBrief(task, docs, codexStages)
    const cwd = agent.session?.header?.cwd || process.cwd()
    const budgetCap = resolveCodexBudgetCapMs(config)
    // 8.4：长任务默认放大 30min（值域校验对齐 adapter 常量——手编 config 垃圾值不进毫秒级误杀）
    const validBaseTimeout = Number.isInteger(cliCfg.defaultTimeoutMs) && cliCfg.defaultTimeoutMs >= 30000 && cliCfg.defaultTimeoutMs <= 3600000
    if (!validBaseTimeout && cliCfg.defaultTimeoutMs !== undefined && cliCfg.defaultTimeoutMs !== null) warn("codexCli.defaultTimeoutMs 非法，回落 1800000ms")
    const baseTimeout = validBaseTimeout ? cliCfg.defaultTimeoutMs : 1800000
    const validIdleTimeout = Number.isInteger(cliCfg.idleTimeoutMs) && cliCfg.idleTimeoutMs >= 15000 && cliCfg.idleTimeoutMs <= 3600000
    if (!validIdleTimeout && cliCfg.idleTimeoutMs !== undefined && cliCfg.idleTimeoutMs !== null) warn("codexCli.idleTimeoutMs 非法，回落 300000ms")
    const idleTimeoutMs = validIdleTimeout ? cliCfg.idleTimeoutMs : 300000

    // —— D-20 交付簿记 = 模块级 deliverBookkeeping（codex/dsh、同步/后台四路单一实现——
    // 成功分支恰好一次；R5 §7.2 抬到模块作用域，D-26-⑥ 单一事实源）。文本构建局部闭包：
    const deliveryText = (outputText) => warnPrefix() + "eng_coder delivery (codex-cli):\n" + (outputText || "(empty report)") +
      "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])."
    const failureText = (env) => {
      const partial = env.text ? "\nPartial output:\n" + env.text.slice(0, 2000) : ""
      return warnPrefix() + "eng_coder ended: codex-cli " + env.code + " — " + (env.userMessage || env.diagnostics || "unknown")
        + partial + codexFailureAdvisory(env)
    }

    // 预算 > budgetCap 或显式 background=true（R5 §7.2：长任务强制后台，无视预算）→ 派发
    if (baseTimeout > budgetCap || args?.background === true) {
      const jobs = getJobsService(deps)
      if (jobs && typeof jobs.start === "function") {
        // D-06（§4.3）：single-flight 派发前检查（复合键 sessionId+mechanism——eng 槽位）
        const sid = agent.session.id
        const inFlight = checkInFlightJob(sid, "eng")
        if (inFlight) return inFlight
        const ctrl = new AbortController()
        try {
          const started = jobs.start({
            kind: "eng-codex",
            label: "eng_coder codex (" + (runner.model ?? "default") + ", " + Math.round(baseTimeout / 1000) + "s)",
            outputLimitBytes: 131072,
            owner: ownerIdOf(agent),
            run: (handle) => {
              // 批 27 / US-5（D27-4 · A27-8）：落盘 home 探测透传会话 cwd——可选，缺省行为逐字不变
              const jobPersistOpts = { cwdHint: agent.session?.header?.cwd }
              const done = runCodexTask(deps, {
                taskText: brief,
                cwd,
                sandbox: "workspace-write", // B5：eng_coder 固定写沙箱（不透传更宽配置）
                timeoutMs: baseTimeout, // jobs 免疫平台墙钟：全预算生效（run() 内自有 watchdog）
                idleTimeoutMs,
                runner: effRunner,
                config,
                signal: ctrl.signal, // cancel → hooks.cancel → ctrl.abort
              }).then(async (env) => {
                clearInFlightJob(sid, "eng")
                if (env.ok) {
                  deliverBookkeeping(state, agent, deps, env.text)
                  // 批 9 接线点 1/4（codex 后台成功返回点）：横幅在文本**前部**，簿记语义零改动
                  // 批 26 D48-2：显式 checkMode:"host" 的阶段在宿主侧验收，回执随交付文本（与落盘同一处）
                  //（本回调因此 async 化——done 的 settled 值不变，then 链自动展平 promise）
                  const hostReceipt = await runHostStageChecks(codexStages, cwd, deps.hostCheckOpts)
                  return jobOutcome(handle, { status: "completed", detail: "eng_coder delivery", output: stageGateNote(stages, env.text) + deliveryText(env.text) + hostReceipt }, jobPersistOpts)
                }
                return jobOutcome(handle, { status: "failed", detail: "codex-cli " + env.code, output: failStop(failureText(env)) }, jobPersistOpts)
              }, (e) => {
                clearInFlightJob(sid, "eng")
                return jobOutcome(handle, {
                  status: "failed",
                  detail: String(e?.message ?? e),
                  output: failStop(warnPrefix() + "eng_coder error: " + (e?.message ?? String(e))),
                }, jobPersistOpts)
              })
              done.catch(() => { /* 观察者兜底：reject 已转为 outcome */ })
              return { cancel: (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }, done }
            },
          })
          // D-06：登记槽位（settle 时经 done 回调清除）；D-05：branded string 直接渲染；
          // D-16：budgetCapMs ≥ 600000 时附不变式提醒（共享 codexJobsDispatchReply）。
          // R6 code review 跟进：N4 配置警告（warnPrefix()）并入派发返回——advisor.mjs R4 收尾
          // #4 先例（后台派发时配置告警即时可见，此前只在 job 完成文本可见；空串时行为不变）。
          setInFlightJob(sid, "eng", started)
          return warnPrefix() + codexJobsDispatchReply({ prefix: "eng_coder (codex-cli)", jobId: started, budgetMs: baseTimeout, budgetCapMs: budgetCap, detail: runner.model ?? "codex 默认模型" })
        } catch (e) {
          console.warn("[thincoder-suite] ctx.jobs 派发失败（" + (e?.message ?? String(e)) + "）——eng_coder 回落同步执行"
            + (baseTimeout > budgetCap ? "（预算按 budgetCap 截断）" : ""))
        }
      } else {
        // jobs 缺失降级（响亮告警——绝不无声）；background=true 且预算 ≤cap 时不截断（预算本就合规）
        console.warn("[thincoder-suite] ctx.jobs 不可用——eng_coder codex "
          + (args?.background === true && baseTimeout <= budgetCap
            ? "background=true 请求后台但 jobs 缺失——回落同步执行（预算 " + baseTimeout + "ms 未超 budgetCap，不截断）"
            : "预算 " + baseTimeout + "ms 截为 " + budgetCap + "ms 同步执行")
          + "（建议装配 dsh-jobs-local + dsh-tool-jobs 走后台全预算派发）")
      }
    }

    // —— ≤ budgetCap 或 jobs 缺失/派发失败：同步执行（> cap 时钳制 + 尾部告警，绝不无声）——
    const effTimeout = Math.min(baseTimeout, budgetCap)
    const capNote = baseTimeout > budgetCap
      ? "\n[thincoder-suite] warning: eng_coder codex 预算 " + baseTimeout + "ms 超过 codexCli.budgetCapMs=" + budgetCap
        + "ms——已截断同步执行（平台 run_code 墙钟内；装配 dsh-jobs 可走后台全预算派发）"
      : ""
    try {
      const env = await runCodexTask(deps, {
        taskText: brief,
        cwd,
        sandbox: "workspace-write", // B5：eng_coder 固定写沙箱（不透传更宽配置）
        timeoutMs: effTimeout,
        idleTimeoutMs,
        runner: effRunner,
        config,
        signal,
      })
      if (env.ok) {
        deliverBookkeeping(state, agent, deps, env.text)
        // 批 9 接线点 2/4（codex 同步成功返回点）
        // 批 26 D48-2：显式 checkMode:"host" 的阶段在宿主侧验收（回执在 capNote 之后追加）
        const hostReceipt = await runHostStageChecks(codexStages, cwd, deps.hostCheckOpts)
        return stageGateNote(stages, env.text) + deliveryText(env.text) + capNote + hostReceipt
      }
      // D-20：失败交付不簿记（不重置轮次/不置 mutated/不并 touched）
      return failStop(failureText(env) + capNote)
    } catch (e) {
      if (signal?.aborted) {
        // 批 6 FR-AP5：前缀 "eng_coder aborted." 逐字保留，仅追加溯源后缀（layer settle = 宿主面信号）
        return failStop(warnPrefix() + deathLine(annotateAbort(new Error("eng_coder aborted."), signal, "settle", "caller signal abort"), signal) + capNote)
      }
      return failStop(warnPrefix() + "eng_coder error: " + (e?.message ?? String(e)) + capNote)
    }
  }

  // —— F9-2（D-02 L1）：dsh 分支 effort 按父代理路由模型校验/回落（共享 helper
  // effort-resolve.mjs；"low" 对 model-a-flash 会 UNSUPPORTED_REASONING_EFFORT 秒死——
  // 2026-09-04 eng_coder 三连败根因）。只在 dsh 分支执行（codex 分支已走 codex resolver）。 —————————————
  const effResolved = await resolveSupportedEffort(deps.ctx?.llm ?? null, agentOpts.provider, agentOpts.model, engCoderEffort)
  const engCoderEffortFinal = effResolved.effort
  if (effResolved.note) warn(effResolved.note)

  // DP-1 方案 A（R2 §4.2，已终裁）：dsh 子代理路径内部截止——await run.result 此前无界
  // 等待（600s 平台墙钟下超限被静默截断且无交付报告）。到点 abort + 响亮告警；批 21
  //（FR-1①）后长任务默认已后台——回落态请装 dsh-jobs-local + dsh-tool-jobs、改走 codex
  // runner（engCoderRunner=codex-cli + jobs 后台派发）或拆分 stages。
  const budgetCap = resolveCodexBudgetCapMs(config)
  // 批 26 / D48-1：dsh 路径缺省 checkMode = "host"——验证门归位到宿主（D-48 根因：dsh 子代理
  // 执行子进程起跑即挂死）。任务书渲染（background/同步两处）与宿主验收回执都用这份生效阶段表。
  const dshStages = stagesWithModeDefault(stages, "host")
  // 批 29 / US-1（D29-1，设计 §2.1①）：工具面禁执行——**只挑平台注册面里在册的**执行类工具名追加
  // 进既有 deny 基线；取不到平台工具名清单 ⇒ 该腿**如实标注「未生效」**（A29-2），绝不凭猜下发
  // （未注册名会被平台响亮拒绝 ⇒ 直接打断派发）。「过滤后是否真跑不了」本机无法自验——如实登记。
  const denyPlan = resolveExecToolDeny(deps.ctx)
  if (!denyPlan.applied && !execDenyWarnLatched(deps.ctx)) {
    console.warn("[thincoder-suite] eng_coder 工具面禁执行未生效：" + denyPlan.reason + "——本次照常派发（不假装拦住）")
  }
  // 批 21（FR-3 / D-32-6）：dsh 回落告警的返回文本通道（与 console.warn 双通道；详见下方
  // 回落分支注释）。空串 ⇒ 无回落 ⇒ 所有返回点行为逐字节不变。
  let dshFallbackNote = ""
  const fallbackSuffix = () => (dshFallbackNote ? "\n\n" + dshFallbackNote : "")
  // 批 21（FR-1① / D21-1）：三态判定——省略 ⇒ 派后台 job（新默认：与同插件 codex 后端
  // 按预算默认后台的既有现实拉齐，免 540s 内部截止掐断与平台 600s 墙钟连报告一起丢）；
  // 显式 false ⇒ 强制同步快路径（DP-1 方案 A 保留，短任务逃生口）；非布尔且非 false ⇒
  // 仍后台（fail-safe 到新默认，N-9/AC-15）。codex 行判定（上方 === true）不动——零漂移（AC-6）。
  if (args?.background !== false) {
    const jobs = getJobsService(deps)
    if (jobs && typeof jobs.start === "function") {
      const sid = agent.session.id
      const inFlight = checkInFlightJob(sid, "eng")
      if (inFlight) return inFlight
      const ctrl = new AbortController()
      const backstopMs = resolveDshBackgroundTimeoutMs(config)
      let settled = false
      let slotReady = false
      const settle = () => { settled = true; if (slotReady) clearInFlightJob(sid, "eng") }
      try {
        const started = jobs.start({
          kind: "eng-dsh",
          label: "eng_coder dsh (background)",
          outputLimitBytes: 131072,
          owner: ownerIdOf(agent),
          run: (handle) => {
            // 批 27 / US-5（D27-4 · A27-8）：落盘 home 探测透传会话 cwd——可选，缺省行为逐字不变
            const jobPersistOpts = { cwdHint: agent.session?.header?.cwd }
            let timer = null
            let timedOut = false
            // ————— 批 29 / US-1（D29-2 · D29-6）：静默看门狗（轮询与到点判定住叶子模块）—————
            // 本文件**零新增** setTimeout 字面（下方两处 setTimeout 与第二实参一字未动）·
            // **零新增中止写点**（到点由下方**既有**取消写点执行中止，不新造中止闭包）。
            let silentMs = null
            const silence = resolveEngSilenceAbortMs(config)
            if (silence.warning) warn(silence.warning)
            // D9（分歧审计 #3）：**订阅型方法存在 ≠ 真会发事件**。看门狗**创建时不武装**——只有真收到
            // 至少一次心跳（真实事件 / 句柄事件方法被调用）才武装；零事件 ⇒ 到点也不中止，退回总预算
            // `dshBackgroundTimeoutMs`（宁可晚掐，也**不误杀**一个正在正常输出的子代理）。
            const watchdog = createSilenceWatchdog({ abortMs: silence.ms, armed: false, ...(deps.silenceWatchdogOpts ?? {}) })
            // 既有取消写点的**具名化**：宿主 job_kill 与看门狗到点共用**同一个**写点——中止写点计数
            // 因此不增不减（仍为 5）；宿主 kill 行为逐字不变（同名同体，只是换了个绑定）。
            const cancelJob = (reason) => { try { ctrl.abort(reason) } catch { /* noop */ } }
            watchdog.onSilence((info) => {
              silentMs = (info && typeof info.silentMs === "number") ? info.silentMs : silence.ms
              console.warn("[thincoder-suite] eng_coder dsh 后台子代理疑似挂死（静默 " + silenceMinutesLabel(silentMs)
                + " 分钟）——由既有取消写点 abort 子代理（engSilenceAbortMs=" + silence.ms + "ms）")
              cancelJob(timeoutError("eng_coder dsh subagent silence watchdog deadline reached", "agent", "engSilenceAbortMs"))
            })
            // 静默终止信封：**沿用 FAILURE_OPTIONS_BLOCK 常量**（不新造 wrapper ⇒ 失败后缀 wrapper 计数恒 18）
            const silenceEnvelope = (text) => warnPrefix()
              + "eng_coder ended: dsh 后台子代理疑似挂死（静默 " + silenceMinutesLabel(silentMs) + " 分钟）到点，子代理已 abort（engSilenceAbortMs=" + silence.ms + "ms）"
              + "\nPartial output:\n" + String(text ?? "").slice(0, 2000)
              + codexFailureAdvisory({ text: String(text ?? ""), code: "ABORTED" })
              + stageCheckCommandsBlock(stages) + DSH_SANDBOX_FORENSICS + "\n" + FAILURE_OPTIONS_BLOCK
            // D9：**唯一**心跳回调（不得有第二份副本）——看门狗的 `heartbeat()` 同时完成「武装」与
            // 「续命」，故首次真实事件到达前它保持不武装（订阅面在 ≠ 会发事件）。
            const beat = () => watchdog.heartbeat()
            // 句柄心跳装饰（handle.append / updateProgress 亦是心跳源；读语义与写语义不变）。
            // ★ 参数**就地重绑**（而非改名）：本文件 12 处 jobOutcome(handle, …) 调用点因此逐字不动——
            //   platform 契约锁 ps3「jobOutcome(handle, …) 至少 1 处」与 D-46 输出环契约都零改动。
            handle = watchJobHandle(handle, beat)
            if (Number.isFinite(backstopMs) && backstopMs > 0) {
              timer = setTimeout(() => {
                timedOut = true
                console.warn("[thincoder-suite] eng_coder dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")——abort 子代理")
                try { ctrl.abort(timeoutError("eng dsh background backstop deadline reached", "agent", "dshBackgroundTimeoutMs")) } catch { /* noop */ }
              }, backstopMs)
              timer.unref?.()
            }
            const done = (async () => {
              let sub
              try {
                if (!ctx?.subagents || typeof ctx.subagents.start !== "function") {
                  return jobOutcome(handle, { status: "failed", detail: "ctx.subagents unavailable", output: failStop(warnPrefix() + "eng_coder failed: ctx.subagents is unavailable inside background job (cannot recover after dispatch)") }, jobPersistOpts)
                }
                sub = await ctx.subagents.start("spawn", {
                  prompt: [{ type: "text", text: buildCoderBrief(task, docs, dshStages) }], parent: agent, signal: ctrl.signal,
                  persona: ENG_CODER_PERSONA, label: "eng-coder",
                  agentOptions: { provider: agentOpts.provider, model: agentOpts.model, maxTokens: engCoderMaxTokens,
                    ...(engCoderEffortFinal !== null ? { reasoningEffort: engCoderEffortFinal } : {}) },
                  toolFilter: { deny: denyPlan.deny },
                })
                // 批 29 / US-1（D29-6 · 设计 §2.1②）：心跳 = 作业 run() 内**对子代理运行事件的观察**。
                // 取不到事件流 ⇒ **如实标注「静默看门狗未生效」**（裸 console.warn——不进 warnPrefix
                // 返回文本，stages.test.mjs T12 锁「干净路径零 warning 前缀」）并退回总预算。
                const hb = attachRunHeartbeat(sub, beat)
                if (!hb.attached) {
                  watchdog.dispose()
                  console.warn("[thincoder-suite] eng_coder 静默看门狗未生效：取不到子代理事件流（run 无事件面）——本作业退回总预算 dshBackgroundTimeoutMs=" + backstopMs + "ms")
                }
                if (denyPlan.applied) {
                  const ev = execDenyEvidence(sub)
                  console.warn("[thincoder-suite] eng_coder 工具面禁执行已下发（deny 追加 " + denyPlan.execNames.join(", ")
                    + "）——证据口径：" + (ev.evidence === "platform-echo"
                      ? "平台回显生效清单（强证）"
                      : "派发载荷 toolFilter.deny（弱证：平台未回显生效清单）"))
                }
                const result = await sub.result
                const outputText = (result?.output ?? []).filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()
                // 批 29 / US-1：静默到点的终止分支（在既有兜底分支**之前**——两者文案归属不同）
                if (silentMs !== null) return jobOutcome(handle, { status: "failed", detail: "silence watchdog (engSilenceAbortMs)", output: silenceEnvelope(outputText) }, jobPersistOpts)
                if (timedOut) return jobOutcome(handle, { status: "failed", detail: "dshBackgroundTimeoutMs backstop", output: failStop(warnPrefix() + "eng_coder ended: dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")到点，子代理已 abort—— Partial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: "ABORTED" })) + stageCheckCommandsBlock(stages) + DSH_SANDBOX_FORENSICS }, jobPersistOpts)
                const stopReason = result?.stopReason ?? "unknown"
                if (stopReason !== "completed") return jobOutcome(handle, { status: "failed", detail: stopReason, output: failStop(warnPrefix() + "eng_coder ended: " + stopReason + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null })) }, jobPersistOpts)
                deliverBookkeeping(state, agent, deps, outputText)
                // 批 9 接线点 3/4（dsh 后台成功返回点）
                // 批 26 D48-2：dsh 路径缺省 host 态阶段在宿主侧验收；回执随交付文本（jobOutcome 落盘同一处）
                const hostReceipt = await runHostStageChecks(dshStages, agent.session?.header?.cwd, deps.hostCheckOpts)
                return jobOutcome(handle, { status: "completed", detail: "eng_coder delivery", output: stageGateNote(stages, outputText) + warnPrefix() + "eng_coder delivery:\n" + (outputText || "(empty report)") + "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])." + hostReceipt }, jobPersistOpts)
              } catch (e) {
                // R6 code review 跟进：reject-race 分支（sub.result 以 reject 结束 → await 抛出落
                // catch，而非 resolve 落上方 if(timedOut) 兜底信封）同带 ABORTED 回滚指引——与
                // resolve-race 分支和 escalate timeoutEnvelope("") 先例对称；catch 作用域无
                // outputText → 空串形态（escalate.mjs 同款）。
                // 批 29 / US-1：静默到点（abort → reject）分支——文案 = 疑似挂死 + 静默时长；reject 形态
                // 拿不到 outputText（与既有 ABORTED 兜底信封同款：partial 记为「无」），这里如实照此。
                if (silentMs !== null) return jobOutcome(handle, { status: "failed", detail: "silence watchdog (engSilenceAbortMs)", output: silenceEnvelope("") }, jobPersistOpts)
                if (timedOut) return jobOutcome(handle, { status: "failed", detail: "dshBackgroundTimeoutMs backstop", output: failStop(warnPrefix() + "eng_coder ended: dsh 后台子代理超兜底截止（dshBackgroundTimeoutMs=" + backstopMs + ")到点，子代理已 abort—— ABORTED" + codexFailureAdvisory({ text: "", code: "ABORTED" })) + stageCheckCommandsBlock(stages) + DSH_SANDBOX_FORENSICS }, jobPersistOpts)
                if (ctrl.signal.aborted || e?.name === "AbortError") {
                  // 批 6 FR-AP5/FR-AP6：detail 由纯丢失形态 "aborted" 换成机器短标签（D-AP6）；
                  // output 前缀逐字保留 + 溯源后缀。
                  // 批 6 修复轮（审计 #3 / D-AP3 + §5.1 图 1 W2）：本控制器另一写者是**宿主 job kill**
                  //（cancel 回调，reason 未打标）——该面归 `cancel@settle`，不是 `unknown@agent`。
                  const hostSrc = hostAbortSource(ctrl.signal)
                  const src = hostSrc ?? (ctrl.signal.aborted ? ctrl.signal : e)
                  const layer = hostSrc ? hostSrc.abortInfo.layer : "agent"
                  return jobOutcome(handle, {
                    status: "failed",
                    detail: abortTag(hostSrc ?? e, ctrl.signal, "agent") ?? "aborted",
                    output: failStop(warnPrefix() + deathLine(annotateAbort(new Error("eng_coder aborted."), src, layer, "dsh subagent abort"), src)),
                  }, jobPersistOpts)
                }
                return jobOutcome(handle, { status: "failed", detail: String(e?.message ?? e), output: failStop(warnPrefix() + "eng_coder failed: " + (e?.message ?? String(e))) }, jobPersistOpts)
              } finally {
                if (timer) clearTimeout(timer)
                watchdog.dispose()
                settle()
                try { if (sub) await sub.dispose() } catch { /* noop */ }
              }
            })()
            done.catch(() => {})
            return { cancel: cancelJob, done }
          },
        })
        setInFlightJob(sid, "eng", started)
        slotReady = true
        if (settled) clearInFlightJob(sid, "eng")
        // D-30 批 2 代码评审 #1：与同文件 codex 后台路径（上方 jobs 分支 :602）对齐——
        // warnPrefix() 并入选派返回。续期回执（含**新令牌串**）与 effort/配置告警都在 warnings[]
        // 里，不带前缀则该返回点上它们只能等 job 完成通知才可见，而调用方此刻手里握的是已失效旧串
        // （FR-T5 返回契约「必须把新串交回调用方」在此返回点落空）。
        return warnPrefix() + jobsDispatchReply({ prefix: "eng_coder", jobId: started, budgetMs: backstopMs, detail: "dsh 子代理后台执行（挂死兜底 dshBackgroundTimeoutMs）" })
      } catch (e) {
        // 批 21（FR-3 / D-32-6）：回落告警双通道——console.warn（既有字面，逐字节不变）+
        // 工具返回文本（本批新增；此前只 console ⇒ 翻转后默认走后台，父代理会以为派了后台、
        // 傻等一个不会来的通知 = 静默失败）。不并入 warnings[]/warnPrefix 前缀通道：死亡文案
        // 前缀与门横幅的「首段」锁（death-provenance T-AP2 / stage-gate T-SG5 零改档）要求返回
        // 文本开头不被改写 ⇒ 以尾部后缀并入下方同步路径的全部返回点（advisor「回落 note 是
        // 后缀」先例同形）。行为仍是回落同步（D-32-5 硬约束）。
        dshFallbackNote = "[thincoder-suite] ctx.jobs 派发失败（" + (e?.message ?? String(e)) + "）——eng_coder background=true 回落同步执行（budgetCap 内部截止）"
        console.warn(dshFallbackNote)
      }
    } else {
      dshFallbackNote = "[thincoder-suite] ctx.jobs 不可用——eng_coder background=true 回落同步执行（budgetCap 内部截止）"
      console.warn(dshFallbackNote)
    }
  }
  // —— 批 14（FR-4 / D14-6）：**配错之前被提醒** ——
  // 落点 = **dsh 同步路径、spawn 前**。**仅同步路径**：批 21（FR-1①）后省略/`true` 且 jobs
  // 可用时已在上方 return（后台无平台墙钟问题 ⇒ 告警即错告），落到这里是显式 `false` 或
  // 「后台派发失败/不可用 ⇒ 回落同步执行」——此处的截止**确实**是内部 budgetCap，故仍属同步路径。
  // **不得引入 failStop 调用**（`lib/eng.mjs` 的 `failStop` 计数锁恒 18 = 1 处定义 + 17 个挂点
  // + `:372-375` 的 PREFLIGHT 禁 spawn 前挂 wrapper）：
  // 本告警 fail-open——只 warn、不改任何返回路径（见 §6.3 的 @post）。
  // 批 29 / US-4 🔵(b)：**静默看门狗只装在上方的后台路径**（`lib/silence-watchdog.mjs`）——
  // 本文件的定时器时长/条件字面受 T-AP7(c) 逐字冻结，同步路径不得再引入第二类轮询定时器
  // ⇒ 这里**故意不装**看门狗：同步快速路径的「卡住」由下方内部截止（`codexCli.budgetCapMs`）
  // 兜底。这不是遗漏，是既有的结构边界（与 D29-6「看门狗住叶子模块」同一条纪律）。
  if (budgetCap >= PLATFORM_RUN_CODE_WALL_MS) {
    warn("eng_coder dsh 同步路径的内部截止取自 codexCli.budgetCapMs=" + budgetCap
      + "ms；该值已达或超过平台单次调用墙钟 " + PLATFORM_RUN_CODE_WALL_MS + "ms —— "
      + "插件读不到平台的 maxWallMs，故无法代为校验；长任务请传 background=true 或拆分 stages"
      // 批 26 搭车①（A26-5）：显式 background=false 指定了同步快路径 ⇒ 墙钟截断是必然而非风险
      // ——文案直接点明「本路会白等」（US-5：同步派发的墙钟陷阱在派发时说清）。
      + (args?.background === false
        ? "；background=false 指定的本路会白等——超过平台墙钟的预算部分注定被截断"
        : ""))
  }
  const dshCtrl = new AbortController()
  let dshTimedOut = false
  const dshTimer = setTimeout(() => {
    dshTimedOut = true
    console.warn("[thincoder-suite] eng_coder dsh 子代理路径超内部截止（内部截止值取自 codexCli.budgetCapMs=" + budgetCap
      + "）——abort 子代理（dsh 路径受平台墙钟约束；如需长任务请走 codex runner 或拆分 stages）")
    try { dshCtrl.abort(timeoutError("eng_coder dsh subagent deadline reached", "agent", "budgetCapMs")) } catch { /* already aborted */ }
  }, budgetCap)
  dshTimer.unref?.()
  // 批 6 FR-AP5：中继写点补 reason（只加载荷，不改触发条件/时长）——layer agent（我方中继），
  // trigger 由父信号可读到的因决定（读不到 → 显式 unknown）。
  const forwardSignal = () => { try { dshCtrl.abort(abortError(signal, "agent", "parent signal relayed")) } catch { /* already aborted */ } }
  if (signal) {
    if (signal.aborted) forwardSignal()
    else signal.addEventListener("abort", forwardSignal, { once: true })
  }

  let run
  try {
    run = await ctx.subagents.start("spawn", {
      // F13：有 stages 时渲染 Staged execution 块（缺省 → 现行 brief，逐字节不变）
      prompt: [{ type: "text", text: buildCoderBrief(task, docs, dshStages) }],
      parent: agent,
      signal: dshCtrl.signal, // 截止 + 父级 abort 二合一（父 signal 经 forwardSignal 汇入）
      persona: ENG_CODER_PERSONA,
      label: "eng-coder",
      agentOptions: {
        provider: agentOpts.provider,
        model: agentOpts.model,
        maxTokens: engCoderMaxTokens,
        // F9-2：engCoderEffortFinal=null 表示模型不支持该档——不传（用提供方默认）
        ...(engCoderEffortFinal !== null ? { reasoningEffort: engCoderEffortFinal } : {}),
      },
      // F9：实现者子代理不打断用户（确认 UI 按 agent 路由，主会话无感会死等）
      toolFilter: { deny: denyPlan.deny },
    })
  } catch (e) {
    clearTimeout(dshTimer)
    return failStop(warnPrefix() + "eng_coder failed to start: " + (e?.message ?? String(e))) + fallbackSuffix()
  }

  let result
  try {
    result = await run.result
  } catch (e) {
    if (dshTimedOut) {
      return failStop(warnPrefix() + "eng_coder ended: dsh 子代理路径超内部截止（内部截止值取自 codexCli.budgetCapMs=" + budgetCap
        + "）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。") + fallbackSuffix()
    }
    if (signal?.aborted || e?.name === "AbortError") {
      // 批 6 FR-AP5：归因源优先级——dshCtrl（我方：budgetCap 截止 / 父信号中继）→ 调用方信号 → 错误
      const src = dshCtrl.signal.aborted ? dshCtrl.signal : (signal?.aborted ? signal : e)
      const layer = dshCtrl.signal.aborted ? "agent" : (signal?.aborted ? "settle" : "agent")
      // 批 21（FR-3）注：本返回点（abort 家族）**不带** fallbackSuffix——SITES 针
      // （doc-hygiene T4）锁 `…src))\n    }` 行形、T-AP2 锁返回首段 = 死亡文案 ⇒ 双侧
      // 封死；console.warn 通道照发，且本形态是终态失败（父代理不会等通知 ⇒ 无「傻等」
      // 风险面）。其余五个同步返回点 + 成功点均带后缀。
      return failStop(warnPrefix() + deathLine(annotateAbort(new Error("eng_coder aborted."), src, layer, "dsh subagent abort"), src))
    }
    return failStop(warnPrefix() + "eng_coder error: " + (e?.message ?? String(e))) + fallbackSuffix()
  } finally {
    clearTimeout(dshTimer)
    try { await run.dispose() } catch { /* already disposed */ }
  }

  const outputText = (result?.output ?? [])
    .filter(b => b?.type === "text").map(b => b.text ?? "").join("\n").trim()
  const stopReason = result?.stopReason ?? "unknown"

  if (dshTimedOut) {
    // D-20：截止 abort = 失败交付——不簿记（不重置轮次/不置 mutated/不并 touched）
    return failStop(warnPrefix() + "eng_coder ended: dsh 子代理路径超内部截止（内部截止值取自 codexCli.budgetCapMs=" + budgetCap
      + "）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。"
      + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null })) + fallbackSuffix()
  }

  if (stopReason !== "completed") {
    // D-20（R2 §4.1）：失败交付不簿记（不重置轮次/不置 mutated/不并 touched——与 codex 路径
    // 同语义）；partial 内 Touched 行仅 advisory 解析（不并入审计范围）
    const diag = result?.diagnostic ? " — " + result.diagnostic : ""
    return failStop(warnPrefix() + "eng_coder ended: " + stopReason + diag
      + "\nPartial output:\n" + outputText.slice(0, 2000) + codexFailureAdvisory({ text: outputText, code: null })) + fallbackSuffix()
  }

  deliverBookkeeping(state, agent, deps, outputText)

  // 批 9 接线点 4/4（dsh 同步成功返回点 / 主返回点）
  // 批 26 D48-2：dsh 路径缺省 host 态阶段在宿主侧验收（同步路径无落盘文件，回执只进交付报告）
  const hostReceipt = await runHostStageChecks(dshStages, agent.session?.header?.cwd, deps.hostCheckOpts)
  return stageGateNote(stages, outputText) + warnPrefix() + "eng_coder delivery:\n" + (outputText || "(empty report)") +
    "\n\nNext (automatic flow nodes): verify the delivery against the acceptance criteria, run the divergence audit if this is the FIRST delivery, then run advisor(type='code', documents=[Docs involved])." + hostReceipt + fallbackSuffix()
}
