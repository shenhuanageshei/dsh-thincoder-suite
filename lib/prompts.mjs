// prompts.mjs — 提示词装载（对齐 thincoder advisor.mjs 的 loadPrompt 模式：
// 文件缺失 = 安装损坏，硬失败——静默降级会悄悄丢掉 approval-signal/引用规则）。
// 提示词正文在 lib/prompts/*.md：round1/2/3/design 原文移植自 thincoder；
// engineering/eng-coder/consult-base/coder 做了 DSH 工具名机械替换；
// discipline/main 为条款提取（评审纪律 / 会诊飞刀时机）。
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadPrompt(file, name) {
  try {
    return readFileSync(join(__dirname, "prompts", file), "utf8")
  } catch {
    throw new Error(name + " missing from the installation (lib/prompts/" + file + ") — reinstall the plugin or restore the file")
  }
}

/** advisor 收敛协议三段 system prompt（round1 全量 / round2 验证+新问题 / round3+ 严格验证）。 */
export const ADVISOR_ROUND1 = loadPrompt("advisor-round1.md", "advisor-round1.md")
export const ADVISOR_ROUND2 = loadPrompt("advisor-round2.md", "advisor-round2.md")
export const ADVISOR_ROUND3 = loadPrompt("advisor-round3.md", "advisor-round3.md")
/** 设计评审 prompt（含 [APPROVE:<8hex>] approval-signal 规则）。 */
export const ADVISOR_DESIGN = loadPrompt("advisor-design.md", "advisor-design.md")

/** 工程模式主代理工作流（9 步 Mandatory Flow + Work Loop 状态机）。 */
export const ENGINEERING = loadPrompt("engineering.md", "engineering.md")
/** eng_coder 子代理人格（设计 token 授权 + 交付自查清单）。 */
export const ENG_CODER_PERSONA = loadPrompt("eng-coder.md", "eng-coder.md")
/** 会诊专家人格（只读 + 主历史注入 + 诊断/建议/验证三段结构）。 */
export const CONSULT_PERSONA = loadPrompt("consult-base.md", "consult-base.md")
/** 飞刀 coder 人格（独立交付 + 透明度表）。 */
export const ESCALATE_PERSONA = loadPrompt("coder.md", "coder.md")

/** 常驻提示词 section：评审纪律 + 响应表条款。 */
export const DISCIPLINE = loadPrompt("discipline.md", "discipline.md")
/** 常驻提示词 section（池非空才注册）：会诊/飞刀时机条款。 */
export const MAIN_EXTRA = loadPrompt("main.md", "main.md")
