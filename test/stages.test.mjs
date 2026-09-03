// stages.test.mjs — F13 eng_coder 阶段化任务书单元测试（docs/2026-09-02-session-state-stages-design.md §3/§6）。
// 覆盖 T9（stages 缺省 → brief 逐字节等于现行 fixture）、T10（渲染编号四段 + 校验拒绝缺 check/
// 超 10 + 注册 schema 约束）、T11（stage 表前置指令 + 预算将尽条款）、T12（漂移探测前缀警告）
// + runEngCoder stages 端到端（spawn prompt 含 Staged execution 块）与无效 stages 拒绝。
// node:test 零依赖；T9 fixture 为改动前现行输出的逐字节快照（现行 brief 是三个历史交付共同
// 依赖的契约——fixture 由 git HEAD 的原始 buildCoderBrief 生成，见交付报告）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { randomUUID, createHmac } from "node:crypto"
import { fileURLToPath } from "node:url"
import { dirname, join, resolve } from "node:path"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { buildCoderBrief, validateStages, STAGES_MAX, runEngCoder } from "../lib/eng.mjs"
import { sessionState, dropSession } from "../lib/state.mjs"
import { apply } from "../lib/index.mjs"

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// 屏蔽宿主 DSH_HOME：本文件 runEngCoder 用例传 storPathOverride 临时目录（防 warn 噪声之外
// 不碰真实盘）；apply() 接线用例读 config user 层 → 无 env 时探测回落 null（不读真实 profile）。
process.env.DSH_HOME = ""

const mkHome = () => mkdtempSync(join(tmpdir(), "thincoder-f13-"))
const rmHome = (h) => { try { rmSync(h, { recursive: true, force: true }) } catch { /* 已清理 */ } }
const readFixture = (name) => readFileSync(new URL("./fixtures/" + name, import.meta.url), "utf8")

/** 铸造一枚格式合法的 design token（uuid:expiresAt:hmac16）。 */
function makeToken(expiresAt = Date.now() + 3600_000) {
  const secret = process.env.THINCODER_TOKEN_SECRET || "thincoder-default-secret"
  const payload = randomUUID() + ":" + expiresAt
  return payload + ":" + createHmac("sha256", secret).update(payload).digest("hex").slice(0, 16)
}

/** eng 会话 fixture：engineering=true + 有效 token。 */
function makeEngState(id) {
  const state = sessionState(id)
  state.engineering = true
  state.designToken = makeToken()
  return state
}

/** eng_coder deps stub：subagents.start 收集 request 并返回固定交付报告。 */
function makeEngDeps(id, dshHome, started) {
  const subagents = {
    async start(kind, req) {
      started.push(req)
      return {
        result: Promise.resolve({
          output: [{ type: "text", text: "delivered ok\n\nTouched files: lib/a.mjs" }],
          stopReason: "completed", diagnostic: null,
        }),
        dispose: async () => {},
      }
    },
  }
  return {
    ctx: { subagents },
    agent: { session: { id, header: { cwd: PLUGIN_DIR } }, options: { provider: "p", model: "m" } },
    config: {}, signal: undefined, configDefaultEngineering: false, storPathOverride: dshHome,
  }
}

/** apply() 接线用 fake ctx（同 session-state.test.mjs 的形状——测试文件隔离，无法共享 helper）。 */
function makeFakeCtx() {
  const sections = []
  const registeredTools = []
  const handlers = new Map()
  return {
    sections, registeredTools,
    on: (ev, fn) => {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
      return () => {}
    },
    emit: (ev, payload) => { for (const fn of handlers.get(ev) ?? []) fn(payload) },
    effect: (fn) => { const d = fn?.(); return () => d?.() },
    systemPrompt: { section: (opts) => { sections.push(opts); return () => {} } },
    tools: { register: (t) => { registeredTools.push(t); return () => {} } },
    get: () => null,
  }
}

const validStage = (n) => ({
  goal: "goal " + n, files: ["lib/a" + n + ".mjs"], acceptance: "acceptance " + n, check: "node --check lib/a" + n + ".mjs",
})

// ————————————— T9：stages 缺省 → 逐字节等于现行（fixture 回归锁） —————————————

test("T9: stages omitted → buildCoderBrief output is byte-identical to the pre-F13 fixture (with docs / without docs / undefined / null)", () => {
  const withDocs = buildCoderBrief("implement the design doc", ["docs/2026-09-02-session-state-stages-design.md", "docs/other.md"])
  const fixtureWith = readFixture("coder-brief-with-docs.txt")
  assert.ok(Buffer.compare(Buffer.from(withDocs, "utf8"), Buffer.from(fixtureWith, "utf8")) === 0,
    "byte-identical (with docs)\n--- actual ---\n" + withDocs + "\n--- fixture ---\n" + fixtureWith)
  const noDocs = buildCoderBrief("implement the design doc", [])
  const fixtureNo = readFixture("coder-brief-no-docs.txt")
  assert.ok(Buffer.compare(Buffer.from(noDocs, "utf8"), Buffer.from(fixtureNo, "utf8")) === 0,
    "byte-identical (no docs)")
  // undefined/null/空数组 stages 同样走现行路径
  assert.equal(buildCoderBrief("t", ["docs/d.md"], undefined), buildCoderBrief("t", ["docs/d.md"]))
  assert.equal(buildCoderBrief("t", ["docs/d.md"], null), buildCoderBrief("t", ["docs/d.md"]))
  assert.equal(buildCoderBrief("t", ["docs/d.md"], []), buildCoderBrief("t", ["docs/d.md"]))
})

// ————————————— T10：stages 渲染 + 校验 —————————————

test("T10: stages rendering — numbered four-part sections per stage; existing clauses and tail-line convention untouched", () => {
  const stages = [
    { goal: "extract dsh-home", files: ["lib/dsh-home.mjs", "lib/token-store.mjs"], acceptance: "token-store imports dsh-home", check: "node --check lib/dsh-home.mjs" },
    { goal: "session store", files: ["lib/session-store.mjs"], acceptance: "save/load roundtrip", check: "node --test test/session-state.test.mjs" },
  ]
  const brief = buildCoderBrief("implement the design", ["docs/d.md"], stages)
  assert.ok(brief.includes("### Stage 1 — extract dsh-home"), brief.slice(0, 400))
  assert.ok(brief.includes("### Stage 2 — session store"))
  for (const label of ["Files:", "Acceptance:", "Self-check:"]) {
    assert.equal(brief.split(label).length - 1, 2, label + " appears once per stage")
  }
  assert.ok(brief.includes("- lib/dsh-home.mjs"))
  assert.ok(brief.includes("- lib/token-store.mjs"))
  assert.ok(brief.includes("node --check lib/dsh-home.mjs"))
  assert.ok(brief.includes("node --test test/session-state.test.mjs"))
  // 既有固定条款与尾行约定不动（parseTouchedFiles 兼容）
  assert.ok(brief.includes("Touched files: <paths>"))
  assert.ok(brief.includes("Do NOT run destructive git commands (rebase / reset --hard / clean -f / push --force)"))
  assert.ok(brief.includes("Do not modify any file not listed in the design."))
  // 阶段块位置：Docs 段之后、固定条款之前
  assert.ok(brief.indexOf("## Staged execution") > brief.indexOf("## Docs involved"))
  assert.ok(brief.indexOf("## Staged execution") < brief.indexOf("Implement to the full design"))
})

test("T10-validate: validateStages rejects missing check / empty files / empty strings / non-object / over max; exactly 10 passes", () => {
  assert.equal(validateStages([{ goal: "g", files: ["a"], acceptance: "a" }]).ok, false, "missing check")
  assert.equal(validateStages([{ goal: "g", files: [], acceptance: "a", check: "c" }]).ok, false, "empty files")
  assert.equal(validateStages([{ goal: "g", files: ["a", ""], acceptance: "a", check: "c" }]).ok, false, "blank file entry")
  assert.equal(validateStages([{ goal: "", files: ["a"], acceptance: "a", check: "c" }]).ok, false, "empty goal")
  assert.equal(validateStages([{ goal: "g", files: ["a"], acceptance: "  ", check: "c" }]).ok, false, "blank acceptance")
  assert.equal(validateStages([{ goal: "g", files: ["a"], acceptance: "a", check: "" }]).ok, false, "empty check")
  assert.equal(validateStages(["not an object"]).ok, false, "string entry")
  assert.equal(validateStages([null]).ok, false, "null entry")
  assert.equal(validateStages("nope").ok, false, "not an array")
  assert.equal(validateStages([]).ok, false, "empty array")
  assert.equal(validateStages(Array.from({ length: STAGES_MAX + 1 }, (_, i) => validStage(i))).ok, false, "over maxItems 10")
  const ten = validateStages(Array.from({ length: STAGES_MAX }, (_, i) => validStage(i)))
  assert.equal(ten.ok, true, "exactly 10 passes")
  assert.equal(ten.stages.length, 10)
  assert.equal(validateStages([validStage(0)]).ok, true)
  // 净化副本：字段照抄、结构独立
  const one = validateStages([{ goal: "g", files: ["a.mjs"], acceptance: "ac", check: "ck", extra: "dropped" }])
  assert.equal(one.ok, true)
  assert.deepEqual(one.stages[0], { goal: "g", files: ["a.mjs"], acceptance: "ac", check: "ck" })
})

test("T10-schema: registered eng_coder tool schema carries the stages constraints (maxItems 10, items.required, minLength 1 / minItems 1)", () => {
  const fakeCtx = makeFakeCtx()
  apply(fakeCtx, {})
  const tool = fakeCtx.registeredTools.find(t => t.name === "eng_coder")
  assert.ok(tool, "eng_coder registered")
  const stages = tool.parameters.properties.stages
  assert.ok(stages, "stages parameter present")
  assert.equal(stages.type, "array")
  assert.equal(stages.maxItems, 10)
  assert.deepEqual(stages.items.required, ["goal", "files", "acceptance", "check"])
  assert.equal(stages.items.type, "object")
  assert.equal(stages.items.properties.goal.minLength, 1)
  assert.equal(stages.items.properties.acceptance.minLength, 1)
  assert.equal(stages.items.properties.check.minLength, 1)
  assert.equal(stages.items.properties.files.minItems, 1)
  assert.equal(stages.items.properties.files.items.minLength, 1)
  // 既有参数不动
  assert.deepEqual(tool.parameters.required, ["task", "designToken"])
  assert.ok(tool.parameters.properties.docs)
  assert.ok(tool.description.includes("stages"))
})

// ————————————— T11：stage 表前置指令 + 预算将尽条款 —————————————

test("T11: stages-mode brief contains the stage-status-table-first directive and the budget-nearly-exhausted survival clause", () => {
  const brief = buildCoderBrief("do it", [], [validStage(0)])
  // stage 表前置指令（§3.1——F9 max-tokens 掐断生存性设计）
  assert.ok(brief.includes("stage status table"))
  assert.ok(brief.includes("passed/failed/skipped"))
  assert.ok(brief.includes("check summary"))
  assert.ok(brief.includes("MUST START with the stage status table"))
  // 预算将尽条款（§3.3-3）
  assert.ok(/budget/i.test(brief), "budget clause present")
  assert.ok(brief.includes("nearly exhausted"))
  assert.ok(brief.includes("stop opening new stages"))
  assert.ok(brief.includes("finish the current stage's self-check"))
  // 纪律段（§3.1/§3.2）
  assert.ok(brief.includes("Execute the stages in order"))
  assert.ok(brief.includes("touch only that stage's files"))
  assert.ok(brief.includes("STOP"))
  assert.ok(brief.includes("second genuine fix attempt"))
})

// ————————————— T12：漂移探测（stages 缺省但 task 匹配 /stage|阶段\s*\d/i） —————————————

test("T12: drift detection — no stages but task mentions 'stage 2' / '阶段 2' → warning prefix on the return; clean task → no warning", async () => {
  const home = mkHome()
  const sid = "f13-t12-" + randomUUID()
  try {
    makeEngState(sid)
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, home, started), {
      task: "fix the bug described in stage 2 of the plan", designToken: sessionState(sid).designToken,
    })
    assert.ok(out.includes("[thincoder-suite] warning:"), "warning prefix: " + out.slice(0, 200))
    assert.ok(out.includes("stages"), "warning names stages")
    assert.ok(out.includes("eng_coder delivery:"), "warning does not block execution")
    dropSession(sid)

    const sid2 = "f13-t12b-" + randomUUID()
    makeEngState(sid2)
    const started2 = []
    const out2 = await runEngCoder(makeEngDeps(sid2, home, started2), {
      task: "implement the feature end to end", designToken: sessionState(sid2).designToken,
    })
    assert.ok(!out2.includes("[thincoder-suite] warning:"), "clean task → no warning (existing byte-path)")
    assert.ok(out2.includes("eng_coder delivery:"))
    dropSession(sid2)

    // 中文漂移：阶段 2
    const sid3 = "f13-t12c-" + randomUUID()
    makeEngState(sid3)
    const started3 = []
    const out3 = await runEngCoder(makeEngDeps(sid3, home, started3), {
      task: "按 阶段 2 的说明实现", designToken: sessionState(sid3).designToken,
    })
    assert.ok(out3.includes("[thincoder-suite] warning:"), "Chinese drift detected: " + out3.slice(0, 160))
    assert.ok(out3.includes("eng_coder delivery:"))
    dropSession(sid3)
  } finally {
    rmHome(home)
  }
})

// ————————————— runEngCoder 集成：无效 stages 拒绝 / 有效 stages 渲染进 spawn prompt —————————————

test("runEngCoder integration: invalid stages → explicit error return, no spawn (defensive validation, 确认项 5)", async () => {
  const sid = "f13-inv-" + randomUUID()
  try {
    makeEngState(sid)
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, undefined, started), {
      task: "implement x", designToken: sessionState(sid).designToken,
      stages: [{ goal: "g", files: ["a"], acceptance: "a" }], // 缺 check
    })
    assert.match(out, /^Error: invalid stages — stages\[0\]\.check must be a non-empty string/)
    assert.equal(started.length, 0, "no spawn on invalid stages")
    const out2 = await runEngCoder(makeEngDeps(sid, undefined, started), {
      task: "implement x", designToken: sessionState(sid).designToken,
      stages: Array.from({ length: 11 }, (_, i) => validStage(i)),
    })
    assert.match(out2, /^Error: invalid stages — stages supports at most 10 stages \(got 11\)/)
    assert.equal(started.length, 0)
  } finally { dropSession(sid) }
})

test("runEngCoder integration: valid stages render into the spawn prompt (Staged execution block after Docs involved)", async () => {
  const home = mkHome()
  const sid = "f13-e2e-" + randomUUID()
  try {
    makeEngState(sid)
    const started = []
    const out = await runEngCoder(makeEngDeps(sid, home, started), {
      task: "implement the staged design",
      designToken: sessionState(sid).designToken,
      docs: ["docs/d.md"],
      stages: [
        { goal: "alpha", files: ["lib/a.mjs"], acceptance: "a works", check: "node --check lib/a.mjs" },
        { goal: "beta", files: ["lib/b.mjs"], acceptance: "b works", check: "node --test test/b.test.mjs" },
      ],
    })
    assert.ok(out.includes("eng_coder delivery:"), out)
    assert.equal(started.length, 1)
    const prompt = started[0].prompt[0].text
    assert.ok(prompt.includes("## Docs involved"))
    assert.ok(prompt.includes("- docs/d.md"))
    assert.ok(prompt.includes("## Staged execution"))
    assert.ok(prompt.includes("### Stage 1 — alpha"))
    assert.ok(prompt.includes("### Stage 2 — beta"))
    assert.ok(prompt.includes("### Stage 1 — alpha\nFiles:\n- lib/a.mjs\nAcceptance:\na works\nSelf-check:\nnode --check lib/a.mjs"),
      "four-part section layout verbatim")
    assert.ok(prompt.includes("passed/failed/skipped"), "stage status table directive")
    assert.ok(prompt.includes("Touched files: <paths>"), "tail-line convention untouched")
    assert.ok(prompt.indexOf("## Staged execution") > prompt.indexOf("## Docs involved"))
    assert.ok(prompt.indexOf("## Staged execution") < prompt.indexOf("Implement to the full design"))
  } finally {
    dropSession(sid)
    rmHome(home)
  }
})
