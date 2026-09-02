// advisor-config.test.mjs — 一期 host 机制单元测试（docs/2026-09-01-advisor-config-design.md §5.2）
// + F10 design token 磁盘持久化（docs/2026-09-02-thincoder-suite-extensions-design.md §4，T1–T5）。
// node:test 零依赖：stub ctx.llm.stream 为 async generator 收集 opts/消息，支持注入
// 「静默流」「稳定涓流」「脚本化流（先工具后静默）」三种 chunk 时序（T6/T7/T8 秒级完成，
// 注入小 timeoutMs 200~400ms 与 stallMsOverride，不用生产示例值 300s/900s）。
// 覆盖 2026-09-01 一期 T1–T13、T16、T18–T21（T14/T15/T17 为手动冒烟，见交付说明）
// + 2026-09-02 扩展 F10 T1–T5（storPathOverride 注入临时目录，不碰真实 $DSH_HOME）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID, createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import {
  advisorGroupKey, resolveAdvisorRoute, resolveIncludeProjectGuide,
  runAdvisorConfigTool, runAdvisorToolLoop, isApprovalVerdict, runAdvisorReview,
} from "../lib/advisor.mjs"
import { buildAdvisorUserMessage } from "../lib/advisor-msgs.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { runEngCoder, buildCoderBrief } from "../lib/eng.mjs"
import { loadTokenRecord, saveTokenRecord, resolveTokenStorePath } from "../lib/token-store.mjs"

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
  const secret = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"
  const uuid = randomUUID()
  const expiresAt = Date.now() + 3600_000
  const payload = uuid + ":" + expiresAt
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
  state.designToken = payload + ":" + sig
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

/** 铸造一枚格式合法的 design token（同 advisor 签发：uuid:expiresAt:hmac16，HMAC 绑 TOKEN_SECRET）。 */
function makeF10Token(expiresAt = Date.now() + 3600_000) {
  const secret = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"
  const uuid = randomUUID()
  const payload = uuid + ":" + expiresAt
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
  return payload + ":" + sig
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

/** 跑一轮「裁决通过 + 批准码回显」的 design 评审（stub LLM），返回 advisor 输出文本。 */
async function runDesignApproval(sessionId, storPathOverride) {
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
    config: {},
    reviewType: "design",
    documents: ["docs/2026-09-02-thincoder-suite-extensions-design.md"],
    storPathOverride,
  })
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
