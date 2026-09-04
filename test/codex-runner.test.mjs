// codex-runner.test.mjs — 一期 codex-runner 单元测试（docs/2026-09-03-codex-runner-research.md §7.1 T1.1/T1.2/T1.5）。
// node:test 零依赖：adapter 用假子进程（deps.spawn 注入），不碰真实 codex / 不出网。
// 覆盖：B2/B4/B12 runner 校验、codexCli 全局节、envelope 错误码（注入法）、模型发现解析、
// advisor 路由 codex 分支、config 合并、escalate codex 行剔除、runAdvisorReview codex 路径。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  normalizeRunnerValue, validateRunnerValue, resolveCodexCliGlobals,
  buildCodexArgs, resolveExecutableFile, runCodexTask, discoverCodexModels, codexRowLabel,
} from "../lib/codex-adapter.mjs"
import { resolveAdvisorRoute } from "../lib/advisor.mjs"
import { resolveSupportedEffort, resolveCodexRowEffort } from "../lib/effort-resolve.mjs"
import { startConsultSession, checkConsultSession } from "../lib/consult.mjs"
import { mergeGlobalConfig } from "../lib/config-store.mjs"
import { validateGlobalUserConfig } from "../lib/index.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { runEngCoder } from "../lib/eng.mjs"
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
      return { id: "advisor-codex-1" }
    },
  }
  const sid = "jobs-dispatch-p2"
  const agent = { session: { id: sid, header: { cwd: tmpdir() }, deriveMessages: () => [] }, options: {} }
  const config = { advisor: { round1: { runner: { kind: "codex-cli", model: "gpt-5.6-sol" }, timeoutMs: 900000 } } }
  const out = await runAdvisorReview(
    { llm: { stream: () => { throw new Error("must not be used") } }, spawn, platform: "linux", env: {}, ctx: { get: (svc) => (svc === "jobs" ? jobs : null) } },
    { agent, config, reviewType: "code", paths: [], documents: [], signal: undefined, configDefaultEngineering: false },
  )
  assert.ok(out.includes("advisor-codex-1"), "返回平台 job id")
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
  const llm = reviewLlm([]) // 流直接结束：零块、零 finish
  const r = await captureWarn(() => runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } }))
  const out = r.value
  assert.ok(out.startsWith("Advisor: (empty response"), "返回语义不变（R1 不重试不烧轮次——留 R3）: " + out.slice(0, 80))
  assert.ok(out.includes("empty-response classification: finish-null"), "三形态之一：finish null")
  assert.ok(out.includes("stream observation: finish=null"), "观测字段：finish kind")
  assert.ok(out.includes("blocks(text=0,tool-call=0)"), "观测字段：block 计数")
  assert.ok(out.includes("usage=none"), "观测字段：usage")
  assert.ok(r.warnings.some((w) => w.includes("stream observation: finish=null")), "console.warn 留档（D-18）")
  dropSession(sid)
})

test("R1 D-01 观测: 空响应形态二 stop 零文本块 —— 分类行 + finish 携带的 usage 入观测", async () => {
  const sid = "r1-empty-stop"
  const llm = reviewLlm([
    { type: "finish", reason: { kind: "stop" }, usage: { inputTokens: 5, outputTokens: 0 } },
  ])
  const out = await runDshReview(sid, llm, { advisor: { round1: { provider: "p", model: "m", timeoutMs: 300000 } } })
  assert.ok(out.startsWith("Advisor: (empty response"))
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
  assert.ok(out.startsWith("Advisor: (empty response"))
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
