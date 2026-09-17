# 批 20 摸底记录 —— `writeFileAtomic` 硬化 + 并入 `R-13`

- 日期：2026-09-17
- 状态：**摸底（已完成：会诊 `#19` 已交付并折入需求档与设计档；本档保留为实测证据源）**
- **本档用途**：承载**与会诊无关的实测**（因果判定 · 机制可行性 · 调用面 · 失败可见性）⇒ 会诊返回后**并入需求档与设计档**（本仓先例：`docs/2026-09-15-config-surface-recon.md`）
- 主题：**「写失败被静默吞掉」与「`rename` 无重试」这一族**

<!-- doc-shape
count-marks: 项|处|条|档|值|步|腿
-->

---

## §1 靶子的机制（逐字自源码读，非引用旧登记）

`lib/dsh-home.mjs:65` 的 `writeFileAtomic(filePath, text)`：

| 步 | 动作 | 失败时 |
|---|---|---|
| 1 | `mkdirSync(dir, { recursive: true })` | **向上抛** |
| 2 | `writeFileSync(tmpPath, text, "utf8")`，`tmpPath` = 同目录 `.<基名>.tmp-<pid>-<Date.now()>` | **向上抛** |
| 3 | `renameSync(tmpPath, filePath)` | **`catch` 里 best-effort `unlinkSync(tmpPath)` 后原样抛出** ⇒ **无重试、无退避** |

**⇒ 三个 store 的 `save*` 都把它包在 `try/catch` 里**：`catch` **只 `console.warn` 一句**并返回 `false`（`lib/config-store.mjs:206` · `lib/session-store.mjs:184` · `lib/token-store.mjs` 同形）。

---

## §2 ★ 因果判定：`R-13` 与 `rename` 失败**同源**（实测判据，非推理）

**台账把它记作「**`test/session-state.test.mjs` T6（TTL 清扫）的既有时序 flake**」**。**但失败原文（记在 `docs/2026-09-13-handoff.md`）是**：

```
actual ['keep','malformed','stale1','stale2']   vs   expected ['fresh','keep']
```

**`actual` 恰恰是 `saveSessionState("fresh", …)` **落地之前**的文件内容**——即用例自己手写进去的那四个条目（`stale1` · `stale2` · `malformed` · `keep`），**既没有被清扫、也没有 `fresh`**。

| 判据 | 读数 |
|---|---|
| 该断言与时间有关吗 | **无关**——它比的是**文件里的键集**，不含任何时点量；`stale` 与 `keep` 的 `lastSeen` 分别取 `Date.now() - STATE_TTL_MS - 1000` 与 `Date.now() - 1000`，**余量充足、不可能翻边** |
| 唯一能产生该 `actual` 的路径 | **那次写没有落地**（文件停留在写前状态） |
| 为什么失败是静默的 | `saveSessionState` 失败时 **`catch → console.warn` + `return false`**，**而 T6 断言的是文件内容、不查返回值** |
| ⇒ 结论 | **「时序 flake」是误诊**；`R-13` 与批 14 登记的 **`R-51`**（`AC-17` 的 `saveTokenRecord` 返 `false`，诊断指向同一 helper 的 Windows `EPERM`）**同源** ⇒ **一次修两个** |

**⇒ 由此推出本批的第一条需求**：**`rename` 失败必须有界重试**（治因），**且最终失败必须可见**（治果）。

---

## §3 机制可行性（**仓外探针实测**，仓内零残留）

| # | 测什么 | 读数 |
|---|---|---|
| **1** | 目标被**另一进程持有句柄**时 `renameSync` 抛什么 | **`EPERM` / errno `-4048`**（本机 Windows 实证）⇒ **可重试的错误类别是确定的**（`EPERM`；`EACCES` / `EBUSY` 同族） |
| **2** | **主线程同步 sleep** 可用吗（`writeFileAtomic` 是同步函数，改异步会牵动三个 store 的全部调用面） | `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)` **可用**（请 25ms，实测 37ms）⇒ **同步有界重试可实现，不必改异步** |
| **3** | 锁**在重试循环中途释放** ⇒ 能恢复吗 | **第 6 次成功、总耗 190ms**（`MAX 8 × 退避 30ms`）⇒ **修法真的能治**（不是「重试也无用」） |
| **4** | 锁**持续不放** ⇒ 会假成功吗 | **8 次全败、`ok = false`** ⇒ **重试不掩盖真失败** |

---

## §4 调用面与「失败可见性」摸底

**`writeFileAtomic` 的调用点（全库实测）**：

| 模块 | 行 | 调用者 |
|---|---|---|
| `lib/config-store.mjs` | `:204` | `saveUserConfig` |
| `lib/session-store.mjs` | `:182` · `:229` | `saveSessionState` · `removeSessionState` |
| `lib/token-store.mjs` | `:119` · `:172` | `saveTokenRecord` · `removeTokenRecord` |

**⇒ 共 5 处 / 3 个 store**（计划里写的「4 个 store」**与实测不符**：`lib/dsh-home.mjs` 是**定义处**、不是调用者）。

**★ 第二处同族面（父侧新发现）**：**`lib/config-store.mjs:226` 有一处独立的 `renameSync`**（`clearUserConfig` 的原子删除路径：先 rename 成 `.del-<pid>-<时间戳>` 再 `rmSync`），**不在 `writeFileAtomic` 内** ⇒ **同源暴露，硬化时应一并覆盖**（否则「恢复默认」这条用户路径仍会静默失败）。

**失败可见性（返回值谁查了）**：

| 调用者 | 形态 | 观察 |
|---|---|---|
| `saveTokenRecord` | **有**两处接住：`const persisted = saveTokenRecord(…)`（`lib/advisor.mjs:2108`）· `const saved = saveTokenRecord(…)`（`lib/eng.mjs:715`） | 部分可见 |
| `saveUserConfig` | **接住**：`const saved = saveUserConfig(…)`（`lib/index.mjs:698`）⇒ PUT 面能报错 | 可见 |
| `removeTokenRecord` | **接住**：`const removed = removeTokenRecord(…)`（`lib/advisor.mjs:2157`） | 可见 |
| **`saveSessionState`** | **多数不查返回值**（`lib/advisor.mjs:1664` · `lib/eng.mjs:130` · `lib/escalate.mjs:186`/`:501` · `lib/index.mjs:910`/`:1015`/`:1261` 全部直接调用） | **静默** |
| `removeSessionState` | 直接调用（`lib/index.mjs:1154`，且外面已有 `try/catch`） | 静默 |

**⇒ 结论**：**「静默」集中在 session 面**——而这正是 `R-13` 命中的那个面（`saveSessionState("fresh")` 的失败被吞掉、测试仍按文件内容断言）。**⇒ 需求档要立「写失败必须可见」这一条时，落点应优先落在 `saveSessionState` 的调用面，而不是普适地改所有 store**（避免为一条 flake 牵动 8 处无关调用点）。

---

## §5 交给会诊 `#19` 的问题（**已发 · 已回 · 已折入需求档与设计档**）

重试策略（errno 白名单 · 次数 · 退避 · 失败后要不要重写 tmp）· **同步 sleep 的代价**（阻塞事件循环 vs 改异步的爆炸半径）· **失败可见性该改到哪一层**（helper 内 warn 够不够）· `clearUserConfig` 那处独立 rename 是否同批并入 · 还有哪些失败面（并发写同档 · tmp 名碰撞 · 崩溃残留）. **并被明确允许回答「重试根本治不了它」**。

---

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-17 | 首版（摸底，未开工）：**§2 因果判定**（`R-13` 与 `R-51` **同源**，「时序 flake」**是误诊**——失败原文恰是「写落地前」的文件内容）· **§3 机制可行性四条实测**（`EPERM`/`-4048` · `Atomics.wait` 可用 · 中断释放后第 6 次成功 190ms · 不假成功）· **§4 调用面订正**（**5 处 / 3 store**，非「4 个 store」）＋ **第二处同族面**（`config-store.mjs:226` 的独立 `renameSync`）＋ **失败可见性摸底**（静默集中在 session 面）· §5 待会诊 |
