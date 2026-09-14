Review discipline (standard mode only — engineering mode has its own review timing rules):
- **Advisor:** call after changing code. Must provide scope: `paths` (files/dirs to review) or `documents` (context).
- **After each advisor review, reply with a response table** — exact header `| # | Action | Detail |` (the runtime extracts this header; keep it verbatim). One row per issue; `#` = the advisor's issue number (`Orig#` on rounds 2+).
  - `Action` is one of four values: `Fixed` (you edited the code), `Dispatched` (the fix is delegated to a subagent / background job and has NOT yet returned a verified result — say in the Detail what it was dispatched to), `Not an issue` (technical rebuttal with evidence), `Deferred` (admitted, not fixed now — with a reason).
  - `Dispatched` is a claim of **ownership, never a claim of resolution** — an unverified `Dispatched` 🔴 blocks convergence exactly like an unfixed 🔴. `Detail` on a `Dispatched` row MUST name what it was dispatched to (job/subagent id or a concrete description), otherwise it is indistinguishable from stalling.
  - `Detail` = what changed and where (file:line), or your evidence/reason.
- **No "pre-existing" cop-out.** You own the whole code. "It was already broken" / "I didn't introduce it" is never a reason to skip a fix — when a defect appeared does not decide whether it should be fixed, and earlier agent turns created it. Rebut only on technical grounds, otherwise fix it.
- **Do not bury 🔴.** A 🔴 you neither fix nor rebut blocks convergence. `Deferred` fits 🟡/🔵 improvements or a 🔴 needing a user decision first — never a way to silently drop a real defect; surface any unresolved 🔴 to the user.
- Round 2 verifies the prior table + flags obvious new issues; round 3+ strictly verifies only the prior table (no new-issue hunting). Max 5 rounds total.
- When the advisor reports all clear, the convergence loop is done — proceed to delivery. "All clear" means the advisor's final reply ends with `VERDICT: PASS` (the older prose markers — "no 🔴 remaining", "review passed" — still count, as they fall back to the same judgement).

**文档卫生（五条；违反 = advisor 🔵 起步）**
1. **计数与列表同改**：任何「N 项/N 处/N 条」声明，改列表必须同一次编辑改计数；
   计数须来自当次实测（grep / 读档），不得抄自记忆或旧档。
2. **指针可解析**：引用本仓文档用「档名：§节」；禁「见上/见该节」；行号只作 as-of 括注。
3. **写后回读**：任何写入后回读被改区域（目标锚点仍在 / 全文无替换字符 U+FFFD / 行数与预期增删一致）
   再报完成；结构性改档用编辑工具，禁 shell 单行脚本整档重写。
4. **状态行与事实同步**：状态/版本/日期类声明改一处，必须全库检索同类声明同改。
5. **描述面与实现一致**：注释与模型可见描述（工具 description / 参数说明）不得与代码现状矛盾；
   语义变更同批同步。