# 会诊纪要 —— consult #19（原始层，机制落盘）

- 日期：2026-09-17
- 会诊 id：19
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-6
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #19 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #19 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-6
minutes: docs/consult-minutes/2026-09-17-consult-19-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] zai-coding-cn:glm-5.3 — ok
设计问询已就绪。我通读了靶面全部代码（`dsh-home.mjs` 全档 · 三 store 全档 · `index.mjs`/`advisor.mjs`/`escalate.mjs`/`eng.mjs` 的全部调用点 · T6 原文 · 台账与发布门的机械耦合面）。以下是六问的逐一裁定，全部带档内证据。

---

## 先给总结论

**重试能治 R-13 的已观测类，但只能治一半——本批必须双腿落地：① 有界重试（治瞬态持有者）② 失败可见（治持续持有者）。只做 ① 就是超卖。** 证据：R-13 的 `actual` = 写前文件内容 ⇒ `saveSessionState` 的写被吞（`session-store.mjs:184-187` catch → warn → `return false`），而 T6 断言的是文件内容（`session-state.test.mjs:429-431`）、不查返回值。重试把瞬态窗口（实测 190ms 内释放）吃掉；持续持有者仍会耗尽重试走同一条吞掉路径——那时必须有一条**响的**失败线。

## Q1 重试策略：errno 集 · 次数 · 退避 · tmp 重写

| 维度 | 裁定 | 依据 |
|---|---|---|
| 可重试 errno | **`EPERM` / `EACCES` / `EBUSY`**；`ENOENT` 特判（见下）；其余（`ENOSPC`/`EIO`/`ENOTDIR`/`EISDIR`…）**立即抛** | Win32 共享违例经 libuv 映射后 `EPERM`(-4048) 与 `EACCES` 不可靠区分（你实测到 EPERM；`ERROR_ACCESS_DENIED` 类路径会以 EACCES 出现）——对本语义「可能是瞬态外部持有者」两者同义。误把真权限错当瞬态的代价 = 一次有界 240ms 后诚实失败，可接受 |
| 次数 × 退避 | **8 次 × 平铺 30ms**（总预算 ~250ms） | 恰是你探针的包络（第 6 次成功 / 190ms）。持有者是 AV/索引器的扫描窗口，不是竞争写者——指数退避无对象；无抖动需求（tmp 名带 pid，跨进程不冲突） |
| 失败后重写 tmp？ | **不重写**。rename 失败不消灭 tmp，逐次重试同一 tmp 即可。**唯一例外：`ENOENT`**（tmp 被 AV 隔离/清走）→ 重写 `writeFileSync(tmp)` 再继续循环 | 重写整个 text 每次尝试是纯浪费；ENOENT 特判 ~3 行覆盖「tmp 消失」这一真实分支 |
| 重试范围 | **只包 `renameSync`**。`mkdirSync` 与首写留在循环外 | T5 契约（`badHome` → 快速 `false` + warn，`session-state.test.mjs:382-391`）依赖 mkdir ENOTDIR **立即**失败——重试它只会拖慢测试且无收益 |
| 耗尽后 | 保持现状：best-effort `unlinkSync(tmp)` → **重抛最后一个错误原对象**（保 `.code`），但**追加 message**（如 `e.message += " (rename retried 8x/210ms)"`） | 不 wrap 新 Error 才不丢 `.code`；追加 message 让 store 现有 warn 行自描述——未来的 R-13 在日志里一眼可辨「是重试耗尽、不是没重试」 |

**建议形态**（放 `dsh-home.mjs`，抽 `renameSyncWithRetry(from, to)` 原语供 Q4 复用；常量 `RENAME_MAX_ATTEMPTS`/`RENAME_BACKOFF_MS` 导出——自文档 + 测试可断言包络）：

```js
mkdirSync(dir, { recursive: true })          // 循环外：配置性失败快速抛（T5 契约）
const tmpPath = "…" + process.pid + "-" + Date.now()
writeFileSync(tmpPath, text, "utf8")         // 循环外：唯一新路径无持有者可盲
let lastErr
for (let i = 1; i <= RENAME_MAX_ATTEMPTS; i++) {
  try { return renameSync(tmpPath, filePath) }   // 首试零延迟——常态路径零代价
  catch (e) {
    lastErr = e
    if (!["EPERM", "EACCES", "EBUSY", "ENOENT"].includes(e?.code) || i === RENAME_MAX_ATTEMPTS) break
    if (e?.code === "ENOENT") writeFileSync(tmpPath, text, "utf8")  // tmp 被清走 → 重铸再战
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_BACKOFF_MS) }
    catch { /* 该环境禁用主线程 wait：退化为立即重试，仍正确仅弱效 */ }
  }
}
try { unlinkSync(tmpPath) } catch { /* 沿现状 */ }
lastErr.message += " (rename retried " + RENAME_MAX_ATTEMPTS + "x/~" + (7*RENAME_BACKOFF_MS) + "ms)"
throw lastErr
```

## Q2 同步 sleep（Atomics.wait）——可接受，且是正确取舍

- **事件循环代价的真实形状**：只在竞争且失败时睡——首试成功（常态）**零 sleep**；最坏 ~210ms 且发生在语义转换写点（工具边界/交付/撤销），非热循环。三个 store 本就是全同步 fs 代码，调用方已在阻塞等 fs。
- **异步化的爆炸半径（实测计数）**：`saveSessionState` 等的**同步布尔返回**被 ~40+ 处测试断言直接消费（`assert.equal(saveSessionState(...), true)` 遍布 session-state/codex-runner/advisor-config/truncation 各档）；生产侧 8 个写点含 `index.mjs:1154` 的 `session/disposed` 同步事件钩——改异步它就成 fire-and-forget（未处理 rejection 新面）。50+ 调用点 × 四档 lib × 十五档测试换 30ms×8 的有界停顿，明确不值。
- **兜底**：`Atomics.wait` 外包 try/catch（禁用环境退化为立即重试）。本模块 `node:fs` 直依，浏览器主线程禁令不适用；Node 主线程允许（你已实测 v24 可用）。

## Q3 `catch → warn + return false` 是否同批改——改，但精确到三层，且**不推翻 N3**

1. **helper 层（做）**：耗尽错误追加 message（上文）→ 三个 store 现有 warn 行变成自描述，零调用方改动。
2. **测试层（做，这是杀死 R-13 静默的最小一刀）**：T6 的 `saveSessionState("fresh", …)`（`:428`）及其上方 `:411` 的返回值加 `assert.equal(..., true)`。未来任何耗尽都直接红在 save 调用上（"returned false"），而不是内容 diff 谜语。批 9 的「严禁为消 flake 改基线档」在本批**失效**——批 20 明确收编 R-13，属授权编辑（走 `AP_TEST_AUTHORIZED` + 台账理由列登记）。
3. **生产层（只改一处）**：**`index.mjs:713` 的 `clearUserConfig(...)` 返回值被丢、端点无条件 `send({ ok: true })`**——用户在设置页重置配置，若 rename 失败，UI 报成功而 user 层原样保留，这是**面向用户的谎**，须对齐 PUT 路径先例（`:698-699` collect + 500）。其余 7 个 `saveSessionState` 写点（`advisor.mjs:1664` · `eng.mjs:130` · `escalate.mjs:186/:501` · `index.mjs:910/:1015/:1261`）**维持 N3**——内存态是第一事实源、盘是镜像（三档头注释明文契约；`DSH_HOME` 不可解析时不得砖化评审流），store 内 warn 已带全上下文，调用侧再 warn 只加写点名，不值扩写域。

## Q4 `clearUserConfig` 的独立 rename——**并入，但走共享原语而非塞进 writeFileAtomic**

它的形状是「把活文件 rename 走」（`config-store.mjs:224-227`），与 writeFileAtomic 的「tmp → 目标」不同向——塞进去是削足适履。正确做法：抽 **`renameSyncWithRetry(from, to)`**（Q1 的循环即其本体），writeFileAtomic 与 clearUserConfig 各自调用，重试策略/常量单一事实源。顺手修一个**同处 TOCTOU**：`existsSync`（`:222`）与 rename 之间文件被别进程删走 → rename `ENOENT` → 现在落进通用 catch 报「failed to clear」+false——语义上「已清空」应判**成功**（幂等 clear），一行判 `e.code === "ENOENT" → return true`。

## Q5 你问的 + 你没问的失败面（逐条带处置）

| # | 失败面 | 判定 | 处置 |
|---|---|---|---|
| 1 | 并发写同档（多进程 read-modify-write 丢更新） | **重试治不了**——逻辑竞态非 fs 竞态；desktop+web 双进程共享 DSH_HOME 时 `session-state.json` 是同档（`dsh-home.mjs:14/:35` 两进程实证） | **已登记面**（`session-store.mjs:145` LWW 风险），维持登记不修——锁文件协议对 7d-TTL 内存镜像不成比例 |
| 2 | tmp 名碰撞 | **非问题，可证**：进程内 `writeFileAtomic` 全同步单调用栈不可能自交错；跨进程 pid 不同；同 pid+同 ms 需 pid 复用×时钟巧合撞存活孤儿 | 在 helper 注释里写死这段论证，闭环此问 |
| 3 | 崩溃残留孤儿 tmp | 无害于正确性（点文件，读方只开正名）；耗尽路径已清；**硬崩**（SIGKILL/断电）绕过 → 慢累积 | 建议同批实现极廉清扫：store 写时顺手 unlink 同前缀 `.tmp-`/`.del-` 且 mtime > 1h 的（1h >> 250ms 重试窗 ⇒ 他进程在飞 tmp 安全），配 2 个测试用例（旧者被扫/新者幸存）；不愿扩域则登记 🔵 |
| 4 | 无 fsync（断电可能持久 rename 不持久数据） | 镜像语义 + TTL 兜底 | 登记 accepted，不修 |
| 5 | 永久 EPERM（目录 ACL/管控） | 每次保存烧 250ms 后诚实失败 | 接受；不做失败态缓存（复杂度） |
| 6 | `clearUserConfig` TOCTOU | 见 Q4 | 同批修 |
| 7 | AV 隔离 tmp（ENOENT） | 见 Q1 | 已入循环 |

## Q6 「重试治不了」的诚实边界（两条）

1. **持续持有者**（>250ms 的长扫描/备份软件/他进程长读）重试必耗尽——所以 Q3 的可见性腿**不是可选项**。两条腿都在，R-13 才算根治。
2. **机制残差**：T6 原始失败无 warn 行留档，无法 100% 钉死是 rename-EPERM 还是首写失败（如 ENOSPC）。本设计完全覆盖前者；后者在「唯一新路径」上无合理触发者（AV 无法持有尚不存在的唯一名文件），且首写失败今天/修后都诚实抛。**此一条按不可验登记**（对齐会诊纪要 §5 纪律），不臆称排除。

## 同批机械涟漪（仓纪律要求同改，漏一个就红门）

- **`test/release-check.test.mjs:27/:148-151`**：直读**活台账**并断言「R-13 必须在 flake 表首行」——R-13 移出 §五 的那一刻此断言必红，**必须同批改**（` :353-364` 已有本地两行 fixture 先例可搬给 G6 谓词测试用）。
- **`docs/test-lifecycle.md`**：§三 `session-state.test.mjs` 行（`:102` 的「本批明令不修」是时点语，须按状态行纪律更新）· §五 移除/标注 · §七 变更行——**四方一致闸**（`test-lifecycle.test.mjs`）盯着的。
- **`release-check.mjs:270`** 的 "R-13 flake 复跑转绿” 措辞 → 改泛化（“已知 flake"），防状态漂移。
- 新测试若开新档（如 `test/atomic-write.test.mjs`）：台账 §三 新行 + T-E19 清单 + CHANGELOG 计数 + 版本 bump 全链；只改 T6 断言行则用例数 20 不变。
- 耗尽路径的确定性测试法：dest 处放**同名目录**→ Windows 上 rename 报可重试码、真烧满 ~210ms 后抛（POSIX 上是 EISDIR 立即抛）——断言按平台感知写，或只断言「抛 + store 返回 false + warn 含 retried」。

**一句话**：算法照 Q1（8×30ms、EPERM/EACCES/EBUSY、ENOENT 特判重铸 tmp、耗尽追加 message 重抛），原语抽 `renameSyncWithRetry` 给 clearUserConfig 复用（含 ENOENT→幂等成功），可见性做 helper+T6+`index.mjs:713` 三点，孤儿清扫可选做，LWW/fsync 登记不修——重试治瞬态、可见性治持续，缺一腿都别自称根治 R-13。

[3] deepseek-official:deepseek-v4-pro — ok
调研完毕（读了 `dsh-home.mjs` 全文、三个 store、T6 测试、`release-check` 门代码与测试、台账 §五、会诊 #17 纪要）。以下是会诊意见——先给裁定，再逐问答，最后补两个我实测到的**你没列进清单的失败面**（其中一个会让「R-13 移出 flake 表」这一步直接打红发布门测试）。

---

## 裁定摘要（先行）

**重试治得动这个 flake 的主导因果类，但只能以「机制假设 + 自证观测」的姿态治，不能以「已确诊 EPERM」的姿态治。** 判据链（我逐字核过）：

```dsh-ui
{"title":"R-13 因果链的证据地位","gap":12,"items":[{"type":"callout","tone":"info","title":"可以证死的一半","content":"`actual ['keep','malformed','stale1','stale2']` 恰是 `saveSessionState(\"fresh\")` 落地前的文件内容。T6 里 `writeFileAtomic` 成功的一切路径（清扫成功/读失败按空表/任何语义）都必然产出 `['fresh','keep']`（fresh 必写、keep 未过期必留）⇒ **`writeFileAtomic` 在某一步抛了，这是逻辑必然，与时间无关**——「时序 flake」是误诊，这一点你对。"},{"type":"callout","tone":"warning","title":"证不死的一半","content":"抛在哪一步、什么 errno，**没有任何现场记录**——台账里只有断言 diff，`catch` 里的 warn 文本没人留。EPERM/-4048 是你在本机探针里**证明存在**的机制，但「R-13 那次就是它」是**最佳假设，不是事实**。所以修法必须自带观测面：复发时 warn 必须能判真伪。"}]}
```

由此，**同步重试 + 失败可见**是正确方向，**不假成功**、不改三个 store 的签名、不碰 T6 基线档。但有三件事必须同批做，否则 flake 只是从「表里」挪到「盲区」：① 重试环要包住 **tmp 写 + rename 两步**（不只 rename）；② warn 带 `code`/`errno`/重试次数；③ **台账 §五清空会打红 `test/release-check.test.mjs` 三处断言**（见 Q5-⑦，这是我实测到的最大漏面）。

---

## Q1：重试策略怎么定

**可重试 errno（按 `e.code` 字符串判，不要按 `e.errno` 数字判）**——Windows 的 errno 是负数（EPERM=-4048、EBUSY=-4082、EACCES=-4092、ENOENT=-4058），POSIX 是正数，只有 `code` 跨平台稳定：

| 处置 | errno（`code`） | 理由 |
|---|---|---|
| **重试** | `EPERM` `EBUSY` `EACCES` `EAGAIN` `ENOENT` | 前三 = Windows 共享违例家族（句柄被 AV/索引器/他进程持有）+ POSIX 瞬态锁（含 NFS 的 `EAGAIN`）；`ENOENT` 只在「tmp 刚被自己写完就消失」时出现（AV 隔离/删除 tmp、他进程清扫竞态）——**因为每次尝试都重写 tmp，ENOENT 必然自愈**，重试无风险 |
| **不重试（1 次即抛）** | `ENOTDIR` `EISDIR` `ENOSPC` `EDQUOT` `EXDEV` `EINVAL` `ENAMETOOLONG` `EROFS` | 确定性/结构性问题，重试纯浪费时间；F12-T5 的 `ENOTDIR` 快失败路径要保持（`mkdirSync` 放循环**外**） |

**次数与退避**：8 次，退避 `[20,30,40,60,90,130,180,240]ms`，**总预算 ≈ 790ms**。理由：首试零延迟（健康路径零代价，rename 一次成功不加一毫秒）；AV 对 2-3KB JSON 的 scan-on-close 持锁通常 <50ms（前 2-3 次内恢复）；你探针里的 150-180ms 持锁在第 6 次命中；爬升式比你的平铺 8×30=240ms 多花 ~550ms 预算买到「长尾持锁」覆盖。**不加 jitter**（跨进程雷群在这里可忽略，确定性退避可测可断言）。预算不再加大——持锁 >800ms 的场景（挂死的他进程）属于「本来就该失败」的域：三个 store 的设计哲学就是**失败可容忍**（内存态兜底），重试只该压「常见瞬态」，不该赌「永不失手」。

**失败后必须重写 tmp**：是，且**每次尝试生成新 tmp 名**（加尝试序号）。三个理由：① 现在 `writeFileSync(tmpPath)` 在 `try` **外面**（`dsh-home.mjs:69`）——tmp 写失败不但不重试，还**跳过清理**留半个 tmp；② AV 把 tmp 隔离/删除后 rename 会 ENOENT，重写才自愈；③ 每次新名字把「同 ms + pid 复用」的残留碰撞类结构性归零。

**骨架**（`mkdir` 留环外保 F12-T5 快失败；写+rename 进环；每次失败 unlink；耗尽抛**最后一次**错误）：

```js
export function writeFileAtomic(filePath, text, opts) {
  const { maxAttempts = 8, delays = [20,30,40,60,90,130,180,240] } = opts ?? {}
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true }) // 确定性失败（ENOTDIR 等）在环外快失败
  const base = basename(filePath)
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tmpPath = join(dir, "." + base + ".tmp-" + process.pid + "-" + Date.now() + "-" + attempt)
    try {
      writeFileSync(tmpPath, text, "utf8")
      renameSync(tmpPath, filePath)
      return // 成功：顺带 best-effort 清扫陈旧 tmp（见 Q5-③）
    } catch (e) {
      lastErr = e
      try { unlinkSync(tmpPath) } catch { /* 清理失败不阻塞，陈旧清扫兜底 */ }
      if (!isRetryableFsError(e) || attempt >= maxAttempts) throw e
      sleepSync(delays[Math.min(attempt - 1, delays.length - 1)])
    }
  }
  throw lastErr
}
```

`opts` 第三参向后兼容（stores 现调用两参不变），且是**测试注入缝**（测循环时传 `{delays:[1,1,1]}`，测试秒级跑完）——沿用本仓 `storPathOverride` 注入缝惯例。

## Q2：同步 sleep（Atomics.wait）可接受吗

**接受，且有界——不要异步化。** 账要算对：

- **异步化的爆炸半径**：42 处调用点横穿 advisor 签发链（`advisor.mjs:2108` 签发后立刻要 `persisted` 布尔喂 `recordDesignSettlement`）、eng 交付、escalate 后台、config PUT/apply-session 处理——改成 Promise 要穿透 token 签发与结算簿记的同步链，**且所有既有测试对同步布尔返回的断言全要重写**（T6、F10、F12-T5、config 全套）。收益仅仅是「省掉极端情况下的 ~790ms 阻塞」，成本是整插件的签名地震。
- **阻塞的真实代价**：只在**确有争用**时发生；写的是 2-3KB 文件；单次上限 790ms 与一次 LLM round-trip 同量级；无争用时零附加延迟。fail-safe 契约（失败回落内存态）意味着这不是关键路径的生死点。
- **实测已背书**：`Atomics.wait` 在 Node 主线程合法（浏览器的「主线程禁用」不适用于 Node），你本机 v24 已验；建议包一层 try/catch 落回 `Date.now()` 忙等（2 行保险，防未来运行时变脸）。
- **要登记而非修的两个边界**：① 多个会话同时 save 且遇同一把锁时，单线程下阻塞**串行叠加**（N×预算）——实际 save 是每事件一次、争用罕见，登记即可；② 见 Q5-⑥，重试**加宽**了读-改-写窗口，是既存 lost-update 风险的放大器，登记不锁。

## Q3：catch → warn + return false 该同批改吗

**先订正你简报里的一处口径**（我逐调用点核过）：

```dsh-ui
{"title":"返回值是否被查——按调用点实测","gap":12,"items":[{"type":"table","columns":["store 函数","调用点","返回值被查吗","证据"],"rows":[["saveUserConfig","index.mjs:698-699","✅ 查（且透给 UI）","`if (!saved) return send({ok:false,error:...}, 500)`——设置页用户**看得到**失败"],["saveTokenRecord","advisor.mjs:2108-2124 · eng.mjs:715","✅ 查","advisor 侧接住后喂 `recordDesignSettlement(..., \"token_persist_failed\")`（批 4 P3 专修过「返回值必须接住」）"],["saveSessionState","advisor.mjs:1664 · eng.mjs:130 · escalate.mjs:186/501 · index.mjs:910/1015/1261","❌ 全丢","fire-and-forget——**R-13 的洞就在这里**"],["remove*","index.mjs:1154 等","❌ 丢","清理路径，无碍本批"]]}]}
```

结论：**契约不改（throw 会把「镜像失败」升级成「工具流崩溃」，违背 N2/N3 的 fail-safe 本意）；可见性改两处——**

1. **消息自诊断化**：warn 里带 `e.code`/`e.errno` + 重试次数（「`writeFileAtomic failed after 8 attempts (EPERM) on <path>`」）。这是**判真伪的开关**：复发一次，下一条台账行就能证实或证伪「EPERM 假设」。纯消息改动，零契约变化。
2. **台账纪律（免费，无代码）**：flake 表行格式要求**必须记录 warn 原文**。R-13 当初就是没留 warn 文本，才让因果只能靠文件内容反推。

**不**建议本批把 session-state 调用点改成「接住布尔」——advisor 的 token 路径接住是为了喂结算簿记（token 关功能门），session-state 是**设计上可丢的尽力而为镜像**，6 个调用点改一遍的收益配不上 churn；真想要机械可见，未来可仿 `recordDesignSettlement` 挂计数，**本批推迟**。

## Q4：`clearUserConfig` 的独立 rename 该并入吗

**该。** 它的 `renameSync(filePath, delPath)`（`config-store.mjs:226`）争用对象是**源文件**（活 config.json 被 AV 持锁），与 `writeFileAtomic` 内 rename 的 EPERM 类**同族同源**。做法：在 `dsh-home.mjs` 抽一个 `renameSyncRetry(fromPath, toPath, opts)`（或让 `writeFileAtomic` 内部循环与它共享同一 retry 原语），`clearUserConfig` 调它后再 best-effort `rmSync`。顺带把「rename 成功但 rm 失败 → 残留 `.del-*`」也交给 Q5-③ 的陈旧清扫兜住。**注意**：它的重试预算会短暂延长「user 层已移走但未删完」窗口——语义上仍等价于旧行为（旧行为 = 失败直接残留 config.json），无回归。

## Q5：你漏掉的失败面（我实测补的）

| # | 面 | 现状 | 处置 |
|---|---|---|---|
| ① | **tmp 写失败无清理** | `writeFileSync(tmpPath)` 在 try 外（`dsh-home.mjs:69`），写失败既抛又留半个 tmp | Q1 骨架天然修复（环内 try + 每次 unlink） |
| ② | **AV 隔离/删除 tmp** | rename 时 tmp 已消失 → ENOENT，现按失败抛 | `ENOENT` 入可重试集 + 每次重写 |
| ③ | **崩溃残留（tmp 与 .del）** | 硬崩在写与 rename 之间 → `.tmp-*` 永存；clearUserConfig 崩在 rename 与 rm 之间 → `.del-*` 永存。现只有「失败时 best-effort」清理，无兜底 | 成功路径顺带 best-effort 清扫：`readdirSync(dir)` 里匹配 `.<base>.tmp-*` / `.config.json.del-*` 且 mtime > 1h 的，逐个 try/catch unlink。**误伤面为零**——活写者的 tmp 永远是秒级新鲜，1h 阈值必放过；跨进程 pid 不同名不撞。~8 行，把「OS 最终回收」变成有界 |
| ④ | **tmp 名碰撞** | 现 `pid+Date.now()`：进程内同步不可交错 ⇒ 理论无碰撞；唯一理论面是崩溃后 pid 复用 + 同 ms | 每尝试加序号后缀（Q1 骨架已含）⇒ 结构性归零，成本一行 |
| ⑤ | **目录级锁** | 句柄挂在 `.thincoker` 目录本身时 MoveFileEx 同抛 EPERM | 同 gate 覆盖，零额外代码 |
| ⑥ | **重试加宽 lost-update 窗口** | 读-改-写与 rename 之间隔开 ~790ms，另一进程（桌面 + web 双实例共享 DSH_HOME）的写入会被旧视图回踩 | **登记不锁**——token 已登记 D-30、session 已登记 G-5（`session-store.mjs:145`），本批在文档里把「窗口被重试加宽」这条补进既有登记即可 |
| ⑦ | **★ 发布门机械依赖（最容易被漏，实测必红）** | `test/release-check.test.mjs:149`（flake 表「必须**非空**」）、`:150-151`（「R-13 必须在表」）、`:153`（用**真台账**当 fixture 验证 G6 命中路径）；`release-check.mjs:270` 硬编码「（R-13 flake 复跑转绿…）」；`docs/README.md:19` 写「§五（R-13 首行）」 | **R-13 一移出 §五，这三条断言 + 命中 fixture 当场红**。同批必须决策：空表是否合法（我建议：允许空表，「可解析」保留、「非空」断言改掉；G6 机制用合成 fixture 测，不再依赖真台账恰好有 R-13）；`release-check.mjs:270` 的文案去 R-13 泛化；README 措辞同步。**这是本批「并入 R-13」动作的真实代价面，与 lib/ 修复同提交落地** |

## Q6：重试治得了吗——直说

**治得动主导类，治不「死」。** 我的判断：**做，但按「概率大幅压小 + 复发可判真伪」验收，不按「根治」验收。**

- **治得动**：签名已逻辑证死是 `writeFileAtomic` 抛（不是时序），而可重试 gate ∪ tmp 重写 ∪ ENOENT 自愈 恰好覆盖「writeFileAtomic 抛」的全部瞬态子类（目标锁 / tmp 锁 / tmp 被隔离）。你的探针已证第 6 次 190ms 恢复、锁持续时不假成功。
- **治不动**：持锁 >790ms 的类、以及「假设错了」（原发不是 EPERM 而是别的瞬态但恰好也在 gate 里——那也被覆盖了；真错了且不在 gate 里的，warn 会带着 code 回来）。**正因为原发 errno 从未被捕获，正确姿态是**：修复 + 观测面 + 台账纪律，让「若复发，下一次必确诊」。台账里 R-13 的处置行我建议如实写「**按机制假设根修**（EPERM 探针实证存在，原发 errno 未捕获不可证）」而不是「已确诊 EPERM」——诚实边界对齐你们 R-18 的既有口径。

**回归测试建议**（新档 `test/write-atomic.test.mjs`，**不碰 T6 基线档**——T6 原样继续当见证者，它的持续全绿就是证据）：
1. 注入 `{delays:[1,1,1]}` + mock rename 前 k 次 EPERM → 断言内容落地、零 tmp 残留、返回成功；
2. 持续 EPERM → 抛、消息含 `code`+`after N attempts`、零残留；
3. 非可重试（ENOTDIR/ENOSPC）→ 单次快失败（断言无环内 sleep）；
4. **Windows 门控集成锁（R-13 机制锁本体）**：子进程用 `FileShare.None` 持住目标文件（PowerShell `[IO.File]::Open($p,'Open','Read','None')`，握手用标记文件），父侧调 `s
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[4] kimi-api:kimi-k3 — ok
摸底档、三 store、T6、flake 表机制、G6 判据源已全部逐字读过（`lib/dsh-home.mjs:65-77`、`config-store.mjs:197-233`、`session-store.mjs:162-235`、`token-store.mjs:62-178`、`test/session-state.test.mjs:408-435`、`docs/test-lifecycle.md:102-131`、`release-check.mjs:126-231`、`test/release-check.test.mjs:148-156`）。以下按五问逐条作答，全部锚到实测行号。

---

## 裁定速览

| 问 | 裁定 | 一句话依据 |
|---|---|---|
| 重试策略 | **白名单 `EPERM/EACCES/EBUSY` · 8 次 · 固定 30ms · 不重写 tmp（ENOENT 例外）** | 与探针 #3 参数对齐（第 6 次成功 190ms），不发明未实测的退避曲线 |
| 同步 sleep | **可接受** | 失败路径 ≤~0.4s、仅在 turn 边界；改异步爆炸半径 = 7 处调用点 + 时序语义 |
| catch→warn | **契约不动，加遥测** | N2/N3 是三 store 头注的既定决策；缺的是「可 grep 的失败签名」不是返回值 |
| `clearUserConfig` | **并入** | 同 errno 族；抽 `renameWithRetry` 单一事实源，两消费者 |
| 重试治不了？ | **治得了，证据在探针 #3/#4** | 唯一诚实缺口：R-13 当时的 warn 原文没人捕获（见 §6） |

---

## §1 重试策略（Q1）

**推荐形态：只包 rename，参数与探针对齐。**

| 决策点 | 建议 | 依据 |
|---|---|---|
| 可重试 errno | `EPERM` · `EACCES` · `EBUSY`——**按 `e.code` 字符串匹配**（errno 数值 `-4048/-4092/-4082` 只进注释） | 探针 #1 实证 `EPERM/-4048`；后两者同族（AV/索引器/编辑器 transient hold）。`ENOENT/ENOTDIR/EISDIR` 确定性失败，**不重试** |
| 次数 | **8 次总尝试**（1 + 7 重试） | 探针 #3 用 MAX 8 第 6 次成功——8 给足余量且最坏代价有界 |
| 退避 | **固定 30ms**（7 次 sleep ≤ 210ms）+ 可选 0-10ms jitter；**总耗时硬顶 1000ms** 防御性兜底 | 探针就是固定 30ms 测的；递进/指数曲线没有实测支撑，不发明。jitter 防的是双进程 lockstep，非必需但零成本 |
| 失败后重写 tmp？ | **否**——rename 失败时 tmp 内容完好（rename 原子性：失败则源不动），重写只会再触发一次 AV 扫描。**唯一例外**：重试中 rename 抛 `ENOENT` 且 tmp 已不存在（外部清理器扫走了 tmp）⇒ 在同一预算内重写一次再继续 | 覆盖「tmp 被第三方清掉」这个真实但冷门的面，不新增机制 |
| mkdir / writeFile 失败 | **维持即抛**（现状） | ENOTDIR 确定性；ENOSPC 重试无义。登记为已接受残差 |

**落点**：retry 住在 `lib/dsh-home.mjs` 内部（抽 `renameWithRetry(src, dst)` 导出），5 处 `writeFileAtomic` 调用点**零 diff** 自动继承——单一事实源，最小爆炸半径。常量（次数/步长/顶值）export 供测试断言上界，避免测试里复制魔法数。

**先例**（知识性佐证，非本仓实测）：npm `write-file-atomic` / `proper-lockfile` 在 Windows 对 `EPERM/EACCES/EBUSY` 做同款重试——这不是异端设计，是 Windows 上原子写的行业标准解法。

## §2 同步 sleep 可接受吗（Q2）——可接受，且是**唯一**保同步 API 的形态

**成本量化**：成功路径零代价（第一次 rename 即中，不进循环）；失败路径 ≈ 210ms sleep + 8 次 syscall ≈ **≤0.4s**，发生点全部是 turn 边界（advisor 完成 / eng 翻转 / 交付 / 设置页 PUT）——相对多分钟级的模型调用不可感知。

**改异步的爆炸半径（实测，非推理）**：`saveSessionState` 有 **7 处**直接调用（`advisor.mjs:1664` · `eng.mjs:130` · `escalate.mjs:186/:501` · `index.mjs:910/:1015/:1261`），全部要加 await；且异步化引入新的时序语义——同 tick 内 `removeSessionState` → `saveSessionState` 这类**顺序写**会变成 fire-and-forget 竞态，要正确就得加串行队列 = 新 bug 农场。爆炸半径 ≫ 收益。

**健壮性兜底（一条便宜保险）**：模块加载时 feature-detect 一次 `Atomics.wait`（0ms try/catch）；不可用的 embedding 回落 **Date.now() 自旋等 deadline**（同样 30ms 有界，烧 CPU 但只在失败路径）——保疗效不保优雅。

**登记为已否决**：① store 全面异步化（上述半径）；② worker 线程 offload（三行 fs 调用配结构化克隆 + 生命周期，过度工程）。

## §3 catch → warn + return false 要不要同批改（Q3）——**契约不动，遥测进错误消息**

**不要改 throw**：「写失败不崩评审流程」是 N2/N3 写进三个 store 头注的**既定决策**（`token-store.mjs:10` · `session-store.mjs:16` · `config-store.mjs:16`），改契约 = 语义变更，需要独立批次 + 用户裁定，撞本仓纪律。

**真正的缺口不是返回值，是可诊断性**。R-13 事故里 **warn 原文就在全量跑的 stderr 里，没人看见**——事后无法从日志反查。同批做这两点零契约变更的加固：

1. **helper 层**：重试耗尽后抛出的错误消息带全遥测——`code`/`errno`/**已试次数**/**总耗时**/tmp 路径。三个 store 的既有 warn 都拼 `e?.message`（如 `session-store.mjs:185`）⇒ **遥测零改动自动流进 warn 行**。
2. **warn 加稳定可 grep 签名**（如 `[persist-fail]`），让 CI/宿主日志扫描下次能机械捕获，而不是再靠人眼翻 stderr。

**7 处不查返回值的 session 面调用点**：逐个改成「失败冒泡到 UI/工具输出」= 横跨 advisor/eng/escalate/index 四档的面，**登记为残差 R-xx 另立批次**，不进本批。理由与摸底档 §4 一致：flake 由「写落地」治愈，可见性是防御下一起事故的纵深，不是治 R-13 的必要条件。

## §4 `clearUserConfig:226` 并入吗（Q4）——**并入**

同族暴露：它 rename 的方向相反（target → `.del-*`），但失败模式相同——**target 被 AV 持有 ⇒ `EPERM`**。形态：`config-store.mjs:226` 改用同一个 `renameWithRetry`，重试政策单一事实源不裂。

两个顺手的微加固（可选，各自一行）：① `existsSync` → rename 之间有 TOCTOU，rename 抛 `ENOENT` 可按「已清空」返 true（现状是 warn + false，语义略冤）；② 崩溃残留 `.del-*` 孤儿并入 §5-c 的清扫面。

## §5 漏掉的失败面（Q5）——按风险排序，**a 是批次级地雷**

**a. ★ 移出 R-13 的机械级联（你问的「并入」动作本身，比 writeFileAtomic 改动更危险）**——`R-13` 全仓 **47 处 / 17 档**（实测 grep）。**两个会直接炸红套件**：

- `test/release-check.test.mjs:149-151` 断言**活台账** flake 表「必须可解析且**非空**」且「R-13 必须登记在首行」——删行即红，**必须同批改**；`:122-124` 的 TAP fixture 与 `:153` 的 `isKnownFlake` 正例都拿 `session-state.test.mjs :: T6` 当样品，表空后需重造。
- `release-check.mjs:270` 硬编码字符串 `"（R-13 flake 复跑转绿…）"`——状态行同步（文档卫生 #4）。

其余分类：**活状态必须同改** = `docs/test-lifecycle.md` §五删行 + `:102` 指针（「已知 flake R-13 指本档 T6…本批明令不修」整句失效）+ §七历史行登记已根治（带 sha/判据/疗效证据）；`docs/README.md:19`（「R-13 首行」描述台账现况）；NIGHT-SHIFT-PLAN/REPORT 状态行。**历史叙事不翻案** = CHANGELOG、METHODOLOGY:148、四份 2026-09-13 档、`guard-e.test.mjs:744` 注释、会诊纪要。注意 **G6 闸门语义翻转**：表空后 G2 红 ⇒ 门红、再无复跑豁免——这是期望终态，`gateG6` 对空表谓词正确（`release-check.mjs:227`），但设计档要写明这是**有意收紧**。

**b. 并发写同档（多进程）**：read-modify-write 的 lost-update **重试不治**——last-writer-wins 已在 D-30 登记。设计档**必须重述这句**，防本批超卖「并发已治」。重试治的只是「另一进程的读句柄挡住 rename」这一半。

**c. 崩溃残留累积**：crash 在 writeFile(tmp)→rename 之间 ⇒ `.tmp-*` 孤儿；`:226` 成功后 crash ⇒ `.del-*` 孤儿。现状只有 rename 失败路径的 best-effort 清理（`dsh-home.mjs:74`），崩溃路径无人扫。建议：writeFileAtomic 内 best-effort 清扫**同目录、同 basename 前缀、龄 ≥10min** 的孤儿（try/catch 吞掉；龄阈值防误杀在飞 tmp——在飞 tmp 秒级，阈值 10min 足够分离）。范围紧就登记残差，但它与 §2.4 「写时清扫防崩溃孤儿」的既有哲学同构，成本极低。

**d. tmp 名碰撞——实测证伪，无需改**：pid 区分跨进程；进程内 store 全同步顺序执行 ⇒ 同 ms 两次写也是先 rename 完再算下一个名，不撞；唯一病态（死进程 pid 复用 + 同 ms）的 overwrite 语义无害。**设计档写一行推理即可**，防评审再问。

**e. 重试中 tmp 消失**：见 §1「ENOENT 例外」。

**f. 新测试的登记级联**：`dsh-home` 无专属测试档，回归测试需要**持句柄夹具**——Node 的 `fs.open` 在 Windows 默认带 share-delete，**同进程锁不住 rename**（这正是探针要用另一进程的原因）；仓内复刻 = spawn PowerShell/.NET `FileShare.None`，Windows-only + 子进程 ~1-2s 成本。新建 `test/dsh-home.test.mjs` 触发 **T-E19 登记闸 + 台账 §三处置行 + 用例计数 + ledger-parity/test-lifecycle 双 parity** 全套仪式（批 9/10/14 建的那套），**这是本批最重的机械成本，预算里要先算进去**。

**g. JSDoc/头注同步**：`dsh-home.mjs:60-61` 现写「任何失败向上抛」⇒ 改「白名单 errno 有界重试，耗尽向上抛」；三个 store 头注引用 writeFileAtomic 行为处（`session-store.mjs:18` · `token-store.mjs:23-24` · `config-store.mjs:29-30,189-191`）同批过一遍（描述面与实现一致，纪律 #5）。

## §6 「重试根本治不了」成立吗（Q6）——**不成立，但诚实边界要写明**

**支持治得了的证据**：① 因果链唯一——`actual` 无 `fresh` 有 `malformed/stale`，而清扫与写在同一函数内，任何「写成功了」的路径都不可能产生该 actual（清扫坏 ⇒ 会有 fresh；readStore 空 ⇒ 只剩 fresh；路径错 ⇒ resolve 确定性）⇒ 唯一解 = **写没落地**；② 同 helper 的 R-51 实测过 `EPERM`；③ 探针 #3 直接证明「锁中途释放 ⇒ 第 6 次成功 190ms」——**这就是 flake 的微观重演与治愈**；④ 探针 #4 证明不假成功。

**诚实边界（设计档应照写）**：R-13 当次的 `EPERM` **没有直接观测**（warn 在 stderr 里没被捕获）——诊断是「失败原文因果 + R-51 同 helper EPERM + 探针复现」三段归纳，置信度高但非直接证据。重试治愈的是「≤1s 的 transient hold」；若真实持有者是同步盘/企业备份（秒-分钟级），预算内治不了——但此时 N3 内存兜底仍在、§3 的遥测 warn 让它**第一次可见**，降级优雅。

**建议的疗效举证门槛**（对齐 R-13 当年的测量口径）：全量 `node --test` ×10 + `session-state`/`codex-runner`（AC-17 在后者）单档 ×20 全绿，连同探针复现脚本一并入设计档 §疗效节；达标才准在台账 §七 写「已根治」。

---

**给需求档的三条浓缩输入**：① US 治因 = rename 白名单有界重试（参数 §1）；② US 治果 = 失败遥测 + 可 grep 签名（§3），**不含**契约变更与 7 处调用点改造（登记残差）；③ US 级联 = R-13 移表的全部同改面（§5-a/f/g），并显式声明 G6 收紧是有意的。
```

### §1.1 未截断全文（**仅当有回复超 8000 字软顶时出现**；机制写）

#### [3] deepseek-official:deepseek-v4-pro（8595 字）

```text
调研完毕（读了 `dsh-home.mjs` 全文、三个 store、T6 测试、`release-check` 门代码与测试、台账 §五、会诊 #17 纪要）。以下是会诊意见——先给裁定，再逐问答，最后补两个我实测到的**你没列进清单的失败面**（其中一个会让「R-13 移出 flake 表」这一步直接打红发布门测试）。

---

## 裁定摘要（先行）

**重试治得动这个 flake 的主导因果类，但只能以「机制假设 + 自证观测」的姿态治，不能以「已确诊 EPERM」的姿态治。** 判据链（我逐字核过）：

```dsh-ui
{"title":"R-13 因果链的证据地位","gap":12,"items":[{"type":"callout","tone":"info","title":"可以证死的一半","content":"`actual ['keep','malformed','stale1','stale2']` 恰是 `saveSessionState(\"fresh\")` 落地前的文件内容。T6 里 `writeFileAtomic` 成功的一切路径（清扫成功/读失败按空表/任何语义）都必然产出 `['fresh','keep']`（fresh 必写、keep 未过期必留）⇒ **`writeFileAtomic` 在某一步抛了，这是逻辑必然，与时间无关**——「时序 flake」是误诊，这一点你对。"},{"type":"callout","tone":"warning","title":"证不死的一半","content":"抛在哪一步、什么 errno，**没有任何现场记录**——台账里只有断言 diff，`catch` 里的 warn 文本没人留。EPERM/-4048 是你在本机探针里**证明存在**的机制，但「R-13 那次就是它」是**最佳假设，不是事实**。所以修法必须自带观测面：复发时 warn 必须能判真伪。"}]}
```

由此，**同步重试 + 失败可见**是正确方向，**不假成功**、不改三个 store 的签名、不碰 T6 基线档。但有三件事必须同批做，否则 flake 只是从「表里」挪到「盲区」：① 重试环要包住 **tmp 写 + rename 两步**（不只 rename）；② warn 带 `code`/`errno`/重试次数；③ **台账 §五清空会打红 `test/release-check.test.mjs` 三处断言**（见 Q5-⑦，这是我实测到的最大漏面）。

---

## Q1：重试策略怎么定

**可重试 errno（按 `e.code` 字符串判，不要按 `e.errno` 数字判）**——Windows 的 errno 是负数（EPERM=-4048、EBUSY=-4082、EACCES=-4092、ENOENT=-4058），POSIX 是正数，只有 `code` 跨平台稳定：

| 处置 | errno（`code`） | 理由 |
|---|---|---|
| **重试** | `EPERM` `EBUSY` `EACCES` `EAGAIN` `ENOENT` | 前三 = Windows 共享违例家族（句柄被 AV/索引器/他进程持有）+ POSIX 瞬态锁（含 NFS 的 `EAGAIN`）；`ENOENT` 只在「tmp 刚被自己写完就消失」时出现（AV 隔离/删除 tmp、他进程清扫竞态）——**因为每次尝试都重写 tmp，ENOENT 必然自愈**，重试无风险 |
| **不重试（1 次即抛）** | `ENOTDIR` `EISDIR` `ENOSPC` `EDQUOT` `EXDEV` `EINVAL` `ENAMETOOLONG` `EROFS` | 确定性/结构性问题，重试纯浪费时间；F12-T5 的 `ENOTDIR` 快失败路径要保持（`mkdirSync` 放循环**外**） |

**次数与退避**：8 次，退避 `[20,30,40,60,90,130,180,240]ms`，**总预算 ≈ 790ms**。理由：首试零延迟（健康路径零代价，rename 一次成功不加一毫秒）；AV 对 2-3KB JSON 的 scan-on-close 持锁通常 <50ms（前 2-3 次内恢复）；你探针里的 150-180ms 持锁在第 6 次命中；爬升式比你的平铺 8×30=240ms 多花 ~550ms 预算买到「长尾持锁」覆盖。**不加 jitter**（跨进程雷群在这里可忽略，确定性退避可测可断言）。预算不再加大——持锁 >800ms 的场景（挂死的他进程）属于「本来就该失败」的域：三个 store 的设计哲学就是**失败可容忍**（内存态兜底），重试只该压「常见瞬态」，不该赌「永不失手」。

**失败后必须重写 tmp**：是，且**每次尝试生成新 tmp 名**（加尝试序号）。三个理由：① 现在 `writeFileSync(tmpPath)` 在 `try` **外面**（`dsh-home.mjs:69`）——tmp 写失败不但不重试，还**跳过清理**留半个 tmp；② AV 把 tmp 隔离/删除后 rename 会 ENOENT，重写才自愈；③ 每次新名字把「同 ms + pid 复用」的残留碰撞类结构性归零。

**骨架**（`mkdir` 留环外保 F12-T5 快失败；写+rename 进环；每次失败 unlink；耗尽抛**最后一次**错误）：

```js
export function writeFileAtomic(filePath, text, opts) {
  const { maxAttempts = 8, delays = [20,30,40,60,90,130,180,240] } = opts ?? {}
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true }) // 确定性失败（ENOTDIR 等）在环外快失败
  const base = basename(filePath)
  let lastErr
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const tmpPath = join(dir, "." + base + ".tmp-" + process.pid + "-" + Date.now() + "-" + attempt)
    try {
      writeFileSync(tmpPath, text, "utf8")
      renameSync(tmpPath, filePath)
      return // 成功：顺带 best-effort 清扫陈旧 tmp（见 Q5-③）
    } catch (e) {
      lastErr = e
      try { unlinkSync(tmpPath) } catch { /* 清理失败不阻塞，陈旧清扫兜底 */ }
      if (!isRetryableFsError(e) || attempt >= maxAttempts) throw e
      sleepSync(delays[Math.min(attempt - 1, delays.length - 1)])
    }
  }
  throw lastErr
}
```

`opts` 第三参向后兼容（stores 现调用两参不变），且是**测试注入缝**（测循环时传 `{delays:[1,1,1]}`，测试秒级跑完）——沿用本仓 `storPathOverride` 注入缝惯例。

## Q2：同步 sleep（Atomics.wait）可接受吗

**接受，且有界——不要异步化。** 账要算对：

- **异步化的爆炸半径**：42 处调用点横穿 advisor 签发链（`advisor.mjs:2108` 签发后立刻要 `persisted` 布尔喂 `recordDesignSettlement`）、eng 交付、escalate 后台、config PUT/apply-session 处理——改成 Promise 要穿透 token 签发与结算簿记的同步链，**且所有既有测试对同步布尔返回的断言全要重写**（T6、F10、F12-T5、config 全套）。收益仅仅是「省掉极端情况下的 ~790ms 阻塞」，成本是整插件的签名地震。
- **阻塞的真实代价**：只在**确有争用**时发生；写的是 2-3KB 文件；单次上限 790ms 与一次 LLM round-trip 同量级；无争用时零附加延迟。fail-safe 契约（失败回落内存态）意味着这不是关键路径的生死点。
- **实测已背书**：`Atomics.wait` 在 Node 主线程合法（浏览器的「主线程禁用」不适用于 Node），你本机 v24 已验；建议包一层 try/catch 落回 `Date.now()` 忙等（2 行保险，防未来运行时变脸）。
- **要登记而非修的两个边界**：① 多个会话同时 save 且遇同一把锁时，单线程下阻塞**串行叠加**（N×预算）——实际 save 是每事件一次、争用罕见，登记即可；② 见 Q5-⑥，重试**加宽**了读-改-写窗口，是既存 lost-update 风险的放大器，登记不锁。

## Q3：catch → warn + return false 该同批改吗

**先订正你简报里的一处口径**（我逐调用点核过）：

```dsh-ui
{"title":"返回值是否被查——按调用点实测","gap":12,"items":[{"type":"table","columns":["store 函数","调用点","返回值被查吗","证据"],"rows":[["saveUserConfig","index.mjs:698-699","✅ 查（且透给 UI）","`if (!saved) return send({ok:false,error:...}, 500)`——设置页用户**看得到**失败"],["saveTokenRecord","advisor.mjs:2108-2124 · eng.mjs:715","✅ 查","advisor 侧接住后喂 `recordDesignSettlement(..., \"token_persist_failed\")`（批 4 P3 专修过「返回值必须接住」）"],["saveSessionState","advisor.mjs:1664 · eng.mjs:130 · escalate.mjs:186/501 · index.mjs:910/1015/1261","❌ 全丢","fire-and-forget——**R-13 的洞就在这里**"],["remove*","index.mjs:1154 等","❌ 丢","清理路径，无碍本批"]]}]}
```

结论：**契约不改（throw 会把「镜像失败」升级成「工具流崩溃」，违背 N2/N3 的 fail-safe 本意）；可见性改两处——**

1. **消息自诊断化**：warn 里带 `e.code`/`e.errno` + 重试次数（「`writeFileAtomic failed after 8 attempts (EPERM) on <path>`」）。这是**判真伪的开关**：复发一次，下一条台账行就能证实或证伪「EPERM 假设」。纯消息改动，零契约变化。
2. **台账纪律（免费，无代码）**：flake 表行格式要求**必须记录 warn 原文**。R-13 当初就是没留 warn 文本，才让因果只能靠文件内容反推。

**不**建议本批把 session-state 调用点改成「接住布尔」——advisor 的 token 路径接住是为了喂结算簿记（token 关功能门），session-state 是**设计上可丢的尽力而为镜像**，6 个调用点改一遍的收益配不上 churn；真想要机械可见，未来可仿 `recordDesignSettlement` 挂计数，**本批推迟**。

## Q4：`clearUserConfig` 的独立 rename 该并入吗

**该。** 它的 `renameSync(filePath, delPath)`（`config-store.mjs:226`）争用对象是**源文件**（活 config.json 被 AV 持锁），与 `writeFileAtomic` 内 rename 的 EPERM 类**同族同源**。做法：在 `dsh-home.mjs` 抽一个 `renameSyncRetry(fromPath, toPath, opts)`（或让 `writeFileAtomic` 内部循环与它共享同一 retry 原语），`clearUserConfig` 调它后再 best-effort `rmSync`。顺带把「rename 成功但 rm 失败 → 残留 `.del-*`」也交给 Q5-③ 的陈旧清扫兜住。**注意**：它的重试预算会短暂延长「user 层已移走但未删完」窗口——语义上仍等价于旧行为（旧行为 = 失败直接残留 config.json），无回归。

## Q5：你漏掉的失败面（我实测补的）

| # | 面 | 现状 | 处置 |
|---|---|---|---|
| ① | **tmp 写失败无清理** | `writeFileSync(tmpPath)` 在 try 外（`dsh-home.mjs:69`），写失败既抛又留半个 tmp | Q1 骨架天然修复（环内 try + 每次 unlink） |
| ② | **AV 隔离/删除 tmp** | rename 时 tmp 已消失 → ENOENT，现按失败抛 | `ENOENT` 入可重试集 + 每次重写 |
| ③ | **崩溃残留（tmp 与 .del）** | 硬崩在写与 rename 之间 → `.tmp-*` 永存；clearUserConfig 崩在 rename 与 rm 之间 → `.del-*` 永存。现只有「失败时 best-effort」清理，无兜底 | 成功路径顺带 best-effort 清扫：`readdirSync(dir)` 里匹配 `.<base>.tmp-*` / `.config.json.del-*` 且 mtime > 1h 的，逐个 try/catch unlink。**误伤面为零**——活写者的 tmp 永远是秒级新鲜，1h 阈值必放过；跨进程 pid 不同名不撞。~8 行，把「OS 最终回收」变成有界 |
| ④ | **tmp 名碰撞** | 现 `pid+Date.now()`：进程内同步不可交错 ⇒ 理论无碰撞；唯一理论面是崩溃后 pid 复用 + 同 ms | 每尝试加序号后缀（Q1 骨架已含）⇒ 结构性归零，成本一行 |
| ⑤ | **目录级锁** | 句柄挂在 `.thincoker` 目录本身时 MoveFileEx 同抛 EPERM | 同 gate 覆盖，零额外代码 |
| ⑥ | **重试加宽 lost-update 窗口** | 读-改-写与 rename 之间隔开 ~790ms，另一进程（桌面 + web 双实例共享 DSH_HOME）的写入会被旧视图回踩 | **登记不锁**——token 已登记 D-30、session 已登记 G-5（`session-store.mjs:145`），本批在文档里把「窗口被重试加宽」这条补进既有登记即可 |
| ⑦ | **★ 发布门机械依赖（最容易被漏，实测必红）** | `test/release-check.test.mjs:149`（flake 表「必须**非空**」）、`:150-151`（「R-13 必须在表」）、`:153`（用**真台账**当 fixture 验证 G6 命中路径）；`release-check.mjs:270` 硬编码「（R-13 flake 复跑转绿…）」；`docs/README.md:19` 写「§五（R-13 首行）」 | **R-13 一移出 §五，这三条断言 + 命中 fixture 当场红**。同批必须决策：空表是否合法（我建议：允许空表，「可解析」保留、「非空」断言改掉；G6 机制用合成 fixture 测，不再依赖真台账恰好有 R-13）；`release-check.mjs:270` 的文案去 R-13 泛化；README 措辞同步。**这是本批「并入 R-13」动作的真实代价面，与 lib/ 修复同提交落地** |

## Q6：重试治得了吗——直说

**治得动主导类，治不「死」。** 我的判断：**做，但按「概率大幅压小 + 复发可判真伪」验收，不按「根治」验收。**

- **治得动**：签名已逻辑证死是 `writeFileAtomic` 抛（不是时序），而可重试 gate ∪ tmp 重写 ∪ ENOENT 自愈 恰好覆盖「writeFileAtomic 抛」的全部瞬态子类（目标锁 / tmp 锁 / tmp 被隔离）。你的探针已证第 6 次 190ms 恢复、锁持续时不假成功。
- **治不动**：持锁 >790ms 的类、以及「假设错了」（原发不是 EPERM 而是别的瞬态但恰好也在 gate 里——那也被覆盖了；真错了且不在 gate 里的，warn 会带着 code 回来）。**正因为原发 errno 从未被捕获，正确姿态是**：修复 + 观测面 + 台账纪律，让「若复发，下一次必确诊」。台账里 R-13 的处置行我建议如实写「**按机制假设根修**（EPERM 探针实证存在，原发 errno 未捕获不可证）」而不是「已确诊 EPERM」——诚实边界对齐你们 R-18 的既有口径。

**回归测试建议**（新档 `test/write-atomic.test.mjs`，**不碰 T6 基线档**——T6 原样继续当见证者，它的持续全绿就是证据）：
1. 注入 `{delays:[1,1,1]}` + mock rename 前 k 次 EPERM → 断言内容落地、零 tmp 残留、返回成功；
2. 持续 EPERM → 抛、消息含 `code`+`after N attempts`、零残留；
3. 非可重试（ENOTDIR/ENOSPC）→ 单次快失败（断言无环内 sleep）；
4. **Windows 门控集成锁（R-13 机制锁本体）**：子进程用 `FileShare.None` 持住目标文件（PowerShell `[IO.File]::Open($p,'Open','Read','None')`，握手用标记文件），父侧调 `saveSessionState` 断言返回 `true` 且文件内容正确——这就是把「锁中途释放第 6 次成功」从仓外探针搬进套件，且顺带拿到「save 返回值被断言」这个 T6 没有的机械事实（**不动 T6 就补上了 T6 缺的断言面**）。要给它登记自己的 flake 风险（PowerShell 握手时序），非 Windows 平台 skip。

**台账成本清单（父侧落地时逐项核对）**：新档 ⇒ T-E19 清单 + §三处置行 + 全档计数三处同改；§五清空 + `release-check.test.mjs` 三处断言 + `release-check.mjs:270` 文案 + README §五措辞；`dsh-home.mjs` 头注释与 store 三处头注释同步（本仓 doc-hygiene 测试盯着「描述面与实现一致」）；NIGHT-SHIFT-PLAN/REPORT 状态行。

**一句话**：同步重试按 Q1 骨架做（8 次爬升 ≤790ms、code 门控、每次重写 tmp、mkdir 环外、陈旧清扫兜底），`clearUserConfig` 并入共享 rename 原语，契约不变只亮消息，R-13 移表时**同提交修 `release-check` 的机械依赖**——这四件事缺一不可，缺任何一件要么 flake 挪进盲区、要么发布门当场红。
```

## §2 逐条处置（**主代理写** · 每条回复**恰一条**处置）

| 回复 | 处置 | 计数 |
|---|---|---|
| **[1] `codex-cli:gpt-6-astra`** | **无输出可处置**（`PROCESS_ERROR`——**该席在本会话第六次**；不重试、不补位、不臆称结论） | — |
| **[2] `zai-coding-cn:glm-5.3`** | **采纳 8 · 不采纳 1 · 采纳为可选并实做 1** | 10 |
| **[3] `deepseek-official:deepseek-v4-pro`** | **采纳 12 · 部分采纳 2 · 不采纳 1** | 15 |
| **[4] `kimi-api:kimi-k3`** | **采纳 12 · 不采纳 1** | 13 |

### §2.1 [2] glm-5.3 的 10 条

| # | 它主张 | 处置 |
|---|---|---|
| **G1** | 可重试集 = `EPERM`/`EACCES`/`EBUSY`（**按 `e.code` 字符串**）+ `ENOENT` 特判重铸 tmp | **采纳** |
| **G2** | 8 次 × 平铺 30ms（~250ms，与父侧探针包络对齐） | **采纳**（见 §3 **D-19-1**） |
| **G3** | 只包 `renameSync`；`mkdirSync` 留环外（保 F12-T5 的 ENOTDIR 快失败） | **采纳「mkdir 环外」**；「首写也留环外」**部分不采纳**（见 §3 **D-19-3**） |
| **G4** | 耗尽后**重抛原对象**（保 `.code`）+ 追加 message | **采纳** |
| **G5** | 抽 `renameSyncWithRetry` 原语供 `clearUserConfig` 复用（单一事实源） | **采纳** |
| **G6** | **给 T6 的 `saveSessionState` 加返回值断言**（走 `AP_TEST_AUTHORIZED`） | **不采纳**（见 §3 **D-19-4**） |
| **G7** | ★ `index.mjs` 的 `DELETE /config` **丢了 `clearUserConfig` 返回值、无条件 `ok:true`** ⇒ 面向用户的谎 | **采纳**（**父侧已逐字回盘核实属实**；对照 PUT 路径已正确） |
| **G8** | 其余 7 个 `saveSessionState` 写点**维持 N3**（内存态是第一事实源） | **采纳** |
| **G9** | `clearUserConfig` 的 TOCTOU：`existsSync`→rename 之间被删 ⇒ `ENOENT` 应判「已清空」返回 true | **采纳** |
| **G10** | 孤儿 `.tmp-*`/`.del-*` 清扫（**它自标为可选**） | **采纳为可选 → 实做**（见 §3 **D-19-5**） |

### §2.2 [3] v4-pro 的 15 条

| # | 它主张 | 处置 |
|---|---|---|
| **V1** | 可重试集 = `EPERM`/`EBUSY`/`EACCES`/`EAGAIN`/`ENOENT` | **部分采纳**：前三 + `ENOENT` 采纳；**`EAGAIN` 不采纳**（未实测——白名单是**带注释的常量**，将来显式加，登记 R-61） |
| **V2** | 8 次 + **爬升退避** `[20,30,40,60,90,130,180,240]ms`（总 ~790ms） | **不采纳**（见 §3 **D-19-1**：2:1 对立 + 与探针不对齐；**其长尾论点登记为边界 R-62**） |
| **V3** | **写 + rename 同入环内 try**，且**每次生成新 tmp 名** | **部分采纳**：**「写入环内 try」采纳**（它实测到 `lib/dsh-home.mjs:69` 的**首写失败既抛又留半个 tmp、且不清理**——**父侧已回盘核实属实**）；**「每次新名」不采纳**（碰撞面已被 kimi 实测证伪 ⇒ **不为不存在的问题加机制**，见 §3 **D-19-3**） |
| **V4** | warn 必须带 `code`/`errno`/重试次数 ⇒ **复发可判真伪** | **采纳**（三条腿里唯一的「观测面」） |
| **V5** | **台账纪律**：flake 行必须记 **warn 原文** | **采纳**（进设计档与台账） |
| **V6** | **契约不改**（`warn + return false` 是既定 fail-safe） | **采纳**（三家一致） |
| **V7** | **不**改那 7 处 `session-state` 调用点 | **采纳**（登记 R-65） |
| **V8** | `clearUserConfig` 并入（共享原语） | **采纳** |
| **V9** | ★ **发布门机械级联**：`test/release-check.test.mjs` 三处断言 + `release-check.mjs` 硬编码文案 + `docs/README.md` | **部分采纳**（见 §3 **D-19-6**：**本批不删行 ⇒ 级联不触发**；级联清单**登记为 R-64**） |
| **V10** | 并发 LWW **重试治不了**；「重试加宽了窗口」补进既有登记 | **采纳**（★ 防超卖） |
| **V11** | 无 `fsync`（断电可能 rename 持久而数据不持久）⇒ 登记 accepted | **采纳** |
| **V12** | 永久 `EPERM`（目录 ACL）每次都烧满预算 | **采纳为已接受的代价** |
| **V13** | ★ **诚实边界**：R-13 的**原发 errno 从未被捕获** ⇒ 姿态必须是「**按机制假设根修**」而非「已确诊 EPERM」 | **采纳**（★ 与 R-18 的既有口径同律） |
| **V14** | 疗效举证门槛：全量 ×N + 单档 ×N **全绿**才准写「已根治」 | **采纳**（与 K13 合并为同一条门槛） |
| **V15** | 新建 `test/write-atomic.test.mjs`（**不碰 T6 基线档**） | **采纳**（其机械成本见 §3 **D-19-7**） |

### §2.3 [4] kimi-k3 的 13 条

| # | 它主张 | 处置 |
|---|---|---|
| **K1** | 白名单 `EPERM`/`EACCES`/`EBUSY`（**按 `code`**）· 8 次 · **固定 30ms** · 不重写 tmp（`ENOENT` 例外） | **采纳** |
| **K2** | **不发明未实测的退避曲线** | **采纳**（即 **D-19-1** 的裁据） |
| **K3** | 同步 sleep 可接受；**异步化的爆炸半径实测**（7 处调用点 + 时序语义） | **采纳** |
| **K4** | `Atomics.wait` **feature-detect + 自旋兜底** | **采纳** |
| **K5** | 契约不动；加**稳定可 grep 的失败签名** | **采纳** |
| **K6** | 把那 7 处调用点改成「失败冒泡到 UI」 | **不采纳本批**（登记 **R-65**） |
| **K7** | `clearUserConfig` 并入（共享原语）+ TOCTOU | **采纳** |
| **K8** | 孤儿清扫：**同目录 + 同前缀 + 龄 ≥ 10min**（防误杀在飞 tmp） | **采纳** |
| **K9** | **tmp 名碰撞实测证伪**（跨进程 pid 异 · 进程内同步不交错） | **采纳**（作为设计档的一行论证，防评审再问） |
| **K10** | ★ 新测试档的**登记级联**（T-E19 清单 + 台账 §三 + 双 parity）+ **Windows 持句柄夹具必须用另一进程**（Node 的 `fs.open` 默认 share-delete） | **采纳**（★ 本批最重的机械成本，见 **D-19-7**） |
| **K11** | 头注/JSDoc 同步（`dsh-home.mjs` + 三个 store 的引用处） | **采纳** |
| **K12** | 表空后 **G6 语义翻转**（G2 红 ⇒ 门红、无复跑豁免）是**有意的** | **采纳其分析**；**但不适用本批**（**D-19-6** 不删行） |
| **K13** | 疗效门槛（全量 ×10 + `session-state`/`codex-runner` 单档 ×20） | **采纳**（与 V14 合并为同一条门槛） |

---

## §3 分歧与父侧裁定（**主代理写**）

### D-19-1 **退避曲线：平铺 30ms × 8**（2:1 分歧：glm + kimi 平铺 · v4-pro 爬升至 ~790ms）

**裁定：采纳平铺。**理由三条：① **2:1**；② **与父侧探针包络对齐**（我实测就是「锁中途释放 ⇒ 第 6 次成功、190ms」），而**爬升曲线没有任何实测支撑**——本仓明令「不发明未实测的机制」；③ **同步阻塞的代价要小**（`writeFileAtomic` 在每个 store 的保存路径上）。
**⇒ 同时把 v4-pro 的论据如实登记为边界（不是驳回）**：**持锁 > ~210ms 的类（企业备份/同步盘）本批治不了**——**而那时正是「可见性腿」接手的地方**（V4 / K5）。**⇒ 两条腿的分工由此明确：重试治瞬态，可见性治持续。**

### D-19-2 **可重试集 = `EPERM` / `EACCES` / `EBUSY`（按 `e.code` 字符串）+ `ENOENT` 特判**

`ENOENT` 不进主白名单，而是**特判**（tmp 被 AV 清走 ⇒ **重铸 tmp** 再继续同一预算）。**`EAGAIN` 不采纳**（v4-pro 独家、未实测）：**白名单是一个带注释的常量**，将来要加是一次**显式动作**（登记 **R-61**）。

### D-19-3 **tmp 结构：写 + rename 同入环内 `try`（失败即 `unlink`）；tmp 名保持单次**

- **采纳 V3 的前半**：v4-pro 实测到 `lib/dsh-home.mjs:69` 的**首写失败既抛又留半个 tmp、且不清理**——**父侧已回盘核实属实**，这是真缺陷。
- **不采纳 V3 的后半（每次新 tmp 名）**：**碰撞面已被 kimi 实测证伪**（跨进程 pid 不同；进程内全同步不可自交错）⇒ 为不存在的问题加机制**正是本仓明令禁止的**。

### D-19-4 **不碰基线档 `test/session-state.test.mjs`**（不采纳 G6）

glm 提议给 T6 的 `saveSessionState` 调用加返回值断言并走授权仪式。**不采纳**，理由：① **v4-pro 与 kimi 都主张「T6 原样当见证者」**（它的**持续全绿本身就是疗效证据**）；② 改基线档要动 `AP_TEST_AUTHORIZED`（`test/death-provenance.test.mjs`）——**为一条断言牵动授权面不划算**；③ **本批的可见性腿已有落点**（helper 遥测 + `index.mjs` 的那处谎），不需靠改 T6 取证。

### D-19-5 **孤儿清扫：做**

三家里 glm 标「可选」、kimi 明确建议做。**裁定：做**——它与 `session-store` 既有的「**写时清扫**」哲学**同构**，成本 ~8 行，把「OS 最终回收」变成**有界**。**阈值 = 同目录 + 同前缀 + 龄 ≥ 10min**（kimi 的阈值：在飞 tmp 是秒级 ⇒ **误伤面为零**）。

### D-19-6 ★★ **`R-13` 的处置形态：只翻转状态，不删行**（**本批最大的一处父侧裁定；不采纳会诊的一致建议**）

**会诊一致主张「把 `R-13` 移出 flake 表」并同批改发布门**（V9 的级联清单 + kimi §5-a）。**父侧裁定：不删行，改为把该行的「处置」列更新为「已根治（v0.28.0）」。**理由三条：

| # | 理由 |
|---|---|
| **1** | **删行会触发三条机械断言的级联**：`test/release-check.test.mjs` 断言**活台账的 flake 表非空**且 **`R-13` 在首行**；`release-check.mjs:270` **硬编码**「R-13 flake 复跑转绿」文案；`docs/README.md` 的台账描述写「R-13 首行」 |
| **2** | **它把「发布门本体 + 它的测试档」拉进写域**，而 `test/release-check.test.mjs` 是**基线档** ⇒ 又是一次 `AP_TEST_AUTHORIZED` 仪式 ⇒ **范围与风险都显著上升** |
| **3** | **「移出」不在用户给本批的任务边界内**（原话只要「查明 `R-13` 与 rename 失败的**因果关系**」）⇒ **本批做「状态翻转」，把「删行 + 门内三处谓词改造」登记为 R-64**（那是一次**独立的门改造**，不该夹在写路径硬化里） |

**⇒ 附带如实登记**：表非空 ⇒ `G6` 仍会为 `session-state.test.mjs` 保留一次**复跑豁免**，而该档**已根治** ⇒ **该豁免成为空转**。**这是「不删行」的已知代价**（登记 **R-63**），写进设计档的边界节。

### D-19-7 **新测试档 `test/write-atomic.test.mjs`：采纳，但机械成本先进预算**

kimi 实测列出建新档的级联：**T-E19 档清单闸**（`guard-e.test.mjs` 非递归枚举）· **台账 §三 新行** · **`ledger-parity` / `test-lifecycle` 双 parity** · CHANGELOG 计数 + 版本 bump。**⇒ 设计档必须把这条级联写进 stage 计划**（否则 stage 4 必红）。
**★ 且 Windows 持句柄夹具必须用另一进程**（kimi 实测：Node 的 `fs.open` 默认 share-delete ⇒ **同进程锁不住 rename**）——这与父侧探针一致（父侧当时也用了 holder 子进程）。

### D-19-8 **`T6` 一字不改**

采纳 v4-pro / kimi 的多数派。**它的持续全绿 = 疗效见证**；而 **`R-13` 的行状态翻转**（D-19-6）不影响该档一个字节。

---

## §4 教训（**主代理写**）

| # | 教训 | 证据 |
|---|---|---|
| **1** | **会诊把我的需求档升了级**：我的草稿只有**重试腿** + 一条**泛泛的**「失败可见」；**三家一致指出「只做重试就是超卖」**，并给出可见性的**具体落点**（helper 消息带 `code`/重试次数 · **`index.mjs` 那处面向用户的谎** · 可 grep 的失败签名） | §2 各条 |
| **2** | **三方合力抓到一颗我没看见的地雷**：**「移出 flake 表」会打红三条机械断言并牵动发布门与其基线档**——**我起草需求档时写了 US-3「移出」，却完全没想到它的机械代价** | §3 **D-19-6** |
| **3** | **两处「会诊说得对」由父侧回盘核实**：glm 的 `index.mjs` 谎（**逐字核实属实**）· v4-pro 的「首写失败留半个 tmp」（**`dsh-home.mjs:69` 属实**） | §2.1 G7 · §2.2 V3 |
| **4** | **`codex-cli` 第六次 `PROCESS_ERROR`**（3/4 已是本仓会诊的**常态**） | §2 |
| **5** | **父侧自记**：**我在起草需求档时把自己的要求写成「移出 flake 表」，却没有把它的代价一起算**——**「想要的状态」与「付出的代价」不同批算**，正是本仓「宣言比机制大」的又一面 | §3 **D-19-6** |

---

## §5 不可验清单（**主代理写**）

| # | 项 | 为什么 |
|---|---|---|
| **1** | **`R-13` 的原发 errno** | **无现场记录**（warn 文本没被捕获）⇒ 本批的姿态只能是「**按机制假设根修**」（V13 的诚实边界），**不许写成「已确诊 `EPERM`」** |
| **2** | **真实杀软/索引器的持有形态与时长** | 生产环境不可在仓内复现；探针只能构造「另一进程持有句柄」这一个形态（摸底档 §3） |
| **3** | **宿主日志面的可见性** | 与批 19 同款（`console.warn` 落点不可在本仓内生验证） |
| **4** | **多进程 LWW 的真实发生率** | 与「重试加宽窗口」同源，**登记不修**（V10） |

**登记**：**R-61**（`EAGAIN` 未实测、暂不入白名单）· **R-62**（**持锁 > ~210ms 的类**本批治不了 ⇒ **由可见性腿接手**）· **R-63**（**`G6` 对已根治档的复跑豁免成为空转**——「不删行」的已知代价）· **R-64**（**「删行 + 门内三处谓词改造」**是一次独立的门改造，另立批次）· **R-65**（7 处 `session-state` 调用点的失败可见性，另立批次）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-17 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-09-17 | **裁定层补写（主代理）**：§2 **逐条处置**（[1] `PROCESS_ERROR` 无输出可处置（该席**第六次**）· [2] 采纳 8/不采纳 1/可选实做 1 · [3] 采纳 12/部分 2/不采纳 1 · [4] 采纳 12/不采纳 1）· §3 **八条裁定 D-19-1…D-19-8**（★ **D-19-6 不采纳会诊一致建议**：`R-13` **只翻转状态、不删行**——删行会打红发布门的三条机械断言并牵动基线档与 `AP_TEST_AUTHORIZED`；级联登记为 **R-64**）· §4 **教训五条**（含「会诊把父侧的需求档升了级」与「父侧把要求与代价分开算」）· §5 四项不可验 + **R-61…R-65** |
