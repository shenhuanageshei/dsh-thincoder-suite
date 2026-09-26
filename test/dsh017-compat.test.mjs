// dsh017-compat.test.mjs — D-41 / D-42 / D-46 / D-44 的 0.1.7 兼容回归锁（批 25 增 D-46/D-44 腿）。
//
// 两处都是「插件写的是 0.1.6 的契约、0.1.7 换了契约」：
// - D-41 消息模型：工具结果从 user+tool-result 块改成**独立 tool 角色消息**；
// - D-42 jobs owner：jobs.start 的 owner 从「当桶用的对象」改成「按 id 查活代理」。
// 每处都给两条腿：一条**行为腿**（走真实入口，桩只替掉网络那一层）+ 一条**静态锁**（把「只
// 允许一种写法」钉在源码字节上）——纯行为腿挡不住「换个地方又写回去」，纯静态锁挡不住「形状
// 对但接线错」，两者互补。
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { runAdvisorToolLoop } from "../lib/advisor.mjs"
import { ownerIdOf } from "../lib/job-owner.mjs"
// 批 26 搭车②：原中段 import 上移到文件首部（纯可读性；ESM 的 import 本就提升，语义零变化）。
import { computeDocHash, normalizeDocPath } from "../lib/doc-hash.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { runEngCoder } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { jobOutcome, PATH_FORMS } from "../lib/job-outcome.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB = (f) => join(PLUGIN_DIR, "lib", f)

// 隔离契约（对齐既有测试档）：本档的 job settle 会经 jobOutcome 尝试落盘（批 26 / D-45）——
// 显式置空 ⇒ home 不可解析 ⇒ 不落盘；A26-1/A26-2 用 dshHomeOverride 注入缝**定向**验证落盘面，
// 既有腿（D-41/D-42/D-44/D-46）由此保持零盘副作用。
process.env.DSH_HOME = ""

/** 两段式 llm 桩：第 1 次调用回一个 tool-call，第 2 次回正文收尾；两次的 streamOpts 全留存。 */
function makeToolCallLlm(toolName, argumentsJson) {
  const calls = []
  const llm = {
    stream(streamOpts) {
      calls.push(streamOpts)
      const n = calls.length
      return (async function* () {
        if (n === 1) {
          yield { type: "block-end", block: { type: "tool-call", id: "call-1", name: toolName, arguments: argumentsJson } }
          yield { type: "finish", reason: { kind: "tool-calls" } }
        } else {
          yield { type: "block-end", block: { type: "text", text: "REVIEW-BODY" } }
          yield { type: "finish", reason: { kind: "stop" } }
        }
      })()
    },
    calls,
  }
  return llm
}

// ————————————— D-41：消息模型（tool 角色） —————————————

test("D-41a 行为腿: 工具结果消息满足 0.1.7 的 tool 角色契约——无 user+tool-result 块、无孤儿 tool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-d41-"))
  try {
    writeFileSync(join(dir, "subject.txt"), "alpha\nbeta\n")
    const llm = makeToolCallLlm("read", JSON.stringify({ path: join(dir, "subject.txt") }))
    const out = await runAdvisorToolLoop({ llm }, {
      provider: "p", model: "m", system: "sys", firstUserText: "review this",
      cwd: dir, signal: undefined, sessionId: "d41-shape", timeoutMs: 5000,
    })
    assert.equal(out, "REVIEW-BODY", "两轮后正常收尾（无 Advisor: 失败前缀）")
    assert.equal(llm.calls.length, 2, "第 1 轮产工具调用、第 2 轮收尾")

    const msgs = [...llm.calls[1].messages]
    assert.equal(msgs[0].role, "user", "首条是 user")
    assert.equal(msgs[1].role, "assistant", "次条是带 tool-call 的 assistant")
    const call = msgs[1].content.find((b) => b.type === "tool-call")
    assert.ok(call, "assistant 带 tool-call 块")

    const tool = msgs[2]
    assert.equal(tool.role, "tool", "工具结果是**独立 tool 角色消息**（D-41 主判据）")
    assert.equal(tool.toolCallId, call.id, "toolCallId 与 tool-call id 配对")
    assert.equal(tool.isError, false, "isError 在消息级")
    assert.deepEqual(tool.source, { kind: "tool", callId: call.id }, "source 在消息级且指向同一 callId")
    assert.ok(Array.isArray(tool.content) && tool.content[0].type === "text", "content 直接是原始结果块数组")
    assert.equal(typeof tool.content[0].text, "string", "结果文本在位")

    // 负控（0.1.6 旧形状）：user 角色消息里不得再出现 tool-result 块
    for (const m of msgs) {
      assert.ok(!(m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b?.type === "tool-result")),
        "不得残留 0.1.6 的 user + tool-result 形状")
    }
    // 配对完整性：每条 tool 消息的前驱必须是带同一 id tool-call 的 assistant
    const open = new Set()
    for (const m of msgs) {
      if (m.role === "assistant") for (const b of m.content) if (b.type === "tool-call") open.add(b.id)
      else if (m.role === "tool") {
        assert.ok(open.has(m.toolCallId), "tool 消息必须有配对的前驱 tool-call（孤儿 = deepseek 抛 tool result has no matching call）")
        open.delete(m.toolCallId)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("D-41b 静态锁: lib/ 内不再构造 0.1.6 的 tool-result 块；压缩取文与 consult 渲染同批对齐", () => {
  const advisor = readFileSync(LIB("advisor.mjs"), "utf8")
  assert.equal((advisor.match(/type: "tool-result"/g) ?? []).length, 0, "advisor 不得再构造 0.1.6 旧形状")
  assert.equal((advisor.match(/role: "tool",/g) ?? []).length, 1, "恰一处 tool 角色消息构造点（toolResultMsg）")
  // 压缩守卫的取文位置必须随形状搬：新契约下结果文本在 content[0].text
  assert.ok(advisor.includes('(m.content?.[0]?.text ?? "")'), "keyFiles 取文按新形状")
  assert.equal((advisor.match(/content\[0\]\s*\.\s*content\?/g) ?? []).length, 0, "旧嵌套取文已清零")
  assert.ok(advisor.includes('const isToolResultMsg = (m) => m?.role === "tool"'), "判据单点在场")
  // consult 的主历史渲染必须放行 tool 角色（否则工具结果从注入历史里整条消失）
  const consult = readFileSync(LIB("consult.mjs"), "utf8")
  assert.ok(consult.includes('m.role !== "tool"'), "renderMainHistory 放行 tool 角色")
  assert.ok(consult.includes('m.role === "tool" ? "[tool result]"'), "tool 消息只留标记、不展开 content（预算守卫）")
})

// ————————————— D-42：jobs 的 owner 判据 —————————————

test("D-42a 契约腿: ownerIdOf —— agent.id 优先、回落 session.id、两者皆缺则响亮失败", () => {
  assert.equal(ownerIdOf({ id: "s1", session: { id: "s1" } }), "s1", "agent.id 优先")
  assert.equal(ownerIdOf({ session: { id: "s2" } }), "s2", "缺 agent.id 时回落 session.id（平台强制二者相等）")
  assert.equal(ownerIdOf({ id: "", session: { id: "s3" } }), "s3", "空串不算有效 id")
  for (const bad of [{}, null, undefined, { id: 42 }, { session: {} }, { id: "" }]) {
    assert.throws(() => ownerIdOf(bad), /owner 无法解析/,
      "缺 id 必须响亮失败，绝不静默回落成对象（0.1.7 会以 no live agent 拒收）: " + JSON.stringify(bad))
  }
})

test("D-42b 静态锁: 4 档 7 处 jobs.start 一律 ownerIdOf(agent)，零处直传 Agent 对象", () => {
  const files = ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]
  let starts = 0
  let owners = 0
  for (const f of files) {
    const src = readFileSync(LIB(f), "utf8")
    // 只数**调用点**（实参是对象字面量）——注释里的 jobs.start(spec) 不算派发点
    const s = (src.match(/jobs\.start\(\{/g) ?? []).length
    const o = (src.match(/owner: ownerIdOf\(agent\)/g) ?? []).length
    assert.equal(o, s, f + ": jobs.start 与 ownerIdOf 必须一一对应（" + o + " vs " + s + "）")
    assert.equal((src.match(/owner:\s*agent\s*,/g) ?? []).length, 0, f + ": 不得直传 Agent 对象（0.1.7 报 no live agent）")
    assert.ok(src.includes('from "./job-owner.mjs"'), f + ": 必须从单一事实源取 owner")
    starts += s
    owners += o
  }
  // 登记值（D-42）：0.1.7 之前 7 处写法一致、全部在 0.1.7 下抛 session "[object Object]" has no
  // live agent。新增派发点必须同批更新本锁（数字变了就是提醒）。
  assert.equal(starts, 7, "jobs.start 落点总数 = 7（登记值）")
  assert.equal(owners, 7)
})

// ═══════════════ D-46（0.1.7 作业输出契约）· D-44（指纹基座） ═══════════════
//
// 本批新增腿（设计档 §6.1 锚 A1/A2/A3/A4）。D-46 的四条腿全部走**真实入口**
// （`runEscalate` 的 dsh 后台派发 = 4 档 7 处 jobs.start 之一），只桩掉网络与平台服务——
// 纯静态锁挡不住「形状对但接线错」（append 了、但 append 的不是正文），行为腿挡不住
// 「换个地方又写回 run: ()」⇒ 两条腿都给。
//
// 注意：0.1.7 的 `spec.run(handle)` **带参**；本档的假 jobs 服务必须把 handle 传下去
// （既有测试里的 fakeJobsFactory 是 0.1.6 形态的无参调用——它靠 handle 可选链仍绿，但
// 证明不了「正文进了环」）。这里的假服务 = 0.1.7 形态：调 `spec.run(handle)` 并记录 append。

/** 0.1.7 形态的假 jobs 服务：调 `spec.run(handle)`，把 handle 的 append 调用逐次记下来。 */
function fakeJobs017(handle) {
  const specs = []
  const appended = []
  const runArgs = []
  const jobs = {
    start(spec) {
      runArgs.push(spec.run.length) // run 的形参个数（0.1.7 契约 = 1：handle）
      const hooks = spec.run(handle)
      specs.push({ spec, hooks })
      return (spec.kind ?? "job") + "-" + specs.length
    },
  }
  return { jobs, specs, appended, runArgs }
}

/** dsh 后台行的一次真实派发：返回 { appended, outcome, runArgs, dispatchText }。 */
async function driveEscalateDshJob(sid, body) {
  const handle = {
    id: "job-" + sid,
    append(text, options) { this.calls.push({ text, options }) },
    updateProgress() { /* 平台进度行：本批不用 */ },
    calls: [],
  }
  const { jobs, specs, runArgs } = fakeJobs017(handle)
  const st = sessionState(sid)
  const subagents = {
    async start() {
      return {
        result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: body }] }),
        dispose: async () => { /* 无资源 */ },
      }
    },
  }
  const deps = {
    ctx: { subagents, get: (s) => (s === "jobs" ? jobs : null) },
    agent: { session: { id: sid, header: { delegationDepth: 0, cwd: tmpdir() } } },
    config: { consultModels: [{ provider: "p", model: "m" }], dshBackgroundTimeoutMs: 1000 },
    state: st,
    signal: undefined,
  }
  const dispatchText = await runEscalate(deps, "dsh background work", undefined, false, true)
  const outcome = await specs[0].hooks.done
  dropSession(sid)
  return { handle, appended: handle.calls, outcome, runArgs, dispatchText, specs }
}

test("D-46a 契约腿（锚 A1）: spec.run(handle) 收到 0.1.7 句柄；正文经 handle.append 进输出环，且 append 的文本 = 正文", async () => {
  const BODY = "did the work\n\nTouched files: none"
  const r = await driveEscalateDshJob("d46a-esc-dsh", BODY)
  {
    assert.deepEqual(r.runArgs, [1], "run 的形参个数 = 1（0.1.7 的 run(handle)；0.1.6 的无参版本收不到环）")
    assert.equal(r.specs.length, 1, "恰一次 jobs.start")
    assert.ok(r.dispatchText.includes("dsh"), "前置：确实走了 dsh 后台派发（不是同步快路径）")
    assert.equal(r.appended.length, 1, "正文恰 append 一次（0.1.7 的读法只认输出环，不读 job.output）")
    assert.equal(typeof r.appended[0].text, "string", "append 的实参是字符串")
    assert.equal(r.appended[0].text, r.outcome.result, "append 的文本 = outcome.result（同一段正文，不是两种拼法）")
    assert.ok(r.appended[0].text.includes(BODY), "append 的文本含子代理正文（报告没丢）")
    assert.ok(r.appended[0].text.startsWith("escalate ("), "append 的文本是本 job 的交付正文（不是状态行）")
  }
})

test("D-46b 契约腿（锚 A2）: outcome 同时含 result 与 output 且同值；detail 仍是短句", async () => {
  const BODY = "REPORT-BODY-46B\n\nTouched files: none"
  const r = await driveEscalateDshJob("d46b-esc-dsh", BODY)
  assert.equal(r.outcome.status, "completed", "前置：成功终态")
  assert.equal(typeof r.outcome.result, "string", "result 在场（0.1.7 的 settle 只写 job.result）")
  assert.equal(typeof r.outcome.output, "string", "output 在场（0.1.6/rc.1 读它）")
  assert.equal(r.outcome.output, r.outcome.result, "两字段同值别名（决策 D25-1：写两处只为旧运行时不丢正文）")
  assert.ok(r.outcome.result.includes(BODY), "正文在正文里")
  // detail 进的是状态行/完成通知——短句，不含正文、不含换行
  assert.ok(!r.outcome.detail.includes(BODY), "detail 不得夹正文： " + r.outcome.detail)
  assert.ok(!r.outcome.detail.includes("\n"), "detail 不得含换行： " + r.outcome.detail)
  assert.ok(r.outcome.detail.length <= 64, "detail 是短句（实测 " + r.outcome.detail.length + " 字符）")
})

test("D-44a（锚 A3 · A4）: 同一份文档，绝对路径指纹 == 「相对路径 + 基座」指纹，且指纹非空", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-d44a-"))
  try {
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "a.md"), "# A\n\n同一个文件，两种写法。\n")
    const byAbs = computeDocHash([join(dir, "docs", "a.md")])
    const byRel = computeDocHash([join("docs", "a.md")], dir) // 相对路径 + 显式基座（会话 cwd）
    assert.equal(byAbs.ok, true, "绝对路径可读")
    assert.equal(byRel.ok, true, "相对路径 + 基座可读（改动前这里恒 ok:false）")
    assert.ok(byAbs.hash.length > 0, "指纹非空")
    assert.equal(byRel.hash, byAbs.hash, "同一份临时 md：两种算法必须同一指纹")
    assert.deepEqual(byRel.docPaths, byAbs.docPaths, "落盘路径表也同一份（同一次归一）")
    assert.equal(byAbs.docPaths[0], normalizeDocPath(join("docs", "a.md"), dir), "归一规则单点：resolve(基座, p) + 反斜杠归一")
    // 负控：换个基座 ⇒ 读不到（证明基座真的被用了，而不是碰巧 cwd 也对）
    const otherDir = mkdtempSync(join(tmpdir(), "thincoder-d44a-other-"))
    try {
      assert.equal(computeDocHash([join("docs", "a.md")], otherDir).ok, false,
        "换基座 ⇒ fail-closed（否则说明基座形同虚设）")
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("D-44b（锚 A3 反向腿）: 缺基座行为与改动前逐字一致——resolve(p) 为锚 + fail-closed 不变", () => {
  const dir = mkdtempSync(join(tmpdir(), "thincoder-d44b-"))
  try {
    mkdirSync(join(dir, "docs"), { recursive: true })
    writeFileSync(join(dir, "docs", "a.md"), "# A\n")
    const rel = join("docs", "a.md")
    // ① 归一逐字一致：旧实现 = resolve(String(p))，缺基座/空串/非字符串（.map 传下标）都走它
    assert.equal(normalizeDocPath(rel), resolve(rel).replace(/\\/g, "/"), "缺基座 = resolve(p)（改动前逐字）")
    assert.equal(normalizeDocPath(rel, undefined), normalizeDocPath(rel), "undefined 基座 = 旧行为")
    assert.equal(normalizeDocPath(rel, null), normalizeDocPath(rel), "null 基座 = 旧行为")
    assert.equal(normalizeDocPath(rel, ""), normalizeDocPath(rel), "空串基座 = 旧行为")
    assert.equal(normalizeDocPath(rel, 1), normalizeDocPath(rel), ".map 下标当基座传进来也不许抛（旧调用点兼容）")
    assert.deepEqual([rel, rel].map(normalizeDocPath), [normalizeDocPath(rel), normalizeDocPath(rel)],
      "list.map(normalizeDocPath) 的既有写法逐个同值（下标被忽略）")
    // ② fail-closed 方向不变：相对路径按默认基座（process.cwd()）读不到 —— 仍返回 ok:false + missing 清单
    const onlyUnderDir = join("d44b-only-here", "x.md")
    mkdirSync(join(dir, "d44b-only-here"), { recursive: true })
    writeFileSync(join(dir, "d44b-only-here", "x.md"), "x\n")
    const noBase = computeDocHash([onlyUnderDir])
    assert.equal(noBase.ok, false, "缺基座 + 相对路径 ⇒ fail-closed（行为不变）")
    assert.deepEqual(noBase.missing, [normalizeDocPath(onlyUnderDir)], "missing 清单 = 旧的归一路径")
    assert.equal(noBase.reason, "unreadable", "reason 不变")
    // ③ 同一串给了基座就读得到（这就是 D-44 要修的那一格）
    const withBase = computeDocHash([onlyUnderDir], dir)
    assert.equal(withBase.ok, true, "显式基座 ⇒ 可读（D-44 的修复面）")
    assert.deepEqual(withBase.docPaths, [normalizeDocPath(onlyUnderDir, dir)])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ————————————— D-46 静态锁（设计锚 A5 / AC-4）：7 处 jobs.start 的 run 形参必须全是 handle 形 —————————————
// 行为腿（D-46a 的 runArgs 断言）只覆盖**被走到的那一处**；这条锁覆盖**全部 7 处**：任何一处被改回无参
// `run: () =>` ⇒ 该档 handle 数 < jobs.start 数 ⇒ 当场红（US-4「改回旧契约即红灯」对 7/7 成立）。
test("D-46-static (锚 A5 / AC-4): 4 档 jobs.start 与 run: (handle) 一一对应（合计 7），零处无参 run", () => {
  const files = ["advisor", "consult", "eng", "escalate"]
  let starts = 0, handles = 0, bare = 0
  for (const name of files) {
    const src = readFileSync(new URL("../lib/" + name + ".mjs", import.meta.url), "utf8")
    const s = (src.match(/jobs\.start\(\{/g) ?? []).length
    const h = (src.match(/run:\s*\(handle\)\s*=>/g) ?? []).length
    const z = (src.match(/run:\s*\(\)\s*=>/g) ?? []).length
    assert.equal(z, 0, name + ".mjs 不得残留无参 run: () =>")
    assert.equal(h, s, name + ".mjs 的 run: (handle) 数必须等于 jobs.start 数（实得 " + h + " vs " + s + "）")
    starts += s; handles += h; bare += z
  }
  assert.equal(starts, 7, "4 档 jobs.start 合计 = 7（登记值；新增派发点必须同批更新本锁）")
  assert.equal(handles, 7, "run: (handle) 合计 = 7（登记值）")
  assert.equal(bare, 0)
})
// ═══════════════ 批 26 · A26-1/A26-2（D-45 落盘）⊕ A26-5（搭车① 墙钟文案） ═══════════════
//
// A26-1：环里在写的同时盘上出现内容一致的正文文件（AC-1/AC-6：同一目录 + index.jsonl 记
// pathForm）。A26-2：落盘目录不可写 ⇒ 只 warn、不抛、不改 outcome（D26-2：兜底不得成为新的
// 失败源）。两条都经 dshHomeOverride 注入缝定向到临时目录（生产解析链 pickDshHome 不受干扰）。

test("A26-1 落盘腿 (D-45 / AC-1·AC-6): jobOutcome 环里在写，盘上同时出现内容一致的正文文件 + index.jsonl 记 pathForm", () => {
  const home = mkdtempSync(join(tmpdir(), "thincoder-a26-1-"))
  try {
    const calls = []
    const handle = { id: "advisor-dsh-1", append(text, options) { calls.push({ text, options }) } }
    const BODY = "REPORT-BODY-A26-1\n\nTouched files: lib/x.mjs"
    const out = jobOutcome(handle, { status: "completed", detail: "review delivered", output: BODY },
      { dshHomeOverride: home, pathForm: "session-state" })
    const dir = join(home, ".thincoder", "jobs")
    const file = join(dir, "advisor-dsh-1.txt")
    assert.equal(existsSync(file), true, "落盘文件存在（AC-1 的存在性判据）")
    assert.equal(readFileSync(file, "utf8"), BODY, "落盘内容 = 报告正文（AC-1）")
    assert.equal(calls.length, 1, "环里在写（0.1.7 契约不因落盘而旁路）")
    assert.equal(calls[0].text, BODY, "环里的文本 = 落盘的正文（同一段，不是两种拼法）")
    assert.equal(out.result, BODY, "result 别名不变（批 25 契约零回归）")
    const rows = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(rows.length, 1, "index.jsonl 恰一行（单行 JSON + append）")
    const row = rows[0]
    assert.deepEqual(Object.keys(row).sort(), ["at", "bytes", "jobId", "kind", "pathForm"], "行形状 = { jobId, kind, at, bytes, pathForm }")
    assert.equal(row.jobId, "advisor-dsh-1", "jobId 原值入档（文件名才做字符收窄）")
    assert.equal(row.kind, "advisor-dsh", "kind 由 branded id 前缀派生（<kind>-N，平台契约要点 #1）")
    assert.equal(row.bytes, Buffer.byteLength(BODY, "utf8"), "bytes = 正文字节数")
    assert.ok(PATH_FORMS.includes(row.pathForm), "pathForm 在钉死枚举内")
    assert.equal(row.pathForm, "session-state", "advisor 记自己的 pathForm（批 26 §2.1.4：advisor ⇒ session-state）")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A26-1b 落盘边缘 (D-45): 空报告也写文件（pathForm=none）· 无 handle.id 不落盘（D26-7 的兼容代价如实执行）", () => {
  const home = mkdtempSync(join(tmpdir(), "thincoder-a26-1b-"))
  try {
    jobOutcome({ id: "eng-dsh-9", append() {} }, { status: "completed", detail: "d", output: "" }, { dshHomeOverride: home })
    const dir = join(home, ".thincoder", "jobs")
    assert.equal(existsSync(join(dir, "eng-dsh-9.txt")), true, "空报告也写文件（AC 判据 = 文件存在）")
    assert.equal(readFileSync(join(dir, "eng-dsh-9.txt"), "utf8"), "", "内容为空串")
    const rows = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.equal(rows[0].pathForm, "none", "无正文 ⇒ pathForm=none（钉死枚举的一态）")
    // 无 handle.id ⇒ 不落盘（旧运行时不传 handle ⇒ 无 id ⇒ 静默跳过，不抛）
    const before = existsSync(dir) ? readdirSync(dir).length : 0
    const out = jobOutcome({ append() {} }, { status: "completed", detail: "d", output: "x" }, { dshHomeOverride: home })
    const after = existsSync(dir) ? readdirSync(dir).length : 0
    assert.equal(after, before, "无 handle.id ⇒ 不落盘")
    assert.equal(out.result, "x", "无 id 不影响收口本体（环/result 照常）")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A26-1 扩展 (评审 #5): index.jsonl 末行可解析为 {jobId,kind,at,bytes,pathForm} 且 pathForm ∈ 钉死枚举——跨 advisor/consult/eng/escalate 各跑一次", () => {
  // 四条机制各跑一次收口点（设计档 §2.1.3/§2.1.4：pathForm 由收口点按本次结算实际携带正文的
  // 通道判定——advisor=session-state · consult=consult-minutes · eng/escalate 调用点不传 ⇒
  // 正文非空推断为 result）。静态腿证明四机制的调用面确实如此传值：行为腿不是自说自话。
  const home = mkdtempSync(join(tmpdir(), "thincoder-a26-1x-"))
  try {
    const dir = join(home, ".thincoder", "jobs")
    const lastRow = () => {
      const lines = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n")
      const row = JSON.parse(lines[lines.length - 1])
      assert.deepEqual(Object.keys(row).sort(), ["at", "bytes", "jobId", "kind", "pathForm"],
        "末行形状 = { jobId, kind, at, bytes, pathForm }")
      assert.ok(PATH_FORMS.includes(row.pathForm), "pathForm ∈ 钉死枚举：" + String(row.pathForm))
      return row
    }
    // advisor ⇒ session-state（与其 jobOutcome 调用点实传值一致）
    jobOutcome({ id: "advisor-dsh-1", append() {} }, { status: "completed", detail: "d", output: "ADVISOR-BODY" },
      { dshHomeOverride: home, pathForm: "session-state" })
    let row = lastRow()
    assert.equal(row.jobId, "advisor-dsh-1")
    assert.equal(row.kind, "advisor-dsh", "kind 由 branded id 前缀派生")
    assert.equal(row.pathForm, "session-state", "advisor ⇒ session-state（§2.1.4）")
    // consult ⇒ consult-minutes
    jobOutcome({ id: "consult-1", append() {} }, { status: "completed", detail: "d", output: "CONSULT-DIGEST" },
      { dshHomeOverride: home, pathForm: "consult-minutes" })
    row = lastRow()
    assert.equal(row.kind, "consult")
    assert.equal(row.pathForm, "consult-minutes", "consult ⇒ consult-minutes（§2.1.4）")
    // eng（调用点不传 pathForm ⇒ 非空正文推断为 result）
    jobOutcome({ id: "eng-dsh-1", append() {} }, { status: "completed", detail: "d", output: "ENG-REPORT" },
      { dshHomeOverride: home })
    row = lastRow()
    assert.equal(row.kind, "eng-dsh")
    assert.equal(row.pathForm, "result", "eng ⇒ result（调用点不传 + 非空正文推断）")
    // escalate（同 eng 推断）
    jobOutcome({ id: "escalate-dsh-1", append() {} }, { status: "completed", detail: "d", output: "ESC-REPORT" },
      { dshHomeOverride: home })
    row = lastRow()
    assert.equal(row.kind, "escalate-dsh")
    assert.equal(row.pathForm, "result", "escalate ⇒ result（调用点不传 + 非空正文推断）")
    // 追加语义：四行齐在，末行是 escalate（「末行」判据真实成立，不是首行碰巧对）
    const all = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n")
    assert.equal(all.length, 4, "四机制各恰一行")
    assert.equal(JSON.parse(all[all.length - 1]).kind, "escalate-dsh")
    // 静态腿：调用面的实传值（登记值；新增/删除 jobOutcome 调用点须两处同改）
    const advisorSrc = readFileSync(LIB("advisor.mjs"), "utf8")
    const consultSrc = readFileSync(LIB("consult.mjs"), "utf8")
    assert.equal((advisorSrc.match(/jobOutcome\(handle,/g) ?? []).length, 6, "advisor jobOutcome 调用点 = 6（登记值）")
    assert.equal((advisorSrc.match(/pathForm: "session-state"/g) ?? []).length, 6, "advisor 6 处全部实传 session-state")
    assert.equal((consultSrc.match(/jobOutcome\(handle,/g) ?? []).length, 3, "consult jobOutcome 调用点 = 3（登记值）")
    assert.equal((consultSrc.match(/pathForm: "consult-minutes"/g) ?? []).length, 3, "consult 3 处全部实传 consult-minutes")
    for (const name of ["eng.mjs", "escalate.mjs"]) {
      assert.equal((readFileSync(LIB(name), "utf8").match(/pathForm:/g) ?? []).length, 0,
        name + " 调用点零处实传 pathForm（缺省推断是其契约的一部分——传了反而两路判据不一）")
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A26-2 只 warn 腿 (D-45 / AC-2): 落盘目录不可写 ⇒ 只 warn，不抛、不改 outcome", () => {
  const home = mkdtempSync(join(tmpdir(), "thincoder-a26-2-"))
  try {
    // 把 home 钉成一个**文件** ⇒ mkdir(join(home, ".thincoder", "jobs")) 必 ENOTDIR（不可写形态）
    const blocker = join(home, "not-a-dir")
    writeFileSync(blocker, "x")
    const warnings = []
    const orig = console.warn
    let calls = []
    let out
    try {
      console.warn = (...a) => { warnings.push(a.map(String).join(" ")) }
      out = jobOutcome({ id: "eng-dsh-2", append: (t2) => calls.push(t2) },
        { status: "completed", detail: "eng_coder delivery", output: "BODY-A26-2" }, { dshHomeOverride: blocker })
    } finally {
      console.warn = orig
    }
    assert.equal(out.result, "BODY-A26-2", "outcome 原样返回（不改 outcome）")
    assert.equal(out.status, "completed", "作业终态不被落盘失败翻转")
    assert.equal(calls.join("|"), "BODY-A26-2", "环照写（兜底失败不拖累主契约）")
    assert.ok(warnings.some((w) => w.includes("落盘失败")), "落盘失败必须 warn 留痕（不许静默）：" + JSON.stringify(warnings))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A26-5 墙钟文案腿 (搭车① / AC-5): background=false 且 budgetCap ≥ 600000 ⇒ 返回文本点明「本路会白等」；低于墙钟 ⇒ 不出现", async () => {
  const escSrc = readFileSync(LIB("escalate.mjs"), "utf8")
  assert.ok(escSrc.includes("本路会白等") && escSrc.includes("background === false && budgetCap >= PLATFORM_RUN_CODE_WALL_MS"),
    "escalate 同款白等提示在场（同触发条件：background=false 且 cap ≥ PLATFORM_RUN_CODE_WALL_MS）")
  const mk = (capMs) => {
    const sid = "a26-5-" + randomUUID()
    const st = sessionState(sid)
    st.engineering = true
    st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
    const subagents = {
      async start() {
        return {
          result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "delivered" }] }),
          dispose: async () => {},
        }
      },
    }
    const llm = {
      async resolveModelInfo() {
        return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
      },
    }
    return {
      sid,
      token: st.designToken,
      deps: {
        ctx: { subagents, llm },
        agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
        config: { codexCli: { budgetCapMs: capMs } },
        signal: undefined,
        configDefaultEngineering: false,
      },
    }
  }
  const hi = mk(600000)
  try {
    const out = await runEngCoder(hi.deps, { task: "implement x", designToken: hi.token, background: false })
    assert.ok(out.includes("本路会白等"), "cap=600000 ≥ PLATFORM_RUN_CODE_WALL_MS ⇒ 白等提示随回复带出：" + out.slice(0, 220))
    assert.equal(sessionState(hi.sid).mutatedThisRun, true, "前置：确实走完同步交付（告警 fail-open 不改返回路径）")
  } finally {
    dropSession(hi.sid)
  }
  const lo = mk(540000)
  try {
    const out2 = await runEngCoder(lo.deps, { task: "implement x", designToken: lo.token, background: false })
    assert.ok(!out2.includes("本路会白等"), "cap=540000 < 600000 ⇒ 不出现（阈值方向负控，否则天天误报）")
  } finally {
    dropSession(lo.sid)
  }
})

