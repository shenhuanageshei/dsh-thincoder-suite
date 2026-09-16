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
  parseVerdict, hasUnresolvedBlockingRow, designApprovalCode,
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

  // 缺省：config 未配置 → 默认 65536 + effort medium（批 14 / D14-1：默认值与回落目标同源常量）
  const started2 = []
  const state2 = makeEngRunFixture("t18b")
  await runEngCoder(makeEngDeps("t18b", {}, started2), { task: "implement x", designToken: state2.designToken })
  assert.equal(started2[0].agentOptions.maxTokens, 65536)
  assert.equal(started2[0].agentOptions.reasoningEffort, "medium")
  dropSession("t18b")

  // N4：非法值警告并回落（不崩溃，spawn 继续）——回落目标 = 默认值（同源常量）
  const started3 = []
  const state3 = makeEngRunFixture("t18c")
  const out3 = await runEngCoder(
    makeEngDeps("t18c", { engCoderMaxTokens: "abc", engCoderEffort: "turbo" }, started3),
    { task: "implement x", designToken: state3.designToken },
  )
  assert.ok(out3.includes("[thincoder-suite] warning:"), out3)
  assert.equal(started3[0].agentOptions.maxTokens, 65536)
  assert.equal(started3[0].agentOptions.reasoningEffort, "medium")
  assert.ok(out3.includes('falling back to "medium"'), "回落警告文案随常量（不写死字面）: " + out3)
  dropSession("t18c")
})

// ————————————— T18d eng_coder 到点文案 + 前置告警（批 14 / FR-4 · D14-5 · D14-6） —————————————
//
// 锚 A7（`codexCli.` 前缀 + 第二字面仍 2 次 + failStop 仍 18）与 A8（前置告警的**两条路径**）：
// 文案的**唯一权威**是 `lib/eng.mjs` 的源码字面——`doc-hygiene.test.mjs` 的 SITES 表
// （`[2, '）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束…']`）锁着**第二字面**，
// 它由两处 `failStop` 各供一次；本用例锁**第一字面**与前置告警的落点。
/** 假 jobs 服务：只记录 `start` 调用，**不执行** `spec.run`（⇒ spawn 不发生，测试秒级）。 */
function makeFakeJobs() {
  const specs = []
  const jobs = {
    start(spec) { specs.push(spec); return "eng-dsh-fake-1" },
    get: () => null, cancel: () => false, list: () => [],
  }
  return { jobs, specs }
}

test("T18d: FR-4 三处第一字面含 codexCli. 前缀 + 第二字面仍 2 次 + 前置告警仅同步路径（budgetCap ≥ 600000）", async () => {
  // —— ① 文案面（静态源码字节，A7）——
  const engSrc = readFileSync(join(PLUGIN_DIR, "lib", "eng.mjs"), "utf8")
  const FIRST = "超内部截止（内部截止值取自 codexCli.budgetCapMs="
  assert.equal(engSrc.split(FIRST).length - 1, 3,
    "三处第一字面都须带 codexCli. 前缀（`:1017` console.warn · `:1059`/`:1080` 两条竞态分支）")
  assert.equal(engSrc.split("超内部截止（budgetCapMs=").length - 1, 0, "旧形态（无节前缀）必须零残留")
  const SECOND = "）到点，子代理已 abort—— dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages。\""
  assert.equal(engSrc.split(SECOND).length - 1, 2,
    "第二字面（被引偏的机理**不在**这里）须一字不动、仍 2 次——`doc-hygiene.test.mjs:317` 期望 2")
  assert.equal(engSrc.split("failStop(").length - 1, 18, "前置告警不得引入 failStop 调用（锁面恒 18）")

  // —— ② 前置告警：仅 dsh 同步路径（默认 background=false），spawn 前恰一条 ——
  const sidA = "t18d-sync"
  const stA = makeEngRunFixture(sidA)
  const startedA = []
  const capNote = "eng_coder dsh 同步路径的内部截止取自 codexCli.budgetCapMs=700000ms"
  const capDeps = { ...makeEngDeps(sidA, { codexCli: { budgetCapMs: 700000 } }, startedA), agent: { session: { id: sidA, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } } }
  const captured = []
  const origWarn = console.warn
  let outA
  try {
    console.warn = (...a) => { captured.push(a.map(String).join(" ")) }
    outA = await runEngCoder(capDeps, { task: "implement x", designToken: stA.designToken })
  } finally { console.warn = origWarn }
  assert.equal(captured.filter((w) => w.includes(capNote)).length, 1,
    "同步路径 budgetCap ≥ 600000 ⇒ 恰一条前置告警（spawn 前），实测 " + JSON.stringify(captured))
  assert.ok(outA.includes(capNote), "告警须随返回文本带出（主会话可见）")
  assert.equal(startedA.length, 1, "告警 fail-open：不改任何返回路径，spawn 照常发生")
  dropSession(sidA)

  // —— ③ 默认值 540000 < 600000 ⇒ 零告警（阈值方向负控）——
  const sidB = "t18d-default"
  const stB = makeEngRunFixture(sidB)
  const capB = []
  try {
    console.warn = (...a) => { capB.push(a.map(String).join(" ")) }
    await runEngCoder(makeEngDeps(sidB, {}, []), { task: "implement x", designToken: stB.designToken })
  } finally { console.warn = origWarn }
  assert.equal(capB.filter((w) => w.includes("已达或超过平台单次调用墙钟")).length, 0,
    "缺省 budgetCapMs=540000 < 600000 ⇒ 不告警（否则本告警天天误报）")
  dropSession(sidB)

  // —— ④ background=true 且 jobs 可用 ⇒ 派发后台，**不经同步路径**（AC-13 的第二条腿）——
  const sidC = "t18d-bg-jobs"
  const stC = makeEngRunFixture(sidC)
  const startedC = []
  const { jobs, specs } = makeFakeJobs()
  const capC = []
  let outC
  try {
    console.warn = (...a) => { capC.push(a.map(String).join(" ")) }
    outC = await runEngCoder(
      { ...makeEngDeps(sidC, { codexCli: { budgetCapMs: 700000 }, dshBackgroundTimeoutMs: 1000 }, startedC), ctx: { subagents: {}, get: (s) => (s === "jobs" ? jobs : null) } },
      { task: "implement x", designToken: stC.designToken, background: true },
    )
  } finally { console.warn = origWarn }
  assert.equal(specs.length, 1, "后台服务可用 ⇒ 派发 job（不落同步路径）")
  assert.equal(capC.filter((w) => w.includes(capNote)).length, 0,
    "background=true 走后台 ⇒ **不告警**（后台无平台墙钟问题，告警即错告；D14-6）")
  assert.ok(outC.includes("eng-dsh-fake-1"), "后台句柄可见: " + outC.slice(0, 160))
  dropSession(sidC)

  // —— ⑤ background=true 但 jobs 不可用 ⇒ 回落同步执行，**此时**同步路径告警才该出现 ——
  const sidD = "t18d-bg-nojobs"
  const stD = makeEngRunFixture(sidD)
  const startedD = []
  const capD = []
  try {
    console.warn = (...a) => { capD.push(a.map(String).join(" ")) }
    await runEngCoder(
      makeEngDeps(sidD, { codexCli: { budgetCapMs: 700000 } }, startedD),
      { task: "implement x", designToken: stD.designToken, background: true },
    )
  } finally { console.warn = origWarn }
  assert.equal(capD.filter((w) => w.includes(capNote)).length, 1,
    "jobs 不可用 ⇒ 确实回落同步执行 ⇒ 同步路径告警成立（不是错告）")
  dropSession(sidD)
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

// ═════════════════ 批 3：评审协议增强（设计档 §7 AC-V1…AC-V22） ═════════════════
// docs/2026-09-12-review-protocol-design.md。本区覆盖 VERDICT 解析器单测（AC-V1）、
// 签发/撤销路径集成（AC-V2…V11、V18…V22）与 D-33/D-34 两条实测缺陷的回归锁。
// 提示词侧静态断言（AC-V13…V15c）在 preset-static.test.mjs；AC-V12 在 codex-runner.test.mjs。
// AC-V16 = 上方 T16（**原样未动**：20+ 条 isApprovalVerdict 断言 = N1 逐字节等价锁）。
//   批 3 处置轮（分歧审计 🔴 #1）修订：注释**不是**机械保护 —— 现由下方「AC-V16 [negative lock]」
//   用例把 T16 的 25 条 (输入 → 期望) 对**独立复述并逐条重跑**，另加源级计数锁要求锁表覆盖 T16
//   的每一条断言。T16 本体仍**原样未动**（N1：本轮只新增，不改旧断言）。
// AC-V17 = 全量 `node --test` 绿 + AC-28（package.json dependencies 为空，既有静态锁）。
//   批 3 处置轮（分歧审计 🔴 #1）修订：该条**已从设计档 §7 移除**（全量绿不是单测可断言的对象；
//   `dependencies` 为空由 test/codex-runner.test.mjs 的 AC-28 机械锁住）——不再声称本文件内有用例。

// ————————————— AC-V16 [负]：T16 断言的**机械**重跑（N1 的锁，不止注释） —————————————
// 分歧审计 🔴 #1（批 3 处置轮）：设计档 §7 声称 AC-V16 = 「T16 的 20+ 条断言原样全绿」，而此前
// 测试里**只有那行注释** —— 注释不是机械保护：把 isApprovalVerdict 改坏、或把 T16 的样本删光，
// 测试照样全绿。本用例把 T16 的 (输入 → 期望) 对**独立复述**（不改 T16 本体，N1）并逐条重跑，
// 另加源级计数锁：锁表条数必须等于 T16 内 `assert.equal(isApprovalVerdict(` 的条数。
/** T16 的 `fixedTable` 样本（逐字符复述，不改 T16 本体）。 */
const T16_FIXED_TABLE = "| # | Orig# | File | Severity | Status | Notes |\n"
  + "| 1 | 2 | lib/a.mjs | 🔴 | Fixed | addressed |\n"
  + "| 2 | 1 | lib/b.mjs | 🟡 | Fixed | done |\n"
  + "The design is approved."
/** T16 的全部断言对：`[输入, isApprovalVerdict 的期望]`，顺序与 T16 一致。 */
const T16_LOCK = [
  // —— 通过（true）——
  ["The design is approved.", true],
  ["All issues verified. The design is approved.", true],
  [T16_FIXED_TABLE, true],
  ["| # | Severity | Status |\n| 1 | **🔴** | 已修复 |\nDesign approved.", true],
  ["| # | Severity | Issue |\n| 1 | 🟡 | the 🔴 mentioned in prose must not block |\napproved", true],
  ["no unfixed 🔴 remain — the design is approved.", true],
  // —— 不签发（false）——
  ["| 1 | 🔴 | something broken |\nThe design is approved.", false],
  ["The design is not approved.", false],
  ["The design will not be approved.", false],
  ["| 1 | 🟡 | minor |\n设计未通过", false],
  ["该设计未能通过评审。", false],
  ["该设计没有通过评审。", false],
  ["该设计不会通过。", false],
  ["该设计不能通过。", false],
  ["The design remains unapproved.", false],
  ["没法通过——存在致命缺陷。", false],
  ["The design cannot be approved.", false],
  ["Everything is fine.", false],
  ["| 1 | Feasibility | 🔴 Critical | broken |\nThe design is approved.", false],
  ["  | 1 | 🔴 | broken |\nThe design is approved.", false],
  ["| 1 | 1 | a.md | 🔴 | Not done | still open |\napproved", false],
  ["| 1 | 1 | a.md | 🔴 | pending | open |\napproved", false],
  ["| 1 | 1 | a.md | 🔴 | 未修复 | open |\napproved", false],
  ["| 1 | 1 | a.md | 🔴 | not addressed | open |\napproved", false],
  ["| 1 | Feasibility | 🔴(must fix) | broken |\napproved", false],
]

test("AC-V16 [negative lock]: every T16 isApprovalVerdict case is re-run independently — the fallback heuristic stays behaviourally identical (N1)", () => {
  // ① 源级计数锁：锁表必须覆盖 T16 里的**每一条** isApprovalVerdict 断言
  //    （删样本 → 红；加样本却不更新锁表 → 红。这正是「注释型锁」缺的那一环。）
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8")
  const t16Start = src.indexOf('test("T16:')
  assert.ok(t16Start > 0, "找不到 T16 用例（本锁的前提）")
  const t16End = src.indexOf("\ntest(", t16Start + 1)
  const t16Body = src.slice(t16Start, t16End === -1 ? undefined : t16End)
  const t16Count = (t16Body.match(/assert\.equal\(isApprovalVerdict\(/g) || []).length
  assert.equal(T16_LOCK.length, t16Count,
    "锁表条数必须等于 T16 的断言条数（不可抽空锁表 / 不可漏抄样本）")
  assert.ok(T16_LOCK.length >= 20, "N1 锁要求 ≥20 条样本（T16 的「20+ 条」口径），当前 " + T16_LOCK.length)

  // ② 逐条重跑：任何对 isApprovalVerdict 的行为改动都会在这里红
  for (const [text, expected] of T16_LOCK) {
    assert.equal(isApprovalVerdict(text), expected, "N1 断裂——T16 样本行为漂移: " + JSON.stringify(text))
  }
})

/** 批 3 夹具待批令牌：固定 uuid（未过期 → runAdvisorReview 不重铸；批准码可确定性派生）。 */
const V3_UUID = "3f8fad5b-d9cb-469f-a165-70867728950e"
const v3Pending = () => V3_UUID + ":" + (Date.now() + 3600_000)
/** 启发式（回落路径）命中的通过句——措辞与既有 T16 样本同款。 */
const V3_HEURISTIC_PASS = "The design is approved with no unresolved Critical issues."
const V3_PASS_LINE = "VERDICT: PASS"
const V3_FAIL_LINE = "VERDICT: FAIL"

/**
 * 批 3 签发路径夹具：design 评审 + 完全可控的评审正文（其余走真实 runAdvisorReview）。
 * @param {object} [opts] seedToken 内存预置令牌 / seedRecord 磁盘预置记录 / cwd 会话 cwd / pendingToken
 */
async function runVerdictCase(sid, home, replyText, opts = {}) {
  const st = sessionState(sid)
  st.engineering = true
  st.pendingDesignToken = opts.pendingToken ?? v3Pending()
  st.pendingDocPaths = []
  // 只在显式 seedToken 时改内存令牌——否则会「替产品擦掉」上一轮已签发的令牌，
  // 让「后续轮不得撤销」这条断言假绿/假红（AC-V21 ④）。
  if ("seedToken" in opts) st.designToken = opts.seedToken
  if (opts.seedRecord) saveTokenRecord(sid, opts.seedRecord, home)
  if (!opts.keepRound) {
    st.advisorRound = 0
    st.lastAdvisorOutput = null
    st.advisorOverride = null
  }
  const agent = {
    session: { id: sid, header: { cwd: opts.cwd ?? PLUGIN_DIR }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
  const llm = {
    stream: () => (async function* () {
      yield { type: "block-end", block: { type: "text", text: replyText } }
      yield { type: "finish", reason: { kind: "stop" } }
    })(),
  }
  const out = await runAdvisorReview({ llm }, {
    agent, config: {}, reviewType: "design", documents: [], storPathOverride: home,
  })
  return { out, st: sessionState(sid) }
}

/** 本夹具的合法批准码回显行（批准码 = sha256(token 首段) 前 8 位，只能派生、不能硬编码）。 */
const v3Echo = (token) => "[APPROVE:" + designApprovalCode(token) + "]"

/** 捕获 console.warn 期间跑一段逻辑（AC-V22 撤销留痕）。 */
async function withWarnCapture(fn) {
  const captured = []
  const original = console.warn
  console.warn = (...args) => { captured.push(args.map(String).join(" ")) }
  try { return { out: await fn(), warns: captured } } finally { console.warn = original }
}

/** `|` 围栏的真实评审表格行（与真实评审表同形：`# | … | Severity | …`）。 */
const V3_TABLE_WITH_CLEAN_ROWS = [
  "| # | Orig# | File | Severity | Status | Notes |",
  "| 1 | 2 | lib/advisor.mjs | 🟡 | Fixed | 已修复 |",
].join("\n")

// ————————————— AC-V1：解析器六形态 + 容忍面（单测） —————————————

test("AC-V1: parseVerdict — pass/fail/absent/bad-value/misplaced/duplicate + bold / period / case / whitespace / CRLF tolerance", () => {
  // ① 六个基本形态
  assert.deepEqual(parseVerdict("...\n" + V3_PASS_LINE), { kind: "pass" })
  assert.deepEqual(parseVerdict(V3_FAIL_LINE), { kind: "fail" })
  assert.deepEqual(parseVerdict("no verdict line at all"), { kind: "absent" })
  assert.deepEqual(parseVerdict("VERDICT: MAYBE"), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict(V3_PASS_LINE + "\nmore text below"), { kind: "invalid", reason: "misplaced" })
  assert.deepEqual(parseVerdict(V3_PASS_LINE + "\n" + V3_PASS_LINE), { kind: "invalid", reason: "duplicate" })
  assert.deepEqual(parseVerdict(V3_PASS_LINE + "\n" + V3_FAIL_LINE), { kind: "invalid", reason: "duplicate" })

  // ② 容忍面（决策 D-c）：加粗 / 尾句号 / 大小写 / 前后空白 / CRLF / 尾部空行
  assert.deepEqual(parseVerdict("  **VERDICT: PASS**  "), { kind: "pass" })
  assert.deepEqual(parseVerdict("**VERDICT: FAIL**"), { kind: "fail" })
  assert.deepEqual(parseVerdict("VERDICT: PASS."), { kind: "pass" })
  assert.deepEqual(parseVerdict("verdict: pass"), { kind: "pass" })
  assert.deepEqual(parseVerdict("VeRdIcT : FaIl"), { kind: "fail" })
  assert.deepEqual(parseVerdict("\tVERDICT: PASS\r\n"), { kind: "pass" })
  assert.deepEqual(parseVerdict(V3_PASS_LINE + "\r\n\r\n"), { kind: "pass" })

  // ③ 未声明的容忍边界（设计档 §8）：** 只包住关键字（冒号在外）→ 不命中过滤器 → 回落 absent
  assert.deepEqual(parseVerdict("**VERDICT**: PASS"), { kind: "absent" })

  // ④ 放宽**语义**一律不放松：行尾垃圾 / 多值
  assert.deepEqual(parseVerdict("VERDICT: PASS — all good"), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("VERDICT: PASS FAIL"), { kind: "invalid", reason: "bad-value" })

  // ⑤ 前置：任意值输入，纯函数、不抛、无副作用
  for (const v of [null, undefined, 42, {}, [], true]) {
    assert.deepEqual(parseVerdict(v), { kind: "absent" }, "非字符串输入 → absent：" + String(v))
  }
})

// ————————————— AC-V1 盲点（批 3 分歧审计 🟡 #2 / N6） —————————————
// 放宽项（D-c 容忍）不得放宽到**接受错误值**：尾句号必须紧跟取值、`**` 必须成对。
// 本用例是独立的（不改上方 AC-V1 的既有断言），并附 D-c 容忍面的**反证**防止过度收紧。

test("AC-V1 (blind spots): trailing period must be adjacent and `**` must be paired — tolerance never accepts a malformed verdict (N6)", () => {
  // ① 尾句号必须**紧跟**取值：中间夹空白 → INVALID（收紧前 `\s*\.?` 会接受）
  assert.deepEqual(parseVerdict("VERDICT: PASS   .   "), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("VERDICT: PASS ."), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("VERDICT: FAIL ."), { kind: "invalid", reason: "bad-value" })
  // ② `**` 必须**成对**：缺尾 / 缺首 → INVALID（收紧前两个 `(?:\*\*)?` 各自可选，会接受）
  assert.deepEqual(parseVerdict("**VERDICT: PASS"), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("VERDICT: PASS**"), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("**VERDICT: FAIL"), { kind: "invalid", reason: "bad-value" })
  // ③ `VERDICT: PASS..` 继续拒绝（仍恰好一个尾句号）
  assert.deepEqual(parseVerdict("VERDICT: PASS.."), { kind: "invalid", reason: "bad-value" })
  assert.deepEqual(parseVerdict("**VERDICT: PASS..**"), { kind: "invalid", reason: "bad-value" })
  // —— 反证：决策 D-c 的容忍面**未被过度收紧**（合法形态必须继续接受）——
  assert.deepEqual(parseVerdict("VERDICT: PASS."), { kind: "pass" })
  assert.deepEqual(parseVerdict("VERDICT: FAIL."), { kind: "fail" })
  assert.deepEqual(parseVerdict("**VERDICT: PASS**"), { kind: "pass" })
  assert.deepEqual(parseVerdict("**VERDICT: FAIL**"), { kind: "fail" })
  assert.deepEqual(parseVerdict("**VERDICT: PASS.**"), { kind: "pass" })
  assert.deepEqual(parseVerdict("  **VERDICT: PASS**  "), { kind: "pass" })
  assert.deepEqual(parseVerdict("VeRdIcT : FaIl"), { kind: "fail" })
  assert.deepEqual(parseVerdict("\tVERDICT: PASS\r\n"), { kind: "pass" })
})

// ————————————— AC-V8b 机制层：阻塞行扫描的「先抽单元格」管线 —————————————

test("AC-V8b (mechanism): blocking rows are matched PER CELL in table rows; 🔴 or 🟡 must-fix block, a bare line never does", () => {
  // 真表格行（`|` 围栏）——severity 单元格可在首列或中列，与真实评审表同形
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 must-fix | x |"), true, "must-fix 在中列")
  assert.equal(hasUnresolvedBlockingRow("| 🟡 must-fix | lib/a.mjs | x |"), true, "must-fix 在首列")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | **🟡** must-fix | x |"), true, "加粗变体：**🟡** must-fix")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 (must fix) | x |"), true, "括号变体")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 Must-Fix | x |"), true, "连字符 + 大小写")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🔴 | broken | x |"), true, "未解决 🔴")

  // 非阻塞：已修复标记 / 普通 🟡 / 普通 🔵
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🔴 | Fixed | x |"), false)
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 | plain advisory | x |"), false)
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🔵 | note | x |"), false)

  // **反证**：无 `|` 围栏的裸行**不得**命中——锁死「先抽单元格再匹配」的管线语义
  assert.equal(hasUnresolvedBlockingRow("🟡 must-fix here"), false, "裸行不得命中（拿整行匹配会让这条为 true）")
  assert.equal(hasUnresolvedBlockingRow("must-fix"), false)
  assert.equal(hasUnresolvedBlockingRow("🔴 must-fix (no table)"), false)

  // 空/异常输入：纯函数、不抛
  assert.equal(hasUnresolvedBlockingRow(""), false)
  assert.equal(hasUnresolvedBlockingRow(null), false)
  assert.equal(hasUnresolvedBlockingRow(undefined), false)
})

// ————————————— 收口轮 #3：must-fix 单元格长度护栏的 fail-open 角落 —————————————
// 旧实现把 🔴 与 🟡 must-fix 共用 16 的长度上限，而 `**🟡** (must fix)`（加粗 + 括号组合，
// UTF-16 长度 17）在匹配前就被护栏挡掉 → must-fix 静默漏判（可能错发凭证，方向是 fail-open）。
// 用例必须能**证伪**：既证明该组合现在被拦，也证明放宽后普通长描述单元格仍不误判。

test("AC-V8b (#3): the 17-char `**🟡** (must fix)` severity cell blocks; relaxing the cap does not misjudge ordinary long description cells", () => {
  // —— ① 证伪旧行为：加粗 + 括号组合（UTF-16 长度 17 > 旧上限 16）必须命中 ——
  assert.equal("**🟡** (must fix)".length, 17, "夹具前提：该单元格 UTF-16 长度恰为 17（旧上限 16 时漏判）")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | **🟡** (must fix) | x |"), true,
    "加粗+括号组合必须命中（旧上限 16 时此处为 false —— fail-open 角落）")
  assert.equal(hasUnresolvedBlockingRow("| **🟡** (must fix) | lib/a.mjs | x |"), true, "同一单元格出现在首列同样命中")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | **🟡**(must fix) | x |"), true, "无空格变体")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | **🟡** (must-fix) | x |"), true, "连字符变体")

  // —— ② 反证：放宽**只**对以 🟡 开头的严重度单元格生效；普通长描述单元格仍不误判 ——
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 | we must fix this one later, it is advisory | x |"), false,
    "描述列里的 must fix 文字不得把该行判成阻塞")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | long descriptive cell with must fix wording inside | x |"), false,
    "以文字开头（非 🟡）的长单元格不得命中 MUST_FIX_RE")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🔵 | see the must fix note in the design doc, later | x |"), false,
    "🔵 行携带 must fix 措辞仍不阻塞")
  assert.equal(hasUnresolvedBlockingRow("| 1 | lib/a.mjs | 🟡 | " + "x".repeat(60) + " | x |"), false,
    "超长描述单元格（🔵/🟡 普通行）不得误判")
})

// ————————————— AC-V2 / V3：签发路径正反向 —————————————

test("AC-V2: VERDICT: PASS + valid echo → token issued, echo stripped, approval message shape kept", async () => {
  const root = makeF10Root()
  const sid = "acv2-" + randomUUID()
  const home = join(root, "h")
  try {
    const token = v3Pending()
    const { out, st } = await runVerdictCase(sid, home,
      V3_HEURISTIC_PASS + "\n" + v3Echo(token) + "\n" + V3_PASS_LINE, { pendingToken: token })
    assert.ok(out.includes("Approved. Pass this exact token to eng_coder"), "PASS + 有效回显必须签发: " + out)
    assert.ok(out.includes(token), "签发文案带出令牌本体: " + out)
    assert.ok(/有效至 .+，TTL engTokenTtlMs/.test(out), "有效期行形状保持: " + out)
    assert.ok(!out.includes("[APPROVE:"), "回显被剥离: " + out)
    assert.match(out, /VERDICT: PASS/, "评正文保留（只剥离回显）")
    assert.equal(st.designToken, token, "state 记录签发令牌")
    assert.equal(loadTokenRecord(sid, home)?.token, token, "磁盘同步落盘")
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-V3: VERDICT: PASS without a valid echo → no token + the existing echo diagnostic", async () => {
  const root = makeF10Root()
  try {
    for (const [name, reply] of [
      ["no-echo", V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE],
      ["wrong-echo", V3_HEURISTIC_PASS + "\n[APPROVE:deadbeef]\n" + V3_PASS_LINE],
    ]) {
      const sid = "acv3-" + name + "-" + randomUUID()
      const home = join(root, name)
      try {
        const { out, st } = await runVerdictCase(sid, home, reply)
        assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), name + " 不得签发: " + out)
        assert.ok(out.includes("批准码校验失败"), name + " 必须给既有批准码诊断: " + out)
        assert.equal(st.designToken, null, name + " → state 无签发")
        assert.equal(loadTokenRecord(sid, home), null, name + " → 磁盘无记录")
      } finally { dropSession(sid) }
    }
  } finally { rmRoot(root) }
})

// ————————————— AC-V4：FAIL 撤销 —————————————

test("AC-V4: VERDICT: FAIL + valid echo → no issue, state cleared, removeTokenRecord called (disk record gone)", async () => {
  const root = makeF10Root()
  const sid = "acv4-" + randomUUID()
  const home = join(root, "h")
  const seeded = "11111111-2222-3333-4444-555555555555:" + (Date.now() + 3600_000)
  try {
    const { out, st } = await runVerdictCase(sid, home,
      "The design is not approved.\n" + v3Echo(v3Pending()) + "\n" + V3_FAIL_LINE,
      { seedToken: seeded, seedRecord: { token: seeded, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
    assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "FAIL 不得签发: " + out)
    assert.equal(st.designToken, null, "FAIL → state 撤销")
    assert.equal(loadTokenRecord(sid, home), null, "FAIL → 磁盘记录被 removeTokenRecord 删除（= 调用证据）")
    assert.ok(out.includes("评审员判定为不通过"), "FAIL 诊断在位: " + out)
  } finally { dropSession(sid); rmRoot(root) }
})

// ————————————— AC-V5：INVALID 三因不签发 + 点名格式 —————————————

test("AC-V5: INVALID (duplicate / misplaced / bad-value) → no issue, no fallback, diagnostic names the VERDICT format", async () => {
  const root = makeF10Root()
  const token = v3Pending()
  try {
    const cases = [
      ["duplicate", V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE + "\n" + V3_PASS_LINE, "多行"],
      ["misplaced", V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE + "\n尾注：以上。", "最后一行非空"],
      ["bad-value", V3_HEURISTIC_PASS + "\nVERDICT: MAYBE", "取值不是 PASS / FAIL"],
    ]
    const seen = []
    for (const [name, reply, marker] of cases) {
      const sid = "acv5-" + name + "-" + randomUUID()
      const home = join(root, name)
      try {
        // 回显有效也无用：verdict 决定「算不算通过」（D-f 不回落）。回显在 verdict 行**上方**（设计档 §4.1）。
        const { out, st } = await runVerdictCase(sid, home, v3Echo(token) + "\n" + reply, { pendingToken: token })
        assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), name + " 不得签发: " + out)
        assert.ok(out.includes("VERDICT 行格式非法"), name + " 必须给格式诊断: " + out)
        assert.ok(out.includes("`VERDICT: PASS`") && out.includes("`VERDICT: FAIL`"), name + " 诊断必须点名格式: " + out)
        assert.ok(out.includes(marker), name + " 原因点名（" + marker + "）: " + out)
        assert.ok(!out.includes("批准码校验失败"), name + " 不得误报为回显问题（可区分性）: " + out)
        assert.equal(st.designToken, null)
        seen.push(out.slice(out.indexOf("VERDICT 行格式非法")))
      } finally { dropSession(sid) }
    }
    assert.equal(new Set(seen).size, 3, "三种 invalid 原因必须给出**可区分**诊断")
  } finally { rmRoot(root) }
})

// ————————————— AC-V6 [负] / AC-V7：回落路径（N1 的锁） —————————————

test("AC-V6 [negative lock]: no VERDICT line + heuristic pass + valid echo → STILL ISSUES (the fallback path is permanent)", async () => {
  const root = makeF10Root()
  const sid = "acv6-" + randomUUID()
  const home = join(root, "h")
  const token = v3Pending()
  try {
    const { out, st } = await runVerdictCase(sid, home, V3_HEURISTIC_PASS + "\n" + v3Echo(token), { pendingToken: token })
    assert.ok(out.includes("Approved. Pass this exact token to eng_coder"),
      "回落路径必须仍然签发 —— 若将来有人把 VERDICT 改成必需，本测试必红: " + out)
    assert.equal(st.designToken, token)
    assert.equal(loadTokenRecord(sid, home)?.token, token)
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-V7: no VERDICT line + heuristic fails + valid echo → no token (legacy negative behaviour kept)", async () => {
  const root = makeF10Root()
  const sid = "acv7-" + randomUUID()
  const home = join(root, "h")
  try {
    const token = v3Pending()
    const { out, st } = await runVerdictCase(sid, home, "Everything is fine.\n" + v3Echo(token), { pendingToken: token })
    assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "回落判不通过 → 不签发: " + out)
    assert.equal(st.designToken, null)
    assert.equal(loadTokenRecord(sid, home), null)
  } finally { dropSession(sid); rmRoot(root) }
})

// ————————————— AC-V8 / AC-V9：verdict 与表格的 AND —————————————

test("AC-V8: VERDICT: PASS + an unresolved 🔴 row + valid echo → no token + the contradiction diagnostic (D-a)", async () => {
  const root = makeF10Root()
  const sid = "acv8-" + randomUUID()
  const home = join(root, "h")
  try {
    const token = v3Pending()
    const reply = [
      "| # | File | Severity | Issue | Suggestion |",
      "|---|------|----------|-------|------------|",
      "| 1 | lib/a.mjs | 🔴 | crash on empty input | guard it |",
      "",
      v3Echo(token),
      V3_PASS_LINE,
    ].join("\n")
    const { out, st } = await runVerdictCase(sid, home, reply, { pendingToken: token })
    assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "verdict 与表格矛盾 → 不得签发: " + out)
    assert.ok(out.includes("verdict 与表格矛盾"), "矛盾诊断在位: " + out)
    assert.ok(!out.includes("批准码校验失败"), "不得误报为回显问题（诊断指错方向 = 送补救进错误的洞）: " + out)
    assert.equal(st.designToken, null)
    assert.equal(loadTokenRecord(sid, home), null)
  } finally { dropSession(sid); rmRoot(root) }
})

test("AC-V8b: VERDICT: PASS + a real `|`-fenced 🟡 must-fix row + valid echo → no token (D-b)", async () => {
  const root = makeF10Root()
  try {
    for (const [name, severityCell] of [["mid-column", "| 1 | lib/a.mjs | 🟡 must-fix | x |"], ["first-column", "| 🟡 must-fix | lib/a.mjs | x |"]]) {
      const sid = "acv8b-" + name + "-" + randomUUID()
      const home = join(root, name)
      try {
        const token = v3Pending()
        const reply = V3_TABLE_WITH_CLEAN_ROWS + "\n" + severityCell + "\n\n" + v3Echo(token) + "\n" + V3_PASS_LINE
        const { out, st } = await runVerdictCase(sid, home, reply, { pendingToken: token })
        assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), name + "：must-fix 必须阻塞签发: " + out)
        assert.ok(out.includes("verdict 与表格矛盾"), name + "：矛盾诊断: " + out)
        assert.equal(st.designToken, null)
        assert.equal(loadTokenRecord(sid, home), null)
      } finally { dropSession(sid) }
    }
  } finally { rmRoot(root) }
})

test("AC-V9 [negative lock]: VERDICT: PASS + a plain 🟡 (unresolved) row + valid echo → STILL ISSUES", async () => {
  const root = makeF10Root()
  const sid = "acv9-" + randomUUID()
  const home = join(root, "h")
  const token = v3Pending()
  try {
    const reply = [
      "| # | File | Severity | Issue | Suggestion |",
      "|---|------|----------|-------|------------|",
      "| 1 | lib/a.mjs | 🟡 | advisory, not fixed | consider it |",
      "| 2 | lib/b.mjs | 🔵 | style nit | — |",
      "",
      v3Echo(token),
      V3_PASS_LINE,
    ].join("\n")
    const { out, st } = await runVerdictCase(sid, home, reply, { pendingToken: token })
    assert.ok(out.includes("Approved. Pass this exact token to eng_coder"),
      "普通 🟡/🔵 永不阻塞 —— 若有人把行扫描简化成「扫所有 emoji」，本测试必红: " + out)
    assert.equal(st.designToken, token)
  } finally { dropSession(sid); rmRoot(root) }
})

// ————————————— AC-V10：旧格式回显（钓鱼通道） —————————————

test("AC-V10: VERDICT: PASS + legacy [DESIGN-TOKEN:<token>] echo → no token (old channel stays closed on the new path)", async () => {
  const root = makeF10Root()
  const sid = "acv10-" + randomUUID()
  const home = join(root, "h")
  try {
    const token = v3Pending()
    const { out, st } = await runVerdictCase(sid, home,
      V3_HEURISTIC_PASS + "\n[DESIGN-TOKEN:" + token + "]\n" + V3_PASS_LINE, { pendingToken: token })
    assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "旧格式回显不得签发: " + out)
    assert.ok(out.includes("批准码校验失败"), "走回显诊断（非 verdict 诊断）: " + out)
    assert.equal(st.designToken, null)
    assert.equal(loadTokenRecord(sid, home), null)
  } finally { dropSession(sid); rmRoot(root) }
})

// ————————————— AC-V11：截断表格（双重 fail-closed） —————————————

test("AC-V11: truncated table fixtures (heuristic true / false) → neither issues (verdict + echo are both at the tail → double fail-closed)", async () => {
  const root = makeF10Root()
  try {
    for (const [name, reply] of [
      // 启发式为真：通过句在正文里，但表格/verdict/回显被截断
      ["heuristic-true", "| # | File | Severity |\n| 1 | lib/a.mjs | 🟡 |\n\nThe design is approved with no unresolved Critical issues.\n\n[APPROVE:aa"],
      // 启发式为假：截断在表格中途
      ["heuristic-false", "| # | File | Severity |\n| 1 | lib/a.mjs | 🔴 |"],
    ]) {
      const sid = "acv11-" + name + "-" + randomUUID()
      const home = join(root, name)
      try {
        const { out, st } = await runVerdictCase(sid, home, reply)
        assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), name + " 不得签发: " + out)
        assert.equal(st.designToken, null, name)
        assert.equal(loadTokenRecord(sid, home), null, name)
      } finally { dropSession(sid) }
    }
  } finally { rmRoot(root) }
})

// ————————————— AC-V18 [负] / AC-V20：D-33 回归锁（真实中文评审文本） —————————————

/**
 * D-33 实测评审文本（2026-09-12 现场，父侧逐条实测）：中文散文表达通过 + 中文表格 + 末行批准码回显。
 * 实测的批准码为 `a6065235`；批准码 = sha256(令牌首段) 前 8 位、无法反推，故该行的 code 由
 * **本夹具待批令牌派生**（其余文字逐字保留）。真实会话里宿主对该文本的判定是「不通过」——
 * 这正是 P5：三词词表（通过/批准/approved）命中数为 0。
 */
function d33ReviewText(code) {
  return [
    "## 评审结论",
    "",
    "| # | Orig# | File | Severity | Status | Notes |",
    "|---|-------|------|----------|--------|-------|",
    "| 1 | 2 | lib/advisor.mjs | 🔴 | Fixed | 已修复并复核 |",
    "| 2 | 1 | lib/prompts/discipline.md | 🟡 | Fixed | 三值词表已改 |",
    "",
    "无未决 🔴、无新增阻塞项，设计档可交 eng_coder 实施。",
    "",
    "[APPROVE:" + code + "]",
  ].join("\n")
}

test("AC-V18 [negative lock]: the real D-33 Chinese PASS review issues a token once VERDICT: PASS is appended — and does not without it", async () => {
  const root = makeF10Root()
  const token = v3Pending()
  const code = designApprovalCode(token)
  try {
    // ① 加 VERDICT: PASS 末行 → 必须签发（D-33 的正解：中文通过表达不再静默卡死）
    const sid1 = "acv18-ok-" + randomUUID()
    const home1 = join(root, "ok")
    try {
      const { out, st } = await runVerdictCase(sid1, home1, d33ReviewText(code) + "\n" + V3_PASS_LINE, { pendingToken: token })
      assert.ok(out.includes("Approved. Pass this exact token to eng_coder"), "D-33 回归锁：中文通过 + VERDICT: PASS 必须签发: " + out)
      assert.equal(st.designToken, token)
      assert.equal(loadTokenRecord(sid1, home1)?.token, token)
    } finally { dropSession(sid1) }

    // ② 去掉 VERDICT 行 → 走回落（证明「修好中文通过」靠的正是 VERDICT，而非扩词表）
    const sid2 = "acv18-fallback-" + randomUUID()
    const home2 = join(root, "fallback")
    try {
      const { out } = await runVerdictCase(sid2, home2, d33ReviewText(code), { pendingToken: token })
      assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"),
        "回落路径下同一文本仍判不通过（P5 的实测根因 = 三词词表命中数为 0）: " + out)
      assert.ok(out.includes("未给出 VERDICT 行"), "但必须**可见**（AC-V19/V20）: " + out)
    } finally { dropSession(sid2) }
  } finally { rmRoot(root) }
})

test("AC-V20: the Chinese-pass fallback diagnostic is readable — it does NOT claim '评审未通过' and names the real cause", async () => {
  const root = makeF10Root()
  const sid = "acv20-" + randomUUID()
  const home = join(root, "h")
  try {
    const { out } = await runVerdictCase(sid, home, d33ReviewText(designApprovalCode(v3Pending())))
    assert.ok(out.includes("评审员表达了通过但宿主未识别其通过措辞"),
      "必须明说「评审员表达了通过但宿主未识别」（而不是让用户以为评审没过）: " + out)
    assert.ok(!out.includes("评审未通过"), "不得写成「评审未通过」（误导）: " + out)
    assert.ok(out.includes("不等于") && out.includes("判了不通过"), "必须显式排除误解: " + out)
    assert.ok(out.includes("`VERDICT: PASS`"), "必须给出补救动作（重跑评审 + 末行 VERDICT）: " + out)
  } finally { dropSession(sid); rmRoot(root) }
})

// ————————————— AC-V19：六类情形各自可区分诊断（N7） —————————————

test("AC-V19: every path that does NOT issue a token names a distinguishable reason (N7 — silence is a defect)", async () => {
  const root = makeF10Root()
  const token = v3Pending()
  const echo = v3Echo(token)
  const unissued = [
    ["pass+blocking", "| 1 | lib/a.mjs | 🔴 | broken |\n" + echo + "\n" + V3_PASS_LINE, "verdict 与表格矛盾"],
    ["pass+echo", V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE, "批准码校验失败"],
    ["fail", echo + "\n" + V3_FAIL_LINE, "评审员判定为不通过"],
    ["invalid", echo + "\n" + V3_PASS_LINE + "\n" + V3_PASS_LINE, "VERDICT 行格式非法"],
    ["absent+heuristic-fail", "Everything is fine.\n" + echo, "未给出 VERDICT 行；回落启发式判定为不通过"],
  ]
  try {
    const seen = []
    for (const [name, reply, marker] of unissued) {
      const sid = "acv19-" + name + "-" + randomUUID()
      const home = join(root, name)
      try {
        const { out, st } = await runVerdictCase(sid, home, reply, { pendingToken: token })
        assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), name + " 不该签发: " + out)
        assert.ok(out.includes(marker), name + " 缺少可区分诊断「" + marker + "」: " + out)
        // 诊断尾部可辨：取诊断段，逐条必须互不相同
        seen.push(out.slice(out.indexOf(marker)))
        assert.equal(st.designToken, null)
      } finally { dropSession(sid) }
    }
    assert.equal(new Set(seen).size, unissued.length, "五类未签发诊断必须两两可区分")
    // 第六类（absent + 回落判通过 + 回显有效）= 正常签发，由 AC-V6 覆盖（唯一允许的「无诊断」路径）
    const sidOk = "acv19-ok-" + randomUUID()
    const homeOk = join(root, "ok")
    try {
      const { out } = await runVerdictCase(sidOk, homeOk, V3_HEURISTIC_PASS + "\n" + echo, { pendingToken: token })
      assert.ok(out.includes("Approved. Pass this exact token to eng_coder"), "第六类 = 正常签发")
    } finally { dropSession(sidOk) }
  } finally { rmRoot(root) }
})

// ————————————— AC-V21：撤销收紧（D-i / D-34）正反两向 —————————————

test("AC-V21: revocation tightened — FAIL revokes, fallback-fail revokes, PASS-with-bad-echo does NOT, a later round keeps an issued token", async () => {
  const root = makeF10Root()
  const seeded = "99999999-8888-7777-6666-555555555555:" + (Date.now() + 3600_000)
  const seedOpts = () => ({ seedToken: seeded, seedRecord: { token: seeded, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 } })
  try {
    // ① verdict 显式 FAIL → 撤销 + 诊断
    const sid1 = "acv21a-" + randomUUID()
    const home1 = join(root, "a")
    try {
      const { out, st } = await runVerdictCase(sid1, home1, V3_FAIL_LINE, { ...seedOpts(), pendingToken: v3Pending() })
      assert.equal(st.designToken, null, "① FAIL → state 撤销")
      assert.equal(loadTokenRecord(sid1, home1), null, "① FAIL → 磁盘记录撤销")
      assert.ok(out.includes("评审员判定为不通过"), "① 诊断")
    } finally { dropSession(sid1) }

    // ② 无 verdict + 回落判不通过 → 撤销 + 诊断（含「未给出 VERDICT 行」）
    //    收口小轮（FR-6 / AC-V23 ②）修订：本支的前提是「**无**有效令牌」——守卫命中（已有有效令牌）时
    //    不再撤销，那是 AC-V23 ③ 的领地。此处原先预置了一枚**有效**令牌，与方案 A 的语义直接冲突，
    //    故只把预置去掉（断言本体与语义不变：无有效令牌时 **仍撤销**，fail-closed 保留）。
    const sid2 = "acv21b-" + randomUUID()
    const home2 = join(root, "b")
    try {
      const { out, st } = await runVerdictCase(sid2, home2, "Nothing to report.", { pendingToken: v3Pending() })
      assert.equal(st.designToken, null, "② 回落判不通过 → 撤销")
      assert.equal(loadTokenRecord(sid2, home2), null, "② 磁盘撤销")
      assert.ok(out.includes("未给出 VERDICT 行；回落启发式判定为不通过"), "② 诊断")
    } finally { dropSession(sid2) }

    // ③ verdict PASS 但回显缺失/不符 → **只诊断、不撤销**（[负] 锁：不再因回显问题销毁已签发令牌）
    for (const [name, reply] of [["missing", V3_PASS_LINE], ["wrong", "[APPROVE:deadbeef]\n" + V3_PASS_LINE]]) {
      const sid3 = "acv21c-" + name + "-" + randomUUID()
      const home3 = join(root, "c-" + name)
      try {
        const { out, st } = await runVerdictCase(sid3, home3, reply, seedOpts())
        assert.ok(out.includes("批准码校验失败"), name + "：诊断在位: " + out)
        assert.equal(st.designToken, seeded, name + "：③ **不得**撤销已签发令牌（state）")
        assert.equal(loadTokenRecord(sid3, home3)?.token, seeded, name + "：③ 磁盘记录不得被动（D-i）")
      } finally { dropSession(sid3) }
    }

    // ④ 成功签发之后的后续轮（同一会话）：令牌仍在
    const sid4 = "acv21d-" + randomUUID()
    const home4 = join(root, "d")
    try {
      const token = v3Pending()
      const first = await runVerdictCase(sid4, home4,
        V3_HEURISTIC_PASS + "\n" + v3Echo(token) + "\n" + V3_PASS_LINE, { pendingToken: token })
      assert.ok(first.out.includes("Approved. Pass this exact token to eng_coder"), "首轮签发")
      // 后续轮：verdict PASS 但忘带回显 → 令牌必须仍在（state + 磁盘）
      const later = await runVerdictCase(sid4, home4, V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE,
        { pendingToken: token, keepRound: true })
      assert.ok(later.out.includes("批准码校验失败"), "后续轮诊断在位")
      assert.equal(later.st.designToken, token, "④ 后续轮不得撤销已签发令牌（state）")
      assert.equal(loadTokenRecord(sid4, home4)?.token, token, "④ 后续轮不得撤销已签发令牌（磁盘）")
    } finally { dropSession(sid4) }
  } finally { rmRoot(root) }
})

// ————————————— AC-V23：FR-6 守卫（方案 A）——「猜不通过」不得撤销已签发的**有效**令牌 —————————————
// 设计档 §4.5「A 的精确语义」（批 3 收口小轮，用户裁定方案 A）：
//   ① `verdict.kind === "fail"`  → **仍撤销**（明确的否定裁决，不是猜测）；
//   ② `absent` ∧ 回落判不通过    → **先查「有效」令牌**：有 → **只诊断、不撤销**；无 → 撤销（D-33 的 fail-closed 保留）；
//   ③ `pass` 侧回显缺失/不符     → 只诊断（不变）。
// 守卫检查对象是**「有效」而非「存在」**（⑤ 锁死：已过期的令牌本就不能用，不构成要保的授权）。
// 可证伪性：③ 在**加守卫之前**必红 —— 撤销支会把已签发令牌清成 null（本用例实施时已实测红，见交付报告）。
// 与 AC-V21 互补：AC-V21 覆盖 FR-5 的收紧（③ 不再撤销、④ 后续轮带 VERDICT 时不受影响），
// 本用例覆盖 FR-6 的残余修补（④ 那个承诺在**无 VERDICT 的后续轮**上此前并不成立）。

test("AC-V23: the FR-6 guard — an explicit FAIL still revokes, a guessed FAIL no longer destroys a VALID token, an expired token is not protected", async () => {
  const root = makeF10Root()
  // 已签发的**有效**令牌（未过期 → validateDesignToken 为真）
  const valid = "99999999-8888-7777-6666-555555555555:" + (Date.now() + 3600_000)
  const validOpts = () => ({
    seedToken: valid,
    seedRecord: { token: valid, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 },
    pendingToken: v3Pending(),
  })
  // 已**过期**的令牌（存在但无效）
  const expired = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:" + (Date.now() - 60_000)
  // ② 的输入形态：无 VERDICT 行 + 回落启发式判不通过（= 宿主「猜」不通过）
  const guessedFail = "Nothing to report."
  try {
    // ① 明说 FAIL + 已有一枚有效令牌 → **仍撤销**（守卫**不得**渗进「明说」的那一支）
    const sid1 = "acv23a-" + randomUUID()
    const home1 = join(root, "a")
    try {
      const { out, st } = await runVerdictCase(sid1, home1, V3_FAIL_LINE, validOpts())
      assert.equal(st.designToken, null, "① 明说 FAIL → 仍撤销（即便已有有效令牌）")
      assert.equal(loadTokenRecord(sid1, home1), null, "① 磁盘记录同步撤销")
      assert.ok(out.includes("评审员判定为不通过"), "① 诊断 = 明确的否定裁决: " + out)
      assert.ok(!out.includes("未撤销"), "① 不得出现「未撤销」措辞（守卫只能作用于②）: " + out)
    } finally { dropSession(sid1) }

    // ② 猜是没过 + **无**有效令牌 → 撤销（D-33 的 fail-closed 语义原样保留）
    const sid2 = "acv23b-" + randomUUID()
    const home2 = join(root, "b")
    try {
      const { out, st } = await runVerdictCase(sid2, home2, guessedFail, { pendingToken: v3Pending() })
      assert.equal(st.designToken, null, "② 无有效令牌 → 撤销")
      assert.equal(loadTokenRecord(sid2, home2), null, "② 磁盘无记录")
      assert.ok(out.includes("评审未签发：未给出 VERDICT 行；回落启发式判定为不通过"), "② 撤销支诊断: " + out)
      assert.ok(!out.includes("未撤销"), "② 守卫未命中 → 不得出现「未撤销」措辞: " + out)
    } finally { dropSession(sid2) }

    // ③ 猜是没过 + **有**有效令牌 → **不撤销** + 诊断可见（D-34 残余的正向修复；加守卫前此支必红）
    const sid3 = "acv23c-" + randomUUID()
    const home3 = join(root, "c")
    try {
      const { out, st } = await runVerdictCase(sid3, home3, guessedFail, validOpts())
      assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "③ 本轮不得签发新令牌: " + out)
      assert.equal(st.designToken, valid, "③ **不得撤销**已有有效令牌（state）—— 加守卫前此处必红")
      assert.equal(loadTokenRecord(sid3, home3)?.token, valid, "③ 磁盘记录不得被动（守卫只在「猜」这一支生效）")
      assert.ok(out.includes("本轮评审未签发新令牌"), "③ 必须点名「本轮未签发」: " + out)
      assert.ok(out.includes("未给出 VERDICT 行") && out.includes("回落启发式判定为不通过"),
        "③ 必须点名原因（未给出 VERDICT 行 + 回落判不通过）: " + out)
      assert.ok(out.includes("已有一枚有效令牌") && out.includes("未撤销"),
        "③ 必须点名「因已有有效令牌而未撤销」（与撤销支文案可区分）: " + out)
      assert.ok(!out.includes("评审未签发：未给出 VERDICT 行"),
        "③ 不得复用撤销支的文案（两条诊断必须可区分，N7）: " + out)
    } finally { dropSession(sid3) }

    // ④ pass 侧回显缺失 → 只诊断、不撤销（FR-5 的 ③，不变；且与 ③ 的守卫生效路径**可区分**）
    const sid4 = "acv23d-" + randomUUID()
    const home4 = join(root, "d")
    try {
      const { out, st } = await runVerdictCase(sid4, home4, V3_HEURISTIC_PASS + "\n" + V3_PASS_LINE, validOpts())
      assert.ok(out.includes("批准码校验失败"), "④ 走既有回显诊断: " + out)
      assert.ok(!out.includes("未给出 VERDICT 行"), "④ 不得误报为「未给出 VERDICT 行」（与③可区分）: " + out)
      assert.equal(st.designToken, valid, "④ 不撤销（state）")
      assert.equal(loadTokenRecord(sid4, home4)?.token, valid, "④ 磁盘不动")
    } finally { dropSession(sid4) }

    // ⑤ 令牌**存在但无效**（已过期）+ 猜是没过 → **仍撤销** —— 锁死「有效而非存在」
    const sid5 = "acv23e-" + randomUUID()
    const home5 = join(root, "e")
    try {
      // 夹具前提：该令牌「存在但已过期」（不引 validateDesignToken 以免改本文件既有 import 行，
      // 用与 tokenExpiryMs 同口径的「第二段是毫秒时间戳」直接断言）
      assert.ok(Number(expired.split(":")[1]) < Date.now(), "夹具前提：令牌已过期（存在但无效）")
      const { out, st } = await runVerdictCase(sid5, home5, guessedFail, {
        seedToken: expired,
        seedRecord: { token: expired, issuedAt: Date.now() - 7200_000, expiresAt: Date.now() - 60_000 },
        pendingToken: v3Pending(),
      })
      assert.equal(st.designToken, null, "⑤ 过期令牌不构成要保的授权 → **仍撤销**（锁「有效而非存在」）")
      assert.equal(loadTokenRecord(sid5, home5), null, "⑤ 磁盘记录被撤销")
      assert.ok(out.includes("未给出 VERDICT 行；回落启发式判定为不通过"), "⑤ 撤销支诊断: " + out)
      assert.ok(!out.includes("未撤销"), "⑤ 守卫不得命中已过期令牌: " + out)
    } finally { dropSession(sid5) }
  } finally { rmRoot(root) }
})

// ————————————— AC-V22：撤销路径留痕（返回值被收集，不再丢弃） —————————————

test("AC-V22: the revocation path collects removeTokenRecord's boolean and warns (both on removal and on failure)", async () => {
  const root = makeF10Root()
  const seeded = "77777777-6666-5555-4444-333333333333:" + (Date.now() + 3600_000)
  try {
    // ① 磁盘记录存在 → 删除成功 → 撤销发生时必须 warn（「令牌为什么没了」可查）
    const sid1 = "acv22a-" + randomUUID()
    const home1 = join(root, "a")
    try {
      const { warns } = await withWarnCapture(() => runVerdictCase(sid1, home1, V3_FAIL_LINE, {
        seedToken: seeded,
        seedRecord: { token: seeded, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 },
        pendingToken: v3Pending(),
      }))
      const revokeWarn = warns.find(w => w.includes("design token 撤销"))
      assert.ok(revokeWarn, "撤销必须留痕（console.warn）: " + JSON.stringify(warns))
      assert.ok(revokeWarn.includes("VERDICT: FAIL"), "留痕点明撤销原因: " + revokeWarn)
      assert.ok(revokeWarn.includes("已删除"), "留痕带出 removeTokenRecord 的返回值（已收集，不再丢弃）: " + revokeWarn)
      assert.equal(loadTokenRecord(sid1, home1), null)
    } finally { dropSession(sid1) }

    // ② 磁盘删除失败（存储路径不可解析）→ 返回值 false → 必须 warn 失败（而不是静默丢弃）
    const sid2 = "acv22b-" + randomUUID()
    const tmpCwd = mkdtempSync(join(tmpdir(), "thincoder-acv22-"))
    try {
      const { warns } = await withWarnCapture(() => runVerdictCase(sid2, "", V3_FAIL_LINE, {
        pendingToken: v3Pending(), cwd: tmpCwd,
      }))
      const revokeWarn = warns.find(w => w.includes("design token 撤销"))
      assert.ok(revokeWarn, "撤销必须留痕: " + JSON.stringify(warns))
      assert.ok(revokeWarn.includes("删除失败"), "删除失败必须 warn（返回值 = false 被收集）: " + revokeWarn)
      assert.equal(sessionState(sid2).designToken, null, "内存态仍撤销")
    } finally { dropSession(sid2); rmRoot(tmpCwd) }
  } finally { rmRoot(root) }
})
