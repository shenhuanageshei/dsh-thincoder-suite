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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  startConsultSession, stopConsultSession, cleanupConsultSessions, selectConsultModels,
  composeConsultDigest, readConsultLedger, consultDigestionGate, consultLedgerOrphans,
  undigestedConsultSessions, CONSULT_DIGEST_REPLY_CAP,
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
  assert.equal(spec.owner, h.deps.agent)
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

test("selectConsultModels（provider:model / 裸 provider / 裸 model / 未知）+ 批 15 交付与消化面（AC-1…AC-26 的腿）+ 修复轮补腿（AC-7 形状 · AC-16 正向锁 · AC-20 alreadySettled · AC-23/US-12）+ 收尾修复轮补腿（交付代码评审 #1 看门狗清除 · #2 终结事件 sessionId 与幽灵孤儿 · #3 落点路径字面锁）", async () => {
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
})
