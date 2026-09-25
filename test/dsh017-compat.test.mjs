// dsh017-compat.test.mjs — D-41 / D-42 的 0.1.7 兼容回归锁。
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
