// path-kind.mjs — 「这个路径是文档还是代码」的**唯一权威**（批 7 / D-P9）。
// 为什么单独成模块：eng.mjs 已 import advisor.mjs，权威必须放第三方以免成环；
// doc-hash.mjs 是同型先例（零依赖叶模块）。
//
// 两个消费者问的是**不同问题**，但共享**同一个子问题**（本模块）：
//   - 写门禁问「写这个路径要不要设计令牌」（eng.mjs）
//   - 评审入参校验问「这个路径能否作为设计评审文档」（advisor.mjs）
//   - 配置校验问「声明的标准文档路径是不是文档」（index.mjs，J11）
// 矛盾全部出在共享子问题被实现了两遍、且各有盲区。本模块消灭这份重复。
//
// **边界（约定，不是代码）**：docs/ 按**纯文档树**约定——代码文件落进 docs/ 属**布局违规**，
// 由评审与分歧审计抓，**不归写门禁兜底**。堵它需要「代码扩展名清单」，而人工维护的清单必漂移。

/** 文档扩展名白名单（**全库唯一字面量** —— N-3）。 */
export const DOC_EXT_RE = /\.(md|markdown|mdx|txt|rst|adoc)$/i

/** 路径归一：反斜杠 → "/"（**不做**大小写折叠，对齐 doc-hash.normalizeDocPath 的既有裁定 G-4）。 */
const norm = (p) => String(p ?? "").replace(/\\/g, "/")

/**
 * 这个路径是文档吗？（唯一权威）
 * 规则（两条，顺序即语义）：
 *   ① 归一后以 "docs/" 开头 → 文档（根锚定**保留**——两个原谓词今日在此一致）
 *   ② 文档扩展名命中 → 文档（**任意目录、任意深度**，含 src/ 内）
 * 空/畸形输入 → **false**（不得翻真）。
 * 判空用 `norm(p).trim() === ""`：「空/白 = 无有效目标」是一个语义，不因空白字符分叉
 * （纯空白串在 JS 里是 truthy，写门禁的 `!target` 短路**拦不住**它——判定照走，故必须在此判掉；
 * 由此纯空白路径的行为由「拦」转为「放行」，方向更宽松，与「文档可写」的自书意图一致）。
 */
export function isDocPath(p) {
  const n = norm(p)
  if (n.trim() === "") return false
  if (n.startsWith("docs/")) return true
  return DOC_EXT_RE.test(n)
}

/**
 * 写门禁用的产品代码判据 = **isDocPath 的纯补集**（D-P10：无第二套规则体）。
 * 空/畸形 → false（**双守卫**：保留「空 → 双双 false」的现状，否则空路径会翻成
 * 产品代码，写门禁对畸形调用转 fail-closed = 回归）。
 */
export function isProductCodePath(p) {
  const n = norm(p)
  if (n.trim() === "") return false
  return !isDocPath(n)
}
