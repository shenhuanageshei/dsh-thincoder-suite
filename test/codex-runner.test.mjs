// codex-runner.test.mjs — 一期 codex-runner 单元测试（docs/2026-09-03-codex-runner-research.md §7.1 T1.1/T1.2/T1.5）。
// node:test 零依赖：adapter 用假子进程（deps.spawn 注入），不碰真实 codex / 不出网。
// 覆盖：B2/B4/B12 runner 校验、codexCli 全局节、envelope 错误码（注入法）、模型发现解析、
// advisor 路由 codex 分支、config 合并、escalate codex 行剔除、runAdvisorReview codex 路径。
// R4 收尾微修复轮（登记表 D-25 + code review 跟进）：TOKEN_SECRET 密钥源三形态/重启稳定性 +
// advisor jobs 派发路径 warnPrefix 可见性。
// R6 纯断言轮（登记表 D-26，设计 §12）：十项维护处方断言——①③④⑤⑥⑦⑧⑨⑩ 各 ≥1 断言
//（②编译级核验 = node --check + 全量绿；④ codex ok+空文本经真实 adapter 不可达——唯一 OK
// 出口要求 text !== ""，按「两路径一致」以 dsh 行为断言 + codex 分支源级一致性断言交付）。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { writeFileSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  normalizeRunnerValue, validateRunnerValue, resolveCodexCliGlobals,
  buildCodexArgs, resolveExecutableFile, runCodexTask, discoverCodexModels, codexRowLabel, sweepStaleCodexTempDirs,
} from "../lib/codex-adapter.mjs"
import { resolveAdvisorRoute, advisorGenerationOf, bumpAdvisorGeneration, sessionStateViewWithGeneration, checkInFlightJob,
  generateDesignToken, validateDesignToken, designApprovalCode, designTokenShape, designTokenFailureReason,
  expiryLabel, renewDesignToken, TOKEN_TTL_DEFAULT_MS, tokenExpiryMs } from "../lib/advisor.mjs"
import { normalizeDocPath, computeDocHash, sha256Hex } from "../lib/doc-hash.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "../lib/effort-resolve.mjs"
import { startConsultSession } from "../lib/consult.mjs"
import { mergeGlobalConfig, saveUserConfig, loadUserConfig } from "../lib/config-store.mjs"
import { validateGlobalUserConfig, warnDeprecatedTokenSecretEnvOnce, resetDeprecatedSecretEnvWarnForTests } from "../lib/index.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { runEngCoder, makeWriteGate } from "../lib/eng.mjs"
import { saveSessionState, loadSessionState, normalizeRestored, resolveSessionStorePath } from "../lib/session-store.mjs"
import { saveTokenRecord, resolveTokenStorePath } from "../lib/token-store.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

// ————————————— 批 22 / D-39：信任栅栏的测试缝 —————————————
// `makeApiHandler` 的 handler 现在**无条件**先问宿主 `ctx.get("connection")` 要拒绝码
// （服务取不到 = 503 fail-closed ⇒ 空 ctx 直调会全变 503）。直调用例必须**显式**声明
// 「本请求被放行」——放行是白纸黑字，不是靠门缺席。这正是本批的纪律：安全默认不迁就夹具。
/** 放行 / 拒绝两态 stub：`undefined` = 放行；401 / 403 = 宿主拒绝码。 */
const fenceCtx = (rejection = undefined) => ({
  get: (name) => (name === "connection" ? { requestRejection: () => rejection } : undefined),
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ————————————— 批 15（FR-1/FR-2）：consult 的派发与消费面 —————————————
/**
 * 假平台 jobs 服务。批 15 起 consult **必须**走 `jobs.start`（D15-4：jobs 缺失 ⇒ 拒发，
 * 不回落同步）⇒ 原先 `ctx: {}` 的会诊用例必须注入它。平台契约（`dsh-jobs` 的 `JobStart`）：
 * `start(spec)` 调 `spec.run()` 取 `{cancel, done}`，返回 branded string `<kind>-N`。
 */
function consultJobs() {
  const specs = []
  return {
    specs,
    jobs: { start(spec) { const hooks = spec.run(); specs.push({ spec, hooks }); return "consult-" + specs.length } },
  }
}
/**
 * 批 15（FR-2）：`checkConsultSession` + `waiters` 已退役 ⇒ **生产消费面 = digest**
 * （`composeConsultDigest` 的产物；run 体在 job complete **之前**合成，见 §6.1 @post）。
 */
async function consultDigestOf(state, id, timeoutMs = 3000) {
  const s = state.consultSessions.get(String(id))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !s?.digest) await sleep(5)
  assert.ok(s?.digest, "consult digest 必须在 " + timeoutMs + "ms 内 settle（实得 " + String(s?.digest) + "）")
  return s.digest
}

// ————————————— 假子进程 —————————————
// script(args) → { events: [{stream, data, delay}], exitCode, exitDelay, outText }
// outText 非空时：模拟 codex 把最终回复写到 -o 目标文件（argv 中 -o 的下一参数）。
function fakeSpawnFactory(scripts) {
  return (file, args) => {
    const spec = scripts(args) ?? { events: [], exitCode: 0 }
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { writes: [], ended: false, write(d) { this.writes.push(String(d)) }, end() { this.ended = true } }
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", null, "SIGKILL")) }
    ;(async () => {
      for (const ev of spec.events ?? []) {
        await sleep(ev.delay ?? 0)
        ;(child[ev.stream ?? "stdout"] ?? child.stdout).emit("data", Buffer.from(ev.data ?? ""))
      }
      if (spec.outText !== undefined) {
        const i = args.indexOf("-o")
        if (i >= 0) { try { writeFileSync(args[i + 1], spec.outText) } catch { /* 忽略 */ } }
      }
      if (spec.hang === true) return // 挂死：不发 exit，等 watchdog kill
      await sleep(spec.exitDelay ?? 10)
      child.emit("exit", spec.exitCode ?? 0)
    })()
    return child
  }
}

// 通用 deps：platform=linux（killTree 走 child.kill 假实现，不触发真 taskkill）、
// executable 用 process.execPath（绝对路径，必存在）。
const baseDeps = (spawn) => ({ spawn, platform: "linux", env: {} })
const probeScript = (args) => args.includes("--version")
  ? { events: [{ data: "codex-cli 0.150.1\n" }], exitCode: 0 }
  : null

// ————————————— runner 规范化（B2/B4/B12） —————————————

test("runner: 缺省 → dsh（现状路径）", () => {
  const r = normalizeRunnerValue(undefined)
  assert.equal(r.ok, true)
  assert.equal(r.runner.kind, "dsh")
})

test("runner: 字符串简写两种 + B2 未知 kind fail-closed", () => {
  assert.equal(normalizeRunnerValue("codex-cli").runner.kind, "codex-cli")
  assert.equal(normalizeRunnerValue("dsh").runner.kind, "dsh")
  const bad = normalizeRunnerValue("claude-cli")
  assert.equal(bad.ok, false)
  assert.ok(bad.errors[0].includes("codex-cli"))
})

test("runner: B4 dsh 行带 codex 专属字段 → 忽略 + warn", () => {
  const r = normalizeRunnerValue({ kind: "dsh", model: "codex-model-a" })
  assert.equal(r.ok, true)
  assert.equal(r.runner.kind, "dsh")
  assert.equal(r.runner.model, undefined)
  assert.ok(r.warnings.some((w) => w.includes("model")))
})

test("runner: B12 字段级错误（timeoutMs 越界 / sandbox 非法 / executable 元字符）", () => {
  const r = normalizeRunnerValue({ kind: "codex-cli", timeoutMs: 5, sandbox: "yolo", executable: "codex & whoami" })
  assert.equal(r.ok, false)
  assert.equal(r.errors.length, 3)
  const errs = validateRunnerValue("advisor.round1.runner", { kind: "codex-cli", timeoutMs: 5 })
  assert.equal(errs.length, 1)
  assert.ok(errs[0].startsWith("advisor.round1.runner"))
})

test("runner: effort 透传不查枚举（C11），model 合法保留", () => {
  const r = normalizeRunnerValue({ kind: "codex-cli", model: "codex-model-a", effort: "ultra" })
  assert.equal(r.ok, true)
  assert.equal(r.runner.effort, "ultra")
})

// ————————————— codexCli 全局节 —————————————

test("codexCli: 默认值（D1 agentsMdPolicy=disable）+ 非法回落 warn", () => {
  const d = resolveCodexCliGlobals({}).globals
  assert.equal(d.agentsMdPolicy, "disable")
  assert.equal(d.proxyMode, "inherit")
  const r = resolveCodexCliGlobals({ codexCli: { proxyMode: "sideway", defaultTimeoutMs: 1 } })
  assert.equal(r.globals.proxyMode, "inherit")
  assert.equal(r.globals.defaultTimeoutMs, 600000)
  assert.ok(r.warnings.length >= 2)
})

test("codexCli: proxyMode=url 缺 proxyUrl → 回落 inherit + warn", () => {
  const r = resolveCodexCliGlobals({ codexCli: { proxyMode: "url" } })
  assert.equal(r.globals.proxyMode, "inherit")
  assert.ok(r.warnings.some((w) => w.includes("proxyUrl")))
})

// ————————————— argv 构造（B6/B7/C11） —————————————

test("buildCodexArgs: 模型/effort TOML 形态/AGENTS 禁用/stdin 尾参", () => {
  const args = buildCodexArgs({ cwd: "C:/w", sandbox: "read-only", model: "codex-model-a", effort: "xhigh", agentsMd: "disable", tmpOut: "o.txt" })
  assert.deepEqual(args, [
    "exec", "-C", "C:/w", "--skip-git-repo-check", "-s", "read-only",
    "-m", "codex-model-a",
    "-c", 'model_reasoning_effort="xhigh"',
    "-c", "project_doc_max_bytes=0",
    "--json", "-o", "o.txt", "-",
  ])
})

test("resolveExecutableFile: B6 元字符拒绝 + 不存在路径 null", () => {
  assert.equal(resolveExecutableFile({ platform: "win32", env: { PATH: "" } }, "codex & whoami"), null)
  assert.equal(resolveExecutableFile({ platform: "win32", env: { PATH: "" } }, "D:/no/such/codex.exe"), null)
})

// ————————————— runCodexTask 错误码（注入法，FR-4/FR-5） —————————————

const RUNNER = { kind: "codex-cli", model: "codex-model-a" }
const GLOBALS = { executable: process.execPath, proxyMode: "inherit", proxyUrl: null, agentsMdPolicy: "disable", model: null, defaultTimeoutMs: 600000 }

test("runCodexTask: 成功 → OK envelope（exit 0 + 输出文件 + threadId + usage）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return {
      events: [
        { data: JSON.stringify({ type: "thread.started", thread_id: "tid-123" }) + "\n" },
        { data: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }) + "\n" },
      ],
      exitCode: 0,
      outText: "FAKE REPLY",
    }
  })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", runner: RUNNER, globals: GLOBALS })
  assert.equal(env.ok, true)
  assert.equal(env.code, "OK")
  assert.equal(env.text, "FAKE REPLY")
  assert.equal(env.threadId, "tid-123")
  assert.deepEqual(env.usage, { inputTokens: 10, outputTokens: 2 })
  assert.equal(env.runner.version, "0.150.1")
  // B7：stdin 写入 prompt 且 end
})

test("runCodexTask: exit=0 但无输出 → NO_OUTPUT（FR-5）", async () => {
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 0 })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "NO_OUTPUT")
  assert.equal(env.ok, false)
})

test("runCodexTask: 非零退出但有部分输出 → PROCESS_ERROR（text 保留不当成功，C4）", async () => {
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1, outText: "PARTIAL" })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "PROCESS_ERROR")
  assert.equal(env.ok, false)
  assert.equal(env.text, "PARTIAL")
})

test("runCodexTask: B11 探测失败 → RUNNER_UNAVAILABLE（不可执行路径）", async () => {
  const spawn = fakeSpawnFactory(() => ({ events: [], exitCode: 0 }))
  const env = await runCodexTask(baseDeps(spawn), {
    taskText: "hi", cwd: tmpdir(), sandbox: "read-only",
    runner: { kind: "codex-cli", executable: "D:/no/such/codex.exe" }, globals: GLOBALS,
  })
  assert.equal(env.code, "RUNNER_UNAVAILABLE")
  assert.equal(env.ok, false)
})

test("runCodexTask: watchdog 超时 → TIMEOUT（linux 假 kill 成功路径）", async () => {
  // 假进程永不自退出（exitCode 省略 → 不发 exit），等 watchdog 触发 kill → exit(null)
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [{ stream: "stdout", delay: 40, data: "slow" }], hang: true })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 300, runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "TIMEOUT")
  assert.equal(env.ok, false)
})

test("runCodexTask: abort → ABORTED", async () => {
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [{ stream: "stdout", delay: 5000, data: "slow" }], exitCode: 0, exitDelay: 5000 })
  const ctrl = new AbortController()
  const p = runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 30000, runner: RUNNER, globals: GLOBALS, signal: ctrl.signal })
  await sleep(30)
  ctrl.abort()
  const env = await p
  assert.equal(env.code, "ABORTED")
})

// ————————————— 模型发现（5.6） —————————————

test("discoverCodexModels: debug models JSON 解析 + efforts 归一", async () => {
  const catalog = JSON.stringify({ models: [
    { slug: "codex-model-a", display_name: "GPT-5.6 Sol", default_reasoning_level: "low", visibility: "list", context_window: 272000,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }, { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" }] },
    { display_name: "no slug here" },
  ] })
  const spawn = fakeSpawnFactory((args) => args.includes("models") ? { events: [{ data: catalog }], exitCode: 0 } : probeScript(args))
  const r = await discoverCodexModels(baseDeps(spawn), { executable: process.execPath, refresh: true })
  assert.equal(r.ok, true)
  assert.equal(r.source, "debug-models")
  assert.equal(r.models.length, 1)
  assert.deepEqual(r.models[0].efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  assert.equal(r.models[0].defaultEffort, "low")
})

test("discoverCodexModels: spawn 失败 → CODEX_HOME 缓存兜底", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-"))
  writeFileSync(join(dir, "models_cache.json"), JSON.stringify({ models: [
    { slug: "cached-model", display_name: "Cached", default_reasoning_level: "medium", visibility: "list", context_window: 1000, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  ] }))
  const throwing = () => { throw new Error("no exec") }
  const r = await discoverCodexModels({ platform: "win32", env: { CODEX_HOME: dir, PATH: "" } }, { executable: "D:/no/such/x.exe", refresh: true })
  assert.equal(r.ok, true)
  assert.equal(r.source, "cache")
  assert.equal(r.models[0].slug, "cached-model")
})

test("codexRowLabel: 有 model 用 model，否则回落全局/默认", () => {
  assert.equal(codexRowLabel({ kind: "codex-cli", model: "codex-model-a" }), "codex-cli:codex-model-a")
  assert.equal(codexRowLabel({ kind: "codex-cli" }, { model: "gpt-5.6-terra" }), "codex-cli:gpt-5.6-terra")
  assert.equal(codexRowLabel({ kind: "codex-cli" }), "codex-cli:default")
})

// ————————————— advisor 路由 codex 分支 —————————————

test("advisor 路由: codex 行免 provider/model，model 回落 runner.model", () => {
  const r = resolveAdvisorRoute({
    config: { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" } } } },
    override: null, agentOpts: {}, advisorRound: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "codex-cli")
  assert.equal(r.model, "codex-model-a")
  assert.equal(r.runner.kind, "codex-cli")
  assert.equal(r.timeoutSource, "default")
})

test("advisor 路由: runner.effort 优先于组 effort；runner.timeoutMs 优先", () => {
  const r = resolveAdvisorRoute({
    config: { advisor: { round1: { effort: "low", runner: { kind: "codex-cli", model: "m1", effort: "xhigh", timeoutMs: 120000 } } } },
    override: null, agentOpts: {}, advisorRound: 0,
  })
  assert.equal(r.effort, "xhigh")
  assert.equal(r.timeoutMs, 120000)
  assert.equal(r.timeoutSource, "codex runner")
})

test("advisor 路由: runner=dsh → 回落既有解析链（零变化，B1）", () => {
  const r = resolveAdvisorRoute({
    config: { advisor: { round1: { provider: "deepseek", model: "deepseek-chat", runner: "dsh" } } },
    override: null, agentOpts: {}, advisorRound: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "deepseek")
  assert.equal(r.runner, undefined)
})

// ————————————— 配置合并与校验 —————————————

test("mergeGlobalConfig: codexCli 字段级合并 + consultModels runner 行保留", () => {
  const merged = mergeGlobalConfig(
    { codexCli: { executable: "codex", proxyMode: "inherit" }, consultModels: [{ provider: "deepseek", model: "d1" }] },
    { codexCli: { proxyMode: "url", proxyUrl: "http://127.0.0.1:7897" }, consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a" } }] },
  )
  assert.deepEqual(merged.codexCli, { executable: "codex", proxyMode: "url", proxyUrl: "http://127.0.0.1:7897" })
  assert.equal(merged.consultModels[0].runner.kind, "codex-cli")
})

test("validateGlobalUserConfig: codex 行免 provider/model 合法；codexCli 非法值报错（B12）", () => {
  const v = validateGlobalUserConfig({ codexCli: { executable: "codex", agentsMdPolicy: "disable" }, consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a" } }] }, [])
  assert.equal(v.ok, true)
  assert.equal(v.sanitized.codexCli.agentsMdPolicy, "disable")
  assert.equal(v.sanitized.consultModels[0].runner.kind, "codex-cli")
  const v2 = validateGlobalUserConfig({ consultModels: [{ runner: "claude-cli" }] }, [])
  assert.equal(v2.ok, false)
  const v3 = validateGlobalUserConfig({ codexCli: { proxyMode: "sideway" } }, [])
  assert.equal(v3.ok, false)
  assert.ok(v3.errors.some((e) => e.includes("proxyMode")))
})

// ————————————— escalate 一期范围守卫（D2） —————————————

// 二期 T2.1 后「全池皆 codex 行」走真实 codex 分支（见下方 T2.1 假子进程用例）——
// 旧「明确报错」断言已失效删除（该用例曾因误触真实 spawn 空跑 10 分钟，教训：
// escalate deps 不带 spawn 注入时 adapter 会走真进程）。

// ————————————— runAdvisorReview codex 路径（端到端，假进程） —————————————

test("runAdvisorReview: codex runner → 走 adapter 返回评本文（llm 不被触碰）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const sid = "advisor-codex-test"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("LLM must not be used for codex runner") } }, spawn, platform: "linux", env: {} },
    { agent, config: { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" } } } }, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(!out.startsWith("Advisor:"), "completed review should not carry error prefix")
  assert.ok(out.includes("Issue"), "review table text should flow through")
  dropSession(sid)
})

// ═════════ 批 3（评审协议增强）：AC-V12 —— code 评审不设宿主门禁（决策 D-d）═════════
// docs/2026-09-12-review-protocol-design.md §7.2。四份提示词都要求 VERDICT，但宿主**只**对
// design token 路径设门禁；code 评审的 verdict 供主代理消费（batch 6 才做评审链守卫）。

test("AC-V12 (批 3): reviewType='code' + VERDICT: PASS + a valid-looking echo → NOTHING is issued and the token path is untouched", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const sid = "acv12-code-review"
  const home = mkdtempSync(join(tmpdir(), "thincoder-acv12-"))
  const seeded = "0f8fad5b-d9cb-469f-a165-70867728950e:" + (Date.now() + 3600_000)
  try {
    const st = sessionState(sid)
    st.engineering = true
    st.pendingDesignToken = seeded
    st.pendingDocPaths = []
    st.designToken = null
    // 预置既有磁盘记录：code 评审**不得**删它、也不得写它
    saveTokenRecord(sid, { token: seeded, issuedAt: Date.now(), expiresAt: Date.now() + 3600_000 }, home)
    const reply = "| # | File | Severity | Issue |\n|---|---|---|---|\n| 1 | lib/a.mjs | 🟡 | minor |\n\n"
      + "[APPROVE:deadbeef]\nVERDICT: PASS"
    const llm = {
      stream: () => (async function* () {
        yield { type: "block-end", block: { type: "text", text: reply } }
        yield { type: "finish", reason: { kind: "stop" } }
      })(),
    }
    const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: { provider: "p", model: "m" } }
    const out = await runAdvisorReview({ llm }, {
      agent, config: {}, reviewType: "code", paths: [], documents: [], signal: undefined,
      configDefaultEngineering: false, storPathOverride: home,
    })
    assert.ok(!out.includes("Approved. Pass this exact token to eng_coder"), "code 评审不得签发任何东西: " + out)
    assert.ok(!out.includes("批准码校验失败"), "code 评审不得被 design 侧诊断污染: " + out)
    assert.ok(out.includes("VERDICT: PASS"), "评正文原样返回（不剥离、不改写）: " + out)
    assert.equal(sessionState(sid).designToken, null, "state 不得被触碰")
    const raw = JSON.parse(readFileSync(resolveTokenStorePath(home), "utf8"))
    assert.equal(raw.tokens[sid].token, seeded, "既有磁盘记录不得被 code 评审删除/改写")
  } finally {
    dropSession(sid)
    rmSync(home, { recursive: true, force: true })
  }
})

// ————————————— 二期：T2.1 escalate 写任务 / T2.3 idle / T2.4 resume / T2.2 eng_coder —————————————

const CODexDeps = (spawn, extra) => ({ spawn, platform: "linux", env: {}, ...extra })

function makeEscDeps(sid, spawn, config) {
  const agent = { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }
  return { ctx: {}, agent, config, state: sessionState(sid), signal: undefined, spawn, platform: "linux", env: {} }
}

/** R2 fake jobs（平台契约/D-05）：start(p) 调 p.run() 取 { cancel, done } 并返回 branded
 *  string `<kind>-N`（非对象）。specs 收集 payload/hooks/id 供断言与 done settle 驱动。 */
function fakeJobsFactory() {
  const specs = []
  const jobs = {
    start(p) {
      const hooks = p.run()
      const id = (p.kind ?? "job") + "-" + (specs.length + 1)
      specs.push({ payload: p, hooks, id })
      return id
    },
  }
  return { jobs, specs }
}

const ESC_CONFIG = {
  consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a" } }],
  codexCli: { executable: process.execPath, agentsMdPolicy: "disable" },
}

test("T2.1 escalate codex 行：workspace-write 沙箱 + touched files 并入 + post-op 报告", async () => {
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    seenArgs = args
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-tid-1" }) + "\n" }], exitCode: 0, outText: "did the work\n\nTouched files: lib/a.mjs, lib/b.mjs" }
  })
  const sid = "esc-codex-p2"
  const out = await runEscalate(makeEscDeps(sid, spawn, ESC_CONFIG), "fix the bug", undefined)
  assert.ok(out.includes("post-op report"), "should return post-op report")
  assert.ok(out.includes("did the work"))
  assert.ok(seenArgs.includes("-s") && seenArgs.includes("workspace-write"), "B5: escalate 默认写沙箱")
  assert.ok(!seenArgs.includes("resume"), "首次调用不走 resume")
  const st = sessionState(sid)
  assert.ok(st.touchedFiles.includes("lib/a.mjs") && st.touchedFiles.includes("lib/b.mjs"), "Touched files 并入 state")
  dropSession(sid)
})

test("T2.4 escalate followup：第二次调用走 exec resume + 内存 threadId（不落盘）", async () => {
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    seenArgs = args
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-tid-2" }) + "\n" }], exitCode: 0, outText: "round two done\n\nTouched files: none" }
  })
  const sid = "esc-followup-p2"
  await runEscalate(makeEscDeps(sid, spawn, ESC_CONFIG), "first task", undefined)
  const out = await runEscalate(makeEscDeps(sid, spawn, ESC_CONFIG), "follow-up tweak", undefined, true)
  assert.ok(out.includes("resume"), "报告应标注 resume 轮")
  assert.ok(seenArgs.includes("resume") && seenArgs.includes("esc-tid-2"), "argv 走 exec resume <threadId>")
  dropSession(sid)
})

test("T2.4 followup 无前置线程 → 明确报错", async () => {
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 0 })
  const sid = "esc-followup-none"
  const out = await runEscalate(makeEscDeps(sid, spawn, ESC_CONFIG), "x", undefined, true)
  assert.ok(out.includes("no codex escalate thread"))
  dropSession(sid)
})

test("T2.5/D3: escalate 显式 danger-full-access 透传（显式配置即许可）+ console.warn 来源留痕", async () => {
  const warnings = []
  const origWarn = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try {
    let seenArgs = null
    const spawn = fakeSpawnFactory((args) => {
      if (args.includes("--version")) return probeScript(args)
      seenArgs = args
      return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
    })
    const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m", sandbox: "danger-full-access" } }], codexCli: { executable: process.execPath } }
    const sid = "esc-dfa-p2"
    const out = await runEscalate(makeEscDeps(sid, spawn, cfg), "x", undefined)
    assert.ok(seenArgs.includes("danger-full-access"))
    assert.ok(warnings.some((w) => w.includes("danger-full-access") && w.includes("explicitly configured")), "D3：来源随日志留痕")
    dropSession(sid)
  } finally { console.warn = origWarn }
})

test("T2.3 idle watchdog：事件停流 → idle 判假死 → TIMEOUT；不误杀持续产出的任务", async () => {
  // 假进程 hang，事件间隔 40ms 共 3 次（最后活动 ~80ms），idle 150ms → ~150ms 时判假死
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ stream: "stdout", delay: 0, data: "a" }, { stream: "stdout", delay: 40, data: "b" }, { stream: "stdout", delay: 40, data: "c" }], hang: true }
  })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 30000, idleTimeoutMs: 150, runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "TIMEOUT")
  assert.ok(env.diagnostics.includes("idle"))
})

test("buildCodexArgs: resume 形态（flags → resume → id → stdin）", () => {
  const args = buildCodexArgs({ cwd: "C:/w", sandbox: "workspace-write", model: null, effort: null, agentsMd: "disable", tmpOut: "o.txt", resumeThreadId: "tid-9" })
  assert.ok(args.indexOf("resume") > args.indexOf("--json"), "resume 在 exec flags 之后")
  assert.deepEqual(args.slice(args.indexOf("resume")), ["resume", "tid-9", "-"])
})

// ————————————— T2.2 eng_coder codex 后端 —————————————

function makeEngToken(state) {
  // D-30（FR-T1）：token = uuid:expiresAt，恰好两段（HMAC 签名腿已随密钥链删除）。
  const uuid = "u-" + Math.random().toString(16).slice(2)
  const expiresAt = Date.now() + 3600_000
  state.designToken = uuid + ":" + expiresAt
  return state.designToken
}

test("T2.2 eng_coder codex 后端：workspace-write + AGENTS 禁用 + 交付状态写入（advisor 预算重置）", async () => {
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    seenArgs = args
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "eng-tid-1" }) + "\n" }], exitCode: 0, outText: "implemented\n\nTouched files: src/x.ts" }
  })
  const sid = "eng-codex-p2"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: {} }
  const config = { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", agentsMdPolicy: "disable" } }
  const out = await runEngCoder(
    { ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for codex backend") } } }, agent, config, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {} },
    { task: "implement x", designToken: token, docs: [], stages: undefined },
  )
  assert.ok(out.includes("eng_coder delivery (codex-cli)"), "codex 交付走专用前缀")
  assert.ok(out.includes("implemented"))
  assert.ok(seenArgs.includes("-s") && seenArgs.includes("workspace-write"), "B5：eng_coder 固定写沙箱")
  assert.ok(seenArgs.includes("project_doc_max_bytes=0"), "AGENTS 策略默认 disable")
  assert.ok(seenArgs.includes("-m") && seenArgs.includes("codex-model-a"))
  const st2 = sessionState(sid)
  assert.ok(st2.touchedFiles.includes("src/x.ts"))
  assert.equal(st2.advisorRound, 0)
  assert.ok(st2.mutatedThisRun === true)
  dropSession(sid)
})

test("T2.2 eng_coder：engCoderRunner 未配 → dsh 路径零变化（B1）", async () => {
  let codexCalled = false
  const spawn = () => { codexCalled = true; throw new Error("nope") }
  const sid = "eng-dsh-p2"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }
  const subagents = { async start() { return { result: Promise.resolve({ output: [{ type: "text", text: "dsh ok\n\nTouched files: none" }], stopReason: "completed", diagnostic: null }), dispose: async () => {} } } }
  const out = await runEngCoder(
    { ctx: { subagents }, agent, config: {}, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {} },
    { task: "implement y", designToken: token, docs: [], stages: undefined },
  )
  assert.equal(codexCalled, false)
  assert.ok(out.includes("eng_coder delivery:"))
  dropSession(sid)
})

// ————————————— 评审修复回归（2026-09-04 评审 #1-#5） —————————————

test("评审#1: escalate codex 行 sandbox=read-only 被纠正为 workspace-write（B5）", async () => {
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    seenArgs = args
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m1", sandbox: "read-only" } }], codexCli: { executable: process.execPath } }
  const sid = "esc-ro-p2"
  const out = await runEscalate(makeEscDeps(sid, spawn, cfg), "x", undefined)
  assert.ok(seenArgs.includes("workspace-write") && !seenArgs.includes("read-only"), "read-only 被纠正为写沙箱")
  dropSession(sid)
})

test("评审#2: Touched files: none 哨兵不进 touchedFiles（审计范围不污染）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "did work but touched nothing new\n\nTouched files: none" }
  })
  const sid = "esc-none-p2"
  const deps = makeEscDeps(sid, spawn, ESC_CONFIG)
  await runEscalate(deps, "x", undefined)
  assert.equal(deps.state.mutatedThisRun, false, "none 哨兵不触发 mutatedThisRun")
  assert.equal((deps.state.touchedFiles ?? []).length, 0)
  dropSession(sid)
})

test("评审#3: 失败交付 → threadId 弃置，followup 报无线程", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "" } // NO_OUTPUT 失败
  })
  const sid = "esc-fail-p2"
  const deps = makeEscDeps(sid, spawn, ESC_CONFIG)
  await runEscalate(deps, "first (fails)", undefined)
  const out = await runEscalate(deps, "followup", undefined, true)
  assert.ok(out.includes("no codex escalate thread"), "失败后 thread 已弃置")
  dropSession(sid)
})

test("评审#5: followup 使用交付时保存的 runner（池首行不同也不错配）", async () => {
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    seenArgs = args
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-tid-B" }) + "\n" }], exitCode: 0, outText: "row B done\n\nTouched files: none" }
  })
  // 池两行：首行是 dsh，第二行才是 codex——显式点名第二行交付，followup 省略 model
  const cfg = {
    consultModels: [
      { provider: "dsh-p", model: "dsh-m" },
      { runner: { kind: "codex-cli", model: "codex-model-a" } },
    ],
    codexCli: { executable: process.execPath },
  }
  const sid = "esc-mismatch-p2"
  await runEscalate(makeEscDeps(sid, spawn, cfg), "first via row B", "codex-cli:codex-model-a")
  await runEscalate(makeEscDeps(sid, spawn, cfg), "followup tweak", undefined, true)
  assert.ok(seenArgs.includes("-m") && seenArgs.includes("codex-model-a"), "followup 用保存行的 model（非 pool[0]）")
  assert.ok(seenArgs.includes("resume") && seenArgs.includes("esc-tid-B"))
  dropSession(sid)
})

test("评审#4: clearCodexThread 导出可清会话线程（内存生命周期闭环）", async () => {
  const { clearCodexThread } = await import("../lib/escalate.mjs")
  assert.equal(typeof clearCodexThread, "function")
  clearCodexThread("any-session") // 不抛即通过（幂等）
})

test("jobs 派发: 预算超 cap 且 ctx.jobs 可用 → 派后台任务（owner 绑定 + finalize 在 done 内恰好一次）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  let startPayload = null
  let hooks = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const jobs = {
    start(p) {
      startPayload = p
      hooks = p.run() // 产出 { cancel, done }
      return "advisor-codex-1" // 平台契约（D-05）：start 返回 branded string（非对象无 .id）
    },
  }
  const sid = "jobs-dispatch-p2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-codex-1"), "返回平台 job id（branded string 直接渲染——D-05，不再恒显 ?）")
  assert.ok(!out.includes("job ?"), "job id 不恒显 ?（D-05）")
  assert.ok(out.includes("等待完成通知后再继续"), "D-09/UI-2：等待完成通知的接续指令")
  assert.ok(out.includes("job_output"), "D-09：全文经 job_output 读取的指引")
  assert.ok(!out.includes("含评审全文"), "D-09：删除「通知含评审全文」虚假承诺（通知只含一行指针）")
  assert.ok(!out.includes("完成时会话内自动收到通知"), "旧虚假承诺文案整体移除")
  assert.equal(startPayload.kind, "advisor-codex")
  assert.equal(startPayload.owner, agent, "owner 绑定发起会话的 agent")
  assert.ok(startPayload.label.includes("codex-model-a"))
  // done settle → finalize 恰好一次：轮次推进 + 评审全文进 job output
  const outcome = await hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(outcome.output.includes("Issue"), "finalize 后的评审全文进 job output")
  const st = sessionState(sid)
  assert.equal(st.advisorRound, 1, "finalize 轮次推进恰好一次")
  dropSession(sid)
})

test("jobs 派发降级: ctx.jobs 缺失 → 同步截断执行 + 响亮告警（绝不无声）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const sid = "jobs-missing-p2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("budgetCapMs=540000ms"), "降级告警可见")
  assert.ok(out.includes("Issue"), "同步路径仍交付评审")
  dropSession(sid)
})

// ————————————— 智能回落 + 平台墙钟预算截断（另一会话 6 连超时反馈） —————————————

test("advisor 路由: ignoreRunner=true 跳过 codex 分支回落 dsh 链", () => {
  const cfg = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a" } } }
  const r = resolveAdvisorRoute({ config: cfg, override: null, agentOpts: {}, advisorRound: 0, ignoreRunner: true })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "acme")
  assert.equal(r.model, "model-a")
  assert.equal(r.runner, undefined)
})

test("advisor 路由: runner=codex-cli 生效且组内显式 provider/model → 告警（UX 陷阱可见）", () => {
  const cfg = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a" } } }
  const r = resolveAdvisorRoute({ config: cfg, override: null, agentOpts: {}, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "codex-cli")
  assert.ok(r.warnings.some((w) => w.includes("被忽略") && w.includes("acme:model-a")))
})

test("智能回落: codex 连续 2 次失败 → 第 3 轮自动走 dsh 路由（llm 被调用）+ 响亮告警", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  let llmCalls = 0
  const llm = {
    stream: (opts) => {
      llmCalls++
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "GLM REVIEW OUTPUT" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  let codexCalls = 0
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    codexCalls++
    return { events: [], exitCode: 1 } // 每次都失败（无输出非零退出 → PROCESS_ERROR）
  })
  const sid = "smart-fallback-p2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a" } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  const r1 = await run()
  assert.ok(r1.includes("codex-cli PROCESS_ERROR"))
  assert.equal(llmCalls, 0)
  const r2 = await run()
  assert.ok(r2.includes("下一轮 advisor start 将自动回落"))
  assert.equal(llmCalls, 0)
  const r3 = await run()
  assert.equal(llmCalls, 1, "第 3 轮回落 dsh 路由，llm 被调用")
  assert.equal(codexCalls, 2, "codex 只跑前两轮")
  assert.ok(r3.includes("自动回落 dsh 路由") && r3.includes("GLM REVIEW OUTPUT"))
  dropSession(sid)
})

test("预算截断告警: round1.timeoutMs=900000 + codex runner → 成功结果带截断提示", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const sid = "cap-note-p2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("540000"), "截断后的实际预算可见")
  assert.ok(out.includes("budgetCapMs"), "截断提示指向 budgetCapMs 配置")
  dropSession(sid)
})

// ————————————— dsh 目录发现端点（设置页"目录不可用"修复） —————————————

test("GET /catalog: ctx.llm 运行时注册表 → 全部 provider（含内置 DeepSeek）+ efforts 富化", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const llm = {
    listProviders: async () => [
      { id: "deepseek-official", name: "DeepSeek" },
      { id: "acme", name: "Acme" },
      { id: "beta-labs", name: "Beta" },
    ],
    listModels: async (provider) => provider === "deepseek-official"
      ? [{ provider, id: "deepseek-chat", name: "DeepSeek Chat" }]
      : [{ provider, id: "model-a", name: "Model A" }, { provider, id: "model-a-flash", name: "Flash" }, { broken: 1 }],
  }
  const handler = makeApiHandler(fenceCtx(), {
    baseConfig: {},
    llm,
    settingsGet: (ns) => ns === "llm-pi-ai" ? {
      providers: {
        "beta-labs": {
          models: [
            { id: "model-a", reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" } },
            { id: "model-a-flash", reasoningEfforts: { off: null, high: "high" } },
          ],
        },
      },
    } : null,
  })
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler({ method: "GET", url: "/thincoder-suite/api/catalog" }, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.providers.length, 3)
  const ds = body.providers.filter((p) => p.id === "deepseek-official")[0]
  assert.ok(ds, "内置 DeepSeek 适配器必须在目录中（用户投诉的验收点）")
  assert.equal(ds.displayName, "DeepSeek")
  assert.equal(ds.models.length, 1)
  assert.equal(ds.models[0].id, "deepseek-chat")
  const zai = body.providers.filter((p) => p.id === "beta-labs")[0]
  const glm = zai.models.filter((m) => m.id === "model-a")[0]
  assert.deepEqual(glm.efforts, ["low", "medium", "high"], "settings reasoningEfforts 富化（null 档剔除）")
})

test("GET /catalog: llm runtime 缺失 → 502 + 明确错误（不再静默降级手填）", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const handler = makeApiHandler(fenceCtx(), { baseConfig: {}, settingsGet: () => null })
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler({ method: "GET", url: "/thincoder-suite/api/catalog" }, res)
  assert.equal(res.statusCode, 502)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, false)
  assert.ok(body.error.includes("llm runtime 不可用"))
})

test("PUT /config: provider 存在性 = 运行时注册表 ∪ settings（deepseek-official 假阳性修复）", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const llm = {
    listProviders: async () => [{ id: "deepseek-official", name: "DeepSeek" }, { id: "acme", name: "Acme" }],
    listConfigurableProviders: async () => [{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] }],
  }
  const handler = makeApiHandler(fenceCtx(), {
    baseConfig: {},
    llm,
    dshHomeOverride: mkdtempSync(join(tmpdir(), "provider-registry-")),
    settingsGet: (ns) => ns === "llm-pi-ai" ? { providers: { "beta-labs": { models: [] } } } : null,
  })
  const payload = JSON.stringify({
    config: {
      advisor: { convergence: { provider: "deepseek-official", model: "deepseek-chat" } },
      consultModels: [
        { provider: "deepseek-official", model: "deepseek-chat" },
        { provider: "acme", model: "model-a" },
      ],
    },
  })
  const req = { method: "PUT", url: "/thincoder-suite/api/config", [Symbol.asyncIterator]: function* () { yield Buffer.from(payload) } }
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true, "deepseek-official 来自运行时注册表——必须通过（用户投诉场景）")
  assert.equal(body.user.advisor.convergence.provider, "deepseek-official")
  assert.equal(body.user.consultModels[0].provider, "deepseek-official")
  // 负例：真正不存在的 provider 仍拒绝
  const req2 = { method: "PUT", url: "/thincoder-suite/api/config", [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ config: { consultModels: [{ provider: "totally-fake", model: "x" }] } })) } }
  const res2 = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler(req2, res2)
  assert.equal(res2.statusCode, 400)
  assert.ok(JSON.parse(res2.body).errors.some((e) => e.includes("totally-fake")))
})

// ————————————— R1 D-02：effort 三层校验收口（D-裁决-2 最近支持档 + DP-2 等距向上取） —————————————
// 覆盖：dsh resolver（resolveSupportedEffort）核心语义、codex resolver（resolveCodexRowEffort，
// 数据源 = discoverCodexModels catalog）、9 消费点接线（consult dsh/codex、escalate dsh/codex、
// eng dsh/codex、advisor codex runner/组 effort、advisor dsh 主路径、advisor 回落轮）。

/** 档位元数据 llm stub：resolveModelInfo 返回 reasoning.efforts（生产 LlmRuntime 实有该 API）。 */
const ladderLlm = (efforts) => ({
  async resolveModelInfo() {
    return { reasoning: { efforts: efforts.map((e) => ({ id: e })) } }
  },
})

/** console.warn 捕获（fail-open 响亮告警断言用）。 */
async function captureWarn(fn) {
  const warnings = []
  const orig = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try { return { value: await fn(), warnings } } finally { console.warn = orig }
}

/** codex 目录 spawn：debug models 返回注入目录 JSON；exec 任务 spawn 记录 argv。
 *  各用例用互不重复的 executable（modelCache/probeCache 按 executable 键控——防跨用例目录污染）。 */
function catalogSpawn(catalogModels, taskSpec) {
  const catalog = JSON.stringify({ models: catalogModels })
  let seenArgs = null
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    if (args.includes("debug") && args.includes("models")) return { events: [{ data: catalog }], exitCode: 0 }
    seenArgs = args
    return taskSpec ?? { events: [], exitCode: 0, outText: "ok" }
  })
  return { spawn, seenArgs: () => seenArgs }
}

test("R1 effort(dsh): 受支持档保持原样（无 note 无告警）", async () => {
  const r = await resolveSupportedEffort(ladderLlm(["off", "high", "max"]), "acme", "model-a-flash", "high")
  assert.equal(r.effort, "high")
  assert.equal(r.note, null)
})

test("R1 effort(dsh): 非法档 → 最近支持档 + note（DP-2：medium 缺失且 low/high 皆支持 → 取 high）", async () => {
  const r = await resolveSupportedEffort(ladderLlm(["low", "high"]), "acme", "m1", "medium")
  assert.equal(r.effort, "high", "等距 tie-break 向上取（DP-2 终裁：保推理质量）")
  assert.ok(r.note.includes("falling back to nearest supported effort"))
  assert.ok(r.note.includes('"high"'))
  assert.ok(r.note.includes("supported: low|high"))
})

test("R1 effort(dsh): 非等距取序距离最近（high 对 [off,low] → low；历史事故形状 low 对 [off,high,max] 批 19 起回落 high）", async () => {
  const a = await resolveSupportedEffort(ladderLlm(["off", "low"]), "p", "m", "high")
  assert.equal(a.effort, "low")
  // 2026-09-04 生产事故形状：model-a-flash efforts 仅 off/high/max，engCoderEffort "low" 曾被
  // 静默回落到 off（推理全关）——批 19（D19-1）起 off 退出距离竞争，回落力度域最近档 high
  const b = await resolveSupportedEffort(ladderLlm(["off", "high", "max"]), "p", "model-a-flash", "low")
  assert.equal(b.effort, "high", "low 对 [off,high,max] 回落力度域最近档 high（off 是开关不参与距离，批 19 D19-1；绝不秒死不变）")
  assert.ok(b.note.includes("falling back"))
})

test("R1 effort(dsh): 显式 off（未受支持 → 省略 effort 交提供方默认 + 专属 note；受支持 → 保持）", async () => {
  const a = await resolveSupportedEffort(ladderLlm(["low", "high"]), "p", "m", "off")
  assert.equal(a.effort, null, "显式 off 关不掉 ⇒ 省略 reasoningEffort（D19-3，交还提供方默认档）")
  assert.ok(a.note && a.note.includes("未能关闭推理"), "关不掉必须明说（专属 note，纪要 D-3）")
  const b = await resolveSupportedEffort(ladderLlm(["off", "high"]), "p", "m", "off")
  assert.equal(b.effort, "off")
  assert.equal(b.note, null)
})

test("R1 effort(dsh): 元数据不可得（resolveModelInfo 缺失/抛错）→ fail-open 透传 + 响亮告警 + note", async () => {
  const r1 = await captureWarn(() => resolveSupportedEffort({ stream: () => { } }, "p", "m", "low"))
  assert.equal(r1.value.effort, "low")
  assert.ok(r1.value.note.includes("passed through unverified"), "透传也带 note（设计 §3.1）")
  assert.ok(r1.warnings.some((w) => w.includes("effort metadata unavailable")), "响亮告警 console.warn 留档")
  const throwing = { async resolveModelInfo() { throw new Error("boom") } }
  const r2 = await captureWarn(() => resolveSupportedEffort(throwing, "p", "m", "low"))
  assert.equal(r2.value.effort, "low")
  assert.ok(r2.value.note.includes("lookup failed"))
  assert.ok(r2.warnings.some((w) => w.includes("lookup failed")))
})

// ————————————— 批 19（FR-1/FR-2/FR-3 验收用例 · 设计档 2026-09-17-effort-off-fallback-design.md §8.2/§8.3） —————————————
// 锚覆盖：A5 穷尽差集 · A6/A7 退化兜底与措辞分叉 · A8 显式 off 关不掉 · A9 接线级 null 出口 ·
// A10 五个 dsh 消费点各一条读数断言。每条新断言均为「旧实现下会红」（红的方式见各断言消息：
// 值红 / 键红 / 措辞红——退化支只钉值是恒真断言，判别力全在专属子串「退化兜底」上）。

test("R1 批19 A5: 穷尽 31 个非空支持集（requested=low）——effort 值差集恰 3 组且逐组点名（值面口径；note 面单列）", async () => {
  // 旧语义 oracle：改前 resolveSupportedEffort 对 requested=low 的取值（最近支持档 + 透传；
  // 31 个梯子子集全部与梯子有交集 ⇒ 透传不触发 ⇒ 旧值 = nearestEffort 本体）。nearestEffort
  // 未导出 ⇒ 测试内本地参照实现（与改前 lib 函数体同语义：序距离最近、等距向上取）。
  const LADDER = ["off", "low", "medium", "high", "max"]
  const oldNearest = (supported) => {
    const ri = 1 // "low" 在梯子上的下标
    let best = null
    let bestIdx = -1
    let bestDist = Infinity
    for (const cand of supported) {
      const ci = LADDER.indexOf(cand)
      if (ci < 0) continue
      const dist = Math.abs(ci - ri)
      if (dist < bestDist || (dist === bestDist && ci > bestIdx)) { best = cand; bestIdx = ci; bestDist = dist }
    }
    return best
  }
  const subsets = []
  for (let mask = 1; mask < 32; mask++) subsets.push(LADDER.filter((_, i) => (mask & (1 << i)) !== 0))
  assert.equal(subsets.length, 31, "5 档梯子的非空子集恰 31 个")
  const diffs = []
  for (const s of subsets) {
    const r = await resolveSupportedEffort(ladderLlm(s), "p", "m", "low")
    const oldV = oldNearest(s)
    if (r.effort !== oldV) diffs.push({ set: s.join("|"), from: oldV, to: r.effort })
  }
  assert.deepEqual(diffs, [
    { set: "off|high", from: "off", to: "high" },
    { set: "off|max", from: "off", to: "max" },
    { set: "off|high|max", from: "off", to: "high" },
  ], "改动差集恒等于 3 组（US-4 / N-2：其余 28 个非空集的 effort 值逐字不变；退化集 {off} 值不变而措辞变 ⇒ 由 A6/A7 用例单列钉）")
})

test("R1 批19 A6/A7: 退化集 {off} 五种请求全落 off 且 note 命中退化专属子串（不含普通回落句）；{off,xhigh} 同落退化支（D19-2）", async () => {
  for (const req of ["off", "low", "medium", "high", "max"]) {
    const r = await resolveSupportedEffort(ladderLlm(["off"]), "p", "m", req)
    assert.equal(r.effort, "off", "退化集 {off} 上请求 " + req + " ⇒ 唯一可执行值 off（值与改前相同——判别力在 note 措辞）")
    if (req === "off") {
      assert.equal(r.note, null, "显式 off 受支持 ⇒ 命中快路径无 note（M4 顺序陷阱守卫）")
    } else {
      assert.ok(r.note && r.note.includes("退化兜底"), "退化专属子串可见（只钉值则新旧实现同绿 = 恒真断言）：" + String(r.note))
      assert.ok(!r.note.includes("falling back to nearest supported effort"), "A7：退化支不得复用普通回落句（措辞分叉）")
    }
  }
  // D19-2 边界形状 {off,xhigh}：xhigh 不在插件梯子上 ⇒ cands=[off]、degrees=[] ⇒ 退化支取 off。
  // （若按「nearest 返回 null 即退化」误判，会透传一个已知不被支持的值 ⇒ 秒死路径——本断言就是那条守卫）
  const x = await captureWarn(() => resolveSupportedEffort(ladderLlm(["off", "xhigh"]), "p", "m", "high"))
  assert.equal(x.value.effort, "off", "{off,xhigh} 落退化支（纪要 D-1：off 是该形状唯一已验证可执行值）")
  assert.ok(x.value.note && x.value.note.includes("退化兜底") && x.value.note.includes("off|xhigh"), "退化 note 回显 supported 全集（不掩盖 xhigh 的存在）")
  assert.ok(!x.value.note.includes("falling back to nearest supported effort"), "{off,xhigh} 退化支同样不复用普通回落句")
  assert.ok(x.warnings.some((w) => w.includes("退化兜底")), "退化告警 console.warn 留档")
})

test("R1 批19 A8: 显式 off 关不掉 ⇒ effort null + 专属 note（含「未能关闭推理」，不含 falling back 句）+ console.warn", async () => {
  const r = await captureWarn(() => resolveSupportedEffort(ladderLlm(["low", "high"]), "p", "m", "off"))
  assert.equal(r.value.effort, null, "{low,high} 配 off ⇒ null（用户裁定②：交还提供方默认，不再悄悄改落力度档）")
  assert.ok(r.value.note && r.value.note.includes("未能关闭推理"), "关不掉必须明说（纪要 D-3：对称性只转移值，不转移沉默）")
  assert.ok(!r.value.note.includes("falling back to nearest supported effort"), "不是最近档事件——不得复用回落句（防两侧断言交叉误绿）")
  assert.ok(r.warnings.some((w) => w.includes("未能关闭推理")), "console.warn 响亮留档（A4）")
  for (const efforts of [["medium", "high"], ["max"]]) {
    const x = await resolveSupportedEffort(ladderLlm(efforts), "p", "m", "off")
    assert.equal(x.effort, null, "{" + efforts.join("|") + "} 配 off ⇒ null（旧实现改落 " + efforts[0] + "——用户要关推理却被打开）")
    assert.ok(x.note && x.note.includes("未能关闭推理"))
  }
})

test("R1 批19 A9/A10 接线 consult dsh 行: 显式 off 关不掉 ⇒ agentOptions 无 reasoningEffort 键且 provider/model 仍在", async () => {
  const started = []
  const j = consultJobs()
  const ctx = {
    llm: ladderLlm(["low", "high"]),
    get: (svc) => (svc === "jobs" ? j.jobs : null),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "second opinion" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "r1-consult-dsh-off"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const r = await startConsultSession(
    { ctx, agent, config: { consultModels: [{ provider: "acme", model: "model-a", effort: "off" }] }, state, dshHome: mkdtempSync(join(tmpdir(), "b15-home-")) },
    "problem brief", undefined,
  )
  const digest = await consultDigestOf(state, r.id)
  assert.equal(started.length, 1)
  const ao = started[0].agentOptions
  assert.ok(!("reasoningEffort" in ao), "null ⇒ 键缺席（键在值错正是病灶形态——必须钉键而非钉值）: " + JSON.stringify(ao))
  assert.equal(ao.provider, "acme", "provider 仍传")
  assert.equal(ao.model, "model-a", "model 仍传")
  assert.ok(digest.includes("second opinion"))
  assert.ok(digest.includes("未能关闭推理"), "专属 note 入 digest 尾部（主 agent 可见）")
  dropSession(sid)
})

test("R1 批19 A9/A10 接线 escalate dsh 行: 显式 off 关不掉 ⇒ agentOptions 无 reasoningEffort 键且 provider/model 仍在", async () => {
  const started = []
  const ctx = {
    llm: ladderLlm(["low", "high"]),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "done the work\n\nTouched files: none" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "r1-esc-dsh-off"
  const deps = {
    ctx,
    agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "acme", model: "model-a", effort: "off" }] },
    state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn for a dsh row") }, platform: "linux", env: {},
  }
  const out = await runEscalate(deps, "fix it", undefined)
  assert.ok(out.includes("post-op report"))
  const ao = started[0].agentOptions
  assert.ok(!("reasoningEffort" in ao), "null ⇒ 键缺席: " + JSON.stringify(ao))
  assert.equal(ao.provider, "acme")
  assert.equal(ao.model, "model-a")
  assert.ok(out.includes("未能关闭推理"), "专属 note 入术后报告尾部")
  dropSession(sid)
})

test("R1 批19 A9/A10 接线 eng dsh 分支: 显式 off 关不掉 ⇒ agentOptions 无 reasoningEffort 键且 provider/model 仍在", async () => {
  const started = []
  const subagents = {
    async start(_kind, req) {
      started.push(req)
      return { result: Promise.resolve({ output: [{ type: "text", text: "ok\n\nTouched files: none" }], stopReason: "completed" }), dispose: async () => { } }
    },
  }
  const sid = "r1-eng-dsh-off"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "model-a" } }
  const out = await runEngCoder(
    { ctx: { subagents, llm: ladderLlm(["low", "high"]) }, agent, config: { engCoderEffort: "off" }, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement z", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder delivery:"))
  const ao = started[0].agentOptions
  assert.ok(!("reasoningEffort" in ao), "null ⇒ 键缺席（eng 的 !== null 判空——R-59 已登记）: " + JSON.stringify(ao))
  assert.equal(ao.provider, "acme")
  assert.equal(ao.model, "model-a")
  assert.ok(out.includes("未能关闭推理"), "专属 note 经 warn 通道随工具返回可见")
  dropSession(sid)
})

test("R1 批19 A9/A10 接线 advisor dsh 主路径: 显式 off 关不掉 ⇒ streamOpts 无 reasoningEffort 键且 provider/model 仍在", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const sid = "r1-adv-dsh-off"
  const streamOptsSeen = []
  const llm = {
    ...ladderLlm(["low", "high"]),
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const out = await runAdvisorReview(
    { llm },
    { agent, config: { advisor: { round1: { provider: "acme", model: "model-a", effort: "off", timeoutMs: 300000 } } }, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.equal(streamOptsSeen.length, 1)
  const so = streamOptsSeen[0]
  assert.ok(!("reasoningEffort" in so), "null ⇒ 键缺席: " + JSON.stringify(Object.keys(so)))
  assert.equal(so.provider, "acme")
  assert.equal(so.model, "model-a")
  assert.ok(out.includes("| 1 | a | b |"), "评审正文照常交付")
  assert.ok(out.includes("未能关闭推理"), "专属 note 入结果尾部（finalize 之后，不破坏 completed 判定）")
  dropSession(sid)
})

test("R1 批19 A9/A10 接线 advisor 智能回落轮: 显式 off 关不掉 ⇒ streamOpts 无 reasoningEffort 键且 provider/model 仍在", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const streamOptsSeen = []
  const llm = {
    ...ladderLlm(["low", "high"]),
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "FB REVIEW OUTPUT" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
  const sid = "r1-adv-fb-off"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", effort: "off" } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: { CODEX_HOME: emptyHome } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 ×2（PROCESS_ERROR）
  await run()
  const r3 = await run() // 第 3 轮自动回落 dsh
  assert.ok(r3.includes("自动回落 dsh 路由"))
  assert.ok(r3.includes("FB REVIEW OUTPUT"))
  const so = streamOptsSeen[0]
  assert.ok(!("reasoningEffort" in so), "null ⇒ 键缺席: " + JSON.stringify(Object.keys(so)))
  assert.equal(so.provider, "acme")
  assert.equal(so.model, "model-a")
  assert.ok(r3.includes("未能关闭推理"), "专属 note 入回落轮结果尾部")
  dropSession(sid)
})

test("R1 effort(codex): catalog 命中同名 → 保持；非法档 → 最近档（等距向上取 high）", async () => {
  const cat = catalogSpawn([{ slug: "m1", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }])
  const deps = baseDeps(cat.spawn)
  const keep = await resolveCodexRowEffort(deps, { kind: "codex-cli", model: "m1", executable: "t-eff-keep" }, "low")
  assert.equal(keep.effort, "low")
  assert.equal(keep.note, null)
  const near = await resolveCodexRowEffort(deps, { kind: "codex-cli", model: "m1", executable: "t-eff-keep" }, "medium")
  assert.equal(near.effort, "high", "medium 对 [low,high] 等距 → 向上取 high")
  assert.ok(near.note.includes("falling back to nearest supported effort"))
  assert.ok(near.note.includes("codex model m1"))
})

test("R1 effort(codex): off → null（不传，codex 无 off）", async () => {
  const cat = catalogSpawn([{ slug: "m1", supported_reasoning_levels: [{ effort: "low" }] }])
  const r = await resolveCodexRowEffort(baseDeps(cat.spawn), { kind: "codex-cli", model: "m1", executable: "t-eff-off" }, "off")
  assert.equal(r.effort, null)
  assert.equal(r.note, null)
})

test("R1 effort(codex): catalog 未命中模型 / 目录不可得 / 未配 model → fail-open 透传 + 响亮告警", async () => {
  const cat = catalogSpawn([{ slug: "other", supported_reasoning_levels: [{ effort: "low" }] }])
  const r1 = await captureWarn(() => resolveCodexRowEffort(baseDeps(cat.spawn), { kind: "codex-cli", model: "m-missing", executable: "t-eff-miss" }, "low"))
  assert.equal(r1.value.effort, "low")
  assert.ok(r1.value.note.includes("未命中 codex 模型目录"))
  assert.ok(r1.warnings.some((w) => w.includes("未命中")))
  // 目录不可得：debug models 退出码非零 + CODEX_HOME 指向空目录（无 models_cache.json 兜底，隔离真机 ~/.codex）
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const bad = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 1 }
  })
  const r2 = await captureWarn(() => resolveCodexRowEffort({ spawn: bad, platform: "linux", env: { CODEX_HOME: emptyHome } }, { kind: "codex-cli", model: "m1", executable: "t-eff-bad" }, "low"))
  assert.equal(r2.value.effort, "low")
  assert.ok(r2.value.note.includes("codex 模型目录不可得"))
  assert.ok(r2.warnings.some((w) => w.includes("目录不可得")))
  // runner 未配 model（codex 自身默认模型——无法按目录校验）
  const r3 = await captureWarn(() => resolveCodexRowEffort(baseDeps(cat.spawn), { kind: "codex-cli" }, "low"))
  assert.equal(r3.value.effort, "low")
  assert.ok(r3.value.note.includes("未配置 model"))
})

test("R1 接线 consult dsh 行：effort 按行 provider/model 解析（agentOptions 收最近档）+ note 入回复尾部", async () => {
  const started = []
  const j = consultJobs()
  const ctx = {
    llm: ladderLlm(["off", "high", "max"]),
    get: (svc) => (svc === "jobs" ? j.jobs : null),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "second opinion" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "r1-consult-dsh"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const r = await startConsultSession(
    { ctx, agent, config: { consultModels: [{ provider: "acme", model: "model-a-flash", effort: "low" }] }, state, dshHome: mkdtempSync(join(tmpdir(), "b15-home-")) },
    "problem brief", undefined,
  )
  const digest = await consultDigestOf(state, r.id)
  assert.equal(started.length, 1)
  assert.equal(started[0].agentOptions.reasoningEffort, "high", "low 对 [off,high,max] 回落 high（off 不参与距离竞争，批 19）")
  assert.ok(digest.includes("second opinion"))
  assert.ok(digest.includes("falling back to nearest supported effort"), "note 入回复尾部（主agent 可见）")
  dropSession(sid)
})

test("R1 接线 consult codex 行：effort 经 codex catalog 校验（argv 最近档）+ note 入回复", async () => {
  const cat = catalogSpawn([{ slug: "m-cc", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "codex opinion" })
  const sid = "r1-consult-codex"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const j = consultJobs()
  const deps = {
    ctx: { get: (svc) => (svc === "jobs" ? j.jobs : null) },
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc", effort: "medium", executable: "t-cc-1" } }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
    dshHome: mkdtempSync(join(tmpdir(), "b15-home-")),
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  const digest = await consultDigestOf(state, r.id)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "medium 对 [low,high] 等距向上 → high")
  assert.ok(digest.includes("codex opinion"))
  assert.ok(digest.includes("falling back to nearest supported effort"))
  dropSession(sid)
})

test("R1 接线 escalate dsh 行：effort 按行 provider/model 解析（agentOptions）+ note 入术后报告尾部", async () => {
  const started = []
  const ctx = {
    llm: ladderLlm(["low", "high"]),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "done the work\n\nTouched files: none" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "r1-esc-dsh"
  const deps = {
    ctx,
    agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "acme", model: "model-a", effort: "medium" }] },
    state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn for a dsh row") }, platform: "linux", env: {},
  }
  const out = await runEscalate(deps, "fix it", undefined)
  assert.ok(out.includes("post-op report"))
  assert.equal(started[0].agentOptions.reasoningEffort, "high", "medium 对 [low,high] 等距向上取")
  assert.ok(out.includes("falling back to nearest supported effort"), "note 入报告尾部")
  dropSession(sid)
})

test("R1 接线 escalate codex 行：effort 经 codex catalog 回落进 argv + note 入报告", async () => {
  const cat = catalogSpawn([{ slug: "m-esc", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m-esc", effort: "medium", executable: "t-esc-1" } }], codexCli: { executable: "t-esc-1" } }
  const sid = "r1-esc-codex"
  const out = await runEscalate(makeEscDeps(sid, cat.spawn, cfg), "x", undefined)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "argv 收最近支持档")
  assert.ok(out.includes("falling back to nearest supported effort"))
  dropSession(sid)
})

test("R1 接线 escalate codex 行：effort=off → argv 不传 model_reasoning_effort（codex 无 off）", async () => {
  const cat = catalogSpawn([{ slug: "m-esc2", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m-esc2", effort: "off", executable: "t-esc-2" } }], codexCli: { executable: "t-esc-2" } }
  const sid = "r1-esc-codex-off"
  const out = await runEscalate(makeEscDeps(sid, cat.spawn, cfg), "x", undefined)
  assert.ok(!cat.seenArgs().some((a) => String(a).includes("model_reasoning_effort")), "off → null 不传（全 argv 无 effort 配置项）: " + JSON.stringify(cat.seenArgs()))
  assert.ok(out.includes("post-op report"))
  dropSession(sid)
})

test("R1 接线 eng codex 分支：effort 走 codex resolver（argv 最近档）+ dsh 解析不在 codex 分支跑（误导告警消除）", async () => {
  const cat = catalogSpawn([{ slug: "m-eng", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "implemented\n\nTouched files: src/x.ts" })
  const sid = "r1-eng-codex"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "parent-model" } }
  const config = { engCoderEffort: "medium", codexCli: { engCoderRunner: "codex-cli", model: "m-eng", executable: "t-eng-1" } }
  const out = await runEngCoder(
    {
      ctx: {
        subagents: { start: () => { throw new Error("dsh spawn must not run for codex backend") } },
        // 若 dsh 侧解析误跑（D-02 旧缺陷：eng:385 在 codex 分支也执行），会产出含 parent-model 的 effort 告警
        llm: ladderLlm(["low"]),
      },
      agent, config, signal: undefined, configDefaultEngineering: false, spawn: cat.spawn, platform: "linux", env: {},
    },
    { task: "implement x", designToken: token, docs: [] },
  )
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "medium → high（等距向上）")
  assert.ok(out.includes("eng_coder delivery (codex-cli)"))
  assert.ok(out.includes("falling back to nearest supported effort"))
  assert.ok(!out.includes("parent-model"), "codex 分支不跑 dsh 侧解析（eng:385 误导告警消除，D-02）")
  dropSession(sid)
})

test("R1 接线 eng dsh 分支：effort 按父代理路由模型解析（agentOptions 最近档）+ note 走 warn 通道", async () => {
  const started = []
  const subagents = {
    async start(_kind, req) {
      started.push(req)
      return { result: Promise.resolve({ output: [{ type: "text", text: "ok\n\nTouched files: none" }], stopReason: "completed" }), dispose: async () => { } }
    },
  }
  const sid = "r1-eng-dsh"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "model-a-flash" } }
  const out = await runEngCoder(
    { ctx: { subagents, llm: ladderLlm(["off", "high", "max"]) }, agent, config: { engCoderEffort: "low" }, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement y", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder delivery:"))
  assert.equal(started[0].agentOptions.reasoningEffort, "high", "low 对 [off,high,max] 回落 high（off 不参与距离竞争，批 19）")
  assert.ok(out.includes("is not supported by model model-a-flash"), "note 经 warn 通道随工具返回可见")
  dropSession(sid)
})

test("R1 接线 advisor codex 行：runner.effort 经 catalog 校验回落（argv）+ note 并入结果尾部", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const cat = catalogSpawn([{ slug: "m-adv", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "r1-adv-codex"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "m-adv", effort: "medium" }, timeoutMs: 300000 } }, codexCli: { executable: "t-adv-1" } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn: cat.spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "argv 收最近支持档（buildCodexArgs 之前收口）")
  assert.ok(out.includes("Issue"), "评审正文照常交付")
  assert.ok(out.includes("falling back to nearest supported effort"), "note 并入结果尾部")
  assert.ok(!out.startsWith("Advisor:"), "回落 note 是后缀——不破坏 completed 判定")
  dropSession(sid)
})

test("R1 接线 advisor codex 行：组环 effort（runner.effort 未配）同样解析并真正生效（消灭静默丢弃）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const cat = catalogSpawn([{ slug: "m-adv2", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "r1-adv-codex2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "m-adv2" }, effort: "low", timeoutMs: 300000 } }, codexCli: { executable: "t-adv-2" } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn: cat.spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="low"'), "组环 effort 对 codex 行生效（此前被 runner 静默丢弃）")
  assert.ok(!out.includes("falling back"), "low 受支持 → 无回落 note")
  dropSession(sid)
})

test("R1 接线 advisor dsh 主路径：effort 按路由模型解析（stream reasoningEffort 最近档）+ note 入尾部", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const sid = "r1-adv-dsh"
  const streamOptsSeen = []
  const llm = {
    ...ladderLlm(["off", "high", "max"]),
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const out = await runAdvisorReview(
    { llm },
    { agent, config: { advisor: { round1: { provider: "acme", model: "model-a-flash", effort: "low", timeoutMs: 300000 } } }, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.equal(streamOptsSeen[0].reasoningEffort, "high", "low 对 [off,high,max] 回落 high（off 不参与距离竞争，批 19）")
  assert.ok(out.includes("falling back to nearest supported effort"))
  dropSession(sid)
})

test("R1 接线 advisor 回落轮：回落模型 effort 按其实际档位解析（stream reasoningEffort 最近档）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const streamOptsSeen = []
  const llm = {
    ...ladderLlm(["off", "high"]),
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "FB REVIEW OUTPUT" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
  const sid = "r1-adv-fb"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", effort: "medium" } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: { CODEX_HOME: emptyHome } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 ×2（PROCESS_ERROR）
  await run()
  const r3 = await run() // 第 3 轮自动回落 dsh
  assert.ok(r3.includes("自动回落 dsh 路由"))
  assert.ok(r3.includes("FB REVIEW OUTPUT"))
  assert.equal(streamOptsSeen[0].reasoningEffort, "high", "回落模型 medium 对 [off,high] 最近 = high")
  dropSession(sid)
})

// ————————————— R1 D-18/D-01：结构化观测 + 空响应分类 + D-17 dsh 预算钳制 —————————————

/** advisor dsh 评审 stub：stream 返回注入的块/finish 序列（无 effort/无工具轮）。 */
function reviewLlm(chunks) {
  return {
    stream() {
      return (async function* () {
        for (const c of chunks) yield c
      })()
    },
  }
}

const REVIEW_TABLE = { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }

async function runDshReview(sid, llm, config, deps = {}) {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  return runAdvisorReview(
    { llm, ...deps },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
}

test("R1 D-01 观测: 空响应形态一 finish-null —— 分类行 + 观测字段（finish/blocks/usage）+ console.warn 留档", async () => {
  const sid = "r1-empty-null"
  const llm = reviewLlm([]) // 流直接结束：零块、零 finish（重试一次同样空——R3 D-01 后 stream 被调两次）
  const r = await captureWarn(() => runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } }))
  const out = r.value
  assert.ok(out.startsWith("Advisor: review failed (empty response"), "R3 语义：重试一次仍空 → 前缀失败: " + out.slice(0, 80))
  assert.ok(out.includes("重试一次仍空"), "重试标记可见（D-裁决-1）")
  assert.ok(out.includes("empty-response classification: finish-null"), "三形态之一：finish null")
  assert.ok(out.includes("stream observation: finish=null"), "观测字段：finish kind")
  assert.ok(out.includes("blocks(text=0,tool-call=0)"), "观测字段：block 计数")
  assert.ok(out.includes("usage=none"), "观测字段：usage")
  assert.ok(r.warnings.some((w) => w.includes("stream observation: finish=null")), "console.warn 留档（D-18）")
  assert.ok(r.warnings.some((w) => w.includes("自动重试一次")), "重试 console.warn 留档（R3 D-01）")
  dropSession(sid)
})

test("R1 D-01 观测: 空响应形态二 stop 零文本块 —— 分类行 + finish 携带的 usage 入观测", async () => {
  const sid = "r1-empty-stop"
  const llm = reviewLlm([
    { type: "finish", reason: { kind: "stop" }, usage: { inputTokens: 5, outputTokens: 0 } },
  ])
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.ok(out.startsWith("Advisor: review failed (empty response"), "R3 语义：重试一次仍空 → 前缀失败")
  assert.ok(out.includes("重试一次仍空"), "重试标记可见")
  assert.ok(out.includes("empty-response classification: stop-zero-text-blocks"), "三形态之二：stop 零块")
  assert.ok(out.includes("stream observation: finish=stop"))
  assert.ok(out.includes('"inputTokens":5'), "finish 携带的 usage 入观测字段")
  dropSession(sid)
})

test("R1 D-01 观测: 空响应形态三 error 无 message —— 失败文本带分类行（不再坍缩为 unknown provider error）", async () => {
  const sid = "r1-empty-error"
  const llm = reviewLlm([
    { type: "finish", reason: { kind: "error", failure: {} } },
  ])
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.ok(out.startsWith("Advisor: review failed — unknown provider error"))
  assert.ok(out.includes("empty-response classification: error-no-message"), "三形态之三：error 无 message（有独立路径但同样可归因）")
  assert.ok(out.includes("stream observation: finish=error"))
  dropSession(sid)
})

test("R1 D-01 观测: finish=length 显式分类（生产复现根因：推理烧光 maxTokens 零正文）", async () => {
  const sid = "r1-empty-length"
  const llm = reviewLlm([
    { type: "finish", reason: { kind: "length" } },
  ])
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.ok(out.startsWith("Advisor: review failed (empty response"), "R3 语义：重试一次仍空 → 前缀失败")
  assert.ok(out.includes("重试一次仍空"), "重试标记可见")
  assert.ok(out.includes("empty-response classification: length"), "length 显式分类（登记表 D-01 修复要求）")
  assert.ok(out.includes("advisor.maxOutputTokens"), "maxTokens 不足的独立诊断指引")
  dropSession(sid)
})

test("R1 D-17: advisor dsh 主路径预算钳制——timeoutMs>budgetCap → 生效值=budgetCap + 结果尾部截断告警", async () => {
  const sid = "r1-dsh-clamp"
  const t0 = Date.now()
  const llm = { stream: () => (async function* () { await new Promise(() => { }) })() } // 静默挂起流：等 deadline
  const out = await runDshReview(sid, llm, {
    advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } },
    codexCli: { budgetCapMs: 400 },
  })
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, "生效预算 = budgetCap（400ms 量级 deadline 生效，未钳制则 900s 挂死）: " + elapsed + "ms")
  assert.ok(out.startsWith("Advisor: review timeout after"), "预算到点即 timeout")
  assert.ok(out.includes("已按 codexCli.budgetCapMs=400ms 截断执行"), "结果尾部截断告警（镜像 codex 同步路径）")
  assert.ok(out.includes("900000ms"), "原预算可见")
  dropSession(sid)
})

test("R1 D-17: advisor 回落轮预算钳制（fbRoute.timeoutMs > budgetCap → 回落轮跑 budgetCap + 尾部告警）", async () => {
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
  const sid = "r1-fb-clamp"
  const llm = { stream: () => (async function* () { await new Promise(() => { }) })() }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "p", model: "m", timeoutMs: 900000 } }, codexCli: { budgetCapMs: 400 } }
  const deps = { llm, spawn, platform: "linux", env: { CODEX_HOME: emptyHome } }
  await runDshReview(sid, llm, config, deps) // codex 失败 ×1
  await runDshReview(sid, llm, config, deps) // codex 失败 ×2
  const t0 = Date.now()
  const out = await runDshReview(sid, llm, config, deps) // 第 3 轮回落 dsh（预算 900000 → 钳 400）
  const elapsed = Date.now() - t0
  assert.ok(out.includes("自动回落 dsh 路由"), "回落路径已触发")
  assert.ok(elapsed < 5000, "回落轮生效预算 = budgetCap: " + elapsed + "ms")
  assert.ok(out.includes("Advisor: review timeout after"), "回落轮预算到点即 timeout（前缀前有组配置 warnPrefix——codex 路由的 UX 告警）")
  assert.ok(out.includes("已按 codexCli.budgetCapMs=400ms 截断执行"), "回落轮截断告警")
  dropSession(sid)
})

test("R1 D-18: codex TIMEOUT 上浮 usage（信封 + 诊断）+ stderr 保留改尾部 4K", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return {
      events: [
        { stream: "stdout", data: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } }) + "\n" },
        { stream: "stderr", data: "HEAD-NOISE-" + "x".repeat(5000) },
        { stream: "stderr", data: "TAIL-MARKER-FATAL-HERE" },
      ],
      hang: true, // 等 watchdog 触发 TIMEOUT
    }
  })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 300, runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "TIMEOUT")
  assert.deepEqual(env.usage, { inputTokens: 11, outputTokens: 7 }, "TIMEOUT 信封上浮 usage（此前只捕获不上浮）")
  assert.ok(env.diagnostics.includes('"inputTokens":11'), "TIMEOUT 诊断含 usage")
  assert.ok(env.diagnostics.includes("TAIL-MARKER-FATAL-HERE"), "stderr 保留尾部（可用错误在尾）")
  assert.ok(!env.diagnostics.includes("HEAD-NOISE"), "头部启动噪音被裁掉（保尾 4K）")
})

test("R1 D-18: codex PROCESS_ERROR 诊断含 usage + stderr 保尾", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return {
      events: [
        { stream: "stdout", data: JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4 } }) + "\n" },
        { stream: "stderr", data: "HEAD-NOISE-" + "y".repeat(5000) + "FATAL-TAIL-CODE" },
      ],
      exitCode: 1,
    }
  })
  const env = await runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", runner: RUNNER, globals: GLOBALS })
  assert.equal(env.code, "PROCESS_ERROR")
  assert.deepEqual(env.usage, { inputTokens: 3, outputTokens: 4 })
  assert.ok(env.diagnostics.includes('"outputTokens":4'), "PROCESS_ERROR 诊断上浮 usage")
  assert.ok(env.diagnostics.includes("FATAL-TAIL-CODE"), "stderr 保尾")
  assert.ok(!env.diagnostics.includes("HEAD-NOISE"), "头部被裁（保尾 4K）")
})

// ————————————— R1 §3.6（D-01 热修正式化）：advisor.maxOutputTokens 三面白名单同步 —————————————

test("R1 maxOutputTokens 三面同步: PUT 接受合法值 ⊕ merge 保留 ⊕ 运行时生效", async () => {
  // 面 1：PUT 校验（index.mjs validateGlobalUserConfig 经 makeApiHandler 真实 PUT 路径）
  const { makeApiHandler } = await import("../lib/index.mjs")
  const handler = makeApiHandler(fenceCtx(), { baseConfig: {}, dshHomeOverride: mkdtempSync(join(tmpdir(), "maxout-")) })
  const req = { method: "PUT", url: "/thincoder-suite/api/config", [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ config: { advisor: { maxOutputTokens: 8192 } } })) } }
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler(req, res)
  assert.equal(res.statusCode, 200, "PUT 接受合法值: " + res.body)
  assert.equal(JSON.parse(res.body).user.advisor.maxOutputTokens, 8192, "sanitized 保留")
  // 面 2：配置合并（config-store.mjs mergeGlobalConfig 白名单透传）
  const merged = mergeGlobalConfig({}, { advisor: { maxOutputTokens: 8192 } })
  assert.equal(merged.advisor.maxOutputTokens, 8192, "merge 保留（user 层覆盖 base）")
  // 面 3：运行时生效（advisor.mjs stream opts maxTokens = effectiveGlobalConfig 解析值）
  const sid = "r1-maxout"
  const streamOptsSeen = []
  const llm = {
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 }, maxOutputTokens: 4096 } })
  assert.equal(streamOptsSeen[0].maxTokens, 4096, "运行时 stream opts 收配置值（热修 16384 常量退役为缺省）")
  assert.ok(out.includes("| 1 |"), "评审照常交付")
  dropSession(sid)
})

test("R1 maxOutputTokens: PUT 拒绝区间外/非整数（B12 字段级错误，越界值不落盘）", async () => {
  const bad1 = validateGlobalUserConfig({ advisor: { maxOutputTokens: 100 } }, [])
  assert.equal(bad1.ok, false)
  assert.ok(bad1.errors.some((e) => e.includes("maxOutputTokens")))
  const bad2 = validateGlobalUserConfig({ advisor: { maxOutputTokens: 70000 } }, [])
  assert.equal(bad2.ok, false)
  assert.ok(bad2.errors.some((e) => e.includes("4096..65536")))
  const bad3 = validateGlobalUserConfig({ advisor: { maxOutputTokens: 8192.5 } }, [])
  assert.equal(bad3.ok, false)
  assert.equal(bad3.sanitized.advisor, undefined, "越界值不进 sanitized（不落盘）")
})

test("R1 maxOutputTokens: 运行时非法值（手编 config.json）→ 回落缺省 16384 + 响亮告警", async () => {
  const sid = "r1-maxout-bad"
  const streamOptsSeen = []
  const llm = {
    stream(opts) {
      streamOptsSeen.push(opts)
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const r = await captureWarn(() => runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 }, maxOutputTokens: 100 } }))
  assert.equal(streamOptsSeen[0].maxTokens, 16384, "越界回落缺省（绝不砖化评审）")
  assert.ok(r.warnings.some((w) => w.includes("advisor.maxOutputTokens") && w.includes("16384")), "越界告警 console.warn 留档")
  assert.ok(r.value.includes("| 1 |"), "评审照常交付")
  dropSession(sid)
})

// ————————————— R2 §4.1 Stage 1：escalate codex jobs 迁移（D-03/D-04/D-09/D-20） —————————————

test("R2 escalate codex jobs: 预算>cap 且 jobs 可用 → 派发 + 句柄/UI-2 接续指令 + 簿记在 done 成功分支恰好一次", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-job-t1" }) + "\n" }], exitCode: 0, outText: "did the work in background\n\nTouched files: lib/j.mjs" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid = "esc-jobs-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  deps.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out = await runEscalate(deps, "fix the bug", undefined)
  assert.ok(out.includes("escalate-codex-1"), "返回 branded string job 句柄: " + out.slice(0, 140))
  assert.ok(out.includes("等待完成通知后再继续"), "UI-2：等待完成通知的接续指令")
  assert.ok(out.includes("勿用 job_output wait"), "UI-2：勿用 job_output 阻塞等待指令")
  assert.ok(out.includes("900s"), "句柄文本携带预算")
  assert.ok(!out.includes("post-op report"), "派发即返回句柄（不是交付报告）")
  assert.equal(specs.length, 1)
  assert.equal(specs[0].payload.kind, "escalate-codex", "job kind 机制专属")
  assert.equal(specs[0].payload.owner, deps.agent, "owner 绑定发起 agent（cancel/通知路由）")
  assert.ok(specs[0].payload.label.includes("900s"), "job label 含预算")
  assert.equal(typeof specs[0].hooks.cancel, "function", "hooks.cancel（→ ctrl.abort）存在")
  const st0 = sessionState(sid)
  assert.deepEqual(st0.touchedFiles ?? [], [], "派发即返回：簿记尚未发生（done 未 settle）")
  assert.equal(st0.mutatedThisRun ?? false, false)
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(outcome.output.includes("post-op report"), "交付报告进 job output（经 job_output 读取）")
  assert.ok(outcome.output.includes("did the work in background"))
  const st = sessionState(sid)
  assert.deepEqual(st.touchedFiles, ["lib/j.mjs"], "D-20：簿记在 done 成功分支恰好一次")
  assert.equal(st.mutatedThisRun, true)
  dropSession(sid)
})

test("R2 escalate codex jobs: 失败交付 → done failed 分支不簿记（D-20）+ partial Touched 行 advisory 解析（D-11）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    // 非零退出 + 部分输出（含 Touched 行）——PROCESS_ERROR 保留 text 为 partial
    return { events: [], exitCode: 1, outText: "half-written report\nTouched files: lib/half.mjs" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid = "esc-jobs-fail-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  deps.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  await runEscalate(deps, "will fail", undefined)
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "failed")
  assert.ok(outcome.output.includes("codex-cli PROCESS_ERROR"), "失败诊断进通知/output")
  assert.ok(outcome.output.includes("lib/half.mjs"), "partial 输出可见")
  assert.ok(outcome.output.includes("advisory"), "partial 内 Touched 行作 advisory 解析（不并入审计范围）")
  const st = sessionState(sid)
  assert.deepEqual(st.touchedFiles ?? [], [], "D-20：失败交付不并 touched")
  assert.equal(st.mutatedThisRun ?? false, false, "D-20：失败交付不置 mutatedThisRun")
  dropSession(sid)
})

test("R2 escalate codex: jobs 缺失 → 同步钳制（900000 → budgetCap 540000）+ 响亮告警（绝不无声）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "sync did the work\n\nTouched files: none" }
  })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid = "esc-jobs-missing-r2"
  const deps = makeEscDeps(sid, spawn, cfg) // ctx: {} → jobs 缺失
  const r = await captureWarn(() => runEscalate(deps, "x", undefined))
  assert.ok(r.value.includes("post-op report"), "同步降级路径照常交付")
  assert.ok(r.value.includes("budgetCapMs=540000ms"), "截断告警随结果可见（镜像 advisor 同步降级）")
  assert.ok(r.value.includes("900000ms"), "原预算可见")
  assert.ok(r.warnings.some((w) => w.includes("ctx.jobs 不可用") && w.includes("540000")), "响亮告警 console.warn 留档")
  dropSession(sid)
})

test("R2 D-04: followup 预算与首次同链——jobs 可用 → 全预算派发（resume）；jobs 缺失 → 钳制同步（不再零余量撞墙）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-d4-tid" }) + "\n" }], exitCode: 0, outText: "done\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid = "esc-d4-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  deps.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps, "first", undefined)
  assert.ok(out1.includes("escalate-codex-1"))
  await specs[0].hooks.done // 首次交付 settle → 保存线程
  // followup（jobs 仍在）：同链派发——第二个 job，全预算 + resume 线程
  const out2 = await runEscalate(deps, "followup tweak", undefined, true)
  assert.ok(out2.includes("escalate-codex-2"), "followup 走 jobs 派发（D-04：预算与首次同链）")
  assert.ok(out2.includes("(resume)"), "句柄文本标注 resume")
  assert.ok(specs[1].payload.label.includes("resume") && specs[1].payload.label.includes("900s"), "job label 标注 resume + 全预算")
  const outcome2 = await specs[1].hooks.done
  assert.equal(outcome2.status, "completed")
  assert.ok(outcome2.output.includes(", resume) post-op report"), "followup 交付标注 resume 轮")
  // followup（jobs 缺失）：钳制同步——D-04 旧缺陷 = runner.timeoutMs 原样透传零余量撞墙
  const depsNoJobs = makeEscDeps(sid, spawn, cfg) // ctx: {} → jobs 缺失
  const out3 = await runEscalate(depsNoJobs, "sync followup", undefined, true)
  assert.ok(out3.includes("post-op report"), "同步降级照常交付")
  assert.ok(out3.includes("budgetCapMs=540000ms"), "D-04：followup 同步路径同样钳制（旧缺陷=不钳制）")
  assert.ok(out3.includes("resume)"), "同步 followup 同样走 resume")
  dropSession(sid)
})

test("R2 回归(R1 审计🔵5): followup 复用首次交付保存的已解析 runner——effort 不重复解析", async () => {
  let debugCalls = 0
  const seen = []
  const catalog = JSON.stringify({ models: [{ slug: "m-re", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] })
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    if (args.includes("debug") && args.includes("models")) { debugCalls++; return { events: [{ data: catalog }], exitCode: 0 } }
    seen.push(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "re-tid" }) + "\n" }], exitCode: 0, outText: "done\n\nTouched files: none" }
  })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m-re", effort: "medium", executable: "t-re-1" } }], codexCli: { executable: "t-re-1" } }
  const sid = "esc-reuse-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  const out1 = await runEscalate(deps, "first", undefined)
  assert.ok(seen[0].includes('model_reasoning_effort="high"'), "首次：medium 对 [low,high] 等距向上 → high")
  assert.equal(debugCalls, 1, "首次解析查一次目录")
  assert.ok(out1.includes("falling back to nearest supported effort"), "首次回落 note 可见")
  const out2 = await runEscalate(deps, "followup tweak", undefined, true)
  assert.ok(seen[1].includes('model_reasoning_effort="high"'), "followup 复用已解析 effort（high 保持）")
  assert.equal(debugCalls, 1, "followup 不重复解析（目录零依赖——锁死 R1 审计 🔵5 语义）")
  assert.ok(!out2.includes("falling back") && !out2.includes("目录不可得"), "followup 无解析 note（不重复解析）")
  dropSession(sid)
})

// ————————————— R2 §4.1 Stage 2：eng_coder codex jobs 迁移（D-03/D-20） —————————————

function makeEngDepsR2(sid, jobs, spawn, config, extra = {}) {
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: {} }
  return {
    deps: {
      ctx: { get: (svc) => (svc === "jobs" ? jobs : null), subagents: { start: () => { throw new Error("dsh spawn must not run for codex backend") } } },
      agent, config, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {}, ...extra,
    },
    token,
  }
}

test("R2 eng_coder codex jobs: 预算>cap 且 jobs 可用 → 派发 + 句柄文本 + 交付簿记在 done 成功分支恰好一次", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "eng-job-t1" }) + "\n" }], exitCode: 0, outText: "implemented in background\n\nTouched files: src/bg.ts" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "eng-jobs-r2"
  const st = sessionState(sid)
  st.advisorRound = 2 // 有前置轮次 → 验证 done 内重置恰好一次
  st.lastAdvisorOutput = "prior review"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath } })
  const out = await runEngCoder(deps, { task: "implement x", designToken: token, docs: [] })
  assert.ok(out.includes("eng-codex-1"), "返回 branded string job 句柄: " + out.slice(0, 140))
  assert.ok(out.includes("等待完成通知后再继续"), "UI-2：等待完成通知的接续指令")
  assert.ok(out.includes("勿用 job_output wait"), "UI-2：勿用 job_output 阻塞等待指令")
  assert.ok(out.includes("1800s"), "句柄文本携带默认 30min 全预算")
  assert.ok(!out.includes("eng_coder delivery"), "派发即返回句柄（不是交付报告）")
  assert.equal(specs.length, 1)
  assert.equal(specs[0].payload.kind, "eng-codex", "job kind 机制专属")
  assert.equal(specs[0].payload.owner, deps.agent, "owner 绑定发起 agent")
  assert.equal(typeof specs[0].hooks.cancel, "function", "hooks.cancel（→ ctrl.abort）存在")
  assert.equal(sessionState(sid).advisorRound, 2, "派发即返回：轮次未重置（done 未 settle）")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(outcome.output.includes("eng_coder delivery (codex-cli)"), "交付报告进 job output")
  assert.ok(outcome.output.includes("implemented in background"))
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 0, "D-20：轮次重置在 done 成功分支恰好一次")
  assert.equal(st2.lastAdvisorOutput, null, "prior 清除")
  assert.ok(st2.touchedFiles.includes("src/bg.ts"), "touched 合并")
  assert.equal(st2.mutatedThisRun, true, "mutatedThisRun 置位")
  dropSession(sid)
})

test("R2 eng_coder codex jobs D-20: 失败交付 → 不重置轮次/不置 mutated/不并 touched（partial touched 仅 advisory）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 1, outText: "half-written delivery\n\nTouched files: src/half.ts" } // PROCESS_ERROR + partial
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "eng-jobs-fail-r2"
  const st = sessionState(sid)
  st.advisorRound = 3
  st.lastAdvisorOutput = "prior review round 3"
  st.touchedFiles = ["src/existing.ts"]
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath } })
  await runEngCoder(deps, { task: "implement y", designToken: token, docs: [] })
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "failed")
  assert.ok(outcome.output.includes("codex-cli PROCESS_ERROR"), "失败诊断进 output")
  assert.ok(outcome.output.includes("src/half.ts"), "partial 输出可见")
  assert.ok(outcome.output.includes("advisory"), "D-11：partial Touched 行 advisory 解析（不并入审计范围）")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 3, "D-20：失败交付不重置轮次（评审预算不被销毁）")
  assert.equal(st2.lastAdvisorOutput, "prior review round 3", "D-20：prior 不被清")
  assert.deepEqual(st2.touchedFiles, ["src/existing.ts"], "D-20：partial touched 不并入")
  assert.equal(st2.mutatedThisRun ?? false, false, "D-20：失败交付不置 mutatedThisRun")
  dropSession(sid)
})

test("R2 eng_coder codex 同步降级 D-20: jobs 缺失 → 钳制同步执行，失败交付同样不簿记", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "" } // NO_OUTPUT 失败
  })
  const sid = "eng-sync-fail-r2"
  const st = sessionState(sid)
  st.advisorRound = 1
  st.lastAdvisorOutput = "prior"
  const { deps, token } = makeEngDepsR2(sid, null, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath } })
  const r = await captureWarn(() => runEngCoder(deps, { task: "implement z", designToken: token, docs: [] }))
  assert.ok(r.value.includes("eng_coder ended: codex-cli NO_OUTPUT"), "同步降级路径失败诊断")
  assert.ok(r.value.includes("budgetCapMs=540000ms"), "钳制告警可见（1800000 → 540000）")
  assert.ok(r.warnings.some((w) => w.includes("ctx.jobs 不可用") && w.includes("eng_coder")), "响亮告警留档")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 1, "D-20：同步降级路径失败同样不重置轮次")
  assert.equal(st2.lastAdvisorOutput, "prior")
  assert.equal(st2.mutatedThisRun ?? false, false, "不置 mutated")
  dropSession(sid)
})

test("R2 eng_coder dsh 路径 D-20: stopReason != completed → 不簿记（不重置轮次/不置 mutated）", async () => {
  const sid = "eng-dsh-fail-r2"
  const st = sessionState(sid)
  st.engineering = true
  st.advisorRound = 2
  st.lastAdvisorOutput = "prior review"
  const token = makeEngToken(st)
  const subagents = {
    async start() {
      return { result: Promise.resolve({ output: [{ type: "text", text: "died midway\n\nTouched files: src/dead.ts" }], stopReason: "interrupted", diagnostic: "killed" }), dispose: async () => { } }
    },
  }
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }
  const out = await runEngCoder(
    { ctx: { subagents, llm: ladderLlm(["low"]) }, agent, config: {}, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement w", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder ended: interrupted"), "失败诊断")
  assert.ok(out.includes("src/dead.ts"), "partial 输出可见")
  assert.ok(out.includes("advisory"), "partial Touched 行 advisory（不并入）")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 2, "D-20：失败交付不重置轮次")
  assert.equal(st2.lastAdvisorOutput, "prior review", "prior 不被清")
  assert.deepEqual(st2.touchedFiles ?? [], [], "touched 不并入")
  assert.equal(st2.mutatedThisRun ?? false, false, "不置 mutated")
  dropSession(sid)
})

// ————————————— R2 §4.3/§4.4 Stage 3：single-flight 复合键 + advisorGeneration 代际 + D-05/D-09 —————————————

test("R2 D-06: single-flight 复合键 sessionId+mechanism——同机制在飞二次调用被拒（含 job id），异机制不受阻，settle 后可再派", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid = "sf-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  deps.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps, "first", undefined)
  assert.ok(out1.includes("escalate-codex-1"), "首次派发成功")
  // 同机制二次调用 → 拒绝（含在飞 job id 与接续方式）
  const out2 = await runEscalate(deps, "second while in flight", undefined)
  assert.ok(out2.startsWith("Error"), "在飞时二次调用被拒")
  assert.ok(out2.includes("escalate-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("job_output"), "拒绝文本含接续方式")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "没有第二个 job 被派发")
  // 异机制（advisor）：批 21（FR-2 / D21-2）起 escalate 在飞 ⇒ **code 型评审**被跨机制护栏拒绝（错序评审窗口封堵——文本点名 job id）；design 型不受阻（AC-8，advisor-config 新腿见证）；复合键独立性对其余方向保持
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const outA = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(outA.startsWith("Error") && outA.includes("escalate-codex-1") && outA.includes("本次请求未派发"), "批 21（FR-2/D21-2）：escalate 在飞 ⇒ code 型评审被跨机制护栏拒绝（点名在飞 job id）: " + outA.slice(0, 120))
  assert.equal(specs.length, 1, "护栏拒绝 ⇒ advisor job 未派发（specs 不增）")
  // escalate job settle → 槽位清除 → 可再次派发
  await specs[0].hooks.done
  const out3 = await runEscalate(deps, "after settle", undefined)
  assert.ok(out3.includes("escalate-codex-2"), "settle 后槽位清除，可再次派发")
  assert.equal(specs.length, 2)
  dropSession(sid)
})

test("R2 D-06: eng 机制槽位——eng 在飞时二次 eng_coder 被拒", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "implemented\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "sf-eng-r2"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath } })
  const out1 = await runEngCoder(deps, { task: "implement a", designToken: token, docs: [] })
  assert.ok(out1.includes("eng-codex-1"))
  const out2 = await runEngCoder(deps, { task: "implement b while in flight", designToken: token, docs: [] })
  assert.ok(out2.startsWith("Error"), "在飞时二次 eng_coder 被拒")
  assert.ok(out2.includes("eng-codex-1"), "拒绝文本含在飞 job id")
  assert.equal(specs.length, 1, "没有第二个 job 被派发")
  await specs[0].hooks.done
  dropSession(sid)
})

test("R2 D-10: advisor jobs 派发后代际变更（eng 交付重置同款 bump）→ finalize 丢弃状态变更 + 完成通知注明", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "adv-gen-r2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-codex-1"))
  // 模拟「派发后、finalize 前」的语义转换点（eng 交付重置同款 bumpAdvisorGeneration）
  bumpAdvisorGeneration(sessionState(sid))
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(outcome.output.includes("Issue"), "评审原文可读（不并入但可读）")
  assert.ok(outcome.output.includes("状态代际已变更"), "完成通知注明代际变更")
  assert.ok(outcome.output.includes("不并入"), "注明本轮结果不并入会话状态")
  const st = sessionState(sid)
  assert.equal(st.advisorRound, 0, "finalize 丢弃：轮次不推进（晚到完成不复活已被重置状态）")
  assert.equal(st.lastAdvisorOutput, null, "finalize 丢弃：prior 不写")
  dropSession(sid)
})

test("R2 D-10: eng 交付簿记 bump 代际（真实链路：advisor 在飞 → eng 交付 → advisor done 丢弃）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  // 第一个 exec 任务（advisor 评审）挂 400ms 才退出——保证 eng 交付先发生（在飞窗口真实化）
  let execCalls = 0
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    execCalls++
    return {
      events: [],
      exitCode: 0,
      outText: execCalls === 1
        ? "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |"
        : "delivered\n\nTouched files: none",
      exitDelay: execCalls === 1 ? 400 : 10,
    }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "gen-eng-chain-r2"
  // advisor 派发（在飞）
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const advConfig = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config: advConfig, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  const gen0 = advisorGenerationOf(sessionState(sid))
  // eng_coder codex 交付（同 jobs 设施，任务快退）→ deliverBookkeeping 内 bumpAdvisorGeneration
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath } })
  await runEngCoder(deps, { task: "implement x", designToken: token, docs: [] })
  const engOutcome = await specs[1].hooks.done
  assert.equal(engOutcome.status, "completed")
  assert.ok(advisorGenerationOf(sessionState(sid)) > gen0, "eng 交付重置 bump 代际（+1）")
  // 在飞 advisor 结果晚到（eng 交付之后 settle）→ finalize 丢弃 + 注明
  const advOutcome = await specs[0].hooks.done
  assert.equal(advOutcome.status, "completed")
  assert.ok(advOutcome.output.includes("状态代际已变更"), "晚到 advisor 结果被代际校验拦截")
  assert.ok(advOutcome.output.includes("Issue"), "晚到结果原文可读")
  assert.equal(sessionState(sid).advisorRound, 0, "eng 交付重置不被晚到 finalize 复活")
  dropSession(sid)
})

test("R2 D-10: generation 随 F12 视图持久化（写点拼入 + normalizeRestored 白名单 + 往返恢复）", () => {
  const home = mkdtempSync(join(tmpdir(), "gen-r2-"))
  try {
    // 写点拼入（sessionStateViewWithGeneration）：state 带 generation 3 → 落盘 → load 恢复
    const view = sessionStateViewWithGeneration({ advisorRound: 1, lastAdvisorOutput: "p", advisorGeneration: 3 })
    assert.equal(view.advisorGeneration, 3)
    assert.ok(saveSessionState("sid-gen", view, home))
    const snap = loadSessionState("sid-gen", home)
    assert.equal(snap.advisorGeneration, 3, "落盘/恢复往返")
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions["sid-gen"]
    assert.ok("advisorGeneration" in entry, "落盘条目含 generation 键")
    // 无 generation 的视图（viewOfSessionState 形态/旧调用方）不引入键（条件白名单——键集兼容）
    assert.ok(saveSessionState("sid-plain", { advisorRound: 0, touchedFiles: [] }, home))
    const entry2 = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions["sid-plain"]
    assert.ok(!("advisorGeneration" in entry2), "无 generation 的视图不引入键")
    // 非法值（负数/非整数/非数字）不保留（恢复侧按 0 兜底）
    assert.equal(normalizeRestored({ advisorRound: 0, advisorGeneration: -5 }).advisorGeneration, undefined)
    assert.equal(normalizeRestored({ advisorRound: 0, advisorGeneration: 2.5 }).advisorGeneration, undefined)
    assert.equal(advisorGenerationOf(normalizeRestored({ advisorRound: 0, advisorGeneration: "x" })), 0)
    assert.equal(advisorGenerationOf({}), 0, "未设 → 0")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("R2 D-10: F11 类型切换 bump 代际 + 落盘（typeSwitched 写点带 generation）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const home = mkdtempSync(join(tmpdir(), "gen-f11-r2-"))
  const sid = "gen-f11-r2"
  try {
    const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
    const state = sessionState(sid)
    state.lastReviewType = "code"
    state.advisorRound = 1
    state.lastAdvisorOutput = "code prior"
    state.advisorGeneration = 2
    // llm 无 stream → 评审失败（完成分支不落盘）→ 只剩类型切换写点（隔离验证，同 F12 T590 手法）
    await runAdvisorReview({ llm: {} }, {
      agent, config: {}, reviewType: "design", documents: ["docs/2026-09-05-defect-remediation-design.md"],
      storPathOverride: home,
    })
    assert.equal(advisorGenerationOf(sessionState(sid)), 3, "类型切换 bump 代际（2 → 3）")
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid]
    assert.equal(entry.advisorGeneration, 3, "typeSwitched 写点带 generation 落盘")
  } finally {
    dropSession(sid)
    rmSync(home, { recursive: true, force: true })
  }
})

// ————————————— R2 §4.5 Stage 4：进程卫生批（D-14/D-16/D-11/D-22/D-15） —————————————

test("R2 D-14: 全局并发准入——活跃数达 maxConcurrent → CONCURRENCY_LIMIT fail-fast（不排队），释放后恢复", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ stream: "stdout", delay: 0, data: "a" }, { stream: "stdout", delay: 60, data: "b" }], exitDelay: 60, exitCode: 0, outText: "slow task" }
  })
  const g = { ...GLOBALS, maxConcurrent: 1 }
  const p1 = runCodexTask(baseDeps(spawn), { taskText: "first", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 30000, runner: RUNNER, globals: g })
  const env2 = await runCodexTask(baseDeps(spawn), { taskText: "second", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 30000, runner: RUNNER, globals: g })
  assert.equal(env2.code, "CONCURRENCY_LIMIT", "超限 fail-fast（D-14）")
  assert.equal(env2.ok, false)
  assert.ok(env2.diagnostics.includes("maxConcurrent"), "明确报错并指向上限配置")
  assert.ok(env2.diagnostics.includes("fail-fast"), "不排队——简单诚实")
  const env1 = await p1
  assert.equal(env1.code, "OK", "在飞任务正常完成")
  const env3 = await runCodexTask(baseDeps(spawn), { taskText: "third", cwd: tmpdir(), sandbox: "read-only", timeoutMs: 30000, runner: RUNNER, globals: g })
  assert.equal(env3.code, "OK", "槽位释放后恢复正常准入")
})

test("R2 D-14: maxConcurrent 三面白名单（PUT 接受 ⊕ merge 保留 ⊕ 运行时默认 8 + 非法回落告警）", () => {
  // 面 1：PUT 校验（index.mjs validateGlobalUserConfig）
  const ok = validateGlobalUserConfig({ codexCli: { maxConcurrent: 4 } }, [])
  assert.equal(ok.ok, true)
  assert.equal(ok.sanitized.codexCli.maxConcurrent, 4)
  for (const bad of [0, 65, 2.5, "many"]) {
    const v = validateGlobalUserConfig({ codexCli: { maxConcurrent: bad } }, [])
    assert.equal(v.ok, false, "PUT 拒绝非法值 " + JSON.stringify(bad))
    assert.ok(v.errors.some((e) => e.includes("maxConcurrent")))
  }
  // 面 2：merge 白名单（config-store.mjs mergeGlobalConfig）
  const merged = mergeGlobalConfig({}, { codexCli: { maxConcurrent: 4 } })
  assert.equal(merged.codexCli.maxConcurrent, 4, "merge 保留（user 层覆盖）")
  // 面 3：运行时解析（resolveCodexCliGlobals：DP-3 终裁默认 8 + 非法回落 + 告警）
  assert.equal(resolveCodexCliGlobals({}).globals.maxConcurrent, 8, "默认 8（DP-3）")
  const bad = resolveCodexCliGlobals({ codexCli: { maxConcurrent: "many" } })
  assert.equal(bad.globals.maxConcurrent, 8, "非法回落默认")
  assert.ok(bad.warnings.some((w) => w.includes("maxConcurrent")), "非法值告警留档")
})

test("R2 D-16: 派发时 budgetCapMs ≥ 600000 → 句柄文本附不变式提醒 + console.warn；< 600000 无提醒", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath, budgetCapMs: 700000 } }
  const sid = "d16-r2"
  const deps = makeEscDeps(sid, spawn, cfg)
  deps.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const r = await captureWarn(() => runEscalate(deps, "x", undefined))
  assert.ok(r.value.includes("escalate-codex-1"))
  assert.ok(r.value.includes("不变式提醒"), "句柄文本附不变式提醒（D-16）")
  assert.ok(r.value.includes("budgetCapMs=700000"), "提醒携带实际 cap 值")
  assert.ok(r.value.includes("maxWallMs"), "提醒内容：确认平台 maxWallMs 同步提高且 cap < wall")
  assert.ok(r.warnings.some((w) => w.includes("不变式提醒") && w.includes("700000")), "console.warn 留档（输出一次）")
  await specs[0].hooks.done
  dropSession(sid)
  // 对照：默认 budgetCap 540000 < 600000 → 无提醒
  const { jobs: jobs2, specs: specs2 } = fakeJobsFactory()
  const sid2 = "d16-none-r2"
  const deps2 = makeEscDeps(sid2, spawn, { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } })
  deps2.ctx = { get: (svc) => (svc === "jobs" ? jobs2 : null) }
  const out2 = await runEscalate(deps2, "x", undefined)
  assert.ok(out2.includes("escalate-codex-1"))
  assert.ok(!out2.includes("不变式提醒"), "budgetCap < 600000 无提醒")
  await specs2[0].hooks.done
  dropSession(sid2)
})

test("R2 D-11: 启动清扫——陈旧 thincoder-codex-* 目录（>24h）删除 + warn，新鲜目录保留，无关目录不动", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sweep-r2-"))
  try {
    const stale = join(dir, "thincoder-codex-stale")
    const fresh = join(dir, "thincoder-codex-fresh")
    const other = join(dir, "unrelated-dir")
    for (const d of [stale, fresh, other]) mkdirSync(d)
    writeFileSync(join(stale, "last-message.txt"), "orphan output")
    // 陈旧判定：mtime 早于 24h 前（utimes 直改目录 mtime；不可改则由 now 偏移兜底）
    let mtimeSet = true
    try {
      const old = new Date(Date.now() - 25 * 3600 * 1000)
      const { utimesSync } = await import("node:fs")
      utimesSync(stale, old, old)
    } catch { mtimeSet = false }
    const r = await captureWarn(() => sweepStaleCodexTempDirs({ tmpDirPath: dir, now: mtimeSet ? Date.now() : Date.now() + 25 * 3600 * 1000 }))
    assert.deepEqual(r.value.removed, ["thincoder-codex-stale"], "陈旧目录删除")
    assert.equal(r.value.kept, 1, "新鲜目录（<24h）保留")
    assert.ok(!existsSync(stale), "陈旧目录已删除")
    assert.ok(existsSync(fresh), "新鲜目录保留")
    assert.ok(existsSync(other), "无关命名目录不受影响")
    assert.ok(r.warnings.some((w) => w.includes("启动清扫")), "清扫 warn 留档")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("R2 D-22: cleanCwdRoot 死旋钮删除——clean-cwd 一律一次性临时目录（globals.cleanCwdRoot 不再消费）", async () => {
  const inner = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 0, outText: "ok" })
  let seenCwd = null
  const spawn = (file, args, opts) => {
    if (!args.includes("--version")) seenCwd = opts?.cwd
    return inner(file, args)
  }
  const fakeRoot = mkdtempSync(join(tmpdir(), "cc-root-"))
  try {
    const env = await runCodexTask(baseDeps(spawn), {
      taskText: "hi", cwd: join(tmpdir(), "original-cwd"), sandbox: "read-only", runner: RUNNER,
      globals: { ...GLOBALS, agentsMdPolicy: "clean-cwd", cleanCwdRoot: fakeRoot },
    })
    assert.equal(env.code, "OK")
    assert.notEqual(seenCwd, fakeRoot, "死旋钮不再消费（cleanCwdRoot 被忽略，D-22）")
    assert.ok(String(seenCwd).includes("thincoder-codex-"), "clean-cwd 一律一次性临时目录: " + seenCwd)
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true })
  }
})

test("R2 D-22: consult 子代理 run 补 dispose（回复 settle 后释放，不泄漏到进程生命周期）", async () => {
  const disposed = []
  const j = consultJobs()
  const ctx = {
    llm: ladderLlm(["low"]),
    get: (svc) => (svc === "jobs" ? j.jobs : null),
    subagents: {
      async start() {
        return {
          result: Promise.resolve({ output: [{ type: "text", text: "second opinion" }], stopReason: "completed" }),
          dispose: async () => { disposed.push(1) },
        }
      },
    },
  }
  const sid = "consult-dispose-r2"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const r = await startConsultSession(
    { ctx, agent, config: { consultModels: [{ provider: "acme", model: "model-a", effort: "low" }] }, state, dshHome: mkdtempSync(join(tmpdir(), "b15-home-")) },
    "problem brief", undefined,
  )
  const digest = await consultDigestOf(state, r.id)
  assert.ok(digest.includes("second opinion"))
  await sleep(30) // finally 内 dispose 异步执行（settle 唤醒后的收尾）
  assert.equal(disposed.length, 1, "子代理 run 被 dispose（D-22）")
  dropSession(sid)
})

test("R2 D-22: codexFailureCount 会话销毁清理（session/disposed 清理组接线，防跨会话滞留误回落）", async () => {
  const { apply, runAdvisorReview } = { ...(await import("../lib/index.mjs")), ...(await import("../lib/advisor.mjs")) }
  const home = mkdtempSync(join(tmpdir(), "d22-home-"))
  const savedDshHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    // 最小 fake ctx（apply 装配 → session/disposed 处理器注册）
    const handlers = new Map()
    const fakeCtx = {
      on: (ev, fn) => { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); return () => { } },
      emit: (ev, payload) => { for (const fn of handlers.get(ev) ?? []) fn(payload) },
      effect: (fn) => { const d = fn?.(); return () => d?.() },
      systemPrompt: { section: () => () => { } },
      tools: { register: () => () => { } },
      get: () => null,
    }
    apply(fakeCtx, {})
    const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
    const llm = { stream: () => (async function* () { yield { type: "block-end", block: { type: "text", text: "DSH REVIEW" } }; yield { type: "finish", reason: { kind: "stop" } } })() }
    const sid = "d22-fc-r2"
    const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
    const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "p", model: "m" } } }
    const run = () => runAdvisorReview({ llm, spawn, platform: "linux", env: {} }, { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
    await run() // codex 失败 ×1 → codexFailureCount=1
    await run() // codex 失败 ×2 → codexFailureCount=2（回落阈值）
    // 会话销毁 → D-22 清理 codexFailureCount
    fakeCtx.emit("session/disposed", { id: sid })
    // 第 3 次调用：计数已清 → 重试 codex（失败）而非自动回落 dsh
    const r3 = await run()
    assert.ok(r3.includes("codex-cli PROCESS_ERROR"), "计数已随会话销毁清理 → 第 3 次重试 codex")
    assert.ok(!r3.includes("自动回落 dsh 路由"), "无回落（D-22 生效；未清理时此处会回落 dsh）")
    dropSession(sid)
  } finally {
    process.env.DSH_HOME = savedDshHome
    rmSync(home, { recursive: true, force: true })
  }
})

test("R2 D-15 铺底: adapter 退出记录最大静默间隙（maxSilentGapMs 留档——真机 idle 档位测量数据源）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    // 两段活动间隔 ~120ms → 最大静默间隙 ≈ 120ms（含尾段）
    return { events: [{ stream: "stdout", delay: 0, data: "a" }, { stream: "stdout", delay: 120, data: "b" }], exitDelay: 10, exitCode: 0, outText: "ok" }
  })
  const r = await captureWarn(() => runCodexTask(baseDeps(spawn), { taskText: "hi", cwd: tmpdir(), sandbox: "read-only", runner: RUNNER, globals: GLOBALS }))
  assert.equal(r.value.code, "OK")
  const line = r.warnings.find((w) => w.includes("maxSilentGapMs"))
  assert.ok(line, "退出记录最大静默间隙: " + r.warnings.join(" | ").slice(-200))
  const gap = Number((line.match(/maxSilentGapMs=(\d+)/) ?? [])[1])
  assert.ok(gap >= 100, "间隙测量合理（活动间隔 ~120ms）: " + gap + "ms")
})

// ————————————— R2 Stage 5：DP-1 方案 A（dsh 路径内部截止）+ R1 折入 + D-02 遗留 —————————————

/** DP-1 用假 run：result 挂起直到 signal abort 才 settle（模拟被截止终止的子代理）。 */
function hangingRunSpy(startedRequests) {
  return {
    async start(_kind, req) {
      startedRequests.push(req)
      return {
        result: new Promise((resolve) => {
          req.signal.addEventListener("abort", () => resolve({
            stopReason: "aborted",
            output: [{ type: "text", text: "halfway work" }],
            diagnostic: "deadline abort",
          }))
        }),
        dispose: async () => { },
      }
    },
  }
}

test("R2 DP-1 方案 A: escalate dsh 子代理路径内部截止——run.result 挂起 → budgetCap 到点 abort + 响亮告警", async () => {
  const started = []
  const ctx = {
    llm: ladderLlm(["low"]),
    subagents: hangingRunSpy(started),
  }
  const cfg = { consultModels: [{ provider: "acme", model: "model-a" }], codexCli: { budgetCapMs: 250 } }
  const sid = "dp1-esc-r2"
  const deps = {
    ctx, agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: cfg, state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn for a dsh row") }, platform: "linux", env: {},
  }
  const t0 = Date.now()
  const r = await captureWarn(() => runEscalate(deps, "long dsh task", undefined))
  const elapsed = Date.now() - t0
  assert.ok(elapsed < 5000, "内部截止生效（未钳制则 await run.result 永久挂起）: " + elapsed + "ms")
  assert.ok(started.length === 1, "dsh 子代理已启动")
  assert.ok(r.value.includes("dsh 子代理路径受平台墙钟约束"), "响亮告警（设计 §4.2 文案）")
  assert.ok(r.value.includes("budgetCapMs=250"), "截止值可见")
  assert.ok(r.value.includes("codex runner 或拆分 stages"), "长任务替代指引（codex runner / 拆分 stages）")
  assert.ok(r.value.includes("halfway work"), "partial 输出可见")
  assert.ok(r.warnings.some((w) => w.includes("内部截止") && w.includes("abort 子代理")), "console.warn 留档")
  dropSession(sid)
})

test("R2 DP-1 方案 A: eng_coder dsh 子代理路径内部截止——run.result 挂起 → budgetCap 到点 abort（失败交付不簿记）", async () => {
  const started = []
  const sid = "dp1-eng-r2"
  const st = sessionState(sid)
  st.engineering = true
  st.advisorRound = 2
  st.lastAdvisorOutput = "prior review"
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "model-a" } }
  const out = await runEngCoder(
    {
      ctx: { subagents: hangingRunSpy(started), llm: ladderLlm(["low"]) },
      agent, config: { codexCli: { budgetCapMs: 250 } }, signal: undefined, configDefaultEngineering: false,
      spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {},
    },
    { task: "long dsh implementation", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder ended: dsh 子代理路径超内部截止"), "截止终止文案")
  assert.ok(out.includes("dsh 子代理路径受平台墙钟约束"), "响亮告警（设计 §4.2 文案）")
  assert.ok(out.includes("codex runner 或拆分 stages"), "长任务替代指引")
  assert.ok(out.includes("halfway work"), "partial 输出可见")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 2, "D-20：截止 abort = 失败交付——不重置轮次")
  assert.equal(st2.mutatedThisRun ?? false, false, "不置 mutated")
  dropSession(sid)
})

test("R2 R1折入: escalate effort-note 前缀统一 \\n\\n[thincoder-suite]（与其余消费点对齐）", async () => {
  const started = []
  const ctx = {
    llm: ladderLlm(["low", "high"]),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "done\n\nTouched files: none" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "prefix-esc-r2"
  const deps = {
    ctx,
    agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "acme", model: "model-a", effort: "medium" }] },
    state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {},
  }
  const out = await runEscalate(deps, "fix it", undefined)
  assert.ok(out.includes("falling back to nearest supported effort"), "回落 note 存在")
  assert.ok(out.includes("\n\n[thincoder-suite] effort"), "前缀统一为空行 + [thincoder-suite] 标记（dsh 行）")
  // codex 行同款前缀
  const cat = catalogSpawn([{ slug: "m-pre", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" })
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "m-pre", effort: "medium", executable: "t-pre-1" } }], codexCli: { executable: "t-pre-1" } }
  const sid2 = "prefix-esc-codex-r2"
  const out2 = await runEscalate(makeEscDeps(sid2, cat.spawn, cfg), "x", undefined)
  assert.ok(out2.includes("\n\n[thincoder-suite] effort"), "前缀统一（codex 行）")
  dropSession(sid)
  dropSession(sid2)
})

test("R2 R1折入: advisor codex 行 resolveCodexCliGlobals warnings 并入 route.warnings（非法 codexCi 值运行时响亮告警）", () => {
  const cfg = {
    advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" } } },
    codexCli: { proxyMode: "sideway", defaultTimeoutMs: 1, model: "  " },
  }
  const r = resolveAdvisorRoute({ config: cfg, override: null, agentOpts: {}, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "codex-cli")
  assert.ok(r.warnings.some((w) => w.includes("codexCli.proxyMode 忽略")), "proxyMode 非法值告警上浮")
  assert.ok(r.warnings.some((w) => w.includes("codexCli.defaultTimeoutMs 忽略")), "defaultTimeoutMs 非法值告警上浮")
  assert.ok(r.warnings.some((w) => w.includes("codexCli.model 忽略")), "model 非法值告警上浮")
  // dsh 路由（非 codex 分支）不引入 codexCli 告警
  const r2 = resolveAdvisorRoute({
    config: { advisor: { round1: { provider: "p", model: "m" } }, codexCli: { proxyMode: "sideway" } },
    override: null, agentOpts: {}, advisorRound: 0,
  })
  assert.ok(!r2.warnings.some((w) => w.includes("codexCli.")), "dsh 行不引入 codexCli 告警（分支限定）")
})

test("R2 D-02 遗留: consult codex 行 row.effort 接通（row.effort → resolveCodexRowEffort → runner.effort，镜像 advisor）", async () => {
  const cat = catalogSpawn([{ slug: "m-cc2", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "codex opinion via row effort" })
  const sid = "r2-consult-roweff"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const j = consultJobs()
  const deps = {
    ctx: { get: (svc) => (svc === "jobs" ? j.jobs : null) },
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc2", executable: "t-cc2-1" }, effort: "medium" }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
    dshHome: mkdtempSync(join(tmpdir(), "b15-home-")),
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  const digest = await consultDigestOf(state, r.id)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "row.effort=medium 经目录校验回落 high（此前 row.effort 是死配置）")
  assert.ok(digest.includes("codex opinion via row effort"))
  assert.ok(digest.includes("falling back to nearest supported effort"), "回落 note 入回复")
  dropSession(sid)
})

test("R2 D-02 遗留: consult codex 行 runner.effort 优先于 row.effort（优先级链不变）", async () => {
  const cat = catalogSpawn([{ slug: "m-cc3", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "ok" })
  const sid = "r2-consult-roweff2"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const j = consultJobs()
  const deps = {
    ctx: { get: (svc) => (svc === "jobs" ? j.jobs : null) },
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc3", effort: "low", executable: "t-cc3-1" }, effort: "medium" }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
    dshHome: mkdtempSync(join(tmpdir(), "b15-home-")),
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  await consultDigestOf(state, r.id)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="low"'), "runner.effort=low 优先（row.effort=medium 不覆盖）")
  dropSession(sid)
})

// ————————————— R2 §4.7-8（US-3）：job_output 保尾截断下 design token 存活性回归 —————————————
// 钉死平台 retainTail 契约（登记表 D-08 已驳回「尾部截断丢 token」假设——token 位于返回
// 文本尾部反而安全）：模拟 job_output 保尾截断（头部丢弃 + [output truncated] 标记）→
// 尾部 design token 完整可提取（eng_coder 签收链不断）。

test("R2 §4.7-8 US-3: job_output 保尾截断（头部丢弃 + [output truncated] 标记）→ 尾部 design token 完整可提取", async () => {
  const { runAdvisorReview, validateDesignToken } = await import("../lib/advisor.mjs")
  // 假 codex 进程：从 stdin 任务书提取 [APPROVE:<code>]，回长评审 + 批准码回显（触发签发）
  const spawn = (file, args) => {
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    const stdinText = []
    child.stdin = { write(d) { stdinText.push(String(d)) }, end() { } }
    child.kill = () => { child.killed = true }
    ;(async () => {
      await sleep(5)
      if (args.includes("--version")) {
        child.stdout.emit("data", Buffer.from("codex-cli 0.150.1\n"))
        await sleep(5)
        child.emit("exit", 0)
        return
      }
      await sleep(20) // 等 runCodexTask 同步写完 stdin
      const prompt = stdinText.join("")
      const m = prompt.match(/\[APPROVE:([0-9a-f]{8})\]/)
      const code = m ? m[1] : "00000000"
      const bigReview = "| # | Issue | Detail |\n|---|---|---|\n"
        + Array.from({ length: 40 }, (_, i) => "| " + i + " | issue " + i + " | " + "x".repeat(60) + " |").join("\n")
      const text = bigReview + "\n\nThe design is approved with no unresolved Critical issues.\n\n[APPROVE:" + code + "]"
      const i = args.indexOf("-o")
      if (i >= 0) { try { writeFileSync(args[i + 1], text) } catch { /* 忽略 */ } }
      child.emit("exit", 0)
    })()
    return child
  }
  const { jobs, specs } = fakeJobsFactory()
  const sid = "us3-token-r2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "design", documents: ["docs/2026-09-05-defect-remediation-design.md"], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-codex-1"), "design 评审经 jobs 派发")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  const output = outcome.output
  assert.ok(output.includes("Approved. Pass this exact token to eng_coder"), "签发行在 job output 尾部")
  // —— 模拟平台 job_output 保尾截断（retainTail）：头部丢弃 + [output truncated] 标记 ——
  const LIMIT = 600
  const truncated = "[output truncated]\n" + output.slice(-LIMIT)
  assert.ok(truncated.length < output.length, "截断真实发生（保尾丢弃头部）")
  assert.ok(!truncated.includes("| 0 | issue 0"), "头部评审内容被丢弃")
  assert.ok(!truncated.includes(bigReviewHead(output)), "表头被丢弃（截断幅度足够）")
  // —— 尾部 design token 完整可提取 + 可通过校验（eng_coder 签收链不断） ——
  const tm = truncated.match(/Approved\. Pass this exact token to eng_coder \(designToken parameter\): ([0-9a-f-]+:\d+)/)
  assert.ok(tm, "token 行完整保留在截断后尾部（retainTail 契约）")
  assert.equal(typeof tm[1], "string")
  assert.equal(validateDesignToken(tm[1]), true, "提取的 token 通过形状/过期校验（eng_coder 可签收）")
  dropSession(sid)
})

/** 从 output 取表头行（截断断言辅助：表头在头部，保尾截断后必失）。 */
function bigReviewHead(output) {
  const first = output.split("\n")[0]
  return first
}

// ————————————— R3 §5.1（D-07 / D-裁决-3）：回落封顶与硬停 —————————————
// 计数器语义（设计 §5.1 精确版）：codexFailureCount——codex 失败 +1、任一路由成功清零、
// delete 移到回落轮结果之后（失败不清零）；fallbackFailureCount——回落失败 +1、任一路由
// 成功清零；连续 2 次回落失败硬停（双路由诊断 + 修正指引）；硬停 armed 后同会话后续
// advisor 调用持续返回硬停指引（不静默重试）——配置变更（路由指纹失配）或会话重置解除。

/** R3 D-07 测试共用：codex 必败 spawn（PROCESS_ERROR；execCalls 只数真实 exec 不数 --version probe）。 */
function r3FailingCodexSpawn() {
  let execCalls = 0
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    execCalls++
    return { events: [], exitCode: 1 } // 非零退出无输出 → PROCESS_ERROR
  })
  return { spawn, execCalls: () => execCalls }
}

/** R3 D-07 测试共用：dsh 回落轮 agent 构造。 */
function r3Agent(sid) {
  return { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
}

test("R3 D-07 活锁封顶: codex 败×2 → 回落败×2 → 硬停（双路由诊断 + 修正指引，不再交替重试）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const llmCalls = { n: 0 }
  const llm = { // 回落必败：stream 抛错 → "Advisor: review failed (unknown)"（确定性失败形态）
    stream() { llmCalls.n++; return (async function* () { throw new Error("fb route down") })() },
  }
  const sid = "r3-d07-livelock"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = (cfg) => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config: cfg ?? config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )

  const r1 = await run()
  assert.ok(r1.includes("Advisor: review failed (codex-cli PROCESS_ERROR"), "codex 失败 #1")
  assert.equal(llmCalls.n, 0, "codex 路径不触碰 llm")
  const r2 = await run()
  assert.ok(r2.includes("下一轮 advisor start 将自动回落"), "codex 失败 #2 → 回落预告（fallbackNote）")
  assert.equal(execCalls(), 2, "codex 恰好跑两次")

  const r3 = await run() // 回落失败 #1
  assert.ok(r3.includes("自动回落 dsh 路由"), "第 3 轮触发智能回落")
  assert.ok(r3.includes("review failed (unknown) — fb route down"), "回落轮失败可归因")
  assert.equal(execCalls(), 2, "delete-after-result：回落失败不清零 codex 计数——codex 不被重试（顺序修正）")
  assert.ok(r3.includes("回落失败 1/2"), "R4 R3收尾①：回落失败路径带「回落失败 X/2」计数后缀（与不可达路径对齐）")
  assert.ok(!r3.includes("回落硬停"), "回落失败 1/2——未硬停")

  const r4 = await run() // 回落失败 #2 → 硬停
  assert.ok(r4.startsWith("Advisor: 回落硬停"), "连续 2 次回落失败 → 硬停文本（不经 finalize——无 warnPrefix）")
  assert.ok(r4.includes("双路由皆不可用"), "硬停声明：双路由皆不可用")
  assert.ok(r4.includes("不再交替重试"), "D-裁决-3：终止自愈循环")
  assert.ok(r4.includes("codex 路由: runner=codex-cli model=codex-model-a"), "codex 路由诊断（配置状态）")
  assert.ok(r4.includes("最近失败码: PROCESS_ERROR"), "codex 最近失败码")
  assert.ok(r4.includes("dsh 回落路由: acme:model-a"), "dsh 回落路由诊断（配置状态）")
  assert.ok(r4.includes("fb route down"), "dsh 回落最近失败原因可见")
  assert.ok(r4.includes("网络/代理"), "修正指引：网络/代理")
  assert.ok(r4.includes("runner 切换"), "修正指引：runner 切换")
  assert.ok(r4.includes("provider 检查"), "修正指引：provider 检查")
  assert.ok(r4.includes("硬停解除"), "解除方式指引（配置变更 / 会话重置）")
  assert.equal(execCalls(), 2, "硬停前 codex 未再重试（codex↔dsh 无界交替就此终止）")
  assert.equal(llmCalls.n, 2, "两轮回落各调一次 llm（失败确定性）")
  dropSession(sid)
})

test("R3 D-07 硬停持续: armed 后同会话后续调用持续返回硬停指引（零 LLM/零 codex 活动）——配置变更 → 自动解除", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const llmCalls = { n: 0 }
  const llm = { stream() { llmCalls.n++; return (async function* () { throw new Error("fb route down") })() } }
  const sid = "r3-d07-held"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = (cfg) => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config: cfg ?? config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  for (let i = 0; i < 4; i++) await run() // codex×2 → 回落×2 → 硬停 armed
  const llmBefore = llmCalls.n
  const execBefore = execCalls()

  const r5 = await run() // held：不重试
  assert.ok(r5.startsWith("Advisor: 回落硬停"), "held：继续返回硬停指引（而非静默重试）")
  assert.equal(llmCalls.n, llmBefore, "零 LLM 调用")
  assert.equal(execCalls(), execBefore, "零 codex 调用")
  assert.equal(sessionState(sid).advisorRound, 0, "held 不烧轮次")

  // 配置变更（round1.provider 变化 → 路由指纹失配）→ 硬停自动解除 → 常规执行恢复
  const cfg2 = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme-fixed", model: "model-a", timeoutMs: 300000 } } }
  const r6 = await run(cfg2)
  assert.ok(!r6.includes("回落硬停"), "配置变更 → 硬停解除")
  assert.ok(r6.includes("codex-cli PROCESS_ERROR"), "恢复常规执行（codex 重试——计数已随解除清零）")
  assert.equal(execCalls(), execBefore + 1, "恢复后 codex 实际被调用一次")
  dropSession(sid)
})

test("R3 D-07 硬停解除（会话重置）: clearCodexFailureCount 清双计数器/最近失败码/硬停状态（D-22 清理组扩展）", async () => {
  const { runAdvisorReview, clearCodexFailureCount } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const llm = { stream() { return (async function* () { throw new Error("fb route down") })() } }
  const sid = "r3-d07-reset"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  for (let i = 0; i < 4; i++) await run() // 硬停 armed
  const held = await run()
  assert.ok(held.startsWith("Advisor: 回落硬停"), "armed 后 held 生效")
  clearCodexFailureCount(sid) // 模拟 session/disposed 清理组（index.mjs 既有挂点）
  const r = await run()
  assert.ok(!r.includes("回落硬停"), "会话销毁清理 → 硬停解除")
  assert.ok(r.includes("codex-cli PROCESS_ERROR"), "恢复常规执行（codex 重试）")
  assert.equal(execCalls(), 3, "解除后 codex 被调用（2 次硬停前 + 1 次解除后）")
  dropSession(sid)
})

test("R3 D-07 delete-after-result 顺序（正向）: 回落成功 → 结果产出后计数清零 → 下一轮重试 codex（单次失败不回落）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const llmCalls = { n: 0 }
  const llm = { // 回落成功（确定性：一次 stream 调用产出正文）
    stream() {
      llmCalls.n++
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "FB REVIEW OK — fallback delivered" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const sid = "r3-d07-reset-pos"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 #1
  await run() // codex 失败 #2
  const r3 = await run() // 回落成功 → 计数在结果产出后清零（finalize completed 分支）
  assert.ok(r3.includes("自动回落 dsh 路由") && r3.includes("FB REVIEW OK"), "回落轮成功交付")
  assert.equal(execCalls(), 2, "回落轮不跑 codex")
  const r4 = await run() // 计数已清 → codex 重试（失败 #1——不再回落）
  assert.ok(r4.includes("codex-cli PROCESS_ERROR"), "回落成功后计数清零 → codex 重试")
  assert.ok(!r4.includes("自动回落 dsh 路由"), "清零后单次 codex 失败不触发回落")
  assert.equal(llmCalls.n, 1, "回落成功只调一次 llm（delete 在结果产出后执行——旧顺序也无重试歧义）")
  dropSession(sid)
})

test("R3 D-07 回落路由不可达组合: codex 败×2 + 回落不可达×2 → 硬停（任何零进度组合同经硬停终止）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const sid = "r3-d07-noroute"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" } } } } // 无 dsh 回落路由
  const run = () => runAdvisorReview(
    { llm: { stream: () => { throw new Error("llm must not be called") } }, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run()
  await run()
  const r3 = await run() // 回落不可达 #1
  assert.ok(r3.includes("回落 dsh 路由不可用"), "回落路由不可达 = 回落失败（组内未配 provider/model）")
  assert.ok(r3.includes("回落失败 1/2"), "回落失败计数可见（响亮预告）")
  assert.ok(!r3.includes("回落硬停"), "1/2 未硬停")
  const r4 = await run() // 回落不可达 #2 → 硬停
  assert.ok(r4.startsWith("Advisor: 回落硬停"), "回落不可达 #2 → 硬停")
  assert.ok(r4.includes("dsh 回落路由: 不可用"), "诊断：dsh 回落路由不可用")
  assert.ok(r4.includes("codex 路由: runner=codex-cli"), "诊断：codex 路由")
  assert.equal(execCalls(), 2, "不可达组合同样不再交替重试 codex")
  dropSession(sid)
})

// ————————————— R3 §5.2（D-01 / D-裁决-1）：空响应重试与分类 —————————————
// 非基础设施形态空响应（finish-null / stop 零块 / length / 非预期形态）自动重试一次
//（复用 messages、独立计数）；再空 → "Advisor:" 前缀可归因失败（不烧轮次/不写 prior）；
// 基础设施形态（error 无 message / stall）走既有失败路径，不空重试。

test("R3 D-01 重试语义: 空响应自动重试一次 → 仍空 → \"Advisor:\" 前缀失败（不烧轮次/不写 prior/旧 prior 保留）", async () => {
  const sid = "r3-d01-retry-fail"
  const st = sessionState(sid)
  st.advisorRound = 2 // 有 prior 的收敛轮（路由走 convergence 组）
  st.lastAdvisorOutput = "prior review body"
  let llmCalls = 0
  const llm = { // 每次调用都 stop 零文本块（非基础设施空形态）
    stream() {
      llmCalls++
      return (async function* () { yield { type: "finish", reason: { kind: "stop" } } })()
    },
  }
  const out = await runDshReview(sid, llm, {
    advisor: {
      round1: { provider: "p", model: "m", timeoutMs: 300000 },
      convergence: { provider: "p", model: "m", timeoutMs: 300000 },
    },
  })
  assert.equal(llmCalls, 2, "自动重试恰好一次（首次空 + 重试空）")
  assert.ok(out.startsWith("Advisor: review failed (empty response"), "前缀失败语义（finalize 判定不 completed）")
  assert.ok(out.includes("重试一次仍空"), "「重试一次仍空」标记")
  assert.ok(out.includes("empty-response classification: stop-zero-text-blocks"), "分类行保留（R1 观测不回退）")
  assert.ok(out.includes("stream observation: finish=stop"), "观测字段保留")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 2, "不烧轮次（advisorRound 不变）")
  assert.equal(st2.lastAdvisorOutput, "prior review body", "不写 prior（旧 prior 原样保留——空响应不进 lastAdvisorOutput）")
  dropSession(sid)
})

test("R3 D-01 重试语义: 首次空响应 → 重试成功交付（轮次恰好推进一次，不重复计轮）", async () => {
  const sid = "r3-d01-retry-ok"
  let llmCalls = 0
  const llm = {
    stream() {
      llmCalls++
      const first = llmCalls === 1
      return (async function* () {
        if (first) { yield { type: "finish", reason: { kind: "stop" } }; return } // 首次：stop 零文本块
        yield { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.equal(llmCalls, 2, "空响应重试一次后成功")
  assert.ok(out.includes("| 1 | a | b |"), "重试轮的评审正文交付")
  assert.ok(!out.includes("重试一次仍空"), "成功交付无失败标记")
  assert.ok(!out.startsWith("Advisor:"), "成功交付不带失败前缀")
  const st = sessionState(sid)
  assert.equal(st.advisorRound, 1, "完成恰好推进一轮（重试不重复计轮）")
  assert.ok(st.lastAdvisorOutput.includes("| 1 | a | b |"), "重试轮正文进 prior（收敛轮注入源）")
  dropSession(sid)
})

test("R3 D-01 分类护栏: 基础设施形态（error 无 message）不走空重试——既有失败路径直返", async () => {
  const sid = "r3-d01-infra"
  let llmCalls = 0
  const llm = {
    stream() {
      llmCalls++
      return (async function* () { yield { type: "finish", reason: { kind: "error", failure: {} } } })()
    },
  }
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.equal(llmCalls, 1, "基础设施形态不空重试（设计 §5.2：error 无 message / stall 走既有失败路径）")
  assert.ok(out.startsWith("Advisor: review failed — unknown provider error"), "既有失败路径语义不变")
  dropSession(sid)
})

test("R3 D-01×D-07 交互: 回落轮空响应（重试后仍空）= 回落失败——计入回落连败至硬停（非静默）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  let llmCalls = 0
  const llm = { // 每次都 stop 零文本块（回落轮空响应形态）
    stream() {
      llmCalls++
      return (async function* () { yield { type: "finish", reason: { kind: "stop" } } })()
    },
  }
  const sid = "r3-d01x07"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 #1
  await run() // codex 失败 #2
  const r3 = await run() // 回落轮：空 → 重试 → 仍空 → 前缀失败 → 回落失败 #1
  assert.equal(llmCalls, 2, "回落轮空响应重试一次（两次 stream 调用）")
  assert.ok(r3.includes("review failed (empty response — 重试一次仍空)"), "空响应失败文本可见")
  assert.ok(r3.includes("自动回落 dsh 路由"), "回落告警可见")
  assert.equal(execCalls(), 2, "回落失败不清零 codex 计数（delete-after-result）")
  const r4 = await run() // 回落失败 #2 → 硬停
  assert.ok(r4.startsWith("Advisor: 回落硬停"), "空响应形态的回落连败同经硬停终止")
  dropSession(sid)
})

// ————————————— R3 §5.3（D-19）：prior 纯净化 —————————————
// finalize 区分 body（评审正文）与机制性后缀（回落告警/effort note/截断提示）：
// lastAdvisorOutput 只存 body（收敛轮 prior 注入不再携带插件杂讯）；返回文本照常带后缀。

test("R3 D-19 prior 纯净化: 回落成功轮 lastAdvisorOutput 只存评审正文（回落告警/effort note 后缀不进 prior）；返回文本仍含后缀", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
  const llm = { // 回落模型 efforts [off,high]：effort medium → 最近档 high + note（后缀可断言）
    ...ladderLlm(["off", "high"]),
    stream() {
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const sid = "r3-d19-prior"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", effort: "medium" } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: { CODEX_HOME: emptyHome } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 #1
  await run() // codex 失败 #2
  const r3 = await run() // 回落成功（effort 回落 note + 回落告警均为机制后缀）
  // 返回文本照常带后缀（可见性不变）
  assert.ok(r3.includes("自动回落 dsh 路由"), "返回文本仍含回落告警后缀")
  assert.ok(r3.includes("falling back to nearest supported effort"), "返回文本仍含 effort note 后缀")
  assert.ok(r3.includes("| 1 | a | b |"), "评审正文交付")
  // prior 纯净：lastAdvisorOutput 只存正文
  const prior = sessionState(sid).lastAdvisorOutput
  assert.ok(prior, "回落成功轮正文进 prior（looksLikeReview 命中）")
  assert.ok(prior.includes("| 1 | a | b |"), "prior 含评审正文")
  assert.ok(!prior.includes("[thincoder-suite]"), "prior 不含任何机制性后缀（D-19）")
  assert.ok(!prior.includes("自动回落"), "prior 不含回落告警")
  assert.ok(!prior.includes("falling back"), "prior 不含 effort note")
  dropSession(sid)
})

test("R3 D-19 prior 纯净化（dsh 主路径）: effort note 后缀不进 lastAdvisorOutput；返回文本仍含 note", async () => {
  const sid = "r3-d19-dsh"
  const llm = {
    ...ladderLlm(["off", "high"]),
    stream() {
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "| # | I | D |\n|---|---|---|\n| 1 | a | b |" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "acme", model: "model-a", effort: "medium", timeoutMs: 300000 } } })
  assert.ok(out.includes("falling back to nearest supported effort"), "返回文本仍含 effort note 后缀")
  assert.ok(out.includes("| 1 | a | b |"), "正文交付")
  const prior = sessionState(sid).lastAdvisorOutput
  assert.ok(prior && prior.includes("| 1 | a | b |"), "正文进 prior")
  assert.ok(!prior.includes("[thincoder-suite]"), "prior 不含机制后缀（D-19）")
  dropSession(sid)
})

test("R3 D-19 prior 纯净化（codex 同步路径）: effort note 后缀不进 lastAdvisorOutput", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const cat = catalogSpawn([{ slug: "m-d19", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "r3-d19-codex"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "m-d19", effort: "medium" }, timeoutMs: 300000 } }, codexCli: { executable: "t-d19-1" } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn: cat.spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("falling back to nearest supported effort"), "返回文本仍含 effort note 后缀")
  assert.ok(out.includes("| 1 | x | y |"), "正文交付")
  const prior = sessionState(sid).lastAdvisorOutput
  assert.ok(prior && prior.includes("| 1 | x | y |"), "正文进 prior")
  assert.ok(!prior.includes("[thincoder-suite]"), "prior 不含 effort note（D-19）")
  dropSession(sid)
})

test("R3 D-19 prior 纯净化（codex 同步降级路径）: 截断告警/effort note 后缀不进 lastAdvisorOutput", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const cat = catalogSpawn([{ slug: "m-d19b", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "r3-d19-degraded"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "m-d19b", effort: "medium" }, timeoutMs: 900000 } }, codexCli: { executable: "t-d19-2" } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn: cat.spawn, platform: "linux", env: {} }, // 无 ctx.jobs → 同步降级
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("budgetCapMs=540000ms"), "返回文本仍含截断告警后缀（可见性不变）")
  assert.ok(out.includes("falling back to nearest supported effort"), "返回文本仍含 effort note 后缀")
  const prior = sessionState(sid).lastAdvisorOutput
  assert.ok(prior && prior.includes("| 1 | x | y |"), "正文进 prior")
  assert.ok(!prior.includes("[thincoder-suite]"), "prior 不含截断告警/effort note（D-19）")
  dropSession(sid)
})

test("R3 D-19 looksLikeReview 阈值修正: 短正文 + 长机制后缀 → prior 不再被后缀推过 200 字符阈值", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const emptyHome = mkdtempSync(join(tmpdir(), "codex-empty-"))
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 1 })
  const llm = {
    stream() {
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "FB SHORT" } } // 8 字符短正文（无表格）
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const sid = "r3-d19-threshold"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a" } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: { CODEX_HOME: emptyHome } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 #1
  await run() // codex 失败 #2
  const r3 = await run() // 回落成功：短正文 + 长回落告警后缀
  assert.ok(r3.includes("自动回落 dsh 路由"), "返回文本带回落告警后缀")
  assert.equal(sessionState(sid).lastAdvisorOutput, null, "短正文不进 prior（后缀不参与 looksLikeReview 判定——D-19 前长告警会把 8 字符正文推过 200 阈值）")
  dropSession(sid)
})

// ————————————— R3 §5.4（D-06 同步路径单飞扩展）+ §5.1 验收⑥ 正向清零 —————————————

test("R3 D-07 正向清零（验收⑥）: 回落成功后双计数器归零——单次未来回落失败不触发硬停", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { spawn, execCalls } = r3FailingCodexSpawn()
  let fbCall = 0
  const llm = { // 回落轮调用序：#1 成功交付（触发正向清零），其后失败
    stream() {
      fbCall++
      if (fbCall === 1) {
        return (async function* () {
          yield { type: "block-end", block: { type: "text", text: "FB REVIEW OK — fallback delivered" } }
          yield { type: "finish", reason: { kind: "stop" } }
        })()
      }
      return (async function* () { throw new Error("fb route down") })()
    },
  }
  const sid = "r3-d07-reset-six"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  await run() // codex 失败 #1
  await run() // codex 失败 #2
  await run() // 回落成功 → codexFailureCount/fallbackFailureCount 双清零（正向清零）
  await run() // codex 失败 #1（重新计数）
  await run() // codex 失败 #2
  const r6 = await run() // 回落失败 #1——若未清零此处已是 #2（硬停）；清零后应为 1/2
  assert.ok(r6.includes("自动回落 dsh 路由"), "回落轮触发")
  assert.ok(r6.includes("review failed (unknown) — fb route down"), "回落失败可归因")
  assert.ok(!r6.includes("回落硬停"), "单次未来回落失败不触发硬停（计数器已随回落成功归零）")
  const r7 = await run() // 回落失败 #2 → 硬停
  assert.ok(r7.startsWith("Advisor: 回落硬停"), "清零后仍需连败 2 次才硬停")
  dropSession(sid)
})

test("R3 D-06 同步路径单飞（验收⑦）: advisor >cap job 在飞期间 ≤cap 同步调用/dsh 路由调用均被拒（全部入口单飞）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r3-d06-sync"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 900000 } } } // >cap → jobs 派发
  const deps = {
    llm: { stream: () => { throw new Error("must not be used") } },
    spawn, platform: "linux", env: {},
    ctx: { get: (svc) => (svc === "jobs" ? jobs : null) },
  }
  const out1 = await runAdvisorReview(deps, { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out1.includes("advisor-codex-1"), ">cap 预算派发后台 job")
  assert.equal(specs.length, 1)

  // 在飞期间：≤cap 同步预算调用（codex 路由）被拒——R2 只覆盖派发入口，本检查提前到全部入口
  //（组配 round1+convergence 同形：首个 jobs 评审 completed 烧轮后路由键转 convergence 组）
  const configSync = {
    advisor: {
      round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 300000 },
      convergence: { runner: { kind: "codex-cli", model: "codex-model-a" }, timeoutMs: 300000 },
    },
  }
  const r2 = await runAdvisorReview(deps, { agent, config: configSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(r2.startsWith("Error"), "≤cap 同步调用在飞期间被拒（D-06 扩展：全部入口单飞）")
  assert.ok(r2.includes("advisor-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(r2.includes("job_output"), "拒绝文本含接续方式")
  assert.ok(r2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")

  // 在飞期间：dsh 主路径调用同样被拒（同机制任意路由——无入口例外；若未拒会调用 llm 抛错）
  const configDsh = { advisor: { round1: { provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const rDsh = await runAdvisorReview(deps, { agent, config: configDsh, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(rDsh.startsWith("Error"), "dsh 主路径调用在飞期间同样被拒（机制级单飞）")
  assert.ok(rDsh.includes("advisor-codex-1"), "拒绝文本含在飞 job id")

  // settle → 槽位清除 → ≤cap 同步调用正常执行
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  const r3 = await runAdvisorReview(deps, { agent, config: configSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(r3.includes("| 1 | x | y |"), "settle 后槽位清除，≤cap 同步调用正常执行")
  dropSession(sid)
})

// ————————————— R3 §5.4 补丁轮（D-06）：escalate/eng 全入口单飞（≤cap 同步 + dsh 子代理路径） —————————————
// R3 主轮已交付 advisor 机制全入口检查（上方验收⑦）；本节补齐 escalate/eng 两机制全部入口：
// >cap job 在飞（占位）期间，≤cap 同步调用与 dsh 子代理路径调用一律在机制入口被拒（R2 同款
// 拒绝文本：Error 前缀 + 在飞 job id + 接续指引）；settle 双分支清除复用 R2 既有
// clearInFlightJob（done 回调内，零新代码）。

test("R3 D-06 补丁轮 escalate: >cap job 在飞期间 ≤cap codex 同步调用/followup 续轮被拒（含 job id），settle 后恢复", async () => {
  let execCalls = 0
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    execCalls++ // 行不带 effort → codex 目录发现零触发，只数真实 exec 任务（计数确定）
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r3-d06-esc-sync"
  // 首次：>cap 预算（900000 > 默认 budgetCap 540000）→ jobs 后台派发并占位 escalate 槽位
  const cfgOver = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const deps1 = makeEscDeps(sid, spawn, cfgOver)
  deps1.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps1, "first long task", undefined)
  assert.ok(out1.includes("escalate-codex-1"), ">cap 首次派发后台 job（占位 escalate 槽位）")
  assert.equal(specs.length, 1)
  // 在飞期间：≤cap 同步预算调用（codex 行 300000 ≤ cap）被拒——R2 只覆盖派发入口，补丁轮提前到机制入口
  const cfgSync = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 300000 } }], codexCli: { executable: process.execPath } }
  const deps2 = makeEscDeps(sid, spawn, cfgSync)
  deps2.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out2 = await runEscalate(deps2, "short task while in flight", undefined)
  assert.ok(out2.startsWith("Error"), "≤cap 同步调用在飞期间被拒（D-06 扩展：escalate 全入口单飞）")
  assert.ok(out2.includes("escalate-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("job_output"), "拒绝文本含接续方式")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")
  // 在飞期间：followup 续轮入口同样被拒（全入口无例外——先于线程查找即拒）
  const outF = await runEscalate(deps2, "followup while in flight", undefined, true)
  assert.ok(outF.startsWith("Error") && outF.includes("escalate-codex-1"), "followup 续轮入口同样被拒（机制级单飞）")
  // settle → 槽位清除（done 双分支 clearInFlightJob）→ ≤cap 同步调用恢复执行。
  // execCalls===1 证明被拒的 ≤cap/followup 调用零 exec（若走同步路径会各多一次且文本断言已先行失败）
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.equal(execCalls, 1, "被拒调用零 exec——在飞窗口内仅后台 job 恰好一次")
  const out3 = await runEscalate(deps2, "short task after settle", undefined)
  assert.ok(out3.includes("post-op report"), "settle 后槽位清除，≤cap 同步调用正常执行")
  assert.equal(specs.length, 1, "同步执行不派 job")
  assert.equal(execCalls, 2, "同步路径恢复执行（恰好一次 runCodexTask）")
  dropSession(sid)
})

test("R3 D-06 补丁轮 escalate: >cap job 在飞期间 dsh 子代理路径调用被拒（llm/subagents 零触碰）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r3-d06-esc-dsh"
  const cfgOver = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const deps1 = makeEscDeps(sid, spawn, cfgOver)
  deps1.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps1, "first long task", undefined)
  assert.ok(out1.includes("escalate-codex-1"), ">cap 首次派发后台 job（占位 escalate 槽位）")
  // 在飞期间：dsh 行（非 codex runner）调用同样被拒——若未拒将走 dsh 分支触碰 llm/subagents
  let dshTouched = false
  const cfgDsh = { consultModels: [{ provider: "acme", model: "model-a", effort: "medium" }] }
  const deps2 = makeEscDeps(sid, spawn, cfgDsh)
  deps2.ctx = {
    get: (svc) => (svc === "jobs" ? jobs : null),
    llm: { resolveModelInfo: async () => { dshTouched = true; throw new Error("llm must not be touched while in flight") } },
    subagents: { start: () => { dshTouched = true; throw new Error("dsh spawn must not run while in flight") } },
  }
  const out2 = await runEscalate(deps2, "dsh row task while in flight", undefined)
  assert.ok(out2.startsWith("Error"), "dsh 子代理路径调用在飞期间被拒（D-06 扩展：escalate 全入口单飞）")
  assert.ok(out2.includes("escalate-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")
  assert.equal(dshTouched, false, "dsh 分支零触碰（effort 解析/subagents.start 均未执行——入口即拒）")
  await specs[0].hooks.done // settle 清槽位（测试隔离）
  dropSession(sid)
})

test("R3 D-06 补丁轮 eng: >cap job 在飞期间 ≤cap codex 同步调用被拒（含 job id），settle 后恢复", async () => {
  let execCalls = 0
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    execCalls++ // engCoderEffort=off → codex 目录发现零触发，只数真实 exec 任务（计数确定）
    return { events: [], exitCode: 0, outText: "implemented\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r3-d06-eng-sync"
  // 首次：默认 30min 预算（1800000 > 默认 budgetCap 540000）→ jobs 后台派发并占位 eng 槽位
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath }, engCoderEffort: "off" })
  const out1 = await runEngCoder(deps, { task: "implement a (long)", designToken: token, docs: [] })
  assert.ok(out1.includes("eng-codex-1"), ">cap 首次派发后台 job（占位 eng 槽位）")
  assert.equal(specs.length, 1)
  // 在飞期间：≤cap 同步预算（defaultTimeoutMs=300000 ≤ cap）调用被拒——入口即拒，runCodexTask 未被触碰
  const { deps: deps2, token: token2 } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath, defaultTimeoutMs: 300000 }, engCoderEffort: "off" })
  const out2 = await runEngCoder(deps2, { task: "implement b (short) while in flight", designToken: token2, docs: [] })
  assert.ok(out2.startsWith("Error"), "≤cap 同步调用在飞期间被拒（D-06 扩展：eng 全入口单飞）")
  assert.ok(out2.includes("eng-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("job_output"), "拒绝文本含接续方式")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")
  // settle → 槽位清除（done 双分支 clearInFlightJob）→ ≤cap 同步调用恢复执行。
  // execCalls===1 证明被拒的 ≤cap 调用零 exec（若走同步路径会多一次且文本断言已先行失败）
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.equal(execCalls, 1, "被拒调用零 exec——在飞窗口内仅后台 job 恰好一次")
  const out3 = await runEngCoder(deps2, { task: "implement c (short) after settle", designToken: token2, docs: [] })
  assert.ok(out3.includes("eng_coder delivery (codex-cli)"), "settle 后槽位清除，≤cap 同步调用正常执行")
  assert.equal(specs.length, 1, "同步执行不派 job")
  assert.equal(execCalls, 2, "同步路径恢复执行（恰好一次 runCodexTask）")
  dropSession(sid)
})

test("R3 D-06 补丁轮 eng: >cap job 在飞期间 dsh 子代理路径调用被拒（subagents 零触碰）", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "implemented\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r3-d06-eng-dsh"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath }, engCoderEffort: "off" })
  const out1 = await runEngCoder(deps, { task: "implement a (long)", designToken: token, docs: [] })
  assert.ok(out1.includes("eng-codex-1"), ">cap 首次派发后台 job（占位 eng 槽位）")
  // 在飞期间：dsh 后端（engCoderRunner 未配）调用同样被拒——若未拒将走 dsh 分支触碰 subagents
  let dshTouched = false
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: {} }
  const depsDsh = {
    ctx: {
      get: (svc) => (svc === "jobs" ? jobs : null),
      subagents: { start: () => { dshTouched = true; throw new Error("dsh spawn must not run while in flight") } },
    },
    agent, config: {}, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {},
  }
  const out2 = await runEngCoder(depsDsh, { task: "implement b (dsh) while in flight", designToken: token, docs: [] })
  assert.ok(out2.startsWith("Error"), "dsh 子代理路径调用在飞期间被拒（D-06 扩展：eng 全入口单飞）")
  assert.ok(out2.includes("eng-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")
  assert.equal(dshTouched, false, "dsh 分支零触碰（subagents.start 未执行——入口即拒）")
  await specs[0].hooks.done // settle 清槽位（测试隔离）
  dropSession(sid)
})

// ————————————— R4 §6.5：R3 code review 收尾四项折入 —————————————
// ① 回落失败路径补「回落失败 X/2」计数后缀（断言已折入上方 R3 D-07 活锁封顶用例）；
// ② escalate dsh 超时竞态分支补 codexFailureAdvisory（与 eng 对齐）；
// ③ clearCodexFailureCount 更名 clearAdvisorRouteFailureState + 旧名导出别名（index.mjs 挂点零改动）；
// ④ advisor JSDoc 补 single-flight "Error:" 前缀例外注记（纯注释——全量绿即无行为变化，前缀
//    语义由既有 D-06 系用例的 startsWith("Error") 断言锁死）。

test("R4 R3收尾②: escalate dsh 超时竞态分支补 codexFailureAdvisory——partial Touched 行 advisory 解析（与 eng 对齐，不并入审计范围）", async () => {
  const started = []
  const ctx = {
    llm: ladderLlm(["low"]),
    subagents: {
      async start(_kind, req) {
        started.push(req)
        // 竞态形态：run.result 不 throw、在 signal abort 时正常 resolve（stopReason=aborted）——
        // 走 dshTimedOut 竞态分支（run.result 的 throw 分支在 R2 DP-1 用例覆盖）
        return {
          result: new Promise((resolve) => {
            req.signal.addEventListener("abort", () => resolve({
              stopReason: "aborted",
              output: [{ type: "text", text: "halfway work\n\nTouched files: lib/racy.mjs" }],
              diagnostic: "deadline abort",
            }))
          }),
          dispose: async () => { },
        }
      },
    },
  }
  const sid = "r4-esc-race"
  const deps = {
    ctx, agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "acme", model: "model-a" }], codexCli: { budgetCapMs: 250 } },
    state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn for a dsh row") }, platform: "linux", env: {},
  }
  const r = await captureWarn(() => runEscalate(deps, "long dsh task", undefined))
  assert.equal(started.length, 1, "dsh 子代理已启动")
  assert.ok(r.value.includes("dsh 子代理路径超内部截止"), "竞态分支终止文案（run.result 正常返回 + dshTimedOut）")
  assert.ok(r.value.includes("halfway work"), "partial 输出可见")
  assert.ok(r.value.includes("partial 输出含 Touched 行（advisory 解析，未并入审计范围）"), "codexFailureAdvisory 补齐（R4 R3收尾②，与 eng 对齐）")
  assert.ok(r.value.includes("lib/racy.mjs"), "advisory 提示含 Touched 路径")
  assert.ok(!(sessionState(sid).touchedFiles || []).includes("lib/racy.mjs"), "advisory 不并入 touchedFiles 审计范围（D-20 失败交付不簿记）")
  dropSession(sid)
})

test("R4 R3收尾③: clearCodexFailureCount 更名 clearAdvisorRouteFailureState——旧名为同一函数导出别名（index.mjs D-22 挂点零改动）", async () => {
  const { runAdvisorReview, clearAdvisorRouteFailureState, clearCodexFailureCount } = await import("../lib/advisor.mjs")
  assert.equal(clearCodexFailureCount, clearAdvisorRouteFailureState, "旧名 = 新名导出别名（同一函数引用）")
  assert.equal(typeof clearAdvisorRouteFailureState, "function", "新名可调用")
  // 行为等价：armed 硬停经新名清理解除（镜像 R3 D-07 会话重置解除用例）
  const { spawn, execCalls } = r3FailingCodexSpawn()
  const llm = { stream() { return (async function* () { throw new Error("fb route down") })() } }
  const sid = "r4-rename-alias"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 300000 } } }
  const run = () => runAdvisorReview(
    { llm, spawn, platform: "linux", env: {} },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  for (let i = 0; i < 4; i++) await run() // 硬停 armed
  const held = await run()
  assert.ok(held.startsWith("Advisor: 回落硬停"), "armed 后 held 生效")
  clearAdvisorRouteFailureState(sid) // 新名调用（index.mjs 挂点语义不变）
  const r = await run()
  assert.ok(!r.includes("回落硬停"), "新名清理 → 硬停解除（与旧名行为等价）")
  assert.ok(r.includes("codex-cli PROCESS_ERROR"), "恢复常规执行")
  assert.equal(execCalls(), 3, "解除后 codex 被调用（2 次硬停前 + 1 次解除后）")
  dropSession(sid)
})

// ————————————— R4 §6.2（D-13）：advisorOverride.runner 三面同步 —————————————
// 三面 = advisor_config 工具（ADVISOR_OVERRIDE_GROUP_PATHS + coerceValue 校验走
// normalizeRunnerValue）⊕ session-store 持久化白名单 ⊕ apply-session（index.mjs 一期已接受，
// 零改动）。会话覆盖 runner 此前「工具拒收 + 重启即丢」——resolve 链本身一期即消费 runner
// （resolveAdvisorRoute 组环合并含 runner），缺的只是入口与持久化两道白名单。

test("R4 D-13: advisor_config set/reset runner——白名单接受（normalizeRunnerValue 校验 + 归一化存储），非法值拒收（N4 不变式）", async () => {
  const { runAdvisorConfigTool } = await import("../lib/advisor.mjs")
  const state = { advisorOverride: null }
  const deps = { config: { advisor: { round1: { provider: "p", model: "m" } } }, agentOpts: {}, state, sessionId: "r4-d13-set" }
  // 字符串简写 "codex-cli" → 归一化结构存储
  let out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":"codex-cli"}', deps)
  assert.ok(out.startsWith("advisor_config: set round1.runner"), "runner 进入可设路径: " + out)
  assert.deepEqual(state.advisorOverride.round1.runner, { kind: "codex-cli" }, "字符串简写 → 归一化结构")
  // 对象形态（model/effort 字段级校验 + 透传）
  out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":{"kind":"codex-cli","model":"codex-model-a","effort":"high"}}', deps)
  assert.ok(out.startsWith("advisor_config: set round1.runner"))
  assert.deepEqual(state.advisorOverride.round1.runner, { kind: "codex-cli", model: "codex-model-a", effort: "high" })
  // 字符串 "dsh" → 显式切回 dsh（回落硬停修正指引 2 的通道）
  out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":"dsh"}', deps)
  assert.deepEqual(state.advisorOverride.round1.runner, { kind: "dsh" }, "dsh 显式回切（非 codex 分支，回落既有链）")
  // 面三（resolve 链消费）：override runner=codex-cli → codex 路由生效
  state.advisorOverride.round1.runner = { kind: "codex-cli", model: "codex-model-a" }
  const route = resolveAdvisorRoute({ config: deps.config, override: state.advisorOverride, agentOpts: {}, advisorRound: 0 })
  assert.equal(route.provider, "codex-cli", "会话覆盖 runner 真正生效（codex 分支——一期已支持，工具面今通）")
  assert.equal(route.model, "codex-model-a")
  // reset 清除
  out = runAdvisorConfigTool('{"action":"reset","path":"round1"}', deps)
  assert.ok(out.startsWith("advisor_config: reset round1"))
  assert.equal(state.advisorOverride, null)
  // 非法值拒收：未知 kind / 类型错 / 越界 timeoutMs（B12 字段级错误 → invalid input，state 不变）
  state.advisorOverride = { round1: { provider: "keep" } }
  const before = JSON.stringify(state.advisorOverride)
  for (const bad of [{ kind: "bogus" }, { kind: "codex-cli", timeoutMs: 10 }, ["codex-cli"], 42]) {
    out = runAdvisorConfigTool(JSON.stringify({ action: "set", path: "round1.runner", value: bad }), deps)
    assert.ok(out.startsWith("advisor_config: invalid input"), "非法 runner 拒收: " + out)
    assert.ok(out.includes("runner"), "错误信息指向 runner 校验")
  }
  out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":"codex-wrong"}', deps)
  assert.ok(out.startsWith("advisor_config: invalid input") && out.includes("dsh"), "字符串非枚举拒收（错误信息含合法域）: " + out)
  assert.equal(JSON.stringify(state.advisorOverride), before, "拒收不改 state（N4）")
})

test("R4 D-13: runner 会话覆盖持久化往返——set runner → 落盘 → 模拟重启恢复 → 仍在且解析链继续生效（session-store 白名单此前丢弃）", async () => {
  const { runAdvisorConfigTool } = await import("../lib/advisor.mjs")
  const home = mkdtempSync(join(tmpdir(), "runner-rt-r4-"))
  try {
    const sid = "r4-d13-roundtrip"
    const state = sessionState(sid)
    const deps = { config: {}, agentOpts: {}, state, sessionId: sid }
    // 面 1：advisor_config 工具 set（归一化结构入 override）
    const out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":{"kind":"codex-cli","model":"codex-model-a"}}', deps)
    assert.ok(out.startsWith("advisor_config: set round1.runner"), "set 成功: " + out)
    // 面 2：落盘（index.mjs advisor_config set 写点的同一视图链路：sessionStateViewWithGeneration）
    assert.ok(saveSessionState(sid, sessionStateViewWithGeneration(state), home), "落盘成功")
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid]
    assert.deepEqual(entry.advisorOverride.round1.runner, { kind: "codex-cli", model: "codex-model-a" },
      "持久化白名单保留 runner（D-13：此前 sanitizeAdvisorOverride 丢弃——重启即失）")
    // 模拟重启：loadSessionState（normalizeRestored）→ runner 仍在
    const snap = loadSessionState(sid, home)
    assert.deepEqual(snap.advisorOverride.round1.runner, { kind: "codex-cli", model: "codex-model-a" }, "恢复侧 runner 保留")
    // 面 3：恢复的 override 继续被解析链消费（往返闭合）
    const route = resolveAdvisorRoute({ config: {}, override: snap.advisorOverride, agentOpts: {}, advisorRound: 0 })
    assert.equal(route.ok, true)
    assert.equal(route.provider, "codex-cli", "恢复的 runner 继续生效（codex 路由）")
    assert.equal(route.model, "codex-model-a")
    dropSession(sid)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ————————————— R4 §6.4：R1 审计 🔵 遗留收口 —————————————
// ① per-point fail-open 接线级用例：resolver 级覆盖（"元数据不可得 → 透传 + 响亮告警"）已有，
//    此前缺消费点接线形态——escalate dsh 行 / advisor dsh 主路径（元数据不可得时 effort
//    原样透传进 agentOptions/stream opts + note 入返回尾部，绝不砖化）。②③④见
//    codex-adapter.mjs 缓存注释 / 登记表 D-18 措辞核对 + D-15 测量标注（docs 侧交付）。

test("R4 R1审计🔵①: 接线级 fail-open — escalate dsh 行元数据不可得（llm 无 resolveModelInfo）→ effort 原样透传 + note 入术后报告", async () => {
  const started = []
  const ctx = {
    llm: { stream() { } }, // 无 resolveModelInfo → 元数据不可得（fail-open 判定分支）
    subagents: {
      async start(_kind, req) {
        started.push(req)
        return { result: Promise.resolve({ output: [{ type: "text", text: "second opinion" }], stopReason: "completed" }), dispose: async () => { } }
      },
    },
  }
  const sid = "r4-failopen-esc"
  const deps = {
    ctx, agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "acme", model: "model-a", effort: "high" }] },
    state: sessionState(sid), signal: undefined,
    spawn: () => { throw new Error("codex must not spawn for a dsh row") }, platform: "linux", env: {},
  }
  const r = await captureWarn(() => runEscalate(deps, "fix it", undefined))
  assert.equal(started.length, 1, "dsh 子代理已启动（未砖化）")
  assert.equal(started[0].agentOptions.reasoningEffort, "high", "接线级：effort 原样透传进 agentOptions（元数据缺失不拦截）")
  assert.ok(r.value.includes("passed through unverified"), "透传 note 入术后报告尾部（附录 D.3）")
  assert.ok(r.warnings.some((w) => w.includes("effort metadata unavailable")), "响亮告警 console.warn 留档")
  dropSession(sid)
})

test("R4 R1审计🔵①: 接线级 fail-open — advisor dsh 主路径元数据不可得 → stream opts 原样透传 reasoningEffort + note 入结果尾部", async () => {
  const sid = "r4-failopen-adv"
  const streamOptsSeen = []
  const llm = {
    stream(opts) { // 有 stream 无 resolveModelInfo → 元数据不可得
      streamOptsSeen.push(opts)
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const r = await captureWarn(() => runDshReview(sid, llm, {
    advisor: { round1: { provider: "acme", model: "model-a", effort: "high", timeoutMs: 300000 } },
  }))
  assert.equal(streamOptsSeen[0].reasoningEffort, "high", "接线级：effort 原样透传进 stream opts（元数据缺失不拦截）")
  assert.ok(r.value.includes("passed through unverified"), "透传 note 入结果尾部")
  assert.ok(r.warnings.some((w) => w.includes("effort metadata unavailable")), "响亮告警 console.warn 留档")
  assert.ok(r.value.includes("| 1 |"), "评审照常交付（fail-open 绝不砖化）")
  dropSession(sid)
})

// ————————————— D-30（FR-T2）：旧密钥链已删除 —— 本块原 D-25 用例（三形态密钥解析 / 重启稳定性 /
// 公开默认值回落）随密钥链一并移除；替代覆盖 = AC-3（静态：advisor.mjs 无密钥链残留）、
// AC-4（无 env 无 DSH_HOME 时铸造+校验成功且无告警）、AC-26（一次性弃用告警）。
// jobs 派发 warnPrefix —————————————

// ————————————— D-30 补丁（分歧审计 B2）：tokenExpiryMs 必须匹配**整段**整数 —————————————
// 修复前用 Number.parseInt → 截断尾随垃圾，故 validateDesignToken("<uuid>:<exp>xyz") === true，
// 与 advisor.mjs:678 注释「畸形串一律不通过」及设计档契约「expiresAt 有限」矛盾（父侧实测复现）。
test("D-30/B2: tokenExpiryMs matches the WHOLE expiry segment — trailing junk / whitespace / sign / float / scientific / overlong digit strings are all malformed", () => {
  const exp = Date.now() + 10 * 24 * 3600 * 1000 // 10d 后：任何「截断后仍读到 exp」的实现都会误判为有效
  const uuid = "11111111-2222-3333-4444-555555555555"
  const good = uuid + ":" + exp
  // 干净两段仍通过（回归锁：本补丁不得误伤合法令牌）
  assert.equal(tokenExpiryMs(good), exp, "整数段 → 原值")
  assert.equal(validateDesignToken(good), true, "干净两段仍通过")
  assert.equal(designTokenFailureReason(good), null)
  const bad = [
    good + "xyz",                    // 尾随垃圾（B2 实测复现形态）
    uuid + ": " + exp,               // 段前空白
    uuid + ":" + exp + " ",          // 段后空白
    uuid + ":+" + exp,               // 前导符号
    uuid + ":-" + exp,
    uuid + ":" + exp + ".5",         // 浮点
    uuid + ":1e12",                  // 科学计数
    uuid + ":0x10",                  // 十六进制
    uuid + ":" + "9".repeat(16),     // 超长数字串（>15 位；19 位起 Number 精度失真）
    uuid + ":",                      // 空段
  ]
  for (const t of bad) {
    assert.equal(tokenExpiryMs(t), null, "not an exact integer segment: " + JSON.stringify(t))
    assert.equal(validateDesignToken(t), false, "malformed token must NOT validate: " + JSON.stringify(t))
    assert.equal(designTokenFailureReason(t), "malformed", "failure reason must be malformed: " + JSON.stringify(t))
  }
  // 边界（显式记录，非本轮变更面）：**整串**前导空白不落在第 1 段上，故 tokenExpiryMs 仍返回 exp。
  // 该形态在真实路径上必先撞 eng.mjs 的全等匹配（token !== state.designToken），无授权面影响；
  // 此处锁住现状，避免将来「顺手 trim」把形状语义改到无人察觉。
  assert.equal(tokenExpiryMs(" " + good), exp, "整串前导空白不改变第 1 段（形状层概念，见上）")
})

test("R4 收尾 #4: advisor jobs 派发路径 warnPrefix 并入派发文本——与同步路径可见性一致（此前仅 console.warn 留档）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args)
    : { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "jobs-warnprefix-r4"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  // 组内 runner + 显式 provider/model 并存 → route.warnings 非空（「被忽略」告警）；timeoutMs > budgetCap → jobs 派发
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "codex-model-a" }, provider: "acme", model: "model-a", timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-codex-1"), "派发正常（fake jobs 返回 branded string）")
  assert.ok(out.includes("advisor configuration warnings"), "warnPrefix 摘要并入派发文本（与同步路径一致）")
  assert.ok(out.includes("被忽略"), "具体警告内容（runner=codex-cli 生效中——组内 provider/model 被忽略）随文本可见")
  await specs[0].hooks.done // settle（finalize 轮次推进）后再清理会话
  dropSession(sid)
})

// ————————————— R5（D-27，设计 §7）：dsh 路径后台化 —— Stage 1：dshBackgroundTimeoutMs 三面落地 —————————————
// 三面白名单同步（N-5/US-10，防 D-13 类漂移）：PUT 校验（index.mjs）⊕ merge 白名单
//（config-store.mjs）⊕ 运行时解析（resolveDshBackgroundTimeoutMs——config-store.mjs 导出，
// advisor/escalate/eng 三机制消费的单一事实源）。缺省 1800000（30min）；合法 60000..3600000。

test("R5 dshBackgroundTimeoutMs 三面同步: PUT 接受合法值 ⊕ merge 保留 ⊕ 运行时解析生效", async () => {  // 面 1：PUT 校验（index.mjs validateGlobalUserConfig 经 makeApiHandler 真实 PUT 路径）
  const { makeApiHandler } = await import("../lib/index.mjs")
  const handler = makeApiHandler(fenceCtx(), { baseConfig: {}, dshHomeOverride: mkdtempSync(join(tmpdir(), "dshbg-")) })
  const req = { method: "PUT", url: "/thincoder-suite/api/config", [Symbol.asyncIterator]: function* () { yield Buffer.from(JSON.stringify({ config: { dshBackgroundTimeoutMs: 720000 } })) } }
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler(req, res)
  assert.equal(res.statusCode, 200, "PUT 接受合法值: " + res.body)
  assert.equal(JSON.parse(res.body).user.dshBackgroundTimeoutMs, 720000, "sanitized 保留")
  // 面 2：配置合并（config-store.mjs mergeGlobalConfig 白名单透传）
  const merged = mergeGlobalConfig({}, { dshBackgroundTimeoutMs: 720000 })
  assert.equal(merged.dshBackgroundTimeoutMs, 720000, "merge 保留（user 层覆盖 base）")
  assert.equal(mergeGlobalConfig({ dshBackgroundTimeoutMs: 900000 }, {}).dshBackgroundTimeoutMs, 900000, "无 user 层保留 base")
  // 面 3：运行时解析（config-store resolveDshBackgroundTimeoutMs——三条后台 dsh 路径共享的兜底 deadline 读取）
  const { resolveDshBackgroundTimeoutMs, DSHS_BACKGROUND_TIMEOUT_DEFAULT_MS } = await import("../lib/config-store.mjs")
  assert.equal(resolveDshBackgroundTimeoutMs({ dshBackgroundTimeoutMs: 720000 }), 720000, "运行时收配置值")
  assert.equal(resolveDshBackgroundTimeoutMs({}), DSHS_BACKGROUND_TIMEOUT_DEFAULT_MS, "未配 → 缺省 1800000（30min）")
  assert.equal(DSHS_BACKGROUND_TIMEOUT_DEFAULT_MS, 1800000)
})

test("R5 dshBackgroundTimeoutMs: PUT 拒绝区间外/非整数（B12 字段级错误，越界值不落盘）", () => {
  for (const bad of [0, 59999, 3600001, 1.5, -100, "many"]) {
    const v = validateGlobalUserConfig({ dshBackgroundTimeoutMs: bad }, [])
    assert.equal(v.ok, false, "PUT 拒绝非法值 " + JSON.stringify(bad))
    assert.ok(v.errors.some((e) => e.includes("dshBackgroundTimeoutMs") && e.includes("60000..3600000")), "错误信息含合法区间: " + v.errors.join("|"))
    assert.equal(v.sanitized.dshBackgroundTimeoutMs, undefined, "非法值不进 sanitized（不落盘）")
  }
  const ok = validateGlobalUserConfig({ dshBackgroundTimeoutMs: 60000 }, [])
  assert.equal(ok.ok, true, "下边界 60000 接受")
  assert.equal(ok.sanitized.dshBackgroundTimeoutMs, 60000)
  const ok2 = validateGlobalUserConfig({ dshBackgroundTimeoutMs: 3600000 }, [])
  assert.equal(ok2.ok, true, "上边界 3600000 接受")
})

test("R5 dshBackgroundTimeoutMs: 运行时非法值（手编 config）→ 回落缺省 1800000 + 响亮告警", async () => {
  const { resolveDshBackgroundTimeoutMs, DSHS_BACKGROUND_TIMEOUT_DEFAULT_MS } = await import("../lib/config-store.mjs")
  for (const bad of ["many", -5, 0, 1.5]) {
    const r = await captureWarn(() => resolveDshBackgroundTimeoutMs({ dshBackgroundTimeoutMs: bad }))
    assert.equal(r.value, DSHS_BACKGROUND_TIMEOUT_DEFAULT_MS, "非法值回落缺省（绝不砖化后台派发）: " + JSON.stringify(bad))
    assert.ok(r.warnings.some((w) => w.includes("dshBackgroundTimeoutMs") && w.includes("1800000")), "非法值告警 console.warn 留档: " + r.warnings.join("|"))
  }
  // 运行时宽容正整数值（对齐 resolveCodexBudgetCapMs 先例：测试/手编小值可驱动兜底 deadline）
  assert.equal(resolveDshBackgroundTimeoutMs({ dshBackgroundTimeoutMs: 400 }), 400, "正整数值运行时生效（PUT 面仍收口 60000..3600000）")
})

// ————————————— D-29：consultTimeoutMs / engTokenTtlMs 进 user 层白名单 —————————————
// 缺口（用户实测）：两键运行时都读得到配置，却都被 mergeGlobalConfig 白名单排除 → 只能改
// entry base（cordis.patch.yml），设置页改不动。本块锁三面同步（PUT 校验 ⊕ merge 保留 ⊕
// 到达运行时消费点），并对「此前会告警 unknown top-level field」做回归断言。

test("D-29 consultTimeoutMs/engTokenTtlMs: PUT 接受合法值 ⊕ 不再告警 unknown ⊕ merge 保留", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const handler = makeApiHandler(fenceCtx(), { baseConfig: {}, dshHomeOverride: mkdtempSync(join(tmpdir(), "d29-")) })
  const req = {
    method: "PUT", url: "/thincoder-suite/api/config",
    [Symbol.asyncIterator]: function* () {
      yield Buffer.from(JSON.stringify({ config: { consultTimeoutMs: 1800000, engTokenTtlMs: 604800000 } }))
    },
  }
  const res = { statusCode: 0, body: "", writeHead(code) { this.statusCode = code }, end(b) { this.body = b } }
  await handler(req, res)
  assert.equal(res.statusCode, 200, "PUT 接受合法值: " + res.body)
  const body = JSON.parse(res.body)
  assert.equal(body.user.consultTimeoutMs, 1800000, "consultTimeoutMs sanitized 保留")
  assert.equal(body.user.engTokenTtlMs, 604800000, "engTokenTtlMs sanitized 保留")
  // 回归：这两键此前落在 topAllowed 之外 → notes 里会出现 "ignoring unknown top-level field"
  const notes = (body.notes ?? []).join("|")
  assert.ok(!notes.includes("ignoring unknown top-level field"), "两键已入白名单，不再被当未知字段忽略: " + notes)
  // merge 面：user 层覆盖 base；无 user 层保留 base
  const merged = mergeGlobalConfig({}, { consultTimeoutMs: 1800000, engTokenTtlMs: 604800000 })
  assert.equal(merged.consultTimeoutMs, 1800000, "merge 保留 consultTimeoutMs")
  assert.equal(merged.engTokenTtlMs, 604800000, "merge 保留 engTokenTtlMs")
  assert.equal(mergeGlobalConfig({ consultTimeoutMs: 30000 }, {}).consultTimeoutMs, 30000, "无 user 层保留 base（consult）")
  assert.equal(mergeGlobalConfig({ engTokenTtlMs: 600000 }, {}).engTokenTtlMs, 600000, "无 user 层保留 base（ttl）")
  // —— 面 3（**移植远端分叉 7b6a845 / v0.9.3 的真增量**）：会诊看门狗预算的运行时解析 ——
  // 7b6a845 与本仓 D-29 是**同一件修复**（consultTimeoutMs 用户层化）的两次独立实现；本仓 D-29
  // 已把两键补进三面白名单（功能完整），故只取它**独有的精炼点**：把预算解析从 consult.mjs 的
  // 就地三元式提到 config-store 的**单一事实源**（带非法值告警、跨升级保留语义）。
  const { resolveConsultTimeoutMs, CONSULT_TIMEOUT_DEFAULT_MS } = await import("../lib/config-store.mjs")
  assert.equal(CONSULT_TIMEOUT_DEFAULT_MS, 600000, "缺省 600000（10min）")
  assert.equal(resolveConsultTimeoutMs({ consultTimeoutMs: 900000 }), 900000, "合法配置值生效（未配/非法才回落）")
  assert.equal(resolveConsultTimeoutMs({ consultTimeoutMs: 30000 }), 30000,
    "下限侧合法值生效——30000..59999 的既有用户配置**不得**被回落（值域取下限 30000 的裁定落点）")
  assert.equal(resolveConsultTimeoutMs({}), CONSULT_TIMEOUT_DEFAULT_MS, "未配 → 缺省")
  assert.equal(resolveConsultTimeoutMs({ consultTimeoutMs: null }), CONSULT_TIMEOUT_DEFAULT_MS, "null 视为未配 → 缺省")
  assert.equal(resolveConsultTimeoutMs(undefined), CONSULT_TIMEOUT_DEFAULT_MS, "无 config → 缺省（不抛）")
  assert.equal(resolveConsultTimeoutMs([{ consultTimeoutMs: 900000 }]), CONSULT_TIMEOUT_DEFAULT_MS,
    "数组形态 → 缺省（非配置对象）")
  for (const bad of [0, -5, 1.5, "many", NaN, Infinity]) {
    const r = await captureWarn(() => resolveConsultTimeoutMs({ consultTimeoutMs: bad }))
    assert.equal(r.value, CONSULT_TIMEOUT_DEFAULT_MS,
      "非法值回落缺省（绝不砖化会诊启动）: " + JSON.stringify(bad))
    assert.ok(r.warnings.some((w) => w.includes("consultTimeoutMs") && w.includes("600000")),
      "非法值告警 console.warn 留档: " + r.warnings.join("|"))
  }
  // 对照：合法值零告警（告警面只对非法值开口）
  const okResolve = await captureWarn(() => resolveConsultTimeoutMs({ consultTimeoutMs: 900000 }))
  assert.equal(okResolve.value, 900000)
  assert.equal(okResolve.warnings.length, 0, "合法值不告警")
})

test("D-29: PUT 拒绝区间外/非整数（越界值不落盘，错误文案含合法区间）", async () => {
  const cases = [
    ["consultTimeoutMs", [29999, 3600001, 1.5, "x", -1], "30000..3600000"],
    ["engTokenTtlMs", [599999, 2592000001, 1.5, "x", -1], "600000..2592000000"],
  ]
  for (const [field, bads, range] of cases) {
    for (const bad of bads) {
      const v = validateGlobalUserConfig({ [field]: bad }, [])
      assert.ok(v.errors.some((e) => e.includes(field) && e.includes(range)),
        field + " 越界报错含区间（" + JSON.stringify(bad) + "）: " + v.errors.join("|"))
      assert.equal(v.sanitized[field], undefined, field + " 非法值不进 sanitized（不落盘）")
    }
    // 边界值两侧都合法
    for (const ok of [Number(range.split("..")[0]), Number(range.split("..")[1])]) {
      const v = validateGlobalUserConfig({ [field]: ok }, [])
      assert.equal(v.ok, true, field + " 边界值合法（" + ok + "）: " + v.errors.join("|"))
      assert.equal(v.sanitized[field], ok, field + " 边界值进 sanitized")
    }
  }
  // —— 值域常量锁（移植 7b6a845 时的**裁定**）：下限取本仓批 1 已发布的 30000，**不取远端的 60000** ——
  // 远端独立选了 60000，没有任何依据要求我们跟随；跟随它会让**已存在的合法用户配置**
  //（30000..59999）静默变成非法而回落缺省——那是行为回归。故 MIN/MAX 继续复用批 1 的两常量
  //（不重复声明），并把「下限没被抬高」钉在**行为**上（30001 合法 / 29999 非法）。
  const { CONSULT_TIMEOUT_MIN_MS, CONSULT_TIMEOUT_MAX_MS, CONSULT_TIMEOUT_DEFAULT_MS, isValidConsultTimeoutMs } =
    await import("../lib/config-store.mjs")
  assert.equal(CONSULT_TIMEOUT_MIN_MS, 30000, "MIN 必须是批 1 已发布的 30000（远端口径 60000 会让既有配置静默变非法）")
  assert.equal(CONSULT_TIMEOUT_MAX_MS, 3600000, "MAX 1h（与 dshBackgroundTimeoutMs 同域）")
  assert.equal(CONSULT_TIMEOUT_DEFAULT_MS, 600000, "DEFAULT 10min")
  assert.equal(isValidConsultTimeoutMs(30000), true, "PUT 面 30000 合法")
  assert.equal(isValidConsultTimeoutMs(30001), true, "PUT 面 30001 合法（远端口径下会非法）")
  assert.equal(isValidConsultTimeoutMs(29999), false, "PUT 面 29999 非法")
  assert.equal(isValidConsultTimeoutMs(60000), true, "PUT 面 60000 合法（未被排除）")
})

test("D-29: 设置页表单接线齐全（静态核对——client.js 无既有 UI 测试面，至少锁住接线不丢字段）", () => {
  // client.js 是宿主内联的浏览器 bundle，无法在本进程直接渲染；这里做静态接线核对，
  // 防止「后端白名单开了、设置页却没接」这类静默半成品（本批最可能出的错）。
  const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
  for (const field of ["consultTimeoutMs", "engTokenTtlMs"]) {
    // ① 初始态（effective → draft 表单串）
    assert.ok(src.includes(field + ": effective && effective." + field + " !== undefined"),
      field + " 缺 draft 初始态接线（effective → 表单串）")
    // ② 草稿 → PUT 载荷（空字段不发送）
    assert.ok(src.includes("config." + field + " = Number(draft." + field + ")"),
      field + " 缺草稿 → PUT 载荷接线")
    // ③ 表单校验分支（区间常量）
    assert.ok(src.includes("draft." + field + " !== \"\"") && src.includes(field + " 必须是 "),
      field + " 缺前端校验分支或错误文案")
    // ④ busy 窗口内编辑保留（touched 回填）
    assert.ok(src.includes("touched[\"" + field + "\"]") && src.includes("next." + field + " = curOf(["),
      field + " 缺 busy 窗口编辑保留接线（touched 回填）")
    // ⑤ 表单控件 + onChange（有输入框才算真的可编辑）
    assert.ok(src.includes("setField([\"" + field + "\"], e.target.value)"),
      field + " 缺表单控件 onChange 接线")
  }
  // 区间常量与后端同值（防两面漂移）
  assert.ok(src.includes("var CONSULT_TIMEOUT_MIN = 30000") && src.includes("var CONSULT_TIMEOUT_MAX = 3600000"),
    "client.js 的 consultTimeoutMs 区间常量须与 config-store 同值")
  assert.ok(src.includes("var ENG_TTL_MIN = 600000") && src.includes("var ENG_TTL_MAX = 2592000000"),
    "client.js 的 engTokenTtlMs 区间常量须与 config-store 同值")
  // —— 结构配对（**移植远端 7b6a845**）：看门狗预算解析必须**单点化**在 config-store，consult 只消费 ——
  // 移植的判据是「结构」而非字节：远端那两个文件是本仓的**旧版本**（0.9.3 时代），照搬会回退其后
  // 17 个提交的改动 ⇒ 只取「resolver 这个函数 + consult 改调它」两处结构，内容按当前 HEAD 写。
  const consultSrc = readFileSync(new URL("../lib/consult.mjs", import.meta.url), "utf8")
  assert.ok(consultSrc.includes("resolveConsultTimeoutMs(config)"),
    "consult.mjs 消费点改调 config-store 的单一事实源（resolveConsultTimeoutMs(config)）")
  assert.ok(!consultSrc.includes("CONSULT_TIMEOUT_MS"),
    "就地常量 CONSULT_TIMEOUT_MS 已删除（预算解析不再有第二处数字）")
  assert.ok(!/Number\.isFinite\(config\.consultTimeoutMs\)/.test(consultSrc),
    "就地三元式判定已移除（否则单一事实源名存实亡）")
  assert.ok(consultSrc.includes('from "./config-store.mjs"'), "consult.mjs 从 config-store 导入 resolver")
  assert.ok(consultSrc.includes('from "./abort-provenance.mjs"'),
    "既有的 abort-provenance 导入保留（与 config-store 两条 import 并存，不得互相覆盖）")
  assert.ok(consultSrc.includes("abortTag") && consultSrc.includes("deathLine"),
    "abort-provenance 消费点仍在（导入未被架空——D-28 的死亡溯源词汇表）")
})

test("D-29: user 层落盘 → loadUserConfig → merge → 到达运行时消费点（effective 值真的变）", async () => {
  const home = mkdtempSync(join(tmpdir(), "d29-roundtrip-"))
  try {
    const cfg = { consultTimeoutMs: 900000, engTokenTtlMs: 604800000 }
    assert.equal(saveUserConfig(cfg, home), true, "user 层落盘成功")
    const loaded = loadUserConfig(home)
    assert.equal(loaded.consultTimeoutMs, 900000, "loadUserConfig 读回 consultTimeoutMs")
    assert.equal(loaded.engTokenTtlMs, 604800000, "loadUserConfig 读回 engTokenTtlMs")
    // base 里是旧值（模拟 cordis.patch.yml 的钉死值）——user 层必须覆盖它
    const base = { consultTimeoutMs: 600000, engTokenTtlMs: 3600000 }
    const effective = mergeGlobalConfig(base, loaded)
    assert.equal(effective.consultTimeoutMs, 900000, "user 层覆盖 base 的 consultTimeoutMs（这正是用户痛点：base 钉死改不动）")
    assert.equal(effective.engTokenTtlMs, 604800000, "user 层覆盖 base 的 engTokenTtlMs")
    // 消费点：驱动**真实铸造路径**（advisor.mjs generateDesignToken 读 config.engTokenTtlMs），
    // 断言 token 的有效期确实由 user 层生效值决定——而不是复制读取表达式（评审 🔵#6）
    const { generateDesignToken, tokenExpiryMs } = await import("../lib/advisor.mjs")
    const t0 = Date.now()
    const tok = generateDesignToken(effective)
    const exp = tokenExpiryMs(tok)
    assert.ok(exp !== null, "铸造出的 token 可解析 expiresAt")
    const ttlActual = exp - t0
    assert.ok(Math.abs(ttlActual - 604800000) < 5000,
      "token 有效期由 user 层 engTokenTtlMs 决定（实测 " + ttlActual + "ms，期望 ≈604800000）")
    // 反证：base 的旧值（1h）不再影响结果——证明覆盖链真的生效
    const tokBase = generateDesignToken({ engTokenTtlMs: 3600000 })
    assert.ok(Math.abs((tokenExpiryMs(tokBase) - t0) - 3600000) < 5000,
      "未覆盖时仍按传入 config 的 TTL 生效（对照组）")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ————————————— R5（D-27，设计 §7.1/§7.2）：advisor dsh 循环后台化 —— Stage 2 —————————————
// route.timeoutMs > budgetCapMs 且 ctx.jobs 可用 → 自动派后台 job（与 codex 分支完全对称）：
// run() 内跑完整 runAdvisorToolLoop（job 内预算不钳制——D-17 只护同步路径，route.timeoutMs
// 在 job 内全额生效）、finalize 在 done 内恰好一次（单飞 advisor 槽位 / 代际捕获校验 /
// prior·token 语义全套复用 R2 codex 模式）；≤cap / jobs 缺失 / 派发抛错 → 同步 + 钳制 +
// 响亮告警（D-17 现状——钳制保护的就是墙钟内的同步路径）。挂死兜底 dshBackgroundTimeoutMs
//（§7.2，Stage 1 三面落地后）：到点 abort 挂起的 llm.stream + 超时信封（job 不永悬）。
// 假 jobs（fakeJobsFactory——平台契约：start 返回 branded string + run() 产出 { cancel, done }）
// 假 llm（stream 注入，零出网）；dshBackgroundTimeoutMs 运行时宽容小值驱动兜底 deadline。

test("R5 §7.1 dsh 自动派发: >cap + ctx.jobs → job 内跑完整 runAdvisorToolLoop + finalize 恰好一次 + UI-2 接续指令 + settle 后槽位清除", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  let streamCalls = 0
  const llm = {
    stream() {
      streamCalls++
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-dispatch"
  const agent = r3Agent(sid)
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } } } // > 默认 budgetCap 540000
  const deps = { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } }
  const out = await runAdvisorReview(deps, { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out.includes("advisor-dsh-1"), "job 句柄（branded string 直接渲染——D-05）: " + out)
  assert.ok(!out.includes("job ?"), "job id 不恒显 ?（D-05）")
  assert.ok(out.includes("等待完成通知后再继续") && out.includes("job_output"), "UI-2/D-09 接续指令（勿 job_output wait 阻塞）")
  assert.ok(!out.includes("含评审全文"), "D-09：不承诺「通知含评审全文」（通知只含一行指针）")
  assert.ok(out.includes("预算 900s"), "全额预算可见（非钳制后数值）")
  assert.ok(out.includes("job 内预算不钳制"), "派发文案明示 job 内预算不钳制（D-17 只护同步路径）")
  assert.equal(specs.length, 1)
  assert.equal(specs[0].payload.kind, "advisor-dsh")
  assert.equal(specs[0].payload.owner, agent, "owner 绑定会话 agent")
  assert.ok(specs[0].payload.label.includes("dsh review (p:m, 900s)"), "label 含路由与预算")
  assert.ok(streamCalls >= 1, "run() 内 llm.stream 已被消费（job 启动即跑完整循环——纯进程内调用，无子进程）")
  // done settle → finalize 恰好一次：轮次推进恰好 1、prior 只存评审正文（D-19：机制后缀不进 prior）
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(outcome.output.includes("| 1 | a | b |"), "评审全文进 job output")
  const st = sessionState(sid)
  assert.equal(st.advisorRound, 1, "finalize 轮次推进恰好一次")
  assert.ok(st.lastAdvisorOutput && st.lastAdvisorOutput.includes("| 1 | a | b |"), "正文进 prior")
  assert.ok(!st.lastAdvisorOutput.includes("[thincoder-suite]"), "prior 不含机制后缀（D-19）")
  // settle 清槽位 → ≤cap 后续调用走同步（不再派发；首轮完成烧轮后路由键转 convergence 组）
  const cfgSync = {
    advisor: {
      round1: { provider: "p", model: "m", timeoutMs: 300000 },
      convergence: { provider: "p", model: "m", timeoutMs: 300000 },
    },
  }
  const out2 = await runAdvisorReview(deps, { agent, config: cfgSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out2.includes("| 1 | a | b |"), "settle 后 ≤cap 同步执行")
  assert.equal(specs.length, 1, "同步执行不派 job")
  dropSession(sid)
})

test("R5 §7.1 ≤cap 同步不变: jobs 可用也不派发（D-17 现状——≤cap 即同步快路径）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-sync"
  const agent = r3Agent(sid)
  const llm = {
    stream() {
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } } // ≤cap 540000
  const out = await runAdvisorReview(
    { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("| 1 | a | b |"), "同步路径交付评审")
  assert.ok(!out.includes("background job"), "未派发后台 job")
  assert.equal(specs.length, 0, "≤cap 不派发")
  assert.equal(sessionState(sid).advisorRound, 1, "同步 finalize 轮次推进")
  dropSession(sid)
})

test("R5 §7.1 jobs 缺失降级: >cap 且 ctx 无 jobs → 同步 + 钳制 + 响亮告警（D-17 现状保护同步路径）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const sid = "r5-adv-dsh-nojobs"
  const agent = r3Agent(sid)
  const llm = {
    stream() {
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } } }
  const r = await captureWarn(() => runAdvisorReview(
    { llm }, // 无 ctx → getJobsService 返回 null
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  ))
  const out = r.value
  assert.ok(r.warnings.some((w) => w.includes("ctx.jobs 不可用") && w.includes("900000") && w.includes("540000")), "jobs 缺失响亮告警: " + r.warnings.join("|"))
  assert.ok(out.includes("| 1 | a | b |"), "同步降级仍交付评审")
  assert.ok(out.includes("已按 codexCli.budgetCapMs=540000ms 截断执行"), "D-17 钳制尾部告警（同步路径可见）")
  dropSession(sid)
})

test("R5 §7.1 派发抛错降级: jobs.start throw → 同步 + 钳制 + 响亮告警（降级不静默吞——§7.1 同款 try/catch）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const sid = "r5-adv-dsh-throw"
  const agent = r3Agent(sid)
  const llm = {
    stream() {
      return (async function* () {
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const jobs = { start() { throw new Error("boom") } }
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } } }
  const r = await captureWarn(() => runAdvisorReview(
    { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  ))
  const out = r.value
  assert.ok(r.warnings.some((w) => w.includes("派发失败") && w.includes("boom")), "派发失败响亮告警: " + r.warnings.join("|"))
  assert.ok(out.includes("| 1 | a | b |"), "同步降级仍交付评审")
  assert.ok(out.includes("已按 codexCli.budgetCapMs=540000ms 截断执行"), "钳制告警（D-17 同步路径）")
  assert.equal(sessionState(sid).advisorRound, 1, "同步 finalize 轮次推进")
  dropSession(sid)
})

test("R5 §7.1 job 内预算不钳制: budgetCap=250ms 而 job 内流跨过 250ms 存活完成（route.timeoutMs 在 job 内全额生效）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-noclamp"
  const agent = r3Agent(sid)
  const llm = {
    stream() {
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: "FIRST PART " } }
        await sleep(800) // 第二块晚于 budgetCap=250ms 钳制窗口——job 内若被钳制会在 250ms 被杀
        yield { type: "block-end", block: { type: "text", text: "SECOND PART" } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const config = {
    advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } },
    codexCli: { budgetCapMs: 250 },
  }
  const out = await runAdvisorReview(
    { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-dsh-1"), "900000 > 250 → 自动派发")
  const t0 = Date.now()
  const outcome = await specs[0].hooks.done
  const elapsed = Date.now() - t0
  assert.equal(outcome.status, "completed", "job 内跑满 route.timeoutMs——流跨过钳制窗口后正常完成")
  assert.ok(outcome.output.includes("FIRST PART") && outcome.output.includes("SECOND PART"),
    "两块正文都收齐（第二块晚于 budgetCap=250ms 钳制窗口——钳制未在 job 内生效）")
  assert.ok(!outcome.output.includes("review timeout after"), "job 内未被 budgetCap 截断（无 250ms timeout 信封）")
  assert.ok(elapsed >= 400 && elapsed < 5000, "存活过钳制窗口（流自身 ~800ms）: " + elapsed + "ms")
  assert.equal(sessionState(sid).advisorRound, 1, "完成恰好一次")
  dropSession(sid)
})

test("R5 §7.2 兜底 deadline: 挂起 llm.stream 到点 abort（dshBackgroundTimeoutMs）+ 超时信封（job 不永悬、槽位清除、不烧轮次）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-backstop"
  const agent = r3Agent(sid)
  let calls = 0
  const llm = {
    stream(opts) {
      calls++
      return (async function* () {
        if (calls === 1) {
          // 第一调用（job 内）：产出部分内容后挂死，直到 signal abort（模拟 provider 流挂起）
          yield REVIEW_TABLE
          await new Promise((resolve, reject) => {
            const s = opts.signal
            if (!s) return setTimeout(resolve, 100000)
            const onAbort = () => reject((s.reason instanceof Error) ? s.reason : new Error(String(s.reason ?? "aborted")))
            if (s.aborted) onAbort()
            else s.addEventListener("abort", onAbort, { once: true })
          })
        } else {
          yield REVIEW_TABLE
          yield { type: "finish", reason: { kind: "stop" } }
        }
      })()
    },
  }
  const config = {
    advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } },
    dshBackgroundTimeoutMs: 300, // 运行时宽容小值驱动兜底 deadline（PUT 面仍收口 60000..3600000）
  }
  const warnings = []
  const origWarn = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try {
    const out = await runAdvisorReview(
      { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
      { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
    )
    assert.ok(out.includes("advisor-dsh-1"), "挂起任务先派发（主调用不被挂起阻塞）")
    const t0 = Date.now()
    const outcome = await specs[0].hooks.done // job settle 由兜底 abort 驱动（不依赖平台 cancel）
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 250 && elapsed < 5000, "兜底 deadline（~300ms）到点即 abort，job 不永悬: " + elapsed + "ms")
    assert.equal(outcome.status, "failed", "超时信封：评审未完成 → failed（partial 保留）")
    assert.ok(outcome.output.includes("超 dshBackgroundTimeoutMs=300ms 兜底截止"), "超时信封注明兜底截止: " + outcome.output.slice(0, 200))
    assert.ok(warnings.some((w) => w.includes("超兜底截止") && w.includes("dshBackgroundTimeoutMs=300")), "abort 响亮告警留档: " + warnings.join("|"))
    const st = sessionState(sid)
    assert.equal(st.advisorRound, 0, "超时信封不烧轮次")
    assert.equal(st.lastAdvisorOutput, null, "超时信封不写 prior")
    // 槽位清除（settle 双分支）：后续 ≤cap 同步调用不再被拒、正常交付
    const cfgSync = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } }
    const out2 = await runAdvisorReview(
      { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
      { agent, config: cfgSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
    )
    assert.ok(out2.includes("| 1 | a | b |"), "settle 后同步路径恢复（槽位已清）")
  } finally {
    console.warn = origWarn
  }
  dropSession(sid)
})

test("R5 §7.1 单飞（D-06）: dsh job 在飞期间二次 advisor 调用被拒（含 job id 与接续指引），cancel → settle 后槽位清除恢复", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-inflight"
  const agent = r3Agent(sid)
  let calls = 0
  const llm = {
    stream(opts) {
      calls++
      return (async function* () {
        if (calls === 1) {
          yield REVIEW_TABLE
          await new Promise((resolve, reject) => {
            const s = opts.signal
            if (!s) return setTimeout(resolve, 100000)
            const onAbort = () => reject((s.reason instanceof Error) ? s.reason : new Error(String(s.reason ?? "aborted")))
            if (s.aborted) onAbort()
            else s.addEventListener("abort", onAbort, { once: true })
          })
        } else {
          yield REVIEW_TABLE
          yield { type: "finish", reason: { kind: "stop" } }
        }
      })()
    },
  }
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } } }
  const deps = { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } }
  const out1 = await runAdvisorReview(deps, { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out1.includes("advisor-dsh-1"), ">cap 派发后台 job（advisor 槽位占位）")
  assert.equal(specs.length, 1)
  // 在飞期间：二次 advisor 调用（≤cap dsh 路由）在机制入口被拒——含在飞 job id 与接续方式
  const cfgSync = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } }
  const out2 = await runAdvisorReview(deps, { agent, config: cfgSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out2.startsWith("Error"), "在飞期间二次调用被拒（advisor 机制单飞——全部入口，D-06 扩展）")
  assert.ok(out2.includes("advisor-dsh-1"), "拒绝文本含在飞 job id")
  assert.ok(out2.includes("job_output") && out2.includes("未派发"), "接续指引 + 明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")
  // cancel → abort → done settle（双分支清除槽位）
  specs[0].hooks.cancel("cancelled by test")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "failed", "cancel 后 settle（中止形态）")
  assert.ok(outcome.output.includes("Advisor: interrupted.") || outcome.output.includes("review failed"), "中止可归因: " + outcome.output.slice(0, 120))
  const out3 = await runAdvisorReview(deps, { agent, config: cfgSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out3.includes("| 1 | a | b |"), "settle 后槽位清除，同步调用恢复执行")
  dropSession(sid)
})

test("R5 §7.1 代际（D-10）: dsh job 派发后 generation 变更 → 结果不并入（finalize 不执行——轮次/prior/token 丢弃）+ 完成通知注明", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-adv-dsh-gen"
  const agent = r3Agent(sid)
  let release
  const gate = new Promise((r) => { release = r })
  const llm = {
    stream() {
      return (async function* () {
        await gate // 派发后、finalize 前由测试控制完成时机
        yield REVIEW_TABLE
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
  const config = { advisor: { round1: { provider: "p", model: "m", timeoutMs: 900000 } } }
  const deps = { llm, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } }
  const out = await runAdvisorReview(deps, { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(out.includes("advisor-dsh-1"), "派发时捕获代际")
  // 派发后、done settle 前：语义转换点 bump 代际（eng 交付重置同款）
  bumpAdvisorGeneration(sessionState(sid))
  release()
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed", "评审完成（代际不匹配不改变完成性——原文可读）")
  assert.ok(outcome.output.includes("| 1 | a | b |"), "评审原文可读（不并入但可读）")
  assert.ok(outcome.output.includes("状态代际已变更"), "完成通知注明代际变更")
  assert.ok(outcome.output.includes("不并入"), "注明本轮结果不并入会话状态")
  const st = sessionState(sid)
  assert.equal(st.advisorRound, 0, "finalize 丢弃：轮次不推进（晚到完成不复活已重置状态——D-10）")
  assert.equal(st.lastAdvisorOutput, null, "finalize 丢弃：prior 不写")
  dropSession(sid)
})

test("R5 §7.2 escalate dsh background: run() 内启动子代理，成功簿记恰好一次，句柄只含接续指针", async () => {
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-esc-dsh-bg"
  const st = sessionState(sid)
  let starts = 0
  const subagents = { async start(_kind, opts) {
    starts++
    assert.ok(opts.signal, "子代理接收 job controller signal")
    return { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "done\n\nTouched files: lib/bg.mjs" }] }), dispose: async () => {} }
  } }
  const deps = { ctx: { subagents, get: (s) => s === "jobs" ? jobs : null }, agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }, config: { consultModels: [{ provider: "p", model: "m" }], dshBackgroundTimeoutMs: 1000 }, state: st, signal: undefined }
  const out = await runEscalate(deps, "background work", undefined, false, true)
  assert.ok(out.includes("escalate-dsh-1") && out.includes("job_output"), "返回句柄与接续指针")
  assert.equal(starts, 1, "子代理仅在 run() 内启动一次")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.deepEqual(st.touchedFiles, ["lib/bg.mjs"], "成功分支簿记一次")
  assert.equal(st.mutatedThisRun, true)
  assert.equal(checkInFlightJob(sid, "escalate"), null, "settle 清除单飞槽位")
  dropSession(sid)
})

test("R5 §7.2 escalate dsh background: 失败不簿记；jobs.start 抛错回落同步并告警", async () => {
  const sid = "r5-esc-dsh-bg-fail"
  const st = sessionState(sid)
  const subagents = { async start() { return { result: Promise.resolve({ stopReason: "error", diagnostic: "nope", output: [{ type: "text", text: "partial\n\nTouched files: lib/nope.mjs" }] }), dispose: async () => {} } } }
  const agent = { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }
  const base = { ctx: { subagents }, agent, config: { consultModels: [{ provider: "p", model: "m" }], codexCli: { budgetCapMs: 50 } }, state: st, signal: undefined }
  const throwing = { start() { throw new Error("jobs boom") } }
  const oldWarn = console.warn; const warnings = []; console.warn = (m) => warnings.push(String(m))
  try {
    const out = await runEscalate({ ...base, ctx: { ...base.ctx, get: (s) => s === "jobs" ? throwing : null } }, "fallback", undefined, false, true)
    assert.ok(!out.includes("escalate-dsh-1"), "派发抛错回落同步（无 job 句柄）")
    assert.ok(warnings.some(w => w.includes("派发失败")), "派发抛错响亮告警")
    const sid2 = "r5-esc-dsh-bg-nojobs"
    const st2 = sessionState(sid2)
    const out2 = await runEscalate({ ...base, state: st2, agent: { session: { id: sid2, header: { delegationDepth: 0, cwd: tmpdir() } } }, ctx: { subagents } }, "fallback", undefined, false, true)
    assert.ok(!out2.includes("escalate-dsh-1"), "jobs 缺失回落同步（无 job 句柄）")
    assert.ok(warnings.some(w => w.includes("ctx.jobs 缺失")), "jobs 缺失响亮告警")
    dropSession(sid2)
  } finally { console.warn = oldWarn }
  dropSession(sid)
})

test("R5 §7.2 eng dsh background: 成功簿记一次，cancel 传播到子代理 abort", async () => {
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r5-eng-dsh-bg"
  const st = sessionState(sid); st.engineering = true
  const token = makeEngToken(st)
  let aborted = false
  const subagents = { async start(_kind, opts) {
    opts.signal.addEventListener("abort", () => { aborted = true }, { once: true })
    return { result: new Promise((resolve) => setTimeout(() => resolve({ stopReason: "completed", output: [{ type: "text", text: "eng done\n\nTouched files: lib/eng-bg.mjs" }] }), 20)), dispose: async () => {} }
  } }
  const deps = { ctx: { subagents, get: (s) => s === "jobs" ? jobs : null }, agent: { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }, config: { dshBackgroundTimeoutMs: 1000 }, signal: undefined }
  const out = await runEngCoder(deps, { task: "eng background", designToken: token, docs: [], background: true })
  assert.ok(out.includes("eng-dsh-1") && out.includes("job_output"), "后台句柄")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "completed")
  assert.ok(st.touchedFiles.includes("lib/eng-bg.mjs"), "成功交付簿记")
  assert.equal(checkInFlightJob(sid, "eng"), null)
  dropSession(sid)

  const { jobs: jobs2, specs: specs2 } = fakeJobsFactory()
  const sid2 = "r5-eng-dsh-cancel"; const st2 = sessionState(sid2); st2.engineering = true
  const token2 = makeEngToken(st2)
  const subagents2 = { async start(_kind, opts) {
    return { result: new Promise((resolve, reject) => opts.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })), dispose: async () => {} }
  } }
  const deps2 = { ctx: { subagents: subagents2, get: (s) => s === "jobs" ? jobs2 : null }, agent: { session: { id: sid2, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }, config: { dshBackgroundTimeoutMs: 1000 }, signal: undefined }
  const out2 = await runEngCoder(deps2, { task: "cancel", designToken: token2, docs: [], background: true })
  assert.ok(out2.includes("eng-dsh-1")); specs2[0].hooks.cancel("test cancel"); const outcome2 = await specs2[0].hooks.done
  assert.equal(outcome2.status, "failed"); assert.equal(aborted, true, "job cancel 传播子代理 abort")
  dropSession(sid2)
})

// ————————————— R6（D-26 维护轮，设计 §12）：纯断言轮——十项实现已在库（WIP 9318826，经架构师逐项审计），本节只钉死行为 —————————————
// ②（engineeringToggle 移除未用参数 configDefaultEngineering + index.mjs 两调用方同步）为编译级
// 核验：node --check 三文件 + 全量测试绿即核销（纯无行为重构，无断言面）。

test("R6 ①(D-26): eng codex 分支告警留痕——globals warnings 逐条 warn + defaultTimeoutMs/idleTimeoutMs 本地回落 warn；escalate 同款点一并断言", async () => {
  // eng codex 同步路径（jobs 缺失 → 降级同步，交付文本带 warnPrefix——四路告警全部可见）
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "r6-eng-warn-t1" }) + "\n" }], exitCode: 0, outText: "implemented\n\nTouched files: none" }
  })
  const sid = "r6-eng-warn"
  const st = sessionState(sid)
  st.engineering = true
  const token = makeEngToken(st)
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: {} }
  const config = {
    engCoderEffort: "off", // off → codex resolver 零目录依赖（R1：off 不查 catalog——spawn 计数确定）
    codexCli: {
      engCoderRunner: "codex-cli", model: "m-r6", executable: process.execPath,
      proxyMode: "sideway", defaultTimeoutMs: 5, idleTimeoutMs: 5, // 非法值：globals 两处 + eng 本地两处
    },
  }
  const r = await captureWarn(() => runEngCoder(
    {
      ctx: { get: () => null, subagents: { start: () => { throw new Error("dsh must not run for codex backend") } } },
      agent, config, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {},
    },
    { task: "implement x", designToken: token, docs: [] },
  ))
  assert.ok(r.value.includes("eng_coder delivery (codex-cli)"), "同步降级路径照常交付（1800000 → 钳制 540000）")
  assert.ok(r.value.includes("[thincoder-suite] warning: codexCli.proxyMode 忽略"), "globals warnings 逐条 warn()（proxyMode）")
  assert.ok(r.value.includes("[thincoder-suite] warning: codexCli.defaultTimeoutMs 忽略"), "globals warnings 逐条 warn()（defaultTimeoutMs）")
  assert.ok(r.value.includes("codexCli.defaultTimeoutMs 非法，回落 1800000ms"), "本地校验回落补 warn（defaultTimeoutMs，eng 回落档 1800000）")
  assert.ok(r.value.includes("codexCli.idleTimeoutMs 非法，回落 300000ms"), "本地校验回落补 warn（idleTimeoutMs——globals 不校验此字段，此行只能来自本地 warn）")
  assert.ok(r.warnings.some((w) => w.includes("codexCli.defaultTimeoutMs 非法，回落 1800000ms")), "console.warn 留痕（warn 通道）")
  dropSession(sid)

  // escalate 同款点（runEscalateCodex 预算链）：本地回落告警（600000 档）+ globals 捕获告警均入术后报告
  const spawnE = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "ok\n\nTouched files: none" }
  })
  const cfgE = {
    consultModels: [{ runner: { kind: "codex-cli", model: "m-esc-r6" } }], // 行不带 effort → codex 目录零触发
    codexCli: { executable: process.execPath, defaultTimeoutMs: 1, idleTimeoutMs: 7 },
  }
  const sidE = "r6-esc-warn"
  const outE = await runEscalate(makeEscDeps(sidE, spawnE, cfgE), "x", undefined)
  assert.ok(outE.includes("post-op report"), "escalate 同步路径照常交付（600000 → 钳制 540000）")
  assert.ok(outE.includes("codexCli.defaultTimeoutMs 非法，回落 600000ms"), "escalate 同款：defaultTimeoutMs 本地回落告警（600000 档）")
  assert.ok(outE.includes("codexCli.idleTimeoutMs 非法，回落 300000ms"), "escalate 同款：idleTimeoutMs 本地回落告警")
  assert.ok(outE.includes("codexCli.defaultTimeoutMs 忽略"), "escalate 同款：resolveCodexCliGlobals 捕获告警并入报告")
  dropSession(sidE)
})

test("R6 ③⑤(D-26): eng 单飞拒绝返回带 warnPrefix 前缀 + F10 盘回填两态文案（已签发未传 vs 从未签发）", async () => {
  // ③：>cap 首次派发占位 eng 槽位 → 二次调用任务文本命中 F13 漂移正则（stages 缺省）先积 warn
  //    → 入口单飞拒绝 = warnPrefix() + 拒绝文本（前缀先于 Error 可见）
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args) : { events: [], exitCode: 0, outText: "implemented\n\nTouched files: none" })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r6-eng-sf-prefix"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath }, engCoderEffort: "off" })
  const out1 = await runEngCoder(deps, { task: "implement a (long)", designToken: token, docs: [] })
  assert.ok(out1.includes("eng-codex-1"), ">cap 首次派发（占位 eng 槽位）")
  const out2 = await runEngCoder(deps, { task: "tweak stage 2 logic while in flight", designToken: token, docs: [] })
  assert.ok(out2.startsWith("[thincoder-suite] warning:"), "③：单飞拒绝返回补 warnPrefix 前缀（不再裸 Error 开头）")
  assert.ok(out2.includes("task text mentions stages"), "前缀内容 = 入口检查前积累的 F13 漂移告警")
  assert.ok(out2.includes("Error") && out2.includes("eng-codex-1"), "拒绝主体保留（Error + 在飞 job id）")
  assert.ok(out2.includes("未派发"), "明确本次未派发")
  await specs[0].hooks.done // settle 清槽位（测试隔离）
  dropSession(sid)

  // ⑤：F10 盘回填两态——同一 store 内：sidA 有签发记录但未传 token；sidB 无任何记录
  // D-30 批 2 评审 #3：工程模式 OFF 检查已前置到 token 块之前（被拒调用零副作用），故本用例
  // 的目标（F10 回填两态文案）须在 eng ON 会话里断言——否则先撞「engineering mode is OFF」。
  const home = mkdtempSync(join(tmpdir(), "r6-f10-"))
  try {
    assert.ok(saveTokenRecord("r6-f10-issued", { token: "tok-issued-once", expiresAt: Date.now() + 3600_000 }, home), "预置盘上签发记录")
    const mkDeps = (sidX) => ({
      ctx: {}, agent: { session: { id: sidX, header: { cwd: tmpdir() } }, options: {} },
      config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: home,
      spawn: () => { throw new Error("must not spawn before token gate") }, platform: "linux", env: {},
    })
    sessionState("r6-f10-issued").engineering = true // 新语义：eng 检查前置，需 ON 才到 token 分支
    const outA = await runEngCoder(mkDeps("r6-f10-issued"), { task: "implement without passing token" }) // designToken 缺省未传
    assert.ok(outA.includes("本会话已签发但本次未传"), "⑤：盘有记录+未传 →「本会话已签发但本次未传」: " + outA.slice(0, 100))
    assert.ok(!outA.includes("从未签发"), "两态区分：不误落「从未签发」")
    dropSession("r6-f10-issued")
    sessionState("r6-f10-never").engineering = true
    const outB = await runEngCoder(mkDeps("r6-f10-never"), { task: "implement with no record at all" })
    assert.ok(outB.includes("从未签发"), "⑤：无盘记录 →「从未签发」")
    assert.ok(!outB.includes("本会话已签发"), "两态区分：不误落「已签发未传」")
    dropSession("r6-f10-never")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("R6 ④⑥⑦(D-26): 空输出归类统一（交付行共用 (empty report) 显式标记）+ eng dsh 同步簿记等价 + deliverBookkeeping 四路单一实现（源级断言）", async () => {
  const src = readFileSync(new URL("../lib/eng.mjs", import.meta.url), "utf8")
  // ⑥⑦ 单一实现（grep 级——deliverBookkeeping 未导出，spy 不可行，择简）：
  // 定义 1 处 + 四路调用 4 处；内联簿记残留清零（轮次重置/代际 bump 写点唯一）
  assert.equal((src.match(/deliverBookkeeping\(/g) ?? []).length, 5, "⑥⑦：deliverBookkeeping 定义 1 处 + 四路调用（codex/dsh × 同步/后台）")
  assert.equal((src.match(/state\.advisorRound = 0/g) ?? []).length, 1, "⑥⑦：轮次重置只在 deliverBookkeeping 内（dsh 同步内联簿记已替换）")
  assert.equal((src.match(/bumpAdvisorGeneration\(state\)/g) ?? []).length, 1, "⑥⑦：代际 bump 写点唯一")
  // ④ 两路径一致（源级）：codex deliveryText 与 dsh 交付行（后台+同步）共用空文本显式标记表达式；
  // 分类只看 env.ok（不再叠加 env.text 条件）。注：adapter 唯一 OK 出口要求 text !== ""，
  // eng codex ok+空文本是防御性一致分支——行为面经下方 dsh 空输出路径断言（两路径同表达式）。
  assert.equal((src.match(/\(outputText \|\| "\(empty report\)"\)/g) ?? []).length, 3, "④：三处交付行共用 (outputText || \"(empty report)\") 表达式（codex deliveryText + dsh 后台 + dsh 同步）")
  assert.ok(!src.includes("env.ok && env.text"), "④：成功分类不再叠加 env.text 条件（空 OK 不静默翻转失败类别）")
  assert.equal((src.match(/if \(env\.ok\) \{/g) ?? []).length, 2, "④：codex 两路（jobs done 回调 + 同步）均按 env.ok 单条件分类")

  // 行为面 ⑥⑦（dsh 同步成功路径簿记等价——既有断言核销 + 本块显式复核全套字段）：
  const subOf = (output) => ({
    async start() {
      return { result: Promise.resolve({ stopReason: "completed", output }), dispose: async () => {} }
    },
  })
  const sid = "r6-dsh-sync-book"
  const st = sessionState(sid)
  st.engineering = true
  st.advisorRound = 2
  st.lastAdvisorOutput = "prior review"
  const gen0 = advisorGenerationOf(st)
  const token = makeEngToken(st)
  const out = await runEngCoder(
    { ctx: { subagents: subOf([{ type: "text", text: "implemented\n\nTouched files: src/r6.ts" }]) }, agent: { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "model-a" } }, config: {}, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement x", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder delivery:") && out.includes("implemented"), "dsh 同步交付")
  const st2 = sessionState(sid)
  assert.equal(st2.advisorRound, 0, "簿记等价：轮次重置（deliverBookkeeping 单一实现路径）")
  assert.equal(st2.lastAdvisorOutput, null, "簿记等价：prior 清除")
  assert.ok(st2.touchedFiles.includes("src/r6.ts"), "簿记等价：touched 合并")
  assert.equal(st2.mutatedThisRun, true, "簿记等价：mutated 置位")
  assert.ok(advisorGenerationOf(st2) > gen0, "簿记等价：代际 bump（D-10 语义转换点）")
  dropSession(sid)

  // 行为面 ④（dsh 空输出 → 仍按交付归类 + "(empty report)" 显式标记 + completed 簿记照常）：
  const sid2 = "r6-dsh-sync-empty"
  const st3 = sessionState(sid2)
  st3.engineering = true
  st3.advisorRound = 1
  const token2 = makeEngToken(st3)
  const out2 = await runEngCoder(
    { ctx: { subagents: subOf([]) }, agent: { session: { id: sid2, header: { cwd: tmpdir() } }, options: { provider: "acme", model: "model-a" } }, config: {}, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement y (empty delivery)", designToken: token2, docs: [] },
  )
  assert.ok(out2.includes("eng_coder delivery:"), "空输出仍按交付归类（不翻转为失败类别）")
  assert.ok(out2.includes("(empty report)"), "④：空文本显式 (empty report) 标记（与 codex deliveryText 同表达式）")
  assert.ok(!out2.includes("eng_coder ended"), "不落失败类别文案")
  const st4 = sessionState(sid2)
  assert.equal(st4.advisorRound, 0, "completed 簿记照常（轮次重置）")
  assert.equal(st4.mutatedThisRun, true, "completed 簿记照常（mutated 置位）")
  dropSession(sid2)
})

test("R6 ⑧⑨⑩(D-26): dsh 后台兜底超时信封 ABORTED 触发回滚指引（eng+escalate）+ escalate codex jobs reject 后 codexThreads 无残留 + 兜底文案句读统一", async () => {
  // ⑧+⑩（eng）：挂起子代理超兜底截止 → failed 信封含回滚指引（ABORTED 码）+ 统一句读（abort—— 后空格）
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r6-eng-backstop"
  const st = sessionState(sid)
  st.engineering = true
  st.advisorRound = 2
  const token = makeEngToken(st)
  const subagents = {
    async start(_kind, opts) {
      return {
        result: new Promise((resolve) => {
          opts.signal.addEventListener("abort", () => resolve({
            stopReason: "aborted",
            output: [{ type: "text", text: "halfway\n\nTouched files: src/r6-half.ts" }],
            diagnostic: "deadline abort",
          }), { once: true })
        }),
        dispose: async () => {},
      }
    },
  }
  const deps = { ctx: { subagents, get: (s) => s === "jobs" ? jobs : null }, agent: { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }, config: { dshBackgroundTimeoutMs: 150 }, signal: undefined }
  const out = await runEngCoder(deps, { task: "long background work", designToken: token, docs: [], background: true })
  assert.ok(out.includes("eng-dsh-1"), "后台句柄先返回")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "failed", "兜底截止 → failed（partial 保留）")
  assert.ok(outcome.output.includes("超兜底截止"), "超时信封注明兜底截止")
  assert.ok(outcome.output.includes("半途写入可能残留") && outcome.output.includes("git 回滚"), "⑧：ABORTED 码触发 codexFailureAdvisory 回滚指引")
  assert.ok(outcome.output.includes("src/r6-half.ts"), "partial 内 Touched 行 advisory 解析（可见不并入）")
  assert.ok(outcome.output.includes("abort—— Partial output"), "⑩：兜底文案句读统一（abort—— 后空格）")
  assert.equal(sessionState(sid).advisorRound, 2, "失败不簿记（D-20 保持——轮次不重置）")
  dropSession(sid)

  // ⑧（escalate 同款）：dsh background 兜底信封同带 ABORTED 回滚指引（与 codex TIMEOUT 对称）
  const { jobs: jobs2, specs: specs2 } = fakeJobsFactory()
  const sid2 = "r6-esc-backstop"
  const subagents2 = {
    async start(_kind, opts) {
      return {
        result: new Promise((resolve) => opts.signal.addEventListener("abort", () => resolve({
          stopReason: "aborted",
          output: [{ type: "text", text: "partial work" }],
        }), { once: true })),
        dispose: async () => {},
      }
    },
  }
  const deps2 = { ctx: { subagents: subagents2, get: (s) => s === "jobs" ? jobs2 : null }, agent: { session: { id: sid2, header: { delegationDepth: 0, cwd: tmpdir() } } }, config: { consultModels: [{ provider: "p", model: "m" }], dshBackgroundTimeoutMs: 150 }, state: sessionState(sid2), signal: undefined }
  const out2 = await runEscalate(deps2, "background work", undefined, false, true)
  assert.ok(out2.includes("escalate-dsh-1"), "escalate 后台句柄先返回")
  const outcome2 = await specs2[0].hooks.done
  assert.equal(outcome2.status, "failed", "兜底截止 → failed")
  assert.ok(outcome2.output.includes("半途写入可能残留") && outcome2.output.includes("git 回滚"), "escalate 同款：ABORTED 码触发回滚指引")
  dropSession(sid2)

  // ⑨：escalate codex jobs reject 分支 codexThreads.delete（与失败分支对称）——
  //   成功交付保存线程 → followup 派发后 runCodexTask reject（poisoned config 的 maxConcurrent
  //   getter 第 2 次被 resolveCodexCliGlobals 访问时抛错：第 1 次 = runCodexTask 准入 :527，
  //   第 2 次 = runCodexTaskInner :550）→ done 链 reject 分支清线程 → 再次 followup 报「无线程」
  const spawn9 = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "r6-esc-tid" }) + "\n" }], exitCode: 0, outText: "first delivery\n\nTouched files: none" }
  })
  const cfg9 = { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const sid9 = "r6-esc-reject-cleanup"
  const { jobs: jobs9, specs: specs9 } = fakeJobsFactory()
  const deps9 = makeEscDeps(sid9, spawn9, cfg9)
  deps9.ctx = { get: (svc) => (svc === "jobs" ? jobs9 : null) }
  const out9a = await runEscalate(deps9, "first task", undefined)
  assert.ok(out9a.includes("escalate-codex-1"), "首次 >cap 派发")
  const oc9a = await specs9[0].hooks.done
  assert.equal(oc9a.status, "completed", "首次交付成功 → codexThreads.set(threadId)")
  let mcAccess = 0
  const poisoned = {
    consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a", timeoutMs: 900000 } }],
    codexCli: {
      executable: process.execPath,
      get maxConcurrent() { if (++mcAccess >= 2) throw new Error("boom-r6"); return undefined },
    },
  }
  const { jobs: jobs9b, specs: specs9b } = fakeJobsFactory()
  const deps9b = makeEscDeps(sid9, spawn9, poisoned)
  deps9b.ctx = { get: (svc) => (svc === "jobs" ? jobs9b : null) }
  const out9b = await runEscalate(deps9b, "followup that rejects", undefined, true)
  assert.ok(out9b.includes("escalate-codex-1"), "followup 续轮派发（resume）")
  const oc9b = await specs9b[0].hooks.done
  assert.equal(oc9b.status, "failed", "runCodexTask reject → failed settle")
  assert.ok(oc9b.output.includes("error: boom-r6"), "reject 分支诊断可见: " + oc9b.output.slice(0, 120))
  assert.equal(checkInFlightJob(sid9, "escalate"), null, "reject settle 清单飞槽位")
  const deps9c = makeEscDeps(sid9, spawn9, cfg9) // ctx: {} — followup 无线程时在入口即拒，零 spawn
  const out9c = await runEscalate(deps9c, "followup after reject", undefined, true)
  assert.ok(out9c.includes("no codex escalate thread"), "⑨：reject 分支 codexThreads.delete——线程无残留（与失败分支对称）")
  dropSession(sid9)
})

// ————————————— R6 code review 微修轮：① reject-race 兜底回滚指引 + ③ 派发返回并入配置告警 —————————————

test("R6 微修①: eng dsh 后台兜底 reject-race 分支（catch 内 if(timedOut)）同带 ABORTED 回滚指引——与 resolve-race 对称", async () => {
  const { jobs, specs } = fakeJobsFactory()
  const sid = "r6-eng-backstop-reject"
  const st = sessionState(sid)
  st.engineering = true
  st.advisorRound = 2
  const token = makeEngToken(st)
  // 假 subagents reject 形态：abort 信号触发 result promise reject（await sub.result 抛出 → 落
  // catch 分支；timedOut=true → 兜底信封。e.name=AbortError 也不走 aborted 分支——timedOut 检查在前）
  const subagents = {
    async start(_kind, opts) {
      return {
        result: new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => {
            const e = new Error("subagent aborted by backstop deadline")
            e.name = "AbortError"
            reject(e)
          }, { once: true })
        }),
        dispose: async () => {},
      }
    },
  }
  const deps = { ctx: { subagents, get: (s) => s === "jobs" ? jobs : null }, agent: { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "p", model: "m" } }, config: { dshBackgroundTimeoutMs: 150 }, signal: undefined }
  const out = await runEngCoder(deps, { task: "long background work (reject form)", designToken: token, docs: [], background: true })
  assert.ok(out.includes("eng-dsh-1"), "后台句柄先返回")
  const outcome = await specs[0].hooks.done
  assert.equal(outcome.status, "failed", "兜底截止 → failed（reject 形态同样 settle）")
  assert.ok(outcome.output.includes("超兜底截止"), "超时信封注明兜底截止")
  assert.ok(outcome.output.includes("半途写入可能残留") && outcome.output.includes("git 回滚"),
    '①：reject-race 分支输出含回滚指引（codexFailureAdvisory({ text: "", code: "ABORTED" })——escalate timeoutEnvelope("") 先例）')
  assert.ok(!outcome.output.includes("Partial output") && !outcome.output.includes("Touched 行"), "catch 作用域无 outputText → 空串形态（无 partial 块、无 Touched advisory 行）")
  assert.ok(!outcome.output.includes("eng_coder aborted."), "timedOut 检查先于 AbortError 分支（reject-race 语义）")
  assert.equal(sessionState(sid).advisorRound, 2, "失败不簿记（D-20 保持——轮次不重置）")
  dropSession(sid)
})

test("R6 微修③: eng/escalate codex jobs 派发返回并入配置告警（warnPrefix 先于句柄文本——对齐 advisor R4 收尾 #4 先例）", async () => {
  // eng：非法 codexCli.defaultTimeoutMs → 警告即时并入派发返回（此前只在 job 完成文本可见）
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "eng-wp-r6" }) + "\n" }], exitCode: 0, outText: "done\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "eng-dispatch-warn-r6"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "codex-model-a", executable: process.execPath, defaultTimeoutMs: "bad" } })
  const out = await runEngCoder(deps, { task: "implement x", designToken: token, docs: [] })
  assert.ok(out.includes("eng-codex-1"), "派发正常（非法 defaultTimeoutMs 回落 1800000ms > cap）")
  assert.ok(out.includes("[thincoder-suite] warning: codexCli.defaultTimeoutMs 非法，回落 1800000ms"), "③：配置告警并入派发文本")
  assert.ok(out.indexOf("codexCli.defaultTimeoutMs 非法") < out.indexOf("eng-codex-1"), "告警先于句柄文本（warnPrefix() + codexJobsDispatchReply）")
  await specs[0].hooks.done // settle（交付簿记完成）后再清理会话
  dropSession(sid)

  // escalate 同款：timeoutWarnings（defaultTimeoutMs 非法）+ >cap → 派发返回带告警前缀
  const spawn2 = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [{ data: JSON.stringify({ type: "thread.started", thread_id: "esc-wp-r6" }) + "\n" }], exitCode: 0, outText: "done\n\nTouched files: none" }
  })
  const { jobs: jobs2, specs: specs2 } = fakeJobsFactory()
  const sid2 = "esc-dispatch-warn-r6"
  const deps2 = makeEscDeps(sid2, spawn2, { consultModels: [{ runner: { kind: "codex-cli", model: "codex-model-a" } }], codexCli: { executable: process.execPath, defaultTimeoutMs: "bad" } })
  deps2.ctx = { get: (svc) => (svc === "jobs" ? jobs2 : null) }
  const out2 = await runEscalate(deps2, "fix the bug", undefined)
  assert.ok(out2.includes("escalate-codex-1"), "派发正常（非法 defaultTimeoutMs 回落 600000ms > cap）")
  assert.ok(out2.includes("[thincoder-suite] codexCli.defaultTimeoutMs 非法，回落 600000ms"), "③：配置告警并入派发文本")
  assert.ok(out2.indexOf("codexCli.defaultTimeoutMs 非法") < out2.indexOf("escalate-codex-1"), "告警先于句柄文本（warnPrefix + codexJobsDispatchReply）")
  await specs2[0].hooks.done // settle 后清理
  dropSession(sid2)
})

// ═════════════════════ D-30 验收标准 ACS：token 单元类（设计档 §5 AC-1/2/3/4/5/7/23/25/26） ═════════════════════
// 本块按设计档 §5 逐条落地**专用**用例。硬约束：不得用同义反复/恒真断言（AC-5 尤为明确——
// 禁用「从提示词正则抠出 code 再原样回显」形式，改用固定 uuid 直接对拍 sha256(uuid).slice(0,8)）。

test("AC-1: generateDesignToken yields exactly two segments — segment 0 is a UUID, segment 1 an integer expiresAt > now", () => {
  const before = Date.now()
  const t = generateDesignToken({})
  const parts = t.split(":")
  assert.equal(parts.length, 2, "恰好两段（HMAC 签名腿已随密钥链删除）: " + t)
  assert.match(parts[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "第 0 段是 UUID")
  assert.match(parts[1], /^\d+$/, "第 1 段是纯整数")
  const exp = Number(parts[1])
  assert.ok(Number.isFinite(exp) && exp > before, "第 1 段 = expiresAt > now")
  assert.equal(tokenExpiryMs(t), exp, "tokenExpiryMs 读同一段（解析路径单点）")
  assert.equal(validateDesignToken(t), true, "新铸令牌通过校验")
  assert.equal(designTokenShape(t), "two-part")
})

test("AC-2: validateDesignToken negatives (legacy 3-part / 1-part / empty / non-string / non-numeric exp / past exp) and positives (fresh, boundary now+50)", () => {
  const now = Date.now()
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
  // —— 负例 ——
  const legacy = uuid + ":" + (now + 60_000) + ":deadbeefdeadbeef"
  assert.equal(validateDesignToken(legacy), false, "3 段旧格式（形状合法）不通过")
  assert.equal(designTokenShape(legacy), "legacy", "形状检测可区分旧格式")
  assert.equal(designTokenFailureReason(legacy), "legacy", "失败原因 = legacy（FR-T9 文案依据）")
  assert.equal(validateDesignToken(uuid), false, "1 段不通过")
  assert.equal(designTokenShape(uuid), "malformed")
  assert.equal(validateDesignToken(""), false, "空串不通过")
  assert.equal(validateDesignToken(null), false, "非字符串 null 不通过")
  assert.equal(validateDesignToken(12345), false, "非字符串 number 不通过")
  assert.equal(designTokenFailureReason(null), "missing")
  assert.equal(validateDesignToken(uuid + ":abc"), false, "expiresAt 非数不通过")
  assert.equal(designTokenFailureReason(uuid + ":abc"), "malformed")
  assert.equal(validateDesignToken(uuid + ":" + (now - 1000)), false, "expiresAt < now 不通过")
  assert.equal(designTokenFailureReason(uuid + ":" + (now - 1000)), "expired")
  // —— 正例 ——
  assert.equal(validateDesignToken(generateDesignToken({})), true, "新铸通过")
  assert.equal(validateDesignToken(uuid + ":" + (now + 50)), true, "边界 now+50 仍未过期 → 通过")
  assert.equal(designTokenFailureReason(uuid + ":" + (now + 50)), null)
  assert.equal(validateDesignToken(uuid + ":" + (now - 50)), false, "边界 now-50 已过期 → 不通过（判定为严格 >）")
  assert.equal(designTokenFailureReason(uuid + ":" + (now - 50)), "expired")
})

test("AC-3: static — advisor.mjs has no secret-chain remnant and the export surface drops all six D-25 names", async () => {
  const src = readFileSync(new URL("../lib/advisor.mjs", import.meta.url), "utf8")
  for (const needle of ["createHmac", "TOKEN_SECRET", "token-secret", "randomBytes", "thincoder-default-secret"]) {
    assert.equal(src.includes(needle), false, "advisor.mjs 不得再出现 " + needle)
  }
  const mod = await import("../lib/advisor.mjs")
  // 密钥链 6 名（D-25 的 3 个导出 + 3 个模块级常量/函数）：导出面一个都不得残留
  const SECRET_CHAIN_NAMES = [
    "resolveTokenSecretPath", "resolveTokenSecret", "resetTokenSecretCacheForTests",
    "tokenSecret", "TOKEN_SECRET_FALLBACK", "TOKEN_SECRET_FILE",
  ]
  for (const n of SECRET_CHAIN_NAMES) assert.equal(n in mod, false, "导出面不得残留密钥链名 " + n)
  // [负] 防「顺手删过头」：两段式铸造面与无状态审批码派生面必须仍在
  assert.equal(typeof mod.generateDesignToken, "function")
  assert.equal(typeof mod.designApprovalCode, "function")
  assert.equal(typeof mod.validateDesignToken, "function")
})

test("AC-4: no DSH_HOME + no env → mint + validate succeed with NO warning; setting THINCODER_TOKEN_SECRET changes nothing", async () => {
  const savedHome = process.env.DSH_HOME
  const savedSecret = process.env.THINCODER_TOKEN_SECRET
  try {
    delete process.env.DSH_HOME // 无 DSH_HOME（旧 D-25 链会在此响亮告警并回落公开默认密钥）
    delete process.env.THINCODER_TOKEN_SECRET
    const r1 = await captureWarn(() => {
      const t = generateDesignToken({})
      assert.equal(validateDesignToken(t), true, "无 env 无 DSH_HOME 仍铸造+校验成功")
      return t
    })
    assert.equal(r1.warnings.length, 0, "无告警（D-25 的「公开默认密钥不可信」已随密钥链消失）: " + r1.warnings.join("|"))
    assert.equal(r1.value.split(":").length, 2)
    // [负] 设 env 不改变任何行为（密钥链已删除，该变量是 no-op）
    process.env.THINCODER_TOKEN_SECRET = "ops-secret-that-must-not-matter"
    const r2 = await captureWarn(() => {
      const t = generateDesignToken({})
      assert.equal(validateDesignToken(t), true, "设 env 后仍铸造+校验成功")
      assert.equal(t.split(":").length, 2, "设 env 不改变形状")
      assert.equal(designApprovalCode(t), sha256Hex(t.split(":")[0]).slice(0, 8),
        "设 env 不改变审批码（无状态派生，无密钥参与）")
      return t
    })
    assert.equal(r2.warnings.length, 0, "设 env 也不产生任何告警（advisor 路径已彻底无密钥面）")
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome
    if (savedSecret === undefined) delete process.env.THINCODER_TOKEN_SECRET; else process.env.THINCODER_TOKEN_SECRET = savedSecret
  }
})

test("AC-5: designApprovalCode(t) === sha256(fixed uuid).slice(0,8) — direct对拍, NOT a prompt-echo tautology", () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e" // 固定 uuid：期望值与派生实现无关，可独立算出
  const other = "11111111-2222-3333-4444-555555555555"
  const now = Date.now()
  const t1 = uuid + ":" + (now + 3600_000)
  const t2 = uuid + ":" + (now + 7200_000) // 同 uuid、不同到期时间
  // 直接对拍：若派生被改成常量串（审计 D3 指出的恒真写法正是为掩盖这种退化），本条必红。
  assert.equal(designApprovalCode(t1), sha256Hex(uuid).slice(0, 8), "固定 uuid → 直接对拍 sha256(uuid).slice(0,8)")
  assert.equal(designApprovalCode(t1), "c812e1ed", "硬编码期望码（= sha256('" + uuid + "')[:8]，与实现无关）")
  assert.match(designApprovalCode(t1), /^[0-9a-f]{8}$/, "8 位十六进制")
  assert.equal(designApprovalCode(t2), designApprovalCode(t1), "同 token（同 uuid）→ 同码；与第 1 段无关")
  assert.notEqual(designApprovalCode(other + ":" + (now + 3600_000)), designApprovalCode(t1), "不同 uuid → 不同码")
  // 防「常量替换」退化：两个不同 uuid 的码不得相等（上一条已锁），且非空串
  assert.notEqual(designApprovalCode(t1), "")
})

test("AC-7: generateDesignToken({}) TTL ≈ 7d (TOKEN_TTL_DEFAULT_MS); an explicit engTokenTtlMs still wins; renewal shares the same TTL point", () => {
  const t0 = Date.now()
  const t = generateDesignToken({})
  const delta = tokenExpiryMs(t) - t0
  assert.equal(TOKEN_TTL_DEFAULT_MS, 7 * 24 * 3600 * 1000, "缺省 TTL = 7d（FR-T4）")
  assert.ok(Math.abs(delta - TOKEN_TTL_DEFAULT_MS) < 5000, "expiresAt - now ≈ 7d（实测 " + delta + "ms）")
  // 显式 engTokenTtlMs 仍优先（D-29 覆盖链不回退）
  const tBase = generateDesignToken({ engTokenTtlMs: 3600000 })
  assert.ok(Math.abs((tokenExpiryMs(tBase) - Date.now()) - 3600000) < 5000, "显式 engTokenTtlMs 优先")
  // 非法值回落缺省（resolveEngTokenTtlMs 非有限/非正 → 7d）
  for (const bad of [0, -1, "7d", NaN, null, Infinity]) {
    const tb = generateDesignToken({ engTokenTtlMs: bad })
    assert.ok(Math.abs((tokenExpiryMs(tb) - Date.now()) - TOKEN_TTL_DEFAULT_MS) < 5000,
      "非法 engTokenTtlMs=" + String(bad) + " → 回落 7d")
  }
  // 续期与铸造共用 TTL 单点（FR-T5/FR-T4）：uuid 不变、expiresAt 按同一 resolveEngTokenTtlMs 顺延
  const renewed = renewDesignToken(t, { engTokenTtlMs: 3600000 })
  assert.equal(renewed.split(":")[0], t.split(":")[0], "续期保持同一 uuid")
  assert.ok(Math.abs((tokenExpiryMs(renewed) - Date.now()) - 3600000) < 5000, "续期用显式 TTL")
  assert.ok(Math.abs((tokenExpiryMs(renewDesignToken(t, {})) - Date.now()) - TOKEN_TTL_DEFAULT_MS) < 5000, "续期缺省用 7d")
})

test("AC-23: normalizeDocPath collapses relative/absolute/backslash spellings; case differences stay DISTINCT (pinned rule)", () => {
  const abs = normalizeDocPath("docs/a.md")
  assert.equal(abs, resolve("docs", "a.md").replace(/\\/g, "/"), "相对路径 → 绝对 + 正斜杠")
  assert.equal(normalizeDocPath(resolve("docs", "a.md").replace(/\\/g, "/")), abs, "绝对路径与相对路径同形")
  assert.equal(normalizeDocPath("docs\\a.md"), abs, "反斜杠与正斜杠混用 → 同形")
  assert.equal(normalizeDocPath("./docs/../docs/a.md"), abs, "中间 .. 归一 → 同形")
  assert.notEqual(normalizeDocPath("docs/A.md"), abs, "大小写**不**折叠 → 视为不同条目（§3 钉死规则）")
  // 指纹层同款（续期判定与用例共用 doc-hash.mjs 单点实现）
  const root = mkdtempSync(join(tmpdir(), "thincoder-ac23-"))
  try {
    mkdirSync(join(root, "docs"), { recursive: true })
    writeFileSync(join(root, "docs", "a.md"), "hello")
    const p = join(root, "docs", "a.md")
    const h1 = computeDocHash([p])
    const h2 = computeDocHash([p.replace(/\\/g, "/")])                     // 正斜杠书写
    const h3 = computeDocHash([root + "/docs/../docs/a.md"])              // 原始串：混用分隔符 + 中间 ..
    assert.equal(h1.ok, true, "同一文件可读 → ok")
    assert.equal(h1.hash, h2.hash, "正/反斜杠书写 → 同一指纹")
    assert.equal(h1.hash, h3.hash, "含 .. 的书写 → 同一指纹")
    const hu = computeDocHash([join(root, "docs", "A.md")])
    assert.ok(!(hu.ok && h1.ok && hu.hash === h1.hash), "大小写不同不得产生同一指纹（Windows 上文件仍可读，但路径已参与摘要）")
  } finally { try { rmSync(root, { recursive: true, force: true }) } catch { /* 已清理 */ } }
})

test("AC-25: expiryLabel switches to a DATE once the remaining TTL exceeds 24h (unit level, advisor.mjs)", () => {
  const now = Date.now()
  const day = 24 * 3600 * 1000
  assert.match(expiryLabel("u:" + (now + 7 * day), now), /^\d{4}-\d{2}-\d{2}$/, "7d → 日期而非钟点")
  assert.match(expiryLabel("u:" + (now + day + 60_000), now), /^\d{4}-\d{2}-\d{2}$/, ">24h → 日期（阈值外）")
  assert.match(expiryLabel("u:" + (now + day - 60_000), now), /^\d{2}:\d{2}$/, "≤24h → HH:MM（阈值内，保持既有语义）")
  assert.equal(expiryLabel("u:garbage", now), "??", "畸形段 → ??")
  assert.equal(expiryLabel("u:", now), "??")
})

test("AC-26: THINCODER_TOKEN_SECRET set → exactly ONE deprecation warning; unset/blank → silent; repeat call silent", async () => {
  resetDeprecatedSecretEnvWarnForTests()
  try {
    const r0 = await captureWarn(() => warnDeprecatedTokenSecretEnvOnce({}))
    assert.equal(r0.value, false, "未设 → 不打印")
    assert.equal(r0.warnings.length, 0, "未设 → 无告警")
    const rb = await captureWarn(() => warnDeprecatedTokenSecretEnvOnce({ THINCODER_TOKEN_SECRET: "   " }))
    assert.equal(rb.value, false, "空白串视为未设")
    assert.equal(rb.warnings.length, 0)
    const r1 = await captureWarn(() => warnDeprecatedTokenSecretEnvOnce({ THINCODER_TOKEN_SECRET: "ops-secret" }))
    assert.equal(r1.value, true, "设值 → 打印弃用告警")
    assert.ok(r1.warnings.some((w) => w.includes("THINCODER_TOKEN_SECRET") && w.includes("NO effect")),
      "告警说清该 env 已无任何作用: " + r1.warnings.join("|"))
    // 进程级 once：fiber 重建 / 重复 apply 不重复刷屏
    const r2 = await captureWarn(() => warnDeprecatedTokenSecretEnvOnce({ THINCODER_TOKEN_SECRET: "ops-secret" }))
    assert.equal(r2.value, false, "第二次调用不打印")
    assert.equal(r2.warnings.length, 0)
  } finally { resetDeprecatedSecretEnvWarnForTests() }
})

// ═════════════════ D-30 验收标准 ACS：门禁 / 文案 / 静态（设计档 §5 AC-21/22/24） ═════════════════

/** AC-21/AC-24 用最小 eng_coder deps：dsh 子代理 stub（不许 spawn 的用例直接抛）。 */
function makeMinimalEngDeps(sid, { spawned } = {}) {
  return {
    ctx: {
      subagents: {
        async start(_kind, req) {
          if (spawned) spawned.push(req)
          return {
            result: Promise.resolve({ output: [{ type: "text", text: "done\n\nTouched files: none" }], stopReason: "completed" }),
            dispose: async () => {},
          }
        },
      },
    },
    agent: { session: { id: sid, header: { cwd: tmpdir() } }, options: {} },
    config: {}, signal: undefined, configDefaultEngineering: false,
  }
}

test("AC-21: the write gate stays fail-open on its own faults and NEVER performs renewal (D1 boundary)", async () => {
  // (a) 门禁自身故障 → 放行（fail-open 只此一处；续期判定是 fail-closed，两者语义互斥）
  const brokenGate = makeWriteGate(() => { throw new Error("config unavailable (gate-internal fault)") })
  let nexted = false
  const r = await brokenGate(
    { name: "write", arguments: { file_path: "src/x.ts" }, agent: { session: { id: "gate-boom", header: {} } } },
    async () => { nexted = true; return "NEXT" })
  assert.equal(nexted, true, "门禁内部抛错 → next() 放行（不许砖会话）")
  assert.equal(r, "NEXT")

  // (b) 门禁不执行续期：工程模式 ON + 令牌已过期 + 盘上有**可续期**记录（指纹与文档一致）
  //     → 仍 deny，且 state 与磁盘一字未改（续期落点只在 eng_coder 过期子分支，决策 D1）
  const home = mkdtempSync(join(tmpdir(), "thincoder-ac21-"))
  const sid = "ac21-gate-norenew"
  try {
    const st = sessionState(sid)
    st.engineering = true
    const expired = "11111111-2222-3333-4444-555555555555:" + (Date.now() - 60_000)
    st.designToken = expired
    const doc = join(home, "a.md")
    writeFileSync(doc, "A — unchanged content")
    const dh = computeDocHash([doc])
    assert.equal(dh.ok, true)
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveTokenStorePath(home), JSON.stringify({
      version: 1,
      tokens: { [sid]: { token: expired, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 60_000, docHash: dh.hash, docPaths: dh.docPaths } },
    }))
    const diskBefore = readFileSync(resolveTokenStorePath(home), "utf8")
    const gate = makeWriteGate(() => true) // config 默认 engineering=true
    const exec = { name: "write", arguments: { file_path: "src/x.ts" }, agent: { session: { id: sid, header: { cwd: home } } } }
    const res = await gate(exec, async () => "NEXT")
    assert.equal(res.kind, "deny", "过期令牌 + 产品代码写 → deny（不得 fail-open 放行）: " + JSON.stringify(res))
    assert.ok(/eng_coder/.test(res.reason), "deny 文案指向真实出路（再调 eng_coder 走续期）: " + res.reason)
    assert.ok(!/write the design document first/.test(res.reason), "过期时不得再说「先写设计文档」（误导）")
    assert.equal(st.designToken, expired, "门禁绝不执行续期（state 不变）")
    assert.equal(readFileSync(resolveTokenStorePath(home), "utf8"), diskBefore, "门禁绝不写 token 存储")
    // 文档仍可写（门禁范围边界不变）
    const docRes = await gate({ name: "write", arguments: { file_path: "docs/plan.md" }, agent: { session: { id: sid, header: { cwd: home } } } }, async () => "NEXT")
    assert.equal(docRes, "NEXT", "docs/**.md 豁免不受令牌状态影响")
  } finally {
    try { rmSync(home, { recursive: true, force: true }) } catch { /* 已清理 */ }
    dropSession(sid)
  }
})

test("AC-22: static — main.md drops 'bound to the current turn' and names BOTH cross-turn survival and the consultTimeoutMs bound", () => {
  const src = readFileSync(new URL("../lib/prompts/main.md", import.meta.url), "utf8")
  assert.ok(!src.includes("bound to the current turn"), "旧口径（与 consult.mjs D-28 实现矛盾）必须消失")
  const consultLine = src.split("\n").find((l) => /consult/i.test(l) && /(survive|存活)/i.test(l))
  assert.ok(consultLine, "有一行专讲会诊生命周期（跨回合口径）")
  assert.ok(/survive across turns|cross-turn|跨回合|存活/.test(consultLine), "写明跨回合存活（打断/回合结束不杀）: " + consultLine)
  assert.ok(consultLine.includes("consultTimeoutMs"), "同一行写明**有界**（受 consultTimeoutMs 约束）——两件事都在同一句")
  assert.ok(/interrupt/i.test(consultLine), "点明「打断」这条显式路径")
  assert.ok(/end of the current turn|turn/i.test(consultLine), "点明「回合结束」这条显式路径")
})

test("AC-24: a three-part legacy token → eng_coder says 旧版本令牌 (distinct from 无法续期 / 文档已变更)", async () => {
  const uuid = "0f8fad5b-d9cb-469f-a165-70867728950e"
  // (a) 未过期的三段式（升级后在途令牌的真实形态：形状不兼容，与 TTL 无关）
  const sidA = "ac24-legacy-fresh"
  const stA = sessionState(sidA)
  stA.engineering = true
  const legacyFresh = uuid + ":" + (Date.now() + 3600_000) + ":deadbeefdeadbeef"
  stA.designToken = legacyFresh
  try {
    const spawned = []
    const outA = await runEngCoder(makeMinimalEngDeps(sidA, { spawned }), { task: "implement x", designToken: legacyFresh })
    assert.ok(outA.includes("旧版本令牌"), "旧版本文案: " + outA)
    assert.ok(outA.includes("shape") || outA.includes("三段") || outA.includes("three-part"), "说明形状不兼容")
    assert.ok(!outA.includes("文档已变更"), "不得与「文档已变更」混淆")
    assert.ok(!outA.includes("eng_coder delivery:"), "三段式不得放行")
    assert.equal(spawned.length, 0)
  } finally { dropSession(sidA) }
  // (b) 已过期的三段式：走过期子分支的 legacy 检测，同样给「旧版本」文案
  const sidB = "ac24-legacy-expired"
  const stB = sessionState(sidB)
  stB.engineering = true
  const legacyExpired = uuid + ":" + (Date.now() - 60_000) + ":deadbeefdeadbeef"
  stB.designToken = legacyExpired
  try {
    const spawned = []
    const outB = await runEngCoder(makeMinimalEngDeps(sidB, { spawned }), { task: "implement x", designToken: legacyExpired })
    assert.ok(outB.includes("design token expired"), "先报过期: " + outB)
    assert.ok(outB.includes("旧版本令牌"), "过期三段式同样给旧版本文案: " + outB)
    assert.ok(outB.includes("无法续期"), "同时说明无法续期（避免与「文档已变更」混淆）")
    assert.ok(!outB.includes("design document set has CHANGED"), "不得误报文档变更")
    assert.equal(spawned.length, 0)
  } finally { dropSession(sidB) }
})

// ═════════════════ D-30 验收标准 ACS：续期 / 指纹绑定（设计档 §5 AC-10） ═════════════════

/** AC-10 夹具：可改名/可编辑的文档 + 「已签发但已过期」的磁盘记录（保留 docHash/docPaths）。 */
function makeAc10Fixture(sid, home, { content }) {
  const docDir = join(home, "docsrc")
  mkdirSync(docDir, { recursive: true })
  const pathA = join(docDir, "a.md")
  writeFileSync(pathA, content)
  const issued = computeDocHash([pathA])
  assert.equal(issued.ok, true, "签发放下的指纹可算（夹具前提）")
  const expired = "0f8fad5b-d9cb-469f-a165-70867728950e:" + (Date.now() - 60_000)
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = expired
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  const storePath = resolveTokenStorePath(home)
  writeFileSync(storePath, JSON.stringify({
    version: 1,
    tokens: {
      [sid]: { token: expired, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 60_000, docHash: issued.hash, docPaths: issued.docPaths },
    },
  }))
  return { pathA, issued, expired, storePath }
}

test("AC-10: renaming/moving a bound document with BYTE-IDENTICAL content → renewal REFUSED (the fingerprint binds the PATH, not only the content)", async () => {
  // 本条的证伪力在于「内容字节不变而路径变了」这一个变量：纯内容指纹会把改名/移位判为未变
  // （评审的指向物已消失而 hash 还绿）→ 放行续期；路径+内容双绑则必须拒绝（设计档 §3 FR-T5）。
  const CONTENT = "A v1 — the approved design document body"
  // ——— (a) 改名/移位：内容逐字节不变 ———
  const homeA = mkdtempSync(join(tmpdir(), "thincoder-ac10-rename-"))
  const sidA = "ac10-rename"
  try {
    const { pathA, issued, expired, storePath } = makeAc10Fixture(sidA, homeA, { content: CONTENT })
    const pathB = join(homeA, "docsrc", "moved-a.md")
    renameSync(pathA, pathB) // 改名/移位（同一份文档，位置变了）
    assert.equal(existsSync(pathA), false, "旧路径已不存在（指向物确实被移位）")
    assert.equal(readFileSync(pathB, "utf8"), CONTENT, "内容逐字节不变")
    // 证伪证据：指纹里的**内容项**完全没变，只有路径项变了 ——
    // 若 docHash 只绑内容，下面这条 notEqual 必红（这正是本条用例要挡的退化）。
    assert.equal(sha256Hex(readFileSync(pathB)), sha256Hex(CONTENT), "内容摘要不变 → 纯内容指纹在此会判「未变」")
    const moved = computeDocHash([pathB])
    assert.equal(moved.ok, true)
    assert.notEqual(moved.hash, issued.hash, "路径参与摘要 → 移位后指纹必不同（而记录里的 docHash 仍绑 A 的路径）")
    // 指向物跟着走：记录里的 docPaths 更新为 B（评审指向的仍是这份文档，只是位置变了）
    writeFileSync(storePath, JSON.stringify({
      version: 1,
      tokens: { [sidA]: { token: expired, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 60_000, docHash: issued.hash, docPaths: moved.docPaths } },
    }))
    // 同一 uuid 的过期场景 → 必须拒绝续期
    const spawned = []
    const out = await runEngCoder({ ...makeMinimalEngDeps(sidA, { spawned }), storPathOverride: homeA },
      { task: "implement x", designToken: expired })
    assert.ok(out.includes("the design document set has CHANGED"), "改名/移位 → 「文档已变更」: " + out)
    assert.ok(out.includes("文档已变更"), "中文文案可区分: " + out)
    assert.ok(out.includes(normalizeDocPath(pathB)), "点名变更后的文档集（诊断可见）: " + out)
    assert.ok(!out.includes("eng_coder delivery:"), "拒绝路径不得 spawn")
    assert.equal(spawned.length, 0, "no spawn")
    assert.equal(sessionState(sidA).designToken, expired, "state 不顺延（仍为过期串）")
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).tokens[sidA].token, expired, "磁盘未被续期改写")
  } finally { dropSession(sidA); rmSync(homeA, { recursive: true, force: true }) }

  // ——— (b) 反向对照：不改名、只改内容 → 同样拒绝（证明夹具与判定路径是活的，不是靠路径一条特例） ———
  const homeB = mkdtempSync(join(tmpdir(), "thincoder-ac10-edit-"))
  const sidB = "ac10-edit"
  try {
    const { pathA, expired, storePath } = makeAc10Fixture(sidB, homeB, { content: CONTENT })
    writeFileSync(pathA, CONTENT + " — edited in place") // 路径不变，内容变
    const spawned = []
    const out = await runEngCoder({ ...makeMinimalEngDeps(sidB, { spawned }), storPathOverride: homeB },
      { task: "implement x", designToken: expired })
    assert.ok(out.includes("the design document set has CHANGED"), "只改内容 → 同样拒绝: " + out)
    assert.ok(!out.includes("eng_coder delivery:") && spawned.length === 0, "拒绝路径不得 spawn")
    assert.equal(sessionState(sidB).designToken, expired, "state 不顺延")
    assert.equal(JSON.parse(readFileSync(storePath, "utf8")).tokens[sidB].token, expired, "磁盘未被续期改写")
  } finally { dropSession(sidB); rmSync(homeB, { recursive: true, force: true }) }
})

// ═════════════ D-30 批 2 收口轮：代码评审 #1（dsh 后台派发漏带 warnPrefix） ═════════════

/**
 * 夹具：engineering ON + 已过期令牌（内存/磁盘同一串）+ 盘上**可续期**记录（docHash 与文档
 * 集当前一致）。返回续期判定所需的全部素材（评审 #1 用例与 AC-8 同形，只是走后台派发）。
 */
function makeRenewableFixture(sid, home) {
  const docPath = join(home, "a.md")
  writeFileSync(docPath, "A — unchanged since the review approved it")
  const issued = computeDocHash([docPath])
  assert.equal(issued.ok, true, "夹具前提：签发放下的指纹可算")
  const expired = "0f8fad5b-d9cb-469f-a165-70867728950e:" + (Date.now() - 60_000)
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = expired
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  writeFileSync(resolveTokenStorePath(home), JSON.stringify({
    version: 1,
    tokens: { [sid]: { token: expired, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 60_000, docHash: issued.hash, docPaths: issued.docPaths } },
  }))
  return { expired, issued }
}

test("D-30 评审#1: dsh 后台派发返回并入 warnPrefix —— 续期回执（含新令牌串）在**派发文本**里可见，不再等到 job 完成", async () => {
  const home = mkdtempSync(join(tmpdir(), "thincoder-r1-dshbg-"))
  const sid = "r1-dsh-bg-renew"
  try {
    const { expired } = makeRenewableFixture(sid, home)
    const { jobs, specs } = fakeJobsFactory()
    const subagents = { async start() {
      return { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "eng done\n\nTouched files: none" }] }), dispose: async () => {} }
    } }
    const deps = {
      ctx: { subagents, get: (s) => s === "jobs" ? jobs : null },
      agent: { session: { id: sid, header: { cwd: home } }, options: { provider: "p", model: "m" } },
      config: { dshBackgroundTimeoutMs: 1000 }, signal: undefined,
      configDefaultEngineering: false, storPathOverride: home,
    }
    const out = await runEngCoder(deps, { task: "implement x", designToken: expired, docs: [], background: true })
    // 前置：续期确实发生（否则下面的断言无的放矢）
    const fresh = sessionState(sid).designToken
    assert.notEqual(fresh, expired, "过期 + 文档未变 → 续期发生（同 uuid 顺延）")
    assert.equal(fresh.split(":")[0], expired.split(":")[0], "续期 = 同一 uuid")
    assert.ok(out.includes("eng-dsh-1") && out.includes("job_output"), "dsh 后台派发句柄: " + out.slice(0, 160))
    // —— 证伪点：去掉 eng.mjs:756 的 warnPrefix()，下面两条必红（新串彼时只在 job 完成通知里） ——
    assert.ok(out.includes("design token RENEWED"), "派发回执含续期回执（不再是裸句柄文本）: " + out)
    assert.ok(out.includes(fresh), "**新令牌串在派发回执里**（FR-T5 返回契约：调用方此刻即拿到新串）")
    assert.ok(out.includes("Replace the copy you hold"), "附「替换你手里的副本」指引")
    assert.ok(out.indexOf("[thincoder-suite]") < out.indexOf("eng-dsh-1"),
      "统一前缀先于句柄文本（warnPrefix + jobsDispatchReply，与 codex 后台路径同形）")
    const outcome = await specs[0].hooks.done
    assert.equal(outcome.status, "completed", "job 正常完成（槽位清理）")
    assert.equal(checkInFlightJob(sid, "eng"), null, "settle 清槽位")
  } finally { dropSession(sid); rmSync(home, { recursive: true, force: true }) }
})

// ═════════════ D-30 批 2 收口轮：代码评审 #2（SUPERSEDED 判定过宽 → 误报/遮蔽） ═════════════

test("D-30 评审#2: SUPERSEDED 只在「与 state 同 uuid 且已过期」时成立——未签发的过期垃圾串不被误报，旧三段式拿到旧版本文案", async () => {
  const UUID_STATE = "0f8fad5b-d9cb-469f-a165-70867728950e"  // 本会话 state 里的 uuid
  const UUID_OTHER = "11111111-2222-3333-4444-555555555555"  // 从未由本会话签发过的 uuid

  // —— 场景①：state 是有效（未过期）令牌，传入一枚**从未签发过**的过期垃圾串 ——
  //    旧判定「传入已过期 ∧ state 未过期」即报 SUPERSEDED = 虚假因果（实际什么都没发生过）。
  const sidA = "r2-garbage-not-superseded"
  const stA = sessionState(sidA)
  stA.engineering = true
  const freshA = UUID_STATE + ":" + (Date.now() + 3600_000)
  stA.designToken = freshA
  try {
    const spawned = []
    const garbage = UUID_OTHER + ":" + (Date.now() - 60_000)
    const outA = await runEngCoder(makeMinimalEngDeps(sidA, { spawned }), { task: "implement x", designToken: garbage })
    assert.ok(!outA.includes("SUPERSEDED"), "不得误报「已被本次会话的续期取代」（从未签发过）: " + outA)
    assert.ok(!outA.includes("已被本次会话的续期取代"), "中文文案同样不得误报")
    assert.ok(outA.includes("invalid or missing design token"), "回落到 mismatch 文案（该 uuid 在本会话无签发历史）: " + outA)
    assert.ok(!outA.includes("eng_coder delivery:"), "拒绝路径不得放行")
    assert.equal(spawned.length, 0, "no spawn")
    assert.equal(stA.designToken, freshA, "state 不变")
  } finally { dropSession(sidA) }

  // —— 场景②：state 已是「续期后的两段式」，传入的是旧三段式**过期**令牌 ——
  //    旧判序里 SUPERSEDED 先命中 → AC-24 要求的「旧版本令牌」文案被遮蔽。
  const sidB = "r2-legacy-not-shadowed"
  const stB = sessionState(sidB)
  stB.engineering = true
  const renewed = UUID_STATE + ":" + (Date.now() + 3600_000) // 续期后 state（两段式、未过期）
  stB.designToken = renewed
  try {
    const spawned = []
    const legacyExpired = UUID_OTHER + ":" + (Date.now() - 60_000) + ":deadbeefdeadbeef"
    const outB = await runEngCoder(makeMinimalEngDeps(sidB, { spawned }), { task: "implement x", designToken: legacyExpired })
    assert.ok(outB.includes("旧版本令牌"), "旧三段式过期串 → 旧版本文案（AC-24 不被遮蔽）: " + outB)
    assert.ok(outB.includes("three-part") || outB.includes("旧版本令牌"), "说明形状不兼容")
    assert.ok(!outB.includes("SUPERSEDED"), "不得被 SUPERSEDED 抢先命中")
    assert.ok(!outB.includes("eng_coder delivery:"))
    assert.equal(spawned.length, 0, "no spawn")
    assert.equal(stB.designToken, renewed, "state 不变（拒绝路径无副作用）")
  } finally { dropSession(sidB) }

  // —— 正向对照（防「收紧过头」）：真正的续期取代场景仍必须报 SUPERSEDED ——
  //    state = 续期后的两段式（同 uuid、新 expiresAt），传入 = 同 uuid 的旧过期串（AC-18 形态）。
  const sidC = "r2-superseded-still-works"
  const stC = sessionState(sidC)
  stC.engineering = true
  const oldExpired = UUID_STATE + ":" + (Date.now() - 60_000)
  stC.designToken = UUID_STATE + ":" + (Date.now() + 3600_000) // 续期后：同 uuid、未过期
  try {
    const spawned = []
    const outC = await runEngCoder(makeMinimalEngDeps(sidC, { spawned }), { task: "implement x", designToken: oldExpired })
    assert.ok(outC.includes("SUPERSEDED") && outC.includes("已被本次会话的续期取代"),
      "同 uuid 的过期串仍是 SUPERSEDED（评审 #2 的收紧不得破坏 AC-18）: " + outC)
    assert.ok(outC.includes("Use the NEW token returned by that eng_coder call"), "出路指引保留")
    assert.equal(spawned.length, 0, "no spawn")
  } finally { dropSession(sidC) }
})

// ═════════════ D-30 批 2 收口轮：代码评审 #3（续期副作用先于 engEffective 检查） ═════════════

test("D-30 评审#3: engineering OFF 的调用被拒时零副作用——过期令牌不被顺延、磁盘一字未改", async () => {
  const home = mkdtempSync(join(tmpdir(), "thincoder-r3-engoff-"))
  const sid = "r3-eng-off"
  try {
    // 盘上放一枚**可续期**记录（指纹与文档一致）——若检查仍排在续期之后，本次调用会把令牌顺延并落盘
    const { expired } = makeRenewableFixture(sid, home)
    const storePath = resolveTokenStorePath(home)
    const diskBefore = readFileSync(storePath, "utf8")
    const st = sessionState(sid)
    st.engineering = false // 显式 OFF（tri-state 显式值胜出，configDefaultEngineering 不参与）
    assert.equal(st.designToken, expired, "前置：内存态是那枚过期令牌")
    const spawned = []
    // 注意：本用例**故意**不置 engineering=true——被拒路径必须在 token/续期块之前就返回
    const deps = {
      ctx: { subagents: { async start(k, r) { spawned.push(r); throw new Error("eng OFF must not spawn") } } },
      agent: { session: { id: sid, header: { cwd: home } }, options: {} },
      config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: home,
    }
    const out = await runEngCoder(deps, { task: "implement x", designToken: expired, docs: [] })
    assert.ok(out.includes("engineering mode is OFF"), "先报工程模式 OFF: " + out)
    assert.ok(!out.includes("design token RENEWED"), "被拒的调用不得产生续期回执")
    assert.equal(sessionState(sid).designToken, expired, "state 未被顺延（评审 #3：被拒 = 零副作用）")
    assert.equal(readFileSync(storePath, "utf8"), diskBefore, "磁盘记录一字未改（未落盘续期）")
    assert.equal(spawned.length, 0, "no spawn")
  } finally { dropSession(sid); rmSync(home, { recursive: true, force: true }) }
})

// ═════════════ D-30 批 2 收口轮：代码评审 #4（docPaths 缺失/为空时的文案归类） ═════════════

/** 畸形盘记录夹具：带 docHash 但 docPaths 缺失或为空（手改/损坏）。 */
function writeMalformedRecord(sid, home, { docPaths }) {
  const expired = "0f8fad5b-d9cb-469f-a165-70867728950e:" + (Date.now() - 60_000)
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = expired
  mkdirSync(join(home, ".thincoder"), { recursive: true })
  const rec = { token: expired, issuedAt: Date.now() - 7_200_000, expiresAt: Date.now() - 60_000, docHash: sha256Hex("the approved document set") }
  if (docPaths !== undefined) rec.docPaths = docPaths
  writeFileSync(resolveTokenStorePath(home), JSON.stringify({ version: 1, tokens: { [sid]: rec } }))
  return expired
}

test("D-30 评审#4: docHash 在而 docPaths 缺失/为空 → 报「无法续期（记录不完整）」，不误报「文档已变更」", async () => {
  for (const [label, docPaths] of [["docPaths 缺失", undefined], ["docPaths 为空数组", []]]) {
    const home = mkdtempSync(join(tmpdir(), "thincoder-r4-"))
    const sid = "r4-malformed-" + (docPaths === undefined ? "missing" : "empty")
    try {
      const expired = writeMalformedRecord(sid, home, { docPaths })
      const storePath = resolveTokenStorePath(home)
      const diskBefore = readFileSync(storePath, "utf8")
      const spawned = []
      const out = await runEngCoder({ ...makeMinimalEngDeps(sid, { spawned }), storPathOverride: home },
        { task: "implement x", designToken: expired })
      assert.ok(out.includes("cannot be renewed automatically"), label + " → 「无法续期」类文案: " + out)
      assert.ok(out.includes("无法续期") && out.includes("记录不完整"), label + " → 中文说清「记录不完整」: " + out)
      assert.ok(!out.includes("has CHANGED"), label + " → 不得误报「文档已变更」（根本没有文档集可比）")
      assert.ok(!out.includes("文档已变更"), label + " → 中文同样不得误报")
      assert.ok(!out.includes("eng_coder delivery:"), label + " → 拒绝路径不得放行")
      assert.equal(spawned.length, 0, label + " → no spawn")
      assert.equal(sessionState(sid).designToken, expired, label + " → state 未顺延")
      assert.equal(readFileSync(storePath, "utf8"), diskBefore, label + " → 磁盘未被改写")
    } finally { dropSession(sid); rmSync(home, { recursive: true, force: true }) }
  }
})

// ═════════ D-30 收尾轮：评审 #7（N1「零新增依赖」的专用静态断言 = AC-28） ═════════
// 需求档 §4 N1 的度量方式原本是「`package.json` dependencies 数不变（= 0）」——但**没有任何
// 用例读它**，于是该不变量只是一句约定：任何一次「顺手加个依赖」都不会让测试变红。
// 本用例把它变成静态锁（与 AC-3/AC-22 同类的源级断言）。

test("AC-28 (N1): package.json 零新增依赖 —— dependencies 为空或缺省（静态锁，非约定）", () => {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8")
  const pkg = JSON.parse(raw)
  // 判定：缺省 / null / 空对象三者皆 = 零依赖；非空对象 = 违反 N1。
  const zeroDeps = (p) => Object.keys(p.dependencies ?? {}).length === 0
  const deps = pkg.dependencies ?? {}
  assert.equal(zeroDeps(pkg), true,
    "N1 被破坏：package.json dependencies 非空 → " + JSON.stringify(Object.keys(deps)))
  assert.deepEqual(Object.keys(deps), [], "dependencies 项数必须为 0")

  // 证伪对照（审计对 AC-5/AC-6 恒真断言的教训）：同一判定对「有依赖」样本必须为 false，
  // 否则本用例是恒真空断言，锁不住任何东西。
  assert.equal(zeroDeps({ dependencies: { "left-pad": "^1.3.0" } }), false,
    "判定对非空 dependencies 必须为 false（防恒真）")
  assert.equal(zeroDeps({ dependencies: {} }), true, "空对象 = 零依赖")
  assert.equal(zeroDeps({}), true, "缺省 = 零依赖")

  // 解析面真实性对照：读到的必须是插件清单本体（防「读错文件/读成空」造成的假绿）。
  assert.equal(pkg.name, "@dsh-external/dsh-thincoder-suite", "解析面 = 本插件 package.json")
  // 口径说明：peerDependencies（cordis，由宿主提供）不属于 N1 的 dependencies 口径，
  // 故此处只作存在性留档，不参与零依赖判定。
  assert.ok(pkg.peerDependencies && pkg.peerDependencies.cordis,
    "peerDependencies.cordis 仍在（宿主提供，不计入 N1 的零依赖口径）")
})

// ═════════════ 批 21（长任务默认走后台）：escalate 工具入口的三态透传（FR-1④） ═════════════
// 设计档 `docs/2026-09-17-jobs-default-design.md` §5.1 ④：`lib/index.mjs` 的透传点此前是
// `args?.background === true`——**三态压成二态** ⇒ 省略被压成 `false` ⇒ escalate 的默认翻转
// **完全静默失效**（会诊 G5④ 抓到的父侧漏洞、父侧漏看的那一面）。本区经**真实工具注册入口**
// 见证三态（`apply()` → `ctx.tools.register` → `tool.execute`）：省略 ⇒ 派后台 job；显式
// `false` ⇒ 同步快路径；`ctx.jobs` 缺失 ⇒ 告警随工具返回可见。**把透传改回 `=== true` 必红**
// （省略那一次会落同步 ⇒ `jobs` 零调用、`subagents` 被调一次）。
// 另静态锁 **FR-1③**（schema 描述面）：两处 `background` 的 `default: false` 注解已删、描述串
// 改说「默认后台 / 传 `false` 强制同步」——注解不改变行为，但会让给模型看的 schema 撒谎。

/** 批 21 假 jobs：`start` **只登记不执行** ⇒ job 永不 settle（正控与护栏夹具同形）。 */
function b21HoldJobs(id) {
  const specs = []
  return {
    specs,
    jobs: { start(spec) { specs.push(spec); return id }, get: () => null, cancel: () => false, list: () => [] },
  }
}

/** 批 21 子代理 spy：**同步快路径**的落点（后台派发时不得被调用）。 */
function b21Subagents(spawned) {
  return {
    async start(_kind, req) {
      spawned.push(req)
      return {
        result: Promise.resolve({ output: [{ type: "text", text: "done the work" }], stopReason: "completed" }),
        dispose: async () => { },
      }
    },
  }
}

/** 批 21 工具注册表夹具：跑**真实** `apply()`，按名收集注册的工具（`ctx.get("jobs")` 同缝）。 */
async function b21ToolRegistry(pluginConfig, { jobs = null, subagents = null } = {}) {
  const { apply } = await import("../lib/index.mjs")
  const tools = new Map()
  const ctx = {
    on: () => () => { },
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    systemPrompt: { section: () => () => { } },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => { } } },
    get: (svc) => (svc === "jobs" ? jobs : null),
    subagents,
  }
  apply(ctx, pluginConfig)
  return { tools, ctx }
}

test("批 21 AC-2: escalate 工具入口省略 background ⇒ 派后台 job（三态透传 ④ 的直接见证）", async () => {
  const sid = "b21-ac2-esc"
  const hold = b21HoldJobs("escalate-dsh-ac2")
  const spawned = []
  const { tools } = await b21ToolRegistry(
    { consultModels: [{ provider: "acme", model: "model-a" }] },
    { jobs: hold.jobs, subagents: b21Subagents(spawned) },
  )
  const tool = tools.get("escalate")
  assert.ok(tool, "escalate 工具已注册（consultModels 非空）")
  const agent = { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }
  const out = await tool.execute({ task: "fix the bug" }, { agent })
  assert.equal(hold.specs.length, 1,
    "省略 background ⇒ 必须派后台 job（透传改回 `=== true` 时此处为 0）: " + out.slice(0, 200))
  assert.equal(hold.specs[0].kind, "escalate-dsh", "job kind 机制专属")
  assert.equal(spawned.length, 0,
    "后台派发 ⇒ 同步子代理 spawn 不得发生（透传改回 `=== true` 时此处为 1）")
  assert.ok(out.includes("escalate-dsh-ac2"), "工具返回 = job 句柄: " + out.slice(0, 200))
  assert.ok(!out.includes("post-op report"), "派发即返回 ⇒ 返回文本不是术后报告")
  dropSession(sid)
})

test("批 21 AC-3 (escalate 侧): 显式 background=false ⇒ 同步快路径（逃生口不丢，jobs 零调用）", async () => {
  const sid = "b21-ac3-esc-sync"
  const hold = b21HoldJobs("escalate-dsh-must-not-dispatch")
  const spawned = []
  const { tools } = await b21ToolRegistry(
    { consultModels: [{ provider: "acme", model: "model-a" }] },
    { jobs: hold.jobs, subagents: b21Subagents(spawned) },
  )
  const agent = { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }
  const out = await tools.get("escalate").execute({ task: "fix the bug", background: false }, { agent })
  assert.equal(hold.specs.length, 0, "background=false ⇒ jobs 不得被调用（逃生口不丢）")
  assert.equal(spawned.length, 1, "background=false ⇒ 走同步子代理 spawn")
  assert.ok(out.includes("post-op report"), "同步路径当场交付术后报告: " + out.slice(0, 160))
  dropSession(sid)
})

test("批 21 AC-5 (escalate 侧): ctx.jobs 缺失 ⇒ 告警随工具返回可见（双通道）+ 仍回落同步（文案逐字节）", async () => {
  // 文案是既有字面（FR-3 硬约束：行为与文案逐字节保持现状，只新增「随工具返回」这条通道）。
  const NOTE = "[thincoder-suite] escalate background=true 不可用（ctx.jobs 缺失）——回落同步执行（budgetCap 内部截止）"
  const sid = "b21-ac5-esc"
  const spawned = []
  const { tools } = await b21ToolRegistry(
    { consultModels: [{ provider: "acme", model: "model-a" }] },
    { jobs: null, subagents: b21Subagents(spawned) },
  )
  const agent = { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } }
  const warns = []
  const origWarn = console.warn
  let out
  try {
    console.warn = (...a) => { warns.push(a.map(String).join(" ")) }
    out = await tools.get("escalate").execute({ task: "fix the bug" }, { agent })
  } finally { console.warn = origWarn }
  assert.equal(warns.filter((w) => w === NOTE).length, 1, "console 通道：逐字节恰一条: " + JSON.stringify(warns))
  assert.ok(out.includes(NOTE), "★ 工具返回文本通道（本批新增——此前只 console ⇒ 翻转后即静默失败）: " + out.slice(-300))
  assert.equal(out.split(NOTE).length - 1, 1, "返回文本里恰一次（不重复注入）")
  assert.equal(spawned.length, 1, "行为仍是回落同步：同步子代理 spawn 恰好一次")
  assert.ok(out.includes("post-op report"), "回落同步路径照常交付")
  dropSession(sid)
})

test("批 21 A3 (静态锁): 两处 background 的 schema 描述面同批在位、default:false 注解已删（FR-1③）", () => {
  const src = readFileSync(new URL("../lib/index.mjs", import.meta.url), "utf8")
  const SCHEMA = 'background: { type: "boolean", description: "dsh 子代理路径默认后台执行'
  assert.equal(src.split(SCHEMA).length - 1, 2,
    "eng_coder 与 escalate 两处 schema 都改说「默认后台」（描述面与实现一致）")
  assert.equal(src.split('background: { type: "boolean", default: false').length - 1, 0,
    "schema 的 default: false 注解已删——注解不改变行为，但会让给模型看的 schema 撒谎")
  assert.ok(src.includes("传 false 强制同步"), "描述面写明逃生口语义（传 false 强制同步）")
  assert.ok(src.includes("args?.background)"),
    "escalate 的透传点是三态 `args?.background`（A3 的调用点面；`=== true` 形态零残留）")
})

test("批 21 AC-6 / A4 (静态锁): codex 路径的判定仍是 `=== true`（两机制三处）而 dsh 路径是三态（A1/A2）", () => {
  // AC-6 的层标是 **T2（静态谓词 / 逐字可查）**——本批唯一的静止面断言。判据 = 「codex 路径零漂移」：
  // 本批只动 dsh 路径，codex 的 `=== true` 必须逐字仍在（否则 `background` 省略会把**按预算判定**
  // 的 codex 路径也一并翻转 ⇒ 与 P-2 的既有现实脱钩）。
  const engSrc = readFileSync(new URL("../lib/eng.mjs", import.meta.url), "utf8")
  const escSrc = readFileSync(new URL("../lib/escalate.mjs", import.meta.url), "utf8")
  assert.equal(engSrc.split("|| args?.background === true) {").length - 1, 1,
    "eng 的 codex 派发判定未被翻转（A4：仍是 `=== true`）")
  assert.equal(escSrc.split("const background = p.background === true").length - 1, 1,
    "escalate 的 codex 判定未被翻转（A4）")
  assert.equal(escSrc.split("background: background === true,").length - 1, 2,
    "两处 codex 透传（首次 + followup）都未被翻转（A4）")
  // 对照（同一条锁的另一半，防「两处一起改了就都看不出」）：dsh 路径必须是三态形态
  assert.equal(engSrc.split("if (args?.background !== false) {").length - 1, 1, "eng 的 dsh 判定是三态（A1）")
  assert.equal(escSrc.split("if (background !== false) {").length - 1, 1, "escalate 的 dsh 判定是三态（A2）")
})
