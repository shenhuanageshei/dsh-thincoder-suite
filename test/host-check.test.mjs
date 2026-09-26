// host-check.test.mjs — 批 27 宿主验收执行面的回归锚（设计档 docs/dsh017-batch27-design.md §5.1）。
//
// 覆盖：US-3 超时值域解析**单点**（A27-7 静态：解析字面在 lib/host-check.mjs 的**非注释行**上
// 恰好出现 1 处——批 27 分歧修复 D1：注释里的字面不是引用点，剥掉 // 注释行后再计数 +
// helper 行为 + 回执标注与真实生效值一致）· US-4 kill 收窄（A27-5：正常 close 不 kill、
// 超时仍 kill、spawn 抛错收敛）。
//
// 纪律：零真进程、零真实 120s 等待——一律走 A26-8 注入缝（假 spawnImpl + 毫秒级超时，
// 对齐 platform-surface.test.mjs 的 A26-8 先例）；无磁盘副作用、无 env 改写。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { runOneHostCheck, runHostStageChecks, effectiveTimeoutMs, HOST_CHECK_TIMEOUT_MS } from "../lib/host-check.mjs"

/** 假子进程工厂：记录 kill 次数；stdout/stderr/close/error 走同一张 handler 表，emit 驱动。 */
function makeFakeSpawn(deferClose) {
  const spawned = []
  const spawnImpl = () => {
    const hs = new Map()
    const push = (ev, fn) => hs.set(ev, [...(hs.get(ev) ?? []), fn])
    const child = {
      kills: 0,
      stdout: { on: (ev, fn) => push(ev, fn) },
      stderr: { on: (ev, fn) => push(ev, fn) },
      on: (ev, fn) => push(ev, fn),
      kill() { child.kills++ },
      emit(ev, arg) { for (const fn of hs.get(ev) ?? []) fn(arg) },
    }
    spawned.push(child)
    if (deferClose) setTimeout(() => child.emit("close", 0), 5)
    return child
  }
  return { spawnImpl, spawned }
}

/** 批 27 分歧修复 D1：计数只看**非注释行**——注释里的字面不是引用点（lib/host-check.mjs 头部的
 * 说明注释含 `effectiveTimeoutMs(opts)` 字面，全量计数被顶到 4 ⇒ 本用例出生即红）。剥掉 `//`
 * 注释行后再计数：注释措辞变化不再误伤，真出现第 2 个**代码**引用点时依然转红。 */
function countInCode(src, re) {
  return (src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n").match(re) ?? []).length
}

test("A27-7 静态 + helper 行为 (US-3 / AC-5): 超时值域解析字面在 lib/host-check.mjs 的非注释行上恰好出现 1 处，两处消费共用同一 helper", () => {
  const src = readFileSync(new URL("../lib/host-check.mjs", import.meta.url), "utf8")
  assert.equal(countInCode(src, /opts\.timeoutMs > 0/g), 1,
    "超时值域解析字面『opts.timeoutMs > 0』必须恰好在**代码行**出现 1 处（出现第 2 处 = 又开始手写解析；注释行不计——D1）")
  assert.ok(!src.includes("timeoutMsOf"), "被收编的 timeoutMsOf 零残留")
  assert.ok(src.includes("export function effectiveTimeoutMs(opts)"), "唯一 helper 在场且导出")
  assert.equal(countInCode(src, /effectiveTimeoutMs\(opts\)/g), 3,
    "定义 + runOneHostCheck（真实生效值）+ 回执文案（标注）三处**代码**引用恰好（注释行的字面不是引用点——D1；真出现第 2 个代码消费点即红）")
  // helper 行为：注入值域内生效、域外/缺省回落常量（改值域只改 helper 一处——A27-7 的本体）
  assert.equal(effectiveTimeoutMs(), HOST_CHECK_TIMEOUT_MS, "缺省回落")
  assert.equal(effectiveTimeoutMs(undefined), HOST_CHECK_TIMEOUT_MS, "缺省回落")
  assert.equal(effectiveTimeoutMs({}), HOST_CHECK_TIMEOUT_MS, "缺省回落")
  assert.equal(effectiveTimeoutMs({ timeoutMs: 40 }), 40, "注入值生效（A26-8 毫秒级注入缝）")
  assert.equal(effectiveTimeoutMs({ timeoutMs: 0 }), HOST_CHECK_TIMEOUT_MS, "非正数回落")
  assert.equal(effectiveTimeoutMs({ timeoutMs: -5 }), HOST_CHECK_TIMEOUT_MS, "负数回落")
  assert.equal(effectiveTimeoutMs({ timeoutMs: "40" }), HOST_CHECK_TIMEOUT_MS, "非有限数值回落")
})

test("A27-5 正常 close (US-4 / AC-3): 正常退出的假子进程未被 kill；输出照收、回执照常", async () => {
  const { spawnImpl, spawned } = makeFakeSpawn(false)
  const p = runOneHostCheck("echo hi", "C:\\nonexistent-cwd", { spawnImpl })
  const child = spawned[0]
  child.emit("data", "hello-from-fake\n")
  child.emit("close", 0)
  const out = await p
  assert.equal(out.code, 0, "close(0) 照常结算")
  assert.equal(out.timedOut, false, "非超时形态")
  assert.ok(out.tail.includes("hello-from-fake"), "尾部输出照收")
  assert.equal(child.kills, 0, "正常 close ⇒ 未被 kill（A27-5 主判据——批 26 在此多杀一次）")
})

test("A27-5 超时仍 kill (US-4 / AC-3): 永不 close 的假子进程到点收敛 timedOut 且被 kill", async () => {
  const { spawnImpl, spawned } = makeFakeSpawn(false)
  const out = await runOneHostCheck("never-ends", "C:\\nonexistent-cwd", { spawnImpl, timeoutMs: 25 })
  assert.equal(out.timedOut, true, "到点收敛为 timedOut 形态")
  assert.equal(out.code, null, "未收到 close ⇒ code 保持 null（与既有收敛契约一致）")
  assert.equal(spawned[0].kills, 1, "超时路径仍 kill")
})

test("A27-5 spawn 抛错 (US-4): 未收到 close ⇒ 照旧收敛（kill 为空操作不抛）", async () => {
  const out = await runOneHostCheck("whatever", "C:\\nonexistent-cwd", {
    spawnImpl: () => { throw new Error("boom-spawn") },
  })
  assert.equal(out.code, -1, "spawn 异常收敛为 code -1")
  assert.equal(out.timedOut, false)
  assert.ok(out.tail.includes("boom-spawn"), "异常消息进尾部输出")
})

test("A27-7 行为腿 (US-3 / AC-5): 回执超时标注与真实生效值一致（注入 40ms 如实显示）；PASS 腿不 kill", async () => {
  const stages = [{ goal: "g", files: ["lib/x.mjs"], acceptance: "a", check: "node --check x.mjs", checkMode: "host" }]
  // 超时腿：永不 close 的假子进程 + 40ms 注入超时 ⇒ 回执标注 ">40ms"（不是 120000——标注取生效值）
  const timeoutCase = makeFakeSpawn(false)
  const rec = await runHostStageChecks(stages, "C:\\nonexistent-cwd", { timeoutMs: 40, spawnImpl: timeoutCase.spawnImpl })
  assert.ok(rec.includes("check timed out"), "超时回执在场")
  assert.ok(rec.includes(">40ms"), "回执标注 = 生效值（A27-7 行为半腿）：" + rec.split("\n").filter((l) => l.includes("timed out")).join(" | "))
  assert.ok(rec.includes("验收：FAIL"), "超时 ⇒ 验收 FAIL")
  assert.equal(timeoutCase.spawned[0].kills, 1, "超时路径经 runHostStageChecks 仍 kill")
  // PASS 腿：正常 close ⇒ 验收 PASS 且零 kill（US-4 收窄贯穿回执路径）
  const passCase = makeFakeSpawn(true)
  const rec2 = await runHostStageChecks(stages, "C:\\nonexistent-cwd", { timeoutMs: 5000, spawnImpl: passCase.spawnImpl })
  assert.ok(rec2.includes("exit 0") && rec2.includes("验收：PASS"), "正常 close ⇒ PASS 回执")
  assert.equal(passCase.spawned[0].kills, 0, "正常 close ⇒ 未被 kill（回执路径同享收窄）")
})
