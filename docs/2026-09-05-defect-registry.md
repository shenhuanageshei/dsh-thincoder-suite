# 缺陷登记表：dsh-thincoder-suite 机制缺陷治理

- 日期：2026-09-05（thorough 审计定稿，审计子代理报告全量合并）
- 状态：LIVING（随修复轮推进更新 status）
- 证据基线：git `e4aae98`，全部 file:line 已按当前工作树核对
- 图例：风险 🔴 阻塞级 / 🟡 重要 / 🔵 次要；状态 待修 / 修复中 / 已修 / 已裁决处置 / 已驳回 / 待测量
- 轮次：R1 诊断与校验层 / R2 执行架构与进程 / R3 回落与失败语义 / R4 一致性与 UX 收口（轮次定义见设计文档）

## 登记表

| ID | 主题 | 现象（一句话） | 根因状态 | 证据 | 风险 | 轮次 | 状态 |
|---|---|---|---|---|---|---|---|
| D-01 | 失败语义 | advisor dsh 空响应不可诊断：两种形态坍缩为同一句文案（finish===null / stop 零块），finish.reason 从不记录；空响应不重试、不进任何计数 | 已定位 advisor.mjs:779（审计修正：坍缩形态实为 2+1，error-无-message 有独立路径但同样无归因）。**2026-09-05 生产复现 ×2**：① glm-5.3/max；② deepseek-v4-pro/high——跨模型复现指向结构性根因：LLM_MAX_TOKENS=8192（advisor.mjs:57 硬编码）在推理阶段耗尽 → finish=length 零文本块 → 代码不检查 length 落入坍缩路径（finish.kind 无记录，推断待 R1 观测证实） | 🔴（升级：两次阻塞设计评审→阻塞 token 签发→阻塞实施链） | R1 观测 + R3 重试/分类（D-裁决-1）；修复应含 finish=length 显式分类、maxTokens 不足的独立诊断、**maxOutputTokens 可配置化**。〔2026-09-05 用户授权热修：LLM_MAX_TOKENS 8192→16384 一行（工程模式例外，留痕于此）；R1 正式化〕 | 待修（热修已落地，正式修复在 R1） |
| D-02 | 能力校验 | effort 校验漏点实为矩阵级：consult:165 / escalate:207 裸传；eng:399 codex 用原始值且 :385 按父模型解析（对 codex 无意义）；全部 codex 行无 L1（catalog 数据存在但从未用作校验源）；effort-resolve.mjs:6 「四点同修」注释为假 | 已定位（消费点×层矩阵见审计 §4，9 行中 6 行 GAP） | 🔴 | R1（D-裁决-2 最近支持档） | 待修 |
| D-03 | 执行架构 | eng_coder codex 路径完全无钳制无告警：默认 30min 预算在 600s 墙钟下静默死亡 | 已定位 eng.mjs:402-411 | 🔴 | R2（jobs 迁移） | 待修 |
| D-04 | 执行架构 | escalate followup 绕过 budgetCap：runner.timeoutMs ?? 600000 = 零余量撞墙 | 已定位 escalate.mjs:101 + adapter:506 | 🔴 | R2 | 待修 |
| D-05 | 执行架构 | jobs 派发 job id 恒显 "?"：平台 start 返回 branded string，插件取 .id 落空；测试 fake 返回对象掩盖本缺陷 | 已定位 advisor.mjs:1072；平台 dsh-jobs-local/lib/index.js:176 `return id`。**2026-09-05 生产复现**：本次设计评审派发返回 "background job ?" | 🟡 | R2 | 待修 |
| D-06 | 并发安全 | advisor 后台评审无 single-flight：同会话二次调用照派第二个 job，双 finalize → 轮次双增、prior 踩踏 | 已定位（无 in-flight map；平台 10/owner 上限不是替代） | 🔴 | R2 | 待修 |
| D-07 | 回落自愈 | 回落活锁：计数在回落**开始前**清零（:1015）；失败不推进 advisorRound → MAX_ADVISOR_ROUNDS 对失败序列完全失效，codex↔dsh 无界交替 | 已定位 advisor.mjs:1015/:942 | 🔴 | R3（D-裁决-3 连败 2 次硬停） | 待修 |
| D-08 | 评审协议 | ~~design token 尾部截断丢失~~ **已驳回**：平台截断为保尾语义（retainTail），token 位于尾部反而安全；相邻真缺陷是 D-09 | 已驳回（dsh-tool-jobs/lib/index.js:100-107 TextRetainer kind:"tail"） | — | — | 已驳回（US-3 改为回归测试钉死该平台保证） |
| D-09 | 评审协议 | 派发文案谎称「通知含评审全文」——平台完成通知只含一行指针，全文必须 job_output 读取 | 已定位 advisor.mjs:1074 vs dsh-tool-jobs:116-132。**2026-09-05 生产复现**：本次派发返回文本即含该虚假承诺 | 🟡 | R2 | 待修 |
| D-10 | 并发安全 | 晚到的 job finalize 复活已重置状态：无代际/版本检查，40min job 完成于 eng 交付重置之后会覆写 advisorRound/prior | 已定位 advisor.mjs:934-986 vs eng.mjs:415-422 | 🔴 | R2 | 待修 |
| D-11 | 进程卫生 | 写任务截断杀 = 半途编辑残留 + 无术后报告 + touchedFiles 丢失（partial 无 Touched 行）；jobs 迁移只护优雅销毁路径，宿主硬死孤儿仍在 | 已定位 adapter:626-635 + 硬死无 dispose | 🔴 | R2（告警+指引+清扫；硬死边界文档化） | 待修 |
| D-12 | 设置页 UX | 保存竞态：busy 只禁按钮，表单可编辑；成功后 refreshView 整体替换草稿，保存期间编辑被静默覆盖 | 已定位 client.js:697/:552 | 🟡 | R4 | 待修 |
| D-13 | 配置一致性 | advisorOverride.runner 三面不对称：apply-session 接受、advisor_config 工具拒收、持久化白名单丢弃（重启即失）；client.js:726 注释与事实相反 | 已定位 advisor.mjs:84 / index.mjs:283-286 / session-store.mjs:84 | 🟡 | R4 | 待修 |
| D-14 | 进程卫生 | codex 全局并发无准入控制：consult ≤5 仅 per-consult，多机制叠加可 6+ 进程 | 已定位（缺失） | 🟡 | R2 | 待修 |
| D-15 | 进程卫生 | idle 300s 默认值无健康流证据（研究文档附录的停滞都是网络退化；240s 是选择不是测量） | 未定位（需测量） | 🔵 | R4（测量任务） | 待测量 |
| D-16 | 执行架构 | budgetCap < maxWallMs 不变式只在文档：插件读不到 maxWallMs，运行时无检查无警告 | 已定位（平台唯一消费者 dsh-code-runtime-worker-thread:651/:919，无注入面） | 🟡 | R2（ mitigation：钳制时警告已有 + 设置页提示已有 + 不变式文档化；标注为不可完全强制） | 待修 |
| D-17 | 执行架构 | advisor dsh 主路径 + 回落轮 timeoutMs 不钳制（最高 3.6M），与 codex 路径不对称 | 已定位 advisor.mjs:1023/:1119 | 🟡 | R1 | 待修 |
| D-18 | 失败语义 | 结构化观测缺失三件套：finish.reason / usage（codex 捕获了但从不上浮）/ blocks 计数；stderr 只留头部 4K（可用错误通常在尾部）；exit code 单独依赖 | 已定位 | 🟡 | R1 | 待修 |
| D-19 | 评审协议 | 成功路径后缀污染 prior：回落告警/effort note 拼进结果 → 存入 lastAdvisorOutput → 污染下一轮 prior 注入 | 已定位 advisor.mjs:1028/:1124→:941 | 🟡 | R3 | 待修 |
| D-20 | 评审协议 | eng codex 失败路径仍执行交付簿记：重置轮次/置 mutatedThisRun/合并 touched——失败交付销毁评审预算并断言了可能不存在的变更 | 已定位 eng.mjs:413-422 在 ok-check 之前 | 🟡 | R2 | 待修 |
| D-21 | 执行架构 | escalate/eng 的 **dsh 子代理路径**回合内无界等待（escalate:220 / eng:460 await run.result）；escalate.mjs:4 头注释「无墙钟」与平台事实矛盾 | 已定位 | 🔴 | R2（处置方案见设计文档 DP-1：clamp+warn，jobs 迁移另立项） | 待修 |
| D-22 | 进程卫生 | 卫生批：codexFailureCount 会话销毁不清理；consult 子代理 run 从不 dispose；无孤儿启动清扫；cleanCwdRoot 死旋钮（消费但无处可设） | 已定位 | 🔵 | R2 | 待修 |
| D-23 | 工程过程 | 版本 0.1.0 未锚定；文档-代码漂移标记 4 处（escalate:4 / advisor:1074 / client:726 / effort-resolve:6）；测试缺口（fake jobs.start 掩盖 D-05、single-flight/并发 finalize/eng codex 超限/followup 预算/runner 持久化往返零覆盖） | 已定位 | 🔵/🟡 | R1（版本+注释漂移）+ 随各缺陷回归用例 | 待修 |
| D-24 | 工程过程 | eng.mjs 从未经独立代码评审（两次环境阻塞）——评审欠账 | 已定位 | 🔵 | R4（补跑） | 待修 |

## 已核清的非缺陷（审计确认，无需修复）

- **settings.yaml 剩余消费点**：文件读取只剩 profile-root 探测标记（dsh-home.mjs:37）；服务级读取（llm-pi-ai）为有意的分层富化源——数据源漂移问题整类清零（原 D9 收口）。
- **consult 跨回合免疫**（N5）：startConsultChild fire-and-forget，回复在后续回合读取——jobs 迁移判据下无需迁移（需求 N-1 已固化此判据）。
- **advisor/codexCli 组字段三面白名单**：PUT = merge = 运行时解析，同步无漂移（漂移仅在 D-13 的 override runner 一处）。

## 平台契约要点（设计依据，审计 Task C 钉死）

1. `jobs.start(spec)` 返回 **branded string** `<kind>-N`（非对象）；每 owner 活跃上限 10；run() 内**无墙钟**（jobs 免疫 600s）。
2. 完成通知**只含一行指针**（bounded），永不含输出全文；全文经 `job_output` 读取，读取截断为**保尾**语义；原始输出在 registry 中不截断。
3. cancel → hooks.cancel → 插件 ctrl.abort → killTree；owner/session 优雅销毁会 cancel+await；**宿主硬死无任何 dispose**（B9 边界保持）。
4. `job_output wait:true` 平台侧上限 600s（与墙钟同值竞速）——等长 job 必须事件驱动接续。
5. maxWallMs 对已注册插件工具 execute() 的精确绑定路径未在平台源码中钉死（唯一实现于 dsh-code-runtime-worker-thread）；经验事实（本插件 D.1 实测 600s 截断 + 两个会话 15+ 次同形截断）作为设计依据，R2 加断言观测留证。
