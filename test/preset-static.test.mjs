// preset-static.test.mjs — thincoder-eng preset 静态断言（docs/2026-09-02 §4 T6/T7，评审 #5/#6）。
// node:test 零依赖（node:fs + node:path）。EOL 归一化（CRLF/LF）后逐行比较。
//
// T6（评审 #6）：
//   ① preset 含 tool-bash / tool-pwsh 行，平台禁用条件与 DSH 内置 code（PTC）预设逐字一致
//     （bash 仅禁 win32、pwsh 仅禁非 win32，各恰一行）；
//   ② 既有行（persona / fs / planning / compaction 等「非 shell 区行集合」）与基线 fixture
//     逐行对比无变化——fixture = F10 交付态文件提取的「非 shell 区行集合」基线（shell 行
//     插入点带 @@SHELL_ROWS@@ sentinel）：未来任何对既有行的改动（如拿 DSH code preset
//     整文件覆盖 thincoder-eng、误删 persona/compaction 定制）都会触发整文件 diff。
// T7（评审 #5）：preset 无 tool-presentation（mode: code）行——工具集呈现保持 native
// （PTC 工具集 − code 呈现 + native，见文件头注释）。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const PRESET_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "..", "preset", "thincoder-eng", "agent.cordis.yml")

/** shell 工具行（DSH 内置 code preset agent.cordis.yml:51-57 逐字一致，docs/2026-09-02 §2.2）。 */
const SHELL_ROWS = [
  "- id: tool-bash",
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  "",
  "- id: tool-pwsh",
  "  name: '@deepseek-ai/dsh-tool-pwsh'",
  "  disabled: !!js process.platform !== 'win32'",
].join("\n")

/** 非 shell 区基线 fixture：F10 交付态文件去掉 shell 工具行后，在原插入点留 @@SHELL_ROWS@@。 */
const PRESET_STABLE_FIXTURE = `# The \`thincoder-eng\` agent preset: engineering mode from the first message.
#
# Composition = the DSH built-in code (PTC) agent-preset toolset
# (@deepseek-ai/dsh/config/agent-presets/code) MINUS its Code-Mode presentation:
# native presentation kept (PTC toolset + native — no tool-presentation row),
# fitting the architect/dialogue role of this preset. Shell rows below mirror
# the code preset's platform gating verbatim (tool-bash/tool-pwsh); sync tool
# additions from it on DSH upgrades (additions only — rows and persona stay).
# The thincoder mechanism
# itself comes from the GLOBALLY installed @dsh-external/dsh-thincoder-suite
# plugin (advisor / eng / eng_coder / escalate / consult are host-plane tools).
#
# The engineering-mode entry: the plugin watches 'agent/session-start' and
# recognizes this preset's id — a session composed from thincoder-eng starts
# with engineering ON automatically (architect role, design-before-code gates).
# No realm duplication of the plugin, no second fiber: the preset is the
# one-click entry, the plugin is the mechanism.

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are the architect of an engineering-mode session, powered by the {{model}} model, working in {{cwd}}. Your deliverables are requirements and design documents and approved implementation plans — not code. You clarify with open-ended questions, you write design docs before any implementation, and the design review is fired by the USER, never by you. Implementation goes through eng_coder sub-agents carrying a design token from a passed advisor(type='design') review. After each eng_coder delivery you run the delivery review automatically. You end every turn by naming your current workflow state and what the user must do next.

- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
  config:
    maxBytes: 65536


# ── shell ───────────────────────────────────────────────────────────────────

# \`shell-env\` stays in the HOST composition: \`apps/cli/src/web.ts\` injects it to
# publish \`DSH_WEB_URL\`/\`DSH_WEB_MODE\`, and a host row that injects a service is
# the criterion for host-plane ownership — injection resolves before any session
# exists, so there is no agent to key by. Behind a preset realm those variables
# never reached the model's shell at all. Both shell tools consume the host
# registry from here; their executors (\`bash-sandbox\`/\`pwsh-sandbox\`) are
# host-plane too.
@@SHELL_ROWS@@

# ── filesystem ──────────────────────────────────────────────────────────────

# Both register into the host \`tools\` registry and provide nothing, so
# they need no realm. The \`fs\` service and its policy stay in the host.
- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: tool-fs-search
  name: '@deepseek-ai/dsh-tool-fs-search'
  config:
    sampleOverCapGlobResults: false

- id: tool-str-replace-editor
  name: '@deepseek-ai/dsh-tool-str-replace-editor'

# ── background jobs ────────────────────────────────────────────────────────

# Only the model-facing controls. The task REGISTRY stays on the host plane:
# its producers sit outside any realm this file could put it in — \`tool-bash\`
# above resolves it with \`ctx.get\`, and an entry-local realm here is invisible
# to every sibling row, so \`run_in_background\` would answer "background jobs
# unavailable" while these controls sat in the catalog. The registry is keyed by
# owning agent anyway, so one host instance serves every session. What a preset
# chooses is whether its agent can collect and stop background work at all.
- id: tool-jobs
  name: '@deepseek-ai/dsh-tool-jobs'

# ── skills ──────────────────────────────────────────────────────────────────

# The skill REGISTRY lives in the host composition and is layered per scope:
# these rows register into THIS preset's layer of it, so they need no realm.
# \`skill-filesystem\` contributes local-root discovery for agents on this preset, and
# \`tool-skill\` gives them the catalog and loader; the merged catalog also
# carries whatever the deployment registered globally (repository plugins).
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'

- id: tool-skill
  name: '@deepseek-ai/dsh-tool-skill'

# ── goals ───────────────────────────────────────────────────────────────────

# Only the model-facing tool. The goal SERVICE, its session driver, and the
# \`/goal\` command stay on the host plane: the Gateway serves the goal domain as
# Remote endpoints whose receiver comes from a generated descriptor, so it
# resolves \`goals\` on the host and an entry-local realm here would hide it. The
# registry is keyed by session anyway, so one host instance serves every
# session. What a preset chooses is whether its agent can call the goal tool.
- id: tool-goal
  name: '@deepseek-ai/dsh-tool-goal'

# ── plan mode ───────────────────────────────────────────────────────────────

# Plan state is per-agent by nature, so an entry-local realm is not a
# workaround here — it is the correct lifetime.
- id: planning
  name: cordis:group
  group: true
  isolate:
    planMode: true
  config:
    - id: plan-mode
      name: '@deepseek-ai/dsh-plan-mode'
      config:
        section: |
              You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

              Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

              The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

              Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

              Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

              When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.

# ── compaction ──────────────────────────────────────────────────────────────

# \`compaction-basic\` reads \`toolResultPrune\` through \`ctx.get\`, so the pruner must
# share this realm rather than sit outside it.
#
# \`tokenMeter\` is deliberately NOT in this realm: the meter stays on the HOST
# plane, and the rows here resolve that one instance. It takes no configuration,
# keys every fold by Session, and owns the context-meter projection units the
# browser reads for every session — behind a realm those units would come and go
# with whichever presets happen to be mounted. What a preset chooses is whether
# its agent compacts at all, which is \`compaction-basic\` below.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
      config:
        thresholdRatio: 0.55
        retainRatio: 0.2

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024

# ── delegation and workflows ────────────────────────────────────────────────

# The \`subagents\` registry and its spawn/fork backends live in the HOST
# composition: the registry is a process singleton whose cross-session queries
# the api-proxy serves to the browser, and a provider name may only be
# registered once. This preset contributes the delegation TOOLS, which resolve
# that host registry.
#
# \`workflows\` is different — nothing outside an agent reads it — so every row
# that reaches it shares one entry-local realm here, and a consumer left
# outside would resolve a host registry this preset does not populate.
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent-control
      name: '@deepseek-ai/dsh-tool-subagent-control'

    - id: tool-subagent-list-agents
      name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
        backgroundMode: continuable

    - id: tool-subagent-fork
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: fork
        toolName: subagent_fork
        backgroundMode: continuable

    # Product providers are host-plane singletons. Copy this preset, then
    # remove \`disabled\` from either ordinary tool row to expose that product
    # only to agents composed from the copy.
    - id: tool-subagent-codex
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: codex
        toolName: subagent_codex
        enableRunInBackground: false
        maxDepth: provider-managed

    - id: tool-subagent-claude-code
      name: '@deepseek-ai/dsh-tool-subagent'
      disabled: true
      config:
        provider: claude-code
        toolName: subagent_claude_code
        enableRunInBackground: false
        maxDepth: provider-managed

    - id: workflow-worker-thread
      name: '@deepseek-ai/dsh-workflow-worker-thread'
      config:
        provider: spawn

    - id: tool-workflow
      name: '@deepseek-ai/dsh-tool-workflow'

    - id: tool-ralph
      name: '@deepseek-ai/dsh-tool-ralph'
      config:
        subagentProvider: spawn
        maxRounds: 64

# ── remaining model-facing rows ─────────────────────────────────────────────

- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'

- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true

# The \`web\` service and its search provider stay in the host composition; only
# the model-facing tool is per-session.
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000

# ── presentation ────────────────────────────────────────────────────────────

# Native presentation: router-bootstrap calls toolsSvc.presentAs('native') at
# phase_begin; tools are directly callable — no Code Mode / SDK row here.`

/** 归一化行数组（CRLF→LF，去尾随空元素）——比较两端使用同一规则。 */
function linesOf(s) {
  const lines = String(s).replace(/\r\n/g, "\n").split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** 首个差异位置（行号，1-based）或 null。 */
function firstDiffIndex(a, b) {
  const n = Math.max(a.length, b.length)
  for (let k = 0; k < n; k++) {
    if (a[k] !== b[k]) return k + 1
  }
  return null
}

test("T6: preset has tool-bash/tool-pwsh rows with exact platform gating; non-shell lines match the baseline fixture", () => {
  const raw = readFileSync(PRESET_PATH, "utf8")
  const text = raw.replace(/\r\n/g, "\n")

  // —— ① shell 行存在性 + 平台禁用条件（与 code preset 逐字一致）——
  for (const row of SHELL_ROWS.split("\n")) {
    assert.ok(text.includes(row), "missing shell row line: " + row)
  }
  assert.equal(text.split("disabled: !!js process.platform === 'win32'").length - 1, 1,
    "tool-bash disabled-on-win32 appears exactly once")
  assert.equal(text.split("disabled: !!js process.platform !== 'win32'").length - 1, 1,
    "tool-pwsh disabled-off-win32 appears exactly once")

  // —— ② 既有行与基线 fixture 全等（fixture 换入 shell 行后 == 当前文件）——
  assert.ok(PRESET_STABLE_FIXTURE.includes("@@SHELL_ROWS@@"),
    "fixture carries the shell-rows sentinel (fixture must be generated from the delivered file)")
  const expected = linesOf(PRESET_STABLE_FIXTURE.replace("@@SHELL_ROWS@@", SHELL_ROWS))
  const current = linesOf(raw)
  const diffAt = firstDiffIndex(expected, current)
  assert.equal(diffAt, null,
    "non-shell baseline drifted from the F10-delivered fixture — first difference at line "
    + diffAt + ":\n  expected: " + JSON.stringify(expected[diffAt - 1])
    + "\n  actual:   " + JSON.stringify(current[diffAt - 1])
    + (expected.length === current.length ? "" : " (line count " + expected.length + " vs " + current.length + ")"))
})

test("T7: preset has no tool-presentation (mode: code) row — native presentation", () => {
  const text = readFileSync(PRESET_PATH, "utf8").replace(/\r\n/g, "\n")
  assert.ok(!/^\s*- id: tool-presentation\b/m.test(text),
    "no tool-presentation row (Code Mode SDK) may be added (the word may only appear in header docs)")
  assert.ok(!text.includes("dsh-agent-tool-presentation"), "no SDK presentation service row may be added")
  assert.ok(!/mode:\s*code/.test(text), "no mode: code presentation config")
  // 头部注释说明 PTC 工具集 + native 呈现（docs/2026-09-02 §2.2 头部注释更新）
  assert.ok(text.includes("PTC"), "header documents the PTC toolset composition")
  assert.ok(text.includes("native"), "header documents native presentation")
  assert.ok(text.startsWith("# The `thincoder-eng` agent preset"), "preset header intact")
})

// ═════════════════ 批 3：提示词 ↔ 解析器防漂移静态断言（设计档 §7.3 AC-V13…V15c） ═════════════════
// docs/2026-09-12-review-protocol-design.md。N3：提示词与解析器同批改动由用例**互锁** ——
// 契约字面串钉死在提示词里，解析器（lib/advisor.mjs 的 parseVerdict）的过滤器与之同源。

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "prompts")
const PLUGIN_ROOT = resolve(PROMPTS_DIR, "..", "..")
const readPrompt = (name) => readFileSync(resolve(PROMPTS_DIR, name), "utf8")
const readPluginFile = (rel) => readFileSync(resolve(PLUGIN_ROOT, rel), "utf8")

const ADVISOR_PROMPTS = ["advisor-round1.md", "advisor-round2.md", "advisor-round3.md", "advisor-design.md"]

test("AC-V13: all four advisor prompts carry the VERDICT contract (literal `VERDICT: PASS` / `VERDICT: FAIL`); the Approval-Signal builders state the ordering", () => {
  for (const name of ADVISOR_PROMPTS) {
    const text = readPrompt(name)
    assert.ok(text.includes("VERDICT: PASS"), name + " 缺契约字面串 `VERDICT: PASS`")
    assert.ok(text.includes("VERDICT: FAIL"), name + " 缺契约字面串 `VERDICT: FAIL`")
    assert.ok(/last non-empty line/i.test(text), name + " 必须写明「末行」")
    assert.ok(text.includes("Never translate this token"), name + " 必须显式声明该 token 不译（§4.1）")
    // —— 收口轮（评审 #2）：malformed/misplaced = invalid（硬拒不回落，决策 D-f），
    // 措辞必须写成 **refused**；写「counts as no verdict at all」会诱导后人把 malformed
    // 路由成 absent → 静默重开 D-f 要堵的洞（`VERDICT: FAIL` + 尾部垃圾 + 通过散文 → 经回落签发）。
    assert.ok(text.includes("counts as a **refused** verdict"),
      name + " malformed/misplaced 必须表述为 **refused**（硬拒不回落），不得读成 absent")
    assert.ok(text.includes("the host never falls back"),
      name + " 必须明说 refused ≠ absent：绝不回落到散文启发式")
    assert.ok(!text.includes("**no verdict at all**"),
      name + " 负向锁：不得再写「counts as **no verdict at all**」（= absent 语义，与实现相反）")
  }
  // AC-V13 后半：两处 Approval-Signal 构建（design round-1 与 design 收敛轮）都写有次序句
  const msgs = readPluginFile("lib/advisor-msgs.mjs")
  const ordering = msgs.match(/immediately ABOVE the `VERDICT:` line/g) ?? []
  assert.equal(ordering.length, 2, "advisor-msgs.mjs 的两处 Approval-Signal 构建各需一条「回显在 verdict 行上方」次序句，实得 " + ordering.length)
})

// —— 批 3 收口轮（评审 #1）：一揽子句必须带 must-fix 例外 ——
// 成因：AC-V13 只钉了契约字面串，没钉「🟡/🔵 不阻塞」这类**一揽子句**。于是提示词说
// 「普通 🟡 不阻塞」，而宿主门禁（lib/advisor.mjs 的 hasUnresolvedBlockingRow + MUST_FIX_RE）
// 把严重度单元格字面为 `🟡 must-fix` 的行当阻塞 —— 评审员按指示留下 must-fix 🟡 又写
// `VERDICT: PASS`，宿主判「verdict 与表格矛盾」拒签，用户白跑一整轮评审。
// 例外句在四处一揽子句后各出现一次（round1 / design / 两处 Approval-Signal 构建）。
// 批 3 收尾轮（补齐同类漏例外）：收敛轮 round2/round3 的同一形态一揽子句此前漏了该例外 ——
// 而**收敛轮正是评审员决定要不要写 `VERDICT: PASS` 的地方**，漏档代价高于前四处（留下
// `🟡 must-fix` + `PASS` → 宿主拒签 → 白跑一整轮评审）。故断言由「两档」扩为**四份提示词
// 全覆盖**（防止漏档复现），并逐份钉住「恰好一次」以免同一句被复制两遍掩掉别处的漏档。
const MUST_FIX_EXCEPTION = "a row whose severity cell is literally `🟡 must-fix` **does** block approval — exactly like an unresolved 🔴"

test("AC-V13b (#1): every blanket 「🟡/🔵 do not block」 sentence carries the must-fix exception (no prompt↔host contradiction), in all four advisor prompts", () => {
  for (const name of ADVISOR_PROMPTS) {
    const text = readPrompt(name)
    assert.ok(text.includes(MUST_FIX_EXCEPTION), name + " 缺 must-fix 例外句（一揽子句与宿主门禁的矛盾未消除）")
    assert.ok(text.includes("A plain 🟡 or 🔵 never blocks"), name + " 例外句必须同时明说普通 🟡/🔵 不阻塞")
    assert.equal(text.split(MUST_FIX_EXCEPTION).length - 1, 1,
      name + " 的 must-fix 例外句应恰出现一次（多处即掩盖别处漏档）")
  }
  const msgs = readPluginFile("lib/advisor-msgs.mjs")
  assert.equal(msgs.split(MUST_FIX_EXCEPTION).length - 1, 2,
    "advisor-msgs.mjs 的两处 Approval-Signal 构建各需一条 must-fix 例外句")
})

test("AC-V14: the four-value vocabulary (Fixed / Dispatched / Not an issue / Deferred) is synced in all four places; no closed three-value phrasing remains", () => {
  const VOCAB_PLACES = ["lib/prompts/discipline.md", "lib/prompts/engineering.md", "lib/index.mjs", "README.md"]
  const THREE_VALUE = /exactly three values|三值|three values/i
  for (const rel of VOCAB_PLACES) {
    const text = readPluginFile(rel)
    assert.ok(text.includes("Dispatched"), rel + " 缺 `Dispatched`（词表未同步到四值）")
    assert.ok(text.includes("Fixed") && text.includes("Not an issue") && text.includes("Deferred"), rel + " 四值词表不完整")
    assert.ok(!THREE_VALUE.test(text), rel + " 仍含封三值表述（不得再有 exactly three values / 三值）")
  }
  // 收敛轮的 Dispatched 语义句：未验证即未解决（round2 / round3 各需一条）
  for (const name of ["advisor-round2.md", "advisor-round3.md"]) {
    const text = readPrompt(name)
    assert.ok(text.includes("means the fix was delegated and is **unverified**"), name + " 缺「Dispatched = 未验证即未解决」句")
    assert.ok(/treat the item as \*\*open\*\*/.test(text), name + " 缺「未验证即视为 open」句")
    assert.ok(text.includes("unresolved `Dispatched` 🔴 blocks `VERDICT: PASS`"), name + " 缺「未落地的 Dispatched 🔴 阻塞 PASS」句")
  }
})

test("AC-V15: R1 is folded into the design prompt's Document-ownership block (domain split) and the R7e sentence is in place", () => {
  const design = readPrompt("advisor-design.md")
  assert.ok(design.includes("Document ownership severity (R1"), "R1 未并入 Document-ownership 块")
  assert.ok(design.includes("Same mechanism described differently in two places"), "缺「同机制两处不同」分域句")
  assert.ok(design.includes("document vs **document**") && design.includes("document vs **reality**"),
    "缺「同机制（文档 vs 文档）→ 🔴 / 文档态（文档 vs 现实）→ 🟡」的对象分域句（R7a 的必须显式点名对象）")
  assert.ok(design.includes("R7e"), "缺 R7e 句")
  assert.ok(/document-state contradiction never blocks approval/i.test(design),
    "R7e 句未表达「文档态矛盾永不阻塞通过」")
})

test("AC-V15b: R-rule anchors across the four prompts (R2 in round1 / R3 issue-level in round2+3 / R4 / R5)", () => {
  const r1 = readPrompt("advisor-round1.md")
  assert.ok(r1.includes("R2 Implementation deviates from the design"), "round1 缺 R2 句")
  assert.ok(r1.includes("Project Guide (AGENTS.md)"), "R2 必须点名 Project-Guide 为参照")
  assert.ok(r1.includes("R4 Fragile test") && r1.includes("concrete suggestion that makes it deterministic"),
    "round1 缺 R4（脆弱测试 → 🔵 + 确定性建议）")
  assert.ok(r1.includes("R5 Scope coordination") && r1.includes("coordination item") && r1.includes("plain** 🟡"),
    "round1 缺 R5（范围协调 → 普通 🟡「协调项」，永不带 must-fix）")
  assert.ok(r1.includes("R7e NEVER let a document-state contradiction block a pass"), "round1 缺 R7e 执行面句")
  assert.ok(r1.includes("`🟡 must-fix`"), "round1 必须写明阻塞标记的字面形态")
  for (const name of ["advisor-round2.md", "advisor-round3.md"]) {
    const text = readPrompt(name)
    assert.ok(text.includes("R3 (issue level)"), name + " 缺 R3 议题级扩展句")
    assert.ok(text.includes("must NOT be re-raised at the same or a higher severity"),
      name + " R3 句必须表达「不得以同等或更高严重度重提已裁决项」")
  }
})

test("AC-V15c: the fake promise is gone — round1 no longer claims the host recognizes the marker, and the consumer is the requesting agent", () => {
  const r1 = readPrompt("advisor-round1.md")
  assert.ok(!r1.includes("The host recognizes it"), "负向断言：`The host recognizes it` 必须已被删除（假承诺）")
  assert.ok(!/host recognizes/i.test(r1), "不得以任何形式声称「宿主识别」代码评审结论")
  assert.ok(r1.includes("requesting agent (the caller)"), "替换句的消费方必须改口为发起方/主代理")
  assert.ok(r1.includes("The host itself makes no pass/fail judgement on a **code** review"),
    "必须直说宿主不对 code 评审做判定（否则只是把一句假话换成另一句假话）")
  assert.ok(r1.includes("machine-readable to the caller"), "必须说明 VERDICT 行才是机器可读结论")
  assert.ok(r1.includes("`\"All clear — no code changes to review.\"`"), "all-clear 短语本身保留（既有行为不变）")
})
