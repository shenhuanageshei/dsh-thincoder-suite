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
// ⑥ **批 30 / US-5（D-58 · A30-8 / A30-9）**：注入面消毒（裸会话引用形态被断开、带路径形态原样）+ 失败
//    可诊断（无 diagnostic 时兜底读子会话落盘 `turn/end.reason`；读不到 ⇒ 如实声明「子代理面不可诊断」）
//    + codex 行带出 `env.diagnostics`（exit code / stderr）；**US-7（D-59 · A30-11）**：池行前置可用性预检——
//    模型不在目录 / effort 不被接受 ⇒ 该行**不派发**并点名「因配置未派发」+ 原因（判据 = 零 codex exec 调用）；
//    目录不可得 ⇒ fail-open 不拦 + 响亮标注（诚实降级）；**US-6（D30-6 · A30-10 / A30-12）**：权限面判据
//    读**模型请求头**（`request/header`，不得以「restrict 未抛错」代替）+ **会诊产物**（派发回复的 detail 段 ·
//    settle 后的 digest）带「本部署无法保证只读」如实声明与**弱证 / 模型面**证据口径（含一条跨档防漂移锁）。
//    ★ 全部**并入既有块**（台账 §三零改：零新增顶层 `test(`）。
// 假 subagents 忠实复刻 dsh-subagent-in-process-driver 的取消语义：request.signal abort →
// 子代理被取消（stopReason "aborted"）；否则 delayMs 后以 reply 完成。零真实 LLM 调用。
process.env.DSH_HOME = ""
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { EventEmitter } from "node:events"
// 批 30 / US-5（D-58 · 锚 A30-9）：多帧 zstd 会话档的自造夹具（逐帧压缩 + 顺序拼接，真机同形）。
import * as nodeZlib from "node:zlib"
import {
  startConsultSession, stopConsultSession, cleanupConsultSessions, selectConsultModels,
  composeConsultDigest, readConsultLedger, consultDigestionGate, consultLedgerOrphans,
  undigestedConsultSessions, CONSULT_DIGEST_REPLY_CAP,
  // 批 30 / US-5：注入面消毒（A30-8）与落盘日志定位 slug（A30-9 的证据通道）
  sanitizeInjectedText, projectKeySlug,
} from "../lib/consult.mjs"
// 批 30 / US-6（D30-6 · 锚 A30-10/A30-12）：**模型面**证据的捕获与成文（eng.mjs 侧实现，
// 读取器复用 consult.mjs 的补导出——设计 §2.6「不得新建模块」）
import { readChildModelToolSurface, renderModelSurfaceEvidence } from "../lib/eng.mjs"
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
/**
 * 假 jobs 服务（批 15 / D15-1：派发**必须**走平台 job）。平台契约（`dsh-jobs` 的 `JobStart`）：
 * `start(spec)` 调 `spec.run()` 取 `{cancel, done}`，返回 branded string `<kind>-N`。
 */
function makeJobs() {
  const specs = []
  return {
    specs,
    jobs: {
      start(spec) {
        const hooks = spec.run()
        specs.push({ spec, hooks })
        return "consult-" + specs.length
      },
    },
  }
}

/** deps stub：ctx.subagents 假服务 + 假 jobs 服务 + 会话级 state（真实 sessionState 形状）。 */
function makeDeps({ subagents, signal, config = {}, noJobs = false } = {}) {
  const sessionId = "consult-test-" + (++seq)
  const state = sessionState(sessionId)
  const j = makeJobs()
  // 批 15：纪要档与台账都写盘 ⇒ 落点必须在临时目录（不得污染仓库 docs/ 与真实 DSH_HOME）
  const cwd = mkdtempSync(join(tmpdir(), "consult-cwd-"))
  const dshHome = mkdtempSync(join(tmpdir(), "consult-home-"))
  return {
    sessionId,
    state,
    jobs: j,
    cwd,
    dshHome,
    deps: {
      ctx: { subagents, get: (svc) => (svc === "jobs" && !noJobs ? j.jobs : null) },
      agent: {
        session: { id: sessionId, header: { cwd }, deriveMessages: () => [] },
        options: { provider: "p", model: "m" },
      },
      config: { consultModels: [{ provider: "p", model: "m" }], ...config },
      state,
      signal,
      persona: undefined,
      dshHome,
    },
  }
}

const cleanup = (sessionId, state) => { cleanupConsultSessions(state); dropSession(sessionId, (s) => cleanupConsultSessions(s)) }

/**
 * 批 15（FR-2）：`checkConsultSession` 与其 `waiters` 机制已随投递改造退役 ⇒
 * **生产消费面 = digest**（`composeConsultDigest` 的产物，由 run 体在 job complete 前合成）。
 * 测试读的仍是生产站点真正合成的载荷（不手搓等价物——批 6 修复轮审计 🔴 #1 的纪律）。
 */
const sessOf = (state, id) => state.consultSessions.get(String(id))
async function waitDigest(session, timeoutMs = 3000) {
  await waitFor(() => session.digest !== null, timeoutMs)
  return session.digest
}

test("D-28 回归：调用方 exec.signal abort 不得杀死 consult 子代理", async () => {
  const sub = makeSubagents({ delayMs: 30, reply: "keep-it" })
  const outer = new AbortController()
  const { deps, state, sessionId } = makeDeps({ subagents: sub, signal: outer.signal })

  const s = await startConsultSession(deps, "问题", undefined)
  assert.deepEqual(s.models, ["p:m"])
  assert.equal(s.jobId, "consult-1", "批 15（D15-1）：派发走平台 job")
  await waitFor(() => sub.started.length === 1)

  const childSignal = sub.started[0].req.signal
  assert.ok(childSignal, "子代理必须拿到插件自持的 signal")
  outer.abort()                                   // 模拟 PTC run_code 程序 settle（ptc.js:532）
  await sleep(10)

  assert.equal(childSignal.aborted, false, "子代理信号必须与调用方程序解耦")
  assert.equal(sub.aborts.length, 0, "调用方 abort 不得取消子代理")

  const digest = await waitDigest(sessOf(state, s.id))
  assert.match(digest.split("\n")[0], /^\[consult #\d+ finished — 1 of 1 replied \(0 failed\)\]$/)
  assert.ok(digest.includes("keep-it"), "真实回复经生产消费面（digest）可见")
  cleanup(sessionId, state)
})

test("D-28：consult_stop 早停仍中止在跑子代理", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({ subagents: sub })

  const s = await startConsultSession(deps, "问题", undefined)
  await waitFor(() => sub.started.length === 1)

  const stopped = stopConsultSession(state, s.id, 1, deps)
  assert.equal(stopped.abandoned, 1)
  await waitFor(() => sub.aborts.length === 1)

  // ★ 批 15（D15-3 / AC-20，**有意偏离上游 T-R17c**）：stop 会话照产**墓碑 digest**——
  // 退役轮询面后 digest 是唯一消费通道，stop 无 digest = 已收到的回复整批蒸发。
  const sess = sessOf(state, s.id)
  const digest = await waitDigest(sess)
  assert.match(digest.split("\n")[0], /^\[consult #\d+ stopped — 0 of 1 replied \(0 failed, 1 stopped\) before stop\]$/)
  assert.ok(digest.includes("abort(stop@agent: stop requested)"),
    "stop 死亡行经生产消费面（digest）可见：" + digest.split("\n").slice(-3).join(" / "))
  assert.equal(sess.received, 0)
  assert.equal(sess.requiresReport, false, "墓碑 ⇒ requiresReport=false（§7 取值规则 ③）")
  cleanup(sessionId, state)
})

test("D-28：consultTimeoutMs 看门狗仍有界中止（失败回复带 timed out）", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({ subagents: sub, config: { consultTimeoutMs: 25 } })

  const s = await startConsultSession(deps, "问题", undefined)
  const digest = await waitDigest(sessOf(state, s.id))

  assert.ok(digest.includes("timed out after 1s"), "亚秒预算不得渲染成 0s（advisor 🔵#5）")
  assert.match(digest.split("\n")[1], /^effective: 0 of 1 \(1 failed · 0 without content\)$/, "全失败仍照投 + 有效数=0")
  assert.equal(sub.aborts.length, 1)
  cleanup(sessionId, state)
})

test("D-28 跟进：调用方（已 abort 的）信号不得杀子代理，digest 仍读到真实回复", async () => {
  const sub = makeSubagents({ delayMs: 40, reply: "late-ok" })
  const outer = new AbortController()
  outer.abort() // 调用方程序已 settle（PTC run-scoped 信号）
  const { deps, state, sessionId } = makeDeps({ subagents: sub, signal: outer.signal })

  const s = await startConsultSession(deps, "问题", undefined)
  await waitFor(() => sub.started.length === 1)

  const digest = await waitDigest(sessOf(state, s.id))
  assert.equal(sub.aborts.length, 0, "调用方信号不得杀子代理（advisor 🟡#1）")
  assert.match(digest, /^late-ok/m, "子代理仍在跑 → digest 里仍是真实回复")
  cleanup(sessionId, state)
})

test("D-28：cleanupConsultSessions（session 销毁）中止全部在跑子代理", async () => {
  const sub = makeSubagents({ delayMs: 5000 })
  const { deps, state, sessionId } = makeDeps({
    subagents: sub,
    config: { consultModels: [{ provider: "p", model: "m" }, { provider: "p", model: "n" }] },
  })

  const s = await startConsultSession(deps, "问题", undefined)
  await waitFor(() => sub.started.length === 2)
  const sess = sessOf(state, s.id)

  cleanupConsultSessions(state)
  await waitFor(() => sub.aborts.length === 2)
  assert.equal(state.consultSessions.size, 0)
  // R-9 / §9：dispose 面**不强行造墓碑投递**（digest 无从合成是既有登记例外）
  assert.equal(sess.digest, null, "销毁路径不合成 digest（R-9）")
  assert.equal(sess.disposed, true)
  dropSession(sessionId, (s) => cleanupConsultSessions(s))
})

// ═══════════════ 批 15 交付/消化面（AC-1…AC-26 的 T1 腿） ═══════════════
//
// ★ 为什么挤在既有用例里：批 15 的硬约束是**零新增测试档 + 零新增顶层 `test(`**
//（台账 §三零改 → T-LC2 逐档用例数必须与 fs 实测一致）⇒ 新增断言只能**并入既有块**。
// 下面是一组模块级 helper，由本档最后一个用例一次性跑完（每项都带它对应的 AC 号）。

/** 按 req.label 分派回复形态的假子代理（`ok` / `empty` / `fail` / `long` / `ctrl`）。 */
function makeSpecSubagents(pick) {
  return {
    async start(_kind, req) {
      const spec = pick(String(req.label ?? "")) ?? { kind: "ok", text: "reply" }
      if (spec.kind === "fail") return { result: Promise.reject(new Error(spec.text ?? "boom")), dispose: async () => { } }
      if (spec.kind === "empty") return { result: Promise.resolve({ output: [], stopReason: "completed" }), dispose: async () => { } }
      return {
        result: (async () => {
          await sleep(10)
          return { output: [{ type: "text", text: spec.text ?? "reply" }], stopReason: "completed" }
        })(),
        dispose: async () => { },
      }
    },
  }
}

const POOL4 = [
  { provider: "p", model: "a" }, { provider: "p", model: "b" },
  { provider: "p", model: "c" }, { provider: "p", model: "d" },
]

// ═══════════════ 批 15 修复轮：形状腿 · 描述面正向锁 · alreadySettled ═══════════════
//
// 独立分歧审计（子代理 80feea19）判定 AC-5 / AC-7(形状) / AC-16 / AC-25 为 partial、AC-20 的 `alreadySettled`
// 错误用例未测、US-12 无真实覆盖 ⇒ 本组把**可机检的那部分**补齐；**不可机检的那部分**（`goal`/`authorized`
// 两档的送达时判定 = 只有提示词承载、零机制）**如实降为 T3**，并同步设计档 §11.2 / §11.3。
// ★ 硬约束：**零新增测试档 · 零新增顶层 `test(`**（台账 §三零改）⇒ 全部并入既有块。

/** 仓库根（本档在 `test/` 下）——静态锁（描述面 / 纪律面）读源码字节用。 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 纪要形状谓词（**纯函数**，AC-7 的**形状腿** / 修复轮补腿）：
 * 「每条意见**恰一条处置**」的**形状前提** = 机制产出的纪要必须给**每一条回复恰一个编号槽位**
 * （`[N]`，且密排 `1..N`）——主代理的 §2 处置行逐一绑定这些槽位。
 * ★ 语义（每条处置是否正确、不采纳的理由是否成立）**仍只能人眼**（T3；R-41 不许超卖）。
 * @param {string} text 纪要全文
 * @param {number} expectedReplies 该会话的回复条数（`session.replies.length`）
 * @returns {string[]} 违规描述列表（空 = 合规）
 */
function minutesShapeViolations(text, expectedReplies) {
  const bad = []
  const t = String(text ?? "")
  for (const need of ["## §0 汇总", "## §1 原始层", "## §2 逐问裁定"]) {
    if (!t.includes(need)) bad.push("缺小节 " + need)
  }
  if (!t.includes("每条意见**恰一条处置**")) bad.push("§2 缺「每条意见恰一条处置」指令")
  if (!t.includes("不采纳（**必附理由**）")) bad.push("§2 缺「不采纳必附理由」")
  const nums = [...t.matchAll(/^\[(\d+)\] /gm)].map((m) => Number(m[1]))
  const sorted = [...nums].sort((a, b) => a - b)
  if (sorted.length !== expectedReplies || !sorted.every((n, i) => n === i + 1)) {
    bad.push("回复槽位不密不齐：实测 [" + nums.join(",") + "]，应恰为 1.." + expectedReplies)
  }
  return bad
}

/** AC-7(形状) · AC-16 · AC-20(alreadySettled) · AC-23 / US-12：修复轮补齐的可机检腿。 */
async function b15ShapeAndSurfaceChecks() {
  // —— ① AC-7 形状腿（T1）：**真实生产站点**产出的纪要 ⇒ 每条回复恰一个编号槽位 ——
  const sub = makeSpecSubagents((label) => {
    if (label.endsWith("p:a")) return { kind: "ok", text: "reply-from-a" }
    if (label.endsWith("p:b")) return { kind: "empty" }
    if (label.endsWith("p:c")) return { kind: "fail", text: "boom" }
    return { kind: "ok", text: "reply-from-d" }
  })
  const h = makeDeps({ subagents: sub, config: { consultModels: POOL4 } })
  const r = await startConsultSession(h.deps, "问题", undefined)
  await h.jobs.specs[0].hooks.done
  const s = sessOf(h.state, r.id)
  const minutesText = readFileSync(join(h.cwd, s.minutesPath), "utf8")
  assert.equal(s.replies.length, 4, "4 条回复（ok / 空 / 失败 / ok）全部进 replies（digest 的单一输入）")
  assert.deepEqual(minutesShapeViolations(minutesText, s.replies.length), [],
    "AC-7 形状腿：机制产的纪要给每条回复**恰一个**编号槽位（密排 1..N）——「处置行数 == 回复数」的形状前提")
  // 谓词自证（律 3：破坏被保护物 ⇒ 必红，不是恒真锁）
  const dropped = minutesText.replace(/^\[1\] [^\n]*\n/m, "")
  assert.notEqual(dropped, minutesText, "谓词自证前置：编号槽位行（`[N] …`）可定位")
  assert.ok(minutesShapeViolations(dropped, s.replies.length).length > 0, "谓词自证：抽掉一个槽位 ⇒ 必判违规")
  assert.ok(minutesShapeViolations(minutesText.replace(/^\[2\] /m, "[1] "), s.replies.length).length > 0,
    "谓词自证：槽位编号重复（不密）⇒ 必判违规")
  assert.ok(minutesShapeViolations(minutesText, s.replies.length + 1).length > 0,
    "谓词自证：回复数与槽位数不符 ⇒ 必判违规")
  cleanup(h.sessionId, h.state)

  // —— ② AC-16 正向锁（T2）+ 反向：新描述面含「自动投递 / 收到须汇报」 ——
  const idx = readFileSync(join(PLUGIN_DIR, "lib/index.mjs"), "utf8")
  const mainPrompt = readFileSync(join(PLUGIN_DIR, "lib/prompts/main.md"), "utf8")
  assert.ok(idx.includes("Delivery is AUTOMATIC"), "AC-16 正向：consult_start 描述面须声明**自动投递**")
  assert.ok(idx.includes("you ARE notified in-session"), "AC-16 正向：「你会被通知」的字面在场")
  assert.ok(idx.includes("STOP and report to the user"), "AC-16 正向：缺省「停下向用户汇报」在场")
  assert.ok(mainPrompt.includes("you are notified in-session when it settles"), "AC-16 正向：主提示词同款声明在场")
  assert.ok(mainPrompt.includes("STOP and report to the user"), "AC-16 正向：主提示词的缺省停在场")
  // AC-16 反向（逐行）：批 14 那句「没有通知」只准作为**注释留痕**存在，不得回到描述面（字符串字面）
  const retired = idx.split("\n").filter((l) => l.includes("There is NO completion notification"))
  assert.ok(retired.length >= 1, "反向锁自证：该句仍须作为历史留痕留在注释里（否则反向断言是恒真）")
  for (const l of retired) {
    assert.ok(/^\s*\/\//.test(l), "AC-16 反向：那句只准住注释，不得出现在描述面：" + l.trim().slice(0, 60))
  }

  // —— ②b ★ 路径字面正向锁（交付代码评审 #3 的追加要求）：机制的真实落点是 `docs/consult-minutes/`
  //   子目录（F1 修复），**两处描述面必须与之一致**，且**不得回到旧顶层形态**（防再漂移）。
  //   在此之前两档都写着 `docs/<date>-consult-<id>-minutes.md`——**模型可见的指令面指向一个错的落点**。
  const readme = readFileSync(join(PLUGIN_DIR, "README.md"), "utf8")
  /** 路径锁的两条腿（**判据本体**——正向/反向都在这里，自证腿必须打在它身上才不是恒真）。 */
  const minutesPathLegs = (text) => ({
    positive: text.includes("docs/consult-minutes/"),
    noOldTopLevel: !text.includes("docs/<date>-consult-<id>-minutes.md"),
  })
  for (const [label, text] of [["lib/prompts/main.md", mainPrompt], ["README.md", readme]]) {
    const legs = minutesPathLegs(text)
    assert.ok(legs.positive,
      "路径正向锁（AC-16 组）：" + label + " 必须写出机制的真实落点前缀 `docs/consult-minutes/`")
    assert.ok(legs.noOldTopLevel,
      "路径反向锁（AC-16 组）：" + label + " 不得再写旧顶层字面（F1 修复后真实落点是子目录）")
  }
  // 谓词自证（律 3）：合成文本各走一遍 —— 新形态两条腿都过；**旧顶层形态两条腿都判否**
  //（后者逐字就是 F1 修复前 main.md:30 / README.md:146 的原文 ⇒ 这两条断言当时会红）
  assert.deepEqual(minutesPathLegs("minutes land at docs/consult-minutes/<date>-consult-<id>-minutes.md"),
    { positive: true, noOldTopLevel: true }, "谓词自证前置：新形态文本必判过")
  assert.deepEqual(minutesPathLegs("minutes land at docs/<date>-consult-<id>-minutes.md"),
    { positive: false, noOldTopLevel: false }, "谓词自证：旧顶层字面两条腿都判否")

  // —— ③ AC-23 / US-12（T2）：wakeup 回合「先读全文再处置」的纪律在场（英文谓词——该档正文是英文） ——
  assert.ok(mainPrompt.includes("job_output"), "AC-23：主提示词须点名 `job_output`（P4 的那一跳）")
  assert.ok(mainPrompt.includes("read the full digest first"), "AC-23：须有「先读全文」的等价句")

  // —— ④ AC-20 错误用例（补测）：已 settle 的会话再 stop ⇒ 无效（不造第二套结算面） ——
  const h2 = makeDeps({ subagents: makeSpecSubagents(() => ({ kind: "ok", text: "reply" })) })
  const r2 = await startConsultSession(h2.deps, "问题", undefined)
  const s2 = sessOf(h2.state, r2.id)
  await h2.jobs.specs[0].hooks.done
  const settledDigest = s2.digest
  assert.equal(typeof settledDigest, "string", "前置：会话已 settle（有 digest）")
  const rejected = stopConsultSession(h2.state, r2.id, 1, h2.deps)
  assert.deepEqual(rejected, { stopped: 0, alreadySettled: true }, "AC-20 错误用例：已 settle ⇒ stop 无效")
  assert.equal(s2.digest, settledDigest, "已 settle 的 digest 不得被二次合成覆盖（digest 单一写点）")
  assert.equal(s2.stopped, false, "已 settle 的会话不得被标为 stopped（否则墓碑语义被污染）")
  cleanup(h2.sessionId, h2.state)
}

/** AC-1 / AC-2 / AC-9 / AC-21 / AC-22 / §7 ③：一次投递 = job 输出；先落盘再 complete；两个数。 */
async function b15DeliveryChecks() {
  const sub = makeSpecSubagents((label) => {
    if (label.endsWith("p:a")) return { kind: "ok", text: "reply-from-a" }
    if (label.endsWith("p:b")) return { kind: "empty" }        // 空回复（既有兜底 `(empty reply)`）
    if (label.endsWith("p:c")) return { kind: "fail", text: "boom" }
    return { kind: "ok", text: "reply-from-d" }
  })
  const h = makeDeps({ subagents: sub, config: { consultModels: POOL4 } })
  const r = await startConsultSession(h.deps, "问题", undefined)
  assert.equal(r.jobId, "consult-1")
  assert.equal(h.jobs.specs.length, 1, "AC-1/AC-2：全 settle 只产生**一次**投递（一个平台 job）")
  // §7 ③ job spec 逐字段（对齐 eng.mjs 的 kind:\"eng-dsh\" 先例）
  const spec = h.jobs.specs[0].spec
  assert.equal(spec.kind, "consult", "D15-5：kind 无路由后缀（会话混跑 dsh 与 codex-cli 行）")
  assert.equal(spec.outputLimitBytes, 131072)
  assert.equal(spec.owner, h.deps.agent.id ?? h.deps.agent.session.id, "D-42：owner = 共享 agent/session id（0.1.7 平台按 id 查活代理）")
  assert.match(spec.label, /^consult #\d+ \(4 models: p:a, p:b, p:c, p:d\)$/)
  assert.deepEqual(Object.keys(h.jobs.specs[0].hooks).sort(), ["cancel", "done"], "hooks 形 = {cancel, done}")

  const outcome = await h.jobs.specs[0].hooks.done
  const s = sessOf(h.state, r.id)
  assert.equal(outcome.status, "completed")
  assert.equal(outcome.output, s.digest, "job 输出 === session.digest（digest 无第二个写点）")
  // ★★ AC-21 落盘次序：done 解决时纪要**已经在盘上**（写盘先于 job complete）
  assert.ok(s.minutesPath && existsSync(join(h.cwd, s.minutesPath)),
    "AC-21：settle 时纪要原始层先于 job complete 落盘（order = 本批的兜底机制）")
  // AC-9：命名 glob + 结构（§0 汇总 + §1 原始层由机制写；§2–§5 留给主代理）
  assert.match(s.minutesPath, /^docs\/consult-minutes\/\d{4}-\d{2}-\d{2}-consult-\d+-minutes\.md$/, "AC-9（修复轮 F1）：命名 = docs/consult-minutes/<date>-consult-<id>-minutes.md")
  // ★ 批 15 修复轮（审计 F1 = 🔴）：落点**不得**回到 `docs/` 顶层——`test/doc-hygiene.test.mjs:123-132` 的 R-25
  //   登记谓词 `docsTopLevel()` 非递归只读顶层、且要求每个 `*.md` 登记在 `docs/README.md` 全文里 ⇒ 顶层纪要必令套件红。
  assert.ok(!/^docs\/[^/]+\.md$/.test(s.minutesPath), "F1：纪要落点必须留在 docs/ 的子目录里（顶层会撞 R-25 登记谓词）")
  const minutes = readFileSync(join(h.cwd, s.minutesPath), "utf8")
  assert.ok(minutes.includes("## §0 汇总") && minutes.includes("## §1 原始层"), "机制写 §0/§1")
  assert.ok(minutes.includes("## §2 逐问裁定") && minutes.includes("主代理写"), "裁定层留给主代理（插件永不写纪要的裁定层）")
  assert.ok(minutes.includes("不采纳（**必附理由**）"), "AC-8：纪要模板含理由列")
  // AC-22 / T-3：**交付数与有效数是两个数**
  const [head, eff] = String(s.digest).split("\n")
  assert.equal(head, "[consult #1 finished — 3 of 4 replied (1 failed)]", "交付数 3 of 4（失败 1）")
  assert.equal(eff, "effective: 2 of 4 (1 failed · 1 without content)", "有效数 2 of 4（空回复不计入有效）")
  assert.ok(String(s.digest).includes("reply-from-a") && String(s.digest).includes("reply-from-d"), "逐条回复在场")
  assert.equal(s.requiresReport, true, "§7 取值规则 ①：正常 settle ⇒ true")
  assert.equal(s.digested, false)
  const ledgerEvs = readConsultLedger(h.deps)
  assert.deepEqual(ledgerEvs.rows.map((x) => x.ev), ["started", "settled"], "台账 append-only：started → settled")
  cleanup(h.sessionId, h.state)
}

/** AC-18 / D15-4：jobs 缺失或 jobs.start 抛错 ⇒ **拒发**（零部分工作，绝不回落同步）。 */
async function b15RefusalChecks() {
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "x" }))
  const h = makeDeps({ subagents: sub, noJobs: true })
  const r = await startConsultSession(h.deps, "问题", undefined)
  assert.match(String(r.error), /jobs/, "AC-18：jobs 缺失 ⇒ 响亮拒发")
  assert.match(String(r.error), /未派发任何子代理/)
  assert.equal(sub.started?.length ?? 0, 0, "拒发路径未派发任何子代理")
  assert.equal(h.state.consultSessions.size, 0, "拒发路径不留下会话（零部分工作）")
  cleanup(h.sessionId, h.state)

  const h2 = makeDeps({ subagents: sub })
  h2.deps.ctx.get = () => ({ start() { throw new Error("no job controller serves this agent") } })
  const r2 = await startConsultSession(h2.deps, "问题", undefined)
  assert.match(String(r2.error), /派发失败/, "jobs.start 抛错同样拒发（不回落）")
  assert.equal(h2.state.consultSessions.size, 0)
  cleanup(h2.sessionId, h2.state)
}

/** AC-5 / AC-6 / AC-25 / R-7：豁免档（仅 unattended 在 start 声明 · note 必填 · 三处留痕 · 字段仍 true）。 */
async function b15ExemptionChecks() {
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "reply" }))
  // 缺省 = 无豁免 = 停
  const h0 = makeDeps({ subagents: sub })
  const r0 = await startConsultSession(h0.deps, "问题", undefined)
  await waitDigest(sessOf(h0.state, r0.id))
  assert.equal(sessOf(h0.state, r0.id).exemption, null, "AC-6：豁免缺省全部关闭")
  assert.equal(sessOf(h0.state, r0.id).requiresReport, true, "缺省 ⇒ 必须汇报（停下汇报断点）")
  cleanup(h0.sessionId, h0.state)

  // 声明 unattended ⇒ session.exemption + digest 头部行 + 台账 exempted；requiresReport **仍 true**
  const h1 = makeDeps({ subagents: sub })
  const r1 = await startConsultSession(h1.deps, "问题", undefined, { kind: "unattended", note: "user is away for 2h" })
  const d1 = await waitDigest(sessOf(h1.state, r1.id))
  assert.deepEqual(sessOf(h1.state, r1.id).exemption, { kind: "unattended", note: "user is away for 2h" }, "AC-25：session.exemption 留痕")
  assert.ok(d1.includes("exemption: unattended — user is away for 2h"), "R-7：digest 头部行留痕（wakeup 回合据此知道不必停）")
  assert.equal(sessOf(h1.state, r1.id).requiresReport, true, "§7 取值规则 ④：豁免时字段**仍为 true**（字段表达事实，不表达动作）")
  assert.deepEqual(readConsultLedger(h1.deps).rows.map((x) => x.ev), ["started", "exempted", "settled"], "R-7 第三处：台账 exempted 事件")
  cleanup(h1.sessionId, h1.state)

  // 非法 kind / note 空 ⇒ 拒
  const h2 = makeDeps({ subagents: sub })
  assert.match(String((await startConsultSession(h2.deps, "问题", undefined, { kind: "goal", note: "x" })).error), /unattended/,
    "AC-5：非法 kind ⇒ 拒（goal/authorized 只能在送达时判）")
  assert.match(String((await startConsultSession(h2.deps, "问题", undefined, { kind: "unattended", note: "   " })).error), /note/,
    "AC-5/AC-25：note 必填（豁免必须留痕）")
  assert.equal(h2.state.consultSessions.size, 0, "非法豁免 ⇒ 零部分工作")
  cleanup(h2.sessionId, h2.state)
}

/** AC-19 / AC-10 / §5.7：门禁不变量 + ack 形状（正常 / 边界 / 错误三用例）。 */
async function b15GateChecks() {
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "reply" }))
  const h = makeDeps({ subagents: sub })
  const r = await startConsultSession(h.deps, "问题", undefined)
  const d = await waitDigest(sessOf(h.state, r.id))
  const s = sessOf(h.state, r.id)

  // 边界：裸 settle（无 ack）⇒ 拒发 + 内联未消化 digest + ack 指引
  let gate = consultDigestionGate(h.state, undefined, h.deps)
  assert.equal(gate.blocked, true, "AC-19：settled ∧ ¬digested ∧ ¬minutesExempt ⇒ 命中")
  assert.ok(gate.text.includes("未派发任何子代理"), "拒发文案含「未派发任何子代理」")
  assert.ok(gate.text.includes(d.split("\n")[0]), "内联未消化 digest（拒发即恢复通道）")
  assert.ok(gate.text.includes("digested:"), "ack 指引在场")
  assert.deepEqual(undigestedConsultSessions(h.state).map((x) => x.id), [r.id], "谓词 = settled ∧ ¬digested ∧ ¬minutesExempt")

  // 错误：ack 的 minutesPath 不存在 / 裸 id ⇒ 拒（仍拦）
  gate = consultDigestionGate(h.state, [{ id: r.id, minutesPath: "docs/nope.md" }], h.deps)
  assert.equal(gate.blocked, true, "AC-19 错误用例：ack 路径不存在 ⇒ 拒")
  assert.match(gate.acked.rejected.join(" "), /不存在/)
  gate = consultDigestionGate(h.state, [String(r.id)], h.deps)
  assert.equal(gate.blocked, true, "裸 id 串不够（留痕是这一档全部的意义）")
  assert.match(gate.acked.rejected.join(" "), /id/)
  gate = consultDigestionGate(h.state, [{ id: r.id, minutesExempt: { reason: "  " } }], h.deps)
  assert.equal(gate.blocked, true, "AC-10：minutesExempt.reason 必填")

  // 正常：分钟豁免（显式 + 理由）⇒ 放行；且留痕
  gate = consultDigestionGate(h.state, [{ id: r.id, minutesExempt: { reason: "minutes already in the ticket" } }], h.deps)
  assert.equal(gate.blocked, false, "AC-19：显式豁免 ⇒ 放行")
  assert.deepEqual(s.minutesExempt, { reason: "minutes already in the ticket" })
  assert.ok(readConsultLedger(h.deps).rows.some((x) => x.ev === "digested" && x.minutesExempt), "AC-10：豁免留痕（台账）")
  assert.deepEqual(undigestedConsultSessions(h.state), [], "不变量恢复")

  // 正常：minutesPath 存在 ⇒ digested（AC-9 的落点就是 ack 的凭据）
  const h2 = makeDeps({ subagents: sub })
  const r2 = await startConsultSession(h2.deps, "问题", undefined)
  await waitDigest(sessOf(h2.state, r2.id))
  const s2 = sessOf(h2.state, r2.id)
  assert.ok(existsSync(join(h2.cwd, s2.minutesPath)))
  const gate2 = consultDigestionGate(h2.state, [{ id: r2.id, minutesPath: s2.minutesPath }], h2.deps)
  assert.equal(gate2.blocked, false, "AC-19 正常用例：ack 路径在盘上 ⇒ 放行")
  assert.equal(s2.digested, true)
  cleanup(h2.sessionId, h2.state)
  cleanup(h.sessionId, h.state)
}

/** AC-26：台账孤儿扫描（正常无提示 / 边界孤儿 / 错误：在飞会话不误报）。 */
async function b15OrphanChecks() {
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "reply" }))
  const h = makeDeps({ subagents: sub })
  const r = await startConsultSession(h.deps, "问题", undefined)
  assert.deepEqual(consultLedgerOrphans(h.deps, h.state), [], "AC-26 错误用例：在飞会话（有 started 无 settled，但内存里在）⇒ 不误报")
  await waitDigest(sessOf(h.state, r.id))
  assert.deepEqual(consultLedgerOrphans(h.deps, h.state), [], "AC-26 正常用例：完整会话 ⇒ 无提示")
  // 边界：模拟重启后的孤儿行（台账有 started、无 settle、内存里也没有该 id）
  appendFileSync(join(h.dshHome, ".thincoder", "consult-ledger.jsonl"),
    JSON.stringify({ ev: "started", id: "77", sessionId: h.sessionId, at: Date.now() }) + "\n", "utf8")
  const orphans = consultLedgerOrphans(h.deps, h.state)
  assert.deepEqual(orphans.map((o) => o.id), ["77"], "AC-26 边界用例：孤儿 ⇒ 提示（建议性，不阻断）")
  cleanup(h.sessionId, h.state)
}

// ═══════════════ 批 15 收尾修复轮：交付代码评审轮次 1 的两条实质发现 ═══════════════
//
// 交付代码评审（`advisor-dsh-2`，`VERDICT: PASS`，🔴0 🟡4 🔵3）在本批**修复轮 1 新增的代码**里
// 抓出两条实质缺陷（分歧审计没看到——它们随修复轮 1 才进来）：
//   #1 **`lib/consult.mjs` 的 stop-竞速早退路径漏 `clearTimeout(watchdog)`**——与同文件 codex 行
//      finally 注释逐字记录过的**同一缺陷物种**；#2 **三类终结事件漏 `sessionId`** ⇒ 孤儿扫描
//      按会话过滤把它们整批丢掉 ⇒ `started` 行永远关不上 ⇒ 下一次 `consult_start` 附加误导提示。
// ★ 硬约束不变：**零新增测试档 · 零新增顶层 `test(`**（台账 §三零改）⇒ 并入既有块。

/**
 * 交付代码评审 #1：**stop-竞速早退路径必须清掉自己的看门狗**。
 * 该路径在 `setTimeout(watchdog)` **之后**才判 `session.stopped` ⇒ 不清就是滞留（缺省 600000ms）。
 * ★ 观测手段 = 包裹 `globalThis.setTimeout` / `clearTimeout` 记账（consult.mjs 走全局定时器），
 * 只认 `delay === consultTimeoutMs` 的那一个 ⇒ 与测试自身的 sleep/超时定时器不混淆。
 */
async function b15WatchdogLeakChecks() {
  const TIMEOUT = 987654 // 运行时宽容正整数值域（config-store 的 resolveConsultTimeoutMs）且可辨识
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "reply" }))
  const h = makeDeps({ subagents: sub, config: { consultTimeoutMs: TIMEOUT } })
  // 假 jobs：**不立即执行 run 体**（把 spec 交回测试）⇒ 造出「会话已注册、子代理尚未起跑」的竞速窗口
  const deferred = []
  h.deps.ctx.get = () => ({ start(spec) { deferred.push(spec); return "consult-deferred" } })
  const created = new Map()
  const cleared = new Set()
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = function (fn, ms, ...rest) { const hd = origSetTimeout(fn, ms, ...rest); created.set(hd, ms); return hd }
  globalThis.clearTimeout = function (hd) { cleared.add(hd); return origClearTimeout(hd) }
  try {
    const r = await startConsultSession(h.deps, "问题", undefined)
    assert.equal(r.jobId, "consult-deferred", "前置：派发已返回，而 run 体尚未起跑（早停可在此窗口到达）")
    assert.equal(stopConsultSession(h.state, r.id, 1, h.deps).stopped, 1, "前置：早停到达时子代理一个都还没起跑")
    const hooks = deferred[0].run()              // ← 现在才起跑 ⇒ 命中 `if (session.stopped)` 早退分支
    const outcome = await hooks.done
    assert.equal(outcome.status, "completed")
    assert.match(String(outcome.output).split("\n")[0],
      /^\[consult #\d+ stopped — 0 of 1 replied \(0 failed, 1 stopped\) before stop\]$/,
      "墓碑语义不受本修影响（D15-3：0 回复的墓碑同样自证 stop 面）")
    const watchdogs = [...created.entries()].filter(([, ms]) => ms === TIMEOUT)
    assert.equal(watchdogs.length, 1,
      "前置：该早退路径恰好造了 1 个看门狗（delay == consultTimeoutMs）——否则本腿是恒真")
    assert.ok(watchdogs.every(([hd]) => cleared.has(hd)),
      "★ 交付评审 #1：stop-竞速早退路径必须 clearTimeout(watchdog)（否则 unref 定时器 + 已 settle 控制器滞留至 consultTimeoutMs）")
  } finally {
    globalThis.setTimeout = origSetTimeout
    globalThis.clearTimeout = origClearTimeout
    cleanup(h.sessionId, h.state)
  }
}

/**
 * 交付代码评审 #2：**被拒发的会诊必须自己关上台账的 `started` 行**——否则下一次 `consult_start`
 * 会附加一句误导性幽灵提示（「#N 未见 settle——可能因重启丢失」，而那个会诊**从未派发**）。
 * ★ 本腿走**生产站点**：`apply()` 注册的 `consult_start` 工具 `execute`（含 `lib/index.mjs` 的孤儿
 * 提示组装），**不手搓等价物**（批 6 修复轮审计 🔴#1 的纪律）；台账落点由 `DSH_HOME` 注入临时目录
 * （本档顶部把 `DSH_HOME` 置空 = 测试隔离契约，此处临时改回一个临时目录并在 finally 还原）。
 */
async function b15GhostOrphanChecks() {
  const { apply } = await import("../lib/index.mjs")
  const registeredTools = []
  let jobsService = null
  // 注册面用 fake ctx（只需 `effect` + `systemPrompt.section` + `tools.register` + `get("jobs")`；
  // 不需要事件面 —— 本腿只驱动 consult_start 的 execute）
  const fakeCtx = {
    on: () => () => { },
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    systemPrompt: { section: () => () => { } },
    tools: { register: (t) => { registeredTools.push(t); return () => { } } },
    get: (n) => (n === "jobs" ? jobsService : null),
  }
  const dshHome = mkdtempSync(join(tmpdir(), "consult-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "consult-cwd-"))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome // 生产路径的台账落点由 env 解析（index.mjs 的 deps 无 dshHome 注入缝）
  const sessionId = "consult-ghost-" + (++seq)
  const state = sessionState(sessionId)
  const agent = { session: { id: sessionId, header: { cwd }, deriveMessages: () => [] }, options: {} }
  // 滞后的假子代理：会话整段保持在飞（既不被消化门禁拦住，也不会变成孤儿行）
  fakeCtx.subagents = {
    async start(_kind, req) {
      const result = new Promise((resolve) => {
        const onAbort = () => resolve({ output: [], stopReason: "aborted" })
        if (req.signal.aborted) onAbort()
        else req.signal.addEventListener("abort", onAbort, { once: true })
      })
      return { result, dispose: async () => { } }
    },
  }
  try {
    apply(fakeCtx, { consultModels: [{ provider: "p", model: "m" }] })
    const tool = registeredTools.find((t) => t.name === "consult_start")
    assert.ok(tool, "前置：apply() 注册了 consult_start（池非空）")

    // ① 拒发（jobs.start 抛错）：零部分工作，且台账必须留下**可关闭的** disposed 行
    jobsService = { start() { throw new Error("no job controller serves this agent") } }
    const r1 = await tool.execute({ problem: "probe-1" }, { agent })
    assert.match(String(r1), /派发失败/, "前置：拒发路径")
    assert.ok(!String(r1).includes("台账孤儿"), "拒发本次不得报孤儿")
    const ledgerFile = join(dshHome, ".thincoder", "consult-ledger.jsonl")
    const rows1 = readFileSync(ledgerFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    assert.deepEqual(rows1.map((x) => x.ev), ["started", "disposed"], "台账 append-only：started → disposed")
    assert.equal(rows1[1].sessionId, sessionId,
      "★★ 交付评审 #2：终结事件 disposed 必须带 sessionId（孤儿扫描按会话过滤——缺则被系统性丢弃）")

    // ② 再次发起（正常派发）：**不得**再对这个只被拒发的 #1 附加幽灵提示
    const specs = []
    jobsService = { start(spec) { const hooks = spec.run(); specs.push({ spec, hooks }); return "consult-" + specs.length } }
    const r2 = await tool.execute({ problem: "probe-2" }, { agent })
    assert.ok(!String(r2).includes("台账孤儿"),
      "★ 交付评审 #2：被拒发的 #1 不得被报成孤儿（它从未派发 ⇒「未见 settle、可能因重启丢失」是误导性陈述）：" + String(r2))

    // ③ 对照腿（**自证该断言非恒真**）：把 disposed 行改回**旧的**（无 sessionId）形态 ⇒ 下一次调用必报幽灵
    //    —— 逐字复现评审描述的修复前行为（本批修复轮 1 的真实代码就是那样写的）。
    const ghostRows = readFileSync(ledgerFile, "utf8").trim().split("\n").map((l) => JSON.parse(l))
    writeFileSync(ledgerFile,
      ghostRows.map((x) => JSON.stringify(x.ev === "disposed" ? { ...x, sessionId: undefined } : x)).join("\n") + "\n", "utf8")
    const r3 = await tool.execute({ problem: "probe-3" }, { agent })
    assert.ok(String(r3).includes("台账孤儿") && String(r3).includes("#1（"),
      "对照腿自证：旧形态（disposed 无 sessionId）下**确实**出现该幽灵提示 ⇒ ② 那条「不得出现」不是恒真：" + String(r3))

    // ④ 写侧静态锁（T2）：**每个终结事件写点都必须带 `sessionId`**——评审 #2 点名的三个里，
    //    「失败信封的 settled」在现有桩下不可达（settle 路径自身不抛）⇒ 用静态锁补它的可机检腿。
    const consultSrc = readFileSync(join(PLUGIN_DIR, "lib", "consult.mjs"), "utf8")
    const callBlocks = []
    const needle = "ledgerAppend(deps, {"
    for (let i = consultSrc.indexOf(needle); i !== -1; i = consultSrc.indexOf(needle, i + 1)) {
      let depth = 0
      let j = i + needle.length - 1 // 指向那个 `{`
      for (; j < consultSrc.length; j++) {
        if (consultSrc[j] === "{") depth++
        else if (consultSrc[j] === "}") { depth--; if (depth === 0) break }
      }
      callBlocks.push(consultSrc.slice(i, j + 1))
    }
    assert.ok(callBlocks.length >= 6, "前置：写点切块器真的切开了台账写点（实测 " + callBlocks.length + " 块，应 ≥ 6）")
    const terminalBlocks = callBlocks.filter((b) => /ev: "(settled|stopped|disposed)"/.test(b))
    assert.deepEqual([...new Set(terminalBlocks.map((b) => b.match(/ev: "([a-z]+)"/)[1]))].sort(),
      ["disposed", "settled", "stopped"], "前置：三类终结事件写点全在场（settled / stopped / disposed）")
    for (const b of terminalBlocks) {
      assert.match(b, /sessionId:/,
        "交付评审 #2 写侧锁：每个终结事件写点都必须带 sessionId（缺则孤儿扫描按会话过滤丢弃它、该 started 行永远关不上）："
          + b.replace(/\s+/g, " ").slice(0, 100))
    }
  } finally {
    process.env.DSH_HOME = prevHome
    cleanupConsultSessions(state)
    dropSession(sessionId, (s) => cleanupConsultSessions(s))
  }
}

/** AC-21 的负向腿 + §9 畸形 + 台账前向兼容 + id 计数器续接。 */
async function b15RobustnessChecks() {
  // ① 写盘失败 ⇒ digest 仍投递（fail-open）+ warn + minutesPath 归 null（盘上没有就不得声称有）
  const sub = makeSpecSubagents(() => ({ kind: "ok", text: "reply" }))
  const h = makeDeps({ subagents: sub })
  writeFileSync(join(h.cwd, "docs"), "occupied") // 让 docs/ 成为一个**文件** ⇒ mkdirSync 必 EEXIST
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => { warns.push(a.join(" ")) }
  let r
  try {
    r = await startConsultSession(h.deps, "问题", undefined)
    const outcome = await h.jobs.specs[0].hooks.done
    assert.equal(outcome.status, "completed", "AC-21：纪要写不出去也照样投递（记录面 fail-open）")
    assert.ok(warns.some((w) => w.includes("纪要原始层写出失败")), "响亮 warn（不静默）")
    assert.equal(sessOf(h.state, r.id).minutesPath, null, "盘上没有档 ⇒ minutesPath 归 null（artifact 不得撒谎）")
    assert.ok(!String(outcome.output).includes("-minutes.md"), "digest 不得声称一个不存在的落点")
  } finally { console.warn = origWarn; cleanup(h.sessionId, h.state) }

  // ② §9 畸形输入：单条回复软顶 + 截断标记 + 控制字符清洗（**纯函数**直接断言）
  const long = "L".repeat(CONSULT_DIGEST_REPLY_CAP + 500)
  const synthetic = {
    id: "9", total: 1, received: 1, failed: 0, terminated: 0, stopped: false, replies: [{ model: "p:x", reply: "\u0000" + long }],
    models: ["p:x"], jobId: "consult-9", minutesPath: null, requiresReport: true, exemption: null,
  }
  const dLong = composeConsultDigest(synthetic)
  assert.ok(dLong.includes("reply capped at " + CONSULT_DIGEST_REPLY_CAP + " chars"), "§9：软顶 + 截断标记")
  assert.ok(!dLong.includes("L".repeat(CONSULT_DIGEST_REPLY_CAP + 1)), "超帽部分不进 digest（全文在纪要 §1.1）")
  assert.ok(!dLong.includes("\u0000"), "§9：控制字符清洗")
  assert.equal(dLong, composeConsultDigest(synthetic), "纯函数幂等（同输入同输出）")

  // ③ 台账前向兼容（§9 升级类）：未知 ev 忽略、不报错；畸形行忽略
  const h3 = makeDeps({ subagents: sub })
  const file = join(h3.dshHome, ".thincoder", "consult-ledger.jsonl")
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify({ ev: "future-event", id: "5", at: 1 }) + "\n", "utf8")
  appendFileSync(file, "{not json\n", "utf8")
  const read = readConsultLedger(h3.deps)
  assert.deepEqual(read.rows, [], "未知 ev 不进语义视图（忽略该行、不报错）")
  assert.equal(read.unknownEvents.length, 1)
  assert.equal(read.maxId, 5, "★ id 计数器仍看全部合法行（防新版本事件让老读者 id 回退 ⇒ 纪要档名碰撞）")
  // ④ id 计数器续接：台账最大 id=5 ⇒ 下一个会话 id = 6（**重启后不复用 id**）
  const r3 = await startConsultSession(h3.deps, "问题", undefined)
  assert.equal(r3.id, "6", "§7 ⑤：id 计数器由台账续接（重启后不复用 id）")
  await h3.jobs.specs[0].hooks.done
  cleanup(h3.sessionId, h3.state)
}

// ═══════════════ 批 30 / US-5（D-58 · 锚 A30-8 / A30-9）：注入面消毒 + 失败可诊断 ═══════════════
//
// 来源：会诊 #13 **全灭**的已确证真因（子会话落盘 `turn/end` seq 7 铁证 + 平台源码链 + 本地解码
// 复现）：注入文本里的**裸会话引用形态**被平台当 canonical URI 解析 ⇒ base64url + JSON.parse 抛 ⇒
// 整回合 `reason.kind="error"` ⇒ 子代理 `stopReason="error"`（**不带 diagnostic**）⇒ 插件只渲染
// 一行「child ended: error」。本组的消费面与 D-28 腿同源 = **digest**。
// ★ 判据正则**以字面钉进本档**（**不 import 平台模块**——避免测试与平台内部耦合）；
//   来源坐标 = `dsh-session-reference/lib/types/uri.js:59` 的 bare 分支：
//     /@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[^\s)]*)\)|(dsh-session:[A-Za-z0-9_-]+)/gu
//   本档只钉**裸分支那一半**（它才是 #13 命中的那一路）。
const PLATFORM_BARE_SESSION_REF = /(dsh-session:[A-Za-z0-9_-]+)/gu
/**
 * 病态样本**以拼接形态**写（不写整串字面）：设计 §2.0 C 的写作纪律——裸简写不得作为整串出现在
 * 可能被注入的文本里；本档照此形态，免得测试自己成为下一个罪证源（判据正则仍是字面，见上）。
 */
const BARE_REF_SAMPLE = "dsh-session" + ":" + "483-499"
/** 带路径的引用形态（合规写法）：平台两个分支都**不命中**（`dsh-session` 之后是 `/` 而非 `:`）。 */
const PATH_REF_SAMPLE = "dsh-session/lib/types/index.js:483-499"
/** 平台 bare 分支的命中数。**每次新建正则**：带 `g` 的正则有 `lastIndex` 状态，复用会让断言互相污染。 */
const bareRefHits = (text) => [...String(text).matchAll(new RegExp(PLATFORM_BARE_SESSION_REF.source, "gu"))].length
/** 假 codex 子进程调用记录里**真的发起了任务**的那些（`args[0] === "exec"`；探测调用不算）。 */
const execCalls = (log) => (Array.isArray(log) ? log : []).filter((args) => args[0] === "exec")

/**
 * 假 codex 子进程（注入缝 `deps.spawn`；形状对齐 test/codex-runner.test.mjs 的同族夹具）：
 * `--version` ⇒ 探测成功；`debug models` ⇒ 非零退出（目录走 models_cache.json 兜底）；
 * 其余（exec）⇒ 非零退出 + stderr（本组要证的正是 stderr / exit code 上浮进 digest）。
 */
function a30CodexSpawn(stderrText, log) {
  return (_file, args) => {
    // 派发面取证：`args[0] === "exec"` 才是**真的发起了 codex 任务**（`--version` / `debug models` 只是探测）
    if (Array.isArray(log)) log.push(args.slice())
    const child = new EventEmitter()
    child.pid = 424242
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.stdin = { write() { }, end() { } }
    child.kill = () => { }
    ;(async () => {
      // ★ 先让出一拍再发事件：调用方是在 spawn 返回**之后**才挂 `stdout/stderr.on("data")` 的，
      //   同步 emit 会整批丢失（现场形态 = 「codex --version 退出码 0（输出: ）」⇒ RUNNER_UNAVAILABLE）。
      await sleep(0)
      if (args.includes("--version")) {
        child.stdout.emit("data", Buffer.from("codex-cli 0.150.1\n"))
        await sleep(5)
        child.emit("exit", 0)
        return
      }
      if (args.includes("models")) { await sleep(5); child.emit("exit", 1); return }
      child.stderr.emit("data", Buffer.from(stderrText))
      await sleep(5)
      child.emit("exit", 1)
    })()
    return child
  }
}

/** 批 30 / US-5（A30-8 / A30-9）的可机检腿——并入既有块（台账 §三零改：本档零新增顶层 `test(`）。 */
async function b30InjectionAndDiagnosticsChecks() {
  // ——— ① A30-8 谓词自证（先证可判，再对真档断言） ———
  assert.equal(bareRefHits(BARE_REF_SAMPLE), 1, "谓词自证：裸形态必须命中平台 bare 分支（不是恒假断言）")
  assert.equal(bareRefHits(PATH_REF_SAMPLE), 0, "谓词自证：带路径形态**本就不命中**（`dsh-session` 之后是 `/`）")
  assert.equal(bareRefHits(sanitizeInjectedText(BARE_REF_SAMPLE)), 0, "★ 消毒后不再命中（删掉消毒 ⇒ 本行必红）")
  assert.ok(sanitizeInjectedText(BARE_REF_SAMPLE).includes("\u200B"), "断开方式 = 插入零宽空格")
  assert.equal(sanitizeInjectedText(BARE_REF_SAMPLE).replace(/\u200B/g, ""), BARE_REF_SAMPLE,
    "除插入的零宽空格外**逐字不变**（纯替换，不做任何其它改写）")
  assert.equal(sanitizeInjectedText(PATH_REF_SAMPLE), PATH_REF_SAMPLE, "带路径的引用形态**一字不改**（原样保留）")
  assert.equal(sanitizeInjectedText("普通正文\n第二行"), "普通正文\n第二行", "无关文本逐字不变（含换行）")

  // ——— ①b 批 30 修复轮 / 码评 🟡#1：**markdown 提及分支**的形态腿（轮 1 的消毒面扩了它，却没有腿）———
  // 病（码评实证）：消毒的 F3 订正把「`](` 紧跟 `dsh-session:`」这一**上下文形态**一并纳入断开面，
  //   但**没有任何断言**覆盖它 ⇒ 删掉那一半、只留 bare 分支时**全套仍绿**（净损失一条防线）。
  // 判据正则**以字面钉住平台提及分支**：`@\[…\]\((dsh-session:[^\s)]*)\)`（来源坐标同上：
  //   `dsh-session-reference/lib/types/uri.js:59`；载荷是 `[^\s)]*` ⇒ **任意、可为空**）。
  //   两个判据：① **载荷侧** `(dsh-session:[^\s)]*)`（与设计/工单逐字同形）；② **完整提及形态**
  //   `\]\((dsh-session:[^\s)]*)\)`——后者才是平台正则真正要求的那一形（带 `](` 上下文与收尾 `)`）。
  //   它与 bare 分支的载荷形状**不同** ⇒ 两半可各自转红（删任一半，对位的断言必红）。
  const MENTION_PAYLOAD_RE = /(dsh-session:[^\s)]*)/gu
  const MENTION_FULL_RE = /\]\((dsh-session:[^\s)]*)\)/gu
  const hitsOf = (re, text) => [...String(text).matchAll(new RegExp(re.source, "gu"))].length
  const mentionPayloadHits = (text) => hitsOf(MENTION_PAYLOAD_RE, text)
  const mentionFullHits = (text) => hitsOf(MENTION_FULL_RE, text)
  const MD_REF_SAMPLE = "](" + "dsh-session" + ":" + "!!!"   // 载荷**非词字符开头**：bare 分支本就不命中
  const MD_REF_EMPTY = "](" + "dsh-session" + ":" + ")"      // 载荷**为空**：bare 分支同样不命中
  assert.equal(mentionPayloadHits(MD_REF_SAMPLE), 1, "谓词自证：提及形态的**载荷侧**必须命中（不是恒假断言）")
  assert.equal(bareRefHits(MD_REF_SAMPLE), 0, "谓词自证：该样本**本就不命中** bare 分支（故本段只裁 markdown 那一半）")
  assert.equal(mentionPayloadHits(MD_REF_EMPTY), 1, "谓词自证：空载荷形态同样命中提及载荷侧")
  assert.equal(mentionFullHits(MD_REF_EMPTY + "x)"), 1, "谓词自证：**完整提及形态**（带收尾 `)`）命中")
  assert.equal(mentionPayloadHits(sanitizeInjectedText(MD_REF_SAMPLE)), 0,
    "★ 🟡#1 决定性（markdown 半）：消毒后不再命中提及载荷侧（删掉实现里 `](dsh-session:` 那一半 ⇒ 本行必红）")
  assert.equal(mentionPayloadHits(sanitizeInjectedText(MD_REF_EMPTY)), 0, "空载荷形态同样被断开（载荷任意 ⇒ 不能只断词字符形态）")
  assert.equal(mentionFullHits(sanitizeInjectedText(MD_REF_EMPTY + "x)")), 0,
    "★ 完整提及形态（`](dsh-session:<载荷>)`）消毒后不再命中（平台正则真正要求的那一形）")
  assert.equal(sanitizeInjectedText(MD_REF_SAMPLE).replace(/\u200B/g, ""), MD_REF_SAMPLE,
    "仍是**纯替换**（只插入零宽空格，`](` 与其余文本一字不改）")
  assert.ok(sanitizeInjectedText(MD_REF_SAMPLE).includes("](") && sanitizeInjectedText(MD_REF_SAMPLE).includes("!!!"),
    "★ 断言「`](` 上下文被保留」——实现若把整段 `](dsh-session:` 删掉，本行与上一行同时红")
  // 另一半（bare）的独立可转红：**只**断 markdown 上下文时，带词字符载荷的形态仍会命中
  assert.equal(bareRefHits(sanitizeInjectedText(BARE_REF_SAMPLE)), 0,
    "★ 🟡#1 决定性（bare 半）：`dsh-session:` + 词字符载荷仍被断开（删掉那一半 ⇒ 本行必红）")

  // ——— ② A30-8 行为腿：经**真实派发路径**（prompt 装配点）验证两个来源都过消毒 ———
  {
    const sub = makeSubagents({ delayMs: 10, reply: "ok" })
    const h = makeDeps({ subagents: sub })
    // 注入源：① 问题正文含裸形态；② 主历史派生消息里**同时**含裸形态与带路径形态
    h.deps.agent.session.deriveMessages = () => [
      { role: "user", content: [{ type: "text", text: "证据：裸 " + BARE_REF_SAMPLE + " 与带路径 " + PATH_REF_SAMPLE }] },
    ]
    try {
      await startConsultSession(h.deps, "问题里的裸形态 " + BARE_REF_SAMPLE, undefined)
      await waitFor(() => sub.started.length === 1)
      const promptText = (sub.started[0].req.prompt ?? []).map((part) => part?.text ?? "").join("\n")
      assert.ok(promptText.length > 0, "前置：prompt 文本可读（假子代理收到真实装配结果）")
      assert.equal(bareRefHits(promptText), 0,
        "★ 派发出去的 prompt 里**零命中**平台 bare 分支（问题正文与主历史两个来源都过消毒；漏一处本行必红）")
      assert.ok(promptText.includes(PATH_REF_SAMPLE), "带路径的引用形态原样保留在注入文本里")
      assert.ok(promptText.includes("问题里的裸形态"), "问题正文照常注入（消毒不改其余内容）")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ——— ③ A30-9 证据通路的 slug 移植必须与**真机观测值**一致（否则定位永远走不到主路径） ———
  assert.equal(projectKeySlug("D:\\DSH-Portable\\plugins\\dsh-thincoder-suite"),
    "--D-DSH-Portable-plugins-dsh-thincoder-suite--",
    "slug 移植 == 本机 $DSH_HOME/sessions/ 下的真实目录名（逐字比对；漂移 ⇒ 本行红）")
  const zstdOk = typeof nodeZlib.zstdCompressSync === "function" && typeof nodeZlib.zstdDecompressSync === "function"

  // ——— ④ A30-9 形态一「有 reason」：stopReason=error 且**无 diagnostic** ⇒ digest 带出真因 ———
  {
    const childId = "a30-9-child-" + (++seq)
    const sub = {
      started: [],
      async start(_kind, req) {
        sub.started.push(req)
        return { id: childId, result: Promise.resolve({ output: [], stopReason: "error" }), dispose: async () => { } }
      },
    }
    const h = makeDeps({ subagents: sub })
    try {
      const frames = [
        JSON.stringify({ type: "session", version: 4, id: childId }),
        JSON.stringify({ type: "turn/end", seq: 7, time: 1, data: { turn: 1, reason: { kind: "error", error: { message: "A30-9 真因：Unexpected token", code: "UNKNOWN" } } } }),
      ]
      const dir = join(h.dshHome, "sessions", projectKeySlug(h.cwd), childId)
      mkdirSync(dir, { recursive: true })
      const frameBytes = frames.map((f) => nodeZlib.zstdCompressSync(Buffer.from(f + "\n", "utf8")))
      writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.concat(frameBytes))
      const r = await startConsultSession(h.deps, "问题", undefined)
      const digest = await waitDigest(sessOf(h.state, r.id))
      if (zstdOk) {
        assert.ok(digest.includes("child session turn/end"),
          "★ digest 带出兜底读到的真因（删掉兜底读 ⇒ 本行必红）：" + JSON.stringify(digest.slice(0, 260)))
        assert.ok(digest.includes("Unexpected token"), "真因原文（reason.error.message）在场（不是只给 stopReason）")
        assert.ok(digest.includes("error: A30-9 真因"), "reason.kind 一并带出（单行证据行）")
      } else {
        assert.ok(digest.includes("子代理面不可诊断"),
          "本运行时不带 zstd ⇒ 如实降级声明「不可诊断」（诚实降级，不假装读到）")
      }
      assert.ok(digest.includes("child ended: error"), "既有 stopReason 语义不变（兜底只**追加**证据）")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ——— ⑤ A30-9 形态二「无 reason（退路）」：会话档不存在 / 子会话 id 缺失 ⇒ **如实声明不可诊断** ———
  {
    const sub = {
      started: [],
      async start(_kind, req) {
        sub.started.push(req)
        // 子会话 id 缺失（无 id / 无 localAgent）= 定位不到会话档的**最保守形态**
        return { result: Promise.resolve({ output: [], stopReason: "error" }), dispose: async () => { } }
      },
    }
    const h = makeDeps({ subagents: sub })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      const digest = await waitDigest(sessOf(h.state, r.id))
      assert.ok(digest.includes("子代理面不可诊断"),
        "★ 退路：定位 / 解压 / id 任一不可得 ⇒ digest **明写**「子代理面不可诊断」（不假装、不吞掉）："
          + JSON.stringify(digest.slice(0, 260)))
      assert.ok(!digest.includes("child session turn/end"), "退路里**不得**出现「读到了真因」的措辞")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ——— ⑥ A30-9 ③ codex 行：`env.diagnostics`（exit code / stderr）**一并显示**，不再只显示 userMessage ———
  {
    const codexCwd = mkdtempSync(join(tmpdir(), "consult-codex-home-"))
    writeFileSync(join(codexCwd, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-a30-9", display_name: "gpt-a30-9", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }], default_reasoning_level: "low", visibility: "list", context_window: 128000 }],
    }), "utf8")
    const sub = makeSubagents({ delayMs: 10, reply: "unused" })
    const h = makeDeps({ subagents: sub, config: { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-a30-9", executable: "codex-b30-9" } }] } })
    const codexLog = []
    Object.assign(h.deps, {
      spawn: a30CodexSpawn("A30-9 codex stderr: model not supported with a ChatGPT account\n", codexLog),
      platform: "linux",
      env: { CODEX_HOME: codexCwd, PATH: "" },
    })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      const digest = await waitDigest(sessOf(h.state, r.id))
      assert.equal(sub.started.length, 0, "前置：codex 行不走 dsh 子代理面（独立配置面）")
      assert.ok(digest.includes("codex-cli PROCESS_ERROR"), "codex 行失败照常进 digest：" + JSON.stringify(digest.slice(0, 200)))
      assert.ok(digest.includes("A30-9 codex stderr"),
        "★ stderr 原文上浮（旧实现 `userMessage || diagnostics` 二选一 ⇒ userMessage 在场就把真因吞掉，本行必红）")
      assert.ok(digest.includes("exit=1"), "exit code 同样上浮（diagnostics 的两半都在）")
      assert.ok(execCalls(codexLog).length >= 1, "正向对照：该行**确实发起过** codex exec（下面的「零 exec」断言不是恒真）")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ═══ 批次 30 / US-7（D-59 · 锚 A30-11）：池行**前置可用性预检** ═══
  // 形态：池里含**配置性必败行** ⇒ 该行**不被派发**且点名。判据 = ①digest/文案点名「因配置未派发」
  // + 原因；②**零 codex exec 调用**（假子进程的调用记录是「确实没派发」的直接证据，不是推断）。

  // ——— ⑦ 模型**不在目录内** ⇒ 该行不派发、digest 点名；同池的 dsh 行照常结算（不连坐） ———
  {
    const codexHome = mkdtempSync(join(tmpdir(), "consult-pf-a-"))
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-in-catalog", supported_reasoning_levels: [{ effort: "low" }] }],
    }), "utf8")
    const log = []
    const sub = makeSubagents({ delayMs: 10, reply: "dsh 行照常回复" })
    const h = makeDeps({
      subagents: sub,
      config: { consultModels: [
        { provider: "p", model: "m" },
        { runner: { kind: "codex-cli", model: "gpt-a30-11-absent", executable: "codex-b30-11a" } },
      ] },
    })
    Object.assign(h.deps, { spawn: a30CodexSpawn("unused\n", log), platform: "linux", env: { CODEX_HOME: codexHome, PATH: "" } })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      assert.ok(r && r.id, "前置：仅一行必败 ⇒ 池不整体拒发：" + JSON.stringify(r).slice(0, 200))
      const digest = await waitDigest(sessOf(h.state, r.id)) // 等整批 settle 后再取证（此时该派发的都已派发）
      assert.equal(execCalls(log).length, 0,
        "★ 必败的 codex 行**未被派发**（settle 后仍零 exec 调用——假子进程调用记录直接取证，不是推断）")
      assert.equal(sub.started.length, 1, "其余 dsh 行照常派发（一次）")
      assert.ok(digest.includes("因配置未派发"),
        "★ digest 点名「因配置未派发」：" + JSON.stringify(digest.slice(0, 320)))
      assert.ok(digest.includes("codex-cli:gpt-a30-11-absent"), "点名**是那一行**（模型标签逐字在场）")
      assert.ok(digest.includes("不在 codex 模型目录内"), "带出**原因**（目录未命中）")
      assert.ok(digest.includes("dsh 行照常回复"), "其余行照常结算（预检不连坐）")
      assert.equal(sessOf(h.state, r.id).models.join(","), "p:m", "session.models 只含**实际派发**的行")
      assert.equal(sessOf(h.state, r.id).total, 1, "total = 实际派发行数（计数口径与派发面一致）")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ——— ⑧ `reasoningEffort` 不被接受**且无法回落**（只能原样透传）⇒ 同样不派发；池内唯一行必败 ⇒ 整池拒发 ———
  // ★ 判据收窄（见 lib/codex-adapter.mjs 的 preflightCodexRow ②）：可回落的「不被接受」**不拦**
  //   （那是既有回落链的职责，由 codex-runner 测试档的两条回落腿钉住）；只有「连回落都做不到 ⇒
  //   只能把一个已知不被支持的值原样送给 codex」才是配置性必败。
  {
    const codexHome = mkdtempSync(join(tmpdir(), "consult-pf-b-"))
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      // 该模型只声明一个**插件梯子不认识的**档 ⇒ 解析器无法映射 ⇒ 只能原样透传（必败形态）
      models: [{ slug: "gpt-eff-offladder", supported_reasoning_levels: [{ effort: "minimal" }] }],
    }), "utf8")
    const log = []
    const h = makeDeps({
      subagents: makeSubagents({ delayMs: 10, reply: "unused" }),
      config: { consultModels: [
        { runner: { kind: "codex-cli", model: "gpt-eff-offladder", effort: "max", executable: "codex-b30-11b" } },
      ] },
    })
    Object.assign(h.deps, { spawn: a30CodexSpawn("unused\n", log), platform: "linux", env: { CODEX_HOME: codexHome, PATH: "" } })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      assert.ok(r && r.error, "池内**唯一**行必败 ⇒ 整体拒发（响亮、零派发）：" + JSON.stringify(r).slice(0, 260))
      assert.ok(r.error.includes("因配置未派发"), "拒发文案点名「因配置未派发」")
      assert.ok(r.error.includes("不被 codex model gpt-eff-offladder 接受"), "拒发文案带出原因（effort 不被接受）")
      assert.ok(r.error.includes("无法映射到任何受支持档"), "原因里点明**为何不可回落**（只能原样透传）")
      assert.ok(r.error.includes("supported: minimal"), "原因里含该模型**实际支持**的档位（可行动）")
      assert.equal(execCalls(log).length, 0, "★ 零 exec：该行确实没被派发（省下的正是那一行预算）")
    } finally { cleanup(h.sessionId, h.state) }
  }

  // ——— ⑨ 诚实降级：**目录不可得** ⇒ 不拦（fail-open，退回既有行为）+ 响亮 note（绝不假装拦住） ———
  {
    const codexHome = mkdtempSync(join(tmpdir(), "consult-pf-c-")) // 空目录：无 models_cache.json ⇒ 目录不可得
    const log = []
    const h = makeDeps({
      subagents: makeSubagents({ delayMs: 10, reply: "unused" }),
      config: { consultModels: [{ runner: { kind: "codex-cli", model: "gpt-unknown-a30-11", executable: "codex-b30-11c" } }] },
    })
    Object.assign(h.deps, { spawn: a30CodexSpawn("A30-11 目录不可得时的 stderr\n", log), platform: "linux", env: { CODEX_HOME: codexHome, PATH: "" } })
    const warns = []
    const origWarn = console.warn
    try {
      console.warn = (...a) => { warns.push(a.map(String).join(" ")) }
      const r = await startConsultSession(h.deps, "问题", undefined)
      assert.ok(r && r.id, "★ 目录不可得 ⇒ **不拦**（fail-open：绝不因读不到而砖化）：" + JSON.stringify(r).slice(0, 240))
      const digest = await waitDigest(sessOf(h.state, r.id)) // 派发在 job 体内异步发生 ⇒ 等 settle 再取证
      assert.ok(execCalls(log).length >= 1, "该行照常派发（settle 后有 exec 调用）")
      assert.ok(!digest.includes("因配置未派发"), "零「因配置未派发」——降级路径不假装拦住")
      assert.ok(warns.some((w) => w.includes("前置预检")),
        "如实标注该降级（裸 console.warn）：" + JSON.stringify(warns.slice(0, 3)))
    } finally {
      console.warn = origWarn
      cleanup(h.sessionId, h.state)
    }
  }

  // ——— ⑩ 反向对照（**不得误拦**）：可回落的「不被接受」照常派发（既有回落链消化） ———
  // 这条腿防的是「收窄过头」：model [low,high] + 请求 medium ⇒ 解析器回落 high ⇒ 预检**放行** ⇒
  // 该行照常 exec（与 codex-runner 测试档的两条回落腿同一语义——本批不得把既有回落地判死）。
  {
    const codexHome = mkdtempSync(join(tmpdir(), "consult-pf-d-"))
    writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-mappable", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }],
    }), "utf8")
    const log = []
    const h = makeDeps({
      subagents: makeSubagents({ delayMs: 10, reply: "unused" }),
      config: { consultModels: [
        { runner: { kind: "codex-cli", model: "gpt-mappable", effort: "medium", executable: "codex-b30-11d" } },
      ] },
    })
    Object.assign(h.deps, { spawn: a30CodexSpawn("mappable row（照常派发后失败）\n", log), platform: "linux", env: { CODEX_HOME: codexHome, PATH: "" } })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      assert.ok(r && r.id, "★ 可回落行**不得**被预检拦下（拦下 = 打断既有回落语义）：" + JSON.stringify(r).slice(0, 240))
      const digest = await waitDigest(sessOf(h.state, r.id))
      assert.ok(execCalls(log).length >= 1, "该行照常派发（settle 后有 exec 调用）")
      assert.ok(!digest.includes("因配置未派发"), "digest 里零「因配置未派发」（没被误拦）")
      assert.ok(digest.includes("falling back to nearest supported effort"),
        "既有回落 note 照常进回复尾部（medium ⇒ high，回落语义未被本批改动）：" + JSON.stringify(digest.slice(0, 300)))
    } finally { cleanup(h.sessionId, h.state) }
  }
}
/**
 * 批 30 / US-6（D30-6 · 锚 A30-10）：**权限面判据读模型请求头**。
 * 判据（设计 §2.6 硬要求）：「工具面已生效 / 只读已生效」这类断言，证据只能是**模型可见工具面**
 *（子会话落盘 `request/header` 事件），**不得**以「`restrict` 未抛错」代替；读不到 ⇒ 如实标注
 * **「模型面未验」**（并带「本部署无法保证只读」）。
 * ★ 本函数的样本**不经平台**：自造多帧 zstd 会话档（与 A30-9 同形的夹具）。
 * ★ ⓪ 段补的是设计 §2.6 末句的另一半（分歧修复轮 F1 / 审计实证：该声明**只在 eng_coder 的模型面
 *   证据行**、会诊侧零命中）：**「若平台面无法收窄 ⇒ 如实标注『本部署无法保证只读』，并在会诊产物里
 *   带该声明」** ⇒ 会诊的**两条产物**（派发回复的 detail 段 · settle 后的 digest）各一条腿；
 *   外加一条**跨档防漂移锁**（与 `lib/eng.mjs` 的 `renderModelSurfaceEvidence` 同一句）。
 * ★ 并入既有块（台账 §三零改：本档零新增顶层 `test(`）。
 */
async function b30PermissionSurfaceChecks() {
  // ——— ⓪ **会诊产物**必须带如实声明（设计 §2.6 末句逐字：「若平台面无法收窄 ⇒ 如实标注『本部署
  // 无法保证只读』，**并在会诊产物里带该声明**」）———
  // ★ 分歧修复轮 F1 的实证：该声明此前**只在 eng_coder 的模型面证据行**（lib/eng.mjs 的
  //   renderModelSurfaceEvidence），会诊侧零命中 ⇒ 本段把「会诊产物」这一半钉死。
  // ★ 两条产物各一条独立腿（派发回复的 detail 段 / settle 后的 digest）：**任一**缺声明或被改写成
  //   「只读生效」即红（分离断言 ⇒ 删哪一处都能定位，不是一条恒绿的大断言）。
  const READONLY_CORE = "本部署无法保证只读（平台面无法收窄）"
  {
    const sub = makeSubagents({ delayMs: 10, reply: "artifact-ok" })
    const h = makeDeps({ subagents: sub })
    try {
      const r = await startConsultSession(h.deps, "问题", undefined)
      const dispatch = String(r.text ?? "")
      assert.ok(dispatch.includes(READONLY_CORE),
        "★ A30-10：**派发产物**必须带如实声明「" + READONLY_CORE + "」：" + dispatch)
      assert.ok(dispatch.includes("弱证") && dispatch.includes("模型面"),
        "★ 声明必须附**证据口径**（弱证 = allow 白名单下发 / 模型面 = 子会话 request/header）：" + dispatch)
      assert.ok(!dispatch.includes("只读会诊"),
        "★ 派发产物**不得**再自称「只读会诊」（平台面不可收窄：allow 白名单 ≠ 只读保证）：" + dispatch)
      const digest = await waitDigest(sessOf(h.state, r.id))
      const headLines = digest.split("\n").slice(0, 4).join(" / ")
      assert.ok(digest.includes(READONLY_CORE), "★ A30-10：**digest** 必须带如实声明：" + headLines)
      assert.ok(digest.includes("弱证") && digest.includes("模型面") && digest.includes("request/header"),
        "★ digest 的声明必须附证据口径（弱证 + 模型面通道）：" + headLines)
      assert.ok(digest.includes("[run_code]"),
        "★ 声明须带本部署实测模型面（[run_code] 单元素 ⇒ 残余绕行口在场）：" + headLines)
      assert.ok(!digest.includes("只读生效"),
        "★ 声明**不得**被改写成「只读生效」（现场证据相反：会诊子会话实际改写过设计档）：" + headLines)
    } finally { cleanup(h.sessionId, h.state) }
  }
  // ★ 跨档防漂移锁：consult 侧与 `lib/eng.mjs`（renderModelSurfaceEvidence 的未验分支）必须**同一句**
  //   ——平台口径更新时两处同改；只改一处 ⇒ 本锁红（「同源」是可机检的性质，不是注释里的承诺）。
  {
    const engSrc = readFileSync(new URL("../lib/eng.mjs", import.meta.url), "utf8")
    const consultSrc = readFileSync(new URL("../lib/consult.mjs", import.meta.url), "utf8")
    assert.ok(engSrc.includes(READONLY_CORE), "前置：eng.mjs 的模型面证据仍以本句为口径（同源基座）")
    assert.ok(consultSrc.includes(READONLY_CORE), "★ 同源：consult.mjs 必须逐字含本句（防两处漂移）")
  }

  const zstdOk = typeof nodeZlib.zstdCompressSync === "function" && typeof nodeZlib.zstdDecompressSync === "function"
  const childId = "a30-10-child-" + (++seq)
  const cwd = mkdtempSync(join(tmpdir(), "consult-a30-10-cwd-"))
  const home = mkdtempSync(join(tmpdir(), "consult-a30-10-home-"))
  const agent = { session: { id: "a30-10-parent", header: { cwd } } }
  const run = { id: childId, localAgent: { session: { id: childId, header: { cwd } } } }
  const dir = join(home, "sessions", projectKeySlug(cwd), childId)
  const writeFrames = (frames) => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "session.v4.jsonl.zstd"), Buffer.concat(
      frames.map((f) => nodeZlib.zstdCompressSync(Buffer.from(f + "\n", "utf8")))))
  }

  if (!zstdOk) {
    // 本运行时不带 zstd ⇒ 判据**必须**如实降级（不得因为「restrict 没抛错」就说已生效）
    const noZstd = readChildModelToolSurface({ dshHome: home }, run, agent)
    assert.equal(noZstd.verified, false, "无 zstd ⇒ 模型面未验（诚实降级）")
    assert.ok(renderModelSurfaceEvidence(noZstd, ["pwsh"]).includes("模型面未验"), "如实标注「模型面未验」")
    return
  }

  // ——— ① 主形态：请求头里**只有** run_code ⇒ 命名面生效 + 残余绕行口如实标注 ———
  // ★ 多帧：`request/header` 落在**第二个**帧 ⇒ 同时验证「按 magic 切帧循环」（只读第一帧会漏）
  writeFrames([
    JSON.stringify({ type: "session", version: 4, id: childId }),
    JSON.stringify({ type: "request/header", seq: 3, time: 1, data: { header: { reason: "initial", tools: [{ name: "run_code", description: "PTC transport" }] } } }),
  ])
  const surface = readChildModelToolSurface({ dshHome: home }, run, agent)
  assert.equal(surface.verified, true,
    "★ A30-10：判据读的是**模型请求头**（request/header；多帧切帧解压后仍能读到）：" + JSON.stringify(surface))
  assert.deepEqual(surface.tools, ["run_code"], "工具面逐字来自请求头（不是派发载荷、也不是平台回显）")
  const line = renderModelSurfaceEvidence(surface, ["pwsh", "bash"])
  assert.ok(line.includes("request/header"), "证据行点名**证据来源**：" + line)
  assert.ok(line.includes("模型可见工具面 = [run_code]"), "逐字带出模型可见面：" + line)
  assert.ok(line.includes("执行类命名工具在场 0 个") && line.includes("命名面收窄生效"),
    "命名面生效由**模型面**判定：" + line)
  assert.ok(line.includes("残余绕行口") && line.includes("run_code"),
    "★ run_code 在场 ⇒ 如实标注**残余绕行口**（平台保留传输面不可收窄）：" + line)

  // ——— ② 反向（防「判据恒绿」）：请求头里**确有**执行类命名工具 ⇒ 必须判「收窄未生效」 ———
  writeFrames([
    JSON.stringify({ type: "request/header", seq: 1, time: 1, data: { header: { tools: [{ name: "pwsh" }, { name: "run_code" }] } } }),
  ])
  const leaked = readChildModelToolSurface({ dshHome: home }, run, agent)
  const leakedLine = renderModelSurfaceEvidence(leaked, ["pwsh", "bash"])
  assert.deepEqual(leaked.tools, ["pwsh", "run_code"], "反向样本的工具面逐字来自请求头")
  assert.ok(leakedLine.includes("收窄未生效") && leakedLine.includes("pwsh"),
    "★ 谓词不是恒绿：请求头里确有执行类 ⇒ 判**未生效**并点名：" + leakedLine)
  assert.ok(!leakedLine.includes("命名面收窄生效"), "不得同时说生效与未生效：" + leakedLine)

  // ——— ③ 三处如实降级：定位不到 / 事件不含工具面 / 子会话 id 不可得 ⇒ **模型面未验** ———
  const missing = readChildModelToolSurface({ dshHome: home }, { id: "no-such-child-" + (++seq) }, agent)
  assert.equal(missing.verified, false, "定位不到会话档 ⇒ 未验（不假装读到）")
  const missingLine = renderModelSurfaceEvidence(missing, ["pwsh"])
  assert.ok(missingLine.includes("模型面未验"), "★ 明写「模型面未验」：" + missingLine)
  assert.ok(missingLine.includes("不得以「restrict 未抛错」代替"), "★ 明写不得用「未抛错」顶替模型面证据：" + missingLine)
  assert.ok(missingLine.includes("本部署无法保证只读"), "★ 平台面无法收窄 ⇒ 如实声明「本部署无法保证只读」：" + missingLine)
  assert.ok(!missingLine.includes("收窄生效") && !missingLine.includes("已生效"),
    "★ 未验时**绝不**出现「已生效」类措辞（判据伪装的正是这一格）：" + missingLine)
  // 事件在场但不含工具面（形状漂移）⇒ 同样未验，与「读不到档」分开归因
  writeFrames([JSON.stringify({ type: "request/header", seq: 2, time: 1, data: { reason: "series" } })])
  const noTools = readChildModelToolSurface({ dshHome: home }, run, agent)
  assert.equal(noTools.verified, false, "request/header 在场但无工具面 ⇒ 未验")
  assert.ok(noTools.reason.includes("没有可读的工具面"), "归因可读（形状漂移 vs 档不可得，分开写）：" + noTools.reason)
  // 子会话 id 不可得 ⇒ 未验（不抛）
  assert.equal(readChildModelToolSurface({ dshHome: home }, { localAgent: { session: {} } }, agent).verified, false,
    "子会话 id 不可得 ⇒ 未验（不抛）")
  // 连运行对象都没有 ⇒ 未验（不抛；取证面永不成为新的失败源）
  assert.equal(readChildModelToolSurface({ dshHome: home }, null, null).verified, false, "无 run/agent ⇒ 未验（不抛）")
}
test("selectConsultModels（provider:model / 裸 provider / 裸 model / 未知）+ 批 15 交付与消化面（AC-1…AC-26 的腿）+ 修复轮补腿（AC-7 形状 · AC-16 正向锁 · AC-20 alreadySettled · AC-23/US-12）+ 收尾修复轮补腿（交付代码评审 #1 看门狗清除 · #2 终结事件 sessionId 与幽灵孤儿 · #3 落点路径字面锁）+ 批 30 / US-5 补腿（A30-8 注入面消毒 · A30-9 失败可诊断两形态 + codex 行 diagnostics）", async () => {
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

  await b15DeliveryChecks()
  await b15RefusalChecks()
  await b15ExemptionChecks()
  await b15GateChecks()
  await b15OrphanChecks()
  await b15WatchdogLeakChecks()
  await b15GhostOrphanChecks()
  await b15RobustnessChecks()
  await b15ShapeAndSurfaceChecks()
  // 批 30 / US-5（D-58 · A30-8 / A30-9）：注入面消毒 + 失败可诊断（并入既有块——台账 §三零改）
  await b30InjectionAndDiagnosticsChecks()
  // 批 30 / US-6（D30-6 · A30-10）：权限面判据读模型请求头（无法收窄即如实标注）
  await b30PermissionSurfaceChecks()
})

// ═════════ D-52 / A29-7（批 29 单②）：会诊只读白名单的**对位锁** ═════════
//
// 病（2026-09-26 取证）：会诊子代理的只读白名单（`READONLY_TOOLS` / `READONLY_TOOLS_CORE`）
// 是 consult.mjs 的模块私有常量，**没有任何对位锁**——白名单被改动（混进写类工具 / 换成 deny
// 黑名单语义 / 干脆不再下发 toolFilter）时，全套测试**一片绿**。本档补两条：
//   ① **静态**：白名单成员集恰为只读集合（零写类工具）+ 两处派发点都以 `allow` 键下发；
//   ② **行为**：`ctx.subagents.start("spawn", …)` 收到的 spec 里 `toolFilter.allow` 逐项在场、
//      且**不得**出现 `deny`（平台契约：`allow` = keep only / `deny` = remove；两种语义不可混用）。
// 平台契约（2026-09-26 取证）：`restrict(filter)` 的 `allow` = keep only，`deny` = remove；
// 未注册名会被**响亮拒绝**——这正是 consult.mjs 那条 `unknown → 降级核心三件` 重试腿的由来。
test("A29-7 (D-52): 会诊只读白名单对位锁——静态成员集 = 只读集合且 allow 键在场；行为：派发 spec 零 deny、allow 逐项在场", async () => {
  // —— 谓词（先自证可判违规，再对真档断言）——
  const READONLY_UNIVERSE = ["read", "glob", "grep", "web_search", "web_fetch"]
  const WRITE_CLASS = ["write", "edit", "run_code", "pwsh", "bash", "powershell", "sh", "zsh", "cmd",
    "shell", "exec", "spawn", "terminal", "process", "run_terminal", "task", "write_file",
    "str_replace_editor", "notebook_edit"]
  const writeIn = (list) => list.filter((t) => WRITE_CLASS.includes(t))
  assert.deepEqual(writeIn(["read", "write"]), ["write"], "谓词自证：写类成员必须被判出（不是恒真断言）")
  assert.deepEqual(writeIn(["read", "glob"]), [], "谓词自证：只读成员不得被误判")

  const src = readFileSync(new URL("../lib/consult.mjs", import.meta.url), "utf8")
  const arrayOf = (name) => {
    const m = new RegExp("const " + name + " = \\[([^\\]]*)\\]").exec(src)
    return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null
  }
  const full = arrayOf("READONLY_TOOLS")
  const core = arrayOf("READONLY_TOOLS_CORE")
  assert.ok(Array.isArray(full) && Array.isArray(core), "两个白名单常量必须可从源码文本解析出来")
  // ① 静态：成员集**恰为**只读集合（逐项 ⊆ 只读全集 ⇒ 零写类工具），且降级集 ⊆ 全集
  assert.deepEqual(full, [...READONLY_UNIVERSE],
    "白名单成员集恰为只读集合（成员漂移即红，须显式更新本锁）：" + JSON.stringify(full))
  assert.deepEqual(core, ["read", "glob", "grep"], "降级集 = 读 + 检索三件：" + JSON.stringify(core))
  assert.deepEqual(writeIn(full), [], "白名单不得混入任何写类工具：" + JSON.stringify(writeIn(full)))
  assert.ok(core.every((t) => full.includes(t)), "降级集必须是全量的子集")
  // ① 静态：两处派发点都用 `allow` 键（keep-only 语义），且**零** `deny`（黑名单语义）
  const allowSites = [...src.matchAll(/toolFilter:\s*\{\s*allow:\s*(READONLY_TOOLS|READONLY_TOOLS_CORE)\s*\}/g)]
    .map((m) => m[1]).sort()
  assert.deepEqual(allowSites, ["READONLY_TOOLS", "READONLY_TOOLS_CORE"].sort(),
    "两处派发点都显式以 allow 键下发白名单：" + JSON.stringify(allowSites))
  assert.equal((src.match(/toolFilter:\s*\{\s*deny/g) ?? []).length, 0,
    "consult.mjs 不得把只读白名单换成 deny 黑名单语义")

  // —— ② 行为：主路径（全量白名单）收到 spec 的 toolFilter ——
  const subA = makeSubagents({ delayMs: 20, reply: "ok" })
  const hA = makeDeps({ subagents: subA })
  try {
    await startConsultSession(hA.deps, "problem", undefined)
    await waitFor(() => subA.started.length === 1)
    assert.equal(subA.started[0].kind, "spawn", "子代理类型 = spawn")
    const tfA = subA.started[0].req.toolFilter
    assert.ok(tfA && typeof tfA === "object", "spec 必须带 toolFilter：" + JSON.stringify(tfA))
    assert.deepEqual(Object.keys(tfA), ["allow"], "toolFilter 恰有 allow 一个键（零 deny）：" + JSON.stringify(Object.keys(tfA)))
    assert.equal(tfA.deny, undefined, "★ 不得出现 deny（一旦出现，语义就从 keep-only 变成黑名单）")
    for (const t of READONLY_UNIVERSE) {
      assert.ok(tfA.allow.includes(t), "白名单逐项在场：" + t + " → " + JSON.stringify(tfA.allow))
    }
  } finally { cleanup(hA.sessionId, hA.state) }

  // —— ② 行为：降级腿（可选工具未注册 ⇒ 平台响亮拒绝 ⇒ 核心三件重试）同样只有 allow ——
  const subB = {
    started: [],
    async start(kind, req) {
      subB.started.push({ kind, req })
      if (subB.started.length === 1) throw new Error("unknown tool: web_search")
      return { result: Promise.resolve({ output: [{ type: "text", text: "ok" }], stopReason: "completed" }), dispose: async () => {} }
    },
  }
  const hB = makeDeps({ subagents: subB })
  try {
    await startConsultSession(hB.deps, "problem", undefined)
    await waitFor(() => subB.started.length === 2)
    assert.deepEqual(subB.started[1].req.toolFilter, { allow: ["read", "glob", "grep"] },
      "降级腿 = 核心三件白名单，且仍零 deny：" + JSON.stringify(subB.started[1].req.toolFilter))
  } finally { cleanup(hB.sessionId, hB.state) }
})

