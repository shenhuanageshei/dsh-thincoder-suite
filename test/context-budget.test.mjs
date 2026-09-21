// context-budget.test.mjs — 批 5 回归锁（docs/2026-09-13-context-budget-design.md §10.3）。
// T-CB1…T-CB10 逐条映射 AC-CB1…AC-CB9（T-CB9 = §5.5 设置页静态锁，T-CB10 = AC-CB4 的
// 生产路径 CJK 判据）。零网络 / 零真实 LLM（deps.llm.stream 桩）/ 零长等待。
//
// 夹具算术（设计 §8.2，独立复算——不复用生产代码）：
//   firstUserText = 786432 个 ASCII 字符（= 12 × 65536，与 MAX_RESULT_CHARS 同量纲）
//   被测串 = JSON.stringify(m.content ?? [])，content = [{ type:"text", text }]（生产 userMsg 形状）
//   JSON 包装开销 = 27 字符（`[{"type":"text","text":""}]`）→ 串长 786459 → 估算 ceil(786459/4) = 196615
//   （设计 §8.2 记「786432 / 4 = 196608」——那是**纯字符串**口径，不含 JSON 包装。本档以实测口径
//    钉死（196615），差值 7 tokens，两侧判死语义零影响：均为 196615 > 兜底判死 104857。）
//   消息总数 ≤ 20 ⇒ compactMessages 必然早退（其第一条守卫 `messages.length <= 20` 即 return）
//   ⇒ 三行矩阵不依赖压缩行为，可确定复现。
//
// T-CB10（分歧审计 🔴 #1 的修复）：CJK 判据必须**走生产路径**。T-CB4 的 CJK 断言全部打在
//   本档的本地复算副本（newEstimate/legacyEstimate）上，对生产 `estimateTokens` 的 CJK 权重
//   没有任何证据锁——权重被改成任何 ≠1 的值，既有断言仍可全绿。T-CB10 用生产循环入口
//   （runAdvisorToolLoop）+ CJK 夹具 + 逐字尾行 N 补齐该缺口（算式见 T-CB10 节注释）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import {
  advisorContextBudget, isValidAdvisorContextTokens, resolveAdvisorContextTokens,
  resolveAdvisorContextWindow, runAdvisorToolLoop, runAdvisorReview,
  CONTEXT_FALLBACK_WINDOW_TOKENS, CONTEXT_LIMIT_RATIO, COMPACT_TRIGGER_RATIO,
  ADVISOR_CONTEXT_TOKENS_MIN, ADVISOR_CONTEXT_TOKENS_MAX,
} from "../lib/advisor.mjs"
import { mergeGlobalConfig, effectiveGlobalConfig } from "../lib/config-store.mjs"
import { validateGlobalUserConfig } from "../lib/index.mjs"
import { buildAdvisorUserMessage } from "../lib/advisor-msgs.mjs"
import { dropSession } from "../lib/state.mjs"

// ————————————— 批 22 / D-39：信任栅栏的测试缝 —————————————
// `makeApiHandler` 的 handler 现在**无条件**先问宿主 `ctx.get("connection")` 要拒绝码
// （服务取不到 = 503 fail-closed ⇒ 空 ctx 直调会全变 503）。直调用例必须**显式**声明
// 「本请求被放行」——放行是白纸黑字，不是靠门缺席。这正是本批的纪律：安全默认不迁就夹具。
/** 放行 / 拒绝两态 stub：`undefined` = 放行；401 / 403 = 宿主拒绝码。 */
const fenceCtx = (rejection = undefined) => ({
  get: (name) => (name === "connection" ? { requestRejection: () => rejection } : undefined),
})

process.env.DSH_HOME = ""

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// ————————————— 夹具与独立复算辅助 —————————————

/** 12 × 65536 个 ASCII 字符（设计 §8.2 钉死的单条夹具）。物化为单字符串实例（多次使用零重分配）。 */
const BIG_ASCII = "A".repeat(786432)

/** 生产侧被测串 = JSON.stringify(m.content ?? [])；此处独立重建同形状（不复用生产 helper）。 */
const contentJson = (text, type) => JSON.stringify([{ type: type || "text", text }])

/** 旧式估算（HEAD 版公式的独立复算函数）——纯 ASCII 下新式必须与之逐值相等（N-2 / §8.3）。 */
const legacyEstimate = (s) => Math.ceil(s.length / 4)

/** 新式公式的独立复算（ASCII ceil(len/4) + 非 ASCII 逐码元）。 */
function newEstimate(s) {
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) nonAscii++
  return Math.ceil((s.length - nonAscii) / 4) + nonAscii
}

const FIXTURE_CHARS = 786432
const FIXTURE_JSON_LEN = contentJson(BIG_ASCII).length            // 786459（独立实测，见文件头）
const FIXTURE_ESTIMATE = newEstimate(contentJson(BIG_ASCII))     // 196615

/** 设计 §8.2 的纯字符串口径（786432 / 4）——仅用于「实测 vs 设计算术」的事实登记断言。 */
const DESIGN_ARITHMETIC_ESTIMATE = 786432 / 4

/** 判死尾文案（逐字——协议面零改，§8.1）。 */
const deathLine = (n) => "Advisor: context window limit reached (" + n
  + " tokens). Review incomplete — too many tool calls. Try a narrower scope."

/** 尾块：finalize 之后的机制后缀（note / warning）全部剥掉，只留评审正文本身。 */
const coreTail = (out) => String(out).split("\n\n[thincoder-suite]")[0].trim()
const tailLine = (out) => coreTail(out).split("\n").filter((l) => l.trim() !== "").pop()

/** llm 桩：stream 收集 opts；resolveModelInfo 按注入行返回（缺失 = 无该方法）。 */
function makeLoopLlm(opts = {}) {
  const calls = []
  const llm = {
    stream(streamOpts) {
      calls.push(streamOpts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "REVIEW-BODY" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
    calls,
  }
  if (opts.info) llm.resolveModelInfo = async () => opts.info
  return llm
}

async function captureWarn(fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try { return { value: await fn(), warnings } } finally { console.warn = orig }
}

/** runAdvisorReview 精简入口（codex-runner.test.mjs 的 runDshReview 同形）。
 *  includeProjectGuide=false：评审只吃显式 documents=（不注入 AGENTS.md 项目记忆）——
 *  夹具才是「单条 user 消息 = firstUserText」的确定形态（否则评审轮会话的 messages 会被
 *  注入路径加长，夹具算术失真）。 */
async function runReview(sid, llm, config, documents) {
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  return runAdvisorReview(
    { llm },
    {
      agent, config: { ...config, advisor: { ...config.advisor, includeProjectGuide: false } },
      reviewType: "code", paths: [], documents: documents ?? [], signal: undefined, configDefaultEngineering: false,
    },
  )
}

/** loop 直调 opts（timeoutMs 用秒级小值，零长等待）。 */
const loopOpts = (extra = {}) => ({
  provider: "p", model: "m", system: "sys", firstUserText: BIG_ASCII,
  cwd: PLUGIN_DIR, signal: undefined, sessionId: "cb-loop", timeoutMs: 5000,
  ...extra,
})

const cfgOf = (advisor) => ({ advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 }, ...advisor } })

// ————————————— T-CB1 → AC-CB1：预算派生逐值（§5.2 表六组 + 非法入参） —————————————

test("T-CB1: advisorContextBudget — §5.2 六组逐值 + 非法入参不抛且落兜底派生", () => {
  const table = [
    [131072, 104857, 83885],     // 兜底窗
    [200000, 160000, 128000],
    [262144, 209715, 167772],
    [1000000, 800000, 640000],
    [1024000, 819200, 655360],
    [1048576, 838860, 671088],
  ]
  for (const [w, limit, compactAt] of table) {
    assert.deepEqual(advisorContextBudget(w), { limit, compactAt, window: w }, "window " + w)
    // 两档独立复算（两次 floor 口径，§5.2 浮点口径钉死）
    assert.equal(limit, Math.floor(w * CONTEXT_LIMIT_RATIO), "limit = floor(w × 0.8)")
    assert.equal(compactAt, Math.floor(limit * COMPACT_TRIGGER_RATIO), "compactAt = floor(limit × 0.8)")
  }
  // 设计钉死「两次 floor」（与 floor(w × 0.64) 在 131072 上差 1 token）
  assert.equal(advisorContextBudget(131072).compactAt, 83885)
  assert.notEqual(advisorContextBudget(131072).compactAt, Math.floor(131072 * 0.64))
  // 非法入参：不抛、落兜底窗派生
  for (const bad of [NaN, -5, 0, undefined, null, "131072", {}, Infinity, -Infinity]) {
    let r
    assert.doesNotThrow(() => { r = advisorContextBudget(bad) }, String(bad))
    assert.deepEqual(r, { limit: 104857, compactAt: 83885, window: CONTEXT_FALLBACK_WINDOW_TOKENS }, String(bad))
  }
  // 纯函数：重复调用同值、入参零突变
  assert.deepEqual(advisorContextBudget(1000000), advisorContextBudget(1000000))
  // 常量口径
  assert.equal(CONTEXT_FALLBACK_WINDOW_TOKENS, 131072)
  assert.equal(CONTEXT_LIMIT_RATIO, 0.8)
  assert.equal(COMPACT_TRIGGER_RATIO, 0.8)
  assert.equal(ADVISOR_CONTEXT_TOKENS_MIN, 16384)
  assert.equal(ADVISOR_CONTEXT_TOKENS_MAX, 4194304)
  // 手配值校验器（FR-CB5 单一事实源）
  for (const ok of [16384, 131072, 1000000, 4194304]) assert.equal(isValidAdvisorContextTokens(ok), true, String(ok))
  for (const bad of [16383, 4194305, 1.5, "131072", NaN, Infinity, null, undefined, true, {}]) {
    assert.equal(isValidAdvisorContextTokens(bad), false, JSON.stringify(bad))
  }
})

// ————————————— 夹具自洽（AC-CB2/AC-CB3 的前提，可失败断言） —————————————

test("T-CB2/T-CB3 夹具前提: 单条 786432 ASCII 字符 ⇒ 估算 196615（> 兜底判死 104857）；实测 vs 设计算术登记", () => {
  assert.equal(BIG_ASCII.length, FIXTURE_CHARS)
  assert.equal(FIXTURE_JSON_LEN, 786459, "JSON 包装 = 27 字符（生产 userMsg content 形状）")
  assert.equal(legacyEstimate(contentJson(BIG_ASCII)), FIXTURE_ESTIMATE, "纯 ASCII：旧式独立复算 = 新式（零回归）")
  assert.equal(FIXTURE_ESTIMATE, 196615)
  assert.ok(FIXTURE_ESTIMATE > advisorContextBudget(CONTEXT_FALLBACK_WINDOW_TOKENS).limit,
    "夹具必须越过兜底判死线（104857）")
  // 设计 §8.2 的纯字符串口径（786432/4 = 196608）——登记差值，不掩盖
  assert.equal(DESIGN_ARITHMETIC_ESTIMATE, 196608)
})

// ————————————— T-CB2 → AC-CB2：1M 手配窗 + 同夹具 → 不判死、正常收尾 —————————————
// 夹具注入面 = runAdvisorToolLoop 的 firstUserText（设计 §8.2 的夹具本体口径：
// firstUserText = 786432 个 ASCII 字符；runAdvisorReview 的 userText 是提示词模板产物，
// 不含夹具——故正反两面均以循环入口为准，与 §8.2 三行矩阵同缝）。

test("T-CB2: contextTokens=1_000_000 + 同夹具 → 不判死、正常收尾（缺陷闭合）", async () => {
  const llm = makeLoopLlm()
  const out = await runAdvisorToolLoop({ llm }, loopOpts({ contextTokens: 1000000 }))
  assert.equal(out, "REVIEW-BODY", "评审正常收尾（正文在位、无失败前缀）")
  assert.ok(!out.includes("context window limit reached"), "不判死: " + out.slice(0, 160))
  assert.ok(!out.startsWith("Advisor:"), "completed 判定契约（零失败前缀）")
  assert.equal(llm.calls.length, 1, "LLM 确实被调用（未在判死分支提前返回）")
  // 对照复算：1M 窗派生两档均远大于夹具估算
  const b = advisorContextBudget(1000000)
  assert.ok(FIXTURE_ESTIMATE < b.compactAt, "夹具估算 < 压缩触发（连压缩都不触发）")
  assert.ok(FIXTURE_ESTIMATE < b.limit)
})

// ————————————— T-CB3 → AC-CB3：兜底窗同夹具判死（尾行逐字）+ 旧帽复现 —————————————

test("T-CB3: 兜底窗 131072 + 同夹具 → 判死，尾行逐字；contextTokens=150000（旧 120K 帽）同夹具亦判死", async () => {
  // 面 1：兜底窗 131072 + 同夹具 → 判死，尾行逐字（= 设计 §8.2 第三行「文案逐字同 HEAD」）
  const llm1 = makeLoopLlm()
  const out1 = await runAdvisorToolLoop({ llm: llm1 }, loopOpts({ contextTokens: 131072 }))
  assert.equal(out1, deathLine(FIXTURE_ESTIMATE), "尾行逐字（判死时返回即该行本身）")
  assert.equal(llm1.calls.length, 0, "判死在任何 LLM 调用之前（与 HEAD 同结构）")

  // 面 2：旧帽复现——旧行为现在只是「一个窗口取值」：limit = floor(150000 × 0.8) = 120000 = 旧写死帽
  const llm2 = makeLoopLlm()
  const out2 = await runAdvisorToolLoop({ llm: llm2 }, loopOpts({ contextTokens: 150000 }))
  assert.equal(advisorContextBudget(150000).limit, 120000, "旧 120K 写死帽 = 150K 窗口的派生值")
  assert.equal(advisorContextBudget(120000).limit, 96000, "旧上下文：120K 帽的派生判死线 = 96000（对照）")
  assert.equal(out2, deathLine(FIXTURE_ESTIMATE), "旧帽同夹具同样判死（夹具越线是两版共有事实）")
})

// ————————————— T-CB2/T-CB3 生产接线面（runAdvisorReview 双面翻转，AC-CB2/AC-CB3 端到端） —————————————

/** runAdvisorReview 夹具：llm.stream 桩 + 可注入 resolveModelInfo。 */
function makeReviewLlm(infoFn) {
  const calls = []
  const provArgs = []
  const llm = {
    stream(o) {
      calls.push(o)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "| # | Action | Detail |\n|---|---|---|\n| 1 | x | y |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
    calls,
    provArgs,
  }
  if (infoFn) llm.resolveModelInfo = async (p, m) => { provArgs.push([p, m]); return infoFn() }
  return llm
}

// 评审级夹具：runAdvisorReview 的 firstUserText 是提示词模板产物——用 documents 条目数把首条
// user 消息的估算推入**两条判死线之间**的走廊：
//     走廊 = ( advisorContextBudget(TIGHT_WINDOW).limit , advisorContextBudget(WIRE_WINDOW).limit ]
//          = ( 96000 , 104857 ]
//   下界 = 面 2（收窄窗）的判死线；上界 = 面 1（运行时权威窗）的判死线。
//   **两条断言都动态派生自 advisorContextBudget**（不写死估算值）：派生公式若漂移，夹具自检
//   失败而不是静默失真（判死线之间的走廊是该夹具的**正确**口径）。
//
//   **压缩触发不是判死条件**（本夹具的关键口径，评审级入口的确定性所在）：面 1 下 estimate
//   必然 > compactAt(83885) ⇒ 会进入 `compactMessages` 分支，但本评审**只有 1 条消息**
//   （`if (messages.length <= 20) return` 是该函数第一条守卫 ⇒ 压缩必然早退），压缩前后估值
//   恒等 ⇒ 两档的**唯一**分野是 `limit`。故面 1 的存活断言写成 `estimate <= limit`——
//   **不是** `< compactAt`（那会把「进入压缩分支」误当成「判死」，本档 A/B 两面都会被错判）。
//   走廊内（as-of 批 5 交付实测 100169）面 1 存活、面 2 判死，双面翻转证明接的是窗口而非常量。
const REVIEW_DOC_COUNT = 9300
const reviewDocs = Array.from({ length: REVIEW_DOC_COUNT }, (_, i) => "d/f" + i + ".mjs")
/** 面 1 窗 = 运行时权威窗（与 T-CB3 的兜底窗同值：131072 ⇒ 判死线 104857）。 */
const WIRE_WINDOW = 131072
/** 面 2 窗 = 收窄窗（120000 ⇒ 判死线 96000）——旧写死帽 120000 现在只是「一个窗口取值」。 */
const TIGHT_WINDOW = 120000

/** 评审级夹具消息的构造（面 0 自证与端到端两面共用同一构造，保证「自证的串 = 端到端测的串」）。 */
const buildReviewMessage = () => buildAdvisorUserMessage({
  cwd: PLUGIN_DIR, history: [], state: {}, reviewType: "code", designToken: null,
  documents: reviewDocs, paths: [], engineering: false, includeProjectGuide: false,
})

test("T-CB2/T-CB3 接线面: 运行时窗口 131072 → 走廊内不判死；同评审换 120000 → 判死（双面翻转证明接的是窗口而非常量）", async () => {
  // 面 0：夹具自证（可失败断言——走廊区间是动态量，断言用派生边界而非写死数）
  const measured = contentJson(buildReviewMessage())
  const measuredEstimate = newEstimate(measured)
  const corridorHigh = advisorContextBudget(WIRE_WINDOW).limit   // 面 1 判死线（104857）
  const corridorLow = advisorContextBudget(TIGHT_WINDOW).limit    // 面 2 判死线（96000）
  assert.ok(corridorLow < corridorHigh, "走廊非退化: " + corridorLow + " < " + corridorHigh)
  assert.ok(measuredEstimate <= corridorHigh,
    "面 1 夹具不得越 " + WIRE_WINDOW + " 窗的判死线（压缩触发不是判死条件）: "
    + measuredEstimate + " vs " + corridorHigh)
  assert.ok(measuredEstimate > corridorLow,
    "面 2 夹具必须越过 " + TIGHT_WINDOW + " 窗的判死线: " + measuredEstimate + " vs " + corridorLow)
  // 夹具确定性：同输入重建 → 同估算（构造若引入随机/时间成分，走廊断言会静默失真）
  assert.equal(newEstimate(contentJson(buildReviewMessage())), measuredEstimate, "夹具确定性（同输入 → 同估算）")

  const sidA = "cb-wire-a"
  const llmA = makeReviewLlm(() => ({ context: { contextWindow: WIRE_WINDOW } }))
  const outA = await runReview(sidA, llmA, cfgOf({}), reviewDocs)
  assert.ok(!String(outA).includes("context window limit reached"), "131072 窗：不判死")
  assert.equal(coreTail(outA), "| # | Action | Detail |\n|---|---|---|\n| 1 | x | y |", "正常收尾")
  assert.ok(!String(outA).includes("保守兜底"), "运行时命中 → 无兜底 note")
  assert.deepEqual(llmA.provArgs[0], ["p", "m"], "窗口解析发生在真实路由对上（provider/model）")
  dropSession(sidA)

  // 反向：同评审换运行时窗 120000（派生判死线 96000）→ 本地干净判死
  // （证明无手配键时判死线确实跟随**模型窗口**，而不是任何写死常量）
  const sidB = "cb-wire-b"
  const llmB = makeReviewLlm(() => ({ context: { contextWindow: TIGHT_WINDOW } }))
  const outB = await runReview(sidB, llmB, cfgOf({}), reviewDocs)
  assert.match(String(outB), /^Advisor: context window limit reached \(\d+ tokens\)\. Review incomplete — too many tool calls\. Try a narrower scope\./,
    "收窄窗口 → 判死（判死线跟随模型窗口，而不是任何写死常量）: " + String(outB).slice(0, 160))
  assert.equal(llmB.calls.length, 0, "判死先于任何 LLM 调用")
  dropSession(sidB)
})

test("T-CB6b 观测: 兜底 note 在 finalize 之后并入既有 dshEffNote 后缀（故障前缀零污染）", async () => {
  const sid = "cb-note"
  const llm = makeReviewLlm(null) // 无 resolveModelInfo → L3 兜底 + note
  const r = await captureWarn(() => runReview(sid, llm, cfgOf({})))
  const out = String(r.value)
  assert.ok(out.startsWith("| # | Action | Detail |"), "评审正文在最前（note 是后缀，不入 prior 判定）")
  assert.ok(!out.startsWith("Advisor:"), "机制后缀不污染 completed 判定（无 'Advisor:' 前缀）")
  assert.ok(out.includes("[thincoder-suite] 评审上下文窗口 = 131072（保守兜底；原因："), "兜底 note 追加在尾: " + out.slice(-260))
  assert.ok(out.includes("压缩触发 83885 / 判死 104857"), "note 含两档")
  assert.ok(out.includes("advisor.contextTokens"), "note 含出口指引")
  assert.ok(r.warnings.some((w) => w.includes("保守兜底")), "console.warn 留档")
  dropSession(sid)
})

test("T-CB6c 观测: L2 运行时命中 → 无 note（只读观测，不改协议面）", async () => {
  const sid = "cb-note2"
  const llm = makeReviewLlm(() => ({ context: { contextWindow: 1000000 } }))
  const r = await captureWarn(() => runReview(sid, llm, cfgOf({})))
  assert.ok(!String(r.value).includes("保守兜底"), "L2 命中：零 note")
  assert.equal(r.warnings.filter((w) => w.includes("保守兜底")).length, 0)
  dropSession(sid)
})

// ————————————— T-CB4 → AC-CB4：估算器 CJK 加权 + 纯 ASCII 零回归 —————————————

test("T-CB4: 估算器 — 纯 ASCII 与旧式逐值相等（含 ceil 边界）；CJK 与混合逐值；无新增导出", async () => {
  // 面 1：≥8 组纯 ASCII 长度（含 4k±1 的 ceil 边界）→ 旧式独立复算逐值相等
  const lengths = [0, 1, 3, 4, 5, 799, 800, 4000, 4001, 4003, 4004, 8191, 8192, 65535]
  assert.ok(lengths.length >= 8)
  const wrapped = lengths.map((n) => contentJson("A".repeat(n)))
  for (let i = 0; i < lengths.length; i++) {
    assert.equal(newEstimate(wrapped[i]), legacyEstimate(wrapped[i]), "ascii len " + lengths[i])
  }
  assert.equal(newEstimate(wrapped[9]), 1008, "4×1000+2 边界独立复算")
  assert.equal(newEstimate(wrapped[13]), 16391, "65535+27 = 65562 → ceil = 16391")

  // 面 2：CJK 逐值。设计 §5.4 表是**裸串**口径（400 / 250）；生产侧被测串带 JSON 包装
  //（`[{"type":"text","text":""}]` → 前 25 个 ASCII + 尾 2 个 ASCII = ceil(27/4) = 7），
  // 故此处对**裸串**与**包装串**两口径分别独立复算。
  assert.equal(newEstimate("中".repeat(400)), 400, "裸串：CJK 400 字 → 400（设计 §5.4 值逐字）")
  assert.equal(newEstimate("A".repeat(200) + "中".repeat(200)), 250, "裸串：200 ASCII + 200 CJK → 250（设计 §5.4 值逐字）")
  const cjk400 = contentJson("中".repeat(400))
  assert.equal(newEstimate(cjk400), 407, "包装串同口径：400 + ceil(27/4)")
  assert.equal(newEstimate(cjk400), 400 + Math.ceil(27 / 4))
  const mixed = contentJson("A".repeat(200) + "中".repeat(200))
  assert.equal(newEstimate(mixed), 257, "包装串同口径：250 + ceil(27/4)")
  assert.equal(newEstimate(mixed), 250 + Math.ceil(27 / 4))
  assert.ok(legacyEstimate(cjk400) <= 107, "旧式对 CJK 低估 ~4×（对照）")
  assert.equal(legacyEstimate(cjk400), Math.ceil(cjk400.length / 4))

  // 面 3：CJK 修正方向（生产被测串口径）
  const bigCjk = contentJson("中".repeat(40000))
  assert.ok(newEstimate(bigCjk) > legacyEstimate(bigCjk) * 3, "CJK 串新式 ≥ 旧式 3×（4× 低估修正方向）")

  // 面 4：estimateTokens 保持模块私有（FR-CB4 导出面零改）
  const mod = await import("../lib/advisor.mjs")
  assert.equal("estimateTokens" in mod, false, "estimateTokens 不导出")
  assert.equal("estimateText" in mod, false, "estimateText 私有（不新增导出）")
})

// ————————————— T-CB10 → AC-CB4 生产路径 CJK 判据（分歧审计 🔴 #1） —————————————
//
// **缺口**：上面 T-CB4 的 CJK 断言（`"中"×400`→400 / 混合→250 / bigCjk）全部打在本地复算
// 副本 `newEstimate` 上；T-CB4 里唯一面向生产的断言只有「estimateTokens 不在导出面」。把生产
// 权重改成任何 ≠1 的值（例如 `Math.ceil(s.length/4) + Math.round(nonAscii*0.75)`），既有全量
// 仍可全绿——这是**证据锁缺口**（生产公式本身是对的）。
//
// **夹具**：`firstUserText = "中" × 300000`。单条消息 ⇒ `messages.length = 1 ≤ 20` ⇒
// `compactMessages` 第一条守卫即早退（与设计 §8.2 的单条夹具前提同款），故估值在压缩前后恒等，
// 判死与否只由 `limit` 决定。
//
// **逐项算式**（独立复算，不复用生产 helper）：
//   被测串 = `JSON.stringify([{ type:"text", text }])`（生产 userMsg 的 content 形状）
//   JSON 信封 = 27 个 ASCII 字符（`[{"type":"text","text":"` 25 字符 + `"}]` 2 字符）
//   串长 = 27 + 300000 = 300027；nonAscii = 300000；ascii 码元 = 27
//   生产新式 = ceil(ascii/4) + nonAscii = ceil(27/4) + 300000 = 7 + 300000 = **300007**
//   旧式     = ceil(300027/4) = ceil(75006.75) = **75007**（兜底判死线 104857 之下 ⇒ 旧式漏判）
//   缺省（无 contextTokens）⇒ 兜底窗 131072 ⇒ limit = 104857 / compactAt = 83885
//     ⇒ 300007 > 83885 进压缩分支（单条 ⇒ 早退，估值不变）、300007 > 104857 ⇒ **真的判死**
//
// **可失败性**：尾行 N 逐字锁 300007。把生产 CJK 权重改成任何 ≠1 的值（如 ×0.75 ⇒ 225007；
// 退回旧式 ⇒ 75007 且根本不判死）⇒ 本用例转红。

const CJK_CHARS = 300000
/** 单条 CJK 夹具（"中" × 300000）。 */
const BIG_CJK = "中".repeat(CJK_CHARS)
const CJK_JSON_LEN = contentJson(BIG_CJK).length     // 300027（独立实测）
const CJK_PRODUCTION_ESTIMATE = 300007               // 见上方逐项算式
const CJK_LEGACY_ESTIMATE = 75007                    // ceil(300027 / 4)

test("T-CB10: 生产路径 CJK 判据 — 「中」×300000 ⇒ 生产估算恰 300007 ⇒ 兜底窗判死（尾行逐字 N=300007）；旧式 75007 漏判", async () => {
  // 面 1：夹具算术自证（独立复算）
  assert.equal(BIG_CJK.length, CJK_CHARS)
  assert.equal(CJK_JSON_LEN, 300027, "JSON 信封 = 27 ASCII 字符（生产 userMsg content 形状）")
  assert.equal(newEstimate(contentJson(BIG_CJK)), CJK_PRODUCTION_ESTIMATE, "新式独立复算 = 300007")
  assert.equal(legacyEstimate(contentJson(BIG_CJK)), CJK_LEGACY_ESTIMATE, "旧式独立复算 = 75007")
  // 关键性质：新式越线（真的判死）、旧式不越线（漏判）
  const fallbackLimit = advisorContextBudget(CONTEXT_FALLBACK_WINDOW_TOKENS).limit
  assert.equal(fallbackLimit, 104857)
  assert.ok(CJK_PRODUCTION_ESTIMATE > fallbackLimit, "CJK 加权估值越过兜底判死线（" + CJK_PRODUCTION_ESTIMATE + " > " + fallbackLimit + "）")
  assert.ok(CJK_LEGACY_ESTIMATE < fallbackLimit, "旧式口径对 CJK 漏判（" + CJK_LEGACY_ESTIMATE + " < " + fallbackLimit + "）")
  assert.ok(CJK_PRODUCTION_ESTIMATE > advisorContextBudget(CONTEXT_FALLBACK_WINDOW_TOKENS).compactAt,
    "夹具进入压缩分支（单条消息 ⇒ compactMessages 早退，估值不变）")

  // 面 2：生产路径——缺省落兜底窗 ⇒ 判死，且尾行 N **逐字**为 300007
  //（该 N 由生产 estimateTokens 对 CJK 的权重唯一决定：任何 ≠1 的权重都会改变它）
  const llm = makeLoopLlm()
  const out = await runAdvisorToolLoop({ llm }, loopOpts({ firstUserText: BIG_CJK }))
  assert.equal(out, deathLine(300007), "生产 CJK 估值逐字锁定（尾行 N = 300007）")
  assert.equal(llm.calls.length, 0, "判死在任何 LLM 调用之前")

  // 面 3：同 CJK 夹具 + 1M 窗 ⇒ 不判死、正常收尾（CJK 估值同样参与窗口比较）
  const llm2 = makeLoopLlm()
  const out2 = await runAdvisorToolLoop({ llm: llm2 }, loopOpts({ firstUserText: BIG_CJK, contextTokens: 1000000 }))
  assert.equal(out2, "REVIEW-BODY", "1M 窗：CJK 夹具不被判死")
  assert.equal(llm2.calls.length, 1)
})

// ————————————— T-CB5 → AC-CB5：窗口解析四级分支 + 源码级锁 —————————————

test("T-CB5a: 窗口解析四级分支逐断言（config / config 非法下探 / runtime / 不可得→fallback+note）", async () => {
  const eff = (advisor) => effectiveGlobalConfig({ advisor }, { cwdHint: PLUGIN_DIR })
  const info = { context: { contextWindow: 1000000 } }

  // L1 config 命中：静默 + note 为 null
  const r1 = await captureWarn(() => resolveAdvisorContextWindow({ resolveModelInfo: async () => info }, "p", "m", eff({ contextTokens: 200000 })))
  assert.deepEqual(r1.value, { window: 200000, source: "config", note: null })
  assert.equal(r1.warnings.length, 0, "L1 静默")

  // L1 非法（越界）→ console.warn 含合法区间 + 视为未配下探 L2（**不是**直接落兜底）
  const r2 = await captureWarn(() => resolveAdvisorContextWindow({ resolveModelInfo: async () => info }, "p", "m", eff({ contextTokens: 1000 })))
  assert.equal(r2.value.window, 1000000, "非法下探到运行时权威值（非兜底）")
  assert.equal(r2.value.source, "runtime")
  assert.equal(r2.value.note, null)
  assert.ok(r2.warnings.some((w) => w.includes("advisor.contextTokens") && w.includes("16384") && w.includes("4194304")),
    "非法告警含合法区间: " + JSON.stringify(r2.warnings))

  // L2 runtime 命中：source=runtime，静默
  const r3 = await captureWarn(() => resolveAdvisorContextWindow({ resolveModelInfo: async () => info }, "p", "m", eff({})))
  assert.deepEqual(r3.value, { window: 1000000, source: "runtime", note: null })
  assert.equal(r3.warnings.length, 0, "L2 静默")

  // L3 四种不可得成因 → fallback + warn + note 非空
  const fallbackCases = [
    ["llm 缺失", null, "p", "m"],
    ["llm 无 resolveModelInfo", {}, "p", "m"],
    ["provider/model 未知", { resolveModelInfo: async () => info }, "", ""],
    ["查询抛错", { resolveModelInfo: async () => { throw new Error("boom-metadata") } }, "p", "m"],
    ["无 context 字段", { resolveModelInfo: async () => ({ reasoning: {} }) }, "p", "m"],
    ["contextWindow 非整数", { resolveModelInfo: async () => ({ context: { contextWindow: 0 } }) }, "p", "m"],
  ]
  for (const [label, llm, prov, model] of fallbackCases) {
    const r = await captureWarn(() => resolveAdvisorContextWindow(llm, prov, model, eff({})))
    assert.equal(r.value.window, CONTEXT_FALLBACK_WINDOW_TOKENS, label)
    assert.equal(r.value.source, "fallback", label)
    assert.ok(typeof r.value.note === "string" && r.value.note.length > 0, label + ": note 非空")
    // note 保留四信息：值 / 来源 / 两档 / 出口
    assert.ok(r.value.note.includes("131072"), label + ": 值")
    assert.ok(r.value.note.includes("保守兜底"), label + ": 来源")
    assert.ok(r.value.note.includes("83885") && r.value.note.includes("104857"), label + ": 两档")
    assert.ok(r.value.note.includes("advisor.contextTokens"), label + ": 出口")
    assert.ok(r.warnings.some((w) => w.includes("保守兜底")), label + ": console.warn 留档")
  }
  // 抛错分支的诊断串确实上浮
  const rErr = await captureWarn(() => resolveAdvisorContextWindow({ resolveModelInfo: async () => { throw new Error("boom-metadata") } }, "p", "m", eff({})))
  assert.ok(rErr.value.note.includes("boom-metadata"), "抛错原因上浮: " + rErr.value.note)

  // 合法键（含边界）与未配的解析器语义
  assert.equal(resolveAdvisorContextTokens(eff({ contextTokens: 16384 })), 16384)
  assert.equal(resolveAdvisorContextTokens(eff({ contextTokens: 4194304 })), 4194304)
  assert.equal(resolveAdvisorContextTokens(eff({})), null, "未配 → null（键不存在）")
  assert.equal(resolveAdvisorContextTokens({}), null)
  assert.equal(resolveAdvisorContextTokens(null), null)
  assert.equal(resolveAdvisorContextTokens({ advisor: { contextTokens: null } }), null)
  const rBad = await captureWarn(() => resolveAdvisorContextTokens({ advisor: { contextTokens: 1.5 } }))
  assert.equal(rBad.value, null)
  assert.equal(rBad.warnings.length, 1)
  // 解析是纯读：入参零突变（resolveAdvisorRoute 的纯同步契约不受本批影响——窗口走异步旁路）
  const cfg = { advisor: { contextTokens: 1000000 } }
  const snapshot = JSON.stringify(cfg)
  await resolveAdvisorContextWindow({ resolveModelInfo: async () => info }, "p", "m", cfg)
  assert.equal(JSON.stringify(cfg), snapshot, "config 入参零突变")
})

test("T-CB5b: 源码级锁 — resolveAdvisorContextWindow 恰 2 次调用 + 1 次定义；每次调用后同函数体内出现 contextTokens:", () => {
  const src = readFileSync(join(PLUGIN_DIR, "lib", "advisor.mjs"), "utf8")
  const occurrences = []
  const needle = "resolveAdvisorContextWindow("
  for (let i = src.indexOf(needle); i !== -1; i = src.indexOf(needle, i + 1)) occurrences.push(i)
  assert.equal(occurrences.length, 3, "共 3 处（1 定义 + 2 调用）")
  const defs = occurrences.filter((i) => src.slice(Math.max(0, i - 40), i).includes("export async function"))
  const calls = occurrences.filter((i) => !defs.includes(i))
  assert.equal(defs.length, 1, "恰 1 次定义")
  assert.equal(calls.length, 2, "恰 2 次调用（dsh 主路径 + codex→dsh 回落轮）")

  // 「生产忘了传」防护：每次调用之后、同函数体内必须出现 contextTokens:
  const parts = src.split(/^export (?:async )?function\s/m)
  for (const c of calls) {
    const part = parts.find((p) => {
      const at = src.indexOf(p)
      return at !== -1 && c > at && c < at + p.length
    })
    assert.ok(part, "调用点落在某个导出函数体内")
  }
  // 评审 #2（批 5 交付代码评审 🔵）：**逐调用切片**断言——原实现用 part.indexOf("contextTokens:")
  // > part.indexOf(needle)，而两处调用同在 runAdvisorReview 函数体内，indexOf 恒取第一处调用位置
  // ⇒ 配对语义退化（删掉其中一处的接线，该断言仍可能绿）。改为按调用位置切片：
  // 第 i 处调用 → 第 i+1 处调用（末次到文件尾），断言该切片内出现 contextTokens:。
  const sortedCalls = [...calls].sort((a, b) => a - b)
  sortedCalls.forEach((c, idx) => {
    const end = idx + 1 < sortedCalls.length ? sortedCalls[idx + 1] : src.length
    const slice = src.slice(c, end)
    assert.ok(slice.includes("contextTokens:"),
      "第 " + (idx + 1) + " 处调用之后（至下一处调用前）必须传 contextTokens:（逐调用切片）")
  })
  // 两处都传的是解析结果的 window 字段（而非其他值）
  const wired = src.split("contextTokens: winRes.window").length - 1
  assert.equal(wired, 2, "两处接线均传 winRes.window（实得 " + wired + "）")
})

// ————————————— T-CB6 → AC-CB6：PUT 面（合法落盘 / 越界拒绝 / 未知键消息） —————————————

test("T-CB6: PUT — 合法值落盘；越界/非整数报错且不入 sanitized；未知键错误消息含新键名", async () => {
  // 合法值：sanitized 保留（= 校验函数单一事实源放行）
  const ok = validateGlobalUserConfig({ advisor: { contextTokens: 1000000 } }, [])
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.sanitized.advisor.contextTokens, 1000000)
  const okMin = validateGlobalUserConfig({ advisor: { contextTokens: 16384 } }, [])
  assert.equal(okMin.ok, true)
  const okMax = validateGlobalUserConfig({ advisor: { contextTokens: 4194304 } }, [])
  assert.equal(okMax.ok, true)

  // 越界 / 非整数 / 非数字：报错且不入 sanitized
  for (const bad of [16383, 4194305, 1000000.5, "1000000", true]) {
    const v = validateGlobalUserConfig({ advisor: { contextTokens: bad } }, [])
    assert.equal(v.ok, false, "必须拒绝: " + JSON.stringify(bad))
    assert.ok(v.errors.some((e) => e.includes("advisor.contextTokens") && e.includes("16384..4194304")),
      JSON.stringify(bad) + " → " + JSON.stringify(v.errors))
    assert.equal(v.sanitized.advisor, undefined, "越界/非法值不进 sanitized（不落盘）")
  }

  // 未知键错误消息含新键名（白名单提示面已把 contextTokens 列为可用键）
  const unknown = validateGlobalUserConfig({ advisor: { nope: 1 } }, [])
  assert.equal(unknown.ok, false)
  assert.ok(unknown.errors.some((e) => e.includes("advisor.nope is not supported") && e.includes("contextTokens")),
    JSON.stringify(unknown.errors))

  // 真实 PUT 路由（makeApiHandler）落盘：合法值 200 且 user 载荷保留；越界 400 且不入盘
  const { makeApiHandler } = await import("../lib/index.mjs")
  const home = mkdtempSync(join(tmpdir(), "cb-put-"))
  try {
    const put = async (handler, config) => {
      const req = {
        method: "PUT", url: "/thincoder-suite/api/config",
        [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ config })) },
      }
      const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
      await handler(req, res)
      return res
    }
    const handler = makeApiHandler(fenceCtx(), { baseConfig: {}, dshHomeOverride: home })
    const r1 = await put(handler, { advisor: { contextTokens: 200000 } })
    assert.equal(r1.statusCode, 200, "合法值 PUT 接受: " + r1.body)
    assert.equal(JSON.parse(r1.body).user.advisor.contextTokens, 200000, "sanitized 保留")
    const r2 = await put(handler, { advisor: { contextTokens: 999 } })
    assert.equal(r2.statusCode, 400, "越界 PUT 拒绝: " + r2.body)
    assert.ok(JSON.parse(r2.body).errors.some((e) => e.includes("advisor.contextTokens")))
    const r3 = await put(handler, { advisor: { contextTokens: 1000000.7 } })
    assert.equal(r3.statusCode, 400, "非整数 PUT 拒绝")
    // 失败请求不落盘（盘上仍是上一次的合法值）
    const r4 = await put(handler, { advisor: { contextTokens: 300000 } })
    assert.equal(r4.statusCode, 200)
    const onDisk = JSON.parse(readFileSync(join(home, ".thincoder", "config.json"), "utf8"))
    assert.equal(onDisk.config.advisor.contextTokens, 300000, "盘上为最后一次合法值")
  } finally { rmSync(home, { recursive: true, force: true }) }
})

// ————————————— T-CB7 → AC-CB7：merge 白名单透传 + base 未定义时不产生空键 —————————————

test("T-CB7: merge 白名单透传 advisor.contextTokens；base 未定义时不产生空键", () => {
  const merged = mergeGlobalConfig({}, { advisor: { contextTokens: 200000 } })
  assert.equal(merged.advisor.contextTokens, 200000, "白名单透传（user 层覆盖 base）")
  // 非法值本层不重复校验（只透传——值校验归 advisor.mjs 单一事实源）
  assert.equal(mergeGlobalConfig({}, { advisor: { contextTokens: 1 } }).advisor.contextTokens, 1)
  // base 未定义时的键引入面：**不出现 base 缺失导致的空组键**（既有 groups 循环只在
  // 「base 有该组 or user 组非空」时落键；空 advisor {} 会引入空的 advisor 对象本身，那是
  // 既有行为——本批零改）。断言锚点 = 组键未被凭空引入。
  const noKey = mergeGlobalConfig({}, { advisor: {} })
  assert.deepEqual(noKey.advisor, {}, "空 advisor 不引入 round1/convergence 空组键")
  assert.equal("round1" in noKey.advisor, false)
  assert.equal("convergence" in noKey.advisor, false)
  const baseOnly = mergeGlobalConfig({ advisor: { contextTokens: 500000 } }, {})
  assert.equal(baseOnly.advisor.contextTokens, 500000, "无 user 层保留 base")
  // base 未定义 + user 只给 contextTokens → 该键原样出现（不夹带空组键）
  const only = mergeGlobalConfig({}, { advisor: { contextTokens: 1000000 } })
  assert.deepEqual(Object.keys(only.advisor), ["contextTokens"], "不同时引入 round1/convergence 空组")
  assert.equal("contextTokens" in mergeGlobalConfig({}, { advisor: { contextTokens: null } }).advisor, false,
    "null 语义：不落键（与 maxOutputTokens 同款）")
  // effectiveGlobalConfig 端到端：merge 输出 → 运行时 resolver 读得到
  const eff = effectiveGlobalConfig({ advisor: { contextTokens: 200000 } }, { cwdHint: PLUGIN_DIR })
  assert.equal(resolveAdvisorContextTokens(eff), 200000)
})

// ————————————— T-CB8 → AC-CB8：零残留静态锚 + 判死文案逐字 + 接线点锁 —————————————

test("T-CB8: 旧写死常量在 lib/ 递归零命中；判死文案逐字在位；接线点源码锁已在 T-CB5b", () => {
  const retired = ["MAX", "CONTEXT", "TOKENS"].join("_") // 拼装——避免本档自身成为命中源
  const hits = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!/\.(mjs|js|cjs)$/.test(name)) continue
      const src = readFileSync(full, "utf8")
      if (src.includes(retired)) hits.push(full)
    }
  }
  walk(join(PLUGIN_DIR, "lib"))
  assert.deepEqual(hits, [], "退役常量零残留（不留别名）")

  // 判死文案逐字在位 + 两档消费点已换源（旧常量引用零命中已由上一条覆盖）
  const advisor = readFileSync(join(PLUGIN_DIR, "lib", "advisor.mjs"), "utf8")
  assert.ok(advisor.includes('"Advisor: context window limit reached (" + estimateTokens(messages) + " tokens). Review incomplete — too many tool calls. Try a narrower scope."'),
    "判死文案逐字在位")
  assert.ok(advisor.includes("if (currentTokens > budget.compactAt) {")
    && advisor.includes("if (estimateTokens(messages) > budget.limit) {"),
    "两处消费换成 budget.compactAt / budget.limit")
  assert.ok(!advisor.includes("* 0.8) {"), "旧的 MAX_CONTEXT_TOKENS * 0.8 结构零残留")
  // 两段式守卫结构顺序不变（先 compactMessages 后二次估算判死）
  const blk = advisor.slice(advisor.indexOf("if (currentTokens > budget.compactAt) {"), advisor.indexOf("// sessionId/purpose/maxTokens"))
  assert.ok(blk.indexOf("compactMessages(messages)") < blk.indexOf("budget.limit"), "先压缩后判死（顺序零改）")
  // 旧「防 OOM」归因已改写（D-CB8 四项齐备）
  assert.ok(!advisor.includes("防 OOM") && !/Reserve headroom to avoid OOM/.test(advisor), "旧 OOM 归因零残留")
  assert.ok(advisor.includes("输出预算") && advisor.includes("tools schema") && advisor.includes("分词漂移") && advisor.includes("压缩后增长走廊"),
    "D-CB8 四项归因齐备")
  // compactMessages 本体与摘要串零改
  assert.ok(advisor.includes('" [Context compacted] Earlier exploration: "') || advisor.includes('"[Context compacted] Earlier exploration: "'),
    "压缩摘要串在位")
  assert.ok(advisor.includes("if (messages.length <= 20) return"), "compactMessages 早退守卫在位（夹具前提）")
})

// ————————————— 直调循环口径（D-CB6）：缺省落兜底窗；显式窗生效 —————————————

test("T-CB2b/T-CB3b (loop 直调): 缺省静默落兜底窗判死；显式 contextTokens 生效；estimateTokens 逐消息求和", async () => {
  // 缺省（无 contextTokens）→ 兜底窗 → 同夹具判死
  const llm1 = makeLoopLlm()
  const out1 = await runAdvisorToolLoop({ llm: llm1 }, loopOpts())
  assert.equal(out1, deathLine(FIXTURE_ESTIMATE), "缺省落兜底窗后判死")
  assert.equal(llm1.calls.length, 0)
  // 非法 contextTokens（0 / NaN / 负数）同样静默落兜底窗
  for (const bad of [0, NaN, -1, "1000000"]) {
    const llmB = makeLoopLlm()
    const outB = await runAdvisorToolLoop({ llm: llmB }, loopOpts({ contextTokens: bad }))
    assert.equal(outB, deathLine(FIXTURE_ESTIMATE), "非法 contextTokens 落兜底: " + String(bad))
  }
  // 显式 1M 窗 → 不判死、正常产出（loop 层闭环）
  const llm2 = makeLoopLlm()
  const out2 = await runAdvisorToolLoop({ llm: llm2 }, loopOpts({ contextTokens: 1000000 }))
  assert.equal(out2, "REVIEW-BODY")
  assert.equal(llm2.calls.length, 1)
})

// ————————————— T-CB9 → 设计 §5.5 设置页六条 UI 规格（静态源码锁） —————————————
// client.js 是宿主内联的浏览器 bundle，本进程无法渲染 ⇒ 静态接线核对（沿用既有先例
// codex-runner.test.mjs「D-29：设置页表单接线齐全」）。六条规格逐条可失败断言。

test("T-CB9 (§5.5): 设置页 contextTokens 卡片六条 UI 规格逐条在位（静态源码锁）", () => {
  const src = readFileSync(join(PLUGIN_DIR, "lib", "client.js"), "utf8")
  // 卡片区（自 key:"ctxwin" 起，到下一张卡片为止）——限定作用域，防别处同名字符串误判
  const at = src.indexOf('key: "ctxwin"')
  assert.ok(at > 0, "卡片存在（key: ctxwin）")
  const card = src.slice(at, src.indexOf("consultPoolCard()", at))
  assert.ok(card.length > 0 && card.length < 4000, "卡片区切片非空且未越界")

  // ① 卡片标题
  assert.ok(card.includes('"评审上下文窗口（contextTokens）"'), "① 卡片标题")
  // ② 输入框：type=number / min / max / step / 占位（占位**不含具体数值**——窗口随路由变化）
  assert.ok(card.includes('type: "number"'), "② type=number")
  assert.ok(card.includes("min: CONTEXT_TOKENS_MIN") && card.includes("max: CONTEXT_TOKENS_MAX"),
    "② min/max 走区间常量（单一事实源）")
  assert.ok(card.includes("step: 1024"), "② step=1024")
  assert.ok(card.includes('placeholder: "留空 = 评审时自动跟随模型"'), "② 占位文案")
  assert.ok(!/placeholder: "[^"]*\d/.test(card), "② 占位不得写具体数值（设计 §5.5 第 2 条）")
  // ③ 提示行四件事：口径 / 自动跟随+兜底 / 合法区间 / 残余格子（R-3）
  assert.ok(card.includes("口径 = 模型窗口") && card.includes("不是判死线"), "③-① 口径 = 模型窗口（不是判死线）")
  assert.ok(card.includes("留空 = 评审时自动跟随") && card.includes("131072"), "③-② 留空自动跟随 + 兜底 131072")
  assert.ok(card.includes('"合法区间 " + CONTEXT_TOKENS_MIN + "~" + CONTEXT_TOKENS_MAX'), "③-③ 合法区间")
  assert.ok(card.includes("maxOutputTokens 调得很大") && card.includes("20% 头寸"), "③-④ 残余格子提示（R-3）")
  // ④ 当前生效回显 = 仅配置层（复用 fieldSource；不显示 runtime/fallback）
  assert.ok(card.includes('"当前生效（配置层）："') && card.includes('"未设置"'), "④ 回显（值 | 未设置）")
  assert.ok(card.includes('"（来源 " + ctxWinSource + "）。"'), "④ 来源标注")
  assert.ok(src.includes('fieldSource(base, user, ["advisor", "contextTokens"])'), "④ 来源 = fieldSource（同 maxOutputTokens 款）")
  // ⑤ 内联校验（与 PUT 同规则，不静默丢）
  assert.ok(src.includes('errors.push("advisor.contextTokens 必须是 " + CONTEXT_TOKENS_MIN + "~" + CONTEXT_TOKENS_MAX + " 的整数（模型窗口 tokens）");'),
    "⑤ 内联校验报错串")
  // ⑥ reset 语义：清空 = 删除该键（回落自动跟随）
  assert.ok(src.includes('setOf(["advisor", "contextTokens"], curOf(["advisor", "contextTokens"], ""))'), "⑥ reset 清空 = 删键")
  // 草稿 payload（空字段不发送 = 不覆盖 base）
  assert.ok(src.includes("advisor.contextTokens = Number(draft.advisor.contextTokens);"), "payload")
  assert.ok(src.includes('contextTokens: typeof a.contextTokens === "number" ? String(a.contextTokens) : ""'),
    "effective → 草稿回填")
  // 渲染串零 markdown 强调泄漏（** 只允许出现在 JS 注释里，不得进任何渲染字符串）
  assert.ok(!card.includes("**"), "渲染串零 markdown 强调泄漏")
  // 两端区间常量同值（client 侧与 advisor.mjs 单一事实源一致）
  assert.ok(src.includes("var CONTEXT_TOKENS_MIN = " + ADVISOR_CONTEXT_TOKENS_MIN + ";"), "区间下界同值")
  assert.ok(src.includes("var CONTEXT_TOKENS_MAX = " + ADVISOR_CONTEXT_TOKENS_MAX + ";"), "区间上界同值")
})
