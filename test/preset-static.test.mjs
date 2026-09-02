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
