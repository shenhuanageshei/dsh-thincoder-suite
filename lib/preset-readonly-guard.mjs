// preset-readonly-guard.mjs — 批 41（台账 t-6 / 设计档 docs/2026-10-18-consult-preset-drift-design.md §五 FR-1）：
// 「只读会诊预设的**内容漂移**」检测的**纯函数 + 常量**。
//
// ★ **本档零副作用**：无 IO、无网络、无时间、无随机、无模块级可变状态、不碰宿主服务对象。
//   为什么这条声明能成立（设计档 §五 FR-2「函数归属」/ 评审 #4）：要摸服务对象的
//   verifyReadonlyPresetContent(presets) **住 lib/consult.mjs**；住在这里的只有可纯测的判据与文案表。
//
// ★ **语义两层**（D-1；原第三层「禁用能力词表」已被评审 #1 判为假腿并删除）：
//   ① checkModuleSet = 模块集合**精确等值**（**唯一**的模块层判据）；
//   ② checkDocFlags = 关键配置扫描（write: true / edit: true）。
//   WRITE_CAPABLE_TOKENS **不承担判据**：① 是精确等值 ⇒ 任何多出来的模块都已被 ① 拒掉，
//   词表层永远只可能看到发货集合本身 ⇒ 若让它判红，那条断言**永远是绿的**（恒真 / 假腿）。
//   它只作 explainModule 的**文案解释器**：在拒绝文案里补一句「（写/执行类）」。
//
// ★ **保守方向**（设计档 §九，评审 #9 / N3）：normalizeModules **先按 enabled !== false 滤行、
//   再取 moduleName** ⇒ 发货集合**之内**的行被停用 = 比较出「缺失」= **漂移**（拒绝）；
//   发货集合**之外**的行被停用 = 不算在用（放行）。顺序反过来写（先取名再滤）会让两个方向都判错。

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
 * 后置：**先滤行**（enabled === false 的行**不算在用**）**再取** moduleName ⇒ 去重 + 排序
 *       （顺序不同不算漂移；发货集合内的行被停用 ⇒ 表现为「缺失」⇒ 由 checkModuleSet 判红）。
 * @param {unknown} rows { entryId, moduleName, enabled, condition? }[]（group 已由平台展开）
 * @returns {string[]} 去重且排序的模块名
 */
export function normalizeModules(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue
    // ★ 顺序即判据（评审 #9）：**先滤行**——停用的行不得进入比较集
    if (row.enabled === false) continue
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

/**
 * 关键配置扫描（**纯**）：预设声明里出现 write: true / edit: true ⇒ 漂移。
 * 不依赖缩进（设计档 §十二 第 3 条：dump() 的 YAML 形态未实测 ⇒ 用宽松正则）。
 * @param {unknown} yamlText readDocument().content（非字符串 ⇒ 零命中，不抛）
 * @returns {{ok: boolean, hits: string[]}}
 */
export function checkDocFlags(yamlText) {
  const text = typeof yamlText === "string" ? yamlText : ""
  const hits = []
  if (/\bwrite:\s*true\b/i.test(text)) hits.push("write: true")
  if (/\bedit:\s*true\b/i.test(text)) hits.push("edit: true")
  return { ok: hits.length === 0, hits }
}

/**
 * 两层合一的组合判据（**纯**；前置/后置见设计档 §六）。
 * 前置：rows 可为 null/undefined（观测面缺失）；docContent 可为 null/undefined（配置层不可用）。
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
