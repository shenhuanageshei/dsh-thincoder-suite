// consult.test.mjs — 会诊机制单元测试（登记表 D-28 回归钉死，2026-09-09）。
// 覆盖：
// ① D-28 回归：调用方 exec.signal abort 不得杀死子代理——PTC 模式下 exec.signal 是
//    run_code 程序的 run-scoped 控制器（dsh-tools/lib/types/ptc.js:375 注入、:532 在程序
//    settle 的 finally 里 abort），而会诊是「本回合 start、后续回合 check」的跨回合协议；
//    生产实证（2026-09-08/09，lore 会话）：21 次尝试里 20 次子代理在 1~3 秒内被
//    child.cancel({kind:'parent'}) 杀掉且从未发出模型请求。
// ② consult_stop 早停仍中止在跑子代理（不因 ① 的控制器自持而失效）。
// ③ consultTimeoutMs 看门狗仍有界（泄漏兜底不因 ① 而失效）。
// ④ cleanupConsultSessions（session 销毁）中止全部在跑子代理。
// ⑤ selectConsultModels 选择器语义（provider:model / 裸 provider / 裸 model / 未知）。
// 假 subagents 忠实复刻 dsh-subagent-in-process-driver 的取消语义：request.signal abort →
// 子代理被取消（stopReason "aborted"）；否则 delayMs 后以 reply 完成。零真实 LLM 调用。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  startConsultSession, checkConsultSession, stopConsultSession, cleanupConsultSessions, selectConsultModels,
} from "../lib/consult.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await sleep(5)
  }
  throw new Error("waitFor timeout")
}

/** 假 subagents：signal abort → 取消（对齐 in-process driver），否则 delayMs 后完成。 */
function makeSubagents({ delayMs = 20, reply = "reply-ok" } = {}) {
  const started = []
  const aborts = []
  return {
    started,
    aborts,
    async start(kind, req) {
      started.push({ kind, req })
      let cancelled = false
      let onAbort = null
      const result = new Promise((resolve) => {
        onAbort = () => { cancelled = true; aborts.push(Date.now()); resolve({ output: [], stopReason: "aborted" }) }
        if (req.signal) {
          if (req.signal.aborted) onAbort()
          else req.signal.addEventListener("abort", onAbort, { once: true })
        }
        const t = setTimeout(() => {
          if (!cancelled) resolve({ output: [{ type: "text", text: reply }], stopReason: "completed" })
        }, delayMs)
        t.unref?.()
      })
      return {
        result,
        dispose: async () => { try { req.signal?.removeEventListener("abort", onAbort) } catch { /* noop */ } },
      }
    },
  }
}

let seq = 0
/** deps stub：ctx.subagents 假服务 + 会话级 state（真实 sessionState 形状）。 */
function makeDeps({ subagents, signal, config = {} } = {}) {
  const sessionId = "consult-test-" + (++seq)
  const state = sessionState(sessionId)
  return {
    sessionId,
    state,
    deps: {
      ctx: { subagents },
      agent: {
        session: { id: sessionId, header: { cwd: process.cwd() }, deriveMessages: () => [] },
        options: { provider: "p", model: "m" },
      },
      config: { consultModels: [{ provider: "p", model: "m" }], ...config },
      state,
      signal,
      persona: undefined,
    },
  }
}

const cleanup = (sessionId, state) => { cleanupConsultSessions(state); dropSession(sessionId, (s) => cleanupConsultSessions(s)) }

test("D-28 回归：调用方 exec.signal abort 不得杀死 consult 子代理", async () => {
  const sub = makeSubagents({ delayMs: 30, reply: "keep-it" })
  const outer = new AbortController()
  const { deps, state, sessionId } = makeDeps({ subagents: sub, signal: outer.signal })

  const s = await startConsultSession(deps, "问题", undefined)
  assert.deepEqual(s.models, ["p:m"])
  await waitFor(() => sub.started.length === 1)

  const childSignal = sub.started[0].req.signal
  assert.ok(childSignal, "子代理必须拿到插件自持的 signal")
  outer.abort()                                   // 模拟 PTC run_code 程序 settle（ptc.js:532）
  await sleep(10)

  assert.equal(childSignal.aborted, false, "子代理信号必须与调用方程序解耦")
  assert.equal(sub.aborts.length, 0, "调用方 abort 不得取消子代理")

  const r = await checkConsultSession(state, s.id, undefined)
  assert.equal(r.failedReply, false)
  assert.match(String(r.reply), /^keep-it/)
  assert.equal(r.done, true)
  cleanup(sessionId, state)
})

test("D-28：consult_stop 早停仍中止在跑子代理", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({ subagents: sub })

  const s = await startConsultSession(deps, "问题", undefined)
  await waitFor(() => sub.started.length === 1)

  const stopped = stopConsultSession(state, s.id, 1)
  assert.equal(stopped.abandoned, 1)
  await waitFor(() => sub.aborts.length === 1)

  const r = await checkConsultSession(state, s.id, undefined)
  assert.equal(r.done, true)
  assert.equal(r.received, 0)
  cleanup(sessionId, state)
})

test("D-28：consultTimeoutMs 看门狗仍有界中止（失败回复带 timed out）", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({ subagents: sub, config: { consultTimeoutMs: 25 } })

  const s = await startConsultSession(deps, "问题", undefined)
  const r = await checkConsultSession(state, s.id, undefined)

  assert.equal(r.failedReply, true)
  assert.match(String(r.reply), /timed out after/)
  assert.equal(sub.aborts.length, 1)
  cleanup(sessionId, state)
})

test("D-28：cleanupConsultSessions（session 销毁）中止全部在跑子代理", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({
    subagents: sub,
    config: { consultModels: [{ provider: "p", model: "m" }, { provider: "p", model: "n" }] },
  })

  await startConsultSession(deps, "问题", undefined)
  await waitFor(() => sub.started.length === 2)

  cleanupConsultSessions(state)
  await waitFor(() => sub.aborts.length === 2)
  assert.equal(state.consultSessions.size, 0)
  dropSession(sessionId, (s) => cleanupConsultSessions(s))
})

test("selectConsultModels：provider:model / 裸 provider / 裸 model / 未知选择器", () => {
  const pool = [
    { provider: "a", model: "x" },
    { provider: "a", model: "y" },
    { provider: "b", model: "z" },
    { runner: { kind: "codex-cli", model: "gpt" } },
  ]
  assert.deepEqual(selectConsultModels(pool, undefined).models, pool)
  assert.deepEqual(selectConsultModels(pool, []).models, pool)
  assert.deepEqual(selectConsultModels(pool, ["a:x"]).models.map((m) => m.model), ["x"])
  assert.deepEqual(selectConsultModels(pool, ["a"]).models.map((m) => m.model), ["x", "y"])
  assert.deepEqual(selectConsultModels(pool, ["z"]).models.map((m) => m.provider), ["b"])
  assert.deepEqual(selectConsultModels(pool, ["codex-cli:gpt"]).models.map((m) => m.runner.model), ["gpt"])
  assert.match(selectConsultModels(pool, ["nope"]).error, /unknown consult model selector/)
})
