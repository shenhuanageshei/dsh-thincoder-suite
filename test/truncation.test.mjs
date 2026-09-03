// truncation.test.mjs — D 复核回归锁（docs/2026-09-02-session-state-stages-design.md §4/§6）。
// T13：compactMessages 的 keyFiles 去重 + 上限 15（小改进——中段被压缩后评审不重复读已查文件）。
// T17：readonly-tools 的 MAX_RESULT_CHARS = 64K 与行感知截断续读指针行为断言
// （readonly-tools.mjs 本身不改——只加测试，锁死「上游 0.12.43 的 16K→64K 放宽已就位」）。
// F12 §8（评审 #3）：lastAdvisorOutput 落盘 32K 截断 + [truncated] 尾标记的回归锁（上限强制而非期望）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { compactMessages } from "../lib/advisor.mjs"
import { MAX_RESULT_CHARS, truncateResult } from "../lib/readonly-tools.mjs"
import {
  saveSessionState, loadSessionState, resolveSessionStorePath,
  LAST_ADVISOR_OUTPUT_MAX_CHARS, normalizeRestored,
} from "../lib/session-store.mjs"
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-tr-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }

// ————————————— T13：keyFiles 去重 + 上限 15 —————————————

function textMsg(text) {
  return { id: "t" + Math.random(), role: "user", content: [{ type: "text", text }], source: { kind: "user" } }
}

function toolResultMsg(text) {
  return {
    id: "m" + Math.random(), role: "user",
    content: [{
      type: "tool-result", toolCallId: "c" + Math.random(),
      content: [{ type: "text", text }], isError: false,
    }],
    source: { kind: "tool", callId: "c" },
  }
}

test("T13: compactMessages — ≤20 messages is a no-op; keyFiles deduped and capped at 15 in the compaction summary", () => {
  // ≤20 条 → 零变更（现行为保持）
  const small = [textMsg("hi")]
  for (let i = 0; i < 19; i++) small.push(toolResultMsg("f" + i + ".mjs\ncontent"))
  const lenBefore = small.length
  compactMessages(small)
  assert.equal(small.length, lenBefore, "≤20 messages → untouched")

  // >20 条：首条 user + 最近 20 条保留，中段以摘要替换
  // 结构：msgs[0] user 文本；msgs[1..25] 25 个 tool-result（全部落入中段，含重复文件首行）；
  // msgs[26..45] 20 条文本消息（保证窗口起点不落在 tool-result 上——不触发孤儿回退）。
  const firstLines = []
  for (let i = 0; i < 20; i++) firstLines.push("u" + i + ".mjs\n(200 lines of tool output)")
  firstLines.push("u0.mjs\nmore output", "u1.mjs\nmore output", "u0.mjs\nagain", "u5.mjs\nx", "u19.mjs\ny")
  const msgs = [textMsg("first user message")]
  for (const fl of firstLines) msgs.push(toolResultMsg(fl))
  for (let i = 0; i < 20; i++) msgs.push(textMsg("recent " + i))
  assert.equal(msgs.length, 46)
  compactMessages(msgs)
  assert.equal(msgs.length, 22, "first + summary + 20 recent")
  const summary = msgs[1].content[0].text
  assert.ok(summary.includes("[Context compacted] Earlier exploration: 25 tool calls completed."), summary)
  assert.ok(summary.includes("Key files examined: "), "key files part present")
  const listed = summary.split("Key files examined: ")[1].split(", ")
  assert.equal(listed.length, 15, "capped at 15 (was 5)")
  assert.equal(new Set(listed).size, 15, "deduplicated (was not)")
  for (const f of listed) assert.match(f, /^u\d+\.mjs$/, "file-like entry: " + f)
  assert.ok(listed.includes("u0.mjs"))
  assert.ok(listed.includes("u1.mjs"))
  // 保序（插入序）：u0 在 u1 前
  assert.ok(listed.indexOf("u0.mjs") < listed.indexOf("u1.mjs"))
  // 首条与最近窗口原样保留
  assert.equal(msgs[0].content[0].text, "first user message")
  assert.equal(msgs[2].content[0].text, "recent 0")
  assert.equal(msgs[21].content[0].text, "recent 19")

  // 不足 15 个唯一文件 → 全部保留（不虚增）
  const msgs2 = [textMsg("first")]
  for (let i = 0; i < 25; i++) msgs2.push(toolResultMsg("v" + (i % 6) + ".mjs\nout")) // 6 个唯一
  for (let i = 0; i < 20; i++) msgs2.push(textMsg("r " + i))
  compactMessages(msgs2)
  const listed2 = msgs2[1].content[0].text.split("Key files examined: ")[1].split(", ")
  assert.equal(listed2.length, 6, "all unique files kept when under the cap")
  assert.equal(new Set(listed2).size, 6)
})

test("T13-boundary: window start on a tool-result backs off (orphan-pair guard) — compaction keeps protocol pairing", () => {
  // 全 tool-result 的中段：起点回退到 start=1（唯一非 tool-result 边界），old 段为空 → 无 keyFiles
  const msgs = [textMsg("first")]
  for (let i = 0; i < 45; i++) msgs.push(toolResultMsg("z" + i + ".mjs\nout"))
  compactMessages(msgs)
  const summary = msgs[1].content[0].text
  assert.ok(summary.includes("[Context compacted]"))
  assert.ok(!summary.includes("Key files examined:"), "no orphan tool-result at the window start (backoff)")
  // 首条 + 摘要 + 回退后的 recent（slice(1) = 45 条全部保留——配对安全优先于窗口宽度）
  assert.equal(msgs.length, 47)
  assert.equal(msgs[2].content[0].type, "tool-result")
})

// ————————————— T17：截断阈值 + 续读指针回归锁（readonly-tools 不改） —————————————

test("T17: MAX_RESULT_CHARS is 64K; truncateResult small input unchanged; large input keeps line-aware prefix + continuation pointer", () => {
  // 阈值锁死：上游 0.12.43 的 16K→64K 放宽在本移植已就位（§4 事实）
  assert.equal(MAX_RESULT_CHARS, 64 * 1024)
  // 短结果原样（含多行）
  assert.equal(truncateResult("short"), "short")
  assert.equal(truncateResult("a\nb\nc"), "a\nb\nc")
  assert.equal(truncateResult(""), "")
  // 超限 → 行感知截断 + 截断标记 + 续读指针
  const lines = Array.from({ length: 5000 }, (_, i) => "L" + String(i).padStart(5, "0") + " " + "x".repeat(94))
  const big = lines.join("\n")
  assert.ok(big.length > MAX_RESULT_CHARS)
  const out = truncateResult(big)
  assert.ok(out.length < big.length)
  assert.ok(out.includes("… (truncated: "))
  const pointer = out.match(/read\(path, offset=(\d+), limit=200\)/)
  assert.ok(pointer, "continuation pointer present: " + out.slice(-160))
  const more = out.match(/… \(truncated: (\d+) more lines, (\d+) chars total\)/)
  assert.ok(more, "truncation marker with counts")
  const outLines = out.split("\n")
  const idx = outLines.findIndex(l => l.startsWith("… (truncated:"))
  assert.ok(idx > 0, "marker line present")
  const keptCount = idx - 1 // marker 前恰有一个空行（truncated 尾部 \n + 标记前导 \n）
  assert.equal(Number(pointer[1]), keptCount + 1, "pointer offset = first truncated line (1-based, resumable paging)")
  assert.equal(outLines.slice(0, keptCount).join("\n"), lines.slice(0, keptCount).join("\n"), "kept prefix byte-identical to the original")
  assert.equal(Number(more[1]), lines.length - keptCount, "more-lines count correct")
  assert.equal(Number(more[2]), big.length, "total chars count correct")
  // 截断不产生半行：保行完整性
  assert.ok(outLines[keptCount - 1].startsWith("L"), "last kept line is a complete line")
})

// ————————————— F12 §8（评审 #3）：lastAdvisorOutput 落盘 32K 截断回归锁 —————————————

test("F12-32K: >32K lastAdvisorOutput is truncated + [truncated] tail marker on disk; save/load roundtrip is idempotent (marker not doubled)", () => {
  assert.equal(LAST_ADVISOR_OUTPUT_MAX_CHARS, 32 * 1024, "cap locked at 32K (§8 上限强制)")
  const home = mkHome()
  const sid = "tr-32k"
  try {
    // 40K prior（超上限）→ 落盘截断
    const bigPrior = "| # | Category | Severity | Issue |\n" + "x".repeat(40 * 1024)
    assert.ok(bigPrior.length > LAST_ADVISOR_OUTPUT_MAX_CHARS)
    assert.equal(saveSessionState(sid, { advisorRound: 1, lastAdvisorOutput: bigPrior }, home), true)
    const file = JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8"))
    const onDisk = file.sessions[sid].lastAdvisorOutput
    assert.ok(onDisk.endsWith("[truncated]"), "tail marker present")
    assert.ok(onDisk.length > LAST_ADVISOR_OUTPUT_MAX_CHARS
      && onDisk.length <= LAST_ADVISOR_OUTPUT_MAX_CHARS + "\n[truncated]".length,
      "disk length = cap + marker (got " + onDisk.length + ")")
    assert.ok(onDisk.startsWith("| # | Category | Severity | Issue |"), "head kept")
    // 等长以内 → 原样
    const smallPrior = "y".repeat(1000)
    saveSessionState(sid, { advisorRound: 1, lastAdvisorOutput: smallPrior }, home)
    assert.equal(JSON.parse(readFileSync(resolveSessionStorePath(home), "utf8")).sessions[sid].lastAdvisorOutput, smallPrior)
    // 恢复路径幂等：restore→再 save→截断结果不变（标记恰在切片边界，重截断重建同一字符串，不叠加）
    saveSessionState(sid, { advisorRound: 1, lastAdvisorOutput: bigPrior }, home)
    const loaded = loadSessionState(sid, home)
    assert.ok(loaded.lastAdvisorOutput.endsWith("[truncated]"))
    saveSessionState(sid, loaded, home) // 已截断的再落一轮
    const reloaded = loadSessionState(sid, home)
    assert.equal(reloaded.lastAdvisorOutput, loaded.lastAdvisorOutput, "idempotent roundtrip (marker not doubled)")
    // 手写盘上超 32K 条目（绕过写侧）→ load 侧 normalizeRestored 同样截断
    mkdirSync(join(home, ".thincoder"), { recursive: true })
    writeFileSync(resolveSessionStorePath(home), JSON.stringify({
      version: 1, sessions: { bypass: { advisorRound: 1, lastAdvisorOutput: "z".repeat(33 * 1024), lastSeen: Date.now() } },
    }))
    const bypass = loadSessionState("bypass", home)
    assert.ok(bypass.lastAdvisorOutput.endsWith("[truncated]"), "load-side truncation of an externally oversized entry")
    assert.ok(bypass.lastAdvisorOutput.length <= LAST_ADVISOR_OUTPUT_MAX_CHARS + "\n[truncated]".length)
    // 直测 normalizeRestored 截断
    const norm = normalizeRestored({ advisorRound: 1, lastAdvisorOutput: "w".repeat(50 * 1024) })
    assert.ok(norm.lastAdvisorOutput.endsWith("[truncated]"))
  } finally { rmHome(home) }
})
