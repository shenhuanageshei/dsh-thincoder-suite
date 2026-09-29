// contract-baseline.mjs — 批 28（设计档 docs/dsh017-batch28-design.md §2.2/§2.3 · 决策 D28-2）：
// 平台契约基线的**单一事实源**。四个职责：
//
// ① readPlatformVersion(ctx, opts) —— 平台版本的**四源钉死顺序**读取链（§2.2；批 31 扩源）：
//    ① ctx.pkg?.version（宿主注入）→ ② profile manifest 的 dsh 依赖声明 →
//    ③ pluginManager 服务报告的**平台自带组合包**版本 → ④ 进程可见的平台包版本；
//    四者皆不可得 ⇒ 标 "unknown"（不猜、不崩，A28-3），并逐级返回**来源 evidence**
//    （source: "ctx.pkg" | "profile-manifest" | "plugin-manager" | "package-json" | "unknown"）
//    ——本机 profile 层实测就是 rc.1/rc.2 混杂，②会稳定假阳性（同前缀键可能是**别的插件**的版本
//    声明）；有 evidence 才能把「真换契约」与「环境 skew」分开（批 28 评审 #6）。
//
//    ★ 批 31（2026-09-29 · DSH 0.2.0-rc.1 真机）扩源的**动因**：批 28 的三源在本机**全部落空**
//    （contractWatch 稳定报 unknown）⇒ 哨兵对 0.1.7→0.2.0 这次真实换版**零反应**——「只警告不阻断」
//    的防线在拿不到版本时就等于没有。两条实测（本案两条硬事实）：
//      a) 原源③ 的 `@deepseek-ai/dsh-core` **在 0.2.0 里已不存在**（该包只活在 0.1.x）⇒ 候选名改为
//         **平台自有包**，首选 `@deepseek-ai/dsh-app-boot`——平台自己的版本权威就是它
//         （`getDshRuntimeVersion()` 读的正是它自己的 package.json）。
//      b) 从插件自身模块图 `createRequire(import.meta.url)` **解析不到**任何平台包（桌面版把平台装在
//         app.asar 内，不在 profile 的 node_modules 里）⇒ 新增**源③**：向平台服务 `pluginManager`
//         要组合包清单，取其中**平台自带**（钉死枚举 PLATFORM_BUNDLE_NAMES）那一项的版本。刻意
//         **不取「任意 `@deepseek-ai/dsh-*` 包」**——profile 里可能装着用户侧同前缀包
//         （本机实测：`@deepseek-ai/dsh-token-cost@0.1.0`），取它会稳定假告警。
// ② 九条平台触点谓词（批 26 设计档 §2.3 的 #1…#9）——test/platform-surface.test.mjs 与
//    contractWatch 工具**都 import 这里**（A28-5：不存在第二份字面）。求值口径（批 28 第 2 轮
//    评审订正）：九条**一律按「源码文本 / 夹具文本」求值**——零真实网络、零真实 LLM、零子进程
//    （与 D28-4「只读」一致，也不复现批 28 §1-② 的挂死面）。每条求值为
//    { id, ok: true|false|"unknown", evidence }；**取不到文本 ⇒ 记 "unknown" 而非 false**（D28-7，
//    与 A28-3「不猜」同源）；evidence 记「读自哪个文件/片段」或「为何转红」。
// ③ 版本哨兵（US-2 / D28-1）：evaluateVersionSentinel（纯判定，warnings 数组返回）+
//    runVersionSentinel（装配期入口：不一致/未知 ⇒ console.warn **一条响亮告警**，**只警告不阻断**
//    ——拒启动会变成新的砖化源，与 D27-1/D26-2 同一条纪律）。进程级 once（与 index.mjs 的
//    弃用密钥告警同款）：多次 apply / fiber 重建不重复刷屏。
// ④ jobsDirStats(opts) —— 作业报告落盘目录（$DSH_HOME/.thincoder/jobs/）的**只读**状态
//    （US-3 的 jobsDir 腿：{ files, bytes, oldestDays }）。目录缺失/不可读 ⇒ 零值（不建目录、不写盘）。
//
// 本模块自身的源文本会被 ② 的 #7（注册面计数）当作 lib/** 的一员扫描 ⇒ 本文件内**不得**出现
// 未转义的注册面字面（正则一律带转义写）；同样地，其它跨库扫描锁（执行面计数、死名扫描、
// 退役常量扫描、abort 词汇表扫描）各自的禁字面在本文件也一律不出现。
//
// 纪律：纯 node:fs/path/module，零新增依赖、零网络、零子进程。
import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { pickDshHome } from "./dsh-home.mjs"

// ————————————— 平台版本基线（本轮验证过的版本 + 证据） —————————————

/** 本仓九条触点锁当前验证所依据的平台版本（批 31 在 0.2.0-rc.1 与 0.2.0-rc.2 上逐触点复核 + 真机派发）。 */
export const PLATFORM_VERSION_BASELINE = "0.2.0-rc.2"

/** 基线记录时点（ISO 日期——「本轮验证过」的锚，哨兵文案引用）。 */
export const BASELINE_RECORDED_AT = "2026-09-30"

/** 基线证据（人读；供结项说明与上游报告引用）。 */
export const PLATFORM_VERSION_BASELINE_EVIDENCE =
  "批 31 按 0.2.0-rc.1 逐触点复核九条锁并真机派发；0.2.0-rc.2 发布后（桌面版 nightly 自动升级）复跑同一套复核：九条形状逐条仍在位，且 rc.1→rc.2 的**运行时面逐字节未变**（只有 package.json 版本号变）。升级前基线与证据见 git 历史（0.1.7-rc.2 · 2026-09-26 · 宿主验收 node --test 559/559）"

/** 版本来源的**钉死枚举**（§2.2 的 evidence 字段取值；顺序即读取链的钉死顺序）。 */
export const VERSION_SOURCES = Object.freeze(["ctx.pkg", "profile-manifest", "plugin-manager", "package-json", "unknown"])

/**
 * 源③ 的**平台自带组合包**候选名（钉死枚举；按序取首个在场者）。
 * 为什么必须钉死名单：`pluginManager.listBundles()` 的清单里既有平台包也有**用户侧插件**，而用户侧
 * 可以有同前缀名（本机实测 `@deepseek-ai/dsh-token-cost@0.1.0`）——「取首个 `@deepseek-ai/dsh-*`」
 * 会稳定报出**用户插件**的版本（假告警）。名单里只放**平台默认组合**里的成员：
 * `@deepseek-ai/dsh-base` 与 `@deepseek-ai/dsh-web-app`（DEFAULT_PROFILE_BUNDLES）。
 */
export const PLATFORM_BUNDLE_NAMES = Object.freeze(["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"])

/**
 * 源④ 的**平台包候选名**（钉死枚举；按序 try，首个可解析者胜）。
 * 首选 `@deepseek-ai/dsh-app-boot` = 平台版本权威（`getDshRuntimeVersion()` 读的就是它自己的
 * package.json）。**次选只作兜底、版本权威性弱于 app-boot**（批 31 评审 #5 如实登记）：`dsh-base`
 * 与 `dsh-core` 作为组合包成员，理论上可独立于平台版本演进，命中它们时以 evidence 里的人读路径
 * 判读，不要当硬结论；`dsh-core` 殿后另有一层理由——它自 0.2.0 起已不存在，只为 0.1.x 兼容。
 */
export const PLATFORM_PACKAGE_NAMES = Object.freeze([
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-core",
])

/**
 * 源② 的**版本权威键**（命中 ⇒ 该依赖声明的值就是平台版本本身；否则 evidence 上打 skew 标记）。
 * ★ 批 31 评审 #2（🔵）：源② 取「首个 `@deepseek-ai/dsh` 前缀键」是批 29 的既定行为（A29-6④ 锁着
 *   「非 core 前缀键仍可达」），**不改行为**——但 profile manifest 里真有用户侧同前缀包时（本机形态：
 *   `@deepseek-ai/dsh-subagent-codex@0.0.1-rc.1`），源② 会拿它顶替真平台版本并产生**稳定的假 mismatch**。
 *   低成本改善：把「这个键不是版本权威」写进 evidence，让假告警**当场可辨**（值本身照旧返回——判据面
 *   不变，故 A29-6④ 逐字仍绿）。
 */
const MANIFEST_AUTHORITY_KEYS = Object.freeze(["@deepseek-ai/dsh", ...PLATFORM_PACKAGE_NAMES])

/**
 * 版本词元归一：trim + **统一小写** + 去掉前导范围符/「v」前缀（只用于比较；evidence 保留原值）。
 * ★ 批 29 / US-4 🔵⑥：补 `toLowerCase()`——`0.1.7-RC.2` 这类**混合大小写**词元此前**不**等于基线
 *   `0.1.7-rc.2`，于是稳定误判 `mismatch`（假告警：明明同一个版本却告诫「平台可能已换契约」）。
 *   版本词元是**版本号**，大小写不承载语义 ⇒ 先归一再比。
 * ★ 顺序 = trim → toLowerCase → 剥前导符号：先小写可让大写 `V` 前缀一并被剥掉（原序只剥小写 v，
 *   `V0.1.7` 会因残留 `v` 而误判）。
 */
function normalizeVersionToken(v) {
  return String(v ?? "").trim().toLowerCase().replace(/^[\^~>=<\s*v]+/, "")
}

/**
 * 源②：profile manifest（DSH home 根的 package.json）里的 dsh 依赖声明。
 * 优先 @deepseek-ai/dsh-core，否则首个 @deepseek-ai/dsh 前缀键；声明值须能解析出**具体版本**
 * （范围符剥除后以数字开头），workspace:/catalog: 之类的非具体声明 ⇒ 不可得（null，不猜）。
 * ★ 批 31 评审 #2（🔵）：选中键**不是版本权威**（见 MANIFEST_AUTHORITY_KEYS）时，evidence 追加
 *   skew 标记——判据面（返回值与 source）逐字不变，只让假告警当场可辨。
 */
function versionFromProfileManifest(opts, notes) {
  const note = (s) => { if (Array.isArray(notes)) notes.push(s) }
  try {
    const home = pickDshHome(opts?.dshHomeOverride, opts?.cwdHint)
    if (typeof home !== "string" || home === "") { note("② DSH_HOME 不可解析"); return null }
    const manifestPath = join(home, "package.json")
    let manifest = null
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) } catch (e) { note("② " + manifestPath + " → " + shortErr(e)); return null }
    const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) }
    // 批 29 / US-4 🔵④：谓词化简为**单一前缀判据**。原写法
    //   `k === "@deepseek-ai/dsh-core" || (k.startsWith("@deepseek-ai/dsh") && k !== "@deepseek-ai/dsh-core")`
    // 与「startsWith 前缀」在**集合上恒等**：第一项蕴含于第二项（core 键自带该前缀），而第二项
    // 排除的正是同一个 core 键、第一项又把它按同值加回来 ⇒ 化简后结果集（与 keys[0] 的选取）
    // 逐字不变，只是去掉了两个永久冗余的分支。
    const keys = Object.keys(deps).filter((k) => k.startsWith("@deepseek-ai/dsh"))
    const key = keys.includes("@deepseek-ai/dsh-core") ? "@deepseek-ai/dsh-core" : keys[0]
    if (!key) { note("② " + manifestPath + " 里无 @deepseek-ai/dsh* 依赖键"); return null }
    const m = String(deps[key] ?? "").trim().match(/^[\^~>=<\s]*v?([0-9][A-Za-z0-9.+-]*)$/)
    if (!m) { note("② 键 " + key + " 的声明 " + JSON.stringify(deps[key]) + " 不是具体版本"); return null } // 非具体版本声明（workspace:*/catalog: 等）——不猜
    const skew = MANIFEST_AUTHORITY_KEYS.includes(key)
      ? ""
      : "（非版本权威键：可能是其它插件的版本声明 ⇒ 环境 skew 风险，本值未必是平台版本）"
    return { version: m[1], source: "profile-manifest", evidence: manifestPath + " → " + key + "@" + String(deps[key]) + skew }
  } catch (e) { note("② 未预期异常：" + shortErr(e)); return null }
}

/**
 * 源③：**平台服务** `pluginManager` 报告的平台自带组合包版本。
 * 平台把「本次安装自带的组合包」连同版本一起列出来（`listBundles()`），平台包与安装同版号 ⇒
 * 取其中的平台成员即得运行版本。**只认 PLATFORM_BUNDLE_NAMES 里的名字**（理由见该常量的 doc）。
 * 服务缺席（ctx.get 不可用 / 无该服务）/ 调用抛错 / 清单里没有平台成员 ⇒ null（不猜）。
 * ★ 只读：不注册、不写盘、不改平台状态（与 D28-4 一致）。
 * ★ 批 31 实测补记：本机（桌面版）**这一源没有命中**——0.2.0-rc.1 与 0.2.0-rc.2 两轮真机读数都由
 *   源④a 命中（`contractWatch` 的 `versionSource` = `package-json`），本源的缺席**没有**逐源原因可读，
 *   正是这一条促成了「每个源失败都写一行 notes」的补强。合成树里该服务是**条件启用**的
 *   （`disabled: !ctx.get("profileContext")`），因此本源的可用性随宿主而异。⇒ 每次失败都往 `notes`
 *   里写**一行可读原因**（缺席/抛错/清单里没有平台成员），由 readPlatformVersion 汇进 evidence。
 * @param {{get?: (name: string) => unknown}|null|undefined} ctx 宿主 ctx
 * @param {string[]} [notes] 逐源诊断行（追加）
 */
function versionFromPluginManager(ctx, notes) {
  const note = (s) => { if (Array.isArray(notes)) notes.push(s) }
  try {
    if (typeof ctx?.get !== "function") { note("③ ctx 无 get()（宿主未注入 ctx 或为夹具）"); return null }
    let manager = null
    try { manager = ctx.get("pluginManager") } catch (e) { note("③ ctx.get(pluginManager) 抛错：" + shortErr(e)); return null }
    if (manager === null || manager === undefined) { note("③ 无 pluginManager 服务（该组合包条件启用：disabled: !ctx.get('profileContext')）"); return null }
    if (typeof manager.listBundles !== "function") { note("③ pluginManager 无形如函数的 listBundles()"); return null }
    let bundles = null
    try { bundles = manager.listBundles() } catch (e) { note("③ listBundles() 抛错：" + shortErr(e)); return null }
    if (!Array.isArray(bundles)) { note("③ listBundles() 未返回数组（实为 " + typeof bundles + "）"); return null }
    for (const wanted of PLATFORM_BUNDLE_NAMES) {
      const row = bundles.find((b) => b && b.name === wanted && typeof b.version === "string" && b.version.trim() !== "")
      if (row) {
        return {
          version: row.version.trim(),
          source: "plugin-manager",
          evidence: "pluginManager.listBundles() → " + wanted + "@" + row.version.trim(),
        }
      }
    }
    // 清单读到了、但没有平台成员（或它们没有 version）——把**见过的名字**留下来，便于判读
    const seen = bundles.map((b) => (b && typeof b.name === "string" ? b.name : "?")).slice(0, 8).join(",")
    note("③ listBundles() 共 " + bundles.length + " 条，但无 " + PLATFORM_BUNDLE_NAMES.join("/") + " 带版本的行（前几条：" + seen + "）")
  } catch (e) { note("③ 未预期异常：" + shortErr(e)) }
  return null
}

/** 一行错误摘要（诊断用；不抛）。 */
function shortErr(e) {
  try {
    const code = e && typeof e.code === "string" ? e.code + " " : ""
    return code + String((e && e.message) || e).slice(0, 120)
  } catch { return "unprintable" }
}

/**
 * 源④a：**桌面版 Electron 布局**下的平台包（`<exe 同级>/resources/app.asar/dsh/node_modules/…`）。
 * 为什么单列一条：桌面版把平台装在 `app.asar` 内，`createRequire(import.meta.url)` 从插件自身包树
 * **解析不到**任何平台包（批 31 实测）；而这个布局可从 `process.execPath` 直接推出。
 * 能否读到取决于**宿主进程的 fs 是否 asar 感知**——读不到只是本候选落空（每次失败写一行原因，
 * `error.code` 原样带上，下一轮真机读数即可判定）。
 * @param {string[]} [notes]
 */
function versionFromExecPathLayout(notes) {
  const note = (s) => { if (Array.isArray(notes)) notes.push(s) }
  try {
    const roots = []
    const resourcesPath = typeof process?.resourcesPath === "string" ? process.resourcesPath : ""
    if (resourcesPath !== "") roots.push(join(resourcesPath, "app.asar"))
    const exe = typeof process?.execPath === "string" ? process.execPath : ""
    if (exe !== "") {
      const near = join(dirname(exe), "resources", "app.asar")
      if (!roots.includes(near)) roots.push(near)
    }
    if (roots.length === 0) { note("④a 无 process.execPath / process.resourcesPath"); return null }
    for (const root of roots) {
      // ★ 批 31 评审 #5：**每个 root 只留一行**（候选全 miss 时汇总，只带首个 error.code）——
      //   逐路径各记一行会把 evidence 刷成 12 行路径墙，反而稀释源③ 那种真正有判读价值的行。
      let tried = 0
      let firstErr = ""
      for (const sub of [["dsh", "node_modules"], ["node_modules"]]) {
        for (const name of PLATFORM_PACKAGE_NAMES) {
          const p = join(root, ...sub, ...name.split("/"), "package.json")
          tried++
          try {
            const v = JSON.parse(readFileSync(p, "utf8"))?.version
            if (typeof v === "string" && v.trim() !== "") {
              return { version: v.trim(), source: "package-json", evidence: p + " version = " + v.trim() }
            }
          } catch (e) { if (firstErr === "") firstErr = shortErr(e) }
        }
      }
      note("④a " + root + " 下 " + tried + " 个候选全 miss（首个错误：" + firstErr + "）")
    }
  } catch (e) { note("④a 未预期异常：" + shortErr(e)) }
  return null
}

/**
 * 源④b：进程可见的**平台包**版本（按 PLATFORM_PACKAGE_NAMES 顺序 `require.resolve` 后读 version）。
 * 解析失败（插件不在宿主包树内 / 包不存在）⇒ null。首选 `dsh-app-boot`：平台自己的版本权威读的
 * 就是它自己的 package.json。
 * @param {string[]} [notes]
 */
function platformPackageVersion(notes) {
  const note = (s) => { if (Array.isArray(notes)) notes.push(s) }
  let req = null
  try { req = createRequire(import.meta.url) } catch (e) { note("④b createRequire 失败：" + shortErr(e)); return null }
  for (const name of PLATFORM_PACKAGE_NAMES) {
    try {
      const pkgPath = req.resolve(name + "/package.json")
      const v = JSON.parse(readFileSync(pkgPath, "utf8"))?.version
      if (typeof v === "string" && v.trim() !== "") {
        return { version: v.trim(), source: "package-json", evidence: pkgPath + " version = " + v.trim() }
      }
      note("④b " + name + " 解析到但无 version 字段")
    } catch (e) { note("④b " + name + " → " + shortErr(e)) }
  }
  return null
}

/** 源④ 的默认实现：先桌面 Electron 布局（④a），再常规包解析（④b）。 */
function resolvePlatformPackageDefault(notes) {
  return versionFromExecPathLayout(notes) ?? platformPackageVersion(notes)
}

/**
 * 旁证（bystander evidence）——**只进 evidence，绝不参与判定**（批 31 真机复盘补，D31-2）。
 *
 * 动因（真机 2026-09-30 00:16 复盘）：本机四源里只有 ④a 能命中，而 ④a 读的是 `app.asar` ——
 * 那个文件在平台换代时是**整体替换**（实测当前这份的 CreationTime 是 00:14:38，新建而非原地改，
 * 121 MB）。也就是说**哨兵最需要响的那一刻（平台换版）恰好是它最容易瞎的窗口**。真机确实瞎过一次：
 * `contractWatch` 报 `unknown`，而事后**无从复盘**——装配期的 warn 只进宿主 stderr（DSH 只在内存里
 * 滚动、异常退出才 dump，那次没留下），工具返回体里也没有任何可比对的第二读数。
 *
 * 为什么不干脆把下面这些读到的版本**当第五个源**：因为它们**会滞后也会领先**。实测
 * `<DSH_HOME>/dsh-runtimes/dsh-primary-runtime/runtime.json` 的 `desktopVersion` 现在写着
 * `0.2.0-rc.1`（本轮运行时预置时写的），而平台已经是 `0.2.0-rc.2`。拿它当源 ⇒ 判定从「读不到」
 * 变成「读错」，哨兵会对着正确的平台发假告警。**哨兵假告警比哨兵瞎更坏**：瞎了你知道去查，
 * 假告警会让你去改本来没坏的东西。⇒ 它们只作为「同一时刻的第二读数」写进 evidence，供人判读。
 *
 * 零新增依赖、零网络、零子进程、零写盘（与 D28-4 一致）；每一项读不到都只让那一项留空。
 * @param {{dshHomeOverride?: string, cwdHint?: string, localAppDataOverride?: string}} [opts]
 *   与源②同款的 home 探测缝；`localAppDataOverride` 是旁证② 的注入缝（测试用——缺省读
 *   `process.env.LOCALAPPDATA`，与源④a 读 `process.execPath/resourcesPath` 同属「进程可见的环境」）
 * @returns {string} 「 ｜ 」分隔的旁证行；一项都没有 ⇒ "（未取到任何旁证）"
 */
function bystanderEvidence(opts) {
  const out = []
  const stamp = (p) => { try { return "（mtime " + statSync(p).mtime.toISOString() + "）" } catch { return "" } }
  // ① 运行时预置记录：<DSH_HOME>/dsh-runtimes/<name>/runtime.json 的 desktopVersion
  try {
    const home = pickDshHome(opts?.dshHomeOverride, opts?.cwdHint)
    if (typeof home === "string" && home !== "") {
      const root = join(home, "dsh-runtimes")
      let dirs = []
      try { dirs = readdirSync(root).sort() } catch { dirs = [] }
      for (const d of dirs) {
        const p = join(root, d, "runtime.json")
        try {
          const v = JSON.parse(readFileSync(p, "utf8"))?.desktopVersion
          if (typeof v === "string" && v.trim() !== "") {
            out.push("runtime.json desktopVersion=" + v.trim() + " " + p + stamp(p))
          }
        } catch { /* 该 dir 没有可读 runtime.json ⇒ 跳过，不留噪 */ }
      }
      if (dirs.length === 0) out.push("runtime.json：<DSH_HOME>/dsh-runtimes 下无运行时目录")
    }
  } catch { /* 旁证永不抛 */ }
  // ② 更新器待装包：<LOCALAPPDATA>\<*updater>\pending\update-info.json 的 fileName 带版本号
  try {
    const local = typeof opts?.localAppDataOverride === "string" && opts.localAppDataOverride !== ""
      ? opts.localAppDataOverride
      : (typeof process?.env?.LOCALAPPDATA === "string" ? process.env.LOCALAPPDATA : "")
    if (local !== "") {
      let updaters = []
      try { updaters = readdirSync(local).filter((n) => /dsh/i.test(n)).sort() } catch { updaters = [] }
      if (updaters.length === 0) out.push("更新器待装包：该 LOCALAPPDATA 下无 dsh 系 *updater 目录")
      for (const u of updaters) {
        const p = join(local, u, "pending", "update-info.json")
        try {
          const info = JSON.parse(readFileSync(p, "utf8"))
          const fn = typeof info?.fileName === "string" ? info.fileName.trim() : ""
          // ★ 只认 **DSH 自己的载荷名**（真机实测补）：本机 %LOCALAPPDATA% 下有 6 个 electron-updater
          //   应用的 `*-updater\pending\update-info.json`（MiniMax Code / ZCode / Cherry Studio /
          //   uTools / NGP…）。光按目录名匹配会把这 6 个应用的版本一起刷进 evidence —— 正是本档在
          //   源④a 处明确反对过的「把 evidence 刷成路径墙」。⇒ 目录名先粗筛（含 dsh），载荷名再精确判据，
          //   且**只取第一条**。
          if (/^(deepseek[-_]?harness|dsh)[-_]/i.test(fn)) {
            out.push("待装包 fileName=" + fn + " " + p + stamp(p))
            break
          }
        } catch { /* 没有 pending 待装包（已安装完毕/尚未下载）⇒ 跳过 */ }
      }
    } else out.push("更新器待装包：LOCALAPPDATA 不可读")
  } catch { /* 同上 */ }
  // 「查过、没有」也要写出来：它把「没查」与「查了没有」分开——上一轮真机复盘最缺的就是这个区分。
  return out.length > 0 ? out.join(" ｜ ") : "（HOME 与 LOCALAPPDATA 都不可读，未取任何旁证）"
}

/**
 * 平台版本**四源读取链**（§2.2 钉死顺序；单一事实源——哨兵与 contractWatch 工具共用）。
 * ★ 批 31：每个源失败都往 `notes` 写一行**可读原因**，汇入 unknown 分支的 evidence（真机读数
 *   直接可判读，不必再靠猜——这条正是批 31 第一轮真机读数拿不到版本时补的）。
 * @param {{pkg?: {version?: unknown}, get?: (name: string) => unknown}|null|undefined} ctx 宿主 ctx
 *   （① 的注入点与 ③ 的服务入口；可为空）
 * @param {{dshHomeOverride?: string, cwdHint?: string, resolvePlatformPackage?: () => {version: string, source: string, evidence: string}|null}} [opts]
 *   注入缝：dshHomeOverride/cwdHint 透传给源②的 home 探测；resolvePlatformPackage 替换源④
 *   （测试注入「包不可解析」⇒ 传 () => null）。源③ 用 ctx 注入假服务即可钉死（见测试档 A28-3）。
 * @returns {{version: string, source: string, evidence: string}}
 *   version：取到的版本串；四源皆不可得 ⇒ "unknown"（A28-3：不猜、不崩）。
 *   source/evidence：VERSION_SOURCES 之一 + 「版本取自哪个源」的一手出处（unknown 时 evidence 附逐源诊断）。
 */
export function readPlatformVersion(ctx, opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const notes = []
  // ① 宿主注入
  try {
    const pv = ctx?.pkg?.version
    if (typeof pv === "string" && pv.trim() !== "") {
      return { version: pv.trim(), source: "ctx.pkg", evidence: "ctx.pkg.version = " + JSON.stringify(pv.trim()) }
    }
    notes.push("① ctx.pkg.version 缺失")
  } catch (e) { notes.push("① ctx.pkg 读取抛错：" + shortErr(e)) }
  // ② profile manifest 的 dsh 依赖声明
  const viaManifest = versionFromProfileManifest(o, notes)
  if (viaManifest) return viaManifest
  // ③ 平台服务 pluginManager 报告的平台自带组合包版本
  const viaManager = versionFromPluginManager(ctx, notes)
  if (viaManager) return viaManager
  // ④ 平台包版本（④a 桌面 Electron 布局 → ④b 常规解析）
  const viaPackage = (typeof o.resolvePlatformPackage === "function" ? o.resolvePlatformPackage : resolvePlatformPackageDefault)(notes)
  if (viaPackage) return viaPackage
  return {
    version: "unknown",
    source: "unknown",
    evidence: "四源皆不可得（ctx.pkg / profile manifest 的 dsh 依赖声明 / pluginManager 的平台组合包版本 / 平台包解析）"
      + "——按 unknown 处理（A28-3：不猜、不崩）。逐源诊断：" + (notes.length > 0 ? notes.join(" ｜ ") : "（无）")
      // ★ 批 31 真机复盘补（D31-2）：判定不变，只是把「同一时刻的第二读数」一并交出来 —— 上一次
      //   真机瞎掉时，事后连一个可比对的数都没有（见 bystanderEvidence 的头注）。
      + "。旁证（**不参与判定**，会滞后也会领先，只供人判读）：" + bystanderEvidence(o),
  }
}

// ————————————— 版本哨兵（US-2 / D28-1） —————————————

/**
 * 平台版本门槛的**人读指引**（批 31）：本仓当前版本只支持 DSH ≥ 0.2.0-rc.1。
 * 两条分支共用——比基线**更旧**的平台应当去用**旧版 release**（v0.29.11 及更早），而不是硬跑本版。
 * 刻意**不写「自 vX.Y.Z 起」**：那句会随每次发版失同步（文档卫生第 4 条），而「当前版本的支持面 =
 * 基线」这条由 PLATFORM_VERSION_BASELINE 单源渲染。
 */
const SUPPORT_FLOOR_HINT = "本仓当前版本只支持 DSH ≥ " + PLATFORM_VERSION_BASELINE
  + "（组合包已在 package.json 声明 peerDependencies @deepseek-ai/dsh，详见 README 安装节与 CHANGELOG）；平台低于该版本时请改用旧版 release（v0.29.11 支持 0.1.7-rc.2）"

/** 不一致分支的响亮告警文案（必须含基线档与 docs/dsh017- 设计档字样——A28-2 主判据）。 */
function mismatchWarning(found) {
  return "[thincoder-suite] 平台版本哨兵（批 28 / D28-1，只警告不阻断）：检测到平台版本 " + found.version
    + "（来源 " + found.source + "；" + found.evidence + "）与本仓验证基线 " + PLATFORM_VERSION_BASELINE
    + "（记录于 lib/contract-baseline.mjs，基线时点 " + BASELINE_RECORDED_AT + "）不一致——平台可能已换契约，"
    + "九条平台触点锁可能失配。请对照契约矩阵与结项说明 docs/dsh017-program-closeout.md（批次细节："
    + "docs/dsh017-batch26-design.md / docs/dsh017-batch27-design.md / docs/dsh017-batch28-design.md），"
    + "或调用只读巡检工具 contractWatch 一次看清九条锁现状。" + SUPPORT_FLOOR_HINT + "。"
}

/** 取不到版本分支的告警文案（A28-3：标 unknown + 告警 + 不崩；同样指向基线与设计档）。 */
function unknownWarning(detail) {
  return "[thincoder-suite] 平台版本哨兵（批 28 / A28-3，不猜不崩）：平台版本不可解析——" + detail
    + "。按 unknown 处理（不猜、不阻断装配）。基线 " + PLATFORM_VERSION_BASELINE + " 记录于 "
    + "lib/contract-baseline.mjs，契约矩阵见 docs/dsh017-program-closeout.md 与 docs/dsh017-batch28-design.md；"
    + "可调用只读巡检工具 contractWatch 查看九条触点锁现状。" + SUPPORT_FLOOR_HINT + "。"
}

/**
 * 版本哨兵的**纯判定**（无副作用——warnings 以数组返回，测试据此断言；A28-1/2/3 的可注入入口）。
 * @returns {{status: string, version: string, source: string, evidence: string, warnings: string[]}}
 *   status ∈ "match" | "mismatch" | "unknown"；match ⇒ warnings 为空（A28-1 零告警）。
 */
export function evaluateVersionSentinel(ctx, opts) {
  const found = readPlatformVersion(ctx, opts)
  if (found.source === "unknown") {
    return { status: "unknown", version: found.version, source: found.source, evidence: found.evidence, warnings: [unknownWarning(found.evidence)] }
  }
  if (normalizeVersionToken(found.version) === normalizeVersionToken(PLATFORM_VERSION_BASELINE)) {
    return { status: "match", version: found.version, source: found.source, evidence: found.evidence, warnings: [] }
  }
  return { status: "mismatch", version: found.version, source: found.source, evidence: found.evidence, warnings: [mismatchWarning(found)] }
}

/**
 * 装配期告警的进程级 once 标记（多次 apply / fiber 重建只响一次——与弃用密钥告警同款）。
 * ★ 批 29 / US-4 🔵⑤：本闩的 `unknown` 与 `mismatch` **共用**（`runVersionSentinel` 对任一非空
 *   `warnings` 都置位）⇒ **首个 unknown 会占坑**：若进程先以 unknown 响过一次，此后真出 mismatch
 *   时**不会再响**——告警总量仍是「每进程恰一次」，只是那一句的内容停在**先到**的形态上。
 *   这是**有意的取舍**（装配期只该响一次、防刷屏；两形态的告警文案各自都能指明出路），
 *   如实写明以免被读成「unknown / mismatch 各响一次」。行为腿见
 *   `test/contract-baseline.test.mjs` 的 A29-6⑤ 条。 */
let sentinelWarned = false

/**
 * 版本哨兵的装配期入口（lib/index.mjs apply 调用；**只警告不阻断**——D28-1）。
 * match ⇒ 静默；mismatch/unknown ⇒ 恰一条 console.warn（进程级 once）。绝不抛、绝不阻断。
 * @param {{warn?: (...a: unknown[]) => void}} [opts] warn 注入缝（测试收集器；缺省 console.warn）
 */
export function runVersionSentinel(ctx, opts) {
  const r = evaluateVersionSentinel(ctx, opts)
  if (r.warnings.length > 0 && !sentinelWarned) {
    sentinelWarned = true
    const warn = typeof opts?.warn === "function" ? opts.warn : (...a) => console.warn(...a)
    for (const w of r.warnings) warn(w)
  }
  return r
}

/** 测试缝：清装配期 once 标记（对齐 index.mjs 的 resetDeprecatedSecretEnvWarnForTests 先例）。 */
export function resetVersionSentinelWarnForTests() { sentinelWarned = false }

// ————————————— 九条平台触点谓词（批 26 §2.3 #1…#9 的唯一实现；A28-5） —————————————

const LIB_DIR = dirname(fileURLToPath(import.meta.url))

/** lib 兄弟模块源文本读取（读不到 ⇒ null——谓词据此记 "unknown"，D28-7）。 */
function readLibText(f) {
  try { return readFileSync(join(LIB_DIR, f), "utf8") } catch { return null }
}

/** lib 目录的 .mjs 清单（确定性排序；目录不可读 ⇒ 空数组——lockPs7 据此记 "unknown"）。 */
function listLibFiles() {
  try { return readdirSync(LIB_DIR).filter((f) => f.endsWith(".mjs")).sort() } catch { return [] }
}

/** 九条锁的 id（钉死枚举；与批 26 §2.3 的 #1…#9 一一对应）。 */
export const LOCK_IDS = Object.freeze([
  "ps1-llm-tool-result-msg",
  "ps2-jobs-start-owner",
  "ps3-jobs-output-contract",
  "ps4-home-probe-dual-name",
  "ps5-subagents-start-shape",
  "ps6-agent-session-fields",
  "ps7-registration-surface",
  "ps8-request-rejection-fence",
  "ps9-dispatch-copy-persisted-path",
])

/**
 * 注册面期望计数（#7 的**实测基线写死**，批 26 §2.3 #7「不变以该数字为准」）。
 *
 * ★ 批 28 上调登记（D28-6；先例 = 批 26 §2.5 对 T-SG4 的同批改锁处理）：
 *   textTool 注册点 **7 → 8** —— 本批在 lib/index.mjs 新增了只读巡检工具 contractWatch
 *   （每新增一个工具 ⇒ 计数 +1；不同批上调即「被自家锁打红后临场解释」，设计明文禁止）。
 *   toolsRegister=1 与 systemPrompt 提示词组=3 两值不受本批影响（fresh grep @2026-09-26 复核）。
 */
export const REGISTRATION_SURFACE_BASELINE = Object.freeze({
  toolsRegister: 1,
  systemPromptSection: 3,
  textTool: 8, // 批 28 上调（原批 26 基线 7 → 8）：新增只读巡检工具 contractWatch（D28-6）
})

// — #1 llm 工具结果消息（批 25 矩阵 #1 / D-41 的常设复述） —

function lockPs1(readText) {
  const id = LOCK_IDS[0]
  const advisor = readText("advisor.mjs")
  if (advisor === null) {
    return { id, ok: "unknown", evidence: "advisor.mjs 源文本不可读（D28-7：记 unknown 而非 false）" }
  }
  const bad = []
  if ((advisor.match(/role: "tool",/g) ?? []).length !== 1) {
    bad.push("tool 角色消息构造点应恰 1 处（role: tool 字段出现第二处即形状漂移）")
  }
  const iFn = advisor.indexOf("function toolResultMsg(")
  if (!(iFn > 0)) {
    bad.push("toolResultMsg 不可定位")
  } else {
    const body = advisor.slice(iFn, advisor.indexOf("\n}", iFn))
    for (const field of ["toolCallId: callId", "isError: false", "source: { kind: \"tool\", callId }"]) {
      if (!body.includes(field)) bad.push("构造点缺消息级字段：" + field + "（0.1.7 契约 = 字段在消息级，不在块内）")
    }
  }
  if ((advisor.match(/type: "tool-result"/g) ?? []).length !== 0) {
    bad.push("0.1.6 旧形状（user 消息内 tool-result 块）残留——必须零残留")
  }
  if (bad.length > 0) return { id, ok: false, evidence: "advisor.mjs：" + bad.join("；") }
  return { id, ok: true, evidence: "advisor.mjs：toolResultMsg 恰 1 处且带消息级 toolCallId/isError/source；0.1.6 旧形状零残留" }
}

// — #2 jobs.start 的 owner（derived：与 test/dsh017-compat.test.mjs 的 D-42b 同锁，两处同改） —

function lockPs2(readText) {
  const id = LOCK_IDS[1]
  const files = ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]
  const texts = []
  for (const f of files) {
    const s = readText(f)
    if (s === null) return { id, ok: "unknown", evidence: f + " 源文本不可读（D28-7：记 unknown 而非 false）" }
    texts.push([f, s])
  }
  const bad = []
  let starts = 0
  let owners = 0
  for (const [f, s] of texts) {
    const st = (s.match(/jobs\.start\(\{/g) ?? []).length
    const ow = (s.match(/owner: ownerIdOf\(agent\)/g) ?? []).length
    if (ow !== st) bad.push(f + ": jobs.start 与 ownerIdOf 不一一对应（" + st + " vs " + ow + "）")
    if ((s.match(/owner:\s*agent\s*,/g) ?? []).length !== 0) bad.push(f + ": 直传 Agent 对象（0.1.7 报 no live agent）")
    starts += st
    owners += ow
  }
  if (starts !== 7) bad.push("四档 jobs.start 合计应为 7（derived 登记值；新增派发点须两处同改：本基线 + dsh017-compat D-42b），实测 " + starts)
  if (owners !== 7) bad.push("四档 ownerIdOf 合计应为 7，实测 " + owners)
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "advisor/consult/eng/escalate：jobs.start 与 owner: ownerIdOf(agent) 7↔7 一一对应；零处直传 Agent 对象" }
}

// — #3 jobs 输出契约（derived：与 test/dsh017-compat.test.mjs 的 D-46-static 同锁，两处同改） —

function lockPs3(readText) {
  const id = LOCK_IDS[2]
  const files = ["advisor.mjs", "consult.mjs", "eng.mjs", "escalate.mjs"]
  const texts = []
  for (const f of files) {
    const s = readText(f)
    if (s === null) return { id, ok: "unknown", evidence: f + " 源文本不可读（D28-7：记 unknown 而非 false）" }
    texts.push([f, s])
  }
  const bad = []
  let starts = 0
  let handles = 0
  for (const [f, s] of texts) {
    const st = (s.match(/jobs\.start\(\{/g) ?? []).length
    const h = (s.match(/run:\s*\(handle\)\s*=>/g) ?? []).length
    if (h !== st) bad.push(f + ": run(handle) 数应等于 jobs.start 数（收 0.1.7 句柄），实测 " + h + " vs " + st)
    if ((s.match(/run:\s*\(\)\s*=>/g) ?? []).length !== 0) bad.push(f + ": 存在无参 run（0.1.6 形态）")
    if (!s.includes("from \"./job-outcome.mjs\"")) bad.push(f + ": 正文未经 jobOutcome 收口（单点，D-46/D-45）")
    if ((s.match(/jobOutcome\(handle,/g) ?? []).length < 1) bad.push(f + ": 零处 jobOutcome(handle, …) 调用")
    starts += st
    handles += h
  }
  if (starts !== 7) bad.push("四档 jobs.start 合计应为 7（derived 登记值；两处同改：本基线 + dsh017-compat D-46-static），实测 " + starts)
  if (handles !== 7) bad.push("四档 run(handle) 合计应为 7，实测 " + handles)
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "advisor/consult/eng/escalate：run(handle) 7↔7、零无参 run、正文经 jobOutcome 收口" }
}

// — #4 settings.yaml 改名（derived：与 D-40 的 U6d 同锁，两处同改） —

function lockPs4(readText) {
  const id = LOCK_IDS[3]
  const home = readText("dsh-home.mjs")
  if (home === null) {
    return { id, ok: "unknown", evidence: "dsh-home.mjs 源文本不可读（D28-7：记 unknown 而非 false）" }
  }
  const bad = []
  if (!home.includes("existsSync(join(dir, \"settings.yaml\")) || existsSync(join(dir, \"settings.yaml.imported\"))")) {
    bad.push("双名特征判定行不在场（0.1.7 起旧名会被宿主改名 ⇒ 只认旧名 = 无 env 部署设置页 500）")
  }
  if (!home.includes("existsSync(join(dir, \"sessions\"))")) {
    bad.push("sessions/ 特征不在场（判定不得被放宽成「有 settings 就算」的反向：门必须仍要它）")
  }
  if (bad.length > 0) return { id, ok: false, evidence: "dsh-home.mjs：" + bad.join("；") }
  return { id, ok: true, evidence: "dsh-home.mjs：probeProfileRoot 同时接受 settings.yaml 与 settings.yaml.imported，且 sessions/ 特征仍在" }
}

// — #5 subagents.start 形状（批 25 矩阵 #5：0.1.6/0.1.7 逐字一致的平台面） —
//
// ★ 与批 26 设计档 §2.3 #5 的偏差**如实登记**（自批 26 起沿用）：设计给的键集合
//   {prompt,parent,signal,agentOptions,toolFilter,outputSchema} 漏了现有调用点实际在传的
//   persona / label / maxDepth（consult/eng/escalate 三档都在传）。锁钉**实测并集**（九键）：
//   出现并集之外的键（= 平台从未确认过的新形状）即红；outputSchema 现无人传，保留备将来。

/** 模板串引号字符（字符串感知配平必须识别它；用 String.fromCharCode 避免本文件出现裸反引号）。 */
const BT = String.fromCharCode(96)

/** 字符串感知的花括号配平：返回 start（指向“{”）对应的闭括号下标。（自 platform-surface.test.mjs 迁入，逐字实现。） */
function objectEnd(source, start) {
  let depth = 0
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === BT) {
      const q = ch
      i++
      while (i < source.length && source[i] !== q) i += source[i] === "\\" ? 2 : 1
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** 在 [start, end) 内按**顶层深度**收参数键（depth 1 = 对象第一层）；展开语法回查同名 const 定义。（迁入，逐字实现。） */
function collectKeys(source, start, end, keys, followSpreads) {
  let depth = 0
  let i = start
  while (i < end) {
    const ch = source[i]
    if (ch === '"' || ch === "'" || ch === BT) {
      const q = ch
      i++
      while (i < end && source[i] !== q) i += source[i] === "\\" ? 2 : 1
    } else if (ch === "{" || ch === "(" || ch === "[") {
      depth++
    } else if (ch === "}" || ch === ")" || ch === "]") {
      depth--
    } else if (depth === 1 && ch === "." && source[i + 1] === "." && source[i + 2] === ".") {
      let j = i + 3
      let name = ""
      while (j < end && /[\w$]/.test(source[j])) name += source[j++]
      if (followSpreads && name) {
        const defAt = source.indexOf("const " + name + " = {")
        if (defAt >= 0) {
          const objAt = defAt + ("const " + name + " = ").length // 指向“{”本身（与主调用同口径：起点在括号上）
          collectKeys(source, objAt, objectEnd(source, objAt), keys, false)
        }
      }
    } else if (depth === 1 && /[A-Za-z_$]/.test(ch)) {
      let j = i
      let name = ""
      while (j < end && /[\w$]/.test(source[j])) name += source[j++]
      let k = j
      while (k < end && source[k] === " ") k++
      if (source[k] === ":") keys.add(name)
      i = j
      continue
    }
    i++
  }
}

function lockPs5(readText) {
  const id = LOCK_IDS[4]
  const ALLOWED = new Set(["prompt", "parent", "signal", "agentOptions", "toolFilter", "outputSchema", "persona", "label", "maxDepth"])
  const files = ["consult.mjs", "eng.mjs", "escalate.mjs"]
  const texts = []
  for (const f of files) {
    const s = readText(f)
    if (s === null) return { id, ok: "unknown", evidence: f + " 源文本不可读（D28-7：记 unknown 而非 false）" }
    texts.push([f, s])
  }
  const bad = []
  let siteCount = 0
  for (const [f, s] of texts) {
    const keys = new Set()
    const re = /ctx\.subagents\.start\("spawn",\s*\{/g
    let m
    while ((m = re.exec(s)) !== null) {
      siteCount++
      const objAt = m.index + m[0].length - 1
      collectKeys(s, objAt, objectEnd(s, objAt), keys, true)
    }
    const extra = [...keys].filter((k) => !ALLOWED.has(k))
    if (extra.length > 0) bad.push(f + ": subagents.start 出现平台未知键 " + JSON.stringify(extra) + "——换契约时最先红在这里")
    if (keys.size > 0 && !(keys.has("prompt") && keys.has("parent"))) {
      bad.push(f + ": 基本形状（prompt+parent）不在场")
    }
  }
  // advisor 不经 subagents.start（dsh 主路径走 llm 循环）——调用点恰在另外三档，合计 6
  //（consult 2 = 白名单降级腿 · eng 2 = 后台/同步 · escalate 2 = 后台/同步）
  if (siteCount !== 6) bad.push("subagents.start 调用点合计应为 6（consult 2 + eng 2 + escalate 2），实测 " + siteCount)
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "consult/eng/escalate 共 6 个调用点：参数键 ⊆ 平台已知九键并集，prompt+parent 在场" }
}

// — #6 agent/session 字段（批 25 矩阵 #6；实谓词——对「实际消费面」断言，非「存在性」） —

function lockPs6(readText, fixtureText) {
  const id = LOCK_IDS[5]
  const eng = readText("eng.mjs")
  const advisor = readText("advisor.mjs")
  const consult = readText("consult.mjs")
  const escalate = readText("escalate.mjs")
  for (const [f, s] of [["eng.mjs", eng], ["advisor.mjs", advisor], ["consult.mjs", consult], ["escalate.mjs", escalate]]) {
    if (s === null) return { id, ok: "unknown", evidence: f + " 源文本不可读（D28-7：记 unknown 而非 false）" }
  }
  const bad = []
  // ① 会话键 = session.id（sessionState 按 id 键；jobs owner 按 id 查活代理——D-42 同一判据）
  if (!eng.includes("sessionState(agent.session.id)")) bad.push("eng: 会话状态未按 agent.session.id 键")
  for (const [f, s] of [["advisor", advisor], ["consult", consult], ["escalate", escalate]]) {
    if (!s.includes("agent.session.id")) bad.push(f + ": 未消费 agent.session.id")
  }
  // ② depth 门 = header.delegationDepth（只拦主代理的判据面；0.1.6/0.1.7 逐字同）
  if (!eng.includes("agent.session.header?.delegationDepth")) bad.push("eng: depth 门未消费 header.delegationDepth")
  // ③ cwd 基座消费（D-44 指纹基座 / D-47 冻结基座 / D48-2 验收 cwd 的同一来源）
  if (!advisor.includes("session?.header?.cwd")) bad.push("advisor: 未消费 session.header.cwd")
  if (!eng.includes("agent.session?.header?.cwd")) bad.push("eng: 未消费会话 cwd（D-44/D-47/D48-2 同一来源）")
  // ④ options.provider/model 消费链：agent.options ?? {} 收敛 → 子代理 agentOptions 显式透传（F9）
  if (!eng.includes("const agentOpts = agent.options ?? {}")) bad.push("eng: agent.options 未收敛到 agentOpts")
  if (!(eng.includes("provider: agentOpts.provider") && eng.includes("model: agentOpts.model"))) {
    bad.push("eng: provider/model 未经 agentOpts 显式传子代理")
  }
  if (!eng.includes("agentOpts.maxTokens")) bad.push("eng: maxTokens 未经 agentOpts 消费（F9 预算链）")
  // ⑤ 夹具文本腿（**仅测试侧**：fixtureText 由 test/platform-surface.test.mjs 传入自己的源文本；
  //    工具侧不传 ⇒ 本腿跳过——夹具形状是测试行为腿的契约面，不是 lib 的）
  let fixtureNote = ""
  if (typeof fixtureText === "string") {
    if (!fixtureText.includes("header: { cwd: PLUGIN_DIR }")) bad.push("夹具腿：行为腿夹具缺 header.cwd（cwd 语义实流）")
    if (!fixtureText.includes("options: { provider: \"p\", model: \"m\" }")) bad.push("夹具腿：行为腿夹具缺 options.provider/model")
    fixtureNote = "；夹具文本腿已检（本档行为腿夹具满足同一契约）"
  }
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "eng/advisor/consult/escalate：session.id / delegationDepth / header.cwd / options.provider·model / maxTokens 消费面逐点在场" + fixtureNote }
}

// — #7 注册面（期望计数 = 实测基线写死；上调登记见 REGISTRATION_SURFACE_BASELINE 上方注释，D28-6） —

function lockPs7(readText, listFiles) {
  const id = LOCK_IDS[6]
  let files
  try { files = listFiles() } catch { files = [] }
  if (!Array.isArray(files) || files.length === 0) {
    return { id, ok: "unknown", evidence: "lib 目录清单不可读（D28-7：记 unknown 而非 false）" }
  }
  let toolsRegister = 0
  let section = 0
  let textTool = 0
  let unread = 0
  for (const f of files) {
    const s = readText(f)
    if (s === null) { unread++; continue }
    toolsRegister += (s.match(/ctx\.tools\.register\(/g) ?? []).length
    section += (s.match(/systemPrompt\.section\(/g) ?? []).length
    if (f === "index.mjs") textTool += (s.match(/register\(textTool\(\{/g) ?? []).length
  }
  if (unread === files.length) {
    return { id, ok: "unknown", evidence: "lib 源文本全部不可读（D28-7：记 unknown 而非 false）" }
  }
  const B = REGISTRATION_SURFACE_BASELINE
  const bad = []
  if (toolsRegister !== B.toolsRegister) {
    bad.push("tools 注册消费点应为 " + B.toolsRegister + "（index.mjs 的统一 register helper；新增注册面须两处同改），实测 " + toolsRegister)
  }
  if (section !== B.systemPromptSection) {
    bad.push("systemPrompt 提示词组应为 " + B.systemPromptSection + "（index.mjs 2 处全局组 + eng.mjs 1 处 agent 作用域），实测 " + section)
  }
  if (textTool !== B.textTool) {
    bad.push("index.mjs 的 textTool 注册点应为 " + B.textTool
      + "（增删工具即红——防注册面静默漂移；基线上调登记见 REGISTRATION_SURFACE_BASELINE 注释：批 28 contractWatch ⇒ 8，D28-6），实测 " + textTool)
  }
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "注册面计数 = 实测基线（tools 消费点 " + B.toolsRegister + " · 提示词组 " + B.systemPromptSection
    + " · index.mjs textTool 注册点 " + B.textTool + "［批 28 上调 7→8：contractWatch，D28-6］）" }
}

// — #8 webServer 信任栅栏（批 25 矩阵 #8 / D-39 腿复述） —

function lockPs8(readText) {
  const id = LOCK_IDS[7]
  const index = readText("index.mjs")
  if (index === null) {
    return { id, ok: "unknown", evidence: "index.mjs 源文本不可读（D28-7：记 unknown 而非 false）" }
  }
  const bad = []
  const iHandler = index.indexOf("return async (req, res) => {")
  if (!(iHandler > 0)) {
    bad.push("api handler 不可定位")
  } else {
    const iFence = index.indexOf("const rejection = rejectionOf(req)", iHandler)
    const iUrl = index.indexOf("new URL(", iHandler)
    if (!(iFence > 0)) bad.push("栅栏判定调用不在场")
    else if (!(iUrl > iFence)) bad.push("栅栏未先于 URL 解析（处理函数首个业务调用必须是信任栅栏，D-39）")
  }
  const iRej = index.indexOf("const rejectionOf = (req) => {")
  if (!(iRej > 0 && iRej < iHandler)) {
    bad.push("rejectionOf 未定义在 handler 之前")
  } else {
    const rejBody = index.slice(iRej, index.indexOf("return 503", iRej))
    const iGet = rejBody.indexOf("ctx?.get?.(\"connection\")")
    const iAsk = rejBody.indexOf("connection.requestRejection(req)")
    if (!(iGet >= 0 && iAsk > iGet)) bad.push("栅栏未按序先取 connection 服务、再问请求拒绝（顺序不可反）")
  }
  if (bad.length > 0) return { id, ok: false, evidence: "index.mjs：" + bad.join("；") }
  return { id, ok: true, evidence: "index.mjs：api handler 首个业务调用 = 信任栅栏；栅栏先取 connection 服务再问请求拒绝，契约外 ⇒ 503 fail-closed" }
}

// — #9 读取面 ⇒ 插件侧取向：派发文案含首选落盘路径（文本锁，D-45）。★ 2026-09-28 更正：
// 当初的「读取面不在本仓」前提已撤回（真因是第三方插件改写 ctx.jobs.read，见
// docs/job-output-fallback.md §0）；文案取向本身不变——落盘为首选、job_output 为附加。 —

function lockPs9(readText) {
  const id = LOCK_IDS[8]
  const advisor = readText("advisor.mjs")
  if (advisor === null) {
    return { id, ok: "unknown", evidence: "advisor.mjs 源文本不可读（D28-7：记 unknown 而非 false）" }
  }
  const bad = []
  const i = advisor.indexOf("JOBS_CONTINUATION_INSTRUCTION =")
  if (!(i > 0)) {
    bad.push("共享接续指令不可定位")
  } else {
    const lit = advisor.slice(i, advisor.indexOf("\n", advisor.indexOf("job_output 作为附加", i)))
    if (!lit.includes("$DSH_HOME/.thincoder/jobs/<jobId>.txt")) bad.push("派发文案缺落盘路径字面（US-2：不必再问怎么绕）")
    if (!lit.includes("首选读落盘文件")) bad.push("文案未以落盘为首选")
    if (!lit.includes("job_output 作为附加")) bad.push("job_output 未降为附加（D-45 取向：落盘为首选、job_output 为附加保险）")
  }
  for (const f of ["consult.mjs", "eng.mjs", "escalate.mjs"]) {
    const s = readText(f)
    if (s === null) return { id, ok: "unknown", evidence: f + " 源文本不可读（D28-7：记 unknown 而非 false）" }
    if (!s.includes("jobsDispatchReply")) bad.push(f + ": 派发回复未经共享 helper（含首选落盘文案）")
  }
  if (bad.length > 0) return { id, ok: false, evidence: bad.join("；") }
  return { id, ok: true, evidence: "advisor：JOBS_CONTINUATION_INSTRUCTION 含落盘路径/首选落盘/job_output 附加；consult/eng/escalate 派发回复经共享 helper" }
}

/**
 * 九条触点谓词求值（唯一实现；test/platform-surface.test.mjs 与 contractWatch 工具共用——A28-5）。
 * @param {{readText?: (f: string) => string|null, listFiles?: () => string[], fixtureText?: string|null}} [opts]
 *   readText/listFiles：源文本注入缝（测试用「恒 null」钉死 D28-7 的 unknown 态）；
 *   fixtureText：#6 的夹具文本腿输入（仅测试侧传自己的源文本；缺省跳过该腿）。
 * @returns {{id: string, ok: true|false|"unknown", evidence: string}[]} 恒 9 条、顺序 = LOCK_IDS。
 */
export function evaluatePlatformSurfaceLocks(opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const readText = typeof o.readText === "function" ? o.readText : readLibText
  const listFiles = typeof o.listFiles === "function" ? o.listFiles : listLibFiles
  const fixtureText = typeof o.fixtureText === "string" ? o.fixtureText : null
  return [
    lockPs1(readText),
    lockPs2(readText),
    lockPs3(readText),
    lockPs4(readText),
    lockPs5(readText),
    lockPs6(readText, fixtureText),
    lockPs7(readText, listFiles),
    lockPs8(readText),
    lockPs9(readText),
  ]
}

// ————————————— 作业报告目录的只读状态（US-3 的 jobsDir 腿） —————————————

/**
 * $DSH_HOME/.thincoder/jobs/ 的**只读**盘点：{ files, bytes, oldestDays }。
 * files = 目录内普通文件数（含 index.jsonl——它也是目录状态的一部分）；bytes = 字节总和；
 * oldestDays = 最旧文件的 mtime 龄（天，向下取整；空目录/目录缺失 ⇒ 0）。
 * home 不可解析 / 目录不可读 ⇒ 全零（**只读**：不建目录、不写盘、不告警——巡检不是清扫）。
 * @param {{dshHomeOverride?: string, cwdHint?: string}} [opts]
 */
export function jobsDirStats(opts) {
  const o = opts && typeof opts === "object" ? opts : {}
  const out = { files: 0, bytes: 0, oldestDays: 0 }
  try {
    const home = pickDshHome(o.dshHomeOverride, o.cwdHint)
    if (typeof home !== "string" || home === "") return out
    const dir = join(home, ".thincoder", "jobs")
    const names = readdirSync(dir) // 目录缺失 ⇒ 抛 ⇒ 收敛为全零（只读，不 mkdir）
    let oldest = Number.POSITIVE_INFINITY
    for (const name of names) {
      let st = null
      try { st = statSync(join(dir, name)) } catch { continue }
      if (!st.isFile()) continue
      out.files += 1
      out.bytes += st.size
      oldest = Math.min(oldest, st.mtimeMs)
    }
    if (Number.isFinite(oldest)) out.oldestDays = Math.max(0, Math.floor((Date.now() - oldest) / 86400000))
  } catch { /* 只读巡检：任何读取故障都收敛为全零，绝不写入、绝不抛 */ }
  return out
}
