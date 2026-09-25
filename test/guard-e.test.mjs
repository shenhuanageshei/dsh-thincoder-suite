// guard-e.test.mjs — 批 6b：守卫 E（在途窗口冻结 + 预闸拦截 + 结算侧指纹兜底）。
// 设计档：docs/2026-09-13-guard-e-design.md
//   §6 机制伪代码（§6.1 槽位载荷/捕获 · §6.2 finalize 漂移分支 · §6.3 预闸工厂 · §6.4 并排注册）
//   §8.2 机验锚 A1…A10 · §10.2 验收标准 AC-E1…AC-E21 · §9 边界
// 本档 = 本批**唯一**新增文件；既有测试档零修改（N-1）。
// 纪律：零网络、零真实 LLM（deps.llm.stream 桩 + 假 jobs 服务）、零长等待。
// 隔离：process.env.DSH_HOME 置空 → 一切落盘走 storPathOverride 临时目录；会话 id 用 randomUUID。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, unlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import {
  runAdvisorReview, designFreezeSet, setInFlightJob, clearInFlightJob, checkInFlightJob,
  designDocKey, designStrikes, advisorGenerationOf,
} from "../lib/advisor.mjs"
import { makeDocFreezeGate, makeWriteGate } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { resolveTokenStorePath } from "../lib/token-store.mjs"
import { resolveSessionStorePath } from "../lib/session-store.mjs"
import { computeDocHash, normalizeDocPath } from "../lib/doc-hash.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const ADVISOR_SRC = join(PLUGIN_DIR, "lib", "advisor.mjs")
const ENG_SRC = join(PLUGIN_DIR, "lib", "eng.mjs")
const INDEX_SRC = join(PLUGIN_DIR, "lib", "index.mjs")
/** 隔离契约（对齐既有测试档）：空串 = 显式无 env → 只走 override 临时目录。 */
process.env.DSH_HOME = ""

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-b6b-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
const newSid = (tag) => "b6b-" + tag + "-" + randomUUID()
const cleanSid = (sid) => { try { clearInFlightJob(sid, "advisor") } catch { /* noop */ } ; try { dropSession(sid) } catch { /* noop */ } }

/** 真实可读文档（铸造指纹要真读得到；预闸冻结集里放的就是这些归一路径）。 */
function makeDocs(home, files) {
  const dir = join(home, "docsrc")
  mkdirSync(dir, { recursive: true })
  const out = {}
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name)
    writeFileSync(p, content)
    out[name] = p
  }
  return out
}

/** advisor 用 agent stub；depth 用于「子代理会话」形态（AC-E2）。 */
function makeAgent(id, depth = 0) {
  return {
    session: { id, header: { cwd: PLUGIN_DIR, delegationDepth: depth }, deriveMessages: () => [] },
    options: { provider: "p", model: "m" },
  }
}

/** 假 jobs 服务（平台契约：start(spec) → branded string；spec.run() → { cancel, done }）。 */
function fakeJobs() {
  const specs = []
  return {
    specs,
    service: {
      start(p) {
        const hooks = p.run()
        const id = (p.kind ?? "job") + "-" + (specs.length + 1)
        specs.push({ payload: p, hooks, id })
        return id
      },
    },
  }
}
const jobsCtx = (service) => ({ get: (n) => (n === "jobs" ? service : null) })

/** 通过型 design 评审 stub：回显提示词里的批准码（触发签发路径）。 */
function approvingLlm() {
  const calls = []
  return {
    calls,
    stream(opts) {
      calls.push(opts)
      const userText = opts?.messages?.[0]?.content?.[0]?.text ?? ""
      const m = userText.match(/\[APPROVE:([0-9a-f]{8})\]/)
      const code = m ? m[1] : "00000000"
      const echo = "The design is approved with no unresolved Critical issues.\n\n[APPROVE:" + code + "]"
      return (async function* () {
        yield { type: "block-end", block: { type: "text", text: echo } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
}

/** 同上，但流在 release() 之前**挂起**——给测试制造「dispatch 后 / settle 前」的真窗口
 *（哨兵的整个意义就在这一段：不挂起就无从在窗口内改文件）。 */
function gatedApprovingLlm() {
  let release = null
  const gate = new Promise((r) => { release = r })
  const calls = []
  return {
    calls,
    release: () => release(),
    stream(opts) {
      calls.push(opts)
      const userText = opts?.messages?.[0]?.content?.[0]?.text ?? ""
      const m = userText.match(/\[APPROVE:([0-9a-f]{8})\]/)
      const code = m ? m[1] : "00000000"
      const echo = "The design is approved with no unresolved Critical issues.\n\n[APPROVE:" + code + "]"
      return (async function* () {
        await gate
        yield { type: "block-end", block: { type: "text", text: echo } }
        yield { type: "finish", reason: { kind: "stop" } }
      })()
    },
  }
}

/** 兜底超时用：挂起直到 signal abort（不遗留真实定时器）。 */
function hangingLlm() {
  const calls = []
  return {
    calls,
    stream(opts) {
      calls.push(opts)
      return (async function* () {
        await new Promise((_res, rej) => {
          const sig = opts?.signal
          const die = () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))
          if (sig?.aborted) return die()
          sig?.addEventListener?.("abort", die, { once: true })
        })
      })()
    },
  }
}

/** dsh 主路径 + 后台派发（timeoutMs 600000 > budgetCap 5000 ⇒ 走 jobs；窗口因此真开）。 */
const dsCfg = (extra = {}) => ({
  codexCli: { budgetCapMs: 5000 },
  advisor: {
    round1: { provider: "p", model: "m", timeoutMs: 600000 },
    convergence: { provider: "p", model: "m", timeoutMs: 600000 },
  },
  ...extra,
})
/** 同步路径（≤cap，无窗口——§9 边界 1）。 */
const syncCfg = (extra = {}) => ({
  codexCli: { budgetCapMs: 5000 },
  advisor: { round1: { provider: "p", model: "m", timeoutMs: 3000 } },
  ...extra,
})

const callDesign = (deps, agent, docs, home, config = syncCfg()) =>
  runAdvisorReview(deps, { agent, config, reviewType: "design", documents: docs, storPathOverride: home })

/** 开一个**真窗口**：派发 design 后台评审（job 内流挂起 ⇒ 窗口保持打开）。 */
async function openWindow(home, sid, docs, { depth = 0, config = dsCfg() } = {}) {
  const { specs, service } = fakeJobs()
  const g = gatedApprovingLlm()
  const agent = makeAgent(sid, depth)
  const reply = await runAdvisorReview({ llm: g, ctx: jobsCtx(service) },
    { agent, config, reviewType: "design", documents: docs, storPathOverride: home })
  return { specs, g, agent, reply }
}

const ALLOW = Object.freeze({ kind: "next" })
/** 跑一次门禁：返回 { res, allowed }（allowed = 走了 next()）。 */
async function runGate(gate, name, args, agent = undefined) {
  let allowed = false
  const next = async () => { allowed = true; return ALLOW }
  const res = await gate({ name, arguments: args, agent }, next)
  return { res, allowed }
}
const freezeGateNow = () => makeDocFreezeGate(() => designFreezeSet())

function tokenRec(home, sid) {
  const p = resolveTokenStorePath(home)
  if (!p || !existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf8")).tokens?.[sid] ?? null
}
function tokenStoreExists(home) {
  const p = resolveTokenStorePath(home)
  return Boolean(p && existsSync(p))
}
function stateEntry(home, sid) {
  const p = resolveSessionStorePath(home)
  if (!p || !existsSync(p)) return null
  return JSON.parse(readFileSync(p, "utf8")).sessions?.[sid] ?? null
}

const sliceBetween = (src, startMarker, endMarker) => {
  const i = src.indexOf(startMarker)
  assert.ok(i >= 0, "start marker present: " + startMarker)
  const j = src.indexOf(endMarker, i)
  assert.ok(j > i, "end marker present after start: " + endMarker)
  return src.slice(i, j)
}

/** 剥离块注释与行注释（锚计数用：注释里引述的字面不算实现）。
 *  ★ 批 12 收窄自述：原本写「本仓 lib 无该形态」——升格为 A2 的**等值参与者**后，该声明
 *    **承重等值正确性** ⇒ 收窄为「**本切片无该形态**」，并由 A2 的域自检机械守住
 *    （`!rawSlice.includes("/*")`）。实现**逐字节未动**（它同时承 T-E18 的
 *    `"denied: / frozen: ` 计数与 A8 的负向断言）。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1")

/** 归一化到「可执行行」：**先把四个行终止符统一为 `\n`** → 剥离器（其实现零改）→
 *  逐行 `rtrim` → 丢空行 → join("\n")。
 *  ★ **为什么必须先统一行终止符**（设计档 §13.2.0 的 🔴#1 —— **复评 #2 订正**：此处初写「§14.1」，而本档设计止于 §13，该指针悬空；**这正是本批主题「指针陈旧性」的病，出现在本批自己的交付里**）：
 *    `stripComments` 的行注释规则是 `(^|[^:])\/\/[^\n]*` —— 它**只认 LF**；而 JS 的
 *    **LineTerminator 是 LF | CR | U+2028 | U+2029**。于是 `//` 之后插入
 *    **CR / U+2028 / U+2029** 时：**解析器认为注释在其处结束（后面是真代码）**，而
 *    **剥离器把那一行整段吃掉** ⇒ **代码在锁眼里消失，而 A2 全组保持绿**。父侧实测：
 *    该形态下 `normalizeExec(变异切片) === 夹具` 为 **true**，且编译后的门禁**真的变成
 *    fail-open**（走 `next()`）。⇒ **收窄前的逐字节锁对任何字节改动都红 ⇒ 这个缝是本批
 *    引入的**（不是继承来的）。
 *  ★ **行终止符的归一不削弱锁**：可执行行**之内**的 `\r` / LS / PS 在此先变成 `\n` ⇒
 *    它们**仍留在（归一后的）行内**，仍被逐字节锁住 ⇒ **不产生任何新的假绿面**；它们唯一
 *    失去的是「作为行终止符的种类」这一维 —— 而那正是上面那个缝的所在。
 *  ★ **语义边界**（批 12）：锁的是**可执行行的字节与顺序**；注释层（文字 / 位置 / 行数 /
 *    缩进）自由 —— **两个例外**：① **切片内新增 `/*`** ⇒ 域自检红；② **改右界标记
 *    （`WG_END`）的注释文字** ⇒ 边界断言红（并连带 `path-kind` 的 T-PK8，两处共用该标记）。
 *  ★ **顺序承重**：调用方**必须先在原始源码上切片**，再把切片交给本函数。右界标记
 *    （`WG_END`）**本身就是一条注释** ⇒ 先剥离再切片会让 `indexOf(标记)` 恒为 -1，
 *    整个锚当场死掉（防这条退化路径的断言 = A2 的「顺序锁」）。
 *  ★ **域前提**：切片内不得含 `/*`（本函数按**行局部**剥离；块注释跨行吞并会让
 *    「逐行」这个前提失效）。该前提由 A2 的域自检机械守住。
 *  ★ **不归一什么**：token 间空白**不归一**（空白在 JS 里**承重**：`a+ +b` ≠ `a++b`；
 *    `return\nx` 有 ASI 语义 ⇒ 朴素空白归一 = **制造假绿逃逸面**）。**行尾风格**（LF vs CRLF）
 *    在**切片内**因此不再致红 —— 这是统一行终止符的**接受代价，明确登记**（设计档 D12-3）；
 *    整片（含右界标记本身）改成 CRLF 仍会在**边界断言**处红，因为标记文本被改写。 */
const LINE_TERMINATORS = /\r\n?|[\u2028\u2029]/g
const normalizeExec = (src) => stripComments(src.replace(LINE_TERMINATORS, "\n"))
  .split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l !== "").join("\n")

// ═══════════════════════════ 预闸行为面（AC-E1…AC-E8 / AC-E10 / AC-E14） ═══════════════════════════

test("T-E1 (AC-E1): 真派发 design 评审 → 窗口内写冻结集内路径被 deny，理由含 jobId/归一路径/job_kill/settle 自释放四要素", async () => {
  const home = mkHome()
  const sid = newSid("ace1")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, g, reply } = await openWindow(home, sid, [docA])
    assert.match(reply, /started as background job advisor-dsh-1/, "评审真派发为后台 job：" + reply.slice(0, 120))
    assert.equal(specs.length, 1)

    const { res, allowed } = await runGate(freezeGateNow(), "write", { file_path: docA })
    assert.equal(allowed, false, "窗口内写冻结文档**不得**放行")
    assert.equal(res.kind, "deny", "返回 deny")
    const r = res.reason
    assert.ok(r.startsWith("frozen: "), "前缀恰为 frozen: （D-E13）：" + r.slice(0, 40))
    assert.ok(r.includes("advisor-dsh-1"), "① 在飞 job id")
    assert.ok(r.includes("Target: " + normalizeDocPath(docA)), "② 归一后目标路径")
    assert.ok(r.includes("- " + normalizeDocPath(docA)), "② 归一后冻结集（供排查）")
    assert.ok(r.includes("job_kill advisor-dsh-1"), "④ job_kill 逃生门（含真实 job id）")
    assert.ok(r.includes("the slot releases on settle"), "③ settle 自释放说明")

    // 另一条路径同样被拦（edit = WRITE_TOOLS 第二员），且窗口在两次调用后依然打开
    const edit = await runGate(freezeGateNow(), "edit", { file_path: docA })
    assert.equal(edit.res.kind, "deny", "edit 同样被拦")
    assert.equal(designFreezeSet()?.jobIds[0], "advisor-dsh-1", "窗口未因工具调用而改变")
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E2 (AC-E2): 子代理会话（delegationDepth=1）写冻结文档 → 预闸仍 deny；写门禁的 depth 豁免是刻意的不对称", async () => {
  const home = mkHome()
  const sid = newSid("ace2")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    const subAgent = { session: { id: sid + "-sub", header: { delegationDepth: 1, cwd: PLUGIN_DIR } } }

    const { res, allowed } = await runGate(freezeGateNow(), "write", { file_path: docA }, subAgent)
    assert.equal(allowed, false, "全深度拦截（D-E5）")
    assert.equal(res.kind, "deny")
    assert.ok(res.reason.includes("job_kill advisor-dsh-1"), "子代理收到的逃生门同样指向真实 job")

    // 对照：写门禁在 depth>0 时放行（同一次「产品代码」写，depth 0 时则 deny）——两闸方向相反
    const st = sessionState(sid)
    st.engineering = true
    st.designToken = null
    const wg = makeWriteGate(() => true)
    const sub = await runGate(wg, "write", { file_path: join(PLUGIN_DIR, "lib", "eng.mjs") }, subAgent)
    assert.equal(sub.allowed, true, "写门禁：depth>0 豁免（sanctioned 实现者）")
    const main = await runGate(wg, "write", { file_path: join(PLUGIN_DIR, "lib", "eng.mjs") }, makeAgent(sid, 0))
    assert.equal(main.res?.kind, "deny", "写门禁：depth 0 且无令牌 → deny（对照组）")
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E3 (AC-E3): 窗口内写非冻结路径（别的文档 / 产品代码）→ 放行", async () => {
  const home = mkHome()
  const sid = newSid("ace3")
  const docs = makeDocs(home, { "a.md": "# A\n", "b.md": "# B\n" })
  try {
    const { specs, g } = await openWindow(home, sid, [docs["a.md"]])
    const other = await runGate(freezeGateNow(), "write", { file_path: docs["b.md"] })
    assert.equal(other.allowed, true, "另一份文档不在冻结集 → 放行")
    const code = await runGate(freezeGateNow(), "edit", { file_path: join(PLUGIN_DIR, "lib", "advisor.mjs") })
    assert.equal(code.allowed, true, "产品代码 → 放行（两闸拒域不同）")
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E4 (AC-E4): 无在飞窗口 → 任意 write/edit 一律放行（惰性）", async () => {
  const home = mkHome()
  const sid = newSid("ace4")
  try {
    assert.equal(designFreezeSet(), null, "无窗口 ⇒ 访问器返回 null")
    const gate = freezeGateNow()
    for (const args of [{ file_path: "docs/x.md" }, { file_path: join(PLUGIN_DIR, "lib", "eng.mjs") }, { path: "docs/y.md" }]) {
      const r = await runGate(gate, "write", args)
      assert.equal(r.allowed, true, "无窗口 = 惰性：" + JSON.stringify(args))
    }
    assert.equal((await runGate(gate, "edit", { file_path: "docs/x.md" })).allowed, true)
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E5 (AC-E5 / §9 边界 5): 窗口内 bash/pwsh/run_code/file_ops 一律放行（不触发预闸）", async () => {
  const home = mkHome()
  const sid = newSid("ace5")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    const gate = freezeGateNow()
    for (const name of ["bash", "pwsh", "run_code", "file_ops", "read", "grep"]) {
      const r = await runGate(gate, name, { file_path: docA, command: "echo hi > " + docA })
      assert.equal(r.allowed, true, name + " 不属 {write,edit} ⇒ 名字门先于一切判定即返回")
    }
    // 窗口仍开着（上面对非写工具零影响）
    assert.equal(designFreezeSet()?.jobIds.length, 1, "窗口未被非写工具调用改变")
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E6 (AC-E6 / §9 边界 3-4): reviewType=code 与 escalate/eng 槽位在飞 → 不武装", async () => {
  const home = mkHome()
  const sid = newSid("ace6")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    setInFlightJob(sid, "advisor", "job-code-1", { reviewType: "code", docSet: [] })
    assert.equal(designFreezeSet(), null, "code 槽位不武装（docSet 空）")
    assert.equal((await runGate(freezeGateNow(), "write", { file_path: docA })).allowed, true, "code 评审期间其 documents 可写")
    clearInFlightJob(sid, "advisor")

    // 即便 code 槽位误带了 docSet，reviewType 不是 design 仍不武装（谓词两半都要）
    setInFlightJob(sid, "advisor", "job-code-2", { reviewType: "code", docSet: [normalizeDocPath(docA)] })
    assert.equal(designFreezeSet(), null, "reviewType !== 'design' ⇒ 跳过")
    clearInFlightJob(sid, "advisor")

    // escalate / eng 既有三参调用形态（payload 缺省 {}）→ reviewType null → 永不武装
    setInFlightJob(sid, "escalate", "esc-1")
    setInFlightJob(sid, "eng", "eng-1")
    assert.equal(designFreezeSet(), null, "escalate/eng 槽位永不武装（三参兼容形态）")
    assert.equal((await runGate(freezeGateNow(), "write", { file_path: docA })).allowed, true)
    clearInFlightJob(sid, "escalate")
    clearInFlightJob(sid, "eng")
    assert.equal(checkInFlightJob(sid, "escalate"), null, "既有三参调用点语义零改（槽位照常登记/清除）")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E22 (F1① / D-E3 / 纪要 §4 栽点 3): 槽位载荷 docSet = **登记时刻的快照拷贝**——登记后改动调用方数组不改变冻结集", () => {
  const home = mkHome()
  const sid = newSid("acef1a")
  const docs = makeDocs(home, { "a.md": "# A\n", "b.md": "# B\n" })
  const a = normalizeDocPath(docs["a.md"])
  const b = normalizeDocPath(docs["b.md"])
  try {
    const arr = [a]
    setInFlightJob(sid, "advisor", "job-f1-copy", { reviewType: "design", docSet: arr })
    const reg = designFreezeSet()
    assert.ok(reg, "design 槽位 + 非空 docSet ⇒ 武装（前提）")
    assert.deepEqual(reg.docSet, [a], "冻结集 = 登记时传入的集合")

    arr.push(b) // 别名（未拷贝）会让这一步渗进冻结集：槽位必须不持有活引用（D-E3）
    const after = designFreezeSet()
    assert.equal(after.docSet.length, reg.docSet.length,
      "登记后 push 调用方数组 ⇒ 冻结集长度不变（`.slice()` 拷贝；实得 " + after.docSet.length + "）")
    assert.ok(!after.docSet.includes(b),
      "新增元素**不**渗入冻结集（删掉 `.slice()` 即持有活引用）：" + JSON.stringify(after.docSet))
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E23 (F1② / §9 边界 2): design 槽位 docSet=[] ⇒ 预闸**不武装**；write/edit 任意目标一律放行", async () => {
  const home = mkHome()
  const sid = newSid("acef1b")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    setInFlightJob(sid, "advisor", "job-f1-empty", { reviewType: "design", docSet: [] })
    assert.ok(checkInFlightJob(sid, "advisor"), "前提：design 槽位**确实**登记在飞（不是「压根没有槽位」）")
    assert.equal(designFreezeSet(), null,
      "docSet=[] ⇒ 该槽位不武装（§9 边界 2 的真空豁免——空文档集评审不得被冻结，否则永远签不出）")

    // 不武装 ⇒ 该形态下 **连不可解析的目标也放行**（武装窗口内它是 fail-closed 的 deny）
    const gate = freezeGateNow()
    for (const name of ["write", "edit"]) {
      for (const args of [{ file_path: docA }, { file_path: join(PLUGIN_DIR, "lib", "eng.mjs") }, {}]) {
        const r = await runGate(gate, name, args)
        assert.equal(r.allowed, true, "不武装 ⇒ " + name + " 一律 next()：" + JSON.stringify(args))
      }
    }
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E7 (AC-E7): 窗口内目标不可解析（无 file_path/path）→ deny（fail-closed）", async () => {
  const home = mkHome()
  const sid = newSid("ace7")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  try {
    const { specs, g } = await openWindow(home, sid, [docs["a.md"]])
    for (const args of [{}, { content: "x" }, { file_path: 42 }, { path: null }]) {
      const { res, allowed } = await runGate(freezeGateNow(), "edit", args)
      assert.equal(allowed, false, "无法证明目标在冻结集之外 ⇒ 按在其中处理：" + JSON.stringify(args))
      assert.equal(res.kind, "deny")
      assert.ok(res.reason.startsWith("frozen: ") && res.reason.includes("unresolvable target"), "文案标明原因")
    }
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E8 (AC-E8 / N-4): 判定区抛异常且窗口已确认 → deny；注册表读取故障且窗口未确认 → 放行 + warn", async () => {
  const home = mkHome()
  const sid = newSid("ace8")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  const warms = []
  const origWarn = console.warn
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    // ① 判定区（try 内）抛异常：arguments 的属性访问即抛
    const boomArgs = new Proxy({}, { get() { throw new Error("boom-target") } })
    const { res, allowed } = await runGate(freezeGateNow(), "write", boomArgs)
    assert.equal(allowed, false, "已确认窗口内判定故障 ⇒ fail-closed")
    assert.equal(res.kind, "deny")
    assert.ok(res.reason.includes("gate internal error: boom-target"), "文案标明内部错误：" + res.reason.split("\n")[0])
    g.release()
    await specs[0].hooks.done

    // ② 注册表读取故障（窗口判定区在 try 之外）⇒ 窗口未确认 ⇒ 放行，但**必须 warn**
    console.warn = (...a) => { warms.push(a.join(" ")) }
    const broken = makeDocFreezeGate(() => { throw new Error("registry down") })
    const r2 = await runGate(broken, "write", { file_path: docA })
    assert.equal(r2.allowed, true, "窗口未确认时无可护之物 ⇒ next()")
    assert.ok(warms.some(w => w.includes("守卫 E 预闸") && w.includes("registry down")), "放行必须留痕（禁静默 fail-open）：" + JSON.stringify(warms))
    // 非写工具在注册表故障下同样零成本返回（名字门先于扫描）
    const r3 = await runGate(broken, "bash", { command: "ls" })
    assert.equal(r3.allowed, true)
    assert.equal(warms.filter(w => w.includes("守卫 E 预闸")).length, 1, "名字门先于扫描 ⇒ bash 未触发第二次访问器调用")
  } finally { console.warn = origWarn; cleanSid(sid); rmHome(home) }
})

test("T-E10 (AC-E10): 逃生门真实：job_kill（cancel → abort → reject 处理器）后槽位释放，同一写由 deny 转放行", async () => {
  const home = mkHome()
  const sid = newSid("ace10")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, service } = fakeJobs()
    const llm = hangingLlm() // 挂到 abort——窗口必须靠 settle 关闭
    const reply = await runAdvisorReview({ llm, ctx: jobsCtx(service) },
      { agent: makeAgent(sid), config: dsCfg(), reviewType: "design", documents: [docA], storPathOverride: home })
    assert.match(reply, /started as background job/)
    assert.equal((await runGate(freezeGateNow(), "write", { file_path: docA })).res.kind, "deny", "窗口开启中")

    specs[0].hooks.cancel("killed by host") // 宿主 job_kill
    const outcome = await specs[0].hooks.done
    assert.equal(outcome.status, "failed", "被 kill 的 job 以失败收场：" + outcome.status)
    assert.equal(designFreezeSet(), null, "settle 后槽位释放（窗口关闭）")
    const after = await runGate(freezeGateNow(), "write", { file_path: docA })
    assert.equal(after.allowed, true, "同一写由 deny 转为放行——逃生门是真的")
    assert.equal(checkInFlightJob(sid, "advisor"), null, "单飞槽位同步释放")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E14 (AC-E14 / N-5): 标准模式（eng OFF）下窗口内写冻结集 → 仍 deny（预闸不查 engEffective）", async () => {
  const home = mkHome()
  const sid = newSid("ace14")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    const st = sessionState(sid)
    st.engineering = false // 标准模式显式关掉
    const { res, allowed } = await runGate(freezeGateNow(), "write", { file_path: docA })
    assert.equal(allowed, false, "窗口完整性不变式与主代理模式无关（D-E12）")
    assert.equal(res.kind, "deny")
    // 对照组：同一模式设置下写门禁放行（它才是查模式的那一闸）。
    // 必须传**带 session 的 agent**：否则 `makeWriteGate` 在 `if (!agent?.session) return await next()`
    // 就返回了，这条对照的通过原因与 eng 模式无关（空洞断言——修于批 6b 分歧审计 F2）。
    st.designToken = null
    const wg = await runGate(makeWriteGate(() => false), "write",
      { file_path: join(PLUGIN_DIR, "lib", "eng.mjs") }, makeAgent(sid, 0))
    assert.equal(wg.allowed, true, "eng OFF ⇒ 写门禁放行（对照：真走到 engEffective 判定后由模式放行）")
    g.release()
    await specs[0].hooks.done
  } finally { cleanSid(sid); rmHome(home) }
})

// ═══════════════════════════ 结算侧兜底面（AC-E9 / E11 / E12 / E15 / E16 / E20） ═══════════════════════════

test("T-E9 (AC-E9, F17 闭合): PASS + 回显 + 铸造后改动冻结文档 → 不签发，返回漂移诊断四元", async () => {
  const home = mkHome()
  const sid = newSid("ace9")
  const docs = makeDocs(home, { "a.md": "# A original\n" })
  const docA = docs["a.md"]
  const warms = []
  const origWarn = console.warn
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    const st = sessionState(sid)
    assert.equal(typeof st.pendingDocHash, "string", "铸造快照已就位（前提）")

    writeFileSync(docA, "# A EDITED while the review was in flight\n") // 带外改动（预闸覆盖不到的面）
    console.warn = (...a) => { warms.push(a.join(" ")) }
    g.release()
    const outcome = await specs[0].hooks.done
    const out = outcome.output

    assert.equal(st.designToken, null, "**不签发**：state.designToken 未写")
    assert.equal(tokenStoreExists(home), false, "**不签发**：saveTokenRecord 零调用（落盘文件都不存在）")
    assert.ok(!out.includes("Approved."), "返回不含签发文案")
    assert.ok(out.includes("guard E: the reviewed document set changed while the review was in flight"), "① 不签发声明")
    assert.ok(out.includes("is NOT revoked"), "② 不撤销既有令牌声明")
    assert.ok(out.includes("does NOT count against the settlement guard"), "③ 不计振声明")
    assert.ok(out.includes("re-issue advisor(type='design') for a full re-review"), "④ 出路")
    assert.ok(!/\[APPROVE:[0-9a-f]{8}\]/.test(out), "漂移路径剥离批准码回显（D-E15）")
    assert.ok(out.includes("The design is approved"), "评审正文仍带回（可读）")
    assert.ok(warms.some(w => w.includes("守卫 E：签发前文档集指纹失配")), "console.warn 留痕：" + JSON.stringify(warms))
  } finally { console.warn = origWarn; cleanSid(sid); rmHome(home) }
})

test("T-E11 (AC-E11 / D-E14): 铸造后**删除**一份冻结文档 → 同失配，且诊断含 missing 清单", async () => {
  const home = mkHome()
  const sid = newSid("ace11")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    unlinkSync(docA) // 重算 → ok:false
    g.release()
    const out = (await specs[0].hooks.done).output
    assert.equal(sessionState(sid).designToken, null, "读不到 = 漂移（fail-closed，与 doc-hash N3 同向）")
    assert.equal(tokenStoreExists(home), false, "零签发")
    assert.ok(out.includes("Unreadable (deleted / renamed / permission):"), "missing 清单标题")
    assert.ok(out.includes("- " + normalizeDocPath(docA)), "missing 清单列出归一路径：" + normalizeDocPath(docA))
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E12 (AC-E12, 零回归): 文档未动 → 签发路径与今日等价；saveTokenRecord 收到捕获值", async () => {
  const home = mkHome()
  const sid = newSid("ace12")
  const docs = makeDocs(home, { "a.md": "# A stable\n", "b.md": "# B stable\n" })
  const list = [docs["a.md"], docs["b.md"]]
  try {
    const { specs, g } = await openWindow(home, sid, list)
    g.release()
    const out = (await specs[0].hooks.done).output
    assert.ok(out.includes("Approved. Pass this exact token to eng_coder (designToken parameter): "), "签发文案照旧")
    const issued = out.match(/designToken parameter\): (\S+)/)[1]
    assert.equal(sessionState(sid).designToken, issued, "内存令牌写入")
    assert.ok(out.includes("有效至 "), "TTL 展示照旧")

    const rec = tokenRec(home, sid)
    const expected = computeDocHash(list)
    assert.ok(rec, "落盘记录存在")
    assert.equal(rec.token, issued)
    assert.equal(rec.docHash, expected.hash, "喂料 = 捕获指纹（与铸造值等值）")
    assert.deepEqual(rec.docPaths, expected.docPaths, "喂料 = 捕获路径表（归一并排序）")
    assert.ok(!out.includes("guard E:"), "未漂移 ⇒ 不进漂移分支")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E12b (D-E6 行为证明): 漂移基准是**闭包捕获**值——窗口内改活 state.pendingDoc* 不改变判定", async () => {
  const home = mkHome()
  const sid = newSid("ace12b")
  const docs = makeDocs(home, { "a.md": "# A\n", "z.md": "# Z\n" })
  const [docA, docZ] = [docs["a.md"], docs["z.md"]]
  try {
    const { specs, g } = await openWindow(home, sid, [docA])
    const st = sessionState(sid)
    // 模拟「将来有人在窗口内加了第二个写点」：活 state 被改成别的文档集，但**捕获值不动**。
    // 读活版会把 fresh 算成 [Z] 而与 pendingDocHash（仍是 [A] 的指纹）失配 → 假漂移；
    // 捕获版只认铸造快照，A 本身没变 ⇒ 正常签发。
    const origHash = st.pendingDocHash
    st.pendingDocPaths = [normalizeDocPath(docZ)]
    g.release()
    const out = (await specs[0].hooks.done).output
    assert.ok(out.includes("Approved."), "基准是捕获值 ⇒ 不产生假漂移，照常签发")
    assert.ok(!out.includes("guard E:"), "未进漂移分支")
    assert.equal(st.pendingDocHash, origHash, "活 state 未参与判定（值原样）")
    const rec = tokenRec(home, sid)
    assert.deepEqual(rec.docPaths, computeDocHash([docA]).docPaths, "落盘的是捕获集合（不是被改过的活 state）")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E13 (AC-E13 / 锚 A8): 漂移后重跑 design 正常签发；且漂移轮**不消耗**三振（designStrikes 不变）", async () => {
  const home = mkHome()
  const sid = newSid("ace13")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  const docKey = designDocKey([docA])
  try {
    // 前置：先制造 1 振（评审未通过），使「漂移是否吃掉一振 / 是否被误复位」可判别
    const failing = {
      calls: [],
      stream(opts) {
        this.calls.push(opts)
        return (async function* () {
          yield { type: "block-end", block: { type: "text", text: "I could not complete this review." } }
          yield { type: "finish", reason: { kind: "stop" } }
        })()
      },
    }
    await callDesign({ llm: failing }, makeAgent(sid), [docA], home)
    assert.equal(designStrikes(sid, docKey), 1, "前置：一振就位")

    // 漂移轮
    const { specs, g } = await openWindow(home, sid, [docA])
    writeFileSync(docA, "# A drifted\n")
    g.release()
    const driftOut = (await specs[0].hooks.done).output
    assert.ok(driftOut.includes("guard E:"), "确为漂移轮")
    assert.equal(designStrikes(sid, docKey), 1, "漂移对 recordDesignSettlement 零调用（既 +1 也不复位）——落入计振尾会在此变 0")

    // 漂移被吸收：按当前内容重铸指纹 → 正常签发
    const { specs: specs2, g: g2 } = await openWindow(home, sid, [docA])
    g2.release()
    const okOut = (await specs2[0].hooks.done).output
    assert.ok(okOut.includes("Approved."), "重跑按当前内容铸造并正常签发（无永久损伤）：" + okOut.slice(0, 160))
    assert.equal(tokenRec(home, sid).docHash, computeDocHash([docA]).hash, "指纹 = 当前内容")
    assert.equal(designStrikes(sid, docKey), 0, "签发成功（落盘成功）复位该键")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E15 (AC-E15, D-E9): 漂移分支后 advisorRound=0 / lastAdvisorOutput=null 且**已落盘**（对照组证明是「复位」而非「未推进」）", async () => {
  const home = mkHome()
  const sidCtl = newSid("ace15ctl")
  const sid = newSid("ace15")
  const docs = makeDocs(home, { "a.md": "# A\n" })
  const docA = docs["a.md"]
  const seed = (sid2) => {
    const st = sessionState(sid2)
    st.advisorRound = 2
    st.lastAdvisorOutput = "| # | Issue |\n|---|---|\n| 1 | stale prior |\n"
    st.lastReviewType = "design"
    return st
  }
  try {
    // 对照组：同样从 round 2 起，**未漂移** → finalize 照常 +1（证明推进发生在 finalize，不是派发点）
    const stCtl = seed(sidCtl)
    const ctl = await openWindow(home, sidCtl, [docA])
    assert.equal(stCtl.advisorRound, 2, "派发点不推进轮次（对照）")
    ctl.g.release()
    await ctl.specs[0].hooks.done
    assert.equal(stCtl.advisorRound, 3, "未漂移 ⇒ 照常 +1（对照组）")

    // 漂移轮：同起点 → 复位到 0，且清 prior + 落盘
    const st = seed(sid)
    const { specs, g } = await openWindow(home, sid, [docA])
    assert.equal(st.advisorRound, 2, "派发点不推进轮次（漂移轮同样）")
    writeFileSync(docA, "# A drifted\n")
    g.release()
    await specs[0].hooks.done

    assert.equal(st.advisorRound, 0, "漂移 ⇒ 复位轮次（对照组的 2→3 证明这不是「压根没推进」）")
    assert.equal(st.lastAdvisorOutput, null, "漂移 ⇒ 清 prior（已失效内容不得进下轮）")
    const persisted = stateEntry(home, sid)
    assert.ok(persisted, "落盘条目存在")
    assert.equal(persisted.advisorRound, 0, "复位**已落盘**（重启后不复活收敛轮）")
    assert.equal(persisted.lastAdvisorOutput, null, "prior 清空已落盘")
    assert.equal(advisorGenerationOf(st), 0, "代际**不** +1（D-E9：不弃置无关机制的在飞结果）")
    assert.equal(persisted.advisorGeneration, 0, "落盘代际同样仍为 0")
  } finally { cleanSid(sidCtl); cleanSid(sid); rmHome(home) }
})

test("T-E16 (AC-E16, D-E10): 漂移**不撤销**既有令牌——内存态与磁盘记录原样存活", async () => {
  const home = mkHome()
  const sid = newSid("ace16")
  const docs = makeDocs(home, { "a.md": "# A v1\n" })
  const docA = docs["a.md"]
  try {
    // 第一轮：干净签发
    const { specs: s1, g: g1 } = await openWindow(home, sid, [docA])
    g1.release()
    const out1 = (await s1[0].hooks.done).output
    assert.ok(out1.includes("Approved."), "前置：先签发一枚")
    const issued = sessionState(sid).designToken
    const recBefore = JSON.stringify(tokenRec(home, sid))

    // 第二轮：窗口内制造漂移
    const { specs: s2, g: g2 } = await openWindow(home, sid, [docA])
    assert.equal((await runGate(freezeGateNow(), "write", { file_path: docA })).res.kind, "deny", "第二轮窗口同样武装")
    writeFileSync(docA, "# A v2 drifted\n")
    g2.release()
    const out2 = (await s2[0].hooks.done).output
    assert.ok(out2.includes("guard E:"), "第二轮确为漂移轮")

    assert.equal(sessionState(sid).designToken, issued, "内存令牌原样存活（不撤销）")
    assert.equal(JSON.stringify(tokenRec(home, sid)), recBefore, "磁盘记录逐字节不变（removeTokenRecord 零调用）")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E20 (AC-E20 / §9 边界 2): 真空豁免不死锁——documents=[] + PASS + 回显 → 签发照旧", async () => {
  const home = mkHome()
  const sid = newSid("ace20")
  try {
    const out = await callDesign({ llm: approvingLlm() }, makeAgent(sid), [], home)
    const st = sessionState(sid)
    assert.equal(st.pendingDocHash, null, "空集 ⇒ 铸造即 null（D6 真空豁免的前置）")
    assert.ok(out.includes("Approved. Pass this exact token to eng_coder"), "签发照旧（漏判 null 会让空文档集评审永远签不出）：" + out.slice(0, 160))
    assert.ok(!out.includes("guard E:"), "**不得**走入漂移分支")
    assert.equal(typeof st.designToken, "string", "state.designToken 已写")
    const rec = tokenRec(home, sid)
    assert.ok(rec, "saveTokenRecord 被调用（记录存在）")
    assert.equal(rec.docHash, undefined, "空集不写 docHash（D6 既有权衡）")
  } finally { cleanSid(sid); rmHome(home) }
})

test("T-E19 (AC-E19, N-1): 既有测试档零修改——测试档清单 = 下方登记清单 + 本档；批 6b 新机制字面只活在本档", () => {
  const testDir = join(PLUGIN_DIR, "test")
  const files = readdirSync(testDir).filter(f => f.endsWith(".test.mjs")).sort()
  // 本闸的意图 = **「新增测试档必须同步登记」**（防静默扩张），**不是**禁止新增：
  // 清单按**登记制**扩展——每批新增的 `*.test.mjs` 必须在此追加一行（并说明理由），
  // 未登记的新增档会让 deepEqual 转红。（批 7 追加 "path-kind.test.mjs"，
  // J9 用户 2026-09-13 裁定；理由：批 7 的单一权威叶模块需要自己的真值表档。）
  // ── 批 9 追加三个门档 ── **理由与用户裁定引用**（AC-15 / N-5：登记处必须注明，不能只加一行）：
  //   用户裁定（2026-09-13，见 docs/2026-09-13-test-lifecycle-requirements.md §0.3）：
  //     J9-1 痛种 = 锁衰变 + 台账漂移 ⇒ 退役 0 档、不设配额、taxonomy 住台账不住文件系统；
  //     J9-4 发布门 = 仓根脚本（否决纯 gate-as-test）；J9-6 阶段门 = 横幅不阻断；
  //     J9-3 反 tautological 四律升为 AC。三项用户裁定：形态全做 · R-13 不根治 · tag 带 v。
  //   三档理由（设计档 §7 / §10.1 · 台账 docs/test-lifecycle.md「三、逐档处置行」）：
  //     · test-lifecycle.test.mjs = 台账-历史一致闸（元锁：台账 ↔ 工作树 ↔ 本清单 ↔ 退役授权面
  //       四方一致 + 用例数独立算得；期望值只从 git + fs 导出）
  //     · stage-gate.test.mjs     = 阶段门 stageGateNote 三态 + **4** 个成功交付返回点接线
  //       （设计档 §6.4 记「5」= 4 条路径 + 「主返回点」，而「主返回点」与 dsh 同步**是同一处**；
  //        本批实测簿记调用点 = 4，详见 docs/test-lifecycle.md 变更记录）+ 失败点反向断言
  //     · release-check.test.mjs  = 发布门七闸的常驻断言（非计数）+ 解析/闸级比较函数单测
  //   ★ 落地纪律（设计档 §10.3 的 #21 裁定同族，本批同款执行）：**每个新档在其落地的同一
  //     stage 内登记于此**，不得攒到最后一次性补——否则台账-历史一致闸的
  //     「本清单 ↔ 工作树」等值腿会在「fs 已 +1 而本表未登记」时先红。
  const existing = [
    "advisor-config.test.mjs", "codex-runner.test.mjs", "config-api.test.mjs", "consult.test.mjs",
    "context-budget.test.mjs", "death-provenance.test.mjs", "design-review-guard.test.mjs",
    "preset-static.test.mjs", "session-state.test.mjs", "stages.test.mjs", "truncation.test.mjs",
    "path-kind.test.mjs", "prompt-contract.test.mjs",
    "test-lifecycle.test.mjs",
    "stage-gate.test.mjs",
    "release-check.test.mjs",
    // 批 10（台账纪律）新增档——**在其落地的同一 stage 内登记**（批 9 §七 已立此纪律：
    // 台账-历史一致闸的「T-E19 ↔ fs」等值腿会在「fs 已 +1 而本表未登记」时先红）。
    // 理由与裁定引用：
    //   ① ledger-parity.test.mjs —— 计数有据 + 指针/触发两条结构断言（用户 2026-09-13 裁定
    //      J10-11 = 加；设计档 docs/2026-09-13-ledger-discipline-design.md §6.1 / §8.2 M1–M5）；
    //   ② eng-token-fallback.test.mjs —— D-36 写门禁回退腿三态（设计档 §6.3 / §8.2 M9–M12 /
    //      §11.2 AC-G1…AC-G6；决策 D10-13…D10-15）。
    "ledger-parity.test.mjs",
    "eng-token-fallback.test.mjs",
    // 批 11（D1–D7 文档纪律 + 上游失败路径语义 + DOC-HYGIENE 提示词级纪律）新增档——
    // **在其落地的同一 stage 内登记**（批 9 §七 已立此纪律）。
    // 理由与裁定引用：
    //   ③ doc-hygiene.test.mjs —— **D6「回读核对」的机械网**（用户裁定 ⑥ = 建新档做两项机械检查；
    //      裁定引用：需求档 docs/2026-09-13-doc-discipline-requirements.md §0.3 的 J11-6 =
    //      「U+FFFD 全仓扫描 + 五个常设档 canary」；设计档
    //      docs/2026-09-13-doc-discipline-design.md §6.4 / §8.2 V13+V14 / 决策 D11-8 /
    //      §12.2 AC-13+AC-14）。层取 **③ 实况事故收编**：本档的**来历是三次实况写坏事故**
    //      （PowerShell 往返双编码 · shell 单行脚本把常设标准档截为 1 行 · U+FFFD），处置 = 常驻。
    //      ★ 构成注明（防下批误读）：本档同时承载批 11 的锚腿 V1–V12（批次脚手架性质）与
    //        runEngCoder 失败返回串的**进程内**行为断言（② 性质）——台账层号枚举无 `①+③` 形态，
    //        故按**来历与保留政策**记 ③，构成如实写在本行与台账理由格。
    "doc-hygiene.test.mjs",
    // 批 20（writeFileAtomic 有界重试 + 失败可见性）新增档——**在其落地的同一 stage 内登记**
    // （批 9 §七 已立此纪律：台账-历史一致闸的「T-E19 ↔ fs」等值腿会在「fs 已 +1 而本表未登记」时先红）。
    // 理由与设计档引用：write-atomic.test.mjs = 批 20 的 A6…A11 注入式机验锚腿——rename/write
    //   缝注入 EPERM/ENOENT/ENOSPC ⇒ 重试落地 + 零残留 · 耗尽重抛原对象 + 耗尽遥测 · 非白名单
    //   单次快失败 · 首写失败零残留 · 孤儿清扫（龄 ≥ 10min）· clearUserConfig 幂等；负控 N2/N3
    //   在仓外临时副本上会话期自证（不进套件）。设计档 docs/2026-09-17-writefileatomic-design.md
    //   §8.2（锚 A6…A11）· §10.1（新增档，触发登记级联）· §10.4 stage 2。台账行由主代理同批登记。
    "write-atomic.test.mjs",
    // 批 24（D-41 / D-42：DSH 0.1.7 平台契约变更）新增档——**在其落地的同一 stage 内登记**
    // （批 9 §七 已立此纪律：台账-历史一致闸的「T-E19 ↔ fs」等值腿会在「fs 已 +1 而本表未登记」时先红）。
    // 理由与设计档引用：dsh017-compat.test.mjs = 两处 0.1.7 契约断裂的回归锁，每处一条**行为腿** +
    //   一条**源码字节锁**——D-41 消息模型（工具结果必须是独立 tool 角色消息：走真实
    //   runAdvisorToolLoop 的两轮夹具，llm 桩只替网络那一层；断言 role/isError/source/toolCallId
    //   契约 · 无 user+tool-result 残留 · 无孤儿 tool）+ D-42 jobs owner（jobs.start 的 owner 必须是
    //   agent/session id：ownerIdOf 三态 + 4 档 7 处一一对应的字节锁）。设计档
    //   docs/2026-09-25-dsh017-compat-design.md §6（机验锚 A1…A8：A1/A2 = D-41a/D-41b · A3/A4 = T13-boundary-a/b ·
//   A5/A6 = D-42a/D-42b · A7/A8 = 登记与授权面）。台账行由同一提交登记。
    "dsh017-compat.test.mjs",
  ]
  assert.deepEqual(files, [...existing, "guard-e.test.mjs"].sort(),
    // ★ 批 10 交付代码评审 🔵#3（收尾轮）：本消息串此前自报「既有 11 档 + 批 7/8/9 各批登记档」
    //   ——**会漂的自报枚举**（数组本体已登记批 10 两档，而口径仍停在批 9）⇒ 改为**计数无关**表述
    //   （本条断言的有效性不依赖任何计数：期望值 = 上方 `existing` 数组本身）。同理本用例**标题**的
    //   「11 既有」也一并去掉——它与本消息是同一族的漂移。
    "测试档清单 = 上方 existing 登记清单 + 本档（多一个 = 越界新增，少一个 = 既有档被改名/删除）")
  // 既有档不得被「改造以适配本批」：批 6b 的机制字面只允许出现在本档
  for (const f of existing) {
    const src = readFileSync(join(testDir, f), "utf8")
    for (const marker of ["designFreezeSet", "makeDocFreezeGate", "frozen: "]) {
      assert.ok(!src.includes(marker), f + " 不得含批 6b 机制字面（" + marker + "）——既有档零修改")
    }
  }
  // fixtures 基线仍在（既有档依赖，零改动）
  assert.ok(existsSync(join(testDir, "fixtures", "coder-brief-with-docs.txt")), "既有 fixture 原样在位")
})

// ═══════════════════════════ 机验锚（AC-E17 / AC-E18 / AC-E21） ═══════════════════════════

/** `makeWriteGate` 函数体的**归一态**（**批 12 收窄后的锁面**：可执行行的字节与顺序）。
 *  ★ **契约（批 12 起）**：本夹具存的是**已归一态**——`normalizeExec`（= 先统一行终止符 →
 *    剥离器 → 逐行 `rtrim` → 丢空行）作用在「**先在原始源码上切片**得到的 `makeWriteGate`
 *    函数体」上的结果。比对只有**一侧**做剥离（对称剥离会引入假绿逃逸面；R-29）。
 *    **注释层（文字 / 位置 / 行数 / 缩进）自由**：改 / 挪 / 增 / 删 / 改缩进都**不会**让
 *    T-E17 变红。**两个例外**（🔵#5 措辞订正：初稿写「完全自由」**过宽**，审计给出反例）：
 *    ① **切片内新增 `/*`** ⇒ A2 域自检红；② **改右界标记（`WG_END`）的注释文字** ⇒ 边界
 *    断言红（该标记与 `path-kind` 的 T-PK8 共用 ⇒ 一动两处同红）。
 *  ★ **时点快照声明**（本夹具是**一次性写入 + 逐字节比对**的**时点快照**，不是生成物）：
 *    行数 / 字符数由 **stage 0 机械推导**得出并逐字对齐；推导 one-liner 见
 *    `docs/2026-09-15-lock-narrowing-design.md` §6.3。重新基线仍靠人眼复制，故配
 *    `normalizeExec(WRITE_GATE_FIXTURE) === WRITE_GATE_FIXTURE` **幂等自检**兜底（抓「重基线时
 *    误把注释 / 空行 / 尾空格抄进夹具」）。**禁止手抄设计档里的数字**。
 *  ★ **锁面收窄的自白**（批 12；设计档 §9 边界-12 由此**关闭**）：批 10 的三次重新基线里两次的税
 *    就是「注释也在锁内」⇒ 本批把锁面从「函数体**全文含注释**」收窄为「**只锁可执行行**」。
 *  ★ **接受的代价**（设计档 §9 边界-1 / 边界-2，明写而非靠猜）：**注释层自由** ⇒ 注释与代码脱节
 *    不再有锚捕获，**权威 = 设计档 + 评审**（本档**不**补支点注释句锁——那正是本批要消灭的锁）。
 *  ★ **历史基线自白（批 10；原文保留）**：批 6b 立此夹具时的语义是「**本批**未改 `makeWriteGate`」；
 *    批 10 的 D-36 **依法**改动它（内存态为空时读盘回退腿 + `storPathOverride` 可选第二参测试缝）
 *    ⇒ 夹具随该合法改动**重新基线**（**第一次：代码**）。批 10 第二次：改回退腿上方那 4 行**注释**
 *    （承重层订正）；第三次：`diskState` 第三态（**代码 + 其上方 9 行注释**）。**三次的代价见设计档
 *    §9 边界-12** —— 那句「函数体任何改动（含注释）都必须重新基线」**是批 10 当批的约束句**，
 *    批 12 起被本节的新契约**取代**（supersede），此句保留仅作历史记录。 */
const WRITE_GATE_FIXTURE = [
  "export function makeWriteGate(getConfigDefault, storPathOverride) {",
  "  return async (exec, next) => {",
  "    try {",
  "      const name = exec?.name",
  "      if (!WRITE_TOOLS.has(name)) return await next()",
  "      const agent = exec?.agent",
  "      if (!agent?.session) return await next()",
  "      const depth = agent.session.header?.delegationDepth ?? 0",
  "      if (depth > 0) return await next()",
  "      const state = sessionState(agent.session.id)",
  "      if (!engEffective(state, getConfigDefault())) return await next()",
  "      if (state.designToken && validateDesignToken(state.designToken)) return await next()",
  "      const target = targetPathOf(name, exec?.arguments)",
  "      if (!target || !isProductCode(target)) return await next()",
  "      let diskRec = null",
  "      if (!state.designToken) {",
  "        try { diskRec = loadTokenRecord(agent.session.id, storPathOverride, agent.session?.header?.cwd) } catch { diskRec = null }",
  "      }",
  "      const diskToken = diskRec && typeof diskRec.token === \"string\" && diskRec.token !== \"\" ? diskRec.token : null",
  "      const diskState = !state.designToken",
  "        ? (diskToken === null ? \"missing\"",
  "          : (validateDesignToken(diskToken) ? \"valid\"",
  "            : (designTokenFailureReason(diskToken) === \"expired\" ? \"expired\" : \"missing\")))",
  "        : null",
  "      if (diskState === \"valid\") {",
  "        state.designToken = diskToken",
  "        console.warn(\"[thincoder-suite] gate: design token restored from token-store (session \"",
  "          + agent.session.id + \", expires \"",
  "          + new Date(typeof diskRec.expiresAt === \"number\" && Number.isFinite(diskRec.expiresAt)",
  "            ? diskRec.expiresAt : (tokenExpiryMs(diskToken) ?? Date.now())).toISOString() + \")\")",
  "        return await next()",
  "      }",
  "      const gateExp = state.designToken ? tokenExpiryMs(state.designToken)",
  "        : (diskState === \"expired\" ? tokenExpiryMs(diskToken) : null)",
  "      const gateExpired = gateExp !== null && Date.now() > gateExp",
  "      return {",
  "        kind: \"deny\",",
  "        reason: gateExpired",
  "          ? \"denied: engineering mode is ON and the current design token expired at \" + new Date(gateExp).toLocaleString()",
  "            + \" — call eng_coder again with your token: if the design document set is unchanged the token is renewed automatically (no re-review); if it changed, re-run the design review. Docs (*.md under docs/ or at the root) stay writable.\"",
  "          : \"denied: engineering mode is ON and no design token — write the design document first, have the user initiate advisor(type='design'), then implement via eng_coder (the designToken parameter). Docs (*.md under docs/ or at the root) stay writable.\",",
  "      }",
  "    } catch {",
  "      return await next()",
  "    }",
  "  }",
  "}",
].join("\n")

test("T-E17 (AC-E17, 锚 A1/A2/A7/A8): 漂移分支不读活 state · 写门禁函数体未改 · 兜底在写点之前 · 漂移绕过计振尾", () => {
  const src = readFileSync(ADVISOR_SRC, "utf8")
  const engSrc = readFileSync(ENG_SRC, "utf8")

  // —— A7 + A1：签发块切片（右界 = 第一个状态写点） ——
  const issueBlock = sliceBetween(src, "if (echoOk) {", "const persisted = saveTokenRecord(")
  const iFresh = issueBlock.indexOf("computeDocHash(castDocPaths)")
  const iWrite = issueBlock.indexOf("state.designToken = designToken")
  assert.ok(iFresh >= 0, "A7: 兜底复检在签发块内")
  assert.ok(iWrite >= 0, "A7: 签发写点存在")
  assert.ok(iFresh < iWrite, "A7: 兜底在写点**之前**（先于一切状态写点，否则需事后回滚）")
  assert.equal((issueBlock.match(/state\.pendingDoc/g) ?? []).length, 0, "A1: 签发块内不读活 state.pendingDoc*（闭包捕获）")
  assert.ok(issueBlock.includes("castDocHash === null ? null : computeDocHash(castDocPaths)"),
    "A1/D-E7: 真空豁免守卫 —— 基准为捕获对，且只在 castDocHash !== null 时求值")

  // —— A8：漂移分支切片（到签发写点为止） ——
  const driftBlock = sliceBetween(src, "const drifted = ", "state.designToken = designToken")
  const driftCode = stripComments(driftBlock) // 负向断言只看**代码**（注释不是调用）
  assert.ok(driftBlock.includes("return warnPrefix + cleanDrift"), "A8: 漂移分支早返回（绕过下方通用计振尾）")
  assert.equal((driftCode.match(/recordDesignSettlement/g) ?? []).length, 0, "A8: 漂移分支对结算打点函数**零调用**")
  assert.ok(!driftCode.includes("bumpAdvisorGeneration"), "D-E9: 代际不 +1")
  assert.ok(!driftCode.includes("removeTokenRecord") && !driftCode.includes("state.designToken = null"),
    "D-E10: 不撤销既有令牌")
  assert.ok(driftCode.includes("state.advisorRound = 0") && driftCode.includes("state.lastAdvisorOutput = null")
    && driftCode.includes("persistSessionState(agent, state, opts)"), "D-E9: 复位轮次 + 清 prior + 落盘")

  // —— A2：makeWriteGate 函数体的**可执行行**等于本批更新后的夹具（内容比对；非「工作树 vs HEAD」形态） ——
  //    ★ 批 10 起切片起点改为 `export function makeWriteGate(`（不带签名）：D-36 给它加了
  //      **可选**第二参 `storPathOverride`（测试缝，向后兼容）——起点写成带签名会在合法扩参时
  //      定位失败（本批实测踩中）；签名不参与锚，函数体参与。
  //    ★ 批 12（锁面收窄）：锁的语义 = **可执行行的字节与顺序**；注释层（文字 / 位置 / 行数 /
  //      缩进）自由（**两个例外**见本档 `normalizeExec` 与夹具头的 doc）⇒ 比对的是归一态
  //      （`normalizeExec`），**不再**按原样比对函数体全文。
  const WG_END = "\n\n/**\n * 守卫 E 预闸"
  const wgStart = engSrc.indexOf("export function makeWriteGate(")
  const wgEnd = engSrc.indexOf(WG_END)
  assert.ok(wgStart >= 0 && wgEnd > wgStart, "A2: 函数体切片边界可定位")

  // ★ 顺序锁（D12-5）：右界标记**本身是注释居民** ⇒ 必须【先切片、后剥离】。
  //   它堵的退化路径真实且近：T-E18 已在算 `stripComments(engSrc)`，一次「先剥再切」是最自然的
  //   坏改法——没有本条时只会看到一句费解的「边界不可定位」，然后**改标记绕过，锚就这么死了**。
  //   **不过锁**：它钉的是**测试自身的切片机制**，而标记文本早已被上面的边界断言 + 夹具事实钉死。
  assert.ok(stripComments(engSrc).indexOf(WG_END) === -1,
    "A2 顺序锁：右界标记本身是注释 ⇒ 必须【先切片、后剥离】；全档剥离后该标记必失")

  const rawSlice = engSrc.slice(wgStart, wgEnd)

  // ★ 域自检（D12-8）：剥离器在切片上必须**逐行局部**（块注释跨行吞并 = 前提失效）。
  //   它是「丢空行」全部推理的支点，并顺手灭绝 `fro/*x*/zen` 这类拼接绕过。
  assert.ok(!rawSlice.includes("/*"),
    "A2 域自检：剥离器在切片上必须逐行局部（块注释跨行吞并 = 前提失效）")

  const norm = normalizeExec(rawSlice)

  // —— 夹具自检（D12-4）——
  //   ★ 设计修订（交付审计 §13.2.0 🟡#3）：初稿只有 `assert.equal(normalizeExec(FIXTURE), FIXTURE)`，
  //     而审计**证明它不可达为首次失败**：`norm` 恒在 `normalizeExec` 的像集里 ⇒
  //     `norm === FIXTURE` 已经蕴含幂等 ⇒ **排在更前的等值断言永远先红**，幂等的消息**从未
  //     出现**（实测 7 种夹具污染下均如此）⇒ **零边际检测力**。
  //   ⇒ 改成**直接判定夹具原始文本是「已归一态」**（行非空 · 无行尾空白 · 无注释标记），
  //     三条**全部排在等值断言之前** ⇒ 每条都能**独立致红**（不再被等值断言遮蔽）；
  //     幂等式**保留在后作为纵深**。
  const FIXTURE_LINES = WRITE_GATE_FIXTURE.split("\n")
  assert.ok(FIXTURE_LINES.every((l) => l !== "" && l === l.replace(/\s+$/, "")),
    "A2 夹具自检：夹具的行不得为空、不得有行尾空白（它必须是已归一态）")
  assert.ok(!/\/\/|\/\*/.test(WRITE_GATE_FIXTURE),
    "A2 夹具自检：夹具不得含任何注释标记（它必须是已归一态）")
  assert.equal(normalizeExec(WRITE_GATE_FIXTURE), WRITE_GATE_FIXTURE,
    "A2 夹具自检（幂等，保留为纵深）")

  // ★ 等值比对：收窄后（只锁可执行行）
  assert.equal(norm, WRITE_GATE_FIXTURE,
    "A2: makeWriteGate 的**可执行行**（字节与顺序）等于夹具；注释层不入锁")

  // ★ 合并签名正则（D12-6 / D12-7）：负向断言只看**代码**（与 A8 / A6 同惯例；本档唯一的
  //   「跑在原始文本上的负向断言」在此补齐）。修的是**今天就存在的拼写缺口**：
  //   `"frozen"` 匹配不到 `designFreezeSet`（freeze 无 n）⇒ 旧断言只拦 `frozen: ` 文案，
  //   **从没拦过「把预闸函数拖进写门禁」这类合并**——而那正是 D-E1 要防的最重一类。
  assert.ok(!/(designFreezeSet|makeDocFreezeGate|"frozen: )/.test(norm),
    "A2: 守卫 E 未被并进写门禁（D-E1；注释不参与；合并签名三选一出现即红）")

  const mkCount = (engSrc.match(/export function makeWriteGate\s*\(/g) ?? []).length
  assert.equal(mkCount, 1, "A2: 唯一实现点")
})

test("T-E18 (AC-E18, 锚 A3/A4/A5/A6/A9): 全深度拦截 · 不查 eng 模式 · 两闸独立各一 · 判定族字面只追加 · guidance 七 kind 不扩", () => {
  const engSrc = readFileSync(ENG_SRC, "utf8")
  const indexSrc = readFileSync(INDEX_SRC, "utf8")
  const advisorSrc = readFileSync(ADVISOR_SRC, "utf8")

  // —— A3 / A4：预闸函数体切片（到 frozenReason 定义为止） ——
  const gateSrc = sliceBetween(engSrc, "export function makeDocFreezeGate(", "\n/** 拒绝文案（D-E5")
  assert.ok(!gateSrc.includes("delegationDepth"), "A3: 预闸不查 delegationDepth（全深度拦截，D-E5）")
  assert.ok(!gateSrc.includes("engEffective"), "A4: 预闸不查 engEffective（D-E12/N-5）")
  assert.ok(gateSrc.includes("if (!WRITE_TOOLS.has(exec?.name)) return await next()"), "名字门先于注册表扫描")
  // 窗口判定区在 try **之外**（D-E11 的结构性保证）：catch→next 出现在 try 判定区之前
  const iWindowTry = gateSrc.indexOf("try { freeze = getFreezeSet() }")
  const iDecideTry = gateSrc.indexOf("try {\n      const target = targetPathOf(")
  assert.ok(iWindowTry >= 0 && iDecideTry > iWindowTry, "A3/D-E11: 窗口判定区先于且独立于判定区 try")
  assert.ok(gateSrc.slice(iWindowTry, iDecideTry).includes("return await next()"), "窗口未确认 ⇒ 放行")
  assert.ok(gateSrc.slice(iDecideTry).includes('kind: "deny"'), "判定区抛错 ⇒ deny（fail-closed）")
  assert.ok(gateSrc.includes('console.warn("[thincoder-suite] 守卫 E 预闸：'), "窗口判定故障必须 warn（禁静默 fail-open）")

  // —— A5：两闸独立（恰 2 个监听器，各自绑定） ——
  const listenerCount = (indexSrc.match(/ctx\.on\("tools\/pre-execute"/g) ?? []).length
  assert.equal(listenerCount, 2, "A5: tools/pre-execute 恰 2 个监听器")
  assert.ok(indexSrc.includes('ctx.on("tools/pre-execute", makeWriteGate(() => configDefaultEngineering))'), "A5: 其一为写门禁")
  assert.ok(indexSrc.includes('ctx.on("tools/pre-execute", makeDocFreezeGate(() => designFreezeSet()))'), "A5: 其二为守卫 E 预闸")
  assert.ok(/const offFreezeGate = ctx\.on\("tools\/pre-execute", makeDocFreezeGate[\s\S]{0,80}disposes\.push\(offFreezeGate\)/.test(indexSrc),
    "A5: 预闸 disposer 已入 disposes")
  // 写门禁注册点位置零移动：预闸注册在它之后
  assert.ok(indexSrc.indexOf("const offGate = ctx.on") < indexSrc.indexOf("const offFreezeGate = ctx.on"),
    "写门禁位置零移动（预闸放后侧）")

  // —— A6：判定族字面只追加（既有 "denied: " 不得减少；新 "frozen: " 必须存在） ——
  // 计数前**剥离注释**：注释里引述前缀字面不算实现（否则「写一句解释」就能让锚变绿）。
  const deniedCount = (stripComments(engSrc).match(/"denied: /g) ?? []).length
  const frozenCount = (stripComments(engSrc).match(/"frozen: /g) ?? []).length
  assert.ok(deniedCount >= 2, "A6: 既有 denied: 字面 ≥2（实测 2：过期态 + 无令牌态）——替换会归零 → 红，实得 " + deniedCount)
  assert.ok(frozenCount >= 1, "A6: 新前缀 frozen: 必须存在——实得 " + frozenCount)

  // —— A9：guidance 七 kind 不扩（文本切片数条目；防「顺手加第 8 行」） ——
  const table = sliceBetween(advisorSrc, "const SETTLEMENT_KIND_GUIDANCE = [", "\n]")
  const rows = table.split("\n").filter(l => /^\s*\["/.test(l))
  assert.equal(rows.length, 7, "A9: SETTLEMENT_KIND_GUIDANCE 恰 7 行：" + rows.map(r => r.trim().split('"')[1]).join(","))
  for (const k of ["timeout", "context_limit", "empty", "turn_cap", "stale", "token_persist_failed", "review_failed"]) {
    assert.ok(table.includes('"' + k + '"'), "A9: 既有 kind 保留 " + k)
  }
  assert.ok(!table.includes("doc_drift"), "A9/D-E8: 不得新增第八 kind")
  // D-E8 配套：guidance 表上方钉死「漂移不属计数面」的注释
  assert.ok(sliceBetween(advisorSrc, "/**\n * 七 kind 的可行动指引", "const SETTLEMENT_KIND_GUIDANCE = [")
    .includes("不属"), "D-E8 配套注释：漂移不属计数面（防将来「顺手修一致」）")
})

test("T-E21 (AC-E21, 锚 A10): 单一实现——写工具枚举 / 路径归一 / 目标提取 各只一份（跨 lib/**）", () => {
  const libDir = join(PLUGIN_DIR, "lib")
  const files = readdirSync(libDir).filter(f => f.endsWith(".mjs"))
  assert.ok(files.length >= 10, "确实扫到了 lib/ 的模块集：" + files.length)
  const count = (re) => files.reduce((n, f) => n + (readFileSync(join(libDir, f), "utf8").match(re) ?? []).length, 0)
  assert.equal(count(/new Set\(\["write", "edit"\]\)/g), 1, "A10: WRITE_TOOLS 字面恰 1 处（禁第二份副本）")
  assert.equal(count(/export function normalizeDocPath\s*\(/g), 1, "A10: normalizeDocPath 导出恰 1 处（预闸必须复用它）")
  assert.equal(count(/function targetPathOf\s*\(/g), 1, "A10: targetPathOf 定义恰 1 处")
  // 预闸确实 import 了归一实现，而不是自造路径归一
  assert.match(readFileSync(ENG_SRC, "utf8"), /import \{ computeDocHash, normalizeDocPath \} from "\.\/doc-hash\.mjs"/,
    "A10/N-3: eng.mjs 显式 import normalizeDocPath（不自造 cwd 归一）")
})
