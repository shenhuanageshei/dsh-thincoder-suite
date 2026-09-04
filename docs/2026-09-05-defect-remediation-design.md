# 设计文档：机制缺陷分轮修复设计（R1-R4）

- 日期：2026-09-05
- 状态：APPROVED（2026-09-05 设计评审通过——4🟡+2🔵 发现全部折入；DP-1/2/3 待用户终裁后实施）
- 上游：[需求文档](2026-09-05-defect-remediation-requirements.md)（含三项用户裁决 D-裁决-1/2/3）· [缺陷登记表](2026-09-05-defect-registry.md)（D-01…D-24，全部条目带证据行号）· 审计报告（thorough 子代理，2026-09-05）
- 平台契约依据：登记表「平台契约要点」五条（jobs 返回 branded string / 通知只含指针 / cancel→abort / run() 无墙钟 / job_output wait 上限 600s）

## 1. 问题陈述

四机制 + codex runner 已功能可用（125 测试绿），但机制层存在 9 项 🔴 阻塞级缺陷（**D-01 空响应坍缩**〔2026-09-05 生产复现 ×2 后由 🟡 升级〕、effort 矩阵级漏校验、eng codex 无钳制静默死亡、followup 绕过预算、后台无单飞、回落活锁、晚到 finalize 复活状态、写任务半途残留、dsh 子代理路径无界等待）与 10+ 项 🟡/🔵 缺陷。根因横切四个层面：执行架构（回合内 await × 平台墙钟）、失败语义（观测缺失 + 分类坍缩）、自愈边界（回落无封顶）、配置一致性（白名单/数据源漂移）。本设计按「诊断先行 → 架构收口 → 语义完备 → 一致性收尾」分四轮修复，每轮独立提交、独立可回滚、可独立验收。

## 2. 总体方案

### 2.1 四轮结构

| 轮 | 主题 | 覆盖缺陷 | 一句话目标 |
|---|---|---|---|
| **R1** | 诊断与校验层 | D-01(观测)、D-02、D-17、D-18、D-23(版本/注释部分) | 先让失败可读、effort 真正能用——后续轮依赖 R1 的观测与收口点 |
| **R2** | 执行架构与进程生命周期 | D-03、D-04、D-05、D-06、D-09、D-10、D-11、D-14、D-16、D-20、D-21、D-22 | 长任务不再静默死亡：jobs 迁移 + 单飞 + 代际检查 + 进程卫生 |
| **R3** | 回落与失败语义完备化 | D-07、D-01(重试/分类)、D-19 | 自愈可预测：回落封顶 + 空响应重试分类 + prior 纯净 |
| **R4** | 一致性与 UX 收口 | D-12、D-13、D-15、D-24 + 文档/测试收尾 | 配置三面同步 + 设置页竞态 + 测量定档 + 评审欠账 |

轮次依赖：R2 的迁移设计消费 R1 的 codex effort 收口（迁移后的 escalate/eng 复用同一 resolver）；R3 的空响应分类消费 R1 的观测字段；R4 的 D-15 测量消费 R2 的 idle 间隙日志。四轮按序执行，每轮一个 eng_coder 任务（stages 化）+ 偏离审计 + 交付 code review + 独立提交。

### 2.2 跨切原则（全部轮次共同遵守）

1. **回合内 await 判据**（N-1）：回合内的等待要么预算 ≤ budgetCap（钳制 + 响亮告警），要么派 ctx.jobs；无一处静默截断。
2. **失败可归因**（N-2）：失败文本携带结构化观测（finish.reason.kind、usage、block 计数、exit、stderr 尾部）；不单独依赖 exit code。
3. **single-flight + 代际检查**（N-3）：每会话每机制最多一个在飞任务；后台完成对共享状态的合并带代际校验。
4. **兼容性**（N-6）：config user 层只增不改；advisor 协议对外语义不变；DSH 平台零修改。

## 3. R1 — 诊断与校验层

### 3.1 D-02 effort 三层校验收口（核心）

**现状**：9 个消费点 × 三层矩阵中 6 个 GAP（登记表 D-02 + 审计 §4 矩阵）；`effort-resolve.mjs` 现行为回落到模型 `defaultEffort`（违背 D-裁决-2）。

**方案**：

- **`resolveSupportedEffort` 重规约（dsh 侧）**：回落语义改为**最近支持档**（D-裁决-2）。算法：按档位序 `off < low < medium < high < max` 在目标模型 `reasoningEfforts` 列表中查找；命中→保持；未命中→序距离最近的档；**等距 tie-break 向上取**（DP-2，保推理质量）。元数据不可得（resolveModelInfo 缺失/抛错）→ **fail-open 透传 + 响亮告警**（「保证真正能用」原则：绝不因校验砖化）。回落/透传都带 note。
- **新增 codex 侧 resolver**：`resolveCodexRowEffort(deps, runner, effort)` —— 数据源为 `discoverCodexModels` catalog（**不是** `llm.resolveModelInfo`，审计判定点 ③）。dsh 档位 → codex 档位：先按同名校验是否在模型 `supported_reasoning_levels` 内；不在→最近档（同 tie-break）；`off` → `null`（不传，codex 无 off）。catalog 未命中该模型 → fail-open 透传 + 告警。
- **收口点接线（消灭逐点漂移）**：
  - dsh 行：`consult.mjs:165`、`escalate.mjs:207` 按**行自身**的 provider/model 调 `resolveSupportedEffort`（不是父代理路由）；
  - codex 行：`consult` codex 行、`escalate` codex runner、`eng.mjs:399`、advisor 的 `runner.effort`（`resolveAdvisorRoute` 输出 → `buildCodexArgs` 之前）统一走 `resolveCodexRowEffort`；
  - `eng.mjs:385` 的 dsh 解析只在 dsh 分支执行（codex 分支跳过，消除误导告警）。
- **L2 设置页预检**（UI 决策 UI-1）：池行 effort 下拉按行动态取档位——dsh 行用 `/catalog` 的 provider+model `reasoningEfforts`；codex 行用 codex models catalog；`engCard` 的 EffortInput 补 provider/model 上下文（client.js:1057 现无）。静态枚举下拉全部替换。
- 修正 `effort-resolve.mjs:6` 虚假注释。

### 3.2 D-18 结构化观测三件套

- advisor dsh 循环：流结束记录 `finish?.reason`（kind + failure.message）、block 计数（text/tool-call）、finish 携带的 usage（如有）——追加到失败/空响应文本内 + `console.warn` 留档。
- codex 信封：TIMEOUT/PROCESS_ERROR 诊断加入 usage（input/output tokens，adapter 已捕获未上浮）；stderr 保留改为**尾部 4K**（可用错误在尾，N7）。

### 3.3 D-01 观测部分（重试留 R3）

`advisor.mjs:779` 空响应返回前生成分类行（finish null / stop 零块 / error 无 message 三形态区分 + 观测字段）；R1 不改返回语义（不重试、不烧轮次改动留 R3），只让文本可归因。

### 3.4 D-17 dsh 路径预算钳制

advisor dsh 主路径 + 回落轮：`effective = min(route.timeoutMs, budgetCapMs)`，超限钳制 + 尾部告警（镜像 codex 同步路径既有行为）。

### 3.5 D-23 chore（R1 部分）

package.json 版本锚定 0.7.0；`effort-resolve.mjs:6` 注释修正（其余漂移标记随各自轮次修）。

### 3.6 D-01 热修正式化（R1 新增，2026-09-05 热修的配置化收口）

advisor 单次 LLM 输出预算 `LLM_MAX_TOKENS` 由硬编码改为可配置：全局配置 `advisor.maxOutputTokens`（缺省 16384——2026-09-05 用户授权热修值；合法区间 4096..65536）。**三面白名单同步落地（N-5/US-10，防 D-13 同类漂移）**：PUT 校验（`index.mjs` topAllowed 增该字段 + 数值区间校验）、配置合并（`config-store.mjs` merge 白名单）、运行时读取（`advisor.mjs` 常量改为 effectiveGlobalConfig 读取 + 越界回落缺省并告警）、设置页字段（`client.js`）。热修仅改常量值，本节补齐全部配置面（含回归用例：非法值回落缺省 + 告警；三面白名单同步断言）。

### 3.7 R1 受影响文件

`lib/effort-resolve.mjs`（重规约 + codex resolver）、`lib/codex-adapter.mjs`（导出 catalog 解析）、`lib/advisor.mjs`（含 maxOutputTokens 配置化）、`lib/consult.mjs`、`lib/escalate.mjs`、`lib/eng.mjs`、`lib/index.mjs` + `lib/config-store.mjs`（maxOutputTokens 白名单两面）、`lib/client.js`（UI-1 + 新字段）、`package.json`、`test/codex-runner.test.mjs`

### 3.8 R1 验收标准

1. 矩阵 9 消费点全部转绿：每点 ≥1 回归用例（非法档 → 最近档回落 + note 断言；元数据缺失 → 透传 + 告警断言）；
2. tie-break 用例：medium 缺失且 low/high 皆支持 → 取 high（DP-2 过评审后锁定）；
3. codex 行用例：catalog 命中/未命中/off→null 三形态；
4. 空响应文本含分类行与观测字段；
5. dsh 超限预算钳制告警用例；版本 0.7.0 入库；
6. 全量测试绿（≥125 基线 + 新增）；
7. maxOutputTokens 配置化验收：非法值回落缺省 + 告警用例；三面白名单同步断言（PUT 接受 ⊕ merge 保留 ⊕ 运行时生效）。

## 4. R2 — 执行架构与进程生命周期

### 4.1 codex 写路径 jobs 迁移（D-03 / D-04 / T2.1b 收口）

escalate codex（首次 + **followup**，D-04 一并修）与 eng_coder codex 迁移到 ctx.jobs，**整体复制 advisor 已验证模式**：

- 预算 > budgetCap 且 jobs 可用 → 派发（owner 绑定 agent、cancel 走 ctrl.abort、run() 内自有 watchdog）；预算 ≤ cap → 同步执行（现状）。
- **工具契约**（UI 决策 UI-2）：立即返回 job 句柄 + 显式指令「**等待完成通知后再继续**（发散审计/交付评审）；长任务勿用 job_output wait 阻塞等待（平台等待上限 600s）」——修正 D-09 的虚假承诺文本。
- **簿记进 done() 且仅成功分支**（D-20 一并修）：escalate 的 touchedFiles 合并 + codexThreads 记录、eng 的轮次重置/mutatedThisRun/touched 合并，全部移入任务完成回调的成功分支；失败分支只输出诊断 + partial 的 advisory touched 提示。
- **followup 预算**：followup 路径预算解析与首次一致（runner.timeoutMs → budgetCap 钳制/jobs 判定），消除 D-04 的零余量撞墙；**补 followup effort 复用回归用例**（R1 审计 🔵5：首次交付保存已解析 runner，followup 复用——锁死该语义）。
- jobs 缺失降级：同步 + 钳制 + 响亮告警（镜像 advisor）。

### 4.2 D-21 dsh 子代理路径（DP-1，评审裁定）

**推荐方案 A：本轮钳制告警，jobs 迁移另立项**——escalate dsh（:220）与 eng dsh（:460）的 `await run.result` 加内部截止（budgetCap，AbortController + 定时器），到点 abort + 响亮告警（「dsh 子代理路径受平台墙钟约束，超限任务被终止；如需长任务请走 codex runner 或拆分 stages」）。理由：eng_coder dsh 同步交付驱动整个工程流程（交付→审计→评审），迁 jobs 是协议级重构，超出缺陷治理范畴；且历史 14 轮 eng_coder 交付未见 >600s 死亡记录，钳制即可消除静默风险。备选方案 B（一并迁移）如用户裁定则扩展本轮范围。escalate.mjs:4 头注释同步修正。

### 4.3 D-06 single-flight

模块级在飞表（**复合键 `sessionId + mechanism`**，每机制独立单飞槽位——同会话 advisor 在飞不阻塞 escalate/eng 派发，反之亦然，对齐 US-4/N-3 的 per-session-**per-mechanism** 语义）；advisor + 迁移后的 escalate/eng codex 派发前检查，命中 → 拒绝并告知在飞 job id 与接续方式；settle 时清除。

### 4.4 D-10 代际检查

`sessionState.advisorGeneration`（整数，随 F12 视图持久化）；eng 交付重置、F11 类型切换、config apply-session 变更时 **+1**；job 派发时捕获代际，finalize 应用前校验——不匹配 → 丢弃变更 + 完成通知注明「状态代际已变更，本轮结果不并入（原文可读）」。

### 4.5 D-05 / D-11 / D-14 / D-16 / D-22

- **D-05**：`started` 即 branded string，直接使用；测试 fake 改返回 string（消除掩蔽，审计 N26）。
- **D-11**：同步截断杀路径的返回文本加回滚指引（「半途写入可能残留：对照 partial 输出与 Touched 提示检查工作区，必要时 git 回滚」）+ partial 内 Touched 行作 advisory 解析；启动清扫：插件启动时扫描 `tmpdir()/thincoder-codex-*` 陈旧目录（>24h）删除 + warn；进程级清扫因无可靠属主标记列为文档化边界（宿主硬死孤儿 = B9 边界保持）。
- **D-14**：adapter 维护全局活跃 codex 子进程计数，上限 `codexCli.maxConcurrent`（默认 8，设置页可配）；超限 fail-fast 并明确报错（不排队——简单诚实）。
- **D-16**：mitigation 收口——钳制告警（已有）+ 设置页提示（已有）+ 派发时若 `budgetCapMs ≥ 600000` 输出一次不变式提醒（「确认已同步提高平台 maxWallMs 且 cap < wall」）；登记表标注不可完全强制。
- **D-22**：`codexFailureCount` 会话销毁清理（挂到既有 session/disposed 清理组）；consult 子代理 run 补 dispose；`cleanCwdRoot` 死旋钮删除（消费点与注释一并清）。
- **R2 附带观测**（供 D-15 与 maxWallMs 留证）：adapter 退出时记录本次运行最大静默间隙（lastActivityAt 差分最大值）到诊断/warn。
- **R1 code review 🔵 折入**：① escalate effort-note 前缀统一为 `\n\n[thincoder-suite]`（与其余消费点对齐）；② advisor codex 行的 `resolveCodexCliGlobals` warnings 并入 `route.warnings`（手编 config 非法 codexCi 值运行时同样响亮告警）。

### 4.6 R2 受影响文件

`lib/advisor.mjs`、`lib/escalate.mjs`、`lib/eng.mjs`、`lib/consult.mjs`（dispose）、`lib/index.mjs`（清理组接线）、`lib/codex-adapter.mjs`（计数/观测/死旋钮）、`lib/config-store.mjs` + `lib/client.js`（maxConcurrent 字段）、`lib/session-store.mjs`（generation 白名单）、`test/codex-runner.test.mjs`

### 4.7 R2 验收标准

1. 迁移路径单测（假 jobs）：escalate/eng codex 预算 >cap → 派发、簿记在 done 内成功分支恰好一次、句柄文本含接续指令；followup 预算用例；
2. single-flight 用例：在飞时二次调用被拒并含 job id；
3. 代际用例：派发后 generation 变更 → finalize 丢弃 + 通知注明；
4. D-20 用例：失败交付不重置轮次/不置 mutated；
5. job id 真实渲染（fake 返回 string）；D-09 文本修正断言；
6. 全局并发上限 fail-fast 用例；启动清扫用例；D-22 三项卫生用例；
7. dsh 路径（DP-1 方案 A）截止告警用例；
8. **US-3 token 截断存活性回归**：模拟 job_output 保尾截断（头部丢弃 + [output truncated] 标记）→ 尾部 design token 完整可提取——钉死平台 retainTail 契约（用户故事-测试映射补全）。

## 5. R3 — 回落与失败语义完备化

### 5.1 D-07 回落封顶（D-裁决-3）

- `codexFailureCount.delete` 移到**回落轮结果之后**（修正 :1015 顺序错误）；
- 新增 `fallbackFailureCount`（会话内存态）：回落轮失败 +1、成功清零；
- **连续 2 次回落失败 → 硬停**：返回「双路由皆不可用」+ 配置诊断（codex 路由与 dsh 路由各自状态、最近失败码、修正指引：网络/代理/runner 切换/provider 检查）；
- 失败序列封顶：`codexFailStreak + fallbackFailStreak` 独立于 advisorRound 计数，任何组合的零进度循环在硬停处终止。

### 5.2 D-01 重试与分类（D-裁决-1）

- 空响应（R1 分类为非基础设施形态）→ **自动重试一次**（复用 messages，同 stall 重试通道语义但独立计数）；再空 → 返回 **"Advisor:" 前缀**的可归因失败（分类 + 观测字段 + 「重试一次仍空」），不烧轮次、不写 prior（现状空响应会被当 completed 烧轮次——一并修正）；
- 分类为基础设施形态（error 无 message / stall）→ 走既有失败路径，不空重试。

### 5.3 D-19 prior 纯净化

finalize 区分 `body`（评审正文）与 `body + 机制性后缀`（回落告警/effort note/截断提示）：`lastAdvisorOutput` 只存 body；返回文本照常带后缀（可见性不变）。收敛轮 prior 注入因此不再携带插件杂讯。

### 5.4 R3 受影响文件与验收

文件：`lib/advisor.mjs`、`test/codex-runner.test.mjs`。
验收：① 活锁封顶用例（codex 败×2 → 回落败×2 → 硬停文本含双路由诊断）；② delete-after-result 顺序用例；③ 空响应重试一次→仍空→前缀失败不烧轮次用例；④ 重试后成功不重复计轮用例；⑤ prior 纯净用例（后缀不进 lastAdvisorOutput）。

## 6. R4 — 一致性与 UX 收口

### 6.1 D-12 保存竞态（UI 决策 UI-3）

busy 期间禁用全部表单输入（非仅按钮）；保存成功后的 refreshView **不整体替换草稿**——只重放未被用户触碰（自保存发起时起）的字段，触碰字段保留用户值并出提示条「保存期间有编辑，已保留你的修改」。

### 6.2 D-13 override runner 三面同步

方向：**全面接受**（apply-session 已接受）——`ADVISOR_OVERRIDE_GROUP_PATHS` + `advisor_config` coercion 增加 runner（校验走 `normalizeRunnerValue`）；session-store 持久化白名单加 runner；client.js:726 注释修正。往返用例：set runner → 模拟重启恢复 → 仍在。

### 6.3 D-15 idle 档位测量（测量任务，非代码修复）

消费 R2 的最大静默间隙日志：真机跑 ≥3 次高 effort codex 任务，若健康流出现 >240s 静默间隙 → 建议 idleTimeoutMs 默认上调或 effort 感知（数据登记入研究文档附录，默认值是否改动由数据说话）。

### 6.4 D-24 + 收尾

eng.mjs 独立 code review 补跑（advisor type=code，两轮环境阻塞的欠账）；全部登记条目状态核对；METHODOLOGY 文档历史记入 R0-R4；版本号推进至 0.8.0。**R1 审计 🔵 遗留收口**：① per-point fail-open（元数据缺失）补 1-2 个接线级用例（或接受 resolver 级覆盖并记录）；② 登记表 D-02 用例数 17→19 更正；③ 登记表 D-18「TIMEOUT 信封补 usage」措辞收窄（仅 idle-watchdog 信封带结构化 usage，墙钟信封在诊断串内——设计 §3.2 本就只要求诊断）；④ `discoverCodexModels` 缓存无 refresh 通道（R1 评审 #3）——加 refresh 参数或注释缓存语义。

### 6.5 R4 受影响文件与验收

文件：`lib/client.js`、`lib/advisor.mjs`、`lib/session-store.mjs`、`lib/index.mjs`（如 coercion 共享）、`test/codex-runner.test.mjs`、`METHODOLOGY.md`、`package.json`。
验收：① 竞态用例（保存期间编辑被保留 + 提示）；② runner 往返用例；③ 测量数据登记；④ eng.mjs 评审报告落档；⑤ 登记表全条目终态核对。

## 7. UI/交互决策汇总（METHODOLOGY 要求集中呈现）

| # | 决策 | 轮次 |
|---|---|---|
| UI-1 | effort 下拉全部目录化：dsh 行按行 provider+model 取 /catalog 档位；codex 行取 codex catalog；engCard 补模型上下文。**〔2026-09-05 实施裁决〕engCard 上下文来源**：codex 后端 → CodexEffortInput 随 codexCli.model 联动（真实目标模型）；dsh 后端 → dsh 目录档位并集（目标=父代理路由，设置页不可知；运行时 L1 兜底） | R1 |
| UI-2 | 后台派发返回文本 = job 句柄 + 「等完成通知再继续；勿用 job_output wait 阻塞等长任务」显式指令 | R2 |
| UI-3 | 保存期间全表单禁用；保存后草稿不被未触碰字段的刷新覆盖，触碰字段保留 + 提示条 | R4 |
| UI-4 | 设置页新增 `codexCli.maxConcurrent` 字段（默认 8，提示全局 codex 进程上限） | R2 |

## 8. 设计决策点（评审时请用户裁定）

| # | 问题 | 推荐 | 备选 |
|---|---|---|---|
| DP-1 | D-21 dsh 子代理路径处置 | **方案 A：本轮钳制告警，jobs 迁移另立项**（协议级重构超治理范畴；历史无 >600s 死亡记录） | 方案 B：一并迁 jobs（工程流程协议改为通知驱动，范围显著扩大） |
| DP-2 | 最近支持档等距 tie-break | **向上取**（保推理质量：medium 缺失取 high） | 向下取（保成本） |
| DP-3 | 全局 codex 并发上限默认值 | **8**（consult 5 + advisor job 1 + 余量；可配） | 更保守 6 / 更宽 10 |

## 9. 验收标准（项目级，映射需求 §5）

1. 登记表 D-01…D-24 全条目终态 ∈ {已修, 已裁决处置, 已驳回(附证据), 待测量(附数据)}；
2. 单测全绿且每修复 ≥1 回归用例（R1-R4 各节验收条款即用例清单）；
3. 真机验证：advisor（jobs 派发 + 回落链 + token 签发）、eng_coder（一次交付）、escalate（含 followup）、consult（含 codex 行）各一次成功；复测「空响应」「effort 秒死」两受害场景（前者给出可归因诊断或重试后成功；后者不再秒死）；
4. git：R1-R4 每轮独立提交 + 版本 0.7.0→0.8.0 推进 + 文档登记与 METHODOLOGY 历史记入。

## 10. 风险与边界

- **宿主硬死孤儿**（B9）：jobs 只护优雅销毁；R2 的启动清扫缓解陈旧目录，进程级清扫无可靠属主标记——保持文档化边界。
- **maxWallMs 绑定路径未在平台源码钉死**：设计依据 = 本插件 D.1 实测 + 两会话 15+ 次同形截断；R2 钳制告警本身不依赖该绑定成立（绑定不成立时钳制只是多余但无害）。
- **DP-1 方案 A 的残余风险**：eng dsh 超长轮（>600s）在钳制下被终止——数据不足以下结论迁移必要性，钳制 + 告警 + 观测是本轮诚实边界。
- **平台契约依赖**：jobs 契约五条由审计钉死于当前部署版本；DSH 升级若变更契约，登记表「平台契约要点」需复核。
