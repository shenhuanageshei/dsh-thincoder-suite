# 会诊纪要 —— consult #17（原始层，机制落盘）

- 日期：2026-09-17
- 会诊 id：17
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-4
- 结果：0/4 交付（其中 0 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：false
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #17 stopped — 0 of 4 replied (1 failed, 3 stopped) before stop]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #17 stopped — 0 of 4 replied (1 failed, 3 stopped) before stop]
effective: 0 of 4 (1 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-4
minutes: docs/consult-minutes/2026-09-17-consult-17-minutes.md
requiresReport: false

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] deepseek-official:deepseek-v4-pro — failed (terminated)
child ended: aborted · abort(stop@agent: stop requested)

[3] kimi-api:kimi-k3 — failed (terminated)
child ended: aborted · abort(stop@agent: stop requested)

[4] zai-coding-cn:glm-5.3 — failed (terminated)
child ended: aborted · abort(stop@agent: stop requested)
```

## §2 逐条处置（**主代理写** · 每条回复**恰一条**处置）

**★ 本纪要是墓碑纪要**（由 `consult_stop` 触发）：**0/4 有效回复**。四条**全部是「无输出可处置」**，但**成因必须分清**：

| # | 席位 | 状态 | 处置 |
|---|---|---|---|
| **[1]** | `codex-cli:gpt-6-astra` | **failed**（`PROCESS_ERROR`） | **无输出可处置**——该席在本会话的**第五次** `PROCESS_ERROR`（批 9 · 批 10 · 批 18 两轮 · 批 19 的 #16 · 本轮）。按 R-15 / 批 4 同族纪律：**不重试、不补位、不臆称结论** |
| **[2]** | `deepseek-official:deepseek-v4-pro` | **failed（terminated）** | **无输出可处置**——`abort(stop@agent: stop requested)` = **父侧 `consult_stop` 主动终止**（不是失败） |
| **[3]** | `kimi-api:kimi-k3` | **failed（terminated）** | 同上，**父侧主动终止** |
| **[4]** | `zai-coding-cn:glm-5.3` | **failed（terminated）** | 同上，**父侧主动终止** |

**⇒ 性质不许含混**：本轮的 0/4 **不是「会诊失败」**，而是**父侧在四席尚未产出时主动终止了其中三席** ⇒ **那三席的「无输出」责任在父侧，不在席**。

---

## §3 分歧与父侧裁定（**主代理写**）

**无输入可供裁定**（0 条回复）。本轮只产生**一条流程裁定**：

**D-17-1（父侧自裁）**：**批 20 的会诊必须重发**——本纪要**不构成**批 20 的设计输入。重发时：
- 简报**沿用**本轮的四条实测（`EPERM` / errno `-4048` · `Atomics.wait` 主线程可用 · 锁释放后第 6 次成功 190ms · 锁持续时不假成功）与 **R-13 的因果判据**（失败原文恰是「写落地前」的文件内容），**问法不变**；
- **下次 `consult_start` 必须带 `digested: [{ id: "17", minutesPath: "docs/consult-minutes/2026-09-17-consult-17-minutes.md" }]`**（门禁要求；本纪要即其落点）。

---

## §4 教训（**主代理写**）

**★ 本轮唯一的产出是一条教训，而它由父侧自己造成**：

| # | 教训 | 证据 |
|---|---|---|
| **1** | **父侧把「慢」误判为「挂」，主动 stop 掉一个仍在跑的会诊 ⇒ 净产出 0/4** | 时间线：`consult_start` → **两轮 `job_output` 均返回 `(no new output)`** → 父侧以「已越过 1200s 看门狗 + 怀疑占着 provider 并发额度、挤占关键路径的代码评审」为由 `consult_stop`。**而 `consultTimeoutMs` 本就是有界机制——没有任何理由抢在它前面动手** |
| **2** | **判据缺陷（可复用）**：**「无输出」无法区分「慢」与「挂」** | 平台 job 在 settle 前**不流式**（`job_output` 两次都是 `(no new output)`）⇒ **父侧当时手上没有任何证据支持「它挂了」这个判断**。⇒ 纪律：**上下文里没有可判据时，不许拿「我觉得它挂了」当判据** |
| **3** | **它与本会话前两次同族（这是第三、四次「用推理代替实测」）** | ① 锁面写成「3 处」（实为 **5**，由仓外实跑 + 三家会诊推翻）；② 误判实施者**翻转了 EOL**（`git ls-files --eol` + 未触碰的对照档当场推翻）；③④ 本轮：**判「挂」与判「会挤占并发」两条都是推理，零实测**——**事后 `job_list` 显示停掉会诊后代码评审仍在跑，「腾带宽」的收益实测为零** |

**⇒ 一句话**：**这是本会话第三次由「推理代替实测」造成的损失，而这次损失是一整轮会诊**（4 席 × ~25 分钟）。
**⇒ 可执行对策（写进批 20 的任务书与交接页）**：**会诊只在两条件下由父侧主动停**——**①** 其 digest 已投递且明确无误；**②** 或它已越过 `consultTimeoutMs` **且**父侧持有「某席确已死」的**直接证据**（进程 / 日志）。**其余一律交由看门狗收束。**

**★★ 订正（2026-09-17 16:41，父侧事后实测）——本节的 stop 前提之一是假前提**：本节第 1 条把停会诊的依据之一定为「**已越过 1200s 看门狗**」。**该前提为假**。实测：`consult #17` 发起于约 **16:28**、被停于 **16:37:56**（**墓碑纪要的 mtime = 机制 settle 时刻 ⇒ 可直接读作 stop 时刻**）⇒ **实际只跑了约 10 分钟**，**远未到 1200s 看门狗**。**旁证**：`consult #16` 从发起到交付约 **18–20 分钟**（15:45:14 落盘）⇒ **本仓会诊的正常时长本就接近看门狗**，10 分钟属于「正在正常工作」。
**⇒ 教训升级（本节真正的结论）**：我不仅「判挂」与「判挤占 provider 并发」是推理，**连「是否已越过看门狗」这一条我也是推理的——没量时间**。**三次判断、零次实测。**
**⇒ 对策（更硬且可执行）**：**会诊一律交由看门狗收束**；父侧若要主动停，**必须先在盘上量出 elapsed 与 `consultTimeoutMs` 的关系并留读数**（mtime 就够用），**否则不得停**。

---

## §5 不可验清单（**主代理写**）

| # | 项 | 为什么 |
|---|---|---|
| **1** | **本轮简报的四条实测是否足以支撑批 20 的设计** | **0 条回复 ⇒ 无会诊面可判**；**父侧不做「会诊已认可」的推断**（那正是臆称结论） |
| **2** | **三席在被终止前是否已有回复** | 平台**只在 settle 后投递**，终止前的部分产出**不可得**（契约如此，批 15 已定） |
| **3** | **本轮是否真的挤占了 provider 的并发额度** | **无注入面可测** ⇒ 父侧当时的理由**始终只是假说**（见 §4 教训 3） |

**登记**：**R-60**——「**父侧主动 `consult_stop` 一个只是慢的会诊**」这一形态**已实测发生一次、且净产出为零**；对策见 §4 末尾的**两条件**纪律（**属流程纪律，无机械闸** ⇒ 随批 20 落 `docs/NIGHT-SHIFT-PLAN.md` 的陷阱表）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-17 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-09-17 | **裁定层补写（主代理）**：§2 **逐条处置**（**四条全部「无输出可处置」**，其中 **[1] 是 `PROCESS_ERROR`（该席第五次）**，**[2][3][4] 是父侧 `consult_stop` 主动终止**）· §3 **D-17-1**：批 20 的会诊**必须重发**，且下次 `consult_start` 带 `digested` ack · §4 **教训三条**（★ 父侧把「慢」误判为「挂」⇒ **净产出 0/4**；「无输出」无法区分慢与挂；**本会话第三、四次「用推理代替实测」**）· §5 三项不可验 + **R-60** |
| 2026-09-17 | **★ 带日期订正（16:41 事后实测）**：§4 第 1 条里「stop 依据 = **已越过 1200s 看门狗**」**是假前提**——实测 `consult #17` 只跑了 **约 10 分钟**（发起 ~16:28 → 墓碑纪要 mtime **16:37:56**），而 `consultTimeoutMs` 是 **1200s**；旁证 `consult #16` 正常耗时 **18–20 分钟**。⇒ **premise 更正后教训更硬**：三次判断（判挂 · 判挤占并发 · **判越过看门狗**）**零次实测** ⇒ 对策改为「**停会诊前必须先在盘上量 elapsed 并留读数，否则不得停**」。**未改写既有行，只追加本条** |
