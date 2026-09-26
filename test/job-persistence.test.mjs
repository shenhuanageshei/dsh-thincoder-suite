// job-persistence.test.mjs — 批 27（残差清零）落盘面回归锚（设计档 docs/dsh017-batch27-design.md §5.1）。
//
// 覆盖：US-1 清扫/轮转（A27-1 超龄 · A27-2 条数+缺省上限 · A27-3 负控「只清自己的」）·
// US-2 非法 pathForm warn（A27-6）· US-5 cwdHint 透传（A27-8 静态 7 处 + 收口点直喂行为腿 +
// eng 真实派发行为腿——批 27 分歧修复 D5）·
// US-6 零落盘回归锚（A27-4：home 不可解析 ⇒ 零文件落盘 + 进程内只 warn 一次）。
//
// 全部用例走 dshHomeOverride / cwdHint 注入缝 + 临时目录（对齐 dsh017-compat / write-atomic 先例），
// **不写真实 $DSH_HOME**；A27-4 放在档首（其「只 warn 一次」判据依赖本进程此前的零落盘前置）。
// A27-8 两条行为腿不传 override：临时清空 DSH_HOME（save/restore）+ 假 profile 根 ⇒ pickDshHome
// 只能从 cwdHint（= 夹具会话 cwd）探测出落点，透传缺失即红。
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { runEngCoder } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { jobOutcome, sweepJobReports, PATH_FORMS } from "../lib/job-outcome.mjs"
import { probeProfileRoot } from "../lib/dsh-home.mjs"

// 隔离契约（对齐既有测试档 dsh017-compat.test.mjs）：本档会 settle 真作业 ⇒ jobOutcome 尝试
// 落盘并触发清扫（批 27）——显式置空 ⇒ home 不可解析 ⇒ 零盘副作用；落盘/清扫面用
// dshHomeOverride / cwdHint 注入缝定向到临时目录验证。
process.env.DSH_HOME = ""

const DAY_MS = 24 * 60 * 60 * 1000
const jobsDir = (home) => join(home, ".thincoder", "jobs")
const makeHome = (tag) => mkdtempSync(join(tmpdir(), "thincoder-" + tag + "-"))

/** 造一个作业正文文件并把 mtime 钉到 ageDays 天前（清扫按 mtime 裁决）。 */
function plant(home, name, ageDays, content) {
  mkdirSync(jobsDir(home), { recursive: true })
  const p = join(jobsDir(home), name)
  writeFileSync(p, content ?? ("body-of-" + name), "utf8")
  const t = new Date(Date.now() - ageDays * DAY_MS)
  utimesSync(p, t, t)
  return p
}

/** 造一行 index.jsonl（形状与 persistJobReport 的落档行一致）。 */
function indexLine(jobId, kind) {
  return JSON.stringify({ jobId, kind, at: Date.now(), bytes: 3, pathForm: "result" })
}

function writeIndex(home, lines) {
  writeFileSync(join(jobsDir(home), "index.jsonl"), lines.join("\n") + "\n", "utf8")
}

function readIndex(home) {
  return readFileSync(join(jobsDir(home), "index.jsonl"), "utf8").trim().split("\n").filter((l) => l !== "")
}

test("A27-4 零落盘回归锚 (US-6 / AC-2): home 不可解析 ⇒ 零文件落盘（不写 cwd、不写真实 home）+ 进程内只 warn 一次", () => {
  const hintDir = makeHome("a27-4")
  const warnings = []
  const origWarn = console.warn
  try {
    // 前提自证：注入形态真的不可解析（否则本锚测的不是它声称的形态）
    assert.equal(probeProfileRoot(hintDir), null, "临时 cwdHint 目录向上探测必须解析不到 profile 根")
    console.warn = (...a) => { warnings.push(a.map(String).join(" ")) }
    const ring = []
    const out1 = jobOutcome({ id: "advisor-nohome-1", append: (t) => ring.push(t) },
      { status: "completed", detail: "d", output: "NOHOME-1" }, { cwdHint: hintDir })
    const out2 = jobOutcome({ id: "eng-nohome-2", append: (t) => ring.push(t) },
      { status: "failed", detail: "d", output: "NOHOME-2" }, { cwdHint: hintDir })
    assert.equal(out1.result, "NOHOME-1", "收口本体不受影响（环/result 照常）")
    assert.equal(out2.result, "NOHOME-2", "第二次 settle 同样只跳过落盘")
    assert.equal(ring.join("|"), "NOHOME-1|NOHOME-2", "输出环照写（D-45 兜底缺席不拖累 0.1.7 主契约）")
    // 零文件落盘：注入目录、进程 cwd、真实 home 三处都不出现本批的作业文件
    assert.ok(!existsSync(join(hintDir, ".thincoder")), "不写 cwdHint 目录")
    assert.ok(!existsSync(join(process.cwd(), ".thincoder", "jobs", "advisor-nohome-1.txt")), "不写 process.cwd()")
    assert.ok(!existsSync(join(process.cwd(), ".thincoder", "jobs", "eng-nohome-2.txt")), "不写 process.cwd()（第二 id）")
    assert.ok(!existsSync(join(homedir(), ".dsh", ".thincoder", "jobs", "advisor-nohome-1.txt")), "不写真实 home ~/.dsh")
    assert.ok(!existsSync(join(homedir(), ".dsh", ".thincoder", "jobs", "eng-nohome-2.txt")), "不写真实 home ~/.dsh（第二 id）")
    const nohome = warnings.filter((w) => w.includes("DSH_HOME 不可解析"))
    assert.equal(nohome.length, 1, "进程内只 warn 一次（去重，不逐作业刷屏）：" + JSON.stringify(nohome))
  } finally {
    console.warn = origWarn
    rmSync(hintDir, { recursive: true, force: true })
  }
})

test("A27-6 非法 pathForm (US-2 / AC-4): warn 一行（列出合法值）且不抛，写入的仍是合法枚举值", () => {
  const home = makeHome("a27-6")
  const warnings = []
  const origWarn = console.warn
  try {
    console.warn = (...a) => { warnings.push(a.map(String).join(" ")) }
    // 显式非法值：不抛 + warn 一行 + 落档仍是合法枚举（非空正文 ⇒ 推断 result）
    const out = jobOutcome({ id: "eng-form-1", append() {} },
      { status: "completed", detail: "d", output: "FORM-BODY" }, { dshHomeOverride: home, pathForm: "carrier-pigeon" })
    assert.equal(out.result, "FORM-BODY", "不抛：outcome 原样收口（D26-2 维持）")
    let rows = readIndex(home).map((l) => JSON.parse(l))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].pathForm, "result", "写入的仍是合法枚举值（按正文推断）")
    const formWarns = warnings.filter((w) => w.includes("pathForm"))
    assert.equal(formWarns.length, 1, "恰 warn 一行：" + JSON.stringify(formWarns))
    assert.ok(!formWarns[0].includes("\n"), "单行（可 grep）")
    for (const legal of PATH_FORMS) assert.ok(formWarns[0].includes(legal), "warn 列出合法值 " + legal + "：" + formWarns[0])
    // null 同属「显式非法」⇒ 同样 warn；落档推断 none（空正文）
    jobOutcome({ id: "eng-form-2", append() {} }, { status: "completed", detail: "d", output: "" },
      { dshHomeOverride: home, pathForm: null })
    rows = readIndex(home).map((l) => JSON.parse(l))
    assert.equal(rows[rows.length - 1].pathForm, "none", "空正文推断 none")
    assert.equal(warnings.filter((w) => w.includes("pathForm")).length, 2, "null 亦 warn")
    // 合法显式值照常直录且零新增 warn
    jobOutcome({ id: "advisor-form-3", append() {} }, { status: "completed", detail: "d", output: "RING" },
      { dshHomeOverride: home, pathForm: "ring" })
    rows = readIndex(home).map((l) => JSON.parse(l))
    assert.equal(rows[rows.length - 1].pathForm, "ring", "合法显式值直录")
    assert.equal(warnings.filter((w) => w.includes("pathForm")).length, 2, "合法值零新增 warn")
    // 未传（undefined）＝缺省推断，不是非法 ⇒ 零 warn
    jobOutcome({ id: "eng-form-4", append() {} }, { status: "completed", detail: "d", output: "INFER" },
      { dshHomeOverride: home })
    assert.equal(warnings.filter((w) => w.includes("pathForm")).length, 2, "未传零 warn")
  } finally {
    console.warn = origWarn
    rmSync(home, { recursive: true, force: true })
  }
})

test("A27-1 超龄清扫 (US-1 / AC-1): 3 个超龄 + 1 个新鲜 ⇒ 超龄全删、新鲜保留，index.jsonl 只剩新鲜行", () => {
  const home = makeHome("a27-1")
  try {
    plant(home, "advisor-1.txt", 9)
    plant(home, "advisor-2.txt", 8)
    plant(home, "consult-3.txt", 9)
    plant(home, "eng-4.txt", 0)
    // 追加一行「文件根本不存在」的死行——重写必须把它一并裁掉（只留仍存在文件的行）
    writeIndex(home, [
      indexLine("advisor-1", "advisor"),
      indexLine("advisor-2", "advisor"),
      indexLine("consult-3", "consult"),
      indexLine("eng-4", "eng"),
      indexLine("escalate-9", "escalate"),
    ])
    const r = sweepJobReports({ dshHomeOverride: home, maxAgeDays: 7, maxFiles: 200 })
    assert.ok(r && r.deletedAge === 3 && r.deletedCount === 0, "超龄删 3、零条数截断：" + JSON.stringify(r))
    assert.equal(existsSync(join(jobsDir(home), "advisor-1.txt")), false, "超龄删")
    assert.equal(existsSync(join(jobsDir(home), "advisor-2.txt")), false, "超龄删")
    assert.equal(existsSync(join(jobsDir(home), "consult-3.txt")), false, "超龄删（跨 kind 同权重）")
    assert.equal(existsSync(join(jobsDir(home), "eng-4.txt")), true, "新鲜保留")
    const rows = readIndex(home)
    assert.equal(rows.length, 1, "index.jsonl 只剩仍存在文件的行（死行 escalate-9 一并裁掉）")
    assert.equal(JSON.parse(rows[0]).jobId, "eng-4")
    assert.ok(readdirSync(jobsDir(home)).every((n) => !n.startsWith(".index.jsonl.tmp-")), "原子替换无 tmp 残留")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A27-2 条数截断 (US-1 / AC-1): maxFiles+5 个文件 ⇒ 只留 maxFiles 个（mtime 从新到旧），index 同步只剩存活行", () => {
  const home = makeHome("a27-2")
  try {
    const lines = []
    for (let i = 1; i <= 15; i++) {
      plant(home, "eng-" + i + ".txt", 15 - i) // i=1 最老（14 天前）… i=15 最新（0 天前）
      lines.push(indexLine("eng-" + i, "eng"))
    }
    writeIndex(home, lines)
    // maxAgeDays 显式放大（30 天）：把年龄轴隔离掉，让本用例**只**裁决条数截断（年龄轴归 A27-1）
    const r = sweepJobReports({ dshHomeOverride: home, maxAgeDays: 30, maxFiles: 10 })
    assert.ok(r && r.deletedCount === 5 && r.deletedAge === 0, "按条数从旧到新截断 5 个：" + JSON.stringify(r))
    for (let i = 1; i <= 5; i++) assert.equal(existsSync(join(jobsDir(home), "eng-" + i + ".txt")), false, "eng-" + i + "（最老）被截断")
    for (let i = 6; i <= 15; i++) assert.equal(existsSync(join(jobsDir(home), "eng-" + i + ".txt")), true, "eng-" + i + "（较新）保留")
    const keptIds = readIndex(home).map((l) => JSON.parse(l).jobId).sort()
    assert.equal(keptIds.length, 10, "index 同步只剩存活行")
    assert.deepEqual(keptIds, Array.from({ length: 10 }, (_, k) => "eng-" + (k + 6)).sort())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A27-2 缺省上限 (D27-2): 不传参数 ⇒ maxAgeDays=7 / maxFiles=200 生效", () => {
  const home = makeHome("a27-2d")
  try {
    plant(home, "advisor-old.txt", 8) // > 7 天 ⇒ 缺省超龄删
    plant(home, "advisor-new.txt", 6) // < 7 天 ⇒ 缺省保留（且比下方 201 个都新）
    for (let i = 1; i <= 201; i++) plant(home, "escalate-" + i + ".txt", 6 + (201 - i) * 0.0005) // 全部 < 7 天，严格从旧到新
    const r = sweepJobReports({ dshHomeOverride: home })
    assert.ok(r && r.deletedAge === 1 && r.deletedCount === 2, "超龄删 1 + 条数截到 200 删 2：" + JSON.stringify(r))
    assert.equal(existsSync(join(jobsDir(home), "advisor-old.txt")), false, "缺省 7 天线生效")
    assert.equal(existsSync(join(jobsDir(home), "advisor-new.txt")), true, "6 天新鲜保留")
    assert.equal(existsSync(join(jobsDir(home), "escalate-1.txt")), false, "最旧者被截断")
    assert.equal(existsSync(join(jobsDir(home), "escalate-2.txt")), false, "次旧者被截断")
    assert.equal(existsSync(join(jobsDir(home), "escalate-201.txt")), true, "最新者保留")
    const survivors = readdirSync(jobsDir(home)).filter((n) => n.endsWith(".txt"))
    assert.equal(survivors.length, 200, "缺省 maxFiles=200")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A27-3 负控 (US-1 / D27-3): 非本插件形态的文件（pwsh-* 平台 kind 等）清扫永不触碰", () => {
  const home = makeHome("a27-3")
  try {
    plant(home, "advisor-1.txt", 0)
    plant(home, "pwsh-22.txt", 30) // 平台 kind：超龄也不许碰
    plant(home, "random.txt", 30) // 非作业形态
    plant(home, "advisor-notes.txt.bak", 30) // 前缀命中但后缀不符 ⇒ 不碰
    mkdirSync(join(jobsDir(home), "consult-9.txt")) // 形态同名的目录 ⇒ 不碰
    const r = sweepJobReports({ dshHomeOverride: home, maxAgeDays: 7, maxFiles: 200 })
    assert.ok(r && r.deletedAge === 0 && r.deletedCount === 0, "零误删：" + JSON.stringify(r))
    assert.equal(existsSync(join(jobsDir(home), "pwsh-22.txt")), true, "平台 kind 永不触碰")
    assert.equal(existsSync(join(jobsDir(home), "random.txt")), true, "非作业形态不碰")
    assert.equal(existsSync(join(jobsDir(home), "advisor-notes.txt.bak")), true, "后缀不符不碰")
    assert.equal(existsSync(join(jobsDir(home), "consult-9.txt")), true, "同名目录不碰")
    assert.equal(existsSync(join(jobsDir(home), "advisor-1.txt")), true, "本插件新鲜文件保留")
    assert.equal(existsSync(join(jobsDir(home), "index.jsonl")), false, "零删除且无索引 ⇒ 不凭空造索引")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("A27-8 cwdHint 透传 (US-5 / AC-6): 四档 7 处派发点全部传会话 cwd（静态）+ pickDshHome 基座行为腿", () => {
  // 静态腿：每个派发点恰一处 `cwdHint: agent.session?.header?.cwd`（与 escalate 既有
  // saveSessionState 的同款来源表达式；计数随 jobs.start 派发点两处同改——缺一即红）。
  const HINT_RE = /cwdHint: agent\.session\?\.header\?\.cwd/g
  let total = 0
  for (const name of ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]) {
    const src = readFileSync(new URL("../lib/" + name, import.meta.url), "utf8")
    const starts = (src.match(/jobs\.start\(\{/g) ?? []).length
    const hints = (src.match(HINT_RE) ?? []).length
    assert.equal(hints, starts, name + ": 每个派发点恰传一处 cwdHint（实得 " + hints + " vs 派发点 " + starts + "）")
    total += hints
  }
  assert.equal(total, 7, "四档 7 处派发点全部传 cwdHint（缺一即红）——实测 " + total)
  // 行为腿·收口点直喂（单元腿；经真实派发路径的腿见下一用例——批 27 分歧修复 D5）：
  // 会话 cwd（此处以假 profile 根扮演）经 jobOutcome → persistJobReport → pickDshHome
  // 的探测基座生效——正文文件落在该基座下。若透传缺失（基座退回 process.cwd()），本断言必红
  // （临时假 profile 根不在进程 cwd 的任何祖先链上）。
  const fakeRoot = makeHome("a27-8")
  const warnings = []
  const origWarn = console.warn
  try {
    mkdirSync(join(fakeRoot, "sessions"), { recursive: true })
    writeFileSync(join(fakeRoot, "settings.yaml"), "probe: yes\n", "utf8")
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = ""
    try {
      console.warn = (...a) => { warnings.push(a.map(String).join(" ")) }
      jobOutcome({ id: "escalate-dsh-77", append() {} },
        { status: "completed", detail: "d", output: "CWD-HINT-PROOF" }, { cwdHint: fakeRoot })
    } finally {
      console.warn = origWarn
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
    const file = join(fakeRoot, ".thincoder", "jobs", "escalate-dsh-77.txt")
    assert.equal(existsSync(file), true, "落盘基座 = cwdHint 指向的会话 cwd（透传生效）")
    assert.equal(readFileSync(file, "utf8"), "CWD-HINT-PROOF", "正文一致")
    assert.equal(warnings.filter((w) => w.includes("落盘")).length, 0, "全程零落盘告警")
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true })
  }
})

test("A27-8 行为腿·真实派发 (US-5 / AC-6): 经 eng 派发路径 settle 后，pickDshHome 收到的基座 = 夹具会话 header.cwd", async () => {
  // D5（批 27 分歧修复）：直喂 jobOutcome 的腿只证「收口点透传」，不证「派发点真的传了」。
  // 本腿走 lib/eng.mjs 的真实 dsh 派发路径（runEngCoder → jobs.start → run → jobOutcome 的
  // jobPersistOpts = { cwdHint: agent.session?.header?.cwd }），断言正文文件落在夹具会话 cwd
  // 经 pickDshHome 探测出的 profile 根下——派发点漏传 cwdHint（基座退回 process.cwd()）时
  // 本断言必红（临时假 profile 根不在进程 cwd 的任何祖先链上）。夹具对齐 platform-surface
  // A26-7 先例：假 subagents/llm/jobs、零真子代理；stages 不传 ⇒ dshStages 为空 ⇒ 零 host
  // 验收 spawn（零真进程纪律）。
  const sid = "a27-8-dispatch"
  const fakeRoot = makeHome("a27-8d")
  const sessionCwd = join(fakeRoot, "work") // 真实形态：会话 cwd 是 profile 根的后代
  const warnings = []
  const origWarn = console.warn
  try {
    mkdirSync(join(fakeRoot, "sessions"), { recursive: true })
    mkdirSync(sessionCwd, { recursive: true })
    writeFileSync(join(fakeRoot, "settings.yaml"), "probe: yes\n", "utf8")
    const st = sessionState(sid)
    st.engineering = true
    st.designToken = randomUUID() + ":" + (Date.now() + 3600_000)
    const handle = { id: "eng-dsh-a27-8", calls: [], append(text) { this.calls.push(text) } }
    let hooks = null
    const deps = {
      ctx: {
        subagents: {
          async start() {
            return { result: Promise.resolve({ stopReason: "completed", output: [{ type: "text", text: "A27-8 DISPATCH-REPORT" }] }), dispose: async () => {} }
          },
        },
        llm: { async resolveModelInfo() { return { reasoning: { efforts: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }], defaultEffort: "low" } } } },
        // 0.1.7 形态的假 jobs：同步调 spec.run(handle) 并留存 hooks（对齐 platform-surface A26-7）
        get: (s) => (s === "jobs" ? { start(spec) { hooks = spec.run(handle); return handle.id } } : null),
      },
      agent: { session: { id: sid, header: { cwd: sessionCwd } }, options: { provider: "p", model: "m" } },
      config: { dshBackgroundTimeoutMs: 60000 },
      signal: undefined,
      configDefaultEngineering: false,
    }
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = "" // pickDshHome 只剩 cwdHint 探测一条路（隔离契约，save/restore 恢复）
    try {
      console.warn = (...a) => { warnings.push(a.map(String).join(" ")) }
      const out = await runEngCoder(deps, { task: "deliver the a27-8 cwdHint dispatch proof", designToken: st.designToken })
      assert.ok(out.includes("eng-dsh-a27-8"), "前置：确实走了 dsh 后台派发（job 句柄可见）：" + out.slice(0, 140))
      const outcome = await hooks.done
      assert.equal(outcome.status, "completed", "子代理立即完成 ⇒ 交付态")
    } finally {
      console.warn = origWarn
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
    const file = join(fakeRoot, ".thincoder", "jobs", "eng-dsh-a27-8.txt")
    assert.equal(existsSync(file), true,
      "落盘基座 = 夹具会话 header.cwd 经 pickDshHome 探测出的 profile 根（eng 派发点 cwdHint 透传生效；漏传 ⇒ 基座退回 process.cwd() ⇒ 本断言红）")
    assert.ok(readFileSync(file, "utf8").includes("A27-8 DISPATCH-REPORT"), "正文 = 派发路径的交付报告")
    assert.equal(warnings.filter((w) => w.includes("落盘")).length, 0, "全程零落盘告警")
  } finally {
    dropSession(sid)
    rmSync(fakeRoot, { recursive: true, force: true })
  }
})

test("US-1 触发时机 (D27-1): persist 成功后自动清扫一次——顺手清掉既有的超龄残留", () => {
  const home = makeHome("a27-trig")
  try {
    plant(home, "advisor-9.txt", 9) // 上次会话留下的超龄残留
    const out = jobOutcome({ id: "eng-dsh-5", append() {} },
      { status: "completed", detail: "d", output: "TRIGGER" }, { dshHomeOverride: home })
    assert.equal(out.result, "TRIGGER", "收口本体不受影响")
    assert.equal(existsSync(join(jobsDir(home), "eng-dsh-5.txt")), true, "本次正文照常落盘")
    assert.equal(existsSync(join(jobsDir(home), "advisor-9.txt")), false, "persist 成功 ⇒ 清扫自动触发，超龄残留被清")
    const rows = readIndex(home)
    assert.equal(rows.length, 1, "索引同步重写后只剩仍存在文件的行")
    assert.equal(JSON.parse(rows[0]).jobId, "eng-dsh-5")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
