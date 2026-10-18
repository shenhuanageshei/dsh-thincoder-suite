// preset-readonly-guard.mjs — 批 41（台账 t-6 / 设计档 docs/2026-10-18-consult-preset-drift-design.md §五 FR-1）：
// 「只读会诊预设的**内容漂移**」检测的**纯函数 + 常量**。
//
// ★ **本档零副作用**：无 IO、无网络、无时间、无随机、无模块级可变状态、不碰宿主服务对象。
//   为什么这条声明能成立（设计档 §五 FR-2「函数归属」/ 评审 #4）：要摸服务对象的
//   verifyReadonlyPresetContent(presets) **住 lib/consult.mjs**；住在这里的只有可纯测的判据与文案表。
//
// ★ **语义两层**（D-1；原第三层「禁用能力词表」已被评审 #1 判为假腿并删除）：
//   ① checkModuleSet = 模块集合**精确等值**（**唯一**的模块层判据）；
//   ② checkDocFlags = 关键配置**双向**判据（交付评审 #1）：**反向**扫 write: true / edit: true，
//      **正向**要求 tool-fs 那一项**显式**写死 write: false **且** edit: false（平台缺省 true）。
//   WRITE_CAPABLE_TOKENS **不承担判据**：① 是精确等值 ⇒ 任何多出来的模块都已被 ① 拒掉，
//   词表层永远只可能看到发货集合本身 ⇒ 若让它判红，那条断言**永远是绿的**（恒真 / 假腿）。
//   它只作 explainModule 的**文案解释器**：在拒绝文案里补一句「（写/执行类）」。
//
// ★ **在用口径**（修复轮 #4）：normalizeModules 只把**字面量 `enabled: true`** 的行算作在用
//   （平台 flattenRows 恒带布尔 enabled）——`enabled: false`、**非布尔取值**（如平台给 `!!js`
//   条件行产出的 `enabled: "conditional"`）、缺键一律**不算在用** ⇒ 发货集合里的这类行
//   表现为「缺失」⇒ 拒绝（保守方向）。
// ★ **保守方向**（设计档 §九，评审 #9 / N3）：normalizeModules **先滤行、再取 moduleName** ⇒
//   发货集合**之内**的行不算在用 = 比较出「缺失」= **漂移**（拒绝）；
//   发货集合**之外**的行不算在用 = 放行。顺序反过来写（先取名再滤）会让两个方向都判错。

/**
 * 随本包分发的只读会诊预设所声明的**模块名**（单一事实源；group 已展开）。
 * 来源 = cordis.patch.yml 的 preset-thincoder-consult-ro（设计档 §十一 末尾原样抄录，共 9 个）。
 * ★ 与发货定义的**同步锁** = test/consult.test.mjs 的 T-42（静态解析该 YAML 段逐项比对）：
 *   改发货定义却忘了改本常量 ⇒ T-42 红；本常量被误改 ⇒ T-42 也红。
 * @type {readonly string[]}
 */
export const CONSULT_READONLY_MODULES = [
  "@deepseek-ai/dsh-agent-instructions",
  "@deepseek-ai/dsh-tool-fs",
  "@deepseek-ai/dsh-tool-fs-search",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-tool-skill",
  "@deepseek-ai/dsh-tool-web",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-command-compact",
  "@deepseek-ai/dsh-compaction-tool-result-pruner",
]

/**
 * 写 / 执行 / 后台作业 / 再委派类模块的**词表**——**只供文案**（explainModule），不承担判据。
 * 词的粒度按「模块名里出现即视为写/执行类」取（设计档 §五 FR-1 的清单原样）。
 * @type {readonly string[]}
 */
export const WRITE_CAPABLE_TOKENS = [
  "bash", "pwsh", "str-replace-editor", "jobs", "ralph", "workflow", "subagent",
  "terminal", "worktree", "schedule", "present", "goal", "todo", "ask-user",
]

/** 拒绝文案里接在模块名之后的解释片段（纯文案，不参与任何布尔判据）。 */
const WRITE_CAPABLE_NOTE = "（写/执行类）"

/**
 * 该模块名是否带写 / 执行类词（**纯**，仅文案）。
 * @param {unknown} name 模块名（大小写不敏感；非字符串按空串处理，不抛）
 * @returns {string} "（写/执行类）" 或 ""
 */
export function explainModule(name) {
  const n = String(name ?? "").toLowerCase()
  if (n === "") return ""
  return WRITE_CAPABLE_TOKENS.some((t) => n.includes(t)) ? WRITE_CAPABLE_NOTE : ""
}

/**
 * 把 compositionInventory() 的**扁平化声明行**归一成「在用模块名」集合（**纯**）。
 * 前置：rows 可为任意值（非数组 ⇒ 空集，不抛）。
 * 后置：**先滤行**（只有 `enabled === true` 的行算在用；`false`、**非布尔取值**
 *       ——如平台给 `!!js` 条件行产出的 `"conditional"`——以及缺键**一律不算**）
 *       **再取** moduleName ⇒ 去重 + 排序（顺序不同不算漂移；发货集合内的行被停用 / 条件化
 *       ⇒ 表现为「缺失」⇒ 由 checkModuleSet 判红）。
 * @param {unknown} rows { entryId, moduleName, enabled, condition? }[]（group 已由平台展开；
 *   enabled 是**布尔**——非布尔取值一律按「未确定在用」处理，保守方向）
 * @returns {string[]} 去重且排序的模块名
 */
export function normalizeModules(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue
    // ★ 顺序即判据（评审 #9）：**先滤行**——只有字面量 true 才算在用（修复轮 #4：
    //   "conditional" / null / 缺键都是「未证实在用」⇒ 保守地排除）。
    if (row.enabled !== true) continue
    const name = typeof row.moduleName === "string" ? row.moduleName.trim() : ""
    if (name === "" || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out.sort()
}

/**
 * 模块集合的**精确等值**判据（**纯**；唯一的模块层判据）。
 * @param {unknown} actual 实际模块名（接受 string[]，或 compositionInventory() 的行对象数组）
 * @returns {{ok: boolean, added: string[], missing: string[]}}
 *   added = 实际有、发货定义没有（含被词表解释的写/执行类）；missing = 发货定义有、实际没有
 */
export function checkModuleSet(actual) {
  const list = Array.isArray(actual) ? actual : []
  const isStrings = list.every((x) => typeof x === "string")
  const mods = isStrings
    ? [...new Set(list.map((x) => String(x).trim()).filter((x) => x !== ""))].sort()
    : normalizeModules(list)
  const expected = [...new Set(CONSULT_READONLY_MODULES.map((x) => String(x).trim()).filter((x) => x !== ""))].sort()
  const have = new Set(mods)
  const want = new Set(expected)
  const added = mods.filter((m) => !want.has(m))
  const missing = expected.filter((m) => !have.has(m))
  return { ok: added.length === 0 && missing.length === 0, added, missing }
}

/** 平台 `tool-fs` 的模块名（配置层**正向**判据的锚点；与发货常量里的同一项）。 */
const TOOL_FS_MODULE = "@deepseek-ai/dsh-tool-fs"

/**
 * 去掉 YAML 行尾注释（**纯**，不抛）：引号内的 `#` **不是**注释；`#` 只有在**行首**或
 * **前一个字符是空白**时才开始注释（YAML 的行内注释口径）⇒ `@x/y#z` 这类名字不受影响。
 * @param {unknown} raw 一行文本
 * @returns {string} 去注释后的行（保留原缩进）
 */
function stripInlineComment(raw) {
  const s = typeof raw === "string" ? raw : ""
  let quote = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quote !== "") {
      if (ch === quote) quote = ""
      continue
    }
    if (ch === "'" || ch === '"') { quote = ch; continue }
    if (ch === "#" && (i === 0 || s[i - 1] === " " || s[i - 1] === "\t")) return s.slice(0, i)
  }
  return s
}

/** 去掉标量两侧的成对引号（**纯**；`'x'` / `"x"` / `x` 都归一到 `x`）。 */
function unquoteScalar(raw) {
  const v = String(raw ?? "").trim()
  if (v.length >= 2) {
    const a = v[0]
    const b = v[v.length - 1]
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) return v.slice(1, -1)
  }
  return v
}

/**
 * 定位 `tool-fs` 那**一个清单项**的行块（**纯**，不抛）：
 *   ① 找 `name:` 值（去引号后）恰为 `@deepseek-ai/dsh-tool-fs` 的行；
 *   ② 向上找**缩进更浅**的清单行（`- `）作为该项的起点（**不按行号**，不依赖具体层级）；
 *   ③ 返回起点之下、缩进更深的所有行（已去行尾注释）。
 * @param {string} text 文档全文
 * @returns {string[]|null} 行块；找不到 name 行、或定位不到所属清单行 ⇒ null
 */
function toolFsBlockLines(text) {
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = stripInlineComment(lines[i])
    const m = /^(\s*)name:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    if (unquoteScalar(m[2]) !== TOOL_FS_MODULE) continue
    const nameIndent = m[1].length
    let start = -1
    let itemIndent = -1
    for (let j = i - 1; j >= 0; j--) {
      const prev = stripInlineComment(lines[j])
      if (prev.trim() === "") continue
      const im = /^(\s*)-\s+/.exec(prev)
      if (im && im[1].length < nameIndent) { start = j; itemIndent = im[1].length; break }
    }
    if (start < 0) return null
    const body = []
    for (let j = start + 1; j < lines.length; j++) {
      const raw = stripInlineComment(lines[j])
      if (raw.trim() === "") continue
      const ind = /^[ \t]*/.exec(raw)[0].length
      if (ind <= itemIndent) break
      body.push(raw)
    }
    return body
  }
  return null
}

/**
 * 行块里是否把某开关**显式**置为 `false`（**纯**，不抛）。
 * 兼容两种 dump 形态：块式（`write: false` 独占一行）与流式映射（`config: { write: false, edit: false }`）。
 * @param {string[]} body 清单项的行块（已去行尾注释）
 * @param {string} key 开关名（write / edit）
 * @returns {boolean} true = 找到显式 false
 */
function flagIsFalse(body, key) {
  const anchored = new RegExp("^\\s*" + key + ":\\s*(.*?)\\s*$")
  const flow = new RegExp("(?:^|[\\s{,])\\b" + key + ":\\s*(['\"]?)([^\\s,}'\"\\]]*)\\1(?=[\\s,}\\]]|$)")
  for (const raw of body) {
    const a = anchored.exec(raw)
    if (a) return unquoteScalar(a[1]).toLowerCase() === "false"
    const f = flow.exec(raw)
    if (f) return unquoteScalar(f[2]).toLowerCase() === "false"
  }
  return false
}

/**
 * 关键配置的**双向**判据（**纯**）：
 *   ① **反向**：全文出现 `write: true` / `edit: true` ⇒ 命中；
 *   ② ★ **正向**（交付评审 #1）：`tool-fs` 那一项**必须显式写死** `write: false` **且**
 *      `edit: false` —— 平台 `tool-fs` 的 `write` / `edit` **缺省 true**，删掉这两行
 *      = **静默打开**写 / 改工具 ⇒ **缺任一键即漂移**（不是提示，是拒因）；整个 `tool-fs`
 *      项都不在文档里同样命中（无法核验）。
 * 不依赖缩进层级（设计档 §十二 第 3 条：dump() 的 YAML 形态未实测），只按「name 行 +
 * 所属清单项的行块」定界；引号（`'`/`"`）与行尾注释都容忍，块式与流式映射（`config: { write: false }`）
 * 都认（修复轮对 dump 形态的加性容忍；判据不变：没有**显式 false** 就判漂移）。
 * @param {unknown} yamlText readDocument().content（非字符串 ⇒ 视为「tool-fs 行缺失」⇒ 命中）
 * @returns {{ok: boolean, hits: string[]}}
 */
export function checkDocFlags(yamlText) {
  const text = typeof yamlText === "string" ? yamlText : ""
  const scanText = text.split(/\r?\n/).map(stripInlineComment).join("\n")
  const hits = []
  if (/\bwrite:\s*['"]?true['"]?\b/i.test(scanText)) hits.push("write: true")
  if (/\bedit:\s*['"]?true['"]?\b/i.test(scanText)) hits.push("edit: true")
  if (hits.length > 0) return { ok: false, hits }
  const body = toolFsBlockLines(text)
  if (body === null) {
    hits.push("tool-fs 行缺失（write: false / edit: false 无法核验）")
    return { ok: false, hits }
  }
  for (const key of ["write", "edit"]) {
    if (!flagIsFalse(body, key)) hits.push("tool-fs 缺 " + key + ": false（平台缺省 true）")
  }
  return { ok: hits.length === 0, hits }
}

/**
 * 两层合一的组合判据（**纯**；前置/后置见设计档 §六）。
 * 前置：rows 可为 null/undefined（观测面缺失）**或非数组**（形态不符）；docContent 可为
 *       null/undefined（配置层不可用）。★ 修复轮 #5：非数组 rows 与「缺失」同支 ⇒ degraded，
 *       **不得**落进 normalizeModules([]) 变成「缺失 9 项」的谎报（那是把形态错误说成内容漂移）。
 * 后置：任意输入都**不抛**；ok:false 时 reason 非空且含**具体差异**（第一个失败层早返回 ⇒
 *       一条报文只含一类差异，评审 #8）；rows 齐但 docContent 缺 ⇒ ok:true **且 degraded 非空**
 *       （评审 #2：**不许静默**）。
 * @param {{rows?: unknown, docContent?: unknown}} [input]
 * @returns {{ok: boolean, reason: string|null, degraded: string|null}}
 */
export function evaluatePresetDrift(input) {
  const { rows, docContent } = input !== null && typeof input === "object" ? input : {}
  // D-2：内容观测面缺失 ⇒ 降级放行 + 响亮告警（由 caller 并入派发文本）
  if (rows === null || rows === undefined) {
    return { ok: true, reason: null, degraded: "内容观测面不可用" }
  }
  // ★ 修复轮 #5：非数组 rows = **形态不符**（与「缺失」同支：degraded 放行，不是内容漂移）。
  //   否则 normalizeModules 会把任意畸形值折成空集 ⇒ 报「缺失 9 项」的假差异（谎报）。
  if (!Array.isArray(rows)) {
    return { ok: true, reason: null, degraded: "内容观测面形态不符（rows 非数组）" }
  }
  const mods = normalizeModules(rows)          // ★ 先滤行，再取 moduleName
  const set = checkModuleSet(mods)
  if (!set.ok) {
    const diffs = []
    if (set.added.length > 0) diffs.push("多出 " + set.added.map((m) => m + explainModule(m)).join(", "))
    if (set.missing.length > 0) diffs.push("缺失 " + set.missing.join(", "))
    return { ok: false, reason: "模块集合不符（" + diffs.join(" / ") + "）", degraded: null }
  }
  // ★ 评审 #2：模块层过了但配置层读不到 ⇒ **degraded 必须非空**（不假装验过）
  if (docContent === null || docContent === undefined) {
    return { ok: true, reason: null, degraded: "配置层未核验（readDocument 不可用）" }
  }
  const flags = checkDocFlags(docContent)
  if (!flags.ok) {
    return { ok: false, reason: "关键配置被翻转：" + flags.hits.join(" / "), degraded: null }
  }
  return { ok: true, reason: null, degraded: null }
}
