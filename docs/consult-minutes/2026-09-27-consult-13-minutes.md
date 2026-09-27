# 会诊纪要 —— consult #13（原始层，机制落盘）

- 日期：2026-09-27
- 会诊 id：13
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, oc-go:mimo-v2.6-pro, codex-cli:gpt-6-astra
- 平台 job：consult-1
- 结果：0/5 交付（其中 0 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #13 finished — 0 of 5 replied (5 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #13 finished — 0 of 5 replied (5 failed)]
effective: 0 of 5 (5 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, oc-go:mimo-v2.6-pro, codex-cli:gpt-6-astra
job: consult-1
minutes: docs/consult-minutes/2026-09-27-consult-13-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] kimi-api:kimi-k3 — failed
(consultation failed: child ended: error)

[2] zai-coding-cn:glm-5.3 — failed
(consultation failed: child ended: error)

[3] oc-go:mimo-v2.6-pro — failed
(consultation failed: child ended: error)

[4] deepseek-official:deepseek-v4-pro — failed
(consultation failed: child ended: error)

[5] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）

[thincoder-suite] model "gpt-6-astra" 未命中 codex 模型目录（5 个模型）——effort "high" 原样透传 (fail-open))
```

## §2 逐问裁定（**主代理写**）

本次 digest 为**墓碑**（`0 of 5 replied (5 failed)`）⇒ **无任何意见可采纳**。逐条处置如下（每条恰一条）：

| # | 模型 | 结果 | 处置 |
|---|---|---|---|
| 1 | `kimi-api:kimi-k3` | failed（child ended: error） | **不采纳（无内容）**：零输出，无意见可评估 |
| 2 | `zai-coding-cn:glm-5.3` | failed（同上） | **不采纳（无内容）** |
| 3 | `oc-go:mimo-v2.6-pro` | failed（同上） | **不采纳（无内容）** |
| 4 | `deepseek-official:deepseek-v4-pro` | failed（同上） | **不采纳（无内容）** |
| 5 | `codex-cli:gpt-6-astra` | failed（PROCESS_ERROR） | **不采纳（无内容）** + 附**配置面**根因：插件已 warn `model 'gpt-6-astra' 未命中 codex 模型目录（5 个模型）` ⇒ 该行在**当前池配置下必然失败** |

**父侧影响**：无。批 30 的范围裁定（用户选 **B+**）与设计草案**不依赖**本次会诊结论——它建立在本批两条**只读取证**（带平台源码坐标，见 `docs/dsh017-batch30-design.md` §2.0）之上。

## §3 分歧与父侧裁定（**主代理写**）

- **分歧**：无（零内容 ⇒ 无分歧可裁）。
- **父侧裁定**：① 批 30 按已定 **B+** 范围与 §4 工单排序推进；② 会诊**重试一次**（同一 brief），以区分「系统性故障」与「瞬时故障」；③ 失败根因**另派只读溯源**，结论落 `docs/dsh017-batch30-design.md` §2.0 与登记表。

## §4 教训（**主代理写**）

1. **池配置面**：`codex-cli:gpt-6-astra` 不在 codex 模型目录（5 个）内 ⇒ 该行**每次都会失败**；池子应剔除或改名（配置属用户面，本档只如实登记，不代改）。
2. **真根因（已钉死，**推翻**本档初写的『toolFilter 名域』假设）**：4 个不同 provider 同因失败，**与模型无关**，也**不是** `toolFilter` 名域缺陷（形态判据：`restrict` 在 setup 抛错 ⇒ `ctx.subagents.start` **reject**，而 `child ended: error` 只能来自**已发布 run 的 resolve**）。落盘铁证（子会话 `turn/end` seq 7）：`invalid session reference URI "dsh-session:483-499": Unexpected token '\uFFFD'` —— 平台的会话引用解析器把**裸文本 `dsh-session:483-499`** 当成 canonical URI 去 base64url 解码 ⇒ `JSON.parse` 抛 ⇒ `agent/pre-step` 抛出 ⇒ 整回合以 `reason.kind="error"` 结束 ⇒ in-process driver 映射成 `stopReason:"error"`（**不带 diagnostic**）⇒ 插件渲染成 `child ended: error`。
3. **那个 token 的来源是主代理自己的书写**：会诊把「Main Session History」（近期对话）注入子会话 prompt，而**我在近期消息里用了 `dsh-session:483-499` 这种「包名:行号」简写**（指 `dsh-session` 包的第 483-499 行）⇒ 与平台的会话引用语法**撞车**。⇒ **纪律**：文件:行引用**必须带后缀路径**（`dsh-session/lib/types/index.js:483-499`），**绝不用 `<pkg>:<行号>` 的裸简写**。同批文本 4 处命中（`483-499`×3、`526-529`×1）。
4. **连带的观测缺陷**：子会话失败时插件只显示 `child ended: error`（in-process 腿不带 diagnostic），**digest 遮蔽了真正原因**；codex 行同理——插件只显示 `env.userMessage`，**遮蔽 diagnostics**（exit code / stderr），现场只在 codex 自己的 rollout 里。
5. **codex 行的真因**（不只是目录未命中）：codex rollout 末行 `task_complete` 报 `"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."` ⇒ **模型与账号类型不匹配**（配置面），目录未命中只是同一配置缺陷的表征。
6. **方法论**：`child ended: <stopReason>` 这类**坍缩过的字符串**不能当诊断面；溯源必须走**子会话落盘日志 + 平台源码链 + 本地最小复现**三条腿（本次即如此互证）。
3. **方法论**：会诊本身没有「失败可见性」以外的诊断面（digest 只有一行 `child ended: error`）⇒ 追溯必须走**平台源码 + 插件 settle 映射**两条腿。

## §5 不可验清单（**主代理写**）

- **已确证**（溯源 + 子会话落盘 + 本地解码复现三者互证）：真因 = 注入历史里的裸 `dsh-session:483-499` 触发平台会话引用解析器抛错 ⇒ 整回合 error。**初写的「toolFilter 名域」假设已推翻**（形态判据见 §4 第 2 条）。
- **仍未确证**：① 父会话那条消息的 `source` 字段未直接读到（「为何父会话不炸」是依据 `prepareDirectMessages` 只处理 `kind==='user'` 的推断）；② consult #14 的子会话失败形态**不同**（`400 server_error: Streaming response failed: [400] Invalid request parameters`），成因未查；③ 未做端到端复现实验。
- **未验证**：4 个 DSH 行是否**同一根因**、是否**每次都失败**（单次样本）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-27 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-27 | 主代理补写裁定层（§2–§5）：墓碑 digest，5/5 失败 ⇒ 零意见；尽数「不采纳（无内容）」；裁定批 30 照 B+ 推进 + 会诊重试一次 + 另派只读溯源 |
