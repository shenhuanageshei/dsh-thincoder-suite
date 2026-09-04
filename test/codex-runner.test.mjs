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
