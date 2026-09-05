// codex-runner.test.mjs — 一期 codex-runner 单元测试（docs/2026-09-03-codex-runner-research.md §7.1 T1.1/T1.2/T1.5）。
// node:test 零依赖：adapter 用假子进程（deps.spawn 注入），不碰真实 codex / 不出网。
// 覆盖：B2/B4/B12 runner 校验、codexCli 全局节、envelope 错误码（注入法）、模型发现解析、
// advisor 路由 codex 分支、config 合并、escalate codex 行剔除、runAdvisorReview codex 路径。
// R4 收尾微修复轮（登记表 D-25 + code review 跟进）：TOKEN_SECRET 密钥源三形态/重启稳定性 +
// advisor jobs 派发路径 warnPrefix 可见性。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { writeFileSync, mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  normalizeRunnerValue, validateRunnerValue, resolveCodexCliGlobals,
  buildCodexArgs, resolveExecutableFile, runCodexTask, discoverCodexModels, codexRowLabel, sweepStaleCodexTempDirs,
} from "../lib/codex-adapter.mjs"
import { resolveAdvisorRoute, advisorGenerationOf, bumpAdvisorGeneration, sessionStateViewWithGeneration, checkInFlightJob } from "../lib/advisor.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "../lib/effort-resolve.mjs"
import { startConsultSession, checkConsultSession } from "../lib/consult.mjs"
import { mergeGlobalConfig } from "../lib/config-store.mjs"
import { validateGlobalUserConfig } from "../lib/index.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { runEngCoder } from "../lib/eng.mjs"
import { saveSessionState, loadSessionState, normalizeRestored, resolveSessionStorePath } from "../lib/session-store.mjs"
import { createHmac } from "node:crypto"
import { sessionState, dropSession } from "../lib/state.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const r = normalizeRunnerValue({ kind: "dsh", model: "gpt-5.6-sol" })
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
  const r = normalizeRunnerValue({ kind: "codex-cli", model: "gpt-5.6-sol", effort: "ultra" })
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
  const args = buildCodexArgs({ cwd: "C:/w", sandbox: "read-only", model: "gpt-5.6-sol", effort: "xhigh", agentsMd: "disable", tmpOut: "o.txt" })
  assert.deepEqual(args, [
    "exec", "-C", "C:/w", "--skip-git-repo-check", "-s", "read-only",
    "-m", "gpt-5.6-sol",
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

const RUNNER = { kind: "codex-cli", model: "gpt-5.6-sol" }
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
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", default_reasoning_level: "low", visibility: "list", context_window: 272000,
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
  assert.equal(codexRowLabel({ kind: "codex-cli", model: "gpt-5.6-sol" }), "codex-cli:gpt-5.6-sol")
  assert.equal(codexRowLabel({ kind: "codex-cli" }, { model: "gpt-5.6-terra" }), "codex-cli:gpt-5.6-terra")
  assert.equal(codexRowLabel({ kind: "codex-cli" }), "codex-cli:default")
})

// ————————————— advisor 路由 codex 分支 —————————————

test("advisor 路由: codex 行免 provider/model，model 回落 runner.model", () => {
  const r = resolveAdvisorRoute({
    config: { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" } } } },
    override: null, agentOpts: {}, advisorRound: 0,
  })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "codex-cli")
  assert.equal(r.model, "gpt-5.6-sol")
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
    { codexCli: { proxyMode: "url", proxyUrl: "http://127.0.0.1:7897" }, consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol" } }] },
  )
  assert.deepEqual(merged.codexCli, { executable: "codex", proxyMode: "url", proxyUrl: "http://127.0.0.1:7897" })
  assert.equal(merged.consultModels[0].runner.kind, "codex-cli")
})

test("validateGlobalUserConfig: codex 行免 provider/model 合法；codexCli 非法值报错（B12）", () => {
  const v = validateGlobalUserConfig({ codexCli: { executable: "codex", agentsMdPolicy: "disable" }, consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol" } }] }, [])
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
    { agent, config: { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" } } } }, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(!out.startsWith("Advisor:"), "completed review should not carry error prefix")
  assert.ok(out.includes("Issue"), "review table text should flow through")
  dropSession(sid)
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
  consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol" } }],
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
  const secret = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"
  const uuid = "u-" + Math.random().toString(16).slice(2)
  const expiresAt = Date.now() + 3600_000
  const payload = uuid + ":" + expiresAt
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
  state.designToken = payload + ":" + sig
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
  const config = { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", agentsMdPolicy: "disable" } }
  const out = await runEngCoder(
    { ctx: { subagents: { start: () => { throw new Error("dsh spawn must not run for codex backend") } } }, agent, config, signal: undefined, configDefaultEngineering: false, spawn, platform: "linux", env: {} },
    { task: "implement x", designToken: token, docs: [], stages: undefined },
  )
  assert.ok(out.includes("eng_coder delivery (codex-cli)"), "codex 交付走专用前缀")
  assert.ok(out.includes("implemented"))
  assert.ok(seenArgs.includes("-s") && seenArgs.includes("workspace-write"), "B5：eng_coder 固定写沙箱")
  assert.ok(seenArgs.includes("project_doc_max_bytes=0"), "AGENTS 策略默认 disable")
  assert.ok(seenArgs.includes("-m") && seenArgs.includes("gpt-5.6-sol"))
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
      { runner: { kind: "codex-cli", model: "gpt-5.6-sol" } },
    ],
    codexCli: { executable: process.execPath },
  }
  const sid = "esc-mismatch-p2"
  await runEscalate(makeEscDeps(sid, spawn, cfg), "first via row B", "codex-cli:gpt-5.6-sol")
  await runEscalate(makeEscDeps(sid, spawn, cfg), "followup tweak", undefined, true)
  assert.ok(seenArgs.includes("-m") && seenArgs.includes("gpt-5.6-sol"), "followup 用保存行的 model（非 pool[0]）")
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
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
  assert.ok(startPayload.label.includes("gpt-5.6-sol"))
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
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
  const cfg = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3" } } }
  const r = resolveAdvisorRoute({ config: cfg, override: null, agentOpts: {}, advisorRound: 0, ignoreRunner: true })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "qax")
  assert.equal(r.model, "glm-5.3")
  assert.equal(r.runner, undefined)
})

test("advisor 路由: runner=codex-cli 生效且组内显式 provider/model → 告警（UX 陷阱可见）", () => {
  const cfg = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3" } } }
  const r = resolveAdvisorRoute({ config: cfg, override: null, agentOpts: {}, advisorRound: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.provider, "codex-cli")
  assert.ok(r.warnings.some((w) => w.includes("被忽略") && w.includes("qax:glm-5.3")))
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3" } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
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
      { id: "qax", name: "Qax" },
      { id: "zai-coding-cn", name: "ZAI" },
    ],
    listModels: async (provider) => provider === "deepseek-official"
      ? [{ provider, id: "deepseek-chat", name: "DeepSeek Chat" }]
      : [{ provider, id: "glm-5.3", name: "GLM-5.3" }, { provider, id: "glm-5.3-flash", name: "Flash" }, { broken: 1 }],
  }
  const handler = makeApiHandler({}, {
    baseConfig: {},
    llm,
    settingsGet: (ns) => ns === "llm-pi-ai" ? {
      providers: {
        "zai-coding-cn": {
          models: [
            { id: "glm-5.3", reasoningEfforts: { off: null, low: "low", medium: "medium", high: "high" } },
            { id: "glm-5.3-flash", reasoningEfforts: { off: null, high: "high" } },
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
  const zai = body.providers.filter((p) => p.id === "zai-coding-cn")[0]
  const glm = zai.models.filter((m) => m.id === "glm-5.3")[0]
  assert.deepEqual(glm.efforts, ["low", "medium", "high"], "settings reasoningEfforts 富化（null 档剔除）")
})

test("GET /catalog: llm runtime 缺失 → 502 + 明确错误（不再静默降级手填）", async () => {
  const { makeApiHandler } = await import("../lib/index.mjs")
  const handler = makeApiHandler({}, { baseConfig: {}, settingsGet: () => null })
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
    listProviders: async () => [{ id: "deepseek-official", name: "DeepSeek" }, { id: "qax", name: "Qax" }],
    listConfigurableProviders: async () => [{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] }],
  }
  const handler = makeApiHandler({}, {
    baseConfig: {},
    llm,
    dshHomeOverride: mkdtempSync(join(tmpdir(), "provider-registry-")),
    settingsGet: (ns) => ns === "llm-pi-ai" ? { providers: { "zai-coding-cn": { models: [] } } } : null,
  })
  const payload = JSON.stringify({
    config: {
      advisor: { convergence: { provider: "deepseek-official", model: "deepseek-chat" } },
      consultModels: [
        { provider: "deepseek-official", model: "deepseek-chat" },
        { provider: "qax", model: "glm-5.3" },
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
  const r = await resolveSupportedEffort(ladderLlm(["off", "high", "max"]), "qax", "glm-5.3-flash", "high")
  assert.equal(r.effort, "high")
  assert.equal(r.note, null)
})

test("R1 effort(dsh): 非法档 → 最近支持档 + note（DP-2：medium 缺失且 low/high 皆支持 → 取 high）", async () => {
  const r = await resolveSupportedEffort(ladderLlm(["low", "high"]), "qax", "m1", "medium")
  assert.equal(r.effort, "high", "等距 tie-break 向上取（DP-2 终裁：保推理质量）")
  assert.ok(r.note.includes("falling back to nearest supported effort"))
  assert.ok(r.note.includes('"high"'))
  assert.ok(r.note.includes("supported: low|high"))
})

test("R1 effort(dsh): 非等距取序距离最近（high 对 [off,low] → low；历史事故 low 对 [off,high,max] → off）", async () => {
  const a = await resolveSupportedEffort(ladderLlm(["off", "low"]), "p", "m", "high")
  assert.equal(a.effort, "low")
  // 2026-09-04 生产事故复现档：glm-5.3-flash efforts 仅 off/high/max，engCoderEffort "low" 秒死
  const b = await resolveSupportedEffort(ladderLlm(["off", "high", "max"]), "p", "glm-5.3-flash", "low")
  assert.equal(b.effort, "off", "off 序距离最近（D-裁决-2 最近支持档，绝不秒死）")
  assert.ok(b.note.includes("falling back"))
})

test("R1 effort(dsh): off 参与档位序（未受支持 → 最近档；受支持 → 保持）", async () => {
  const a = await resolveSupportedEffort(ladderLlm(["low", "high"]), "p", "m", "off")
  assert.equal(a.effort, "low")
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
  const ctx = {
    llm: ladderLlm(["off", "high", "max"]),
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
    { ctx, agent, config: { consultModels: [{ provider: "qax", model: "glm-5.3-flash", effort: "low" }] }, state },
    "problem brief", undefined,
  )
  const reply = await checkConsultSession(state, r.id)
  assert.equal(started.length, 1)
  assert.equal(started[0].agentOptions.reasoningEffort, "off", "low 对 [off,high,max] 序距离最近 = off")
  assert.ok(reply.reply.includes("second opinion"))
  assert.ok(reply.reply.includes("falling back to nearest supported effort"), "note 入回复尾部（主代理可见）")
  dropSession(sid)
})

test("R1 接线 consult codex 行：effort 经 codex catalog 校验（argv 最近档）+ note 入回复", async () => {
  const cat = catalogSpawn([{ slug: "m-cc", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "codex opinion" })
  const sid = "r1-consult-codex"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const deps = {
    ctx: {},
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc", effort: "medium", executable: "t-cc-1" } }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  const reply = await checkConsultSession(state, r.id)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "medium 对 [low,high] 等距向上 → high")
  assert.ok(reply.reply.includes("codex opinion"))
  assert.ok(reply.reply.includes("falling back to nearest supported effort"))
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
    config: { consultModels: [{ provider: "qax", model: "glm-5.3", effort: "medium" }] },
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
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "qax", model: "parent-model" } }
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
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "qax", model: "glm-5.3-flash" } }
  const out = await runEngCoder(
    { ctx: { subagents, llm: ladderLlm(["off", "high", "max"]) }, agent, config: { engCoderEffort: "low" }, signal: undefined, configDefaultEngineering: false, spawn: () => { throw new Error("codex must not spawn") }, platform: "linux", env: {} },
    { task: "implement y", designToken: token, docs: [] },
  )
  assert.ok(out.includes("eng_coder delivery:"))
  assert.equal(started[0].agentOptions.reasoningEffort, "off", "low 对 [off,high,max] 最近 = off")
  assert.ok(out.includes("is not supported by model glm-5.3-flash"), "note 经 warn 通道随工具返回可见")
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
    { agent, config: { advisor: { round1: { provider: "qax", model: "glm-5.3-flash", effort: "low", timeoutMs: 300000 } } }, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.equal(streamOptsSeen[0].reasoningEffort, "off", "low 对 [off,high,max] 最近 = off")
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", effort: "medium" } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "p", model: "m", timeoutMs: 900000 } }, codexCli: { budgetCapMs: 400 } }
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
  const handler = makeApiHandler({}, { baseConfig: {}, dshHomeOverride: mkdtempSync(join(tmpdir(), "maxout-")) })
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
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
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath } })
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
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath } })
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
  const { deps, token } = makeEngDepsR2(sid, null, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath } })
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
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
  // 异机制（advisor）不受阻——复合键每机制独立槽位
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
  const outA = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(outA.includes("advisor-codex-2"), "异机制（advisor）派发不受 escalate 在飞阻碍（复合键）")
  assert.equal(specs.length, 2)
  // escalate job settle → 槽位清除 → 可再次派发
  await specs[0].hooks.done
  const out3 = await runEscalate(deps, "after settle", undefined)
  assert.ok(out3.includes("escalate-codex-3"), "settle 后槽位清除，可再次派发")
  assert.equal(specs.length, 3)
  dropSession(sid)
})

test("R2 D-06: eng 机制槽位——eng 在飞时二次 eng_coder 被拒", async () => {
  const spawn = fakeSpawnFactory((args) => {
    if (args.includes("--version")) return probeScript(args)
    return { events: [], exitCode: 0, outText: "implemented\n\nTouched files: none" }
  })
  const { jobs, specs } = fakeJobsFactory()
  const sid = "sf-eng-r2"
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath } })
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
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
  const advConfig = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
  await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config: advConfig, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  const gen0 = advisorGenerationOf(sessionState(sid))
  // eng_coder codex 交付（同 jobs 设施，任务快退）→ deliverBookkeeping 内 bumpAdvisorGeneration
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath } })
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
  const cfg = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath, budgetCapMs: 700000 } }
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
  const deps2 = makeEscDeps(sid2, spawn, { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } })
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
  const ctx = {
    llm: ladderLlm(["low"]),
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
    { ctx, agent, config: { consultModels: [{ provider: "qax", model: "glm-5.3", effort: "low" }] }, state },
    "problem brief", undefined,
  )
  const reply = await checkConsultSession(state, r.id)
  assert.ok(reply.reply.includes("second opinion"))
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
    const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "p", model: "m" } } }
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
  const cfg = { consultModels: [{ provider: "qax", model: "glm-5.3" }], codexCli: { budgetCapMs: 250 } }
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
  const agent = { session: { id: sid, header: { cwd: tmpdir() } }, options: { provider: "qax", model: "glm-5.3" } }
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
    config: { consultModels: [{ provider: "qax", model: "glm-5.3", effort: "medium" }] },
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
    advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" } } },
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
  const deps = {
    ctx: {},
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc2", executable: "t-cc2-1" }, effort: "medium" }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  const reply = await checkConsultSession(state, r.id)
  assert.ok(cat.seenArgs().includes('model_reasoning_effort="high"'), "row.effort=medium 经目录校验回落 high（此前 row.effort 是死配置）")
  assert.ok(reply.reply.includes("codex opinion via row effort"))
  assert.ok(reply.reply.includes("falling back to nearest supported effort"), "回落 note 入回复")
  dropSession(sid)
})

test("R2 D-02 遗留: consult codex 行 runner.effort 优先于 row.effort（优先级链不变）", async () => {
  const cat = catalogSpawn([{ slug: "m-cc3", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }], { events: [], exitCode: 0, outText: "ok" })
  const sid = "r2-consult-roweff2"
  const state = sessionState(sid)
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] } }
  const deps = {
    ctx: {},
    agent,
    config: { consultModels: [{ runner: { kind: "codex-cli", model: "m-cc3", effort: "low", executable: "t-cc3-1" }, effort: "medium" }] },
    state, signal: undefined, spawn: cat.spawn, platform: "linux", env: {},
  }
  const r = await startConsultSession(deps, "problem brief", undefined)
  await checkConsultSession(state, r.id)
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
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
  const tm = truncated.match(/Approved\. Pass this exact token to eng_coder \(designToken parameter\): ([0-9a-f-]+:\d+:[0-9a-f]+)/)
  assert.ok(tm, "token 行完整保留在截断后尾部（retainTail 契约）")
  assert.equal(typeof tm[1], "string")
  assert.equal(validateDesignToken(tm[1]), true, "提取的 token 通过签名/过期校验（eng_coder 可签收）")
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  assert.ok(r4.includes("codex 路由: runner=codex-cli model=gpt-5.6-sol"), "codex 路由诊断（配置状态）")
  assert.ok(r4.includes("最近失败码: PROCESS_ERROR"), "codex 最近失败码")
  assert.ok(r4.includes("dsh 回落路由: qax:glm-5.3"), "dsh 回落路由诊断（配置状态）")
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const cfg2 = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax-fixed", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" } } } } // 无 dsh 回落路由
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", effort: "medium" } } }
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
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "qax", model: "glm-5.3", effort: "medium", timeoutMs: 300000 } } })
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3" } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } } // >cap → jobs 派发
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
      round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 300000 },
      convergence: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 300000 },
    },
  }
  const r2 = await runAdvisorReview(deps, { agent, config: configSync, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false })
  assert.ok(r2.startsWith("Error"), "≤cap 同步调用在飞期间被拒（D-06 扩展：全部入口单飞）")
  assert.ok(r2.includes("advisor-codex-1"), "拒绝文本含在飞 job id")
  assert.ok(r2.includes("job_output"), "拒绝文本含接续方式")
  assert.ok(r2.includes("未派发"), "明确本次未派发")
  assert.equal(specs.length, 1, "无第二个 job 派发")

  // 在飞期间：dsh 主路径调用同样被拒（同机制任意路由——无入口例外；若未拒会调用 llm 抛错）
  const configDsh = { advisor: { round1: { provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  const cfgOver = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const deps1 = makeEscDeps(sid, spawn, cfgOver)
  deps1.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps1, "first long task", undefined)
  assert.ok(out1.includes("escalate-codex-1"), ">cap 首次派发后台 job（占位 escalate 槽位）")
  assert.equal(specs.length, 1)
  // 在飞期间：≤cap 同步预算调用（codex 行 300000 ≤ cap）被拒——R2 只覆盖派发入口，补丁轮提前到机制入口
  const cfgSync = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 300000 } }], codexCli: { executable: process.execPath } }
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
  const cfgOver = { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-5.6-sol", timeoutMs: 900000 } }], codexCli: { executable: process.execPath } }
  const deps1 = makeEscDeps(sid, spawn, cfgOver)
  deps1.ctx = { get: (svc) => (svc === "jobs" ? jobs : null) }
  const out1 = await runEscalate(deps1, "first long task", undefined)
  assert.ok(out1.includes("escalate-codex-1"), ">cap 首次派发后台 job（占位 escalate 槽位）")
  // 在飞期间：dsh 行（非 codex runner）调用同样被拒——若未拒将走 dsh 分支触碰 llm/subagents
  let dshTouched = false
  const cfgDsh = { consultModels: [{ provider: "qax", model: "glm-5.3", effort: "medium" }] }
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
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath }, engCoderEffort: "off" })
  const out1 = await runEngCoder(deps, { task: "implement a (long)", designToken: token, docs: [] })
  assert.ok(out1.includes("eng-codex-1"), ">cap 首次派发后台 job（占位 eng 槽位）")
  assert.equal(specs.length, 1)
  // 在飞期间：≤cap 同步预算（defaultTimeoutMs=300000 ≤ cap）调用被拒——入口即拒，runCodexTask 未被触碰
  const { deps: deps2, token: token2 } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath, defaultTimeoutMs: 300000 }, engCoderEffort: "off" })
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
  const { deps, token } = makeEngDepsR2(sid, jobs, spawn, { codexCli: { engCoderRunner: "codex-cli", model: "gpt-5.6-sol", executable: process.execPath }, engCoderEffort: "off" })
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
    config: { consultModels: [{ provider: "qax", model: "glm-5.3" }], codexCli: { budgetCapMs: 250 } },
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
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 300000 } } }
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
  out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":{"kind":"codex-cli","model":"gpt-5.6-sol","effort":"high"}}', deps)
  assert.ok(out.startsWith("advisor_config: set round1.runner"))
  assert.deepEqual(state.advisorOverride.round1.runner, { kind: "codex-cli", model: "gpt-5.6-sol", effort: "high" })
  // 字符串 "dsh" → 显式切回 dsh（回落硬停修正指引 2 的通道）
  out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":"dsh"}', deps)
  assert.deepEqual(state.advisorOverride.round1.runner, { kind: "dsh" }, "dsh 显式回切（非 codex 分支，回落既有链）")
  // 面三（resolve 链消费）：override runner=codex-cli → codex 路由生效
  state.advisorOverride.round1.runner = { kind: "codex-cli", model: "gpt-5.6-sol" }
  const route = resolveAdvisorRoute({ config: deps.config, override: state.advisorOverride, agentOpts: {}, advisorRound: 0 })
  assert.equal(route.provider, "codex-cli", "会话覆盖 runner 真正生效（codex 分支——一期已支持，工具面今通）")
  assert.equal(route.model, "gpt-5.6-sol")
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
    const out = runAdvisorConfigTool('{"action":"set","path":"round1.runner","value":{"kind":"codex-cli","model":"gpt-5.6-sol"}}', deps)
    assert.ok(out.startsWith("advisor_config: set round1.runner"), "set 成功: " + out)
    // 面 2：落盘（index.mjs advisor_config set 写点的同一视图链路：sessionStateViewWithGeneration）
    assert.ok(saveSessionState(sid, sessionStateViewWithGeneration(state), home), "落盘成功")
    const entry = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid]
    assert.deepEqual(entry.advisorOverride.round1.runner, { kind: "codex-cli", model: "gpt-5.6-sol" },
      "持久化白名单保留 runner（D-13：此前 sanitizeAdvisorOverride 丢弃——重启即失）")
    // 模拟重启：loadSessionState（normalizeRestored）→ runner 仍在
    const snap = loadSessionState(sid, home)
    assert.deepEqual(snap.advisorOverride.round1.runner, { kind: "codex-cli", model: "gpt-5.6-sol" }, "恢复侧 runner 保留")
    // 面 3：恢复的 override 继续被解析链消费（往返闭合）
    const route = resolveAdvisorRoute({ config: {}, override: snap.advisorOverride, agentOpts: {}, advisorRound: 0 })
    assert.equal(route.ok, true)
    assert.equal(route.provider, "codex-cli", "恢复的 runner 继续生效（codex 路由）")
    assert.equal(route.model, "gpt-5.6-sol")
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
    config: { consultModels: [{ provider: "qax", model: "glm-5.3", effort: "high" }] },
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
    advisor: { round1: { provider: "qax", model: "glm-5.3", effort: "high", timeoutMs: 300000 } },
  }))
  assert.equal(streamOptsSeen[0].reasoningEffort, "high", "接线级：effort 原样透传进 stream opts（元数据缺失不拦截）")
  assert.ok(r.value.includes("passed through unverified"), "透传 note 入结果尾部")
  assert.ok(r.warnings.some((w) => w.includes("effort metadata unavailable")), "响亮告警 console.warn 留档")
  assert.ok(r.value.includes("| 1 |"), "评审照常交付（fail-open 绝不砖化）")
  dropSession(sid)
})

// ————————————— R4 收尾微修复轮：D-25 TOKEN_SECRET 密钥源 + jobs 派发 warnPrefix —————————————

test("R4 D-25: env THINCODER_TOKEN_SECRET 有值 → 用 env（优先于既有持久化文件，不读盘不写盘；空白串视为未设）", async () => {
  const { resolveTokenSecret } = await import("../lib/advisor.mjs")
  const home = mkdtempSync(join(tmpdir(), "d25-env-"))
  try {
    // 预置持久化密钥，证明 env 优先级更高
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(join(home, ".thincoder", "token-secret"), "persisted-secret-value\n")
    assert.equal(resolveTokenSecret({ THINCODER_TOKEN_SECRET: "env-secret-value" }, home), "env-secret-value", "env 有值 → 用 env")
    // 空白串 = 未设 → 走持久化链
    assert.equal(resolveTokenSecret({ THINCODER_TOKEN_SECRET: "   " }, home), "persisted-secret-value", "空白 env 视为未设 → 读持久化")
    // env 分支不动盘上文件
    assert.equal(readFileSync(join(home, ".thincoder", "token-secret"), "utf8").trim(), "persisted-secret-value", "env 路径不写盘")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("R4 D-25: 无 env 有路径 → 生成 randomBytes(32).hex 持久化；清缓存重解析（模块级缓存模拟重启）密钥稳定，在途 token 不失效", async () => {
  const { resolveTokenSecret, resolveTokenSecretPath, resetTokenSecretCacheForTests, validateDesignToken } = await import("../lib/advisor.mjs")
  const home = mkdtempSync(join(tmpdir(), "d25-persist-"))
  const home2 = mkdtempSync(join(tmpdir(), "d25-other-"))
  const savedHome = process.env.DSH_HOME
  const savedSecret = process.env.THINCODER_TOKEN_SECRET
  const mint = (secret) => {
    const payload = "d25-" + Math.random().toString(16).slice(2) + ":" + (Date.now() + 3600_000)
    return payload + ":" + createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
  }
  try {
    delete process.env.THINCODER_TOKEN_SECRET
    process.env.DSH_HOME = home
    // 无状态解析器：首次解析 → 生成 64hex 密钥并持久化到 $DSH_HOME/.thincoder/token-secret
    const s1 = resolveTokenSecret({}, home)
    assert.match(s1, /^[0-9a-f]{64}$/, "crypto.randomBytes(32).hex 形态")
    assert.equal(resolveTokenSecretPath(home), join(home, ".thincoder", "token-secret"), "路径复用 dsh-home.mjs 解析链（与 token-store 同源）")
    assert.ok(existsSync(resolveTokenSecretPath(home)), "持久化文件生成")
    assert.equal(readFileSync(resolveTokenSecretPath(home), "utf8").trim(), s1, "文件内容 = 密钥")
    // 模块级单例（生产消费路径 tokenSecret()）经公共行为驱动：清缓存 → validateDesignToken 以 home 的密钥验签
    resetTokenSecretCacheForTests()
    assert.equal(validateDesignToken(mint(s1)), true, "单例从持久化文件解析 → 与 s1 同密钥（签名通过）")
    // 模拟重启：清缓存（= 新进程的空缓存）→ 重解析 → 读同一持久化文件 → 同一密钥 → 在途 token 仍有效
    resetTokenSecretCacheForTests()
    assert.equal(validateDesignToken(mint(s1)), true, "重启后密钥稳定——在途 token 不因重启失效")
    // 负对照：换 home（另一密钥域）→ 清缓存重解析生成新密钥 → 旧 token 失效（证明重解析真实发生、密钥按 home 隔离）
    process.env.DSH_HOME = home2
    resetTokenSecretCacheForTests()
    assert.equal(validateDesignToken(mint(s1)), false, "不同 DSH_HOME → 新密钥 → 旧 token 失效（缓存清零真实生效）")
  } finally {
    if (savedSecret === undefined) delete process.env.THINCODER_TOKEN_SECRET
    else process.env.THINCODER_TOKEN_SECRET = savedSecret
    process.env.DSH_HOME = savedHome
    resetTokenSecretCacheForTests() // 后续测试（默认密钥口径 makeEngToken）从恢复后的 env 重新解析
    rmSync(home, { recursive: true, force: true })
    rmSync(home2, { recursive: true, force: true })
  }
})

test("R4 D-25: 无 env 无路径（DSH_HOME 不可解析）→ 回落公开默认值 + 响亮告警「门禁不可信」", async () => {
  const { resolveTokenSecret } = await import("../lib/advisor.mjs")
  // cwdHint 指向无 profile 根特征的深层临时目录（向上探测不命中——同 config-api.test U 系先例）
  const noRoot = mkdtempSync(join(tmpdir(), "d25-nopath-"))
  try {
    const r = await captureWarn(() => resolveTokenSecret({}, null, noRoot))
    assert.equal(r.value, "thincoder-default-secret", "回落公开默认值（fail-open——门禁不砖化但响亮告警）")
    assert.ok(r.warnings.some((w) => w.includes("design token 门禁使用公开默认密钥，不可信")), "响亮告警：门禁不可信")
    assert.ok(r.warnings.some((w) => w.includes("THINCODER_TOKEN_SECRET") && w.includes("DSH_HOME")), "告警给出两条修正路径（env / DSH_HOME）")
  } finally {
    rmSync(noRoot, { recursive: true, force: true })
  }
})

test("R4 收尾 #4: advisor jobs 派发路径 warnPrefix 并入派发文本——与同步路径可见性一致（此前仅 console.warn 留档）", async () => {
  const { runAdvisorReview } = await import("../lib/advisor.mjs")
  const { jobs, specs } = fakeJobsFactory()
  const spawn = fakeSpawnFactory((args) => args.includes("--version") ? probeScript(args)
    : { events: [], exitCode: 0, outText: "| # | Issue | Detail |\n|---|---|---|\n| 1 | x | y |" })
  const sid = "jobs-warnprefix-r4"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  // 组内 runner + 显式 provider/model 并存 → route.warnings 非空（「被忽略」告警）；timeoutMs > budgetCap → jobs 派发
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, provider: "qax", model: "glm-5.3", timeoutMs: 900000 } } }
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
