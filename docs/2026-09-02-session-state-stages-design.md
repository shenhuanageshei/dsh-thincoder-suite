# thincoder-suite 扩展：F12 会话状态持久化 + F13 阶段化任务书 + D 复核 — 设计

- 日期：2026-09-02
- 状态：✅ 已实施（2026-09-03 v0.6 交付：dsh-home/session-store 新模块 + 五文件写点接入 + 29 个新测试用例（50 → 79 全绿）；T0 实证 = `agent/session-start` 在宿主恢复会话时触发（源码级实证，预载分支落地）；T1/T2/T16 为手动冒烟项——需真重启验证，执行方式见交付报告）
- 范围：① F12 会话级状态持久化（engineering/advisorRound 等重启恢复）② F13 eng_coder 阶段化任务书（stages 结构化参数）③ D 评审工具输出限制复核（结论：已 64K，含 keyFiles 小改进）
- 关联文档：`../METHODOLOGY.md`、`2026-09-02-thincoder-suite-extensions-design.md`（F10 token-store 先例）、`2026-09-01-advisor-config-design.md`（一期协议）
- 设计输入：2026-09-02 会诊（consult id=1，qax/glm-5.3——三题独立设计意见带 file:line 依据；本文档采纳并精炼）

---

## 0. 背景与问题陈述

- **F12**：`lib/state.mjs` 的会话状态（engineering 翻转、advisorRound/lastAdvisorOutput/lastReviewType 评审协议状态）为模块级 Map 内存态——进程重启全丢。实证：本会话多次重启后每次都要重新 `eng enter`、设计评审从 round 1 重来（F10 只解决了 designToken；本会话曾因 hotfix 重启被迫 5+ 次重评审）。
- **F13**：eng_coder 一次 spawn 一个大 task 跑完，无阶段自查点——大任务（10+ 文件）翻车难定位；F9 曾因 reasoning 吞输出预算被 max-tokens 掐断（stage 前置表可保生存性）。"输出预算不足优先核心文件"的兜底目前只在主代理的 task 文本里（非模板机制）——需要正式化。
- **D**：疑似上游 0.12.43 的 16K→64K 截断放宽未移植——**会诊复核：已就位**（`lib/readonly-tools.mjs` MAX_RESULT_CHARS = 64K，注释对齐 thincoder run.mjs）。D 的实际工作 = 确认零改动 + compactMessages 小改进 + 风险记录。

---

## 1. 需求（三层）

### 1.1 总体目标

F12：协议推进状态（评审轮次/工程模式/会话路由调优）跨重启存活——重启后工程模式状态与评审轮次按停机前恢复，不重来；F13：大任务以显式阶段执行，阶段自查、失败定位、输出截断下保报告生存性；D：复核确认评审工具输出预算已对齐上游。

### 1.2 功能用户故事

- **F12-1**：作为用户，我在会话里 `eng enter` 后重启 DSH，会话恢复仍是工程模式（不必重新 enter）。
- **F12-2**：作为用户，设计评审进行到 round 2 时重启，恢复后评审从 round 2 续（带 prior 表核销），不从 round 1 重来。
- **F12-3**：作为用户，会话级 advisorOverride（路由调优）重启后仍在。
- **F13-1**：作为用户，我派 eng_coder 时能给结构化阶段列表（每阶段目标/文件/验收/自查命令），子代理按序执行、阶段自查不过不进下一阶段。
- **F13-2**：作为用户，阶段失败后子代理停止并上报 stage 状态表（已过/失败/跳过），我裁决后从失败阶段续派。
- **D-1**：作为用户，评审读大文件不被过早截断（64K 维持）；被压缩的历史不导致评审重复读同一文件（keyFiles 去重）。

### 1.3 非功能标准

- **N1** 零 bare import 零新增依赖维持；新模块（session-store/stages 渲染）纯 node ESM。
- **N2** 协议语义零回归：恢复只填空槽（不覆盖已推进的内存态）；`stages` 缺省时 brief 逐字节等于现行输出（fixture 回归锁死）；D 不改变截断行为。
- **N3** fail-safe：状态文件损坏/缺失 → 回落纯内存行为（不崩溃）；写失败仅 warn。
- **N4** 安全：session-state.json **绝不含 designToken**（F10 token-store 单路管理凭证，避免双事实源/撤销失效事故）。
- **N5** 会话销毁/过期清理：`session/disposed` 删除条目 + 7d TTL 写时全量清扫（防崩溃孤儿累积）。

---

## 2. F12 会话级状态持久化

### 2.1 落盘字段（会诊意见采纳：只落「协议推进状态」，不落运行时绑定/凭证）

| 字段 | 落盘 | 理由 |
|---|---|---|
| `advisorRound` + `lastAdvisorOutput` + `lastReviewType` | ✅ **原子组** | 单存轮次会恢复出「无 prior 的收敛轮」——round≥1 路由 convergence 组且按 round2+ 协议要 prior 表（F11 隔离也依赖 lastReviewType）。**恢复规范化**：`round > 0 && !lastAdvisorOutput → round = 0` |
| `engineering` | ✅ tri-state 原样 | null/true/false 已编码「显式翻转 vs 跟配置默认」；恢复显式值延续用户当时意图 |
| `mutatedThisRun` | ✅ | 移植版从未复位（仅置 true），语义已是会话级 |
| `touchedFiles` | ✅ | advisor 无显式 scope 的兜底；去重 + 封顶 200 |
| `advisorOverride` | ✅ | 会话级路由调优；白名单校验链已存在 |
| `engSection` | ❌ | 进程内 disposer 闭包不可序列化——恢复时重挂 |
| `designToken`/`pendingDesignToken` | ❌ | F10 独立落盘；双盘写 = 双事实源（撤销要走双写同步，任何一路失败即「撤销失效/复活」） |
| `consultSessions`/`consultIdCounter` | ❌ | 绑定当前回合，控制器不可序列化 |

### 2.2 存储：独立 `session-state.json` + 新 `lib/session-store.mjs`

`$DSH_HOME/.thincoder/session-state.json`（与 design-tokens.json **分文件**）：

```json
{ "version": 1, "sessions": { "<sessionId>": { "advisorRound": 2, "lastAdvisorOutput": "…≤32K（超限截断 + [truncated] 标记）…", "lastReviewType": "design", "engineering": true, "mutatedThisRun": true, "touchedFiles": ["…"], "advisorOverride": {…}, "lastSeen": 1788359000000 } } }
```

分文件理由：① 生命周期语义不同（token 内嵌 TTL/HMAC 按 expiresAt 清扫；state 无自然过期 → `lastSeen` + 独立 7d TTL）——混文件 = 两套清扫规则纠缠且稀释 F10「凭证文件」安全推理；② 回滚独立（删 session-state.json 回纯内存行为，token 不受牵连）；③ 顺带抽取公共 `lib/dsh-home.mjs`（pickDshHome/probeProfileRoot 在 token-store 与 config-store 重复两份——第三份前抽公共模块）。

**写入策略**：语义转换点写盘（非每次内部 mutation）——`engineeringToggle`、`runAdvisorReview` 完成分支后、`runEngCoder` 交付后、`runAdvisorConfigTool` set/reset。**原子写 tmp+rename**（对齐 config-store；多会话单文件直写 = 崩半写丢全部会话状态）。评审 #4：该理由同样适用于 design-tokens.json——dsh-home 抽取时把原子写 helper 抽公共，token-store 顺带升级为原子写（其现状直写是 1h TTL 损失=重评审可接受的历史选择，统一后无损失）。

**恢复时机：`agent/session-start` 预载为主**（唯一能无副作用重挂 engineering section 的钩子——preset 自动 enter 即此路径）：
1. session-start 里 `restoreSessionState(sessionId)`：map 无该 key 且盘上有 TTL 内有效条目 → 白名单字段级校验后整条灌入（含规范化 round）；
2. 恢复后 `engineering === true` → 重挂 section（既有 `if (!state.engSection)` 守卫消解双挂）；
3. map 已有 key → 跳过（**只填空槽**，防覆盖重启后已推进的内存态）；
4. 一行 console 观测。
5. **兜底（若 T0 实证 session-start 不触发）**：三个工具 execute 入口惰性 `restoreIfAbsent` + 文档标注（中途重挂 section 可用性未证实——失败方向安全：工具/门禁照常，只是主代理少 architect 人格段）。

### 2.3 写点全表（评审 #6：六持久字段的全部 mutation 路径与写盘时机）

| 字段 | mutation 路径 | 写盘时机 |
|---|---|---|
| advisorRound / lastAdvisorOutput / lastReviewType | runAdvisorReview 完成分支推进；**F11 类型切换重置分支**（重置为 0/清 prior 也要落盘） | runAdvisorReview 返回前 |
| engineering | eng enter/exit（engineeringToggle） | 翻转后 |
| mutatedThisRun | eng_coder/escalate 交付置 true（eng.mjs/escalate.mjs 返回并入处） | 交付后（runEngCoder/runEscalate 返回前） |
| touchedFiles | escalate/eng_coder 返回并入（现有逻辑）；advisor 完成分支（若 append） | 同上 |
| advisorOverride | advisor_config set/reset；**二期 config API apply-session/reset-session（index.mjs）** | 各工具/handler 返回前 |

staleness 窗口：会话内多 mutation 间崩溃丢最近窗口（到上一写点）——接受（N3 fail-safe 语义：丢=回内存行为）。实施时按此表核对写点完整覆盖。

### 2.4 清理与过期

- `session/disposed` → dropSession 现有路径追加 removeSessionState（镜像 removeTokenRecord，不阻塞 consult 清理）；
- 崩溃孤儿 → 写时全量清扫：`now - lastSeen > STATE_TTL_MS`（7d 常量，勿做成用户配置——防泄漏非调优项）；
- 与 F10 清扫互不相干（token 1h / state 7d 各扫各的）。

### 2.5 恢复值与配置默认冲突

不需要新机制：tri-state 已内建优先级（`engEffective`：显式翻转 ?? 配置默认）。要处理的是**呈现**（console 一行观测「restored engineering=on from session state」）与边界（停机期间改了 config 默认 → 恢复显式值胜出——文档说明），不是优先级。

---

## 3. F13 eng_coder 阶段化任务书

### 3.1 语法：结构化 `stages` 参数 + 模板机器渲染

eng_coder 参数加可选 `stages` 数组（工具 schema 层校验——不是 task 里写 markdown，防主代理格式漂移无法机械约束）：

```jsonc
stages: { type: "array", maxItems: 10, items: { type: "object",
  properties: { goal: string, files: string[], acceptance: string, check: string },
  required: ["goal", "files", "acceptance", "check"] } }
```

- `check` 必填 = 阶段自查命令（通常 node --check / node --test 目标子集）；
- `task` 保持自由文本（总体目标/约束）；**stages 缺省时 `buildCoderBrief` 输出逐字节等于现行**（fixture 回归锁死——现行 brief 是三个历史交付共同依赖的契约）；
- 有 stages 时模板渲染统一编号：`### Stage N — goal / Files / Acceptance / Self-check` 四段；**空字段由 schema 拒绝**（required + minLength 1——空串/空数组不通过，故不存在"缺段渲染"歧义，评审 #13）；渲染前再做一次防御校验（host schema 未强制 items 时，见实施确认项 5）；
- 纪律段：「按序执行；stage N 自查不过不得进入 N+1；阶段内只动本阶段 files（文档同步例外）；跨阶段文件需求 = STOP 上报」；
- **stage 状态表置于报告最前**（`| Stage | passed/failed/skipped | check 摘要 |`）——F9 max-tokens 掐断事故的生存性设计：输出被掐也保住分类账；
- 末行 `Touched files: <paths>` 约定不动（parseTouchedFiles 从尾部解析，兼容零改动）；
- 漂移探测：stages 缺省但 task 匹配 `/stage|阶段\s*\d/i` → 返回前缀警告（N4 先例）。

### 3.2 执行与失败策略

- **单次 spawn 跑完全部阶段**（非每阶段一 spawn）：docs 只读一遍、上下文延续、失败报告天然定位。被否方案「每阶段一 spawn」有隐性耦合：每次 spawn 触发 advisorRound 清零 + touchedFiles 合并（eng.mjs 交付后重置）——文档写明防后人改 per-stage 踩雷。
- **check 失败 ≠ 立即停**：阶段内有限自修（修码-重跑是自查的意义——上下文还热）；**同一阶段第二次真修后仍失败 → STOP**。
- 硬停条件：check 两败 / 需动清单外文件 / 设计缺口 / 需用户决策（既有规则）/ permission denied（既有规则）。
- 停止即终局报告：stage 表 + 失败详情（check 命令原文 + 输出尾部 + 假设）+ 待父会话决策项。
- 父代理裁决后**新开一次 eng_coder**（从失败阶段起 corrected stages）——token 不消费可多次 spawn。
- 不做整体自动重试（重试决策归父代理）；不许带病推进。子代理 toolFilter 已 deny escalate/consult——只能上报不能甩锅（有意设计）。

### 3.3 与「预算不足优先核心文件」的合并

会诊诚实盘点：该兜底**目前不存在于代码**（buildCoderBrief 无此措辞——F9 的实际修复是结构性的：显式 maxTokens 65536 + effort low）。F13 是首次正式化：

1. **排序即优先级**：核心文件排 stage 1–2，预算耗尽时未启动的自然是非核心阶段——skipped 行即取舍证据；
2. **stage 表前置** = max-tokens 掐断生存性（输出被掐 → 分类账仍在；Touched files 若被掐丢可从表内 Files 列重建）；
3. 模板加：「意识到输出预算将尽 → 立即停止开启新阶段、跑完当前阶段 check、以 stage 表开头收尾」。

---

## 4. D 复核结论（会诊：已 64K，零改动 + 小改进）

- **事实**：`lib/readonly-tools.mjs` `MAX_RESULT_CHARS = 64 * 1024`（注释对齐 thincoder run.mjs）——上游 0.12.43 的 16K→64K 在本移植已就位；read/glob/grep/ls 全走同一 truncateResult，行感知截断带续读指针（模型可自主分页）。
- **截断 vs 摘要**：文件内容**必须截断不能摘要**——评审产出 file:line 精确引用（机械验真），LLM 摘要 = 制造「已检查」记忆。历史压缩保持本地确定性摘要（无 LLM 无幻觉面）。**不引入 LLM 摘要**。
- **小改进（实施）**：compactMessages 的 keyFiles 只留 5 个且不去重——中段被压缩后评审易重复读已查文件浪费回合。改**去重 + 提到 15**，确定性零成本。
- **风险记录（不动）**：① recent-20 内多条 64K 大结果仍超 → 硬停（设计好的 runaway 守卫）；② 输出侧 8192 token ≈32K chars——大范围 round1 表格式评审有掐尾风险，候选可配 advisorMaxTokens / round1 提档 16384，等一次真实掐尾案例再动（YAGNI）。

---

## 5. 受影响文件

| 文件 | 状态 | 改动 |
|---|---|---|
| `lib/dsh-home.mjs` | ✅ 已实施（新） | 公共路径解析（pickDshHome/probeProfileRoot，从 token-store/config-store 抽取——两处改 import，行为零变化）+ 共用原子写 helper writeFileAtomic（评审 #4：token-store 顺带升级原子写） |
| `lib/session-store.mjs` | ✅ 已实施（新） | 状态 load/save/remove/清扫（原子写、try/catch、storPathOverride 注入缝、normalizeRestored 恢复规范化 T3、7d STATE_TTL、32K 截断、200 封顶） |
| `lib/state.mjs` | ✅ 已实施 | 恢复字段白名单校验 helper（不反向 import index——sanitize 下沉到 session-store.normalizeRestored）：restoreSessionState（只填空槽 T15）+ viewOfSessionState/persistedSessionView 持久化视图 |
| `lib/advisor.mjs` | ✅ 已实施 | 完成分支写盘（round 推进后）+ F11 类型切换重置写盘；compactMessages keyFiles 去重 + 15（导出供 T13 直测） |
| `lib/eng.mjs` | ✅ 已实施 | eng enter/exit 翻转后写盘（engineeringToggle 增 opts 注入缝）；eng_coder 交付后写盘；`stages` 参数 + buildCoderBrief 模板渲染（缺省逐字节不变）+ validateStages 防御校验 + 漂移探测前缀警告 |
| `lib/index.mjs` | ✅ 已实施 | session-start 预载恢复 + engineering section 重挂 + 一行 console 观测；session/disposed 追加 removeSessionState；advisor_config set/reset 与 escalate 交付、config API apply/reset-session（persistSession 钩子）写盘；eng_coder 工具 schema 加 stages |
| `lib/token-store.mjs` / `lib/config-store.mjs` | ✅ 已实施 | 路径解析改 import dsh-home（行为不变，fixture 回归）；token-store 两处写回升级 writeFileAtomic；config-store 的 tmp+rename 单一化为 writeFileAtomic |
| `lib/escalate.mjs` | 不动 | parseTouchedFiles 兼容（brief 尾行约定不变）；§2.3 的 escalate 交付写点落在 index.mjs 调用侧（工具返回前），文件本体零改动 |
| `test/` | ✅ 已实施 | session-state.test.mjs（T1–T8/T15 + §2.3 写点）；stages.test.mjs（T9 fixture 逐字节/T10/T11/T12 + schema）；truncation.test.mjs（T13 keyFiles/T17 截断锁）；既有全部用例回归（T14） |
| `docs/README.md` | 本次 | 登记本设计 |
| `README.md` | ✅ 已实施 | 变更记录（F12/F13/D 复核）+ F12/F13 使用节 + 差异清单更新 |

## 6. 验收标准

| # | 验收标准 | 验证方式 |
|---|---|---|
| T1 | eng enter 后模拟重启（清内存）→ restore 恢复 engineering=true 且 section 重挂（session-start 路径） | 单元（restore 函数直测）+ 手动冒烟（真重启，T0 后） |
| T2 | round 2 评审后模拟重启 → 恢复 advisorRound=2 + prior 表 → 下次评审走收敛轮且带 prior | 单元 + 手动冒烟 |
| T3 | 规范化：盘上 round>0 无 prior → 恢复 round=0 | 单元 |
| T4 | advisorOverride/touchedFiles/mutatedThisRun 恢复（含去重封顶 200） | 单元 |
| T5 | 盘上损坏/缺失/超 TTL → 回落内存行为不崩溃；写失败 warn | 单元 |
| T6 | session/disposed 删除条目；写时清扫过期（7d） | 单元 |
| T7 | 设计 token 不出现于 session-state.json（双盘禁止） | 单元断言 |
| T8 | session-state.json 与 design-tokens.json 分文件、回滚独立 | 单元 |
| T9 | stages 缺省 → brief 逐字节等于现行（fixture） | 单元回归 |
| T10 | stages 渲染：编号四段齐全；缺 check/超 10 → schema 拒 | 单元 |
| T11 | stages 模式任务书含 stage 表前置指令与预算将尽条款 | 单元（brief 文本断言） |
| T12 | 漂移探测：无 stages 但 task 含 "stage 2" → 警告 | 单元 |
| T13 | keyFiles 去重 + 上限 15（compactMessages） | 单元 |
| T14 | 既有全部用例（当前 50）全绿回归 | node --test |
| T15 | **只填空槽守卫**（评审 #2）：内存态已有推进 + 盘上陈旧条目 → 恢复跳过，内存胜（盘不覆盖） | 单元 |
| T16 | staged eng_coder 手动冒烟（评审 #3）：小任务含一阶段故意失败 check → 子代理 STOP + stage 状态表 + 父代理从失败阶段以修正 stages 重派成功 | 手动冒烟（T0 后随 T1/T2 一并） |
| T17 | 截断阈值回归锁（评审 #7）：readonly-tools 的 MAX_RESULT_CHARS=64K 与续读指针行为断言（readonly-tools.mjs 本身不改——只加测试） | 单元 |

## 7. 实施确认项（T0 前置）

0. **F10 状态与顺序**（评审 #1）：F10（token-store/design-tokens.json）已实施（v0.3）——"两份重复路径解析"前提成立（token-store 与 config-store 现存两份）；dsh-home 抽取覆盖两处；若 T0 实证发现顺序问题不影响 F12 主体（存储独立）。

1. **T0（F12 前置实证，与 F10 确认项 5 同一未知数）**：宿主重启恢复会话时 `agent/session-start` 是否触发、sessionId 是否稳定——实证前先不写恢复路径（或并行写 + 实证后切换预载/惰性两分支）；实证方法：重启后观察插件日志/探针；
2. dsh-home 抽取后 token-store/config-store fixture 全绿（行为零变化）；
3. 现行 brief fixture 采集（三个历史交付的 buildCoderBrief 输出快照，或现场生成一份锁死）；
4. session 恢复与 preset 自动 enter（thincoder-eng）双路径不冲突（既有守卫消解，冒烟确认）。
5. **host tool schema 对嵌套数组 items 的强制力**（评审 #11）：eng_coder 工具 schema 的 stages items.required/maxItems 若宿主不强制 → 渲染前代码级防御校验（缺字段/超限 → 明确错误返回）。

## 8. 风险与回滚

- **并发 last-write-wins**（评审 #5）：单宿主进程多会话同时写 session-state.json 的 read-modify-write 可能丢条目——同 F10 已接受限制（单进程 + 状态写低频 + 丢=回内存行为），不做 per-key merge；documented limitation。
- **F12 写放大**：lastAdvisorOutput 落盘前**超 32K 截断 + 尾部 [truncated] 标记**（评审 #9——上限强制而非期望；截断只影响重启后 prior 注入的尾部，正常路径内存态不受影响）；十会话 ≈300K 文件、分钟级写频——可接受；touchedFiles 封顶。
- **轮次上限恢复边界（v0.6 交付注，代码评审 #4）**：完成分支但输出不像评审（<200 字符且无表格——如通过型 design 评审短文本）时 lastAdvisorOutput 不存 → 落盘经 T3 规范化 round=0。后果：重启后该会话评审从 round 1 重来（正确——无 prior 不能走收敛轮），且 5 轮机械上限（MAX_ADVISOR_ROUNDS）随之重置。fail-safe 方向（上限重置只可能导致重评审消耗，不会放过问题），接受为已知行为；持久化「prior elided」哨兵以保上限跨重启不在本设计语义内（违反 §2.1 原子组理由），如需闭环改版本 2。
- **恢复呈现困惑**：停机改配置默认后恢复显式值胜出 → console 一行 + 文档说明（不新增 eng status 子动作）。
- **跨 preset 恢复**：换 preset 后恢复 engineering=true → 人格段并存——接受并文档化。
- **F13 阶段粒度失衡**：maxItems 10 拒 + description 引导 2–8 个可自查交付增量。
- **回滚**：删 session-state.json 回纯内存；stages 是纯增量（缺省零变化）；D 零行为改动。
