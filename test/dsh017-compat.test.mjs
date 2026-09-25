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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { runAdvisorToolLoop } from "../lib/advisor.mjs"
import { ownerIdOf } from "../lib/job-owner.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const LIB = (f) => join(PLUGIN_DIR, "lib", f)

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
import { mkdirSync } from "node:fs"
import { computeDocHash, normalizeDocPath } from "../lib/doc-hash.mjs"
import { runEscalate } from "../lib/escalate.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

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
