// advisor-config.test.mjs — 一期 host 机制单元测试（docs/2026-09-01-advisor-config-design.md §5.2）
// + F10 design token 磁盘持久化（docs/2026-09-02-thincoder-suite-extensions-design.md §4，T1–T5）。
// node:test 零依赖：stub ctx.llm.stream 为 async generator 收集 opts/消息，支持注入
// 「静默流」「稳定涓流」「脚本化流（先工具后静默）」三种 chunk 时序（T6/T7/T8 秒级完成，
// 注入小 timeoutMs 200~400ms 与 stallMsOverride，不用生产示例值 300s/900s）。
// 覆盖 2026-09-01 一期 T1–T13、T16、T18–T21（T14/T15/T17 为手动冒烟，见交付说明）
// + 2026-09-02 扩展 F10 T1–T5（storPathOverride 注入临时目录，不碰真实 $DSH_HOME）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  advisorGroupKey, resolveAdvisorRoute, resolveIncludeProjectGuide,
  runAdvisorConfigTool, runAdvisorToolLoop, isApprovalVerdict, runAdvisorReview,
} from "../lib/advisor.mjs"
import { buildAdvisorUserMessage } from "../lib/advisor-msgs.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { runEngCoder, buildCoderBrief } from "../lib/eng.mjs"
import { loadTokenRecord, saveTokenRecord, resolveTokenStorePath } from "../lib/token-store.mjs"
import { computeDocHash, normalizeDocPath } from "../lib/doc-hash.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 二期隔离：advisor 消费点现在合并 config-store user 层（$DSH_HOME/.thincoder/config.json）。
// 本机宿主 DSH_HOME 指向真实 profile——若有真实 user 层会污染断言。屏蔽 env → 探测回落 null
// （本文件进程内生效；真实宿主不受影响）。F10/token 用例全走显式注入路径，不受影响。
process.env.DSH_HOME = ""

// ————————————— stub 基础设施 —————————————

/** 静默流：永不产出 chunk；opts.signal abort 后在下一 tick 干净结束（close 有界）。 */
function silentStream(opts) {
  return (async function* () {
    while (true) {
      await sleep(20)
      if (opts.signal?.aborted) return
    }
  })()
}

/** 稳定涓流：每 intervalMs 产出一个小 text chunk，直到 abort。 */
function trickleStream(opts, intervalMs) {
  return (async function* () {
    while (true) {
      await sleep(intervalMs)
      if (opts.signal?.aborted) return
      yield { type: "block-end", block: { type: "text", text: "t" } }
    }
  })()
}

const textFinish = { type: "finish", reason: { kind: "stop" } }
const textBlocks = (t) => [{ type: "block-end", block: { type: "text", text: t } }, textFinish]

/** llm stub：收集每次 llm.stream(opts) 的 opts；按调用序号切换脚本流（超出取最后一个）。 */
function makeLlm(behaviors) {
  const calls = []
  let n = 0
  return {
    stream(opts) {
      calls.push(opts)
      const behavior = behaviors[Math.min(n, behaviors.length - 1)]
      n++
      return behavior(opts) // behaviors 元素为 (opts) => AsyncGenerator
    },
    calls,
  }
}
const seq = {
  silent: (opts) => silentStream(opts),
  trickle: (opts) => trickleStream(opts, 8),
  toolCallThenSilent: (opts) => (async function* () {
    yield { type: "block-end", block: { type: "tool-call", id: "c1", name: "read", arguments: JSON.stringify({ path: "package.json" }) } }
    yield textFinish
  })(),
}

function loopOpts(extra = {}) {
  return {
    provider: "p", model: "m", system: "sys", firstUserText: "review scope",
    cwd: PLUGIN_DIR, signal: undefined, sessionId: "loop-test", timeoutMs: 5000,
    ...extra,
  }
}

// ————————————— T1 旧配置自动映射 round1（F6） —————————————

test("T1: legacy advisor.provider/model/timeoutMs maps to round1 only; convergence falls to agent route", () => {
  const config = { advisor: { provider: "legacy-p", model: "legacy-m", timeoutMs: 900000 } }
  const agentOpts = { provider: "agent-p", model: "agent-m" }
  const r1 = resolveAdvisorRoute({ config, override: null, agentOpts, advisorRound: 0 })
  assert.equal(r1.ok, true)
  assert.equal(r1.provider, "legacy-p")
  assert.equal(r1.model, "legacy-m")
  assert.equal(r1.pairSource, "legacy advisor.*")
  assert.equal(r1.timeoutMs, 900000)
  assert.equal(r1.timeoutSource, "legacy advisor.*")
  assert.equal(r1.warnings.length, 0)
  // convergence（round 2+）不沿用 legacy → agent route + convergence 缺省 300000
  const r2 = resolveAdvisorRoute({ config, override: null, agentOpts, advisorRound: 1 })
  assert.equal(r2.ok, true)
  assert.equal(r2.provider, "agent-p")
  assert.equal(r2.model, "agent-m")
  assert.equal(r2.pairSource, "agent route")
  assert.equal(r2.timeoutMs, 300000)
  assert.equal(r2.timeoutSource, "default")
})

// ————————————— T2 advisorRound 缺失/0 → round1；>=1 → convergence —————————————

test("T2: advisorRound routing key (missing = 0 → round1; >=1 → convergence)", () => {
  const config = {
    advisor: {
      round1: { provider: "r1p", model: "r1m" },
      convergence: { provider: "cp", model: "cm" },
    },
  }
  const agentOpts = { provider: "ap", model: "am" }
  assert.equal(advisorGroupKey(undefined), "round1")
  for (const round of [undefined, null, 0]) {
    const r = resolveAdvisorRoute({ config, override: null, agentOpts, advisorRound: round })
    assert.equal(r.provider, "r1p")
    assert.equal(r.model, "r1m")
    assert.equal(r.groupKey, "round1")
  }
  for (const round of [1, 2, 5]) {
    const r = resolveAdvisorRoute({ config, override: null, agentOpts, advisorRound: round })
    assert.equal(r.provider, "cp")
    assert.equal(r.model, "cm")
    assert.equal(r.groupKey, "convergence")
  }
})

// ————————————— T3 effort 合法透传 / 非法忽略并警告 —————————————

test("T3a: valid group effort resolved and forwarded as reasoningEffort in llm.stream opts", async () => {
  const llm = makeLlm([(o) => (async function* () { yield* textBlocks("done") })()])
  const res = await runAdvisorToolLoop({ llm }, loopOpts({ effort: "low" }))
  assert.equal(res, "done")
  assert.equal(llm.calls[0].reasoningEffort, "low")
  // 直接入口非法 effort → N4 兜底：回落不传
  const llm2 = makeLlm([(o) => (async function* () { yield* textBlocks("done2") })()])
  await runAdvisorToolLoop({ llm: llm2 }, loopOpts({ effort: "banana" }))
  assert.equal(llm2.calls[0].reasoningEffort, undefined)
})

test("T3b: invalid effort in config is ignored with a warning (N4)", () => {
  const config = { advisor: { round1: { provider: "A", model: "M", effort: "turbo" } } }
  const r = resolveAdvisorRoute({ config, override: null, agentOpts: { provider: "x", model: "y" }, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.effort, null)
  assert.ok(r.warnings.some((w) => w.includes("advisor config warning") && w.includes("effort") && w.includes("turbo")))
})

// ————————————— T4 includeProjectGuide 记忆开关 —————————————

test("T4: includeProjectGuide=false (default) skips the Project Guide section; true injects it", () => {
  const base = {
    cwd: PLUGIN_DIR, history: [], state: { advisorRound: 0 },
    reviewType: "design", designToken: null, paths: [],
    documents: ["docs/2026-09-01-advisor-config-design.md"], engineering: false,
  }
  const off = buildAdvisorUserMessage({ ...base, includeProjectGuide: false })
  assert.ok(!off.includes("## Project Guide"), "off: no Project Guide section")
  assert.ok(off.includes("(Project guide not injected — review is based on the documents list only. Pass requirement/design docs explicitly via documents=[...].)"), "off: note line appended")
  const on = buildAdvisorUserMessage({ ...base, includeProjectGuide: true })
  assert.ok(on.includes("## Project Guide (AGENTS.md)"), "on: Project Guide section present")
})

// ————————————— T5 会话覆盖字段级合并与优先级 —————————————

test("T5: session override merges per-field over the global group and wins", () => {
  const config = {
    advisor: {
      round1: { provider: "A", model: "M", effort: "high", timeoutMs: 500000 },
      convergence: { provider: "C", model: "N", timeoutMs: 250000 },
    },
  }
  const override = { round1: { provider: "X", effort: "low" } }
  const r = resolveAdvisorRoute({ config, override, agentOpts: { provider: "ap", model: "am" }, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "X")          // override 覆盖 provider
  assert.equal(r.model, "M")             // 未覆盖字段回落全局
  assert.equal(r.pairSource, "session override + global config")
  assert.equal(r.effort, "low")          // override 覆盖 effort
  assert.equal(r.timeoutMs, 500000)      // 未覆盖 → 全局组
  assert.equal(r.timeoutSource, "global config")
  assert.equal(r.warnings.length, 0)
  // convergence 覆盖组同样字段级生效
  const r2 = resolveAdvisorRoute({ config, override: { convergence: { model: "NX" } }, agentOpts: { provider: "ap", model: "am" }, advisorRound: 1 })
  assert.equal(r2.model, "NX")
  assert.equal(r2.provider, "C")
  assert.equal(r2.timeoutMs, 250000)
})

// ————————————— T6 静默流：绝对截止 timeout / idle 看门狗 stall —————————————

test("T6a: silent stream + small timeoutMs (200ms) → absolute deadline wins (timeout, enhanced message)", async () => {
  const llm = makeLlm([seq.silent])
  const t0 = Date.now()
  const res = await runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 200 }))
  const elapsed = Date.now() - t0
  assert.match(res, /^Advisor: review timeout after /)
  assert.match(res, /\(completed 0 tool rounds, 0 files read\)\. Try again with a narrower scope\./)
  assert.ok(elapsed >= 150 && elapsed < 3000, "timeout fires near the budget, got " + elapsed + "ms")
})

test("T6b: big timeoutMs + short stall injection → idle watchdog aborts, STREAM_ATTEMPTS exhausted → provider_stall diagnostic", async () => {
  const llm = makeLlm([seq.silent])
  const t0 = Date.now()
  const res = await runAdvisorToolLoop(
    { llm },
    // 预算 7000ms：期望路径 ≈ 3×40ms stall + 1000+2000ms 退避 ≈ 3.1s，余量 ~3.9s（防慢机 flake，评审 #9）
    loopOpts({ timeoutMs: 7000, stallMsOverride: 40 }),
  )
  const elapsed = Date.now() - t0
  assert.ok(res.includes("provider_stall"), "stall diagnostic expected, got: " + res)
  assert.ok(!res.includes("review timeout after"), "budget not exhausted → not a timeout")
  assert.ok(res.includes("llm call stalled"), "stall reason present")
  assert.ok(elapsed < 6000, "seconds-level test, got " + elapsed + "ms")
})

// ————————————— T7 稳定涓流 → 绝对截止在预算时刻中止 —————————————

test("T7: steady trickle (chunk interval < watchdog window) is cut by the absolute deadline at timeoutMs", async () => {
  const llm = makeLlm([seq.trickle])
  const t0 = Date.now()
  const res = await runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 200 }))
  const elapsed = Date.now() - t0
  assert.match(res, /^Advisor: review timeout after /)
  assert.ok(!res.includes("provider_stall"), "deadline fires before any stall classification")
  assert.ok(elapsed < 1500, "≤ timeoutMs + slack, got " + elapsed + "ms")
})

// ————————————— T8 timeout 消息含轮次/已读文件数 —————————————

test("T8: timeout message reports completed tool rounds and files read; stall keeps provider_stall diagnostic", async () => {
  // 第一轮：read package.json 工具调用执行成功；第二轮静默 → 预算到点 timeout
  const llm = makeLlm([seq.toolCallThenSilent, seq.silent])
  const t0 = Date.now()
  const res = await runAdvisorToolLoop({ llm }, loopOpts({ timeoutMs: 500, sessionId: "t8-loop" }))
  const elapsed = Date.now() - t0
  assert.match(res, /^Advisor: review timeout after /)
  assert.match(res, /\(completed 1 tool rounds, 1 files read\)/)
  assert.ok(elapsed < 3000, "got " + elapsed + "ms")
})

// ————————————— T9 advisor_config get/set/reset —————————————

test("T9: advisor_config get/set/reset normal paths read & write the session override and show effective config", () => {
  const state = { advisorOverride: null }
  const config = {
    advisor: {
      round1: { provider: "A", model: "M", timeoutMs: 600000 },
      convergence: { provider: "B", model: "N" },
    },
  }
  const agentOpts = { provider: "ap", model: "am" }
  const deps = { config, agentOpts, state, sessionId: "s1" }
  // get 初始
  let out = runAdvisorConfigTool('{"action":"get"}', deps)
  assert.ok(out.includes("session override: (none)"))
  assert.ok(out.includes("round1:"))
  assert.ok(out.includes("provider: A"))
  assert.ok(out.includes("includeProjectGuide: false"))
  // set 各 path 类型
  out = runAdvisorConfigTool('{"action":"set","path":"round1.effort","value":"low"}', deps)
  assert.ok(out.startsWith("advisor_config: set round1.effort = \"low\""))
  assert.equal(state.advisorOverride.round1.effort, "low")
  out = runAdvisorConfigTool('{"action":"set","path":"convergence.timeoutMs","value":200000}', deps)
  assert.ok(out.startsWith("advisor_config: set convergence.timeoutMs = 200000"))
  assert.equal(state.advisorOverride.convergence.timeoutMs, 200000)
  out = runAdvisorConfigTool('{"action":"set","path":"includeProjectGuide","value":true}', deps)
  assert.ok(out.startsWith("advisor_config: set includeProjectGuide = true"))
  assert.equal(state.advisorOverride.includeProjectGuide, true)
  // get 显示生效配置（覆盖 JSON + 路由来源标注：覆盖 > 全局组）
  out = runAdvisorConfigTool('{"action":"get"}', deps)
  assert.ok(out.includes('session override: {"round1":{"effort":"low"},"convergence":{"timeoutMs":200000},"includeProjectGuide":true}'), out)
  assert.ok(out.includes("provider: A (source: global config)"), out)
  assert.ok(out.includes('effort: "low" (source: session override)'), out)
  assert.ok(out.includes("timeoutMs: 200000 (source: session override)"), out)
  assert.ok(out.includes("timeoutMs: 600000 (source: global config)"), out)
  assert.ok(out.includes("includeProjectGuide: true (source: session override)"), out)
  // reset 各 path + all
  out = runAdvisorConfigTool('{"action":"reset","path":"convergence"}', deps)
  assert.ok(out.startsWith("advisor_config: reset convergence"))
  assert.equal(state.advisorOverride.convergence, undefined)
  out = runAdvisorConfigTool('{"action":"reset","path":"includeProjectGuide"}', deps)
  assert.equal(state.advisorOverride.includeProjectGuide, undefined)
  out = runAdvisorConfigTool('{"action":"reset","path":"round1"}', deps)
  assert.equal(state.advisorOverride, null)
  // 省略 path = all（与 set 的 path 枚举对称）；get 回到 none
  runAdvisorConfigTool('{"action":"set","path":"round1.model","value":"X"}', deps)
  out = runAdvisorConfigTool('{"action":"reset"}', deps)
  assert.ok(out.startsWith("advisor_config: reset all"))
  assert.equal(state.advisorOverride, null)
})

// ————————————— T10 advisor_config 非法输入不变量 —————————————

test("T10: advisor_config invalid input → error text and advisorOverride unchanged", () => {
  const fresh = () => ({ advisorOverride: { round1: { provider: "keep" } } })
  const config = { advisor: { round1: { provider: "A", model: "M" } } }
  const deps = (state) => ({ config, agentOpts: {}, state, sessionId: "s2" })
  const cases = [
    ["{{{", "malformed JSON"],
    ['{"action":"fly"}', "unknown action"],
    ['{"action":"set"}', "set requires a path"],
    ['{"action":"set","path":"round1.bogus","value":"x"}', "is not settable"],
    ['{"action":"set","path":"round1.effort","value":"turbo"}', "must be one of off|low|medium|high|max"],
    ['{"action":"set","path":"round1.timeoutMs","value":"200000"}', "must be a number in 1000..3600000"],
    ['{"action":"set","path":"round1.timeoutMs","value":50}', "must be a number in 1000..3600000"],
    ['{"action":"set","path":"round1.timeoutMs","value":9999999999}', "must be a number in 1000..3600000"],
    ['{"action":"set","path":"round1.provider","value":123}', "must be a non-empty string"],
    ['{"action":"set","path":"includeProjectGuide","value":"yes"}', "must be a boolean"],
    ['{"action":"reset","path":"round9"}', "is not resettable"],
  ]
  for (const [req, reason] of cases) {
    const state = fresh()
    const out = runAdvisorConfigTool(req, deps(state))
    assert.ok(out.startsWith("advisor_config: invalid input — "), req)
    assert.ok(out.includes(reason), req + " → " + out)
    assert.deepEqual(state.advisorOverride, { round1: { provider: "keep" } }, "state unchanged: " + req)
  }
})

// ————————————— T11 fallback 链每环 —————————————

test("T11: resolution chain fallback; all rings missing → no LLM route available", async () => {
  // 仅 round1 完整组，convergence 缺失 → agent route
  const config = { advisor: { round1: { provider: "R1", model: "R1m" } } }
  const agentOpts = { provider: "ap", model: "am" }
  const rConv = resolveAdvisorRoute({ config, override: null, agentOpts, advisorRound: 1 })
  assert.equal(rConv.ok, true)
  assert.equal(rConv.pairSource, "agent route")
  // 全链缺失 → ok:false（runAdvisorReview 报 "no LLM route available"）
  const rNone = resolveAdvisorRoute({ config: {}, override: null, agentOpts: {}, advisorRound: 0 })
  assert.equal(rNone.ok, false)
  const s = sessionState("t11-no-route")
  s.advisorRound = 0
  s.advisorOverride = null
  const agent = {
    session: { id: "t11-no-route", header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] },
    options: {},
  }
  const out = await runAdvisorReview({ llm: {} }, { agent, config: {}, reviewType: "code", paths: ["package.json"] })
  assert.ok(out.includes("no LLM route available"), out)
  dropSession("t11-no-route")
})

// ————————————— T12 legacy 与 round1 共存 —————————————

test("T12: when advisor.round1 and legacy advisor.* coexist, round1 fields take priority", () => {
  const config = {
    advisor: {
      round1: { provider: "R1p", model: "R1m", timeoutMs: 700000 },
      provider: "legacy-p", model: "legacy-m", timeoutMs: 400000,
    },
  }
  const r = resolveAdvisorRoute({ config, override: null, agentOpts: { provider: "ap", model: "am" }, advisorRound: 0 })
  assert.equal(r.provider, "R1p")
  assert.equal(r.model, "R1m")
  assert.equal(r.timeoutMs, 700000)
  assert.equal(r.warnings.length, 0)
})

// ————————————— T13 非法 timeoutMs 忽略并警告 —————————————

test("T13: invalid timeoutMs (non-number / <=0 / over cap) ignored with warning, defaults apply", () => {
  for (const bad of [-5, "abc", 9999999999, NaN, Infinity]) {
    const config = { advisor: { round1: { provider: "A", model: "M", timeoutMs: bad } } }
    const r = resolveAdvisorRoute({ config, override: null, agentOpts: { provider: "x", model: "y" }, advisorRound: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.timeoutMs, 600000, "default for bad " + String(bad))
    assert.equal(r.timeoutSource, "default")
    assert.ok(r.warnings.some((w) => w.includes("timeoutMs") && w.includes("ignoring invalid")), String(bad))
  }
  // 非法 override timeoutMs 回落全局合法值
  const config = { advisor: { round1: { timeoutMs: 900000 } } }
  const r = resolveAdvisorRoute({ config, override: { round1: { timeoutMs: "slow" } }, agentOpts: { provider: "x", model: "y" }, advisorRound: 0 })
  assert.equal(r.timeoutMs, 900000)
  assert.ok(r.warnings.some((w) => w.includes("session override round1.timeoutMs")))
})

// ————————————— T16 isApprovalVerdict（F8 v3 语义） —————————————

test("T16: isApprovalVerdict v3 — severity-cell anchored, fix-marked red rows pass, prose 🔴 does not block", () => {
  // 通过：无表格 / 无未解决 🔴
  assert.equal(isApprovalVerdict("The design is approved."), true)
  assert.equal(isApprovalVerdict("All issues verified. The design is approved."), true)
  // 通过：severity 单元格 🔴 但行内带修复标记（收敛轮验证表核销）
  const fixedTable = "| # | Orig# | File | Severity | Status | Notes |\n"
    + "| 1 | 2 | lib/a.mjs | 🔴 | Fixed | addressed |\n"
    + "| 2 | 1 | lib/b.mjs | 🟡 | Fixed | done |\n"
    + "The design is approved."
  assert.equal(isApprovalVerdict(fixedTable), true)
  // 通过：加粗 🔴 单元格 + 修复标记（RED_SEVERITY_CELL_RE 允许 ** 包裹）
  const boldFixed = "| # | Severity | Status |\n| 1 | **🔴** | 已修复 |\nDesign approved."
  assert.equal(isApprovalVerdict(boldFixed), true)
  // 通过：描述文本引用 🔴 字样不参与判定（v3）；severity 单元格非 🔴
  const proseRed = "| # | Severity | Issue |\n| 1 | 🟡 | the 🔴 mentioned in prose must not block |\napproved"
  assert.equal(isApprovalVerdict(proseRed), true)
  // 通过：表格外总结句含 "no 🔴" 字样 → 不误拒（v1/v2 踩坑回归）
  assert.equal(isApprovalVerdict("no unfixed 🔴 remain — the design is approved."), true)
  // 不签发：severity 单元格 = 🔴 且无修复标记 → 未解决
  assert.equal(isApprovalVerdict("| 1 | 🔴 | something broken |\nThe design is approved."), false)
  // 不签发：结论词在否定语境（含间隔形式 code review #1）
  assert.equal(isApprovalVerdict("The design is not approved."), false)
  assert.equal(isApprovalVerdict("The design will not be approved."), false)
  assert.equal(isApprovalVerdict("| 1 | 🟡 | minor |\n设计未通过"), false)
  assert.equal(isApprovalVerdict("该设计未能通过评审。"), false)
  assert.equal(isApprovalVerdict("该设计没有通过评审。"), false)
  assert.equal(isApprovalVerdict("该设计不会通过。"), false)
  assert.equal(isApprovalVerdict("该设计不能通过。"), false)
  assert.equal(isApprovalVerdict("The design remains unapproved."), false)
  assert.equal(isApprovalVerdict("没法通过——存在致命缺陷。"), false)
  assert.equal(isApprovalVerdict("The design cannot be approved."), false)
  // 不签发：无通过性结论词
  assert.equal(isApprovalVerdict("Everything is fine."), false)
  // 不签发：severity 单元格 🔴 Critical 后缀（无修复标记）→ 未解决（code review #8②）
  assert.equal(isApprovalVerdict("| 1 | Feasibility | 🔴 Critical | broken |\nThe design is approved."), false)
  // 不签发：前导空格表格行 + 🔴（无修复标记）→ 未解决（code review #8③）
  assert.equal(isApprovalVerdict("  | 1 | 🔴 | broken |\nThe design is approved."), false)
  // 不签发：🔴 行 Status 为否定/待定（not done / pending）→ 不算已修复（code review #8①）
  assert.equal(isApprovalVerdict("| 1 | 1 | a.md | 🔴 | Not done | still open |\napproved"), false)
  assert.equal(isApprovalVerdict("| 1 | 1 | a.md | 🔴 | pending | open |\napproved"), false)
  assert.equal(isApprovalVerdict("| 1 | 1 | a.md | 🔴 | 未修复 | open |\napproved"), false)
  assert.equal(isApprovalVerdict("| 1 | 1 | a.md | 🔴 | not addressed | open |\napproved"), false)
  assert.equal(isApprovalVerdict("| 1 | Feasibility | 🔴(must fix) | broken |\napproved"), false)
})

// ————————————— T18 eng_coder spawn 资源（F9） —————————————

function makeEngRunFixture(id) {
  const state = sessionState(id)
  state.engineering = true
  state.designToken = randomUUID() + ":" + (Date.now() + 3600_000) // D-30：两段式
  return state
}

function makeEngDeps(id, config, started, dshHome) {
  const subagents = {
    async start(kind, req) {
      started.push(req)
      return {
        result: Promise.resolve({
          output: [{ type: "text", text: "delivered ok\n\nTouched files: lib/a.mjs" }],
          stopReason: "completed", diagnostic: null,
        }),
        dispose: async () => {},
      }
    },
  }
  const agent = {
    session: { id, header: { cwd: PLUGIN_DIR } },
    options: { provider: "p", model: "m" },
  }
  return { ctx: { subagents }, agent, config, signal: undefined, configDefaultEngineering: false, storPathOverride: dshHome }
}

test("T18: eng_coder spawn agentOptions carry maxTokens (≥ config or default 65536) + reasoningEffort + ask_user_question deny", async () => {
  const started = []
  const state = makeEngRunFixture("t18a")
  const token = state.designToken
  const out = await runEngCoder(
    makeEngDeps("t18a", { engCoderMaxTokens: 99999, engCoderEffort: "high" }, started),
    { task: "implement x", designToken: token },
  )
  assert.ok(out.includes("eng_coder delivery:"), out)
  const req = started[0]
  assert.equal(req.agentOptions.maxTokens, 99999)
  assert.equal(req.agentOptions.reasoningEffort, "high")
  assert.ok(req.toolFilter.deny.includes("ask_user_question"))
  assert.ok(req.agentOptions.provider === "p" && req.agentOptions.model === "m")
  dropSession("t18a")

  // 缺省：config 未配置 → 默认 65536 + effort low
  const started2 = []
  const state2 = makeEngRunFixture("t18b")
  await runEngCoder(makeEngDeps("t18b", {}, started2), { task: "implement x", designToken: state2.designToken })
  assert.equal(started2[0].agentOptions.maxTokens, 65536)
  assert.equal(started2[0].agentOptions.reasoningEffort, "low")
  dropSession("t18b")

  // N4：非法值警告并回落（不崩溃，spawn 继续）
  const started3 = []
  const state3 = makeEngRunFixture("t18c")
  const out3 = await runEngCoder(
    makeEngDeps("t18c", { engCoderMaxTokens: "abc", engCoderEffort: "turbo" }, started3),
    { task: "implement x", designToken: state3.designToken },
  )
  assert.ok(out3.includes("[thincoder-suite] warning:"), out3)
  assert.equal(started3[0].agentOptions.maxTokens, 65536)
  assert.equal(started3[0].agentOptions.reasoningEffort, "low")
  dropSession("t18c")
})

// ————————————— T19 eng_coder 任务书 git 禁令条款 —————————————

test("T19: eng_coder brief contains the destructive-git prohibition clause", () => {
  const brief = buildCoderBrief("implement the design doc", ["docs/d.md"])
  assert.ok(brief.includes("Do NOT run destructive git commands (rebase / reset --hard / clean -f / push --force) — the parent session owns git history operations."))
  assert.ok(brief.includes("implement the design doc"))
  assert.ok(brief.includes("- docs/d.md"))
})

// ————————————— T20 组环缺 provider/model → 整对下探 + N4 警告 —————————————

test("T20: merged group ring with a lone override model falls through as a pair; N4 warning names the dropped override field", () => {
  const config = { advisor: { round1: { model: "GM" } } }
  const override = { round1: { model: "OM" } }
  const r = resolveAdvisorRoute({ config, override, agentOpts: { provider: "AP", model: "AM" }, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "AP")
  assert.equal(r.model, "AM")
  assert.equal(r.pairSource, "agent route")
  assert.ok(r.warnings.some((w) => w.includes("advisor config warning")
    && w.includes("round1.model") && w.includes("no complete provider/model pair")), JSON.stringify(r.warnings))
})

// ————————————— T21 effort 环 ≠ provider/model 环 → N4 跨环警告 —————————————

test("T21: effort resolved in the merged group while the model pair falls to the agent route → cross-ring warning", () => {
  const config = { advisor: { round1: { model: "GM" } } }
  const override = { round1: { effort: "low" } }
  const r = resolveAdvisorRoute({ config, override, agentOpts: { provider: "AP", model: "AM" }, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.effort, "low")               // effort 仍按字段解析生效
  assert.equal(r.provider, "AP")
  assert.equal(r.model, "AM")
  assert.ok(r.warnings.some((w) => w.includes("advisor config warning")
    && w.includes("effort") && w.includes("agent route")
    && w.includes("effort ring differs from the model ring")), JSON.stringify(r.warnings))
})

// ————————————— F10 design token 磁盘持久化（docs/2026-09-02 §2.1/§4 T1–T5） —————————————

/** 铸造一枚格式合法的 design token（同 advisor 签发：uuid:expiresAt，两段；D-30 删除了 HMAC 签名腿）。 */
function makeF10Token(expiresAt = Date.now() + 3600_000) {
  return randomUUID() + ":" + expiresAt
}
const f10ExpiryOf = (t) => Number.parseInt(String(t).split(":")[1], 10)

/** 临时注入根（storPathOverride 语义 = DSH_HOME 目录；其下子目录按用例需要不预创建）。 */
function makeF10Root() {
  return mkdtempSync(join(tmpdir(), "thincoder-f10-"))
}
const rmRoot = (root) => { try { rmSync(root, { recursive: true, force: true }) } catch { /* 已清理 */ } }

/** 通过型 design 评审 stub：从 user 消息提取本轮 [APPROVE:<code>] 并原样回显 → 触发签发（R2）。 */
function approvingLlm() {
  return {
    stream(opts) {
      const userText = opts?.messages?.[0]?.content?.[0]?.text ?? ""
      const m = userText.match(/\[APPROVE:([0-9a-f]{8})\]/)
      const code = m ? m[1] : "00000000"
      const echo = "The design is approved with no unresolved Critical issues.\n\n[APPROVE:" + code + "]"
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: echo } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
}

/** 跑一轮「裁决通过 + 批准码回显」的 design 评审（stub LLM），返回 advisor 输出文本。
 *  config 缺省 {}（既有调用形态不变）；D-30/AC-25 用它注入 engTokenTtlMs 驱动有效期显示。 */
async function runDesignApproval(sessionId, storPathOverride, config = {}) {
  return runDesignApprovalOn(sessionId, storPathOverride,
    ["docs/2026-09-02-thincoder-suite-extensions-design.md"], config)
}

/** 同上，但可指定文档集（D-30/FR-T5 续期用例需要真实可编辑/可删除的文档）。 */
async function runDesignApprovalOn(sessionId, storPathOverride, documents, config = {}) {
  const state = sessionState(sessionId)
  state.advisorRound = 0
  state.lastAdvisorOutput = null
  state.advisorOverride = null
  const agent = {
    session: { id: sessionId, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
  return runAdvisorReview({ llm: approvingLlm() }, {
    agent,
    config,
    reviewType: "design",
    documents,
    storPathOverride,
  })
}

// ————————————— D-30/FR-T5 续期用例夹具（AC-8…AC-27） —————————————

/** 临时文档集（可编辑/可删除 → 驱动「文档已变更」与「文档不可读」两路 fail-closed）。 */
function makeDocSet(home, files) {
  const dir = join(home, "docsrc")
  mkdirSync(dir, { recursive: true })
  const out = {}
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    writeFileSync(p, content)
    out[name] = p
  }
  return out
}

/**
 * 把已签发的磁盘记录改写成「已过期但指纹保留」形态——确定性制造过期（不依赖 sleep/短 TTL，
 * 也就不会因待批令牌被重铸而丢掉快照），且**保留**签发放下的 docHash/docPaths（续期判定的唯一输入）。
 * 同步把内存态 state.designToken 换成同一串，使 eng.mjs 走进过期子分支。
 * @returns {string} 过期令牌串（同 uuid）
 */
function expireIssuedRecord(sid, home) {
  const storePath = resolveTokenStorePath(home)
  const data = JSON.parse(readFileSync(storePath, "utf8"))
  const rec = data.tokens[sid]
  const expiredToken = String(rec.token).split(":")[0] + ":" + (Date.now() - 60_000)
  data.tokens[sid] = { ...rec, token: expiredToken, expiresAt: Date.now() - 60_000 }
  writeFileSync(storePath, JSON.stringify(data, null, 2) + "\n")
  sessionState(sid).designToken = expiredToken
  return expiredToken
}

// ————————————— F10-T1（§4 T1）：签发落盘，mkdir recursive 隐含验证 —————————————

test("F10-T1: design approval persists this sessionId's token record at the injected path (mkdir implicit)", async () => {
  const root = makeF10Root()
  const home = join(root, "a", "b") // 父目录不预创建——验证 mkdirSync recursive 真被调用（评审 #2）
  const sid = "f10-t1-" + randomUUID()
  try {
    const out = await runDesignApproval(sid, home)
    assert.match(out, /Approved\. Pass this exact token to eng_coder/, out)
    const m = out.match(/designToken parameter\): (\S+)/)
    assert.ok(m, "issued token echoed in the approval output: " + out)
    const issued = m[1]
    assert.equal(sessionState(sid).designToken, issued, "memory token unchanged (first storage)")
    const storePath = resolveTokenStorePath(home)
    assert.ok(storePath && existsSync(storePath), "store file exists at injected path: " + storePath)
    const file = JSON.parse(readFileSync(storePath, "utf8"))
    assert.equal(file.version, 1)
    const rec = file.tokens[sid]
    assert.ok(rec, "this sessionId has a disk record")
    assert.equal(rec.token, issued)
    assert.equal(typeof rec.issuedAt, "number")
    assert.ok(rec.issuedAt <= Date.now(), "issuedAt is a wall-clock timestamp")
    assert.equal(rec.expiresAt, f10ExpiryOf(issued), "expiresAt = token second segment")
    assert.ok(rec.expiresAt > Date.now(), "fresh token not expired")
  } finally {
    dropSession(sid)
    rmRoot(root)
  }
})

// ————————————— F10-T2（§4 T2）：空内存 + 盘上有效 token → 查盘放行并回填 —————————————

test("F10-T2: empty memory + valid on-disk token → eng_coder validates via disk and refills state.designToken", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "f10-t2-" + randomUUID()
  const state = sessionState(sid)
  state.engineering = true
  const token = makeF10Token()
  assert.equal(state.designToken, null, "empty memory (restart simulation)")
  assert.equal(saveTokenRecord(sid, { token, issuedAt: Date.now(), expiresAt: f10ExpiryOf(token) }, home), true)
  const started = []
  try {
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: token })
    assert.ok(out.includes("eng_coder delivery:"), out)
    assert.equal(state.designToken, token, "state refilled from the disk record")
    assert.equal(started.length, 1, "spawn proceeded after disk validation")
    assert.equal(loadTokenRecord(sid, home).token, token)
  } finally {
    dropSession(sid)
    rmRoot(root)
  }
})

// ————————————— F10-T2b（分歧审计 D1 / 评审 #1）：空内存 + 盘上有效记录 + 传入错误 token
//              → 不回填、never-issued 拒绝、写门禁不被间接打开 —————————————

test("F10-T2b: empty memory + valid on-disk record + wrong token → no refill, never-issued rejection, write gate stays closed", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "f10-t2b-" + randomUUID()
  const state = sessionState(sid)
  state.engineering = true
  const token = makeF10Token()
  assert.equal(state.designToken, null, "empty memory (restart simulation)")
  assert.equal(saveTokenRecord(sid, { token, issuedAt: Date.now(), expiresAt: f10ExpiryOf(token) }, home), true)
  const started = []
  try {
    const wrong = makeF10Token() // 不同 token（签发记录之外）
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: wrong })
    assert.ok(out.includes("no design token issued") || out.includes("does not match the latest issued record"), out)
    assert.equal(started.length, 0, "no spawn on wrong token")
    assert.equal(state.designToken, null, "valid on-disk token must NOT refill state for a wrong submitted token (write gate stays closed)")
  } finally {
    dropSession(sid)
    rmRoot(root)
  }
})

// ————————————— F10-T3（§4 T3）：盘上记录过期 → expired 提示，不误放行 —————————————

test("F10-T3: expired on-disk record → eng_coder rejects with the expired hint (no bypass)", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "f10-t3-" + randomUUID()
  const state = sessionState(sid)
  state.engineering = true
  const expired = makeF10Token(Date.now() - 1000) // 早已过期
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  // 直写盘模拟「签发时有效、随后自然过期」的记录——saveTokenRecord 会自我清扫过期条目，无法用它播种
  writeFileSync(resolveTokenStorePath(home), JSON.stringify({
    version: 1,
    tokens: { [sid]: { token: expired, issuedAt: Date.now() - 7200_000, expiresAt: f10ExpiryOf(expired) } },
  }))
  try {
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("design token expired"), out)
    assert.ok(!out.includes("eng_coder delivery:"), "must not spawn on an expired token")
    assert.equal(started.length, 0)
  } finally {
    dropSession(sid)
    rmRoot(root)
  }
})

// ————————————— F10-T4（§4 T4）：写入时全量清扫所有 session 的过期条目 —————————————

test("F10-T4: save sweeps expired records of ALL sessions (incl. others) and keeps live ones", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sidLive = "f10-t4-live"
  const sidExp1 = "f10-t4-exp1"
  const sidExp2 = "f10-t4-exp2"
  const sidNew = "f10-t4-new"
  const liveTok = makeF10Token(Date.now() + 60_000)
  const newTok = makeF10Token()
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  writeFileSync(resolveTokenStorePath(home), JSON.stringify({
    version: 1,
    tokens: {
      [sidLive]: { token: liveTok, issuedAt: Date.now() - 1000, expiresAt: f10ExpiryOf(liveTok) },
      [sidExp1]: { token: makeF10Token(Date.now() - 1000), issuedAt: Date.now() - 3_600_000, expiresAt: Date.now() - 60_000 },
      [sidExp2]: { token: makeF10Token(Date.now() - 1000), issuedAt: Date.now() - 3_600_000, expiresAt: Date.now() - 30_000 },
    },
  }))
  try {
    assert.equal(saveTokenRecord(sidNew, { token: newTok, issuedAt: Date.now(), expiresAt: f10ExpiryOf(newTok) }, home), true)
    const file = JSON.parse(readFileSync(resolveTokenStorePath(home), "utf8"))
    const sids = Object.keys(file.tokens).sort()
    assert.deepEqual(sids, [sidLive, sidNew].sort(), "expired entries of other sessions swept on write")
    assert.equal(file.tokens[sidLive].token, liveTok, "live entry kept")
    assert.equal(file.tokens[sidNew].token, newTok, "this session's entry written")
  } finally {
    rmRoot(root)
  }
})

// ————————————— F10-T5（§4 T5）：不可写路径 → 签发仍成功；损坏文件 + 空内存 → 拒绝不崩溃 —————————————

test("F10-T5: unwritable store path → signing still succeeds (warn, no throw); corrupt file + empty memory → eng_coder rejects without crashing", async () => {
  const root = makeF10Root()
  const sidA = "f10-t5a-" + randomUUID()
  try {
    // (a) 存储路径不可写（注入 home 落在已存在文件之下）→ saveTokenRecord 仅 warn；签发成功、内存态兜底
    const blocker = join(root, "blk")
    writeFileSync(blocker, "a regular file")
    const badHome = join(blocker, "sub") // mkdir 必然失败（父级是文件）
    const outA = await runDesignApproval(sidA, badHome)
    assert.match(outA, /Approved\. Pass this exact token to eng_coder/, outA)
    assert.ok(sessionState(sidA).designToken, "token still issued in memory despite disk failure")
    assert.ok(!existsSync(resolveTokenStorePath(badHome)), "nothing written under the blocker path")
  } finally {
    dropSession(sidA)
    rmRoot(root)
  }
  // (b) 损坏文件 + 空内存 → eng_coder 拒绝（never-issued 提示）且不崩溃（评审 #1）
  const root2 = makeF10Root()
  const home2 = join(root2, "home")
  const sidB = "f10-t5b-" + randomUUID()
  try {
    const stateB = sessionState(sidB)
    stateB.engineering = true
    mkdirSync(join(home2, ".thincoder"), { recursive: true })
    writeFileSync(resolveTokenStorePath(home2), "{ this is not json !!!")
    const started = []
    const outB = await runEngCoder(makeEngDeps(sidB, {}, started, home2), { task: "implement x", designToken: makeF10Token() })
    assert.ok(outB.includes("no design token issued"), outB)
    assert.ok(!outB.includes("eng_coder delivery:"), "must not spawn")
    assert.equal(started.length, 0)
  } finally {
    dropSession(sidB)
    rmRoot(root2)
  }
})

// ————————————— D-30/AC-25：签发消息的有效期显示（TTL > 24h → 日期而非裸 HH:MM） —————————————
// 落点 = advisor.mjs 的批准返回行「（有效至 <expiryLabel>，TTL engTokenTtlMs）」：7d 令牌下
// 「HH:MM」显示的是某个今天/昨天的钟点，无意义 → 改日期（设计档 §3 FR-T6 末段）。

test("AC-25: the issued-token message shows a DATE for a 7d TTL and keeps HH:MM for a 1h TTL (real approval path)", async () => {
  const root = makeF10Root()
  try {
    const sid7 = "ac25-7d-" + randomUUID()
    const s7 = sessionState(sid7)
    s7.pendingDesignToken = null // 清待批令牌 → 按注入 config 重新铸造（否则复用上一枚）
    s7.pendingDocPaths = []
    const out7 = await runDesignApproval(sid7, join(root, "h7"), { engTokenTtlMs: 7 * 24 * 3600 * 1000 })
    assert.match(out7, /Approved\. Pass this exact token to eng_coder/, out7)
    assert.match(out7, /（有效至 \d{4}-\d{2}-\d{2}，TTL engTokenTtlMs）/, "7d → 日期: " + out7)
    dropSession(sid7)

    const sid1 = "ac25-1h-" + randomUUID()
    const s1 = sessionState(sid1)
    s1.pendingDesignToken = null
    s1.pendingDocPaths = []
    const out1 = await runDesignApproval(sid1, join(root, "h1"), { engTokenTtlMs: 3600_000 })
    assert.match(out1, /（有效至 \d{2}:\d{2}，TTL engTokenTtlMs）/, "1h → HH:MM（既有语义不回退）: " + out1)
    dropSession(sid1)
  } finally { rmRoot(root) }
})

// ═════════════════ D-30 验收标准 ACS：审批回显负例（设计档 §5 AC-6） ═════════════════
// 判据必须走**真实签发路径的返回值**：审计（AC-5 注记）已证明「从提示词正则抠出 code 再原样
// 回显」是同义反复——派生被换成常量串时那种写法仍全绿。故本用例预置固定 uuid 的待批令牌，
// 期望码用**与实现无关**的硬编码常量（sha256(uuid).slice(0,8) = c812e1ed，同 AC-5 的独立对拍），
// 再让 stub 评审正文回显「错码 / 无码 / 旧格式」三种形态；正向对照证明同一夹具确实走得通到
// 签发点（防「路径根本没跑到」的假绿）。

/** 待批令牌（固定 uuid，故其批准码是常量 c812e1ed——本用例不调用派生函数求期望值）。 */
const AC6_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const AC6_CODE = "c812e1ed"
/** 通过性裁决正文（与 approvingLlm 同款措辞——isApprovalVerdict 命中的前提）。 */
const AC6_PASS_VERDICT = "The design is approved with no unresolved Critical issues."

/** 脚本化评审正文的 design 评审（正文完全可控；其余走真实 runAdvisorReview）。 */
async function runDesignReviewWithReply(sessionId, storPathOverride, replyText) {
  const state = sessionState(sessionId)
  state.advisorRound = 0
  state.lastAdvisorOutput = null
  state.advisorOverride = null
  const agent = {
    session: { id: sessionId, header: { cwd: PLUGIN_DIR }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
  const llm = {
    stream: () => (async function* () {
      yield { type: "block-end", block: { type: "text", text: replyText } }
      yield { type: "finish", reason: { kind: "stop" } }
    })(),
  }
  return runAdvisorReview({ llm }, { agent, config: {}, reviewType: "design", documents: [], storPathOverride })
}

test("AC-6: approval echo negatives — wrong code / no code / legacy [DESIGN-TOKEN:...] all issue NO token (real approval path)", async () => {
  const root = makeF10Root()
  const pendingToken = AC6_UUID + ":" + (Date.now() + 3600_000)
  /** 跑一条负例：预置同一待批令牌 → 注入可控评审正文 → 从**真实返回文本 + state + 落盘**判有无签发。 */
  const runCase = async (sid, home, replyText) => {
    const st = sessionState(sid)
    st.engineering = true
    st.pendingDesignToken = pendingToken // 固定 uuid 的待批令牌（未过期 → runAdvisorReview 不重铸）
    st.pendingDocPaths = []
    const out = await runDesignReviewWithReply(sid, home, replyText)
    return { out, st }
  }
  try {
    // ——— ① 回显**错误**批准码 → 不签发 ———
    const sid1 = "ac6-wrong-" + randomUUID()
    const r1 = await runCase(sid1, join(root, "h1"), AC6_PASS_VERDICT + "\n\n[APPROVE:deadbeef]")
    assert.ok(!r1.out.includes("Approved. Pass this exact token to eng_coder"), "错码不得签发: " + r1.out)
    assert.ok(r1.out.includes("批准码校验失败"), "裁决本身是通过的——拒绝的唯一来源是批准码（防「路径没跑到」的假绿）: " + r1.out)
    assert.equal(r1.st.designToken, null, "错码 → state 无签发")
    assert.equal(loadTokenRecord(sid1, join(root, "h1")), null, "错码 → 磁盘无签发记录")
    dropSession(sid1)

    // ——— ② 回复中**没有**批准码 → 不签发 ———
    const sid2 = "ac6-nocode-" + randomUUID()
    const r2 = await runCase(sid2, join(root, "h2"), AC6_PASS_VERDICT)
    assert.ok(!r2.out.includes("Approved. Pass this exact token to eng_coder"), "无码不得签发: " + r2.out)
    assert.ok(r2.out.includes("批准码校验失败"), "同上：裁决通过但缺回显: " + r2.out)
    assert.equal(r2.st.designToken, null, "无码 → state 无签发")
    assert.equal(loadTokenRecord(sid2, join(root, "h2")), null, "无码 → 磁盘无签发记录")
    dropSession(sid2)

    // ——— ③ 回显旧格式 [DESIGN-TOKEN:<token>] → 仍被忽略（且这里回显的是**正确**的令牌本体，
    //        比「伪造成令牌」更强的负例：旧通道整体废除，D8 干净切换） ———
    const sid3 = "ac6-legacy-" + randomUUID()
    const r3 = await runCase(sid3, join(root, "h3"), AC6_PASS_VERDICT + "\n\n[DESIGN-TOKEN:" + pendingToken + "]")
    assert.ok(!r3.out.includes("Approved. Pass this exact token to eng_coder"), "旧格式回显不得签发: " + r3.out)
    assert.ok(r3.out.includes("批准码校验失败"), "同上：裁决通过但旧通道不触发签发: " + r3.out)
    assert.equal(r3.st.designToken, null, "旧格式 → state 无签发")
    assert.equal(loadTokenRecord(sid3, join(root, "h3")), null, "旧格式 → 磁盘无签发记录")
    dropSession(sid3)

    // ——— 正向对照：同一夹具 + 正确码（硬编码常量，不经派生函数）→ 必须签发 ———
    const sid4 = "ac6-good-" + randomUUID()
    const home4 = join(root, "h4")
    const r4 = await runCase(sid4, home4, AC6_PASS_VERDICT + "\n\n[APPROVE:" + AC6_CODE + "]")
    assert.ok(r4.out.includes("Approved. Pass this exact token to eng_coder"), "正确码 → 签发（夹具活着的证明）: " + r4.out)
    assert.ok(!r4.out.includes("批准码校验失败"), "正确码不得报校验失败")
    assert.equal(r4.st.designToken, pendingToken, "state 记录签发令牌")
    assert.equal(loadTokenRecord(sid4, home4)?.token, pendingToken, "磁盘同步落盘（真实签发路径）")
    dropSession(sid4)
  } finally { rmRoot(root) }
})

// ═════════════════ D-30 验收标准 ACS：续期 / 清扫类（设计档 §5 AC-8/9/11/13/14/15/18/19/27） ═════════════════
// 本批最重要的验收面：驱动**真实签发路径**（advisor 批准落盘 docHash）→ 确定性过期（保留指纹）
// → eng_coder 四路判定。AC-17（清扫回归）在 session-state.test.mjs（token-store 直测）。

test("AC-8: renewal happy path — document set unchanged → eng_coder proceeds and returns a NEW token (same uuid, ≈now+TTL); state + disk updated", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac8-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A v1", "b.md": "B v1" })
    const bound = [docs["a.md"], docs["b.md"]]
    const out1 = await runDesignApprovalOn(sid, home, bound, {})
    assert.match(out1, /Approved\. Pass this exact token to eng_coder/, out1)
    const rec0 = loadTokenRecord(sid, home)
    assert.equal(typeof rec0.docHash, "string", "签发落盘带 docHash（FR-T8 保存缺口已补）")
    assert.deepEqual(rec0.docPaths.slice().sort(), bound.map(normalizeDocPath).sort(), "落盘路径表 = 归一后集合")
    assert.equal(rec0.docHash, computeDocHash(rec0.docPaths).hash, "落盘指纹 = 按落盘路径表重算的结果")

    const expired = expireIssuedRecord(sid, home)
    const started = []
    const out2 = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out2.includes("eng_coder delivery:"), "续期后放行（不重评）: " + out2)
    assert.ok(out2.includes("design token RENEWED"), "续期回执随工具返回带出: " + out2)
    const fresh = sessionState(sid).designToken
    assert.notEqual(fresh, expired, "state 换成新令牌")
    assert.equal(fresh.split(":")[0], expired.split(":")[0], "续期 = 同一 uuid")
    assert.ok(Math.abs((Number(fresh.split(":")[1]) - Date.now()) - 7 * 24 * 3600 * 1000) < 5000,
      "新 expiresAt ≈ now + 缺省 7d（实测 " + (Number(fresh.split(":")[1]) - Date.now()) + "ms）")
    assert.ok(out2.includes(fresh), "**新令牌串在返回文本里**（FR-T5 返回契约：否则下一次调用必 mismatch）")
    assert.ok(out2.includes("Replace the copy you hold"), "附「替换你手里的副本」指引")
    const rec1 = loadTokenRecord(sid, home)
    assert.equal(rec1.token, fresh, "磁盘与内存同步更新")
    assert.equal(rec1.docHash, rec0.docHash, "续期保留指纹（续期输入不被清）")
    assert.deepEqual(rec1.docPaths, rec0.docPaths, "续期保留路径表")
    assert.equal(started.length, 1, "续期后照常 spawn")
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-9: editing a bound document → renewal refused with 'has CHANGED'; no spawn, state/disk untouched", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac9-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A v1", "b.md": "B v1" })
    await runDesignApprovalOn(sid, home, [docs["a.md"], docs["b.md"]], {})
    const expired = expireIssuedRecord(sid, home)
    const before = loadTokenRecord(sid, home)
    writeFileSync(docs["a.md"], "A v2 — edited after approval") // 文档集漂移
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("design document set has CHANGED"), out)
    assert.ok(out.includes("文档已变更"), "中文文案可区分: " + out)
    assert.ok(out.includes("Re-run the design review"), "指向重评")
    assert.ok(!out.includes("eng_coder delivery:"), "拒绝路径不得 spawn")
    assert.equal(started.length, 0, "no spawn")
    assert.equal(sessionState(sid).designToken, expired, "state 不顺延（仍为过期串）")
    assert.deepEqual(loadTokenRecord(sid, home), before, "磁盘记录未被改写（拒绝路径不写盘）")
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-11: a bound document deleted / unreadable → renewal refused (fail-closed) and eng_coder does not crash", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac11-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A", "b.md": "B" })
    await runDesignApprovalOn(sid, home, [docs["a.md"], docs["b.md"]], {})
    const expired = expireIssuedRecord(sid, home)
    rmSync(docs["b.md"]) // 文档被删
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("no longer readable"), "fail-closed 文案: " + out)
    assert.ok(out.includes(normalizeDocPath(docs["b.md"])), "点名不可读文档（诊断可见）")
    assert.ok(!out.includes("eng_coder delivery:"), "拒绝路径不得 spawn")
    assert.equal(started.length, 0)
    assert.equal(sessionState(sid).designToken, expired, "state 不变")
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-13: a review with an EMPTY document set writes no docHash → renewal is refused", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac13-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const out1 = await runDesignApprovalOn(sid, home, [], {})
    assert.match(out1, /Approved\. Pass this exact token to eng_coder/, out1)
    const rec = loadTokenRecord(sid, home)
    assert.equal(rec.docHash, undefined, "空文档集 → 不写 docHash（决策 D6：空集 hash 恒等会让护栏真空为真）")
    assert.equal(rec.docPaths, undefined)
    const expired = expireIssuedRecord(sid, home)
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("cannot be renewed automatically"), out)
    assert.ok(out.includes("无法续期"), "中文文案可区分: " + out)
    assert.ok(!out.includes("eng_coder delivery:"))
    assert.equal(started.length, 0)
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-14: restart (head-line scenario) — empty memory + expired on-disk record WITH docHash + unchanged docs → refill → renew → proceed", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac14-" + randomUUID()
  try {
    const docs = makeDocSet(home, { "a.md": "A", "b.md": "B" })
    await runDesignApprovalOn(sid, home, [docs["a.md"], docs["b.md"]], {})
    const expired = expireIssuedRecord(sid, home)
    dropSession(sid)                    // 进程重启模拟：内存态全丢
    const state = sessionState(sid)     // 新槽：designToken === null
    assert.equal(state.designToken, null, "内存空")
    assert.equal(loadTokenRecord(sid, home).token, expired, "盘上只剩过期记录（带 docHash）")
    state.engineering = true
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("eng_coder delivery:"), "回填 → 续期 → 放行（头号场景）: " + out)
    assert.ok(out.includes("design token RENEWED"), out)
    assert.equal(started.length, 1)
    const fresh = sessionState(sid).designToken
    assert.notEqual(fresh, expired, "回填后顺延")
    assert.equal(fresh.split(":")[0], expired.split(":")[0], "同一 uuid")
    assert.equal(loadTokenRecord(sid, home).token, fresh, "磁盘同步")
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-15: persistence failure during renewal → token still renewed in memory + returned, with a loud warn (N2 fail-safe)", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac15-" + randomUUID()
  const storeDir = join(home, ".thincoder")
  const storePath = resolveTokenStorePath(home)
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A" })
    await runDesignApprovalOn(sid, home, [docs["a.md"]], {})
    const expired = expireIssuedRecord(sid, home)
    // 只读化：Windows 上 rename 覆盖只读目标 → EPERM；POSIX 上目录不可写 → tmp 创建失败。
    // 两条路径都让「读得到、写不了」，正是 N2 要模拟的持久化故障。
    chmodSync(storePath, 0o444)
    chmodSync(storeDir, 0o555)
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("eng_coder delivery:"), "写盘失败不得砖化会话（内存态继续服务）: " + out)
    assert.ok(out.includes("FAILED to persist"), "响亮告警并入返回文本: " + out)
    assert.ok(out.includes("design token RENEWED"), out)
    const fresh = sessionState(sid).designToken
    assert.notEqual(fresh, expired, "内存态已顺延")
    assert.ok(out.includes(fresh), "新令牌串照常回传（返回契约不因写盘失败而失效）")
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).tokens[sid].token, expired,
      "盘上仍是旧记录（证明这次续期确实没写进去，告警不是空话）")
    assert.equal(started.length, 1, "续期有效 → 照常 spawn")
  } finally {
    try { chmodSync(storeDir, 0o777) } catch { /* 目录可能不存在 */ }
    try { chmodSync(storePath, 0o666) } catch { /* 同上 */ }
    dropSession(sid)
    rmRoot(root)
  }
})

test("AC-18: two eng_coder calls in one session with the SAME expired token → the second gets the SUPERSEDED message", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac18-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A" })
    await runDesignApprovalOn(sid, home, [docs["a.md"]], {})
    const expired = expireIssuedRecord(sid, home)
    const started1 = []
    const out1 = await runEngCoder(makeEngDeps(sid, {}, started1, home), { task: "first", designToken: expired })
    assert.ok(out1.includes("design token RENEWED"), "第一个 eng_coder 触发续期")
    const started2 = []
    const out2 = await runEngCoder(makeEngDeps(sid, {}, started2, home), { task: "second", designToken: expired })
    assert.ok(out2.includes("SUPERSEDED"), out2)
    assert.ok(out2.includes("已被本次会话的续期取代"), "中文文案: " + out2)
    assert.ok(out2.includes("Use the NEW token returned by that eng_coder call"),
      "指明出路：用上一次 eng_coder 返回的新令牌（§3 FR-T5 定稿）: " + out2)
    assert.ok(!out2.includes("eng_coder delivery:"), "第二个调用必须被拒（旧串已失效）")
    assert.equal(started2.length, 0)
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-19: narrowing attack — round 1 binds [A,B], the approval round passes only [A] → the persisted snapshot stays [A,B]", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac19-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A", "b.md": "B" })
    const expected = [docs["a.md"], docs["b.md"]].map(normalizeDocPath).sort()
    const out1 = await runDesignApprovalOn(sid, home, [docs["a.md"], docs["b.md"]], {})
    assert.match(out1, /Approved\. Pass this exact token to eng_coder/, out1)
    assert.deepEqual(loadTokenRecord(sid, home).docPaths, expected, "首轮快照 = [A,B]")
    // 同一评审会话（待批令牌仍有效）的收窄轮：只传 [A]
    const out2 = await runDesignApprovalOn(sid, home, [docs["a.md"]], {})
    assert.match(out2, /Approved\. Pass this exact token to eng_coder/, out2)
    assert.deepEqual(loadTokenRecord(sid, home).docPaths, expected, "收窄轮不缩窄快照（并集语义，评审 #2）")
    // B 漂移 → 续期被拒（快照里确实还绑着 B——收窄攻击失效）
    const expired = expireIssuedRecord(sid, home)
    writeFileSync(docs["b.md"], "B v2")
    const started = []
    const out3 = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out3.includes("design document set has CHANGED"), out3)
    assert.equal(started.length, 0)
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-27: union snapshot — first mint [A], a later round joins [B,C] → snapshot [A,B,C]; a B drift then refuses renewal", async () => {
  const root = makeF10Root()
  const home = join(root, "home")
  const sid = "ac27-" + randomUUID()
  sessionState(sid).engineering = true // 工程模式 ON：让判定真正走到 token 分支（不因 eng OFF 误绿）
  try {
    const docs = makeDocSet(home, { "a.md": "A", "b.md": "B", "c.md": "C" })
    const expected = [docs["a.md"], docs["b.md"], docs["c.md"]].map(normalizeDocPath).sort()
    await runDesignApprovalOn(sid, home, [docs["a.md"]], {})
    assert.deepEqual(loadTokenRecord(sid, home).docPaths, [docs["a.md"]].map(normalizeDocPath), "首铸轮 = [A]")
    await runDesignApprovalOn(sid, home, [docs["b.md"], docs["c.md"]], {})
    const rec = loadTokenRecord(sid, home)
    assert.deepEqual(rec.docPaths, expected, "后续轮并入 [B,C] → 快照 [A,B,C]（历轮并集）")
    assert.equal(rec.docHash, computeDocHash(expected).hash, "指纹覆盖并集")
    // 并入的 B 漂移 → 续期被拒（若快照只绑首轮 [A]，此处会误放行）
    const expired = expireIssuedRecord(sid, home)
    writeFileSync(docs["b.md"], "B v2 — drifted after being joined")
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, {}, started, home), { task: "implement x", designToken: expired })
    assert.ok(out.includes("design document set has CHANGED"), out)
    assert.ok(out.includes("文档已变更") && out.includes(normalizeDocPath(docs["b.md"])),
      "拒绝文案点名变更的文档集（含并入轮加入的 B）: " + out)
    assert.ok(!out.includes("eng_coder delivery:"))
    assert.equal(started.length, 0)
  } finally { dropSession(sid); rmRoot(root) }
})
