// ledger-config-text.mjs — 台账配置表单的「文本 ↔ 数组」纯函数 + 前端**提前提示**
// （设计档 docs/2026-10-16-task-ledger-design.md §十七：§17.3 决策 5 · §17.4 字段与控件 · §17.5 腿 C-L3）。
//
// 为什么单独成档（§17.3 决策 5）：`lib/client.js` 是浏览器 bundle（`window.__ModuleLoader__`
// 的 CJS 工厂，见该档档头），在本仓的 `node --test` 里**不能直接渲染**；而「一行一条 / 逐行 trim /
// 去空行 / 超 8 行报错」这类规则**可以有真腿**。⇒ 把它们抽成**可导出的纯函数**，由
// `test/config-api.test.mjs` 直测（腿 C-L3）。**不写进客户端 bundle 里**（理由同上：那里测不了）。
//
// ★ 单一事实源（本档的边界，铁律 2）：常量与谓词**一律**从 `lib/tasks.mjs` import，本档
//   **不另写一份规则**。这里只做两件事 ——
//     ① 把「多行文本」与「路径数组」互转（纯形态问题，无规则判断）；
//     ② 把**后端谓词**的结论拼成人话错误。
//   最终裁决永远是后端（`lib/index.mjs` 的 PUT 校验，§17.2 非目标①：本单不改后端校验）；
//   本档输出只用于**提前提示**（§17.3 决策 4）。
//
// ★ 与浏览器半边的复制关系（**如实登记，不是"没实现"**）：`lib/client.js` 的手写 CJS bundle
//   **无法 import 本档**——宿主只给 browser 静态模块表（react 等），相对路径 import 不存在
//   （同档处理 ENG_APP_SERVER_RUNNER_REFUSAL 时已写死这条事实：「浏览器 bundle 无法 import lib 的
//   mjs，故此处保留一份字面——两处必须同时改」）。⇒ 客户端另有一份**行为等价**的实现，
//   由 `test/config-api.test.mjs` 的 **C-L4** 腿做**逐夹具行为等值锁**（两边输出必须逐条相同，
//   漂移即红）。本档是**规则的可执行单一源**，客户端那份是它的浏览器镜像。
//
// 变量命名口径：`docPaths` = 数组（持久化形态）；`docPathsText` = 多行文本（表单形态）。

import {
  MAX_DOC_PATHS,
  LEDGER_MODES,
  DEFAULT_COPY_TEMPLATE,
  isValidLedgerMode,
  isValidCopyTemplate,
  isValidDocPathList,
} from "./tasks.mjs"

/**
 * `copyTemplate` 的字符上限。
 *
 * ★ **从谓词推导，不另写一份规则**：`lib/tasks.mjs` 的 500 只写在 `isValidCopyTemplate` 的**函数体**
 *   里，**没有导出常量**，而该档不在本单写域内 ⇒ 不能补导出。这里用谓词**探出**边界值，
 *   保证单一事实源：将来后端把 500 改成别的数，本值自动跟随，前端的「实时字数/上限」提示不会撒谎。
 * @post 恒返回一个有限正整数（`isValidCopyTemplate` 在超出上限后必假 ⇒ 循环必收敛）；
 *       `SAFETY_CAP` 是**防线**而非规则——若谓词哪天变成「无长度上限」，本值不会死循环。
 */
export const COPY_TEMPLATE_MAX_CHARS = (() => {
  const SAFETY_CAP = 100000
  let n = 0
  while (n < SAFETY_CAP && isValidCopyTemplate("x".repeat(n + 1))) n++
  return n
})()

/** 表单默认值（空态回显用，§17.4「空态」）：与后端 `resolveLedgerConfig` 的回落**同源**。 */
export const LEDGER_FORM_DEFAULTS = Object.freeze({
  mode: "standalone",
  docPaths: Object.freeze([]),
  copyTemplate: DEFAULT_COPY_TEMPLATE,
})

/**
 * 路径数组 ⇒ 多行文本（**一行一个**，`\n` 连接；空数组 ⇒ 空串）。
 * @pre 无（非数组 / 非字符串项一律按「不存在」处理，不抛）
 * @post 输出行序 == 输入数组序（§17.3 决策 2：行序即数组序）
 */
export function docPathsToText(paths) {
  const arr = Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : []
  return arr.join("\n")
}

/**
 * 多行文本 ⇒ 路径数组（按 `\r\n` / `\n` 切、**逐行 trim**、**去空行**、**保持顺序**）。
 * @pre 无（非字符串 ⇒ `[]`）
 * @post 每一项都是 trim 后的非空串；`textToDocPaths(docPathsToText(x))` 对
 *       「已 trim 且无空项」的 `x` **逐项相等**（往返无损 —— 腿 C-L3）
 */
export function textToDocPaths(text) {
  if (typeof text !== "string") return []
  return text
    .split(/\r\n|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
}

/**
 * 前端**提前提示**（§17.4「前端校验（提前提示）」列逐条落地）。
 *
 * ★ 三条纪律：
 *   ① **不重复后端规则**：判定全部经 `lib/tasks.mjs` 的谓词/常量（本档不写第二份）；
 *   ② **不替后端拍板**：本函数只产出「按后端的规则，它大概会被拒」的人话提示；
 *      真正保存失败时要显示的是**后端原样 errors**（§17.6），不是这里的句子；
 *   ③ 与后端**同一朝向**：这里严格一点没关系（提示先出现），宽松一点也拦不住
 *      —— 裁决权在后端，所以本函数**不需要**覆盖后端能查的一切（例如未知子键）。
 *
 * @param {{ledger?: {mode?: string, docPathsText?: string, docPaths?: string[], copyTemplate?: string}}} draft
 *        表单草稿。`docPaths` 两种形态都接受：`docPathsText`（文本域，优先）或 `docPaths`（数组，
 *        直传/夹具）——两者并存时**以文本为准**（表单的实际编辑面就是文本域）。
 * @returns {string[]} 错误数组（空 = 无提前提示）
 */
export function ledgerDraftErrors(draft) {
  const d = draft && typeof draft === "object" && !Array.isArray(draft) ? draft : {}
  const ledger = d.ledger && typeof d.ledger === "object" && !Array.isArray(d.ledger) ? d.ledger : null
  // 未加载 / 未触碰：没有草稿就没有提示（保存面仍会被后端判——不在这里编造）
  if (!ledger) return []
  const errors = []

  // ① mode：闭集（下拉本应保证，但草稿也可能来自旧值/手编配置 ⇒ 仍核一次）
  if (!isValidLedgerMode(ledger.mode)) {
    errors.push("ledger.mode 必须是 " + LEDGER_MODES.join("|") + "（当前为 " + JSON.stringify(ledger.mode) + "）")
  }

  // ② docPaths：先归成数组，再交给后端谓词
  const paths = typeof ledger.docPathsText === "string"
    ? textToDocPaths(ledger.docPathsText)
    : ledger.docPaths
  if (paths !== undefined && paths !== null) {
    if (!Array.isArray(paths)) {
      errors.push("ledger.docPaths 必须是路径清单（一行一个）")
    } else if (paths.length > MAX_DOC_PATHS) {
      errors.push("ledger.docPaths 最多 " + MAX_DOC_PATHS + " 条（当前 " + paths.length + " 条）")
    } else if (!isValidDocPathList(paths)) {
      errors.push("ledger.docPaths 的每一条都必须是非空路径（不要留只有空白的行）")
    }
  }

  // ③ copyTemplate：非空、长度有界（上限来自谓词，见 COPY_TEMPLATE_MAX_CHARS）
  if (!isValidCopyTemplate(ledger.copyTemplate)) {
    const cur = typeof ledger.copyTemplate === "string" ? ledger.copyTemplate : ""
    errors.push("ledger.copyTemplate 不能为空且不得超过 " + COPY_TEMPLATE_MAX_CHARS + " 字（当前 " + cur.length + " 字）")
  }

  return errors
}

/**
 * 表单「台账节」⇒ PUT 载荷里的 `ledger` 节（§17.4 三键逐条钉死）。
 * @param {{mode?: string, docPathsText?: string, docPaths?: string[], copyTemplate?: string}} ledger
 *        草稿里的 `ledger` 节（**不是**整个 draft —— 与客户端镜像同签名，C-L4 才能逐夹具比）
 * @pre 调用方**已**用 `ledgerDraftErrors` 提前提示过
 * @post 返回 `{mode, docPaths, copyTemplate}` 三键齐全的**新对象**（不含草稿态字段
 *       `docPathsText`）；纯形态转换，**不做合法化**（非法值交给后端拒 —— 静默修正会让
 *       「保存了但没生效」变成没人看得见的谎）
 */
export function ledgerDraftToPayload(ledger) {
  const lg = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {}
  return {
    mode: lg.mode,
    docPaths: typeof lg.docPathsText === "string"
      ? textToDocPaths(lg.docPathsText)
      : (Array.isArray(lg.docPaths) ? lg.docPaths.map((p) => (typeof p === "string" ? p.trim() : p)) : []),
    copyTemplate: typeof lg.copyTemplate === "string" ? lg.copyTemplate : "",
  }
}
