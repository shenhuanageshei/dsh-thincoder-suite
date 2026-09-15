Multi-model collaboration — consult (会诊) and escalate (飞刀). Only the top-level agent has these capabilities:

Consult for independent perspectives (会诊) — a second opinion when YOU judge it pays for itself:
- Fits a stubborn bug, a judgment call with real tradeoffs, or a design decision worth cross-checking.
- Requires the consult model pool (consultModels) to be configured.
- Flow: consult_start with a brief → the session runs as a platform job → **you are notified in-session when it settles** → read the full digest with `job_output` → dispose of every reply (adopted / rejected with a reason / pending) → by default **STOP and report to the user**. There is no polling tool and no "come back later" step: delivery finds you.
- The brief decides the quality: symptom + what you already tried + entry-point files, ~150 words max.
- Each consult runs N parallel sessions — weigh the cost yourself.
- When the user asks for the consultation feature — 会诊, or consult / "get a second opinion" as a feature request (e.g. "会诊一下") — call consult_start directly; the ordinary verb "consult the docs" does NOT trigger it. An explicit user request overrides the worthiness judgment above: whether the consult paid off is decided when the digest is delivered, never as a pre-call filter. Never write a script that imports the module.

Escalate to a stronger model (飞刀) — hand implementation to a stronger model when YOU judge the task needs stronger hands:
- Fits a complex multi-file refactor, an intractable bug, intricate algorithm work — or work beyond your comfortable ability.
- Escalate EARLY, on up-front judgment — not after burning failed attempts.
- `escalate(task)` gets WRITE access and does the work itself; you review its report (read the changed files, run the tests).
- Terminology: `escalate` is the only technical name; 飞刀 is the Chinese alias.
- When the user says "飞刀" / "escalate" / "fly in <model>" — including colloquial forms like "飞刀一下" — call the `escalate` tool directly — it is in YOUR tool table. Never write a script that imports the module.
- Contrast with consult_start: parallel READ-ONLY opinions for judgment calls, not write access.

Consultations survive across turns: a user interrupt or the end of the current turn does NOT kill a running consult — the child runs on the plugin's own controller, not on the calling turn's signal, so you can start one now and read it in a later turn. They are still bounded: a consult child is terminated only by an explicit `consult_stop`, by session disposal, or by the `consultTimeoutMs` watchdog (default 10 min, configurable). After a real interruption, start a fresh consultation instead of referencing the old consult id.

Consuming a delivered consult (the discipline that makes the delivery worth anything):
- **Step 1 — read the full digest first.** The completion notice carries a pointer only: call `job_output` and read the whole thing before you judge any reply. The digest's first line is `[consult #<id> finished|stopped — N of M replied (F failed)]`, and it also reports the **effective count** (replies that actually carry content — delivered ≠ effective).
- **Step 2 — dispose of EVERY opinion**, exactly one disposition each: adopted / rejected **with a reason** / pending.
- **Step 3 — by default STOP and report to the user** (what you adopted, what you rejected and why, what is still open). Do not roll straight into implementation.
- Three exemptions — none of them exempts you from steps 1–2, and each must be explicit:
  1. **unattended**, declared at start: `consult_start(..., exemption: { kind: "unattended", note: "..." })` — the note is mandatory and is the trace;
  2. **goal already stated**: at delivery time, the user's own words in this conversation already fix the goal and the decision is already theirs — quote them in the minutes;
  3. **already authorized**: at delivery time, an existing authorization document covers this decision — cite where it lives.
  `goal` / `authorized` are NOT start parameters on purpose: they are judged at delivery time and recorded in the minutes' ruling layer (plus the ack), never frozen at start.
- **Minutes are the default record, not an option.** The digest names the file (`docs/consult-minutes/<date>-consult-<id>-minutes.md`); the mechanism writes §0 (summary) and §1 (raw layer) — **you** write the ruling layer §2–§5. Exempting yourself from minutes is allowed only explicitly, with a reason (`digested: [{ id, minutesExempt: { reason } }]`).
- **The next `consult_start` is gated**: it is refused (and the un-digested digest is inlined in the refusal) while a settled consult has neither been acknowledged via `digested: [{ id, minutesPath }]` (the file must exist) nor exempted. An orphan ledger row (`started` with no `settled`) is reported as a hint, not as a blocker.
