// job-owner.mjs — `jobs.start({ owner })` 的 owner 判据**单一事实源**（D-42）。
//
// 背景（0.1.7 平台契约变更，docs/2026-09-25-dsh017-compat-design.md §2）：
// - 0.1.6 的 dsh-jobs-local `start(spec)` 直接把 `spec.owner` 当 owner 桶用
//   （servesOwner / activeJobCount / ensureOwnerCleanup 全吃它）⇒ 传 **Agent 对象**能用；
// - 0.1.7 的 `start(spec)` 首行变成 `const owner = this.resolveOwner(spec.owner)`，而
//   resolveOwner 走 `agents.get(session)`，注册表按 **id** 键（dsh-agent `enter()`：
//   `const id = agent.id`，且强制 `id === agent.session.id`）⇒ 传对象必然查空并抛
//   `session "[object Object]" has no live agent (background job owner must be live)`。
// 平台自己的调用点一律传 `parent.id`（dsh-tool-subagent / dsh-tool-workflow）——本 helper
// 就是把那一条契约收成单点，防 7 处各写各的再漏一处（D-42 的回归锁按此计数）。
//
// 缺 id 时**响亮失败**（不静默回落成对象）：对象形态在 0.1.7 下必然被平台拒收，静默回落会把
// 一个「必定失败的派发」伪装成「派发成功」；抛出的错误在各调用点都由既有的 jobs 缺失/派发失败
// 分支接住（告警 + 回落同步，批 21 FR-3 双通道），所以响亮是安全的。

/**
 * 解析平台要求的 owner（= 共享的 agent/session id）。
 * @param {{id?: string, session?: {id?: string}}} agent — 工具执行上下文里的 Agent
 *   （平台契约保证 id 恒为非空字符串——`dsh-agent` 注册时强制 `id === session.id`；非字符串一律视为缺失）
 * @returns {string} owner id（agent.id 优先，回落 session.id——平台强制二者相等）
 * @throws {Error} 两者都不是非空字符串时（响亮失败，见文件头）
 */
export function ownerIdOf(agent) {
  for (const candidate of [agent?.id, agent?.session?.id]) {
    if (typeof candidate === "string" && candidate !== "") return candidate
  }
  throw new Error("[thincoder-suite] jobs.start owner 无法解析：agent 既无 id 也无 session.id"
    + "（0.1.7 起平台按 id 查找活代理，传对象必被拒收——D-42）")
}
