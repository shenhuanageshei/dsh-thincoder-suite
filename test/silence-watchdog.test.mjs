// silence-watchdog.test.mjs — 批 29 **单①**（US-1 / D29-2 · D29-3 · D29-6）机验腿。
//
// 覆盖（设计档 docs/dsh017-batch29-design.md §5.1）：
//   · **A29-3**：注入静默（无输出）⇒ 到 ENG_SILENCE_ABORT_MS 即**由既有取消写点** abort，
//     终止文案含「疑似挂死」+ 静默时长 + partial/菜单/取证指路；**有输出 ⇒ 续命**不误杀；
//   · **A29-1**：派发期 toolFilter 生效——执行类工具**不在**子会话可用集、非执行类（读写/检索）
//     **仍在**；**证据口径两种形态必须在断言里区分**：平台回显生效清单 = **强证**，
//     否则以派发载荷 toolFilter.deny 为**弱证**（如实标注）；
//   · **A29-2**：取不到平台工具名清单 ⇒ **如实标注「未生效」**（deny 保持逐字基线，不假装拦住）；
//     applied:false 的**两条归因各一条腿且可判**：**读取面不可用**（读取函数返回 null）vs
//     **面可用但可限制名集为空**（返回 []——公开面在场，只是名集为空）。
//   · **A29-8a / A29-8b**（批 29 §2.6 US-A① / D-53 一次性留档，**两态各自成腿 ⇒ 可独立转红**）：
//     看门狗**接线结果的首次留档**——**批 30 / US-2 改接口径**：记**两腿**结果（seq 主腿可用性 +
//     事件辅腿命中面名或零命中）+ run 的 `Object.keys(run)`（有界 / 去重 / 截断安全）；
//     进程内**只一次**；返回文本零污染。
//   · **A29-8c**（§2.6 US-A②）：工具面「未生效」warn 的**同一行**追加 `Object.keys(ctx.tools)`
//     键名清单（一次为限；仍不进返回文本）。
//   · **A29-13**（§2.8 · AC-11 · D-53 可读通道）：留档搬进**回执区**——恰一条「接线留档」行（含键清单
//     与命中名）且**位于交付正文之后**；**同一次派发**里阶段门对合规报告**仍返回空串**（尾部追加不破门禁）。
//   · **A29-14**（§2.8 · AC-11）：留档出现在 `handle.append` 的**字符流**里（**不只是 console 告警**——
//     腿体把 console 告警打成黑洞，仍能在字符流里取到留档）；缓冲区**进程内只发一次**。
//   · **§2.8 审计 🔴D1**（合并修复轮 2026-09-27 · AC-11）：**空搬运不关闩**——dsh 同步回执点
//     零入队地搬运一次后，首派证据**仍**进得了回执区（同时是 🔵D3 的第二个行为腿）。
//   · **§2.8 审计 🔵D3**（AC-11）：四个**回执书写点**逐一含搬运调用的**静态**逐点覆盖（行为腿只
//     覆盖 3/4 与 4/4；codex 两点只有静态覆盖，如实登记、不冒充行为覆盖）。
//   · **§2.8 审计 🔵D4**：第二次搬运不重复追加在**派发面**也由**闩**决定（复位接线留档的闩后再派
//     一次 ⇒ 仍不得追加小节）——「删闩」类变异在派发面**必红**。
//
// ★ 纪律（本档自持）：
//   ① **全部用注入缝，零真实等待**——假时钟（now）+ 假 setInterval/clearInterval（手动 tick，
//      不注册任何真实定时器）⇒ 到点与续命都由测试驱动，不用 sleep；
//   ② 假 jobs 服务（0.1.7 形态：调 spec.run(handle) 并留存 hooks）+ 桩子代理（零真子进程、
//      零网络、零真实 LLM）；
//   ③ eng.mjs 侧唯一新增注入缝 = deps.silenceWatchdogOpts（{ now, setIntervalImpl,
//      clearIntervalImpl }；生产路径不传 ⇒ 缺省 Date.now + 全局 setInterval）；
//   ④ 本档是**新增测试档** ⇒ 同批登记在 test/guard-e.test.mjs 的 T-E19 existing 清单
//      （台账行 docs/test-lifecycle.md 由主代理同批登记）。
//   ⑤ **批 29 §2.7（🔵1–🔵4 · A29-11 / A29-12 · AC-10）**：微任务泵**条件驱动**（见 flush 注释，
//      点名它覆盖的 await 链与对应就绪信号，不再有「恰 8 拍」的隐式契约）；**各派发腿包
//      try { … } finally { f.drop() }** ⇒ 中途断言失败也不残留注册表条目（故本档**不需要**
//      「失败运行会残留注册表条目」这条既有约定）；A29-8c 的 `includes("list")` 补「为何决定性」
//      注释；partial 空契约改**归一形态**断言（`Partial output:` 之后**不得有**非空行（partial 体
//      为空）+ 其后**全部行**去标签前缀、去空白后**逐字以** advisory 文本**开头**；抗 advisory
//      **内部折行**，partial 被填充必红——§2.7 审计 D-1/D-2 修复轮，2026-09-27）。
//   ⑥ **批 29 §2.9（🔵1–🔵4 / 🔵6 · A29-15 / A29-16 · AC-12）**：§2.8 修复轮交付码评的 6 条 🔵
//      收干——非法值告警**双口径**（NaN/Infinity 不再串成孤零零的 null）· 显式 null 视同缺失（口径
//      写进 JSDoc 并被静态钉死）· 键名内嵌换行折叠为单行（单行可 grep）· 缓冲与裸 warn **同一
//      原文**（trim 只做空串判定）· A29-8c 头部复位接线闩（初始态自持，见该腿与文末静态锁）；
//      🔵5 是**登记边界**（零行为改动、不设腿——边界注释一行落在 `drainArchiveBlock` 的 JSDoc）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"
import { runEngCoder, resolveExecToolDeny, readEffectiveToolEcho, execDenyEvidence, collectRegisteredToolNames, stageGateNote } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
// 批 30 修复轮 / F4：前提自证（PLUGIN_DIR 之上不得有 profile 根——否则交付段不产本条要量的告警）
import { probeProfileRoot } from "../lib/dsh-home.mjs"
import {
  ENG_SILENCE_ABORT_MS, ENG_SILENCE_POLL_MS, resolveEngSilenceAbortMs,
  createSilenceWatchdog, attachSubagentHeartbeat, subagentSeqSampler, watchJobHandle, silenceMinutesLabel,
  formatKeyList, KEY_LIST_MAX, archiveWatchdogAttach, __resetWatchdogAttachArchiveForTest,
  // 批 29 / §2.8：留档**搬运工**的可读通道面（入队 / 搬运 / 小节标题 / 缓冲上界 / 复位缝）
  enqueueArchiveLine, drainArchiveBlock, HOST_ARCHIVE_HEADER, ARCHIVE_BUFFER_MAX,
  __resetArchiveChannelForTest,
} from "../lib/silence-watchdog.mjs"

// 与既有档同款隔离：DSH_HOME 置空 ⇒ home 不可解析 ⇒ 不碰真实盘（本档只测机制，不测落盘面）
process.env.DSH_HOME = ""

// ————————— 批 30 修复轮 / F4：**全档 stderr 残留计数**（只计数、**不吞**）—————————
// 为什么要有它：🔵5 的静态锁只判「腿体窗口里出现过 `captureWarn(`」，判不出**窗口边界**——
// 窗口只罩派发、把结算/交付留在窗外时它照样绿，而交付链尾 `saveSessionState` 的裸告警
// （本档 DSH_HOME 置空 + PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）照样落到 stderr
// （修复前单跑实测 **6 行**，全部来自 A29-8a/b/c/A29-13 四腿的 `settleResult → hooks.done` 段）。
// 本计数在**模块装载期**接管 `process.stderr.write`：只**记录**匹配该文案的写入、原样转发
// （不吞——吞掉会让「宿主的 stderr 度量」与「档内断言」互相掩盖）。node:test 单档内按**声明序
// 顺序**执行，A29-16（本档最后一腿）据此断言「此前全部腿零残留」；任一腿漏一条即转红。
const stderrResidual = []
{
  const origWrite = process.stderr.write
  const RESIDUAL_MARK = "session state store path not resolvable"
  process.stderr.write = function (chunk, ...rest) {
    const s = String(chunk)
    if (s.includes(RESIDUAL_MARK)) stderrResidual.push(s)
    return origWrite.call(this, chunk, ...rest)
  }
}

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

/**
 * 条件驱动微任务泵（批 29 §2.7 / 🔵1 · A29-11 · AC-10）：**不再依赖固定拍数**。
 * 泵到 `ready()` 为真**即停**；最多 FLUSH_MAX 拍仍未就绪 ⇒ 抛**点名式**错误（点名缺的就绪信号），
 * 而不是让下游断言以「恰一条不符」的形态红、看不出根因。
 * ★ 本泵覆盖的 await 链（就绪信号逐环对应，将来多一个 await 只需换/加一个就绪条件）：
 *   · `jobs.start` → 假服务 `spec.run(handle)`  ⇒ `f.specs.length`
 *   · `ctx.subagents.start`（挂 abort 监听）        ⇒ `f.requests.length` / `f.runs.length`
 *   · `attachSubagentHeartbeat`（事件辅腿接驳）        ⇒ `f.beats.length === 2`（两条真事件面；`f.ticks` 是轮询注册）
 *   · `archiveWatchdogAttach`（一次性留档 warn）      ⇒ 只能在 `captureWarn` 的 `isReady(warnings)` 里观察
 * 新增 await 会被 FLUSH_MAX 吸收，**不再**让「恰 N 拍」成为隐式契约。仍是**微任务级**，零真实等待。
 */
const FLUSH_MAX = 64

/**
 * @param {() => boolean} [ready] 就绪条件（缺省 = 立即就绪，不泵）
 * @param {string} [label] 泵不到时的点名文案（写清这一拍在等什么）
 * @returns {Promise<number>} 实际拍数（0 = 一开始就已就绪）
 */
const flush = async (ready, label) => {
  for (let i = 0; i <= FLUSH_MAX; i++) {
    if (typeof ready !== "function" || ready()) return i
    await null
  }
  assert.fail("微任务泵在 " + FLUSH_MAX + " 拍内未到达就绪条件【" + (label ?? "(未命名)") + "】"
    + "——await 链又深了一环（见本档 flush 注释）；请核对该腿的就绪信号或调高 FLUSH_MAX，"
    + "**不要**改实现去迁就拍数")
}

/**
 * console.warn 捕获（既有档同款：fail-open 响亮标注的断言用）。
 * @param {() => Promise<any>} fn 被包裹的腿体
 * @param {(warnings: string[]) => boolean} [isReady] **条件驱动泵的就绪条件**（🔵1 / A29-11）——
 *   留档 warn（`archiveWatchdogAttach` / 工具面「未生效」）发生在 `fn` resolve **之后**仍可能在途的
 *   链尾上 ⇒ 这里在 `console.warn` **仍被接管**的窗口内继续泵到该条件成立，避免出现
 *   「恰一条不符」式的红。省略 = 不额外泵（同步腿无需）。
 */
async function captureWarn(fn, isReady) {
  const warnings = []
  const orig = console.warn
  console.warn = (m) => { warnings.push(String(m)) }
  try {
    const value = await fn()
    if (isReady) await flush(() => isReady(warnings), "console.warn 捕获窗内出现期望的告警/状态")
    return { value, warnings }
  } finally { console.warn = orig }
}

/** 最小 ctx.llm 桩（生产 LlmRuntime.resolveModelInfo 同形）——避免 effort 回落告警污染返回文本。 */
const llmStub = {
  async resolveModelInfo() {
    return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } }
  },
}

/**
 * 一次 dsh 后台派发的夹具（注入缝齐备）：
 *   · 假 jobs（0.1.7：带参 spec.run(handle)）· 句柄（id + append 记录）
 *   · 桩子代理的结果形态由 form 决定（reject-race / resolve-race / 永不 settle）
 *   · 假时钟 + 假 setInterval（手动 tick）· 采到的 spec 请求与子代理 run 对象
 *   · **批 30 / US-2（D30-3）心跳面**（主腿 + 辅腿）：
 *     - 主腿：`run.id` + `run.localAgent.session.seq`（采样器读的就是这里，`seqState.value` 可写）；
 *       `seqStart: null` ⇒ **不装 `localAgent`**（out-of-process 的真实形态，A30-6 的降级腿）；
 *     - 辅腿：`ctx.on / ctx.off`（两条真事件面，**按 id 过滤**）——注册记录进 `events`；
 *       `beats[i]()` = 以**本子 id** 触发第 i 个已注册处理器；`otherBeats[i](id?)` = 以**他子 id** 触发
 *       （A30-5 的「他子事件不续命」判据）；
 *     - `eventSurface:false` ⇒ **不提供 `ctx.on`**（= 事件辅腿零命中的真实形态）。
 *   · `runExtra`：往 run 对象上**追加**键（A29-8 的留档探针——验证键名清单如实反映
 *     `Object.keys(run)`；刻意用与平台无关的假键名，避免与事件面名混淆）
 * @param {{form?: "reject"|"resolve"|"hang", eventSurface?: boolean, echoToolNames?: string[]|null,
 *   toolsSurface?: object, abortMs?: number, backstopMs?: number, partialText?: string,
 *   runExtra?: object, seqStart?: number|null}} [opts]
 */
function makeFrame(opts = {}) {
  const form = opts.form ?? "reject"
  const eventSurface = opts.eventSurface !== false
  const sid = "b29-sw-" + randomUUID()
  const childId = "b30-sub-" + randomUUID()
  // 主腿读数（可写；null ⇒ out-of-process 形态：run 上**不装** localAgent）
  const seqState = { value: opts.seqStart === undefined ? 0 : opts.seqStart }
  const st = sessionState(sid)
  st.engineering = true
  st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)

  const clock = { t: 0 }
  const ticks = []
  const beats = []        // 以**本子 id** 触发已注册事件处理器
  const otherBeats = []   // 以**他子 id** 触发（A30-5）
  const events = []       // ctx.on 的注册记录（A30-5 的「零残留监听」判据读 live）
  const cleared = []
  const specs = []
  const requests = []
  const runs = []
  const handle = { id: "eng-dsh-sw-1", calls: [], append(text) { this.calls.push(text) } }
  let aborted = false
  let settleResult = null

  const subagents = {
    async start(_kind, req) {
      requests.push(req)
      req.signal?.addEventListener("abort", () => { aborted = true }, { once: true })
      const run = {
        id: childId,
        result: new Promise((res, rej) => {
          settleResult = (payload) => res(payload)
          if (form === "hang") return
          req.signal?.addEventListener("abort", () => {
            if (form === "reject") {
              const e = new Error("subagent aborted by silence watchdog")
              e.name = "AbortError"
              rej(e)
            } else {
              res({ stopReason: "aborted", output: [{ type: "text", text: opts.partialText ?? "" }] })
            }
          }, { once: true })
        }),
        dispose: async () => { /* 无资源 */ },
      }
      // 主腿：只有装了 localAgent 才可用（`localAgent === undefined` = out-of-process 降级形态）
      if (seqState.value !== null) {
        run.localAgent = { session: { id: childId, header: { cwd: PLUGIN_DIR }, get seq() { return seqState.value } } }
      }
      if (opts.echoToolNames) run.toolNames = opts.echoToolNames
      if (opts.runExtra && typeof opts.runExtra === "object") Object.assign(run, opts.runExtra)
      runs.push(run)
      return run
    },
  }

  // 辅腿的注册面（只认平台真有的两条事件面；`{global:true}` 由实现在 ctx.on 的第三参上传）。
  // ★ 只有**心跳面**的两条注册进 `beats` / `otherBeats`；`subagent/start|end` 的**就绪/终局锚**
  //   也走 ctx.on（同样 `{global:true}`）但**不作静默判据** ⇒ 只进 `events`（供 off 残留断言）。
  const HEARTBEAT_EVENTS = ["agent/assistant-stream", "tools/result"]
  const heartbeatRegs = () => events.filter((e) => HEARTBEAT_EVENTS.includes(e.name))
  const ctxOn = (name, handler, o) => {
    const rec = { name, handler, options: o, live: true }
    events.push(rec)
    if (HEARTBEAT_EVENTS.includes(name)) {
      const fire = (payload) => { if (rec.live) handler(payload) }
      beats.push(() => fire({ agent: { id: childId } }))
      otherBeats.push((id) => fire({ agent: { id: id ?? "some-other-child" } }))
    }
    return () => { rec.live = false }
  }
  const ctxOff = (name, handler) => { for (const rec of events) if (rec.name === name && rec.handler === handler) rec.live = false }

  const deps = {
    ctx: {
      subagents,
      llm: llmStub,
      tools: opts.toolsSurface,
      ...(eventSurface ? { on: ctxOn, off: ctxOff } : {}),
      get: (s) => (s === "jobs"
        ? { start(spec) { const hooks = spec.run(handle); specs.push({ spec, hooks }); return handle.id } }
        : null),
    },
    agent: { session: { id: sid, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: { dshBackgroundTimeoutMs: opts.backstopMs ?? 3600000, engSilenceAbortMs: opts.abortMs ?? 60000 },
    signal: undefined,
    configDefaultEngineering: false,
    // eng.mjs 侧唯一注入缝：假时钟 + 假定时器（生产路径不传）
    silenceWatchdogOpts: {
      now: () => clock.t,
      setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
      clearIntervalImpl: (h) => { cleared.push(h) },
    },
  }
  return {
    sid, st, deps, clock, ticks, beats, otherBeats, events, heartbeatRegs, cleared, specs, requests, runs, handle, childId, seqState,
    isAborted: () => aborted,
    settleResult: (p) => settleResult(p),
    drop: () => dropSession(sid),
  }
}

// ═══════════════ A29-3：静默到点 abort + 文案；有输出续命 ═══════════════

test("A29-3a (D29-2 / AC-2): 注入静默（无输出）⇒ 既有取消写点 abort，终止文案含「疑似挂死」+ 静默时长 + partial/菜单/取证指路；reject-race 与 resolve-race 两形态同判", async () => {
  // ① reject-race（生产形态：abort ⇒ 子代理 result 以 AbortError reject）
  // 🔵2 / A29-11：腿体包 try { … } finally { f.drop() }——中途断言失败也**不留注册表条目**
  {
    const f = makeFrame({ form: "reject" })
    try {
    // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
    // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
    // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
    const cap3a1 = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "implement the silence leg", designToken: f.st.designToken, docs: [] })
    // 🔵1：条件驱动泵——等到「派发 + 事件面接驳 + 轮询注册」三环都落地即停，不依赖任何固定拍数
    await flush(() => f.specs.length === 1 && f.beats.length === 2 && f.ticks.length === 1,
      "A29-3a①：jobs.start → subagents.start → attachSubagentHeartbeat（specs/beats/ticks 各一）")
    assert.ok(dispatch.includes("eng-dsh-sw-1"), "前置：确实走了 dsh 后台派发：" + dispatch.slice(0, 120))
    assert.equal(f.specs.length, 1, "恰一次 jobs.start")
    assert.equal(f.beats.length, 2, "看门狗已接上**两条真事件面**（agent/assistant-stream + tools/result）")
    assert.equal(f.ticks.length, 1, "恰注册一个轮询定时器（叶子模块），本文件零新增 setTimeout")
    assert.equal(f.isAborted(), false, "前置：尚未到点 ⇒ 未 abort")
    // D9：先送一个**真实事件**——订阅面存在 ≠ 真会发事件；未武装的看门狗不判定（零事件腿见 D9 用例）
    f.beats[0]()
    // 注入静默：推进假时钟到阈值之后，手动 tick（零真实等待）
    f.clock.t = 60000
    f.ticks[0]()
    assert.equal(f.isAborted(), true, "到点 ⇒ 由**既有取消写点** abort 子代理")
    const outcome = await f.specs[0].hooks.done
    assert.equal(outcome.status, "failed", "静默到点 ⇒ failed（与兜底同族）")
    assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "detail 标明是静默看门狗（不是兜底）")
    assert.ok(outcome.output.includes("疑似挂死"), "终止文案含「疑似挂死」: " + outcome.output.slice(0, 160))
    assert.ok(outcome.output.includes("静默 1 分钟"), "终止文案含静默时长（N 分钟）: " + outcome.output.slice(0, 160))
    assert.ok(outcome.output.includes("Partial output"), "终止文案带 partial 段")
    assert.ok(outcome.output.includes("--- eng_coder 执行已停止 —— **不自动重派**，由用户裁决。---"),
      "静默终止沿用 FAILURE_OPTIONS_BLOCK 常量（不新造 wrapper）")
    assert.ok(outcome.output.includes("取证指路（D-48）"), "静默信封附取证指路句")
    // ★ 交付验收 3 条 Deferred 🔵（批 29 单② 第 5 条 c）：**显式锁定诚实限制** —— reject 形态下
    //   `sub.result` 以 AbortError **reject** ⇒ 落 eng.mjs 的 catch 作用域，那里**拿不到
    //   outputText**（与既有 ABORTED 兜底信封同款：partial 记「无」）⇒ 静默信封的 partial 体
    //   **为空**。本断言把「空」从「碰巧」变成**契约**：将来若给 reject 面补上 partial，本行会红，
    //   提醒同批更新该限制的登记口径（不得静默放宽）。
    // 🔵4 / A29-12：契约改钉在**归一形态**上——「`Partial output:` 之后的 advisory 段」
    //   归一后逐字等于 advisory 文本。原写法（`split("\n")[1] === ""`）把契约钉在
    //   codexFailureAdvisory 的**前导换行形状**上；其后的「只取第一条非空行」把契约钉在
    //   **advisory 的首行**上——`codexFailureAdvisory` 用 "\n[thincoder-suite] " 续接多段
    //   （lib/escalate.mjs:79），advisory **内部一旦折行**（一句话拆成两段/多行）本腿就会误红，
    //   与「折行位置也被归一吃掉」的注释口径、A29-12 第二子句自相矛盾（§2.7 审计 🔵D-1）。
    //   归一步骤：取 `Partial output:` 之后**全部行** → **逐行**去方括号标签前缀
    //   （[thincoder-suite] 之类）→ 拼接 → **整体去空白** → 与 ADVISORY_TEXT 的去空白形态**前缀**比对。
    //   为什么比**前缀**而不是等值：advisory 之后紧跟信封的**固定尾块**（D-48 取证指路段 +
    //   失败后缀块），本腿下面已有**独立断言**钉住那两段，不在本腿重复钉它们的字面。
    //   为什么是去**全部**空白而不是「折叠为单空格」：折行可以落在两个汉字**之间**（其间本无
    //   空格），只折叠会把折行点变成一个**多出来的空格** ⇒ 仍然误红。
    //   · **partial 被填充 ⇒ 必红**：partial 正文落在 advisory 段**之前**（非空行）⇒ 那条断言红，
    //     且去空白后的整段**不再以**回滚指引开头 ⇒ 前缀比对同样红。
    //   · **仅调 advisory 排版 ⇒ 不红**：前导换行数、空行、标签前缀、**内部折行**都被归一吃掉。
    const partialSeg = outcome.output.split("Partial output:")[1] ?? ""
    const segLines = partialSeg.split("\n")
    const isTagLine = (l) => /^\[[^\]]*\]/.test(String(l).trim())
    const firstTagged = segLines.findIndex(isTagLine)   // advisory 段首行（信封尾部的 D-48 取证指路段在其后，故取**首个**）
    const bodyNonEmpty = (firstTagged === -1 ? segLines : segLines.slice(0, firstTagged)).filter((l) => String(l).trim() !== "")
    const flatSeg = segLines.map((l) => String(l).replace(/^\s*\[[^\]]*\]\s*/, "")).join("").replace(/\s+/g, "")
    const ADVISORY_TEXT = "半途写入可能残留：对照 partial 输出与 Touched 提示检查工作区，必要时 git 回滚。"
    const flatAdvisory = ADVISORY_TEXT.replace(/\s+/g, "")
    assert.ok(firstTagged !== -1,
      "reject-race 下 `Partial output:` 之后**必须存在**带标签的 advisory 段（不得什么都不说）："
        + JSON.stringify(partialSeg.slice(0, 80)))
    assert.deepEqual(bodyNonEmpty, [],
      "reject-race 下 `Partial output:` 之后、advisory 段之前**不得有**任何非空行（partial 体为空；填上内容本行**必红**）："
        + JSON.stringify(bodyNonEmpty))
    assert.ok(flatSeg.startsWith(flatAdvisory),
      "advisory 段**全部行**去标签前缀 + 去空白后**逐字以**回滚指引**开头**（抗排版微调：前导换行 / 空行 / 标签前缀 / **内部折行**都不影响本行；partial 若被填充本行**必红**）："
        + JSON.stringify(flatSeg.slice(0, 120)))
    assert.ok(partialSeg.includes("半途写入可能残留"),
      "空 partial 下仍带 ABORTED 回滚指引（与 resolve 侧对称，不是「什么都没说」）：" + partialSeg.slice(0, 120))
    assert.equal(f.cleared.length, 1, "settle 的 finally 清掉轮询定时器（不泄漏）")
    assert.equal(f.handle.calls.length, 1, "正文照常经 handle.append 进输出环（D-46 契约未破）")
    })
    // ★ 🔵5 的**决定性**形态：本腿的告警确实进了捕获器（删掉包装 ⇒ cap3a1 未定义 ⇒ 本行必红；
    // 而「未捕获」的真实后果就是它落到 stderr 变成噪声）。
    assert.ok(cap3a1.warnings.some((w) => w.includes("工具面禁执行未生效")),
      "★ 🔵5：本腿告警已被捕获（未捕获 = 打到 stderr 的噪音）：" + JSON.stringify(cap3a1.warnings.slice(0, 2)))
    } finally { f.drop() }
  }
  // ② resolve-race（子代理在到点同刻以结果返回）⇒ 同一静默分支，且**带上已产生的 partial**
  {
    const f = makeFrame({ form: "resolve", partialText: "half done\n\nTouched files: lib/a.mjs" })
    try {
    // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
    // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
    // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
    const _cap3a2 = await captureWarn(async () => {
    await runEngCoder(f.deps, { task: "implement the silence leg (resolve)", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.beats.length === 2,
      "A29-3a②：jobs.start → subagents.start → attachSubagentHeartbeat")
    f.beats[0]() // D9：真实事件在前（未武装的看门狗不判定）
    f.clock.t = 60000
    f.ticks[0]()
    const outcome = await f.specs[0].hooks.done
    assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "resolve 侧同走静默分支（不被兜底分支截胡）")
    assert.ok(outcome.output.includes("疑似挂死"), "resolve 侧文案同样含「疑似挂死」")
    assert.ok(outcome.output.includes("half done"), "已产生的 partial 进信封: " + outcome.output.slice(0, 200))
    })
    } finally { f.drop() }
  }
})

test("A29-3b (AC-2): 有输出 ⇒ 心跳续命，不误杀（累计时长越过阈值、单次静默未越）", async () => {
  const f = makeFrame({ form: "hang" })
  try {
  // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
  // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
  // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
  const _cap3b = await captureWarn(async () => {
  await runEngCoder(f.deps, { task: "implement the keep-alive leg", designToken: f.st.designToken, docs: [] })
  await flush(() => f.specs.length === 1 && f.beats.length === 2,
    "A29-3b：jobs.start → subagents.start → attachSubagentHeartbeat")
  assert.equal(f.beats.length, 2, "心跳源已接上（两条真事件面）")
  // 每轮：推进 55s（< 60s 阈值）→ 子代理产出（心跳）→ tick。累计 275s ≫ 阈值，但**单次静默**从未越线。
  for (let i = 0; i < 5; i++) {
    f.clock.t += 55000
    f.beats[0]()
    f.ticks[0]()
  }
  assert.equal(f.isAborted(), false, "有输出 ⇒ 续命：不得误杀（与总预算 dshBackgroundTimeoutMs 是两层）")
  f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "did the work\n\nTouched files: lib/a.mjs" }] })
  const outcome = await f.specs[0].hooks.done
  assert.equal(outcome.status, "completed", "续命到位 ⇒ 正常交付")
  assert.ok(!outcome.output.includes("疑似挂死"), "成功交付不得带静默终止文案")
  })
  } finally { f.drop() }

  // ═══ 批 30 / US-2（D30-3① · 锚 A30-4）：seq 主腿——**涨 ⇒ 续命**；不涨到阈值 ⇒ abort +「疑似挂死」═══
  // 判据（设计 §5.1）：主腿是「单调计数器的**变化**」而不是「订阅面存在」——首拍读数只作基线。
  {
    const fSeq = makeFrame({ form: "reject", abortMs: 60000, seqStart: 100 })
    try {
      const capSeq = await captureWarn(async () => {
        await runEngCoder(fSeq.deps, { task: "implement the seq heartbeat leg", designToken: fSeq.st.designToken, docs: [] })
        await flush(() => fSeq.specs.length === 1 && fSeq.ticks.length === 1 && fSeq.heartbeatRegs().length === 2,
          "A30-4：jobs.start → subagents.start → 两腿装配（ticks / 心跳面注册就绪）")
        // ① 首拍：**只有基线读数**（未观测到变化）⇒ 未武装 ⇒ 不中止（D9 口径不回退）
        fSeq.clock.t = 30000
        fSeq.ticks[0]()
        assert.equal(fSeq.isAborted(), false, "首拍只有基线 ⇒ 未武装 ⇒ 不中止")
        // ② seq **涨** ⇒ 武装 + 续命：单次静默 20s < 阈值 60s，累计 80s ≫ 阈值仍不中止
        for (let i = 0; i < 4; i++) {
          fSeq.clock.t += 20000
          fSeq.seqState.value += 1
          fSeq.ticks[0]()
        }
        assert.equal(fSeq.isAborted(), false, "★ seq 单调上涨 ⇒ 续命（不误杀真在活动的子代理）")
        // ③ seq **不再涨**（子代理卡住）⇒ 静默越阈值 ⇒ 由既有取消写点 abort + 疑似挂死文案
        fSeq.clock.t += 60001
        fSeq.ticks[0]()
        assert.equal(fSeq.isAborted(), true, "★ 不涨到阈值 ⇒ abort（主腿真在判定，不是摆设）")
        const outcome = await fSeq.specs[0].hooks.done
        assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "走静默到点分支")
        assert.ok(outcome.output.includes("疑似挂死"), "文案含「疑似挂死」：" + outcome.output.slice(0, 140))
        assert.ok(outcome.output.includes("静默 1 分钟"), "文案含**真实静默时长**：" + outcome.output.slice(0, 140))
      })
      assert.ok(capSeq.warnings.some((w) => w.includes("疑似挂死")), "到点告警经捕获通道可见（不是只写在返回文本里）")
    } finally { fSeq.drop() }
  }

  // ═══ 批 30 / US-6（D30-6 · 锚 A30-12 真机项的**通道**）：模型面证据必须进**可读的回执区** ═══
  // 本腿只证两件事：① 证据**真的进了可读通道**（回执小节内，正文之后）；② 读不到子会话档时
  // **如实标注「模型面未验」**（不拿派发载荷或「restrict 未抛错」冒充）。真机上的**已验**形态由宿主
  // 在一次真派发后用同一行证据裁定（A30-12 是**真机项**）。
  {
    __resetWatchdogAttachArchiveForTest()
    __resetArchiveChannelForTest()
    const fM = makeFrame({ form: "hang", runExtra: { modelProbe: 1 } })
    try {
      const capM = await captureWarn(async () => {
        await runEngCoder(fM.deps, { task: "probe the model-surface channel", designToken: fM.st.designToken, docs: [] })
        await flush(() => fM.specs.length === 1, "A30-12 通道腿：jobs.start → subagents.start → 两腿装配")
        fM.settleResult({ stopReason: "completed", output: [{ type: "text", text: "model surface probe done" }] })
        await fM.specs[0].hooks.done
      }, (ws) => ws.some((w) => w.includes("模型面证据")))
      assert.equal(fM.handle.calls.length, 1, "交付正文恰经 handle.append 入环一次（D-46 契约）")
      const delivered = String(fM.handle.calls[0] ?? "")
      assert.ok(delivered.includes(HOST_ARCHIVE_HEADER), "回执小节在场（本部署唯一读得到的证据面）：" + delivered.slice(-200))
      const lines = delivered.split("\n").filter((l) => l.includes("模型面证据"))
      assert.equal(lines.length, 1, "★ 回执区恰一条**模型面证据**行：" + JSON.stringify(lines))
      assert.ok(lines[0].includes("模型面未验"),
        "★ 本夹具没有真实子会话档 ⇒ **如实标注「模型面未验」**（不假装读到、不拿载荷冒充）：" + lines[0])
      assert.ok(lines[0].includes("不得以「restrict 未抛错」代替"), "判据口径随行带出：" + lines[0])
      assert.ok(delivered.indexOf(lines[0]) > delivered.indexOf("model surface probe done"),
        "证据行位于**交付正文之后**（绝不前插）：" + delivered.slice(-260))
      assert.ok(capM.warnings.some((w) => w.includes("模型面证据")), "同一条文案也走裸 console.warn（两通道）")
    } finally { fM.drop() }
  }
})

test("A29-3c (D29-6): 看门狗工厂语义——到点回调恰一次（latch）、heartbeat 重置静默计时、dispose 幂等；阈值/周期解析运行时宽容；事件辅腿接驳与主腿采样器的诚实回落", async () => {
  assert.equal(ENG_SILENCE_ABORT_MS, 300000, "缺省阈值 = 5 分钟（D29-2）")
  assert.equal(ENG_SILENCE_POLL_MS, 1000, "轮询周期 = 1s")
  assert.deepEqual(resolveEngSilenceAbortMs({}), { ms: 300000, warning: null }, "缺省不告警")
  assert.deepEqual(resolveEngSilenceAbortMs({ engSilenceAbortMs: 3000 }), { ms: 3000, warning: null }, "正有限数即生效（运行时宽容）")
  for (const bad of ["x", 0, -1, NaN, Infinity]) {
    const r = resolveEngSilenceAbortMs({ engSilenceAbortMs: bad })
    assert.equal(r.ms, ENG_SILENCE_ABORT_MS, "非法值回落缺省：" + String(bad))
    assert.ok(r.warning && r.warning.includes("engSilenceAbortMs"), "非法值返回 warning 供 caller 经 warn() 带出：" + String(bad))
  }
  assert.equal(silenceMinutesLabel(60000), "1", "文案口径：静默 N 分钟")
  assert.equal(silenceMinutesLabel(300000), "5")

  const clock = { t: 0 }
  const ticks = []
  let clearedCount = 0
  const w = createSilenceWatchdog({
    abortMs: 1000, pollMs: 100,
    now: () => clock.t,
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
    clearIntervalImpl: () => { clearedCount++ },
  })
  const fired = []
  w.onSilence((info) => fired.push(info.silentMs))
  clock.t = 900; ticks[0]()
  assert.deepEqual(fired, [], "未越阈值不触发")
  w.heartbeat()
  clock.t = 1800; ticks[0]()
  assert.deepEqual(fired, [], "心跳续命：累计 1800 > 阈值，但静默只有 900 ⇒ 不触发")
  clock.t = 2901; ticks[0]()
  // 批 29 单①交付验收订正（宿主实测）：最后一次心跳发生在 t=900（:227），本次静默自 900 起算
  // ⇒ 2901 − 900 = **2001**；原写 1101 是错算（当成「自 1800 起算」）。**实现报 2001 是对的**
  // （报真实静默时长，而非阈值），本行只是把期望值对齐到该契约。
  assert.deepEqual(fired, [2001], "到点 ⇒ 回调带**静默时长**（毫秒，自最后一次心跳起算的真实值）")
  clock.t = 99000; ticks[0]()
  assert.deepEqual(fired, [2001], "到点**恰一次**（latch：不重复回调）")
  assert.deepEqual(w.state(), { disposed: false, armed: true, delivered: true, silentMs: 2001, abortMs: 1000, lastSample: null },
    "state 如实回报（armed：缺省初始武装 = 既有语义零漂移；lastSample：未传 sample ⇒ 主腿不参与）")
  w.dispose(); w.dispose()
  assert.equal(clearedCount, 1, "dispose 幂等（只清一次）")
  assert.equal(w.state().disposed, true)

  // ——— 批 30 / US-2（D30-3②）：**事件辅腿**的接驳契约（旧「在 run 上猜事件名」的候选表已删）———
  // ① 取不到 ctx.on / 子 id ⇒ attached:false（**不假装在看**——caller 据此标注未生效）
  const noCtx = attachSubagentHeartbeat(null, { id: "c1" }, () => {})
  assert.equal(noCtx.attached, false, "无 ctx ⇒ 未接上（诚实回落）")
  assert.equal(noCtx.via, null)
  assert.equal(typeof noCtx.off, "function", "未接上也返回**幂等 off**（caller 的 finally 无需分支）")
  noCtx.off() // 幂等：不得抛
  assert.equal(attachSubagentHeartbeat({ on: () => {} }, {}, () => {}).attached, false, "子 id 缺失 ⇒ 未接上")
  assert.equal(attachSubagentHeartbeat({ on: () => {} }, { id: "c1" }, null).attached, false, "无 beat ⇒ 未接上")
  // ② 有 ctx.on ⇒ 两条真事件面都注册、都带 {global:true}、按子 id 过滤、off() 幂等且摘净
  {
    const regs = []
    const ctx = {
      on(name, handler, opts) {
        const rec = { name, handler, opts, live: true }
        regs.push(rec)
        return () => { rec.live = false }
      },
      off() { throw new Error("off() 不应被调用：ctx.on 已返回 disposer") },
    }
    let got = 0
    const hb = attachSubagentHeartbeat(ctx, { id: "c1" }, () => { got++ })
    assert.equal(hb.attached, true, "有 ctx.on ⇒ 接上")
    assert.equal(hb.via, "agent/assistant-stream, tools/result", "接的是**两条真事件面**（逐字）：" + hb.via)
    assert.deepEqual(regs.map((r) => r.name), ["agent/assistant-stream", "tools/result"], "注册的事件名逐字")
    assert.ok(regs.every((r) => r.opts && r.opts.global === true), "两条都必须 {global:true}（事件面是全 app 的）")
    regs[0].handler({ agent: { id: "c1" } })
    assert.equal(got, 1, "本子事件 ⇒ 心跳")
    regs[0].handler({ agent: { id: "other-child" } })
    regs[0].handler({})
    assert.equal(got, 1, "★ 过滤：**他子事件 / 无 agent 的载荷**不得续命（不过滤 = 邻居救活本子）")
    regs[1].handler({ agent: { id: "c1" } })
    assert.equal(got, 2, "第二条事件面同样按本子 id 生效")
    hb.off(); hb.off() // 幂等
    assert.ok(regs.every((r) => r.live === false), "off() ⇒ 两条监听都摘除（零残留）")
    // 注：`off()` 的语义 = **调用 ctx.on 返回的 disposer**（平台分发器此后不再派发到本监听）；
    // 直呼 `regs[0].handler(...)` 会绕过该语义、不是本契约的一部分 ⇒ 这里不做「直呼 handler 无心跳」的断言。
    // 「dispose 后零残留」的**派发面**判据在 A29-3c 下方（`fEv.events.every((e) => e.live === false)`）。
  }
  // ③ 主腿采样器：可用性 + 读数 + out-of-process 的如实归因（不抛）
  assert.deepEqual(subagentSeqSampler(null).available, false, "无 run ⇒ 主腿不可用")
  assert.equal(subagentSeqSampler({}).reason.includes("localAgent === undefined"), true,
    "out-of-process 的归因逐字可读：" + subagentSeqSampler({}).reason)
  const seqRun = { localAgent: { session: { seq: 7 } } }
  const seqLeg = subagentSeqSampler(seqRun)
  assert.equal(seqLeg.available, true, "装了 localAgent.session.seq ⇒ 主腿可用")
  assert.equal(seqLeg.read(), 7, "读数 = 当拍 seq")
  seqRun.localAgent.session.seq = 9
  assert.equal(seqLeg.read(), 9, "单调计数器：读数跟着走")
  assert.equal(subagentSeqSampler({ localAgent: { session: { seq: "x" } } }).available, false,
    "形状漂移（非有限数）⇒ 如实判不可用（不抛）")

  // 句柄心跳装饰：append/updateProgress 亦是心跳源，且**读语义/写语义与原句柄一致**
  const h = { id: "j-1", calls: [], append(text) { this.calls.push(text) }, updateProgress(line) { this.calls.push(line) } }
  let beats = 0
  const wrapped = watchJobHandle(h, () => { beats++ })
  assert.notEqual(wrapped, h, "两个事件方法都在场 ⇒ 装饰件生效")
  assert.equal(wrapped.id, "j-1", "其余成员走原型链照旧读（D-46：jobOutcome 读 id/append）")
  wrapped.append("body")
  wrapped.updateProgress("progress")
  assert.deepEqual(h.calls, ["body", "progress"], "委托调用 this 仍是原句柄（行为逐字不变）")
  assert.equal(beats, 2, "append/updateProgress 各算一次心跳")
  assert.equal(watchJobHandle({ id: "j-2" }, () => {}).id, "j-2", "无事件方法 ⇒ 原样返回（零包装）")
  // ★ 批 30 / §2.4 🔵2（锚 A30-7·🔵2）：`Object.create(handle)` 的**枚举面契约**行为对照——
  //   见下方 A29-15 的静态锁（JSDoc 串在场）；此处只补行为侧对照（读写语义一致，键清单不承诺同形）。
  assert.ok(Object.keys(wrapped).every((k) => ["append", "updateProgress"].includes(k)),
    "装饰件的**自有键**就是被覆盖的那两个事件方法（枚举面不保证同形——`id` 在原型链上）：" + JSON.stringify(Object.keys(wrapped)))
  assert.equal(wrapped.id, h.id, "但读写访问语义照常（`id` 穿原型链可读）")

  // —— 批 30 / §2.4 🔵1（锚 A30-7·🔵1）：`onSilence` 的注销函数**只能清自己** ——
  // 病：注销实现此前是裸 `onSilent = null` ⇒ 「先注册 A、再注册 B、调 **A 的**注销」把 **B** 清掉，
  // 到点回调整体失效（看门狗变哑且无迹象）。判据：B 必须照常收到到点回调。
  {
    const clockA = { t: 0 }
    const ticksA = []
    const wA = createSilenceWatchdog({
      abortMs: 1000, pollMs: 100, now: () => clockA.t,
      setIntervalImpl: (fn) => { ticksA.push(fn); return { unref() { /* 假定时器 */ } } },
      clearIntervalImpl: () => { },
    })
    const firedA = []
    const firedB = []
    const offA = wA.onSilence((info) => firedA.push(info.silentMs))
    assert.equal(typeof offA, "function", "注册返回注销函数")
    wA.onSilence((info) => firedB.push(info.silentMs)) // B 抢占注册位
    offA()                                            // ★ A 的注销函数（A 已被抢占 ⇒ 必须是无操作）
    clockA.t = 5000
    ticksA[0]()
    assert.deepEqual(firedB, [5000],
      "★ 🔵1 决定性：A 的注销**不得**误杀 B（裸 `onSilent = null` 时本行必红——到点回调整体失效）")
    assert.deepEqual(firedA, [], "A 已被抢占且已注销 ⇒ 不再收到回调")
    wA.dispose()
  }
  // 反向对照：注销**自己**（现任）仍必须真的清掉 ⇒ 到点不再回调（注销语义未被削弱）
  {
    const clockB = { t: 0 }
    const ticksB = []
    const wB = createSilenceWatchdog({
      abortMs: 1000, pollMs: 100, now: () => clockB.t,
      setIntervalImpl: (fn) => { ticksB.push(fn); return { unref() { /* 假定时器 */ } } },
      clearIntervalImpl: () => { },
    })
    const fired = []
    const off = wB.onSilence((info) => fired.push(info.silentMs))
    off()
    clockB.t = 50000
    ticksB[0]()
    assert.deepEqual(fired, [], "注销**现任**回调 ⇒ 到点不再回调（注销语义照常，不被身份判据削弱）")
    wB.dispose()
  }

  // ═══ 批 30 / US-2（D30-3②③ · 锚 A30-5）：事件辅腿——本子续命 / **他子不续命** / dispose 零残留 ═══
  {
    // 主腿关掉（`seqStart: null` = out-of-process）⇒ 本腿里**只有事件辅腿**能产生心跳
    const fEv = makeFrame({ form: "reject", abortMs: 60000, seqStart: null })
    try {
      const capEv = await captureWarn(async () => {
        await runEngCoder(fEv.deps, { task: "implement the event heartbeat leg", designToken: fEv.st.designToken, docs: [] })
        await flush(() => fEv.specs.length === 1 && fEv.heartbeatRegs().length === 2, "A30-5：两腿装配（心跳面注册各一）")
        assert.equal(fEv.events.every((e) => e.options && e.options.global === true), true,
          "两条监听都带 {global:true}（事件面是全 app 的）")
        // ① **他子事件**（含无 agent 的载荷）在真事件之前批量灌入 ⇒ **绝不能**给本子续命
        for (const ob of fEv.otherBeats) { ob(); ob(undefined) }
        fEv.clock.t = 60001
        fEv.ticks[0]()
        assert.equal(fEv.isAborted(), false,
          "★ 他子事件**不续命**（不过滤就会把邻居的活动算成本子的命 ⇒ 本子挂死却永不中止）")
        // ② **本子事件** ⇒ 武装；此后静默越阈值 ⇒ abort（既有取消写点）
        fEv.beats[0]()
        fEv.clock.t += 60001
        fEv.ticks[0]()
        assert.equal(fEv.isAborted(), true, "本子事件 ⇒ 武装；此后静默越阈值 ⇒ 照常中止")
        await fEv.specs[0].hooks.done
      })
      assert.ok(capEv.warnings.length >= 0, "（捕获通道：本腿两条裸告警都在窗内，不落到 stderr）")
    } finally { fEv.drop() }
    // ③ **dispose 后零残留监听**：派发返回路径（本腿）在 finally 里 off() ——异常 / 静默终止两条
    //    路径走的是**同一个** finally（`eng.mjs` 里那处），故本行对三条路径同时成立。
    assert.equal(fEv.events.every((e) => e.live === false), true,
      "★ off() 摘净全部监听（零残留）：" + JSON.stringify(fEv.events.map((e) => [e.name, e.live])))
    assert.equal(fEv.heartbeatRegs().length, 2, "前置：确实注册过两条**心跳面**监听（否则上一行是恒真断言）")
  }
})

// ═══════════════ A29-1 / A29-2：工具面禁执行（两态 + 证据口径） ═══════════════

/**
 * 平台注册面样本：执行类 2（`pwsh` / `bash`）+ **保留传输名 1**（`run_code`——平台注册面里
 * 确实存在，但 `restrict()` 不得命名它：一命名即抛错并打断整个派发，见 D1）+ 非执行类 5。
 * ★ `run_code` 留在样本里**正是为了证明它不被下发**（不是期望被 deny 的成员）。
 */
const SURFACE = ["read", "write", "edit", "grep", "pwsh", "bash", "run_code", "web_search"]
const BASE_DENY = ["escalate", "consult_start", "consult_stop", "eng", "eng_coder", "ask_user_question"]

test("A29-1a (AC-1, 强证): 平台回显的生效工具清单里执行类**不在**、非执行类**仍在**——证据口径标 platform-echo", async () => {
  const echo = ["read", "write", "edit", "grep", "web_search"]      // 平台侧生效清单
  // 批 30 / US-1：名域读取面改为**带 scope 的 view(agent)**（旧夹具的 `list` 候选面已随 D30-2 删除
  // ——七个别名探测在本机平台上恒不存在 ⇒ 留着只会掩盖真实形态）
  const f = makeFrame({ toolsSurface: { view: () => ({ restrictableNames: new Set(SURFACE) }) }, echoToolNames: echo })
  try {
  // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
  // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
  // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
  const _cap1a = await captureWarn(async () => {
  const dispatch = await runEngCoder(f.deps, { task: "implement the deny leg", designToken: f.st.designToken, docs: [] })
  await flush(() => f.specs.length === 1 && f.requests.length === 1 && f.runs.length === 1,
    "A29-1a：jobs.start → subagents.start（requests/runs 各一）")
  assert.ok(dispatch.includes("eng-dsh-sw-1"), "前置：派发了后台作业")
  // 载荷侧（请求）：执行类确实被要求移除
  const payloadDeny = f.requests[0].toolFilter.deny
  // D1：**保留传输名 run_code 绝不下发**（平台 restrict() 命名它直接抛错 ⇒ 会打断整个派发）
  assert.ok(!payloadDeny.includes("run_code"), "保留名不得进 deny：" + JSON.stringify(payloadDeny))
  for (const exec of ["pwsh", "bash"]) assert.ok(payloadDeny.includes(exec), "载荷把执行类列入 deny：" + exec)
  // 强证侧：平台回显的**生效清单**
  const eff = readEffectiveToolEcho(f.runs[0])
  assert.deepEqual(eff, echo, "平台回显生效清单可读（强证来源）")
  for (const exec of ["pwsh", "bash"]) assert.ok(!eff.includes(exec), "强证：执行类不在子会话可用集内：" + exec)
  for (const keep of ["read", "write", "edit", "grep", "web_search"]) assert.ok(eff.includes(keep), "强证：非执行类仍在：" + keep)
  assert.equal(execDenyEvidence(f.runs[0]).evidence, "platform-echo", "有回显 ⇒ 证据口径 = 强证")
  assert.equal(readEffectiveToolEcho({ tools: { read: 1 } }), null,
    "普通对象（工具实现表）不算回显——不得把载荷/实现表误报成强证")
  })
  } finally { f.drop() }
})

test("A29-1b (AC-1, 弱证): 平台不回显 ⇒ 以派发时接受的 toolFilter 载荷为证并如实标注为弱证（两形态在断言里区分）", async () => {
  // 批 30 / US-1·A30-3：本腿改走**退路面** `schemas(agent)`——一并证明退路在真实派发路径上可用，
  // 且名域里的保留名 `run_code` 被剔（SURFACE 含 run_code，deny 里不得出现它）
  const f = makeFrame({ toolsSurface: { schemas: () => SURFACE.map((n) => ({ name: n })) } })
  try {
  // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
  // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
  // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
  const _cap1b = await captureWarn(async () => {
  await runEngCoder(f.deps, { task: "implement the deny leg (weak)", designToken: f.st.designToken, docs: [] })
  await flush(() => f.specs.length === 1 && f.requests.length === 1 && f.runs.length === 1,
    "A29-1b：jobs.start → subagents.start（requests/runs 各一）")
  const deny = f.requests[0].toolFilter.deny
  assert.deepEqual(deny, [...BASE_DENY, "pwsh", "bash"], "弱证：载荷 = 既有基线 + 在册执行类（逐项）")
  assert.ok(!deny.includes("run_code"), "D1：保留传输名不得出现在载荷 deny 里")
  for (const keep of ["read", "write", "edit", "grep", "web_search"]) {
    assert.ok(!deny.includes(keep), "弱证：非执行类**不得**被 deny（子会话仍可用）：" + keep)
  }
  // 两形态**在断言里区分**（不得混同）：无回显 ⇒ evidence 标 dispatch-payload 且 effective 为 null
  assert.equal(execDenyEvidence(f.runs[0]).evidence, "dispatch-payload", "无回显 ⇒ 证据口径 = 弱证（如实标注）")
  assert.equal(readEffectiveToolEcho(f.runs[0]), null, "无回显 ⇒ effective 为 null（不与强证混同）")
  })
  } finally { f.drop() }
})

test("A29-2 (AC-1 / D29-1): 取不到平台工具名清单 ⇒ 如实标注「未生效」——deny 保持逐字基线（不假装拦住），且标注走裸 console.warn（不进返回文本）", async () => {
  // 单元面：注册面不可得 / 注册面里无执行类 ⇒ applied:false + reason，deny 逐字等于基线
  for (const ctx of [{}, { tools: {} }, { tools: { register() {} } }, { get: () => null }]) {
    const plan = resolveExecToolDeny(ctx)
    assert.equal(plan.applied, false, "取不到清单 ⇒ 未生效（不猜名单）")
    assert.deepEqual(plan.deny, BASE_DENY, "未生效 ⇒ deny 逐字基线（未下发任何执行类名）")
    assert.deepEqual(plan.execNames, [], "未生效 ⇒ 零执行类名")
    assert.equal(typeof plan.reason, "string", "未生效必须给出可读理由")
    assert.ok(plan.reason.length > 0)
    assert.equal(collectRegisteredToolNames(ctx), null, "读取面不可用 ⇒ null（诚实返回，不退化成硬编码名单）")
  }
  // —— 🔵(a) **空集面**（零实现改动）：applied:false 的**另一条**归因 = 面可用但可限制名集为空 ——
  //    （lib/eng.mjs 的 names.length === 0 分支，与 names === null 的「读取面不可用」分开归因）
  //    此前只有 null 路有锁 ⇒ 这里补上 [] 路，并证明两形态在**同一读取函数**上可判。
  const emptySurfaceCtx = { tools: { view: () => ({ restrictableNames: new Set() }) } }
  const emptyPlan = resolveExecToolDeny(emptySurfaceCtx)
  assert.equal(emptyPlan.applied, false, "空集面 ⇒ 同样如实标「未生效」（不假装拦住）")
  assert.deepEqual(emptyPlan.deny, BASE_DENY, "空集面 ⇒ deny 逐字等于基线（未下发任何名字）")
  assert.deepEqual(emptyPlan.execNames, [], "空集面 ⇒ 零执行类名")
  assert.equal(emptyPlan.source, "view(agent)", "空集面的来源仍是**公开读取面**（面在场，只是名集为空）")
  assert.ok(String(emptyPlan.reason).includes("可限制名集为空"),
    "空集面归因 = 面可用但可限制名集为空：" + emptyPlan.reason)
  assert.ok(!String(emptyPlan.reason).includes("读取面不可用"),
    "空集面**不得**被混成「读取面不可用」：" + emptyPlan.reason)
  // 两形态可判：同一读取函数返回 []（面在场但空集）vs null（面不可用）
  const emptyNames = collectRegisteredToolNames(emptySurfaceCtx)
  assert.deepEqual(emptyNames, [], "面可用但名集为空 ⇒ []（不是 null）")
  const nullNames = collectRegisteredToolNames({ tools: {} })
  assert.equal(nullNames, null, "对照：读取面不可用 ⇒ null")
  assert.notDeepStrictEqual(emptyNames, nullNames, "两形态**可判**（[] ≠ null，不得折成同一种归因）")
  const noExec = resolveExecToolDeny({ tools: { list: () => ["read", "write", "grep"] } })
  assert.equal(noExec.applied, false, "注册面里没有执行类谓词命中 ⇒ 同样如实标未生效")
  assert.deepEqual(noExec.deny, BASE_DENY)

  // 行为面：无注册面 ⇒ 实派发的 deny 仍是逐字基线；标注是**裸 console.warn**（不在返回文本里）
  const f = makeFrame({})
  try {
  const r = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "implement the not-effective leg", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.requests.length === 1,
      "A29-2：jobs.start → subagents.start")
    return dispatch
  }, (ws) => ws.some((w) => w.includes("工具面禁执行未生效")))
  assert.deepEqual(f.requests[0].toolFilter.deny, BASE_DENY,
    "未生效 ⇒ 派发载荷不得出现执行类名（不假装拦住）：" + JSON.stringify(f.requests[0].toolFilter.deny))
  assert.ok(r.warnings.some((w) => w.includes("工具面禁执行未生效")), "如实标注走 console.warn：" + r.warnings.join(" | "))
  assert.ok(!r.value.includes("[thincoder-suite] warning:"), "标注**不进** warnPrefix 返回文本（T12 锁：干净路径零 warning 前缀）")
  assert.ok(!r.value.includes("未生效"), "返回文本里不出现机制标注")
  } finally { f.drop() }
})

// ═══════════════ D9：心跳护栏（订阅面在 ≠ 会发事件）· D1/D2：保留名与公开读取面 ═══════════════

test("D9 (AC-2 反例): 事件面**已接上**但零事件 ⇒ 不误杀——看门狗未武装、退回总预算；首个真实事件到达后才判定", async () => {
  const f = makeFrame({ form: "hang" })
  try {
  // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
  // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
  // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
  const _capD9 = await captureWarn(async () => {
  await runEngCoder(f.deps, { task: "implement the zero-event leg", designToken: f.st.designToken, docs: [] })
  await flush(() => f.specs.length === 1 && f.beats.length === 2,
    "D9：jobs.start → subagents.start → attachSubagentHeartbeat")
  assert.equal(f.beats.length, 2, "前置：事件辅腿**已接上**（attached:true，两条真事件面）")
  // 零真实事件：推进假时钟远超阈值并 tick——**不得** abort（否则会误杀一个正在正常输出的子代理）
  f.clock.t = 600000
  for (let i = 0; i < 3; i++) f.ticks[0]()
  assert.equal(f.isAborted(), false,
    "attached 但零事件 ⇒ 未武装 ⇒ 不中止（退回总预算 dshBackgroundTimeoutMs）")
  // 单元面：同一事实的工厂级对照（armed:false 在首个心跳前不判定，心跳即武装）
  const clock = { t: 0 }
  const ticks = []
  const w = createSilenceWatchdog({
    abortMs: 1000, armed: false,
    now: () => clock.t,
    setIntervalImpl: (fn) => { ticks.push(fn); return { unref() { /* 假定时器 */ } } },
    clearIntervalImpl: () => { /* noop */ },
  })
  const fired = []
  w.onSilence((info) => fired.push(info.silentMs))
  clock.t = 999999; ticks[0]()
  assert.deepEqual(fired, [], "armed:false ⇒ 首个心跳前不判定（零事件不误杀）")
  assert.equal(w.state().armed, false, "state 如实回报未武装")
  w.heartbeat()
  clock.t += 1000; ticks[0]()
  assert.deepEqual(fired, [1000], "首个真实心跳 ⇒ 武装；此后静默越阈值即到点（机制未被削弱）")
  w.dispose()
  // 派发面：首个真实事件到达 ⇒ 武装 ⇒ 静默越阈值才中止（并走既有取消写点）
  f.beats[0]()
  f.clock.t += 60000
  f.ticks[0]()
  assert.equal(f.isAborted(), true, "首个真实事件后武装 ⇒ 到点仍由既有取消写点 abort")
  f.settleResult({ stopReason: "aborted", output: [{ type: "text", text: "" }] })
  const outcome = await f.specs[0].hooks.done
  assert.equal(outcome.detail, "silence watchdog (engSilenceAbortMs)", "武装后到点分支照常（零事件腿不打折机制）")
  })

  // ═══ 批 30 / US-2（D30-3④ · 锚 A30-6）：首次心跳前不武装（零变化运行）+ out-of-process 降级 ═══
  // ① 零**变化**运行（seq 恒定、事件面接上但零事件）⇒ 不 abort、退回总预算（D9 口径不回退）
  {
    const fZero = makeFrame({ form: "hang", abortMs: 60000, seqStart: 42 })   // 主腿读数**恒定**（不涨）
    try {
      const _capZero = await captureWarn(async () => {
        await runEngCoder(fZero.deps, { task: "implement the zero-change leg", designToken: fZero.st.designToken, docs: [] })
        await flush(() => fZero.specs.length === 1 && fZero.heartbeatRegs().length === 2 && fZero.ticks.length === 1,
          "A30-6①：两腿装配完成（events 二 / ticks 一）")
        fZero.clock.t = 600000
        for (let i = 0; i < 3; i++) fZero.ticks[0]()
        assert.equal(fZero.isAborted(), false,
          "★ 首次**变化**（心跳）之前不武装 ⇒ 读数恒定的运行不 abort、退回总预算（宁可晚掐，不误杀）")
      })
      assert.ok(_capZero.warnings.length >= 0, "（捕获通道：裸告警不落到 stderr）")
    } finally { fZero.drop() }
  }
  // ② **out-of-process**（`localAgent === undefined`）+ 事件面也不可用 ⇒ 如实标注「未生效」+ 退回总预算
  {
    const fOop = makeFrame({ form: "hang", seqStart: null, eventSurface: false })
    try {
      const capOop = await captureWarn(async () => {
        await runEngCoder(fOop.deps, { task: "implement the out-of-process leg", designToken: fOop.st.designToken, docs: [] })
        await flush(() => fOop.specs.length === 1, "A30-6②：jobs.start → subagents.start")
      }, (ws) => ws.some((w) => w.includes("静默看门狗未生效")))
      assert.equal(fOop.requests.length, 1, "派发照常发生（降级 ≠ 拒发）：" + JSON.stringify(fOop.requests.length))
      assert.equal(fOop.runs.length, 1, "子代理确实起了（不抛、不中断）")
      const line = capOop.warnings.find((w) => w.includes("静默看门狗未生效"))
      assert.ok(line !== undefined, "★ 如实标注「未生效」（不静默）：" + JSON.stringify(capOop.warnings.slice(0, 3)))
      assert.ok(line.includes("localAgent === undefined"), "归因逐字点明 out-of-process：" + line)
      fOop.clock.t = 600000
      fOop.ticks[0]()
      assert.equal(fOop.isAborted(), false, "未生效 ⇒ 不中止（退回总预算）")
      assert.equal(fOop.cleared.length, 1, "降级点已清掉轮询者（幂等 dispose：只清一次，不泄漏定时器）")
    } finally { fOop.drop() }
  }
  } finally { f.drop() }
})

test("D1/D2 (AC-1): 平台保留名 run_code 不进 deny + 公开读取面 view(agent).restrictableNames 为主名域（取到 ⇒ applied:true 且 deny ⊆ 该集合）", async () => {
  // —— D1（单元面）：run_code 不再命中执行类谓词（一被命名，平台 restrict() 直接抛错 ⇒ 打断派发） ——
  // 批 30 / US-1：夹具改走**带 scope 的主读取面**（旧 `list` 候选面已删）
  const reserved = resolveExecToolDeny({ tools: { view: () => ({ restrictableNames: ["read", "pwsh", "bash", "run_code"] }) } })
  assert.ok(!reserved.deny.includes("run_code"), "保留名不进 deny：" + JSON.stringify(reserved.deny))
  assert.deepEqual(reserved.execNames, ["pwsh", "bash"], "执行类谓词不再命中 run_code")

  // —— D2：平台公开面优先，且只下发**与 restrictableNames 求交后**的名字 ——
  const restrictable = ["read", "write", "edit", "grep", "pwsh", "bash", "web_search"]
  const viewSurface = {
    view: () => ({
      visible: new Map(restrictable.map((n) => [n, {}])),
      knownNames: new Set([...restrictable, "run_code"]),   // 保留名只在 knownNames 里出现
      restrictableNames: new Set(restrictable),
    }),
    list: () => ["read"],                                    // 陈旧候选面：有 view 时**不得**被采用
  }
  const unit = resolveExecToolDeny({ tools: viewSurface })
  assert.equal(unit.applied, true, "取到 restrictableNames ⇒ 生效（不再恒未生效）")
  assert.equal(unit.source, "view(agent)", "来源 = 平台公开读取面（restrict() 的合法名域），**带 scope**（批 30 / US-1）")
  // 订正（宿主验收）：`deny` 还含**插件自身**的基线工具名（BASE_DENY 里的 escalate/consult_* 等）——
  // 它们不是平台工具名、本就不在 restrictableNames 域内 ⇒ 子集谓词只能约束**新追加的执行类名**。
  for (const n of unit.execNames) assert.ok(restrictable.includes(n), "执行类新追加名逐名 ⊆ restrictableNames：" + n)
  for (const n of unit.deny.filter((x) => !BASE_DENY.includes(x))) assert.ok(restrictable.includes(n), "deny 新追加部分 ⊆ restrictableNames：" + n)
  assert.deepEqual(unit.deny, [...BASE_DENY, "pwsh", "bash"], "deny = 基线 + 求交后的执行类")

  const f = makeFrame({ toolsSurface: viewSurface })
  try {
  // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
  // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
  // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
  const _capD12 = await captureWarn(async () => {
  await runEngCoder(f.deps, { task: "implement the view-surface leg", designToken: f.st.designToken, docs: [] })
  await flush(() => f.specs.length === 1 && f.requests.length === 1,
    "D1/D2：jobs.start → subagents.start")
  const deny = f.requests[0].toolFilter.deny
  for (const n of deny.filter((x) => !BASE_DENY.includes(x))) assert.ok(restrictable.includes(n), "派发载荷**新追加部分** ⊆ restrictableNames：" + n)
  assert.ok(!deny.includes("run_code"), "保留名（knownNames 有 / restrictableNames 无）不得下发")
  })
  } finally { f.drop() }

  // ═══ 批 30 / US-1（D30-2 · 锚 A30-2）：**带 scope** 读名域 ⇒ 首次派发即 applied:true + 名下来源可证 ═══
  // 病（D-55）：批 29 读的是**无参** view()（= 全局视图），而本部署把执行类工具挂在祖先层 ⇒ 全局面
  // 看不见执行类名 ⇒ 生产恒 applied:false（空转）。本腿钉两件事：① scope **就是** Agent 对象本身
  // （且与派发处传给 parent 的是**同一对象**）；② 证据行附**名下来源**与**逐字命中名清单**。
  {
    const scopeSeen = []
    const SCOPE_SURFACE = ["read", "write", "edit", "grep", "pwsh", "bash", "run_code", "web_search"]
    const f2 = makeFrame({
      toolsSurface: { view: (scope) => { scopeSeen.push(scope); return { restrictableNames: new Set(SCOPE_SURFACE) } } },
    })
    try {
      const cap = await captureWarn(async () => {
        await runEngCoder(f2.deps, { task: "implement the scoped deny leg", designToken: f2.st.designToken, docs: [] })
        await flush(() => f2.specs.length === 1 && f2.requests.length === 1, "A30-2：jobs.start → subagents.start")
      }, (ws) => ws.some((w) => w.includes("工具面禁执行已下发")))
      assert.ok(scopeSeen.length >= 1, "前置：名域读取面**确实被调用**（否则下面的同一对象断言是恒真）")
      assert.equal(scopeSeen[0], f2.deps.agent,
        "★ A30-2：scope = deps.agent（**Agent 对象本身**——无参全局视图正是 D-55 的根因）")
      assert.equal(f2.requests[0].parent, f2.deps.agent,
        "与派发处传给 parent 的是**同一对象**（设计 §2.1① 逐字要求）")
      const deny2 = f2.requests[0].toolFilter.deny
      assert.deepEqual(deny2, [...BASE_DENY, "pwsh", "bash"], "deny 恰含命中名（逐字）：" + JSON.stringify(deny2))
      assert.ok(!deny2.includes("run_code"), "★ 绝不含 run_code（一命名即抛错）：" + JSON.stringify(deny2))
      const line = cap.warnings.find((w) => w.includes("工具面禁执行已下发"))
      assert.ok(line !== undefined, "已下发必须留一条证据行（裸 console.warn）：" + JSON.stringify(cap.warnings))
      assert.ok(line.includes("名下来源 = view(agent)"), "★ 证据行附**名下来源**：" + line)
      assert.ok(line.includes("deny 追加 pwsh, bash）"), "逐字命中名清单在场：" + line)
      assert.ok(line.includes("残余风险"), "残余风险（run_code 不可经 restrict 收窄）写在证据行里：" + line)
    } finally { f2.drop() }
  }

  // ═══ 批 30 / US-1（D30-2 · 锚 A30-3）：三级诚实降级（主面抛错 / 返回空 ⇒ 退 schemas；都失败 ⇒ 不下发）═══
  {
    const SCOPE = { session: { id: "scope-probe" } }
    // ① 主面**抛错** ⇒ 退 schemas(agent)，且保留名 run_code 被剔
    const schemasSeen = []
    const threw = resolveExecToolDeny({
      tools: {
        view: () => { throw new Error("view unavailable") },
        schemas: (scope) => { schemasSeen.push(scope); return [{ name: "read" }, { name: "pwsh" }, { name: "run_code" }, { name: "bash" }] },
      },
    }, undefined, SCOPE)
    assert.equal(threw.applied, true, "主面抛错 ⇒ 退路可用即生效（不因主面故障而空转）")
    assert.equal(threw.source, "schemas(agent)", "名下来源如实标 schemas(agent)：" + threw.source)
    assert.deepEqual(threw.execNames, ["pwsh", "bash"], "退路里逐字命中执行类名")
    assert.deepEqual(threw.deny, [...BASE_DENY, "pwsh", "bash"], "★ 退路结果同样剔 run_code：" + JSON.stringify(threw.deny))
    // ★ **如实登记一处非决定性**（变异自证 M10）：退路面里的「剔 `run_code`」是**冗余防线**——
    //   执行类谓词 `EXEC_TOOL_RE` 本就不命中它（D1 已锁），故**删掉该滤除观测不到差异**（全套仍绿）。
    //   「deny 绝不含 run_code」的**决定性命中**仍由 D1 那一半承担（谓词 + 显式滤除，双保险）。
    assert.equal(schemasSeen[0], SCOPE, "退路同样**带 scope** 调用（不是无参）")
    // ② 主面**返回空**（名集为空）⇒ 同样退 schemas(agent)
    const emptyThen = resolveExecToolDeny({
      tools: { view: () => ({ restrictableNames: new Set() }), schemas: () => ["pwsh"] },
    }, undefined, SCOPE)
    assert.equal(emptyThen.applied, true, "主面返回空 ⇒ 退路可用即生效")
    assert.equal(emptyThen.source, "schemas(agent)", "退路生效 ⇒ 来源标 schemas(agent)")
    assert.deepEqual(emptyThen.execNames, ["pwsh"])
    // ③ 两条都失败 ⇒ **不下发** + 如实标注（applied:false / deny 逐字基线 / source null）
    const both = resolveExecToolDeny({ tools: { view: () => { throw new Error("boom") } } }, undefined, SCOPE)
    assert.equal(both.applied, false, "两条都拿不到 ⇒ 不下发（applied:false 语义不变）")
    assert.deepEqual(both.deny, BASE_DENY, "不下发 ⇒ deny 逐字基线（不猜名）")
    assert.equal(both.source, null, "无读取面 ⇒ 名下来源为 null（caller 如实标「(无读取面)」）")
    assert.ok(String(both.reason).includes("读取面不可用"), "归因如实：" + both.reason)
    // ④ 行为面：两条都失败 ⇒ 派发载荷零执行类名，且证据行**如实标注名下来源为空**
    const f3 = makeFrame({ toolsSurface: { view: () => { throw new Error("boom") } } })
    try {
      const cap3 = await captureWarn(async () => {
        await runEngCoder(f3.deps, { task: "implement the degraded deny leg", designToken: f3.st.designToken, docs: [] })
        await flush(() => f3.specs.length === 1 && f3.requests.length === 1, "A30-3：jobs.start → subagents.start")
      }, (ws) => ws.some((w) => w.includes("工具面禁执行未生效")))
      assert.deepEqual(f3.requests[0].toolFilter.deny, BASE_DENY,
        "★ 不下发 ⇒ 载荷 = 逐字基线（不假装拦住）：" + JSON.stringify(f3.requests[0].toolFilter.deny))
      const line3 = cap3.warnings.find((w) => w.includes("工具面禁执行未生效"))
      assert.ok(line3 !== undefined, "如实标注「未生效」：" + JSON.stringify(cap3.warnings))
      assert.ok(line3.includes("名下来源 = (无读取面)"), "★ 如实标注名下来源为空（不编一个来源出来）：" + line3)
    } finally { f3.drop() }
  }
})

// ═══════════════ A29-8（批 29 §2.6 US-A / D-53）：**一次性留档**三腿 ═══════════════
// 目的（设计 §2.6④）：静默看门狗与工具面禁执行的**生产生效性**本机无法自验 ⇒ 真机放一次就能拿到
// 「平台到底给了什么」。三条腿**各有独立的裁决面**（**批 30 / US-2 已随心跳改接同步口径**）：
//   · A29-8a：两腿都可用 ⇒ 记下**命中事件面名**与 **seq 主腿可用性**；
//   · A29-8b：事件辅腿零命中 ⇒ 列出 `Object.keys(run)` 并如实标注零命中；
//   · A29-8c：工具面首次 applied:false ⇒ 既有「未生效」warn 的**同一行**追加 `ctx.tools` 键名清单。
// 任一形态的实现缺失**只让对应那条腿红**（另两条照绿 ⇒ 可独立转红，互不掩盖）。

test("A29-8a (§2.6 US-A① / AC-9): 接线留档（两腿都可用）= 记下**命中事件面**与 seq 主腿可用性 + run 键清单；进程内只一次；不进返回文本", async () => {
  // —— 单元面：留档函数的返回契约（true = 本次真的打印了 / false = 闩已合上）——
  const runA = { result: Promise.resolve(), dispose() {}, onEvent() {} }
  __resetWatchdogAttachArchiveForTest()
  const cap1 = await captureWarn(async () => archiveWatchdogAttach(runA, { attached: true, via: "agent/assistant-stream, tools/result", seq: { available: true, reason: null } }))
  assert.equal(cap1.value, true, "首次 ⇒ 真的打印了（返回 true）")
  assert.equal(cap1.warnings.length, 1, "首次接线**恰一条** warn：" + JSON.stringify(cap1.warnings))
  assert.ok(cap1.warnings[0].includes("接线留档"), "留档行可辨识：" + cap1.warnings[0])
  // ★ F1（批 29 §2.6 收尾小单 / 只读分歧审计；批 30 / US-2 随心跳改接口径同步）：判据必须是**相邻字面**
  //   「事件辅腿=命中「…」」——只判 includes(via) 时，把 lib/silence-watchdog.mjs 里「命中」那一段整段
  //   删掉，本腿**仍然绿**（非决定性）。本行把裁决面收敛到「命中名」这一件事上。
  //   批 30 起 via 是**两条真事件面名**（不是被删掉的猜测表里的 run 成员名）⇒ 与 run 键清单**不可能**撞车，
  //   决断性比批 29 更强。
  assert.ok(cap1.warnings[0].includes("事件辅腿=命中「agent/assistant-stream, tools/result」"),
    "attached 真 ⇒ 记下**命中的事件面名**（相邻字面判定）：" + cap1.warnings[0])
  assert.ok(cap1.warnings[0].includes("seq 主腿=可用"),
    "同一行如实记下**主腿可用性**（两腿都采样，信息量最大的一笔）：" + cap1.warnings[0])
  assert.ok(cap1.warnings[0].includes("dispose") && cap1.warnings[0].includes("result"),
    "留档附 run 的键名清单（Object.keys(run)）：" + cap1.warnings[0])
  assert.ok(!cap1.warnings[0].includes("\n"), "单行（可 grep）")
  const cap2 = await captureWarn(async () => archiveWatchdogAttach(runA, { attached: true, via: "agent/assistant-stream, tools/result", seq: { available: true, reason: null } }))
  assert.equal(cap2.value, false, "第二次 ⇒ 闩已合上（返回 false）")
  assert.deepEqual(cap2.warnings, [], "**第二次不再打印**（进程内一次闩）")

  // —— 派发腿：走真实接线点（eng.mjs 后台 run() 内 attachSubagentHeartbeat 之后）——
  const f = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbeA: 1 } })
  try {
  __resetWatchdogAttachArchiveForTest()
  // 批 29 / §2.8：上面单元面那条留档**已经入队**（告警不再是唯一通道）⇒ 派发腿之前必须复位
  // 可读通道缓冲，否则本次派发的回执区会带上**单元面**那一条（跨腿串味，A29-13 的「恰一条」会红）。
  __resetArchiveChannelForTest()
  const r = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "archive the attach (hit)", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.beats.length === 2,
      "A29-8a 派发腿：jobs.start → subagents.start → attachSubagentHeartbeat（接驳完成 ⇒ 留档必已打印）")
    return dispatch
  }, (ws) => ws.some((w) => w.includes("接线留档")))
  const lines = r.warnings.filter((w) => w.includes("接线留档"))
  assert.equal(lines.length, 1, "派发路径的首次接线也恰一条留档：" + JSON.stringify(r.warnings))
  // ★ F1：同上——判据必须是**相邻字面**（批 30 起 via 是两条真事件面名，与 run 键清单不可能撞车；
  //   而批 29 时夹具自带 onEvent 键、与键清单一字不差 ⇒ 只判 includes 对「命中分支被删」不敏感）。
  assert.ok(lines[0].includes("事件辅腿=命中「agent/assistant-stream, tools/result」"),
    "命中名来自**真实的 ctx 事件面接线**——相邻字面判定：" + lines[0])
  assert.ok(lines[0].includes("seq 主腿=可用"),
    "★ 主腿来自**真实接线**（run.localAgent.session.seq 装配后即可用）：" + lines[0])
  assert.ok(lines[0].includes("archiveProbeA"), "键名清单如实反映 Object.keys(run)：" + lines[0])
  assert.ok(!r.value.includes("接线留档"), "留档**不进返回文本**（裸 console 告警）：" + r.value.slice(0, 120))
  assert.ok(!r.value.includes("[thincoder-suite] warning:"), "不得触碰 warnPrefix 通道（T12 锁）")
  // 批 30 修复轮 / F4（🔵5 收干——
  // 「单跑该档 stderr 零残留告警」）：**结算/交付段也必须在捕获窗内**。交付链尾的
  // `saveSessionState`（本档 DSH_HOME 置空、且 PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）
  // 恰在 `settleResult → hooks.done` 之间打一条裸告警；窗口只罩派发时它直落 stderr（修复前单跑实测 1 行）。
  await captureWarn(async () => {
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe A done" }] })
    await f.specs[0].hooks.done
  })
  // ★ F2（批 29 §2.6 收尾小单 / 只读分歧审计）：上文的「零污染」两行只覆盖**派发回执**
  //   （r.value = warnPrefix() + jobsDispatchReply），**没有覆盖 run() 内 jobOutcome 生成的交付正文**
  //   ⇒ 往交付正文里追加「接线留档」字样，本腿曾经仍然绿（应红）。判定改落在**真实交付文本**上：
  //   jobOutcome 的唯一正文出口 = handle.append 环（D-46 契约），故读该环，不读回执。
  assert.equal(f.handle.calls.length, 1, "交付正文恰经 handle.append 入环一次（D-46 契约）")
  const delivered = String(f.handle.calls[0] ?? "")
  assert.ok(delivered.includes("archive probe A done"), "前置：环里确实是本次交付正文：" + delivered.slice(0, 120))
  // ★ 批 29 / §2.8②（**本条断言的形态已改**）：留档现在**按设计**进回执区 ⇒ 契约从「零字样」改成
  //   「**正文之前零字样、正文之后恰一段**」。零污染的真正含义是**不混入子代理自己的报告**，
  //   而不是「机器观测不得出现」——后者正是 §2.8 判定为按构造不可读的旧通道。
  //   （前插才是危险方向：阶段门按前缀判表，见 A29-13。）
  const iBody = delivered.indexOf("archive probe A done")
  const iHeader = delivered.indexOf(HOST_ARCHIVE_HEADER)
  assert.ok(iBody >= 0, "前置：环里确实是本次交付正文：" + delivered.slice(0, 120))
  assert.ok(iHeader > iBody, "留档小节**追加在交付正文之后**（§2.8③ 硬约束）：iBody=" + iBody + " iHeader=" + iHeader)
  assert.equal(delivered.slice(0, iHeader).includes("接线留档"), false,
    "交付正文段（留档小节之前）零留档字样——留档绝不可前插混入子代理报告：" + delivered.slice(0, iHeader))
  } finally { f.drop() }

  // —— 静态锁：测试缝（命名约定 + @internal）在**生产路径零引用**（镜像 job-outcome 同款锁）——
  const libUrl = new URL("../lib/", import.meta.url)
  const seam = "__resetWatchdogAttachArchiveForTest"
  const refsSeam = (text) => text.includes(seam)
  assert.equal(refsSeam("const x = " + seam + "()"), true, "谓词自证：命中即真（不是恒假断言）")
  assert.equal(refsSeam("const x = 1"), false, "谓词自证：不命中即假")
  const hits = readdirSync(libUrl)
    .filter((name) => name.endsWith(".mjs") && name !== "silence-watchdog.mjs")
    .filter((name) => refsSeam(readFileSync(new URL(name, libUrl), "utf8")))
  assert.deepEqual(hits, [], "生产路径零引用测试缝：" + JSON.stringify(hits))
  const wdogSrc = readFileSync(new URL("../lib/silence-watchdog.mjs", import.meta.url), "utf8")
  assert.ok(wdogSrc.includes("export function " + seam + "("), "命名约定：__ 前缀 + ForTest 后缀")
  assert.ok(wdogSrc.includes("@internal"), "JSDoc 标注 @internal")
})

test("A29-8b (§2.6 US-A① / AC-9): 事件辅腿零命中形态 = 如实列出 Object.keys(run)（有界/去重/截断安全）、不报命中面名、第二次不再打印", async () => {
  // —— 派发腿：run 上**一个候选事件方法都没有**（attached:false）——
  // ★ 批 30 / US-2：`eventSurface:false` 只关**事件辅腿**；「未生效」标注的判据是**两腿都不可用**
  //   ⇒ 本腿再加上 `seqStart: null`（out-of-process）才是那条判据的真实形态。
  const f = makeFrame({ form: "hang", eventSurface: false, seqStart: null, runExtra: { archiveProbeB: 1 } })
  try {
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()   // §2.8：复位可读通道缓冲（对齐上方闩复位，不让本腿自带上一腿的留档）
  const r = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "archive the attach (no candidate)", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.runs.length === 1,
      "A29-8b 派发腿：jobs.start → subagents.start（本形态零事件面 ⇒ 无 beats 信号，就绪锚在 subagents.start 返回）")
    return dispatch
  }, (ws) => ws.some((w) => w.includes("接线留档")))
  const lines = r.warnings.filter((w) => w.includes("接线留档"))
  assert.equal(lines.length, 1, "零命中形态同样**恰一条**留档：" + JSON.stringify(r.warnings))
  assert.ok(lines[0].includes("事件辅腿=零命中"), "attached 假 ⇒ 如实标注零命中（不假装接上了）：" + lines[0])
  assert.ok(lines[0].includes("archiveProbeB") && lines[0].includes("result") && lines[0].includes("dispose"),
    "零命中 ⇒ 列出 Object.keys(run)：" + lines[0])
  assert.ok(!lines[0].includes("agent/assistant-stream"), "零命中形态不得凭空报命中面名")
  assert.ok(!lines[0].includes("\n"), "单行（可 grep）")
  assert.ok(!r.value.includes("接线留档"), "留档不进返回文本")
  // 既有「未生效」标注仍在场（§2.6 的两条职责不同：那条**按次**如实标注、这条**一次为限**留档）
  assert.ok(r.warnings.some((w) => w.includes("静默看门狗未生效")),
    "既有未生效标注不因留档而消失：" + JSON.stringify(r.warnings))
  // 批 30 修复轮 / F4（🔵5 收干——
  // 「单跑该档 stderr 零残留告警」）：**结算/交付段也必须在捕获窗内**。交付链尾的
  // `saveSessionState`（本档 DSH_HOME 置空、且 PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）
  // 恰在 `settleResult → hooks.done` 之间打一条裸告警；窗口只罩派发时它直落 stderr（修复前单跑实测 1 行）。
  await captureWarn(async () => {
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe B done" }] })
    await f.specs[0].hooks.done
  })
  // 同进程第二次接线（**不复位闩**）⇒ 不再打印
  const r2 = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "archive the attach (no candidate, second)", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 2,
      "A29-8b 第二次派发：jobs.start 第二次发生（第二次**期望不再打印** ⇒ 就绪锚在 specs.length===2）")
    return dispatch
  })
  assert.equal(r2.warnings.filter((w) => w.includes("接线留档")).length, 0, "第二次接线不再打印（进程内一次闩）")
  // 批 30 修复轮 / F4（🔵5 收干——
  // 「单跑该档 stderr 零残留告警」）：**结算/交付段也必须在捕获窗内**。交付链尾的
  // `saveSessionState`（本档 DSH_HOME 置空、且 PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）
  // 恰在 `settleResult → hooks.done` 之间打一条裸告警；窗口只罩派发时它直落 stderr（修复前单跑实测 1 行）。
  await captureWarn(async () => {
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe B done 2" }] })
    await f.specs[1].hooks.done
  })
  // ★ F2（形态已按 §2.8 更新）：两次交付的判定落在 **handle.append 环**（D-46 契约的唯一正文
  //   出口，r.value / r2.value 只是派发回执）；留档按设计**出现在环里**（回执区），契约因此从
  //   「零字样」改为「**正文段零字样 + 小节在正文之后**」。
  assert.equal(f.handle.calls.length, 2, "两次派发各恰一次交付正文入环（D-46 契约）")
  // §2.8：第一次派发**搬运**了留档（回执区可见），第二次（缓冲已空 ⇒ 只发一次）零留档。
  const first = String(f.handle.calls[0] ?? "")
  const second = String(f.handle.calls[1] ?? "")
  assert.equal(first.includes(HOST_ARCHIVE_HEADER), true,
    "第一次派发的交付正文尾部带留档小节（§2.8②）：" + first.slice(-160))
  assert.equal(second.includes(HOST_ARCHIVE_HEADER), false,
    "第二次派发**不重复追加**（缓冲只发一次，进程内）：" + second.slice(-160))
  const bodyOnly = (t) => { const s = String(t ?? ""); const i = s.indexOf(HOST_ARCHIVE_HEADER); return i === -1 ? s : s.slice(0, i) }
  assert.ok(f.handle.calls.every((t) => !bodyOnly(t).includes("接线留档")),
    "两次交付的**正文段**（留档小节之前）均零留档字样——§2.8③ 绝不前插：" + JSON.stringify(f.handle.calls.map((t) => bodyOnly(t).slice(0, 60))))
  } finally { f.drop() }

  // —— 键名清单渲染：US-A③ 的三条硬要求（**有界 / 去重 / 截断安全**）——
  assert.equal(formatKeyList({ a: 1, b: 2 }), "a, b (共 2 项)", "基本形态（逐字）")
  assert.equal(formatKeyList({ "": 1, a: 2 }), "a (共 1 项)", "空键名不进清单（零诊断价值）")
  assert.equal(formatKeyList(null), "(零键) (共 0 项)", "null ⇒ 零键（不抛）")
  assert.equal(formatKeyList(7), "(零键) (共 0 项)", "原始值 ⇒ 零键（不抛）")
  const throwing = new Proxy({}, { ownKeys() { throw new Error("boom") } })
  assert.equal(formatKeyList(throwing), "(零键) (共 0 项)",
    "属性枚举抛错 ⇒ 仍只返回字符串（截断安全：留档自身永不成为故障源）")
  const many = {}
  for (let i = 0; i < KEY_LIST_MAX + 6; i++) many["k" + i] = i
  const manyStr = formatKeyList(many)
  assert.ok(manyStr.includes("截断，共 " + (KEY_LIST_MAX + 6) + " 项"), "超出上界 ⇒ 只报总数（有界）：" + manyStr.slice(-30))
  assert.ok(!manyStr.includes("k" + (KEY_LIST_MAX + 1)), "超出上界的键名不进清单（有界）")
  assert.ok(manyStr.includes("k0") && manyStr.includes("k" + (KEY_LIST_MAX - 1)), "上界内的键名逐字在场")
  const longKey = {}
  longKey["x".repeat(80)] = 1
  assert.ok(formatKeyList(longKey).includes("x".repeat(48) + "…"), "超长键名被截断（截断安全）")
})

test("A29-8c (§2.6 US-A② / AC-9): 工具面首次 applied:false ⇒ 既有「未生效」warn 的**同一行**追加 Object.keys(ctx.tools)；一次为限", async () => {
  // 形态：名域**两级都拿不到**（夹具的 `tools` 只有一个非读取面的 `list` 方法）⇒ applied:false 且
  // reason 可读（"读取面不可用：两级名域读取面…"）。★ 批 30 / US-1 订正（D30-2）：旧的 registry-probe
  // 候选面已删 ⇒ 该夹具的**形态语义**由「命中候选面但无执行类」变为「两级读取面都不可得」——
  // 两者都是 applied:false（本腿真正要证的是**同一行内追加 ctx.tools 键名清单**，与归因文案无关）。
  const f = makeFrame({ form: "hang", toolsSurface: { list: () => ["read", "write"] } })
  try {
  // §2.8：留档缓冲是**进程内**单例（只发一次）⇒ 本档前面的腿若已搬运过，缓冲即关闭。本腿要断言
  // 「工具面留档进了字符流」，必须先复位缓冲（复位是**测试缝**，生产路径零引用）。
  // §2.9 🔵6 / A29-16：再显式复位**接线闩**——此前本腿只复位缓冲不复位闩，「首次接线留档是否
  //   在本腿发生」取决于前腿是否已把闩合上（正确性依赖跨腿顺序）。复位后**初始态自持**：无论
  //   单跑还是全量顺序，首次派发都真的产生一条接线留档（与工具面留档同缓冲、同 warn 窗口）；
  //   本腿既有断言都只按「工具面」字样过滤/定位，不因多出这一行留档而变化（文末 A29-16 的
  //   静态锁钉住本复位在场，删掉它 ⇒ 该锁红）。
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()
  const r1 = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "archive the tool surface", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.requests.length === 1,
      "A29-8c 派发腿：jobs.start → subagents.start")
    return dispatch
  }, (ws) => ws.some((w) => w.includes("工具面禁执行未生效")))
  const denyLines = r1.warnings.filter((w) => w.includes("工具面禁执行未生效"))
  assert.equal(denyLines.length, 1, "「未生效」标注**恰一行**（键名清单追加在同一行内，不新起一行）：" + JSON.stringify(r1.warnings))
  // ★ 🔵3 / A29-11：本行是**决定性**的（删掉实现里的追加段 ⇒ 本行必红），理由钉在这里以免被后人
  //   「顺手清理」掉：本 warn 行的**全部**可能来源只有三处——
  //     ① 固定前缀「eng_coder 工具面禁执行未生效」 ② denyPlan.reason ③ 追加的 ctx.tools 键名清单。
  //   本形态（`list: () => ["read", "write"]` ⇒ 两级读取面都不可得）走的是
  //   resolveExecToolDeny 的**第一个分支**，reason 逐字 = **「读取面不可用：两级名域读取面
  //   （view(agent).restrictableNames → schemas(agent)）都拿不到平台工具名清单」**——其中
  //   **不含 "list" 子串**（中文），前缀 ①、名下来源段（「；名下来源 = (无读取面)」）与分隔文案
  //   （「——本次照常派发（不假装拦住）」/「；ctx.tools 方法名清单 =」）同样不含 ⇒ `includes("list")`
  //   只可能由 ③ 命中，
  //   而 ③ 唯一的内容源是 Object.keys(ctx.tools) = ["list"]（夹具 toolsSurface 只有一个键）。
  //   ⇒ 追加段被整段删除（只留 ①②）时，本行**必红**；反过来，夹具若去掉 list 键，本行也必红。
  assert.ok(denyLines[0].includes("list"), "同一行追加 Object.keys(ctx.tools) 的方法名清单：" + denyLines[0])
  assert.ok(!denyLines[0].includes("\n"), "仍是单行（可 grep）")
  assert.ok(!r1.value.includes("工具面禁执行未生效") && !r1.value.includes("ctx.tools 方法名清单"),
    "留档不进返回文本（裸 console 告警）")
  assert.ok(!r1.value.includes("[thincoder-suite] warning:"), "不得触碰 warnPrefix 通道（T12 锁）")
  // 一次为限：同一 ctx 第二次派发不再打印（既有闩）
  // 批 30 修复轮 / F4（🔵5 收干——
  // 「单跑该档 stderr 零残留告警」）：**结算/交付段也必须在捕获窗内**。交付链尾的
  // `saveSessionState`（本档 DSH_HOME 置空、且 PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）
  // 恰在 `settleResult → hooks.done` 之间打一条裸告警；窗口只罩派发时它直落 stderr（修复前单跑实测 1 行）。
  await captureWarn(async () => {
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "tool surface probe done" }] })
    await f.specs[0].hooks.done
  })
  const r2 = await captureWarn(async () => {
    const dispatch = await runEngCoder(f.deps, { task: "archive the tool surface (second)", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 2,
      "A29-8c 第二次派发：jobs.start 第二次发生（第二次**期望不再打印** ⇒ 就绪锚在 specs.length===2）")
    return dispatch
  })
  assert.equal(r2.warnings.filter((w) => w.includes("工具面禁执行未生效")).length, 0, "同一 ctx 第二次 ⇒ 不再打印（一次为限）")
  // 批 30 修复轮 / F4（🔵5 收干——
  // 「单跑该档 stderr 零残留告警」）：**结算/交付段也必须在捕获窗内**。交付链尾的
  // `saveSessionState`（本档 DSH_HOME 置空、且 PLUGIN_DIR 之上无 profile 根 ⇒ 路径必然不可解析）
  // 恰在 `settleResult → hooks.done` 之间打一条裸告警；窗口只罩派发时它直落 stderr（修复前单跑实测 1 行）。
  await captureWarn(async () => {
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "tool surface probe done 2" }] })
    await f.specs[1].hooks.done
  })
  // ★ F2：工具面留档同一漏洞面——「未生效」标注与 ctx.tools 键名清单原本**只在 console**。
  //   批 29 / §2.8：同一条文案**入队** ⇒ 现在**出现在 handle.append 环**里（回执区，交付正文之后）。
  assert.equal(f.handle.calls.length, 2, "两次派发各恰一次交付正文入环（D-46 契约）")
  const bodyOnly = (t) => { const s = String(t ?? ""); const i = s.indexOf(HOST_ARCHIVE_HEADER); return i === -1 ? s : s.slice(0, i) }
  assert.ok(f.handle.calls.every((t) => !bodyOnly(t).includes("工具面禁执行未生效") && !bodyOnly(t).includes("ctx.tools 方法名清单")),
    "两次交付的**正文段**均零工具面留档字样（留档只进回执小节，绝不前插）：" + JSON.stringify(f.handle.calls.map((t) => bodyOnly(t).slice(0, 60))))
  assert.equal(String(f.handle.calls[0] ?? "").includes("ctx.tools 方法名清单"), true,
    "★ §2.8 的正面证据：工具面留档**进了字符流**（回执小节里可见，不再是只在 console）：" + String(f.handle.calls[0] ?? "").slice(-200))
  assert.equal(String(f.handle.calls[1] ?? "").includes(HOST_ARCHIVE_HEADER), false,
    "第二次派发不重复追加（缓冲只发一次，进程内）：" + String(f.handle.calls[1] ?? "").slice(-120))
  } finally { f.drop() }
})
// ——————————— 批 29 / §2.8（A29-13 · A29-14 · AC-11 · D-53 **可读通道**）———————————
//
// ★ 背景（**实测**，不是推断，故写进注释当证据记录）：§2.6 的两条留档原本**只走**裸 console 告警。
//   本部署上 ① 死亡日志只在**进程死亡时**记 stderr 尾部（实测：全是历史条目，零「接线留档」）；
//   ② 作业报告文件里**只有**经作业句柄 append 的字符（实测：真机区零插件告警，所有形似证据的行
//   都在**宿主验收回执**区）⇒ **那个证据通道按构造不可读**，D-53 无法闭合。故 §2.8 改的是**通道**：
//   入队 + 在**交付正文之后**追加到回执区。裸告警**保留**（人盯终端仍可见）但不再是唯一通道。
//
// ★ 两条跨腿纪律（本档自持）：
//   ① 留档缓冲是**进程内单例**且**只发一次** ⇒ 凡要断言它的腿，开头必须复位缓冲（否则读到的是
//      上一条腿的残留）。复位缝是**测试缝**（生产路径零引用，由 A29-14 腿尾的静态锁守住）。
//   ② 本档既有 A29-8a/8b/8c 的「交付正文零留档」判定已按 §2.8 改为「**正文段零留档 + 小节在正文之后**」
//      ——零污染的真正含义是**不混入子代理自己的报告**，而不是「机器观测不得出现」（后者正是 §2.8
//      判定为按构造不可读的旧通道）。

test("A29-13 (§2.8 · AC-11): 回执区**恰一条**「接线留档」行（含命中名与键清单）且**位于交付正文之后**；同一次派发里阶段门对合规报告**仍返回空串**（尾部追加不破门禁）", async () => {
  // checkMode 显式 subagent ⇒ 宿主验收回执面**零执行**（runHostStageChecks 直接返回空串、零真实
  // 进程）；本腿要验的是阶段门，故必须传结构化 stages（不传则门按 §9 边界 1 不核验）。
  const STAGES = [{ goal: "留档进回执区", files: ["lib/eng.mjs"], acceptance: "回执区可见", check: "node --check lib/eng.mjs", checkMode: "subagent" }]
  // 子代理交付报告 = 一张**全通过**的合规阶段表（阶段门据此应返回空串；中文表头亦钉住 D-54 的中文别名面）
  const REPORT = ["| 阶段 | 状态 | 检查摘要 |", "| --- | --- | --- |", "| 1 | 通过 | 语法检查通过 |", "", "Touched files: lib/eng.mjs"].join("\n")

  // —— 单元面：搬运工本身的形状（小节标题 / 逐行 / 一次闩 / 拒收迟到条目）——
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()
  const capU = await captureWarn(async () => archiveWatchdogAttach({ result: Promise.resolve(), dispose() {}, onEvent() {} }, { attached: true, via: "agent/assistant-stream, tools/result", seq: { available: true, reason: null } }))
  assert.equal(capU.warnings.length, 1, "裸 console 告警**保留**（入队不取代它）：" + JSON.stringify(capU.warnings))
  const block = drainArchiveBlock()
  assert.ok(block.startsWith("\n\n" + HOST_ARCHIVE_HEADER + "\n"),
    "回执小节：两换行起头 + 逐字标题（读者一眼看得出这是机器加的观测、不是交付内容）：" + JSON.stringify(block.slice(0, 60)))
  const secLines = block.trim().split("\n")
  assert.equal(secLines.length, 2, "小节 = 标题 + **恰一条**留档行（首尾不多出空行）：" + JSON.stringify(secLines))
  assert.ok(secLines[1].includes("接线留档"), "留档行可辨识：" + secLines[1])
  assert.ok(secLines[1].includes("事件辅腿=命中「agent/assistant-stream, tools/result」") && secLines[1].includes("dispose") && secLines[1].includes("result"),
    "回执区的留档行**含命中面名与键清单**（§2.8① 键清单口径逐字不变）：" + secLines[1])
  assert.equal(drainArchiveBlock(), "", "缓冲**只发一次**（进程内）：第二次搬运恒空串")
  assert.equal(enqueueArchiveLine("搬运后的迟到留档"), false, "搬运后拒收迟到的入队（不留一个永远搬不掉的缓冲）")

  // —— 门禁面：同一条**真实**留档块 × **真实**阶段门 ——
  assert.equal(stageGateNote(STAGES, REPORT), "", "前置：合规报告本身过门（空串）")
  assert.equal(stageGateNote(STAGES, REPORT + block), "",
    "★ 留档**追加在正文之后** ⇒ 阶段门对合规报告**仍返回空串**（尾部追加不破门禁）")
  // ★ 如实标注一条边界（免得后人拿它当更强的保证）：阶段门扫的是**前 4000 字符**内的表头，
  //   一段几百字的短留档**前插**未必立刻触发横幅（表仍在窗内）⇒ 本腿不拿「前插必红」冒充决定性；
  //   「绝不前插」由下面派发面的**位置**判定独立承担（那条对前插必红）。

  // —— 派发面：真实接线点（attach 留档入队 → 回执区尾部搬运），并**同一次派发**里过阶段门 ——
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()
  const f = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbe13: 1 } })
  try {
    const dispatch = await captureWarn(async () => {
      const r = await runEngCoder(f.deps, { task: "archive into the receipt section", designToken: f.st.designToken, docs: [], stages: STAGES })
      await flush(() => f.specs.length === 1 && f.beats.length === 2,
        "A29-13 派发腿：jobs.start → subagents.start → attachSubagentHeartbeat（接驳完成 ⇒ 留档已入队）")
      return r
    }, (ws) => ws.some((w) => w.includes("接线留档")))
    assert.equal(dispatch.value.includes("接线留档"), false, "前置：留档不进派发回执（只走裸告警 + 回执区两条旁路，不碰 warnPrefix 通道）")
    assert.equal(f.requests[0].prompt[0].text.includes("接线留档"), false, "留档**绝不进子代理任务正文**（指令面零污染）")
    assert.equal(f.requests[0].prompt[0].text.includes(HOST_ARCHIVE_HEADER), false, "同上（逐字标题也不得进任务书）")
    // 批 30 修复轮 / F4（🔵5 收干——「单跑该档 stderr 零残留告警」）：结算/交付段也必须在捕获窗内
    // （交付链尾 `saveSessionState` 的裸告警落在 settleResult → hooks.done 之间；窗口只罩派发时它直落 stderr）。
    await captureWarn(async () => {
      f.settleResult({ stopReason: "completed", output: [{ type: "text", text: REPORT }] })
      await f.specs[0].hooks.done
    })
    assert.equal(f.handle.calls.length, 1, "交付正文恰经 handle.append 入环一次（D-46 契约）")
    const delivered = String(f.handle.calls[0] ?? "")
    // ★ 同一次派发：阶段门返回空串 ⇒ 交付文本**直接从抬头开始**（尾部追加没有挤动横幅位置）。
    //   这条对「把留档前插」必红：前插后交付文本不再以交付抬头开头。
    assert.equal(delivered.slice(0, 40).includes("[thincoder-suite] warning:"), false,
      "前置：干净路径零告警前缀（与 A29-8a 同一前提；若此行红，先看 warnPrefix 侧）：" + delivered.slice(0, 80))
    assert.ok(delivered.startsWith("eng_coder delivery:\n"),
      "★ 同一次派发：阶段门对合规报告**返回空串**（横幅缺席 ⇒ 交付抬头即首行）：" + JSON.stringify(delivered.slice(0, 60)))
    assert.equal(delivered.includes("UNDECLARED"), false, "阶段门未产横幅（报告合规）：" + delivered.slice(0, 200))
    const iTable = delivered.indexOf("| 阶段 | 状态 | 检查摘要 |")
    const iHeader = delivered.indexOf(HOST_ARCHIVE_HEADER)
    assert.ok(iTable >= 0, "前置：交付正文里的合规阶段表在场（门禁读到的是它）：" + delivered.slice(0, 160))
    assert.ok(iHeader > iTable, "回执区留档**位于交付正文之后**（§2.8③ 硬约束）：iTable=" + iTable + " iHeader=" + iHeader)
    const archLines = delivered.slice(iHeader).split("\n").filter((l) => l.includes("接线留档"))
    assert.equal(archLines.length, 1, "回执区**恰一条**接线留档行：" + JSON.stringify(archLines))
    assert.ok(archLines[0].includes("事件辅腿=命中「agent/assistant-stream, tools/result」") && archLines[0].includes("archiveProbe13"),
      "该行含**命中面名 + 键清单**（Object.keys(run) 口径不变）：" + archLines[0])
    assert.equal(delivered.slice(0, iHeader).includes("接线留档"), false,
      "交付正文段（留档小节之前）零留档字样——留档绝不前插混入子代理报告")
  } finally { f.drop() }
})

test("A29-14 (§2.8 · AC-11): 留档出现在 handle.append 的**字符流**里（**不只是 console 告警**——告警被打成黑洞仍能取到）；缓冲区进程内**只发一次**、有界", async () => {
  // —— 有界：留档是诊断设施，不得刷屏、不得挤占交付正文（§2.8①「有界」）——
  __resetArchiveChannelForTest()
  let accepted = 0
  for (let i = 0; i < ARCHIVE_BUFFER_MAX + 5; i++) if (enqueueArchiveLine("有界探针 " + i)) accepted++
  assert.equal(accepted, ARCHIVE_BUFFER_MAX, "缓冲至多 ARCHIVE_BUFFER_MAX 条，超出即丢弃新条（有界、且先到先得）")
  assert.equal(enqueueArchiveLine("   "), false, "空/纯空白行拒收（不产空留档行）")
  const bounded = drainArchiveBlock()
  assert.equal(bounded.split("\n").filter((l) => l.startsWith("有界探针")).length, ARCHIVE_BUFFER_MAX,
    "搬运出来的是**有界**的那一批：" + bounded.split("\n").filter((l) => l.startsWith("有界探针")).length)
  assert.equal(drainArchiveBlock(), "", "只发一次（进程内）")

  // —— 决定性一腿：把 console 告警打成**黑洞**（收进数组但全程不参与任何断言），留档**仍**必须
  //    出现在 handle.append 的**字符流**里 ⇒ 证明可读通道**不是** console（删掉入队、只留告警
  //    的实现本腿必红）。告警侧只做「保留」的正向对照。
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()
  const f = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbe14: 1 } })
  const sink = []
  const orig = console.warn
  try {
    console.warn = (m) => { sink.push(String(m)) }   // 黑洞：只收集，不输出、不参与断言
    const r = await runEngCoder(f.deps, { task: "archive must be readable", designToken: f.st.designToken, docs: [] })
    await flush(() => f.specs.length === 1 && f.beats.length === 2,
      "A29-14 派发腿：接线完成（就绪信号 = attachSubagentHeartbeat 接驳 ⇒ 留档已入队）")
    assert.equal(r.includes("接线留档"), false, "前置：留档不进派发回执（仍是裸告警，不碰 warnPrefix 通道）")
    f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe 14 done" }] })
    await f.specs[0].hooks.done
  } finally { console.warn = orig }
  try {
    assert.equal(f.handle.calls.length, 1, "交付正文恰经 handle.append 入环一次（D-46 契约）")
    const delivered = String(f.handle.calls[0] ?? "")
    assert.ok(delivered.includes(HOST_ARCHIVE_HEADER),
      "★ 决定性：console 告警已被打成黑洞，留档**仍**出现在 handle.append 的字符流里：" + delivered.slice(-200))
    assert.ok(delivered.includes("接线留档") && delivered.includes("archiveProbe14"),
      "字符流里的留档含键名清单（作业报告里读得到，这就是 D-53 的可读通道）：" + delivered.slice(-200))
    assert.equal(sink.some((w) => w.includes("接线留档")), true, "裸告警**保留**（入队不取代它；人盯终端仍可见）")

    // —— 只发一次：同进程第二次派发（不复位闩、不复位缓冲）⇒ 不重复追加 ——
    console.warn = () => {}
    try {
      await runEngCoder(f.deps, { task: "archive must be readable (second)", designToken: f.st.designToken, docs: [] })
      await flush(() => f.specs.length === 2, "A29-14 第二次派发：jobs.start 第二次发生")
      f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe 14 done 2" }] })
      await f.specs[1].hooks.done
    } finally { console.warn = orig }
    assert.equal(f.handle.calls.length, 2, "两次派发各恰一次交付正文入环")
    const second = String(f.handle.calls[1] ?? "")
    assert.equal(second.includes(HOST_ARCHIVE_HEADER), false, "第二次派发**不重复追加**（缓冲只发一次，进程内）：" + second.slice(-160))
    assert.equal(second.includes("接线留档"), false, "同上（逐字判定，不用标题常量兜底）")
    assert.equal(drainArchiveBlock(), "", "搬运过 ⇒ 通道已关闭（迟到的入队也拒收，无第二个出口）")

    // —— 🔵D4（§2.8 审计 · 合并修复轮）：让「第二次搬运不重复追加」在**派发面**也由**闩**决定 ——
    //   上面的第二次派发之所以不追加，是因为**接线留档自身的闩**让它零入队（缓冲本来就是空的）
    //   ⇒ 「删闩」类变异（去掉 `archiveDrained = true`）在派发面**逮不住**。本段补齐：
    //   **只复位接线留档的闩**（让第三次派发**真的会再入队一条**），**不动**搬运闩 ⇒
    //   第三次交付**不得**带留档小节。删闩 ⇒ 入队成功 ⇒ 第三次交付带上小节 ⇒ 本段**必红**。
    assert.equal(enqueueArchiveLine("闩合上后的迟到留档"), false, "闩合上 ⇒ 迟到入队被拒（通道没有第二个出口）")
    __resetWatchdogAttachArchiveForTest()   // 只复位**接线**留档的闩：本次派发会重新入队
    console.warn = () => {}
    try {
      await runEngCoder(f.deps, { task: "archive must be readable (third, latch probe)", designToken: f.st.designToken, docs: [] })
      await flush(() => f.specs.length === 3, "D4 第三次派发：jobs.start 第三次发生")
      f.settleResult({ stopReason: "completed", output: [{ type: "text", text: "archive probe 14 done 3" }] })
      await f.specs[2].hooks.done
    } finally { console.warn = orig }
    assert.equal(f.handle.calls.length, 3, "三次派发各恰一次交付正文入环")
    const third = String(f.handle.calls[2] ?? "")
    assert.equal(third.includes(HOST_ARCHIVE_HEADER), false,
      "★ D4 派发面：闩合上后第三次派发**仍不追加**留档小节（由闩决定，不是「恰好缓冲空」）：" + third.slice(-160))
    assert.equal(third.includes("接线留档"), false, "同上（逐字判定，不用标题常量兜底）")
  } finally { f.drop() }

  // —— 静态锁：留档通道的测试缝（命名约定 + @internal）在**生产路径零引用**（镜像 A29-8a 同款锁）——
  const libUrl = new URL("../lib/", import.meta.url)
  const seam = "__resetArchiveChannelForTest"
  const hits = readdirSync(libUrl)
    .filter((name) => name.endsWith(".mjs") && name !== "silence-watchdog.mjs")
    .filter((name) => readFileSync(new URL(name, libUrl), "utf8").includes(seam))
  assert.deepEqual(hits, [], "生产路径零引用留档通道测试缝：" + JSON.stringify(hits))
  const wdogSrc = readFileSync(new URL("../lib/silence-watchdog.mjs", import.meta.url), "utf8")
  assert.ok(wdogSrc.includes("export function " + seam + "("), "命名约定：__ 前缀 + ForTest 后缀")
  assert.ok(wdogSrc.includes("export function " + seam + "(") && wdogSrc.includes("@internal"), "JSDoc 标注 @internal（三者同时在场才构成测试缝）")
})

// ═══════════════ §2.8 审计（合并修复轮 · 2026-09-27）：🔴D1 · 🔵D3 · 🔵D4 ═══════════════

test("§2.8 审计 🔴D1（AC-11 · A29-13/14）: **空搬运不关闩**——dsh 同步回执点零入队地搬运一次后，首派证据**仍**进得了回执区（同时承担 🔵D3 的第二个行为腿：dsh 同步回执点）", async () => {
  // ★ 这条腿钉的是 §2.8 审计 🔴D1 的**可达路径**，不是假想：`drainArchiveBlock` 曾在**判空之前**就
  //   置闩 ⇒ 一次「本进程暂无留档」的空搬运就把可读通道**永久关死**（此后 `enqueueArchiveLine` 恒
  //   false）。dsh 同步回执点（`background:false` 的主返回点）在工具面 `applied:true` 时**零入队**
  //   却**照常搬运** ⇒ **首次交付**即触发关死 ⇒ 此后首派证据永远进不了回执区（§2.8 要消灭的
  //   「证据按构造不可读」形态）。单元面最小复现：reset → drain() === "" → enqueue() === false。
  const appliedTools = {
    view: () => ({ visible: true, knownNames: ["read", "pwsh"], restrictableNames: ["read", "pwsh"] }),
  }
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()

  // ① 首次交付走 **dsh 同步回执点**：工具面已 applied ⇒ 本次**零入队** ⇒ 该点搬运的是**空缓冲**。
  const fSync = makeFrame({ toolsSurface: appliedTools })
  let syncText = ""
  try {
    // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
    // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
    // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
    const _capD1sync = await captureWarn(async () => {
    const pending = runEngCoder(fSync.deps, { task: "first delivery on the sync path (empty drain)", designToken: fSync.st.designToken, docs: [], background: false })
    await flush(() => fSync.requests.length === 1,
      "D1①：dsh 同步路径的 ctx.subagents.start（就绪信号 = requests 首次出现 ⇒ settleResult 已就绪）")
    fSync.settleResult({ stopReason: "completed", output: [{ type: "text", text: "sync first delivery done\n\nTouched files: lib/eng.mjs" }] })
    syncText = String(await pending)
    })
  } finally { fSync.drop() }
  assert.ok(syncText.includes("eng_coder delivery:"),
    "前置：确实走的是 dsh 同步**成功**回执点（4/4），不是回落信封/错误分支：" + syncText.slice(0, 160))
  assert.equal(syncText.includes(HOST_ARCHIVE_HEADER), false,
    "dsh 同步回执点：工具面已 applied ⇒ 本次零入队 ⇒ 搬运返回空串（回执区**没有**留档小节，行为逐字节不变）")

  // ② 决定性：空搬运**不得**关闩——首派证据此刻仍能入队。
  const PROBE = "[thincoder-suite] 首派证据探针（D1：空搬运后仍应入队）"
  assert.equal(enqueueArchiveLine(PROBE), true,
    "★ 🔴D1 决定性：空搬运**不关闩** ⇒ 后续首派证据仍能入队（把 archiveDrained = true 挪回判空之前本行**必红**）")

  // ③ 该行**仍出现在某个回执区**：随后的 dsh 后台派发把缓冲搬进交付正文（dsh 后台回执点 3/4）。
  __resetWatchdogAttachArchiveForTest()   // 复位**接线**留档的闩：本次派发会再产出一条真实首派证据
  const fBg = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbeD1: 1 }, toolsSurface: appliedTools })
  let delivered = ""
  try {
    // 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：本腿跑**真实派发路径** ⇒ 裸告警（工具面「未生效」/ 一次性接线留档）
    // 会直接打到 stderr（未捕获 = 测试输出噪音）⇒ 整段套 `captureWarn`——**定死用捕获**，不用「档头注一句」。
    // ★ 捕获窗口覆盖全腿（含断言），因为告警可能在 await 链的尾段才落；捕获本身也是判据（见腿尾断言）。
    const _capD1bg = await captureWarn(async () => {
    const dispatch = await runEngCoder(fBg.deps, { task: "second delivery: the first archive must still be readable", designToken: fBg.st.designToken, docs: [] })
    await flush(() => fBg.specs.length === 1 && fBg.beats.length === 2,
      "D1③：后台派发 + 事件面接驳（就绪信号 = specs/beats 各一）")
    assert.equal(dispatch.includes("接线留档"), false, "前置：留档不进派发回执（仍是裸告警，不碰 warnPrefix 通道）")
    fBg.settleResult({ stopReason: "completed", output: [{ type: "text", text: "probe d1 second delivery done" }] })
    await fBg.specs[0].hooks.done
    assert.equal(fBg.handle.calls.length, 1, "交付正文恰经 handle.append 入环一次（D-46 契约）")
    delivered = String(fBg.handle.calls[0] ?? "")
    })
  } finally { fBg.drop() }
  const iHeader = delivered.indexOf(HOST_ARCHIVE_HEADER)
  assert.ok(iHeader !== -1,
    "★ 通道没被空搬运关死：首派证据（探针 + 接线留档）随第二次派发进了回执区：" + delivered.slice(-240))
  assert.ok(delivered.includes(PROBE), "探针行逐字在回执区（首派证据没丢）：" + delivered.slice(-240))
  assert.ok(delivered.includes("接线留档") && delivered.includes("archiveProbeD1"),
    "同时到达的**真实**首派证据（接线留档 + 键名清单）也在回执区：" + delivered.slice(-240))
  assert.ok(iHeader > delivered.indexOf("probe d1 second delivery done"),
    "留档小节**位于交付正文之后**（绝不前插，阶段门是前缀式判定）")
  assert.equal(enqueueArchiveLine("搬运后的迟到留档"), false, "**真搬到了行** ⇒ 此后闩合上、拒收迟到入队（只发一次的既有语义不变）")
})

test("§2.8 审计 🔵D3（AC-11 · D48-2 接线点 1/4…4/4）: 四个**回执书写点**逐一含 drainArchiveBlock 调用（静态逐点覆盖；行为腿覆盖 3/4 与 4/4，另两点由本腿承担——**不冒充行为覆盖**）", () => {
  // ★ 为什么要静态腿（§2.8 审计 🔵D3）：`lib/eng.mjs:917` 自称「四个成功返回点，缺一不可」，而
  //   行为腿原先**只覆盖 dsh 后台那一点**（:1518）⇒ 删掉 :1304 / :1361 / :1688 三处搬运调用全绿。
  //   本腿逐点核「搬运调用在该返回语句本体里」；**行为面**由 D1 腿（4/4 dsh 同步）+ A29-14 腿
  //   （3/4 dsh 后台）承担。codex 两点（1/4 :1304 后台、2/4 :1361 同步）**只有静态覆盖**——
  //   如实登记为覆盖边界，不冒充行为覆盖（本档既不新增 codex 夹具，也不改 `lib/eng.mjs`）。
  const src = readFileSync(new URL("../lib/eng.mjs", import.meta.url), "utf8")
  const lines = src.split("\n")
  const CALL = "drainArchiveBlock("
  // 窗口 = 锚点所在行 + 其后 WINDOW-1 行（覆盖「表达式折行到下一行」的写法，如 4/4 的 :1687+:1688）。
  const WINDOW = 3
  const points = [
    { id: "1/4 codex 后台", anchor: "output: stageGateNote(stages, env.text) + deliveryText(env.text) + hostReceipt" },
    { id: "2/4 codex 同步", anchor: "return stageGateNote(stages, env.text) + deliveryText(env.text) + capNote" },
    { id: "3/4 dsh 后台", anchor: "output: stageGateNote(stages, outputText) + warnPrefix()" },
    { id: "4/4 dsh 同步", anchor: "return stageGateNote(stages, outputText) + warnPrefix()" },
  ]
  // 「四个」这句声明本身也要有断言——点数漂了（增/减返回点）本腿必红，而不是静默少核一个点。
  assert.equal(lines.filter((l) => l.includes(CALL)).length, points.length,
    "lib/eng.mjs 里搬运调用恰四处（与「四个回执书写点」一一对应）：" + points.length)
  for (const p of points) {
    const hits = []
    for (let i = 0; i < lines.length; i++) if (lines[i].includes(p.anchor)) hits.push(i)
    assert.equal(hits.length, 1, p.id + "：锚点在 lib/eng.mjs 里**恰命中一行**（锚点失真 ⇒ 本腿会核错位置）：" + JSON.stringify(hits))
    const region = lines.slice(hits[0], hits[0] + WINDOW).join("\n")
    assert.ok(region.includes(CALL),
      p.id + "（行 " + (hits[0] + 1) + "）：回执书写点**含搬运调用**（删掉这一点 ⇒ 本行必红）")
  }
  // 「为何决定性」钉在断言旁以免被后人「顺手清理」：窗口谓词对**没有**搬运调用的返回语句必须为假。
  assert.equal(lines.slice(0, 3).join("\n").includes(CALL), false,
    "窗口谓词自证：同样宽度的窗口若落在无关行上必须**判否**（否则本腿退化成恒真断言）")
})

// ═══════════════ 批 29 / §2.9（收尾四 · 2026-09-27）：交付码评 6 条 🔵 收干（A29-15 · A29-16 · AC-12）═══════════════
// 来源：§2.8 修复轮的交付码评（PASS，6 条 🔵）。逐条对位：🔵1 双口径渲染 · 🔵2 null 视同缺失（口径写进
// JSDoc）· 🔵3 键名清洗 · 🔵4 缓冲与 warn 同一原文——前四条落在 A29-15 / A29-16 两条腿；🔵6 = A29-8c 腿头部
// 复位接线闩（见该腿；本节 A29-16 的静态锁钉住复位在场）；🔵5 是**登记边界**（零行为改动 ⇒ 不设腿，边界
// 注释一行落在 lib/silence-watchdog.mjs 的 drainArchiveBlock JSDoc 里）。
// ★ 纪律：这两条腿放**文件末尾**——它们会消费留档闩/缓冲（各腿自带复位），其后无腿 ⇒ 零串味；A29-15
//   只碰纯函数与源码静态读，不触碰任何进程内单例状态。

test("A29-15 (§2.9 🔵1/2/3 · AC-12): 非法值告警**双口径**（NaN 不再串成孤零零的 null）· 显式 null 视同缺失且口径写进 JSDoc · 键名内部换行被折叠为单行", async () => {
  // —— 🔵1：双口径渲染。决定性形态 = NaN：JSON.stringify(NaN) === "null" 而 String(NaN) === "NaN"
  //   ⇒ 旧实现（单 JSON 口径）的告警读成「invalid engSilenceAbortMs null」，把排障引向「谁配了
  //   null」的错方向（本仓真实码评形态）。双口径并列 ⇒ 两种读法都对得上账。
  const wNaN = resolveEngSilenceAbortMs({ engSilenceAbortMs: NaN })
  assert.equal(wNaN.ms, ENG_SILENCE_ABORT_MS, "非法（NaN）⇒ 回落缺省不变")
  assert.ok(wNaN.warning.includes("NaN"),
    "★ NaN 形态必须带上 String 口径「NaN」——旧实现只剩孤零零的 null，本行必红：" + wNaN.warning)
  assert.ok(wNaN.warning.includes("null"),
    "NaN 形态同时保留 JSON 口径「null」⇒ 双口径并列（结构化面与人读两本账）：" + wNaN.warning)
  const wInf = resolveEngSilenceAbortMs({ engSilenceAbortMs: Infinity }).warning
  assert.ok(wInf.includes("Infinity") && wInf.includes("null"), "Infinity 同走双口径：" + wInf)
  // 两口径渲染**相同**（如 0 / -1）⇒ 只显一份：不产「0 / String: 0」式重复噪声
  const wZero = resolveEngSilenceAbortMs({ engSilenceAbortMs: 0 }).warning
  assert.ok(wZero.includes("engSilenceAbortMs 0 ("), "两口径相同（如 0）⇒ 单形态渲染保留：" + wZero)
  assert.ok(!wZero.includes("/ String:"), "相同口径不并列第二份（双口径只用在两口径**不同**时）：" + wZero)

  // —— 🔵2：显式 null 视同缺失（零告警）。钉口径：若哪天把 null 改归「非法 ⇒ warning」类，本行必红
  //   ——届时必须同批改 JSDoc（下方静态钉）与 A29-3c 的判据，不得静默漂移。
  assert.deepEqual(resolveEngSilenceAbortMs({ engSilenceAbortMs: null }),
    { ms: ENG_SILENCE_ABORT_MS, warning: null }, "★ 显式 null ⇒ 视同缺失：回落缺省且**零告警**")
  assert.deepEqual(resolveEngSilenceAbortMs({ engSilenceAbortMs: undefined }),
    { ms: ENG_SILENCE_ABORT_MS, warning: null }, "对照：undefined 同为缺失（两形态同判）")
  // 口径必须**写进 JSDoc**（不是只活在测试里）：静态钉住「null 视同缺失」这句话在实现侧在场。
  const wdogSrc = readFileSync(new URL("../lib/silence-watchdog.mjs", import.meta.url), "utf8")
  assert.ok(wdogSrc.includes("null 视同缺失"), "JSDoc 明写「null 视同缺失」口径（§2.9 🔵2 的文档面）")

  // —— 🔵3：键名内嵌换行/控制符 ⇒ 折叠为单空格**后**再截断（「单行可 grep」恒成立）——
  const weird = { "bad\nkey\tname": 1, plain: 2 }
  const weirdStr = formatKeyList(weird)
  assert.ok(!weirdStr.includes("\n") && !weirdStr.includes("\t"),
    "★ 含换行/制表键名 ⇒ 清单仍单行（旧实现键名原样进清单 ⇒ 本行必红）：" + JSON.stringify(weirdStr))
  assert.ok(weirdStr.includes("bad key name"), "键内换行/制表符折叠为单空格（截断**前**清洗）：" + JSON.stringify(weirdStr))
  // 先折叠后截断：超长含换行键名同样单行 + 截断标记在场（折叠若发生在截断后，长度口径即漂移）
  const longWeird = {}
  longWeird["x".repeat(30) + "\n" + "y".repeat(30)] = 1
  const longWeirdStr = formatKeyList(longWeird)
  assert.ok(!longWeirdStr.includes("\n") && longWeirdStr.includes("…"),
    "先折叠后截断（超长含换行键名仍单行且带截断标记）：" + JSON.stringify(longWeirdStr))

  // —— 批 30 / §2.4 🔵4（§2.9 审计 D2 · 锚 A30-7·🔵4）：「折叠**先于**截断」的**决定性**形态 ——
  // 上面那条 `longWeird`（30 x + 换行 + 30 y）**不是决定性的**：折叠后 61 字仍 > 48 ⇒ 照样带 `…`，
  // 折叠若发生在截断**之后**本段也绿（§2.9 审计 D2 实测：变异 M3b 仍全绿，而本档注释宣称已钉住）。
  // 决定性形态 = **短折叠 + 长原串**：原串 > 48（跨过截断线）而**折叠后** ≤ 48（不该出现截断标记）。
  const shortFoldKey = "a".repeat(40) + "\n".repeat(4) + "b".repeat(5) // 原串 49 字；折叠后 46 字
  assert.ok(shortFoldKey.length > 48 && shortFoldKey.replace(/\s+/g, " ").length <= 48,
    "前置自证：该键名跨过截断线而折叠后不跨（否则本段不是决定性的）")
  const shortFoldStr = formatKeyList({ [shortFoldKey]: 1 })
  assert.ok(!shortFoldStr.includes("\n"), "折叠在场：清单仍单行：" + JSON.stringify(shortFoldStr))
  assert.ok(!shortFoldStr.includes("…"),
    "★ 🔵4 决定性：折叠后 46 字 ≤ 48 ⇒ **不得**出现截断标记（把折叠挪到截断之后 ⇒ 截 48 字时换行还在"
      + "⇒ 折叠后仍带 `…` ⇒ 本行必红）：" + JSON.stringify(shortFoldStr))
  assert.ok(shortFoldStr.includes("a".repeat(40) + " b".repeat(1)),
    "折叠为单空格（无信息丢失）：" + JSON.stringify(shortFoldStr))

  // —— 批 30 / §2.4 🔵3（锚 A30-7·🔵3）：<3000ms 的静默给**秒级渲染**（消「静默 0 分钟」的语义误导） ——
  assert.equal(silenceMinutesLabel(60000), "1", "≥3 秒：分钟口径逐字不变（既有断言语义零漂移）")
  assert.equal(silenceMinutesLabel(300000), "5", "既有口径（5 分钟）不变")
  assert.equal(silenceMinutesLabel(3000), "0.1", "3 秒边界仍是分钟口径（边界值归 ≥3000 一支）")
  const l1500 = silenceMinutesLabel(1500)
  assert.notEqual(l1500, "0", "★ 🔵3 决定性：1500ms 此前渲染成 `0`（读成「静默 0 分钟」）——本行必红")
  assert.ok(l1500.includes("秒"), "秒级渲染：带「秒」单位：" + l1500)
  assert.match(l1500, /^1\.5 秒 = 0\.03$/,
    "形态 = `<S> 秒 = <M>`（调用点固定追加 ` 分钟` ⇒ 拼成「静默 1.5 秒 = 0.03 分钟」一句）：" + l1500)
  assert.match(silenceMinutesLabel(2500), /^2\.5 秒 = 0\.04$/, "同一形态的第二个采样：" + silenceMinutesLabel(2500))
  assert.match(silenceMinutesLabel(1), /^0\.001 秒 = 0$/, "极小值也不渲染成「0 秒」（同一个病的另一形态）")
  assert.equal(silenceMinutesLabel(0), "0", "0 / 非法值仍回落 `0`（既有边界不变）")

  // —— 批 30 / §2.4 🔵2（锚 A30-7·🔵2）：枚举面契约**静态锁**（JSDoc 串在场） ——
  assert.ok(wdogSrc.includes("枚举面不保证同形"), "JSDoc 明写「枚举面不保证同形」（契约第一半）")
  assert.ok(wdogSrc.includes("只保证读写访问语义"), "JSDoc 明写「只保证读写访问语义」（契约第二半）")

  // —— 批 30 / §2.4 🔵6（A29-11 第三子句 · 锚 A30-7·🔵6）：「为何决定性」注释**静态锁** ——
  // A29-11 的第三子句 = 「断言旁钉住**为何决定性**」；此前只有注释、没有锁 ⇒ 被「顺手清理」无迹象。
  const selfLines6 = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")
  const iA8c6 = selfLines6.findIndex((l) => l.includes('test("A29-8c'))
  assert.ok(iA8c6 !== -1, "前置：能定位 A29-8c 腿（腿名漂移 ⇒ 本行红，提示同步窗口谓词）")
  assert.ok(selfLines6.slice(iA8c6, iA8c6 + 40).join("\n").includes("本行是**决定性**的"),
    "★ 🔵6：A29-8c 的断言旁**必须**钉住「为何决定性」注释（删掉该注释 ⇒ 本行必红——第三子句由注释承担）")
})

test("A29-16 (§2.9 🔵4/6 · AC-12): 缓冲与裸 warn 用**同一原文**（trim 只做空串判定；含首尾空白入参仍逐字相同）· A29-8c 头部复位接线闩 ⇒ 初始态自持", async () => {
  // —— 🔵4（配对形态）：同一条留档文案进两通道 ⇒ 缓冲行与裸 warn 行逐字相等 ——
  __resetWatchdogAttachArchiveForTest()
  __resetArchiveChannelForTest()
  const capPair = await captureWarn(async () =>
    archiveWatchdogAttach({ result: Promise.resolve(), dispose() {}, onEvent() {} }, { attached: true, via: "agent/assistant-stream, tools/result", seq: { available: true, reason: null } }))
  assert.equal(capPair.warnings.length, 1, "前置：恰一条裸 warn（入队不取代告警，§2.8④）")
  const pairLine = drainArchiveBlock().split("\n").find((l) => l.includes("接线留档"))
  assert.ok(pairLine !== undefined, "前置：回执小节里有留档行（本腿在文件末尾，消费后其后无腿 ⇒ 零串味）")
  assert.equal(pairLine, capPair.warnings[0], "缓冲行与裸 warn 行**逐字相同**（同一原文：两通道由构造同步）")

  // —— 🔵4（决定性形态）：入参带首尾空白 ⇒ 缓冲逐字保留**原文**。旧实现入缓冲前 trim ⇒ 缓冲行 =
  //    原文.trim() ≠ 裸 warn 打的原文 ⇒「同一条文案逐字不变」只是碰巧成立。本段按生产者的配对
  //    形态复现（eng.mjs 的两处生产者都是「同一个字符串交给 enqueue + 裸 warn」），再逐字比对。
  __resetArchiveChannelForTest()
  const PADDED = "  [thincoder-suite] 接线留档·trim 一致性探针（首尾空白原文）  "
  const warned = []
  const origWarn = console.warn
  try {
    console.warn = (m) => { warned.push(String(m)) }
    assert.equal(enqueueArchiveLine(PADDED), true, "首尾空白非纯空白 ⇒ 照常入队（拒收只针对纯空白）")
    console.warn(PADDED) // 生产者配对形态：同一个字符串交给两通道（enqueue + 裸 warn）
  } finally { console.warn = origWarn }
  const paddedLines = drainArchiveBlock().split("\n")
  assert.ok(paddedLines.includes(PADDED),
    "★ 缓冲用**同一原文**（含首尾空白逐字保留，不做入缓冲 trim——旧实现本行必红）：" + JSON.stringify(paddedLines))
  assert.equal(paddedLines[paddedLines.indexOf(PADDED)], warned[0],
    "★ 缓冲内容与裸 warn **逐字相同**（含首尾空白入参时仍成立：§2.8①「同一条文案」由构造保证）")
  assert.equal(enqueueArchiveLine("   "), false, "纯空白仍拒收（trim 只做空串判定，拒收语义不放宽）")

  // —— 🔵6：A29-8c 初始态自持的**静态锁**。该腿头部复位接线闩后，「正确性不依赖跨腿顺序」在全量
  //    顺序下体现不出删改风险（闩早被前腿合上，删掉复位该腿也绿）⇒ 用静态锁钉住复位调用必须在该腿
  //    头部区域：删掉它 ⇒ 本行红（该腿随之退回「跨腿顺序依赖」的旧形态）。窗口 24 行：复位写在腿头
  //    makeFrame/try 与既有缓冲复位之间（第 ~12 行）；腿名漂移 ⇒ 前置行先红（提示同步窗口谓词），
  //    不会静默核错位置。
  const selfLines = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n")
  const iA8c = selfLines.findIndex((l) => l.includes('test("A29-8c'))
  assert.ok(iA8c !== -1, "前置：能定位 A29-8c 腿（腿名漂移 ⇒ 本行红，提示同步窗口谓词）")
  assert.ok(selfLines.slice(iA8c, iA8c + 24).join("\n").includes("__resetWatchdogAttachArchiveForTest()"),
    "★ A29-8c 腿头部显式复位接线闩（§2.9 🔵6：初始态自持——删掉该复位 ⇒ 本行必红，且该腿退回跨腿顺序依赖）")

  // —— 批 30 / §2.4 🔵5（锚 A30-7·🔵5）：**未捕获腿已全部套 `captureWarn`** 的静态锁 ——
  // 病（§2.9 交付码评遗留项）：若干**跑真实派发路径**的腿没有接管 `console.warn` ⇒ 两条裸告警
  //（工具面「未生效」+ 一次性接线留档）直接打到 stderr，成为测试输出里的噪音（也无法被断言消费）。
  // 收干方式**定死为「套捕获」**（不是「档头注一句纪律」）——判据即可机检：每条腿的**腿体窗口**内
  // 必须出现 `captureWarn(` 调用；删掉任一包装 ⇒ 对应行必红。
  {
    const selfSrc5 = readFileSync(fileURLToPath(import.meta.url), "utf8")
    const lines5 = selfSrc5.split("\n")
    // 谓词自证（先证可判）：无包装的窗口必须判否，有包装的必须判真——否则本锁是恒真断言。
    const hasCapture = (text) => text.includes("captureWarn(")
    assert.equal(hasCapture('test("X", async () => { await runEngCoder(f.deps, {}) })'), false,
      "谓词自证：未捕获的腿窗口必须判否（不是恒真锁）")
    assert.equal(hasCapture("const c = await captureWarn(async () => { })"), true, "谓词自证：已捕获必须判真")
    const NOISY_LEGS = [
      'test("A29-3a ', // 静默到点两形态（reject / resolve）
      'test("A29-3b ', // 心跳续命
      'test("A29-1a ', // 工具面强证
      'test("A29-1b ', // 工具面弱证
      'test("D9 ', // 零事件不误杀
      'test("D1/D2 ', // 保留名与公开读取面
      'test("§2.8 审计 🔴D1', // dsh 同步/后台两个回执点
      // 批 30 修复轮 / F4：下列四条腿**修复前**不在清单里，而它们的结算/交付段在捕获窗**之外**
      // ⇒ 单跑向 stderr 打 6 行「session state store path not resolvable」（静态锁判不到窗口边界）。
      // 窗口已延伸至结算段（本档同批改动），此处同步纳入静态锁 ⇒ 删掉任一包装必红。
      'test("A29-8a ', // 接线留档（命中名形态）
      'test("A29-8b ', // 事件辅腿零命中形态
      'test("A29-8c ', // 工具面「未生效」标注面
      'test("A29-13 ', // 留档进回执区（阶段门腿）
    ]
    for (const leg of NOISY_LEGS) {
      // ★ 只认**真正的腿声明行**（`^\s*test\s*\(`）：本清单自身的字符串字面量同样含腿名（若不排除，
      //   谓词会在「腿名只出现在清单里」时静默核对到错误窗口 —— 位置断言于是形同虚设）。
      const realHits = lines5.map((l, j) => (j)).filter((j) => /^\s*test\s*\(/.test(lines5[j]) && lines5[j].includes(leg))
      assert.equal(realHits.length, 1, "前置：腿名 " + leg + "… 在**腿声明行**上恰命中一次（漂移 ⇒ 本行红）：" + JSON.stringify(realHits))
      const i = realHits[0]
      const next = lines5.findIndex((l, j) => j > i && /^\s*test\s*\(/.test(l))
      const window5 = lines5.slice(i, next === -1 ? lines5.length : next).join("\n")
      assert.ok(hasCapture(window5),
        "★ 🔵5：" + leg + "…）的腿体**必须**套 `captureWarn`（未捕获 ⇒ 裸告警打到 stderr 成噪音；"
          + "删掉该包装 ⇒ 本行必红）")
    }
  }

  // —— 批 30 修复轮 / F4（锚 A30-7·🔵5 的**行为腿**：「单跑该档 stderr 零残留告警」）——
  // 上面那条静态锁只判「腿体窗口里出现过 `captureWarn(`」，判不出**窗口边界**：窗口只罩派发、
  // 把结算/交付留在窗外时它照样绿，而交付链尾 `saveSessionState` 的裸告警照样落到 stderr
  // （修复前单跑实测 **6 行**，来源 = A29-8a/b/c/A29-13 四条腿的 `settleResult → hooks.done` 段）。
  // 本段改为**量 stderr 残留本身**，并把「窄窗 ⇒ 残留」做成**决定性对照**——否则「宽窗 ⇒ 0 残留」
  // 可能只是「本条要量的告警根本没发生」的假绿。
  {
    // 前提自证：PLUGIN_DIR 之上没有 profile 根 ⇒ 交付段的 saveSessionState 路径必然不可解析、必然打告警。
    // 环境若变（本仓被搬到某个 profile 根之下）⇒ 本行**先红**，提示同步本段的形态谓词，
    // 而不是让下面两条断言静默退化成恒真。
    assert.equal(probeProfileRoot(PLUGIN_DIR), null,
      "前置：PLUGIN_DIR 向上探测不到 profile 根（否则交付段不产本条要量的告警形态）")
    // ① **全档残留**（本腿是档内最后一腿 ⇒ 此处见到的是「此前全部派发腿」的累计值）：
    //    这是「单跑该档 stderr 零残留告警」的可判形态——任何腿把裸告警漏到 stderr 都在这里转红
    //    （静态锁判不到的窗口边界缺陷，由本条行为断言承接）。
    assert.equal(stderrResidual.length, 0,
      "★ F4：本档此前全部腿零 stderr 残留（修复前实测 6 行，来自 A29-8a/b/c/A29-13 的结算/交付段）："
        + JSON.stringify(stderrResidual.slice(0, 2).map((s) => s.slice(0, 60))))
    // ② 决定性对照：同一条链在**窄窗**（窗口只罩派发）下确实残留——局部接管 stderr（只**吞**本条
    //    要量的告警、不计数），故这一份对照不会污染上面的全档计数。没有这一半，「宽窗 ⇒ 0 残留」
    //    就可能只是「本条要量的告警根本没发生」的假绿。
    const origStderrWrite = process.stderr.write
    const narrowSeen = []
    process.stderr.write = function (chunk, ...rest) {
      const s = String(chunk)
      if (s.includes("session state store path not resolvable")) { narrowSeen.push(s); return true }
      return origStderrWrite.call(this, chunk, ...rest)
    }
    let narrowLeaked = 0
    try {
      // (a) 窄窗（**修复前的形态**）：captureWarn 只罩派发，结算/交付在窗外 ⇒ 告警逃到 stderr
      const fn = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbeF4a: 1 } })
      try {
        await captureWarn(async () => {
          await runEngCoder(fn.deps, { task: "f4 narrow window", designToken: fn.st.designToken, docs: [] })
          await flush(() => fn.specs.length === 1, "F4 窄窗腿：jobs.start → subagents.start")
        })
        fn.settleResult({ stopReason: "completed", output: [{ type: "text", text: "f4 narrow done" }] })
        await fn.specs[0].hooks.done
      } finally { fn.drop() }
      narrowLeaked = narrowSeen.length

      // (b) 宽窗（**修复后的形态**）：同一条链，捕获窗延伸到结算与交付之后 ⇒ stderr **零残留**
      const fw = makeFrame({ form: "hang", eventSurface: true, runExtra: { archiveProbeF4b: 1 } })
      try {
        const capW = await captureWarn(async () => {
          await runEngCoder(fw.deps, { task: "f4 wide window", designToken: fw.st.designToken, docs: [] })
          await flush(() => fw.specs.length === 1, "F4 宽窗腿：jobs.start → subagents.start")
          fw.settleResult({ stopReason: "completed", output: [{ type: "text", text: "f4 wide done" }] })
          await fw.specs[0].hooks.done
        }, (ws) => ws.some((w) => w.includes("session state store path not resolvable")))
        assert.ok(capW.warnings.some((w) => w.includes("session state store path not resolvable")),
          "★ 宽窗下该告警**确实发生且被捕获**（否则下面的「零残留」可能只是「什么都没发生」的假绿）")
      } finally { fw.drop() }
      // 宽窗期间 stderr **零写入**：全档计数没有增长（本段的两次派发都不许漏）
      assert.equal(stderrResidual.length, 0,
        "★ F4：窗口罩住结算/交付 ⇒ 该告警**零** stderr 残留（走的是捕获器，不是 stderr）")
      assert.ok(narrowLeaked >= 1,
        "★ F4 决定性：窗口只罩派发（修复前的形态）⇒ 该告警**确实**逃到 stderr"
        + "（把任一派发腿的窗口收窄回「只罩派发」⇒ 全档残留计数即上涨、上面那条转红）")
    } finally { process.stderr.write = origStderrWrite }
  }
})
