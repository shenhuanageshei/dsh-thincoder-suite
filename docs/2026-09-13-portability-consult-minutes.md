# 批 7（可移植性三件）会诊纪要 —— 2026-09-13

> **用途**：本档是批 7 需求档/设计档的**设计输入**。会诊结果落档纪律（含分歧与父侧裁定）见交接页 §2。
> **任务**：① `METHODOLOGY.md` 从**产品提示词**退役；② 产品提示词去本仓指涉；③ **判据单一权威**。

---

## §0 会诊汇总

| 模型 | 结果 | 关键贡献 |
|---|---|---|
| `deepseek-official:deepseek-v4-pro` | ✅ 交付 | 逐处新措辞（19 处全覆盖）；指出 `ENGINEERING-MODE.md` **本仓不存在**（上游悬空名）；`injectDocumentMap` 今日恒不生效；**WRITE_GATE_FIXTURE 字节冻结**耦合警示 |
| `zai-coding-cn:glm-5.3` | ✅ 交付 | **代数级定性**（矛盾 = 一个共享子问题被实现两遍）；`^src/` 删除是**删死代码而非收紧**的论证；提 `src/*.md` 与 `packages/app/src/a.md` 两类；`.thincoder/` 写入门禁边角 |
| `codex-cli:gpt-6-astra` | ✅ 交付 | 「两份不同语义被误当同一副本」的立场；`docs/**` 即使 `.mjs` 也归文档；判据识别需任意层级路径段 |
| `kimi-api:kimi-k3` | ✅ 交付 | **形式化代数**（`isProductCode = ¬D∧(S∨¬E)`、`isDocFile = D∨E` ⇒ 唯一矛盾类 = 根 `src/` + 文档扩展名）；7 行真值表；`docs/` 归属以**约定登记**而非代码扩展名清单 |

**四家一致的三条**：① 退役 = **逐处改写（维度不删、只改判据来源）**，不是整段删除；② 判据单一权威 = 新建**零依赖叶模块**、`isProductCode` 变**纯补集派生**、`^src/` **删分支而非收紧**；③ 本仓**无** `check-doc-width`/`check-ledger` 等价物可删（实测零命中）⇒ 该项以「证据闭案 + 加锁」处置。

---

## §1 父侧前提纠错（**四家中有三家独立指出**，父侧已回盘实测）

> **父侧纪律**：勘察错误必须落档（对齐批 6 §0.2）。本表即留痕。**这四条全部出自我凭代码阅读推断、而没有实际运行谓词**——正是本仓反复吃过的同一类病。

| # | 父侧会诊任务书原话（错） | 事实（父侧实测 + 三家独立复核） |
|---|---|---|
| 1 | 「`isProductCode("docs/x.mjs")` 判 **true**（产品代码）」 | **错，方向反了**。`eng.mjs:51` 的 `startsWith("docs/")` 在扩展名判定**之前**短路豁免 ⇒ **false**（文档）。两谓词对该路径**一致** |
| 2 | 「`isDocFile` 把根级 `README.md`/`CHANGELOG.md` 判为**非文档**」 | **错**。`advisor.mjs:1674` 的扩展名子句接受它们 ⇒ **true**（合法设计评审文档） |
| 3 | 「`docs/` 对两谓词**语义相反**」（此说源自交接页 §5，我未经复核即采信） | **错**。两谓词对 `docs/**` **都**归文档侧 |
| 4 | 「`injectMethology` 另受 **16K 截断**」 | **错**。16K（`PROJECT_GUIDE_BUDGET`）只作用于 `injectProjectGuide`（AGENTS.md）；METHODOLOGY 注入**全文、无预算** ⇒ 预算要**新增**，不是「保留」 |

**父侧实测真值表**（`node` 实跑，非阅读推断）：

| 路径 | `isProductCode` | `isDocFile` | 互补？ |
|---|---|---|---|
| `docs/x.mjs` | false | true | ✅ |
| `README.md` / `CHANGELOG.md` | false | true | ✅ |
| `lib/a.mjs` / `test/x.mjs` | true | false | ✅ |
| `packages/app/src/a.mjs` | true（**靠兜底**） | false | ✅ |
| **`src/notes.md`** | **true** | **true** | ❌ **唯一矛盾类** |
| `""` | false | false | ❌（双否；但写门禁有 `!target` 前置短路，实际无害） |
| `"  "` | true | false | ✅ |

**另经实测确认**：`docs/design/README.md` **不存在**（本仓地图在 `docs/README.md`）· `ENGINEERING-MODE.md` **不存在**（上游悬空名，却被 `engineering.md:198` 当成本仓文件指涉）。

> **正因如此，父侧原始定性（「两份互相矛盾的副本」「`docs/` 语义相反」）本身就不准确**——真正的矛盾面比交接页 §5 记的**窄**。

---

## §2 判据矛盾的真正形态（父侧采纳 kimi 的形式化）

令 **D** = 「规范化后以 `docs/` 开头」、**S** = 「`^src/` 命中」、**E** = 「文档扩展名命中」，则：

```
isProductCode = ¬D ∧ (S ∨ ¬E)        // docs/ 先豁免，再 ^src/ 快路径，最后扩展名兜底
isDocFile     = D ∨ E
```

- **唯一矛盾类 = ¬D ∧ S ∧ E** —— 即**根 `src/` 下的文档扩展名文件**（`src/README.md`）：写门禁**要令牌** ∧ 评审文档校验**接受**。
- **结构脆弱性**：`packages/app/src/a.mjs` 今天靠**扩展名兜底**才判产品代码——`^src/` 锚**对代码文件是死代码**。
- **不对称（非矛盾）**：`src/README.md` 被拦，而 `packages/app/src/README.md` 不被拦——同一逻辑位置，仅因嵌套深度不同结果相反。

**定性（父侧裁定）**：四家表述不同（「两个不同问题」vs「一个共享子问题两份副本」），**父侧取 kimi 的综合**——**两者同时成立**：
- **不同问题**：`isProductCode` 答「写这个路径**要不要令牌**」（写门禁 `eng.mjs:168`）；`isDocFile` 答「这个路径**能否作为设计评审文档**」（入参校验 `advisor.mjs:1903`）。
- **共享子问题**：「**这个路径是文档还是代码**」。矛盾**全部**出在这个共享子问题被实现了两遍、且各有盲区。

⇒ **单一权威不落在任一谓词上，而落在共享子问题**（见 §3-④）。

---

## §3 四问裁定

### ① 退役的精确终态：**逐处改写，零整段删除**

**总原则（四家一致 + 上游口径）**：**维度不删、只改判据来源；指令句不删、只改指向**。

| 处 | 处置 | 终态措辞要点 |
|---|---|---|
| `advisor-msgs.mjs:212-222` `injectMethology` | **重写**（连拼写错误的函数名一起消掉） | 三态注入器（见 ②） |
| `:270` / `:332` 调用点 | 改写 | 调新注入器；**删 `engineering === true` 门**（决策 Q3） |
| `:274` 硬要求句 | 改写 | 删「Read METHODOLOGY.md to understand the project's standards」，改为指向评审上下文中的 `## Project Standards` 段（若存在）。**顺带自愈一处既有自相矛盾**：该句与同函数 `:261` 的「review ONLY these files」今日就打架 |
| `:278` 六维判据 | 只换其中一维 | `methodology compliance (does it follow the project's METHODOLOGY.md?)` → `standards compliance (does it follow the project standards provided in the review context?)`；**维数与次序不动** |
| `advisor-design.md:11` | 改写 | 同上口径；**顺带清除「4-step workflow」上游残留**（本仓 METHODOLOGY 并非四步） |
| `advisor-design.md:15` | 改写 | `docs/design/README.md`（**不存在的路径**）→ 「评审上下文提供的文档地图（若有）」 |
| `advisor-design.md:39` | 改写 | 引用示例 `docs/design/AGENT-LOOP.md:180` → 中性示例路径 |
| `advisor-design.md:65` | 改写 | 硬要求句同款 |
| `engineering.md` **9 处** | 两型：**纪律名泛指化** + **文件名指涉摘除** | `:22`/`:113`/`:114` 删「per METHODOLOGY」归属状语（三层的**内容本就内联**）；`:64`/`:130` 改「the task structure」（同句已内联枚举三要素）；`:50` 删「METHODOLOGY.md is read by the advisor itself」；`:99-100` **条件整句改为无条件自带纪律**（「测试覆盖是交付的一部分」是**插件自己的**纪律，不依附目标仓文件）；`:198` 枚举里的 `METHODOLOGY.md` **与 `ENGINEERING-MODE.md` 一起摘**（后者本仓根本不存在） |

**退役的可验收形态（机器锁）**：`grep -ri "methodology" lib/` = **0 命中**（含提示词、含 LLM 可见串）。**仓库自身的 `METHODOLOGY.md` 本体保留**——退役范围**只**是产品提示词面。

### ② 声明键：**不新增文件、不新增仓内路径**

**父侧裁定 = 只走插件配置键，落点复用 `includeProjectGuide` 的既有四面管道**（全局配置校验 → config-store 合并 → 会话覆盖 → `advisor_config` 工具；设置页为第五面，见 Q-2）。

| 键 | 语义 | 缺省 |
|---|---|---|
| `advisor.standardsDoc` | 项目标准文档路径（cwd 相对） | 未声明 |

**三态行为**（取代今日的「静默跳过」）：

| 态 | 评审员看到 |
|---|---|
| 声明 + 可读 | `## Project Standards` 段 + 声明说明句 + 全文（**>16384 字符按 `PROJECT_GUIDE_BUDGET` 同款截断 + 标记**） |
| 声明 + **不可读** | **响亮且与未声明可区分**：`(Declared project standards document '…' could not be read — check the advisor.standardsDoc setting. Proceeding without it.)` |
| **未声明** | **显式降级句**：`(No project standards document declared — set advisor.standardsDoc to the project's standards file to have it evaluated. Until then, review against the documents list and general engineering practice.)` |

**父侧否决的两个备选**（含理由，留痕）：

| 备选 | 否决理由 |
|---|---|
| `.thincoder/review.json` 作为仓内声明文件 | ① 它**不是文档扩展名** ⇒ 在工程模式下**写它自己就需要设计令牌**（glm 独立指出）；② 若为它加门禁豁免，就是**人工维护的例外清单必漂移**（吸收清单 §4-9 的教训，与本批要消灭的缺陷同物种）；③ 插件配置键**零门禁交互**、且是可移植的正确层 |
| 把地图路径**改对**成 `docs/README.md` | 等于把本仓布局**再写死一次**——正是本批要消灭的缺陷物种。地图改由**同一把声明键机制**承载（决策 Q-2） |

**本仓狗粮**：本仓经**配置**声明 `advisor.standardsDoc = "METHODOLOGY.md"`（部署注记，非代码变更）——**插件可移植，本仓自愿接入**。

### ③ 「自指脚本类」：**实测为零 ⇒ 证据闭案 + 加锁**

- `check-doc-width` / `check-ledger` / `docs/TODO.md` 在 `lib/**` **零命中**；`package.json` scripts 仅 `node --test`；**无 `scripts/` / `bin/` / `tools/` 目录**（实测）。
- 等价物 = **两处死路径指涉**（已并入 ①）：`advisor-msgs.mjs:224-234` `injectDocumentMap` 读 `docs/design/README.md`（**今日恒不生效**——本仓无该路径，且 lib 内零消费）；`advisor-design.md:15` 同款。
- **处置 = 不产代码，加一条回归锁**（防未来引入）：`grep -ri "check-doc-width\|check-ledger" lib/` = 0。

### ④ 判据单一权威：**新建零依赖叶模块，`isProductCode` 变纯补集**

**落点**：新建 `lib/path-kind.mjs`（**零 import**——`eng.mjs` 已 import `advisor.mjs`，权威必须放第三方以免成环；`doc-hash.mjs` 是同型先例）。

```
DOC_EXT       = /\.(md|markdown|mdx|txt|rst|adoc)$/i
isDocPath(p)  : 归一（反斜杠→"/"）；空 → false
                以 "docs/" 开头 → true          // 保留：两谓词今日在此一致
                DOC_EXT 命中      → true          // 任意深度、任意目录（含 src/ 内）
                否则 false
isProductCode(p) = 非空 ∧ ¬isDocPath(p)           // 纯补集派生，无第二套规则体
```

- `eng.mjs` 的 `isProductCode` 变**一行 wrapper**（**名字与 export 保留**——`guard-e.test.mjs` 的逐字节夹具锁着写门禁函数体里的 `isProductCode(target)` 调用行）。**特别注意**：夹具锁的是 `lib/eng.mjs` **文件内**的名字，跨模块搬家必须保证该文件仍有可解析的 `isProductCode` 绑定，**且夹具字节不变**。
- `advisor.mjs:1671` 的 `isDocFile` **删除**，`:1903` 改用 `isDocPath`；**校验错误文案逐字节不动**（`design-review-guard.test.mjs` 锁着，且改后语义依旧成立）。
- **`^src/` 处置 = 删分支**（不是收紧）：对代码扩展名它是**冗余死代码**（兜底已覆盖，删之结果**零变化**）；对文档扩展名它是**唯一矛盾源**。上游陷阱是「**以锚替换兜底**」；本裁定**保留兜底、去掉锚** ⇒ 嵌套布局真阳性不丢。
- **`docs/` 归属统一 = 约定登记，不加判**：`docs/` 按纯文档树约定（根锚定保留，两谓词今日已一致）；代码文件落进 `docs/` 属**布局违规**，由评审与分歧审计抓，**不归写门禁兜底**——因为堵它需要引入「代码扩展名清单」，而**人工维护的清单必漂移**。此边界写进 `path-kind.mjs` 模块注释。

---

## §4 父侧裁定汇总（含对四家建议的取舍）

| # | 岔口 | 四家倾向 | 父侧裁定 |
|---|---|---|---|
| **J1** | 退役是「删」还是「改写」 | 4/4 改写 | **改写**（维度不删、只改判据来源） |
| **J2** | 措辞统一口径 | 「项目标准由评审上下文提供」 | **「provided in the review context」** —— 「provided」而非「declared」：让**提示词对外绑**（上下文有则有），把**键内绑**留在注入器，两层责任不混 |
| **J3** | 声明键落点 | 意见分散（仓内文件 / 配置键 / 不用键） | **只用配置键**（§3-②）——否决仓内文件（写它自己就要令牌 + 例外清单必漂移）；否决「改成固定路径」（重写死一次本仓绑定） |
| **J4** | 未声明时的行为 | 4/4 显式降级句 | **显式降级句 + 明说「不要自己去磁盘找」**（防「review ONLY」违例） |
| **J5** | `^src/` 怎么办 | 4/4 删分支 | **删分支**（删死代码，非收紧） |
| **J6** | `src/**/*.md` 重分类 | 各家默认采纳 | **采纳**：与自书豁免意图对齐、消唯一矛盾类；本仓无 `src/` ⇒ 本仓**零现场影响** |
| **J7** | 注入器是否保留 `engineering === true` 门 | 多数主张删门 | **删门**——声明显式键本身即用户意图；留门会造出「已声明却被模式静默压制」的新静默洞 |
| **J8** | 地图是否也走声明键 | kimi 主张是 | **是**（同一机制、同款降级句）——避免「改对路径」式重写死 |
| **J9** | **批 6b 的 T-E19 钉死了 `test/` 档清单**（deepEqual：11 个既有 + `guard-e.test.mjs`）⇒ 新增任何 `.test.mjs` 都让它变红；而本批②需要新叶子模块 `lib/path-kind.mjs` 及其真值表测试 | —— | **用户 2026-09-13 裁定：按登记制扩展 T-E19 一行**。即：① T-E19 的 `existing` 列表**追加** `"path-kind.test.mjs"`；② 同处注释改为显式声明**闸的意图 = 「新增测试档必须同步登记」**（防静默扩张），而非禁止新增；③ 该「改批 6b 断言」的动作须在**设计档与本次登记**中写明理由（对齐仓内「改既有断言必须显式授权并记理由」的纪律）。**否决备选**：并进 `doc-hash.mjs`（会让「内容指纹」模块背两个职责）；不新增档而写进既有档（断言位置与职责不对应） |

---

## §5 交给用户的决策点

| # | 岔口 | 父侧倾向 | 影响 |
|---|---|---|---|
| **Q-1** | **设置页面（client.js）随批做还是登记后续** | ~~登记后续~~ → **用户 2026-09-13 裁定：连设置页一起做** | 本批定为 **5 个子件**（退役 / 声明键三态 / **设置页两文本框** / 单一权威 / 卫生锁）；设置页改完**需重启 DSH** 才生效（client 面） |
| **Q-2** | 文档地图键是否随批做 | **随批做**（同构、成本低） | 若否，地图注入继续是死代码（但已不指涉本仓） |
| **Q-3** | 本仓狗粮配置（`advisor.standardsDoc = METHODOLOGY.md`）由谁落地 | **父侧写进交接页部署注记**，用户在设置页填 | 不填则本仓设计评审**丢失现有 methodology 注入**（今日 `engineering=true` 时它真的在注入）⇒ 属**回归性变化**，必须挡住 |

---

## §6 登记面（本批不做，落交接页）

| # | 级别 | 内容 |
|---|---|---|
| **R-5** | 🟡 | **六维 / 七维清单预先存在的漂移**：`advisor-design.md` 列 **7 维**（含 Document ownership），`advisor-msgs.mjs:278` 只列 **6 维**（缺该维）⇒ 系统提示要求一个硬要求句没列的维度。本批**只换措辞不并维**，漂移登记待裁定 |
| **R-6** | 🔵 | `advisor-msgs.mjs` 读 `.thincoder/advisor.md`——沿用上游产品名作目标仓约定路径（有 `DEFAULT_CRITERIA` 兜底，非静默缺陷）；后续批考虑键化 |
| **R-7** | 🔵 | `viz/*.html` 内含过时数字（「5 处」等）——一次性分析产物，不动 |
| **R-8** | 🔵 | `index.mjs` eng_coder 工具参数描述里的示例路径 `lib/x.mjs` 略带本仓形状；可顺手泛化为 `<file>` |

---

## §7 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-13 | 首版：会诊 id 2（批 7 可移植性三件）四家交付；§1 父侧前提纠错四条（三家独立指出 + 父侧实测真值表）；§2 判据矛盾的形式化定性；§3 四问裁定；§4 父侧裁定 **J1–J9**；§5 交用户决策 Q-1…Q-3；§6 登记 R-5…R-8。**补充**：父侧补裁 J10–J12 记于需求档 §0.4（`standardsDoc` global-only / J11 路径前置校验 / J12 注入预算） |
