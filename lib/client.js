// client.js — thincoder-suite 设置页「Thincoder」全局配置编辑器（二期，docs/2026-09-02-settings-ui-design.md §3.3）。
// 手写 CJS bundle（零构建）：以 dsh-client-modules 契约的 wrapper 形态注册（实施确认项 3 实证：
// 对照 dsh-super-injector 产物头部——window.__ModuleLoader__.load({id, factory})，factory(require)
// 返回 { inject, apply }）。React 经模块表 seed（web 壳 staticModules：react / react/jsx-runtime，
// dsh-web-frontend dist 实证）require——手写 React 组件零 tsdown。
//
// - inject = 服务名声明（apply 用到的 ctx 服务：slots / connection / sessions —— 与
//   ui-settings-models 的 exports.inject 形态一致；connection.api 提供官方 RPC llm.providers/
//   llm.models（实施确认项 5：不可用时降级文本输入 + 提示）；sessions 提供当前会话 id
//   （实施确认项 4：list 快照 current；取不到 → 「复制 advisor_config 命令」文本框降级）。
// - 注册：ctx.slots.inject('settings.section', () => ctx.slots.register({name, id:'thincoder',
//   order:40, label:()=> 'Thincoder', inject: () => ({ api, sessions })}, ThincoderPage))。
// - 页面数据流：进入 fetch('/thincoder-suite/api/config') → 表单（base/user/effective 来源标注）；
//   保存 PUT /config（校验内联报错）；恢复默认 DELETE /config；会话视图 GET /session?sessionId=，
//   应用到当前会话 POST /apply-session，恢复会话默认 DELETE /session。
// - 样式极简：只加一块 scoped <style>（thincoder-settings 前缀），继承设置面板容器。

window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-thincoder-suite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region 依赖（seed 词，见 dsh-web-frontend staticModules：react）
		var React = require("react");
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var useRef = React.useRef;
		//#endregion

		var API = "/thincoder-suite/api";
		var EFFORTS = ["off", "low", "medium", "high", "max"];
		var CODEX_PROXY_MODES = ["inherit", "none", "url"];
		var CODEX_AGENTSMD = ["respect", "disable", "clean-cwd"];
		var GROUP_KEYS = ["round1", "convergence"];
		var GROUP_LABEL = { round1: "Round 1（首次全量评审）", convergence: "收敛轮（Round 2+）" };
		var TIMEOUT_MIN = 1000;
		var TIMEOUT_MAX = 3600000;
		// R1 §3.6（D-01）：单次 LLM 输出预算合法区间（与后端 PUT 校验/运行时回落同规则）
		var MAX_OUTPUT_TOKENS_MIN = 4096;
		var MAX_OUTPUT_TOKENS_MAX = 65536;
		// 批 5（FR-CB5）：评审上下文窗口（contextTokens）合法区间——语义 = 模型窗口，
		// 不是判死线（与后端 lib/advisor.mjs 的 ADVISOR_CONTEXT_TOKENS_MIN/MAX 同源同值）
		var CONTEXT_TOKENS_MIN = 16384;
		var CONTEXT_TOKENS_MAX = 4194304;
		// R5 §7.2（D-27 / UI-5）：dsh 后台任务挂死兜底截止合法区间（与后端 PUT 校验同规则）
		var DSHS_BG_TIMEOUT_MIN = 60000;
		var DSHS_BG_TIMEOUT_MAX = 3600000;
		// D-29：两键此前只在 entry base 可改（设置页改不动）——本批并入白名单 + 表单字段。
		// 区间与 lib/config-store.mjs 的 isValidConsultTimeoutMs / isValidEngTokenTtlMs 同规则。
		var CONSULT_TIMEOUT_MIN = 30000;
		var CONSULT_TIMEOUT_MAX = 3600000;
		var ENG_TTL_MIN = 600000;
		var ENG_TTL_MAX = 2592000000;
		// 批 7（D-P4/D-P15）· 批 13（R-6）：三个「项目文档」声明键
		// （advisor.standardsDoc / advisor.documentMapDoc / advisor.criteriaDoc）。
		// 值是**字符串文档路径**，无「合法区间」语义 ⇒ **不加** min/max 常量（对齐既有无区间
		// 标量先例 engCoderMaxTokens）。
		var PROJECT_DOC_KEYS = ["standardsDoc", "documentMapDoc", "criteriaDoc"];
		// 批 36-补2（设计档 docs/2026-10-16-task-ledger-design.md §十七）：个人任务台账三键的表单常量。
		// ★ 这是**浏览器镜像**（形态与理由见下方 ledgerDraftErrors 的档内注释）：本 bundle 无法 import
		//   `lib/tasks.mjs` 的导出谓词（宿主只给 browser 静态模块表：react 等）⇒ 这四个值在后端有**同一
		//   份事实源**，由 `test/config-api.test.mjs` 的 C-L4 腿做**逐夹具行为等值锁 + 字面互锁**
		//   （两边一漂就红）。改这里必须同时看 `lib/tasks.mjs`：
		//   LEDGER_MODE_OPTIONS ⇄ LEDGER_MODES · LEDGER_MAX_DOC_PATHS ⇄ MAX_DOC_PATHS ·
		//   LEDGER_COPY_MAX_CHARS ⇄ isValidCopyTemplate 的长度上限 · LEDGER_DEFAULT_COPY_TEMPLATE ⇄ DEFAULT_COPY_TEMPLATE
		var LEDGER_MODE_OPTIONS = ["standalone", "off"];
		var LEDGER_MODE_LABEL = { standalone: "standalone（启用个人台账）", off: "off（关闭台账分区）" };
		var LEDGER_DEFAULT_MODE = "standalone";
		var LEDGER_MAX_DOC_PATHS = 8;
		var LEDGER_COPY_MAX_CHARS = 500;
		var LEDGER_DEFAULT_COPY_TEMPLATE = "说人话大白话，说清楚前因后果，给建议。";

		function h(type, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return React.createElement.apply(React, [type, props || null].concat(children));
		}

		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init,
			}).then(function (r) { return r.json(); });
		}

		/** 同源请求 + 状态/错误归一。 */
		function apiCall(method, path, body) {
			return fetchJson(path, body === undefined ? { method: method } : { method: method, body: JSON.stringify(body) })
				.catch(function (err) { return { ok: false, error: String(err && err.message ? err.message : err) }; });
		}

		//#region 来源标注（U2：字段来源 = user 层字段定义 → 全局覆盖；base → entry base；否则回落默认）
		function hasPath(obj, parts) {
			var cur = obj;
			for (var i = 0; i < parts.length; i++) {
				if (!cur || typeof cur !== "object") return false;
				if (!(parts[i] in cur)) return false;
				cur = cur[parts[i]];
			}
			return true;
		}
		function fieldSource(base, user, parts) {
			if (hasPath(user, parts)) return "全局覆盖";
			if (hasPath(base, parts)) return "内置默认";
			return "默认";
		}
		//#endregion

		//#region 批 36-补2：个人任务台账三键的「文本 ↔ 数组」纯函数（设计档 §十七 §17.4 / §17.5 C-L3）
		//
		// ★★ 为什么这里是**镜像**而不是 import（**如实登记的设计缺口**）：本档是手写 CJS bundle，
		//    在浏览器里由 `window.__ModuleLoader__.load({factory})` 装载，factory 收到的 `require`
		//    只认宿主静态模块表（react / react-jsx-runtime 等）——**没有相对路径解析** ⇒ 无法 import
		//    `lib/ledger-config-text.mjs`（同档在 ENG_APP_SERVER_RUNNER_REFUSAL 处已写死这条事实：
		//    「浏览器 bundle 无法 import lib 的 mjs，故此处保留一份字面——两处必须同时改」）。
		//    ⇒ 规则的可执行单一源在 `lib/ledger-config-text.mjs`；这里是它的浏览器镜像，
		//      **行为等值由腿 C-L4 逐夹具机械锁死**（两边任一漂移 ⇒ 该腿红），常量字面亦互锁。
		// ★ 最终裁决永远是后端 PUT（本片段只产出「提前提示」，§17.3 决策 4）。

		/** 路径数组 ⇒ 多行文本（一行一个；空数组 ⇒ 空串）。 */
		function docPathsToText(paths) {
			var arr = Array.isArray(paths) ? paths.filter(function (p) { return typeof p === "string"; }) : [];
			return arr.join("\n");
		}

		/** 多行文本 ⇒ 路径数组（按 \r\n / \n 切、逐行 trim、去空行、保持顺序）。 */
		function textToDocPaths(text) {
			if (typeof text !== "string") return [];
			return text.split(/\r\n|\n/).map(function (s) { return s.trim(); }).filter(function (s) { return s !== ""; });
		}

		/** 前端**提前提示**（与后端同规则、不同朝向：这里只提示，后端才是裁决）。 */
		function ledgerDraftErrors(draft) {
			var d = draft && typeof draft === "object" && !Array.isArray(draft) ? draft : {};
			var ledger = d.ledger && typeof d.ledger === "object" && !Array.isArray(d.ledger) ? d.ledger : null;
			if (!ledger) return [];
			var errors = [];
			if (LEDGER_MODE_OPTIONS.indexOf(ledger.mode) === -1) {
				// ★ 文案里的闭集按**后端 `LEDGER_MODES` 的顺序**写（`off|standalone`），而**下拉选项**
				//   按「默认值在前」排（`standalone` / `off`，§17.4）——两者顺序不同是**有意的**：
				//   提示语必须与 `lib/ledger-config-text.mjs` 的同一条逐字相同（腿 C-L4 逐夹具比输出）。
				errors.push("ledger.mode 必须是 off|standalone（当前为 " + JSON.stringify(ledger.mode) + "）");
			}
			var paths = typeof ledger.docPathsText === "string" ? textToDocPaths(ledger.docPathsText) : ledger.docPaths;
			if (paths !== undefined && paths !== null) {
				if (!Array.isArray(paths)) {
					errors.push("ledger.docPaths 必须是路径清单（一行一个）");
				} else if (paths.length > LEDGER_MAX_DOC_PATHS) {
					errors.push("ledger.docPaths 最多 " + LEDGER_MAX_DOC_PATHS + " 条（当前 " + paths.length + " 条）");
				} else if (!(paths.every(function (p) { return typeof p === "string" && p.trim() !== ""; }))) {
					errors.push("ledger.docPaths 的每一条都必须是非空路径（不要留只有空白的行）");
				}
			}
			var tpl = ledger.copyTemplate;
			if (!(typeof tpl === "string" && tpl.trim() !== "" && tpl.length <= LEDGER_COPY_MAX_CHARS)) {
				var cur = typeof tpl === "string" ? tpl : "";
				errors.push("ledger.copyTemplate 不能为空且不得超过 " + LEDGER_COPY_MAX_CHARS + " 字（当前 " + cur.length + " 字）");
			}
			return errors;
		}

		/** 草稿 ledger 节 ⇒ PUT 载荷（纯形态转换；非法值**不静默修正**——交给后端拒）。 */
		function ledgerDraftToPayload(ledger) {
			var lg = ledger && typeof ledger === "object" && !Array.isArray(ledger) ? ledger : {};
			return {
				mode: lg.mode,
				docPaths: typeof lg.docPathsText === "string"
					? textToDocPaths(lg.docPathsText)
					: (Array.isArray(lg.docPaths) ? lg.docPaths.map(function (p) { return typeof p === "string" ? p.trim() : p; }) : []),
				copyTemplate: typeof lg.copyTemplate === "string" ? lg.copyTemplate : "",
			};
		}

		/** user 层 ledger 节 ⇒ 表单草稿（缺省/非法 ⇒ 内置默认，§17.4「空态」）。 */
		function ledgerToDraft(src) {
			var lg = src && typeof src === "object" && !Array.isArray(src) ? src : {};
			return {
				mode: LEDGER_MODE_OPTIONS.indexOf(lg.mode) !== -1 ? lg.mode : LEDGER_DEFAULT_MODE,
				docPathsText: Array.isArray(lg.docPaths)
					? docPathsToText(lg.docPaths.filter(function (p) { return typeof p === "string" && p.trim() !== ""; }))
					: "",
				copyTemplate: typeof lg.copyTemplate === "string" && lg.copyTemplate.trim() !== ""
					? lg.copyTemplate
					: LEDGER_DEFAULT_COPY_TEMPLATE,
			};
		}
		//#endregion

		//#region 内联校验（U3，与 host validateGlobalUserConfig 同规则；不重复后端实现）
		// 批 33（FR-1）：codex 行有两族 kind —— `codex-cli`（本地 CLI 子进程，可写）与
		// `codex-app-server`（平台 provider 的 app-server 传输面，**只读**）。二者在 UI 面的「免
		// provider/model 成对」「model/effort 走 codex 下拉」等判定上同族 ⇒ **判定族字面单点化**：
		// 凡「是不是 codex 行」一律经本函数（此前 9 处各写各的 `=== "codex-cli"`）。
		var CODEX_RUNNER_KINDS = ["codex-cli", "codex-app-server"];
		function isCodexRunnerKind(k) { return CODEX_RUNNER_KINDS.indexOf(k) !== -1; }
		function validateDraft(draft) {
			var errors = [];
			var advisor = draft.advisor || {};
			GROUP_KEYS.forEach(function (gk) {
				var g = advisor[gk] || {};
				// 一期 codex-runner / 批 33：codex 族的组免 provider/model 成对（model 走 codex 下拉）
				if (isCodexRunnerKind(g.runnerKind)) {
					return;
				}
				// 成对语义与解析链一致：只填一半 = 非法；都不填 = 该组回落（合法）；
				// 显式空串不会被发送（草稿净化），此处只拦“只填一半”
				if ((g.provider && !g.model) || (!g.provider && g.model)) {
					errors.push(gk + " 组：provider/model 必须成对填写（都不填则跟随解析链）");
				}
				if (g.effort && EFFORTS.indexOf(g.effort) === -1) errors.push(gk + ".effort 必须是 off|low|medium|high|max");
				if (g.timeoutMs !== "" && g.timeoutMs !== undefined && g.timeoutMs !== null) {
					var t = Number(g.timeoutMs);
					if (!Number.isFinite(t) || t < TIMEOUT_MIN || t > TIMEOUT_MAX || !Number.isInteger(t)) {
						errors.push(gk + ".timeoutMs 必须是 " + TIMEOUT_MIN + "~" + TIMEOUT_MAX + " 的整数（毫秒）");
					}
				}
			});
			if (draft.advisor && draft.advisor.includeProjectGuide !== undefined && typeof draft.advisor.includeProjectGuide !== "boolean") {
				errors.push("includeProjectGuide 必须是布尔值");
			}
			// R1 §3.6：maxOutputTokens 内联校验（与后端 PUT 校验同规则：4096..65536 整数）
			if (draft.advisor && draft.advisor.maxOutputTokens !== "" && draft.advisor.maxOutputTokens !== undefined && draft.advisor.maxOutputTokens !== null) {
				var mo = Number(draft.advisor.maxOutputTokens);
				if (!Number.isFinite(mo) || mo < MAX_OUTPUT_TOKENS_MIN || mo > MAX_OUTPUT_TOKENS_MAX || !Number.isInteger(mo)) {
					errors.push("advisor.maxOutputTokens 必须是 " + MAX_OUTPUT_TOKENS_MIN + "~" + MAX_OUTPUT_TOKENS_MAX + " 的整数（token）");
				}
			}
			// 批 5（FR-CB5）：contextTokens 内联校验（与后端 PUT 校验同规则：16384..4194304 整数；
			// 非法不静默丢——表单内联报错）
			if (draft.advisor && draft.advisor.contextTokens !== "" && draft.advisor.contextTokens !== undefined && draft.advisor.contextTokens !== null) {
				var cw = Number(draft.advisor.contextTokens);
				if (!Number.isFinite(cw) || cw < CONTEXT_TOKENS_MIN || cw > CONTEXT_TOKENS_MAX || !Number.isInteger(cw)) {
					errors.push("advisor.contextTokens 必须是 " + CONTEXT_TOKENS_MIN + "~" + CONTEXT_TOKENS_MAX + " 的整数（模型窗口 tokens）");
				}
			}
			// 批 7（D-P4/J11）· 批 13（R-6）：三个声明键都是**字符串文档路径**（无区间——D-P15）。
			// ★空串不是「不发送」：空串 = 撤销该键（必须照发），故这里只校验「非空即须为字符串」。
			PROJECT_DOC_KEYS.forEach(function (k) {
				var v = draft.advisor ? draft.advisor[k] : undefined;
				if (v !== undefined && v !== null && typeof v !== "string") {
					errors.push("advisor." + k + " 必须是文档路径字符串（相对会话 cwd）");
				}
			});
			(draft.consultModels || []).forEach(function (row, i) {
				// 一期 codex-runner / 批 33：codex 族的行免 provider/model 成对
				if (isCodexRunnerKind(row.runnerKind)) {
					return;
				}
				// 半行（只填 provider 或 model）报错；全空行（刚「+ 添加模型」）静默跳过
				if ((row.provider && !row.model) || (!row.provider && row.model)) {
					errors.push("模型池第 " + (i + 1) + " 行：provider/model 必须成对（全空行保存时忽略）");
				}
				if (row.effort && EFFORTS.indexOf(row.effort) === -1) errors.push("模型池第 " + (i + 1) + " 行：effort 非法");
			});
			// codexCli 全局节（codex-cli 的行/组实际使用这些全局值；批 33：codex-app-server 行
			// **不消费**本节任何字段——它走平台 provider，只有 model/effort 入展示标签）
			if (draft.codexCli) {
				var cc = draft.codexCli;
				if (cc.proxyMode === "url") {
					var u = cc.proxyUrl || "";
					if (u.indexOf("http://") !== 0 && u.indexOf("https://") !== 0) errors.push("codexCli.proxyUrl 必须是 http(s) 开头的 URL（proxyMode=url 时必填）");
				}
				if (cc.defaultTimeoutMs !== "" && cc.defaultTimeoutMs !== undefined && cc.defaultTimeoutMs !== null) {
					var ct = Number(cc.defaultTimeoutMs);
					if (!Number.isFinite(ct) || ct < 30000 || ct > 3600000 || !Number.isInteger(ct)) {
						errors.push("codexCli.defaultTimeoutMs 必须是 30000~3600000 的整数（毫秒）");
					}
				}
				if (cc.idleTimeoutMs !== "" && cc.idleTimeoutMs !== undefined && cc.idleTimeoutMs !== null) {
					var it = Number(cc.idleTimeoutMs);
					if (!Number.isFinite(it) || it < 15000 || it > 3600000 || !Number.isInteger(it)) {
						errors.push("codexCli.idleTimeoutMs 必须是 15000~3600000 的整数（毫秒）");
					}
				}
				// UI-4（R2 §4.5/D-14，DP-3 默认 8）：全局 codex 并发上限
				if (cc.maxConcurrent !== "" && cc.maxConcurrent !== undefined && cc.maxConcurrent !== null) {
					var mc = Number(cc.maxConcurrent);
					if (!Number.isFinite(mc) || mc < 1 || mc > 64 || !Number.isInteger(mc)) {
						errors.push("codexCli.maxConcurrent 必须是 1~64 的整数");
					}
				}
				if (cc.engCoderRunner && cc.engCoderRunner !== "dsh" && cc.engCoderRunner !== "codex-cli") {
					// ★ 批 33（设计档 §8 负向腿 / §9 守卫行）：具名拒绝只读通道——与 host 侧 PUT 的
					// 拒绝文案**同一句语义**（`lib/index.mjs` 的 ENG_APP_SERVER_RUNNER_REFUSAL；
					// 浏览器 bundle 无法 import lib 的 mjs，故此处保留一份字面——两处必须同时改）。
					if (cc.engCoderRunner === "codex-app-server") {
						errors.push("codexCli.engCoderRunner 不接受 codex-app-server：本通道只读、不可用于写任务（平台无人值守对审批一律拒绝/cancel）——eng_coder 请改回 codex-cli（本地 Codex CLI 写沙箱）或 dsh");
					} else {
						errors.push("codexCli.engCoderRunner 必须是 dsh|codex-cli");
					}
				}
			}
			if (draft.engCoderMaxTokens !== "" && draft.engCoderMaxTokens !== undefined && draft.engCoderMaxTokens !== null) {
				var mt = Number(draft.engCoderMaxTokens);
				if (!Number.isFinite(mt) || mt <= 0 || !Number.isInteger(mt)) errors.push("engCoderMaxTokens 必须是正整数");
			}
			if (draft.engCoderEffort && EFFORTS.indexOf(draft.engCoderEffort) === -1) {
				errors.push("engCoderEffort 必须是 off|low|medium|high|max");
			}
			// UI-5（R5 §7.2/D-27）：dsh 后台任务挂死兜底截止（与后端 PUT 校验同规则：60000..3600000 整数）
			if (draft.dshBackgroundTimeoutMs !== "" && draft.dshBackgroundTimeoutMs !== undefined && draft.dshBackgroundTimeoutMs !== null) {
				var dt = Number(draft.dshBackgroundTimeoutMs);
				if (!Number.isFinite(dt) || dt < DSHS_BG_TIMEOUT_MIN || dt > DSHS_BG_TIMEOUT_MAX || !Number.isInteger(dt)) {
					errors.push("dshBackgroundTimeoutMs 必须是 " + DSHS_BG_TIMEOUT_MIN + "~" + DSHS_BG_TIMEOUT_MAX + " 的整数（毫秒）");
				}
			}
			// D-29：consultTimeoutMs（会诊看门狗）/ engTokenTtlMs（design token 有效期）
			if (draft.consultTimeoutMs !== "" && draft.consultTimeoutMs !== undefined && draft.consultTimeoutMs !== null) {
				var ct = Number(draft.consultTimeoutMs);
				if (!Number.isFinite(ct) || ct < CONSULT_TIMEOUT_MIN || ct > CONSULT_TIMEOUT_MAX || !Number.isInteger(ct)) {
					errors.push("consultTimeoutMs 必须是 " + CONSULT_TIMEOUT_MIN + "~" + CONSULT_TIMEOUT_MAX + " 的整数（毫秒）");
				}
			}
			if (draft.engTokenTtlMs !== "" && draft.engTokenTtlMs !== undefined && draft.engTokenTtlMs !== null) {
				var et = Number(draft.engTokenTtlMs);
				if (!Number.isFinite(et) || et < ENG_TTL_MIN || et > ENG_TTL_MAX || !Number.isInteger(et)) {
					errors.push("engTokenTtlMs 必须是 " + ENG_TTL_MIN + "~" + ENG_TTL_MAX + " 的整数（毫秒）");
				}
			}
			return errors;
		}

		/** 草稿 → PUT /config 载荷（空字段不发送 = 不覆盖 base；池行按 poolDirty 显式表达）。 */
		/** 组/池行 → runner 字段（draft 扁平字段 runnerKind/codexModel/codexEffort → schema 形态）。 */
		function runnerFromDraft(g) {
			// 批 33：app-server 行也走 codex 下拉（model/effort **只入展示标签**——后端 FR-4 会如实
			// 告知「本通道不消费」；此处保留字段是为了**往返不丢**用户在 codex-cli 行上已配的值）。
			if (isCodexRunnerKind(g.runnerKind)) {
				var runner = { kind: g.runnerKind };
				if (g.codexModel) runner.model = g.codexModel;
				if (g.codexEffort) runner.effort = g.codexEffort;
				return runner;
			}
			if (g.runnerKind === "dsh") return "dsh";
			return undefined;
		}

		function draftToPayload(draft) {
			var advisor = {};
			GROUP_KEYS.forEach(function (gk) {
				var g = draft.advisor[gk] || {};
				var out = {};
				var runner = runnerFromDraft(g);
				if (runner !== undefined) out.runner = runner;
				if (!isCodexRunnerKind(g.runnerKind)) {
					// dsh/未设组才发 provider/model（codex 组的 model 在 runner 内，发 provider/model 会被校验拒绝）
					if (g.provider) out.provider = g.provider;
					if (g.model) out.model = g.model;
				}
				if (g.effort) out.effort = g.effort;
				if (g.timeoutMs !== "" && g.timeoutMs !== undefined && g.timeoutMs !== null) out.timeoutMs = Number(g.timeoutMs);
				if (Object.keys(out).length > 0) advisor[gk] = out;
			});
			if (draft.advisor && typeof draft.advisor.includeProjectGuide === "boolean") advisor.includeProjectGuide = draft.advisor.includeProjectGuide;
			// R1 §3.6：maxOutputTokens（空字段不发送 = 不覆盖 base/内置缺省）
			if (draft.advisor && draft.advisor.maxOutputTokens !== "" && draft.advisor.maxOutputTokens !== undefined && draft.advisor.maxOutputTokens !== null) {
				advisor.maxOutputTokens = Number(draft.advisor.maxOutputTokens);
			}
			// 批 5（FR-CB5）：contextTokens（空字段不发送 = 删除该键 → 评审时自动跟随模型窗口）
			if (draft.advisor && draft.advisor.contextTokens !== "" && draft.advisor.contextTokens !== undefined && draft.advisor.contextTokens !== null) {
				advisor.contextTokens = Number(draft.advisor.contextTokens);
			}
			// 批 7（J11/AC-P12c）· 批 13（R-6）：三个声明键**一律照发**——空串 `""` 必须**送出**
			// （服务端据此**删除该键** = 撤销声明；「空字段不发送」会把用户锁死在已声明态）。
			// 只有**纯空白**跳过（§6.7 面⑥：纯空白 = 否，不是撤销；服务端也会以「非文档路径」
			// 400 拒它——客户端先滤掉，用户不会拿到一个自己按不出来的报错）。
			PROJECT_DOC_KEYS.forEach(function (k) {
				var v = draft.advisor ? draft.advisor[k] : undefined;
				if (typeof v !== "string") return;
				if (v === "") advisor[k] = "";              // 撤销声明：照发空串
				else if (v.trim() !== "") advisor[k] = v;   // 纯空白跳过（既非声明也非撤销）
			});
			var config = {};
			if (Object.keys(advisor).length > 0) config.advisor = advisor;
			// 评审 #4：池被用户动过（增/删/改）才发——完整行过滤后整体替换；全删 = 显式清空 []
			if (draft.poolDirty) {
				config.consultModels = (draft.consultModels || []).filter(function (r) {
					if (isCodexRunnerKind(r.runnerKind)) return true;
					return r.provider && r.model;
				}).map(function (r) {
					var out = {};
					var runner = runnerFromDraft(r);
					if (runner !== undefined) out.runner = runner;
					if (!isCodexRunnerKind(r.runnerKind)) {
						out.provider = r.provider;
						out.model = r.model;
					}
					if (r.effort) out.effort = r.effort;
					return out;
				});
			}
			if (draft.engCoderMaxTokens !== "" && draft.engCoderMaxTokens !== undefined && draft.engCoderMaxTokens !== null) {
				config.engCoderMaxTokens = Number(draft.engCoderMaxTokens);
			}
			if (draft.engCoderEffort) config.engCoderEffort = draft.engCoderEffort;
			// UI-5（R5 §7.2）：dsh 后台任务挂死兜底截止（空字段不发送 = 不覆盖 base/内置缺省）
			if (draft.dshBackgroundTimeoutMs !== "" && draft.dshBackgroundTimeoutMs !== undefined && draft.dshBackgroundTimeoutMs !== null) {
				config.dshBackgroundTimeoutMs = Number(draft.dshBackgroundTimeoutMs);
			}
			// D-29：consultTimeoutMs / engTokenTtlMs（空字段不发送 = 不覆盖 base）
			if (draft.consultTimeoutMs !== "" && draft.consultTimeoutMs !== undefined && draft.consultTimeoutMs !== null) {
				config.consultTimeoutMs = Number(draft.consultTimeoutMs);
			}
			if (draft.engTokenTtlMs !== "" && draft.engTokenTtlMs !== undefined && draft.engTokenTtlMs !== null) {
				config.engTokenTtlMs = Number(draft.engTokenTtlMs);
			}
			// codexCli 全局节：被编辑过（codexDirty）才发
			if (draft.codexDirty && draft.codexCli) {
				var cc = draft.codexCli;
				var ccOut = {};
				if (cc.executable) ccOut.executable = cc.executable;
				if (cc.model) ccOut.model = cc.model;
				if (cc.proxyMode) ccOut.proxyMode = cc.proxyMode;
				if (cc.proxyUrl) ccOut.proxyUrl = cc.proxyUrl;
				if (cc.agentsMdPolicy) ccOut.agentsMdPolicy = cc.agentsMdPolicy;
				if (cc.defaultTimeoutMs !== "" && cc.defaultTimeoutMs !== undefined && cc.defaultTimeoutMs !== null) ccOut.defaultTimeoutMs = Number(cc.defaultTimeoutMs);
				if (cc.budgetCapMs !== "" && cc.budgetCapMs !== undefined && cc.budgetCapMs !== null) ccOut.budgetCapMs = Number(cc.budgetCapMs);
				if (cc.idleTimeoutMs !== "" && cc.idleTimeoutMs !== undefined && cc.idleTimeoutMs !== null) ccOut.idleTimeoutMs = Number(cc.idleTimeoutMs);
				// UI-4（R2 §4.5/D-14）：全局 codex 进程上限
				if (cc.maxConcurrent !== "" && cc.maxConcurrent !== undefined && cc.maxConcurrent !== null) ccOut.maxConcurrent = Number(cc.maxConcurrent);
				if (cc.engCoderRunner) ccOut.engCoderRunner = cc.engCoderRunner;
				if (Object.keys(ccOut).length > 0) config.codexCli = ccOut;
			}
			// 批 36-补2（设计档 §十七 §17.4）：个人任务台账三键 —— **只有被用户动过（ledgerDirty）才发**。
			// 沿用本函数既有纪律（codexDirty / poolDirty 同款）：user 层原本没有 `ledger` 时，
			// 「什么都没改就保存」**不得**把内置默认物化进 user 层——那会把「未在 user 配置中显式设置」
			// 变成「显式设置」，本卡片的空态标注随之变成一句谎（§17.4「空态」）。
			// ★ `ledger` 已在服务端 `topAllowed` 白名单内（U3c2 的「可产出键 ⊆ 白名单」锁盯着这一行）。
			if (draft.ledgerDirty && draft.ledger) {
				config.ledger = ledgerDraftToPayload(draft.ledger);
			}
			return config;
		}

		/** effective → 表单草稿（空 = 未设/回落，供用户补全）。 */
		function effectiveToDraft(effective) {
			var a = effective && effective.advisor ? effective.advisor : {};
			function group(g) {
				g = g || {};
				return {
					provider: typeof g.provider === "string" ? g.provider : "",
					model: typeof g.model === "string" ? g.model : "",
					effort: typeof g.effort === "string" ? g.effort : "",
					timeoutMs: typeof g.timeoutMs === "number" ? String(g.timeoutMs) : "",
					// 评审 C1：runner 契约允许字符串简写（"dsh"/"codex-cli"/"codex-app-server"）——
					// 归一化两种形态，否则字符串形态加载时显示为默认 dsh、保存时丢失 codex 行
					runnerKind: (function () {
						var rk = g.runner ? (typeof g.runner === "string" ? g.runner : g.runner.kind) : "";
						return (isCodexRunnerKind(rk) || rk === "dsh") ? rk : "";
					})(),
					codexModel: g.runner && typeof g.runner === "object" && typeof g.runner.model === "string" ? g.runner.model : "",
					codexEffort: g.runner && typeof g.runner === "object" && typeof g.runner.effort === "string" ? g.runner.effort : "",
				};
			}
			var ccSrc = (effective && effective.codexCli && typeof effective.codexCli === "object") ? effective.codexCli : {};
			return {
				advisor: {
					round1: group(a.round1),
					convergence: group(a.convergence),
					includeProjectGuide: typeof a.includeProjectGuide === "boolean" ? a.includeProjectGuide : false,
					// R1 §3.6：单次 LLM 输出预算（D-01 空响应治理——推理型模型烧光输出预算的独立旋钮）
					maxOutputTokens: typeof a.maxOutputTokens === "number" ? String(a.maxOutputTokens) : "",
					// 批 5（FR-CB5）：上下文窗口（空串 = 未配 → 评审时自动跟随模型；非数字同样视为未配）
					contextTokens: typeof a.contextTokens === "number" ? String(a.contextTokens) : "",
					// 批 7（D-P4）· 批 13（R-6）：三个声明键（字符串路径；缺省 = 未声明 → 注入器走显式降级句）
					standardsDoc: typeof a.standardsDoc === "string" ? a.standardsDoc : "",
					documentMapDoc: typeof a.documentMapDoc === "string" ? a.documentMapDoc : "",
					criteriaDoc: typeof a.criteriaDoc === "string" ? a.criteriaDoc : "",
				},
				// 池行扁平化：runner 对象/字符串 → runnerKind/codexModel/codexEffort 草稿字段（评审 C1 同源）
				consultModels: (Array.isArray(effective && effective.consultModels) ? effective.consultModels : []).map(function (r) {
					var rk = r && r.runner ? (typeof r.runner === "string" ? r.runner : r.runner.kind) : "";
					var flat = {
						provider: r && typeof r.provider === "string" ? r.provider : "",
						model: r && typeof r.model === "string" ? r.model : "",
						effort: r && typeof r.effort === "string" ? r.effort : "",
						runnerKind: (isCodexRunnerKind(rk) || rk === "dsh") ? rk : "", codexModel: "", codexEffort: "",
					};
					if (isCodexRunnerKind(rk) && r.runner && typeof r.runner === "object") {
						flat.codexModel = typeof r.runner.model === "string" ? r.runner.model : "";
						flat.codexEffort = typeof r.runner.effort === "string" ? r.runner.effort : "";
					}
					return flat;
				}),
				engCoderMaxTokens: effective && effective.engCoderMaxTokens !== undefined ? String(effective.engCoderMaxTokens) : "",
				engCoderEffort: effective && typeof effective.engCoderEffort === "string" ? effective.engCoderEffort : "",
				// UI-5（R5 §7.2）：dsh 后台任务挂死兜底截止（顶层全局字段——effective 数字 → 表单串）
				dshBackgroundTimeoutMs: effective && effective.dshBackgroundTimeoutMs !== undefined ? String(effective.dshBackgroundTimeoutMs) : "",
				// D-29：consultTimeoutMs / engTokenTtlMs（顶层全局字段——effective 数字 → 表单串）
				consultTimeoutMs: effective && effective.consultTimeoutMs !== undefined ? String(effective.consultTimeoutMs) : "",
				engTokenTtlMs: effective && effective.engTokenTtlMs !== undefined ? String(effective.engTokenTtlMs) : "",
				codexCli: {
					executable: typeof ccSrc.executable === "string" ? ccSrc.executable : "",
					model: typeof ccSrc.model === "string" ? ccSrc.model : "",
					proxyMode: typeof ccSrc.proxyMode === "string" ? ccSrc.proxyMode : "",
					proxyUrl: typeof ccSrc.proxyUrl === "string" ? ccSrc.proxyUrl : "",
					agentsMdPolicy: typeof ccSrc.agentsMdPolicy === "string" ? ccSrc.agentsMdPolicy : "",
					defaultTimeoutMs: typeof ccSrc.defaultTimeoutMs === "number" ? String(ccSrc.defaultTimeoutMs) : "",
					budgetCapMs: typeof ccSrc.budgetCapMs === "number" ? String(ccSrc.budgetCapMs) : "",
					idleTimeoutMs: typeof ccSrc.idleTimeoutMs === "number" ? String(ccSrc.idleTimeoutMs) : "",
					// UI-4（R2 §4.5/D-14）：全局 codex 并发上限（缺省 8）
					maxConcurrent: typeof ccSrc.maxConcurrent === "number" ? String(ccSrc.maxConcurrent) : "",
					engCoderRunner: typeof ccSrc.engCoderRunner === "string" ? ccSrc.engCoderRunner : "",
				},
				// 批 36-补2（设计档 §十七 §17.4）：个人任务台账三键。**从传入的层播种**——本函数在
				// refreshView 里的实参就是 `user` 层（评审 #8：base 值不预填，避免「无改动保存把 base
				// 快照进 user 层」）；user 层没有 `ledger` ⇒ 显示**内置默认**（§17.4 空态，标注在卡片上）。
				ledger: ledgerToDraft(effective && effective.ledger),
				// 没动过就不发（见 draftToPayload 的同名注释）
				ledgerDirty: false,
				codexDirty: false,
			};
		}

		/** UI-3（R4/D-12）：保存后草稿合并——未触碰字段重放服务端新值（seeded），busy 窗口内
		 *  触碰的字段保留用户值（cur）。touched = 路径表：
		 *  - 标量字段按点路径：如 "advisor.round1.provider" / "advisor.includeProjectGuide" /
		 *    "engCoderEffort" / "dshBackgroundTimeoutMs"（R5 UI-5）/ "codexCli.proxyUrl" / "codexCli"（整节——结构上 codexCli 无增删行，
		 *    整节触碰仅防御性保留）；
		 *  - 池（consultModels）按整池保留：行字段（runnerKind/provider/model/effort/…）结构互相关联
		 *    （runner 切换隐藏 dsh 字段、保存侧净化会过滤空行重排索引），按行索引逐字段保留会在
		 *    行序漂移时错位——整池保留 + poolDirty=true（未触碰行的值本就等于保存值，行为等价）。
		 *  保留任何 codexCli/池字段时同步置 codexDirty/poolDirty（否则下次保存静默不发该节，
		 *  保留的编辑永远落不了盘）。
		 *  组字段的派生重置（provider 变更清 model、codexModel 变更清 codexEffort）在触碰记录侧
		 *  一并标记（见 setGroupField）——保留用户 provider 而重放服务端 model 会拼出不匹配对。
		 */
		function mergeDraftPreservingTouched(seeded, cur, touched) {
			if (!cur || typeof cur !== "object") return seeded;
			var next = JSON.parse(JSON.stringify(seeded));
			var curOf = function (parts, fallback) {
				var v = cur;
				for (var i = 0; i < parts.length; i++) {
					if (!v || typeof v !== "object") return fallback;
					v = v[parts[i]];
				}
				return v === undefined ? fallback : v;
			};
			var setOf = function (parts, value) {
				var v = next;
				for (var i = 0; i < parts.length - 1; i++) {
					if (!v[parts[i]] || typeof v[parts[i]] !== "object") v[parts[i]] = {};
					v = v[parts[i]];
				}
				v[parts[parts.length - 1]] = value;
			};
			GROUP_KEYS.forEach(function (gk) {
				["provider", "model", "effort", "timeoutMs", "runnerKind", "codexModel", "codexEffort"].forEach(function (f) {
					if (touched["advisor." + gk + "." + f]) {
						setOf(["advisor", gk, f], curOf(["advisor", gk, f], ""));
					}
				});
			});
			if (touched["advisor.includeProjectGuide"]) {
				setOf(["advisor", "includeProjectGuide"], !!curOf(["advisor", "includeProjectGuide"], false));
			}
			if (touched["advisor.maxOutputTokens"]) {
				setOf(["advisor", "maxOutputTokens"], curOf(["advisor", "maxOutputTokens"], ""));
			}
			// 批 5（FR-CB5）：清空 = 删除该键（回落自动跟随模型窗口——与既有 touched/setOf 机制一致）
			if (touched["advisor.contextTokens"]) {
				setOf(["advisor", "contextTokens"], curOf(["advisor", "contextTokens"], ""));
			}
			// 批 7（D-P4/J11）· 批 13（R-6）：三个声明键——清空 = 撤销声明（下一次保存把 "" 送出 ⇒ 服务端删键）
			PROJECT_DOC_KEYS.forEach(function (k) {
				if (touched["advisor." + k]) {
					setOf(["advisor", k], curOf(["advisor", k], ""));
				}
			});
			if (touched["engCoderMaxTokens"]) next.engCoderMaxTokens = curOf(["engCoderMaxTokens"], "");
			if (touched["engCoderEffort"]) next.engCoderEffort = curOf(["engCoderEffort"], "");
			if (touched["dshBackgroundTimeoutMs"]) next.dshBackgroundTimeoutMs = curOf(["dshBackgroundTimeoutMs"], ""); // R5 UI-5：busy 窗口内的编辑保留
			if (touched["consultTimeoutMs"]) next.consultTimeoutMs = curOf(["consultTimeoutMs"], ""); // D-29：busy 窗口内的编辑保留
			if (touched["engTokenTtlMs"]) next.engTokenTtlMs = curOf(["engTokenTtlMs"], "");         // D-29：同上
			var ccTouched = touched["codexCli"]
				|| Object.keys(touched).some(function (k) { return k.indexOf("codexCli.") === 0; });
			if (ccTouched) {
				if (touched["codexCli"]) {
					next.codexCli = JSON.parse(JSON.stringify(cur.codexCli || {}));
				} else {
					["executable", "model", "proxyMode", "proxyUrl", "agentsMdPolicy", "defaultTimeoutMs", "budgetCapMs", "idleTimeoutMs", "maxConcurrent", "engCoderRunner"].forEach(function (f) {
						if (touched["codexCli." + f]) next.codexCli[f] = curOf(["codexCli", f], "");
					});
				}
				next.codexDirty = true; // 保留的编辑必须随下次保存发出（否则永远落不了盘）
			}
			if (touched["consultModels"]
				|| Object.keys(touched).some(function (k) { return k.indexOf("consultModels") === 0; })) {
				next.consultModels = JSON.parse(JSON.stringify(Array.isArray(cur.consultModels) ? cur.consultModels : []));
				next.poolDirty = true; // 同上：整池保留 → 下次保存显式整体替换
			}
			// 批 36-补2（设计档 §十七 §17.4）：台账三键整节保留（与 codexCli 同款：结构无增删行，
			// 整节保留即等价）——保留的编辑必须随下次保存发出，否则落不了盘（ledgerDirty = true）。
			if (touched["ledger"]
				|| Object.keys(touched).some(function (k) { return k.indexOf("ledger.") === 0; })) {
				next.ledger = JSON.parse(JSON.stringify(cur.ledger || ledgerToDraft(null)));
				next.ledgerDirty = true;
			}
			return next;
		}
		//#endregion

		//#region 输入控件（catalog 可用 → select；不可用 → 文本输入 + 提示，实施确认项 5）

		/** provider 下拉/文本。catalog: {ok, providers: [{id,name}], byId}；draftValue 未出现在目录时补一行。
		 *  disabled（UI-3/D-12）：busy 窗口内禁用——保存竞态防护（表单输入全禁，非仅按钮）。 */
		function ProviderInput(props) {
			var catalog = props.catalog, value = props.value, onChange = props.onChange;
			var disabled = !!props.disabled;
			if (catalog && catalog.ok && catalog.providers.length > 0) {
				var ids = catalog.providers.map(function (p) { return p.id; });
				var extra = value && ids.indexOf(value) === -1 ? [value] : [];
				return h("select", {
					className: "tc-field",
					value: value || "",
					disabled: disabled,
					onChange: function (e) { onChange(e.target.value); },
				}, [
					h("option", { key: "", value: "" }, "（未设——跟随解析链）"),
					extra.map(function (v) {
						return h("option", { key: "x" + v, value: v }, v + "（未在注册表）");
					}),
					catalog.providers.map(function (p) {
						return h("option", { key: p.id, value: p.id }, p.id + (p.name && p.name !== p.id ? " — " + p.name : ""));
					}),
				]);
			}
			return h("div", { className: "tc-stack" }, [
				h("input", {
					className: "tc-field", type: "text", placeholder: "provider 路由键（如 acme）",
					value: value || "",
					disabled: disabled,
					onChange: function (e) { onChange(e.target.value); },
				}),
				h("div", { className: "tc-hint" }, "provider/model 目录不可用（" + ((catalog && catalog.note) || "原因未知") + "）——手动输入 provider 路由键（保存时后端尽力校验存在性）。"),
			]);
		}

		function ModelInput(props) {
			var catalog = props.catalog, provider = props.provider, value = props.value, onChange = props.onChange;
			var disabled = !!props.disabled;
			var modelIds = [];
			if (catalog && catalog.ok && provider) {
				var group = catalog.byGroup[provider];
				if (group && Array.isArray(group.models)) modelIds = group.models.map(function (m) { return m.id; });
			}
			if (catalog && catalog.ok && modelIds.length > 0) {
				var extra = value && modelIds.indexOf(value) === -1 ? [value] : [];
				return h("select", {
					className: "tc-field",
					value: value || "",
					disabled: !provider || disabled,
					onChange: function (e) { onChange(e.target.value); },
				}, [
					h("option", { key: "", value: "" }, provider ? "（未设——跟随解析链）" : "（先选 provider）"),
					extra.map(function (v) {
						return h("option", { key: "x" + v, value: v }, v + "（未在注册表）");
					}),
					modelIds.map(function (mid) {
						return h("option", { key: mid, value: mid }, mid);
					}),
				]);
			}
			return h("input", {
				className: "tc-field", type: "text", placeholder: "model id",
				value: value || "",
				disabled: disabled,
				onChange: function (e) { onChange(e.target.value); },
			});
		}

		/** 推理档 effort：目录含该模型的 reasoningEfforts 时按模型档位（null 档不进下拉）；
		 *  UI-1（R1）：无确定模型上下文但目录可用时 → 目录档位并集（dsh 目录数据源，运行时 L1 兜底）；
		 *  目录不可用才回落静态枚举。当前值不在选项中时补一行「未在该模型档位」（防切换模型后丢失）。
		 *  disabled（UI-3/D-12）：busy 窗口内禁用。 */
		function EffortInput(props) {
			var catalog = props.catalog, provider = props.provider, model = props.model;
			var value = props.value, onChange = props.onChange;
			var disabled = !!props.disabled;
			var efforts = null;
			var unionMode = false;
			if (catalog && catalog.ok && provider && model) {
				var group = catalog.byGroup[provider];
				var m = group && Array.isArray(group.models) ? group.models.filter(function (x) { return x.id === model; })[0] : null;
				if (m && Array.isArray(m.efforts) && m.efforts.length > 0) efforts = m.efforts;
			}
			if (!efforts && catalog && catalog.ok && Array.isArray(catalog.providers)) {
				// UI-1（engCard dsh 后端）：目标模型 = 父代理路由（设置页不可知）→ 全目录档位并集
				//（收敛到 dsh 档位枚举域——目录里的越界档位保存必被校验拒，不下拉陷阱值）
				var seen = {};
				var union = [];
				(catalog.providers || []).forEach(function (p) {
					var g = catalog.byGroup && catalog.byGroup[p.id];
					(g && Array.isArray(g.models) ? g.models : []).forEach(function (mm) {
						(Array.isArray(mm.efforts) ? mm.efforts : []).forEach(function (e) {
							if (e && EFFORTS.indexOf(e) !== -1 && !seen[e]) { seen[e] = true; union.push(e); }
						});
					});
				});
				if (union.length > 0) {
					// 稳定排序：枚举序
					union.sort(function (a, b) { return EFFORTS.indexOf(a) - EFFORTS.indexOf(b); });
					efforts = union;
					unionMode = true;
				}
			}
			var list = efforts ?? EFFORTS;
			var inList = efforts ? efforts.indexOf(value) !== -1 : true;
			var extra = value && !inList ? [h("option", { key: "x" + value, value: value }, value + "（未在该模型档位）")] : [];
			return h("select", {
				className: props.narrow ? "tc-field narrow" : "tc-field",
				value: value || "",
				disabled: disabled,
				onChange: function (e) { onChange(e.target.value); },
			}, [
				h("option", { key: "", value: "" }, efforts
					? (unionMode ? "（不设——适配器默认；目标模型运行时校验）" : "（不设——模型默认）")
					: "（不设——适配器默认）"),
			].concat(extra, list.map(function (v) {
				return h("option", { key: v, value: v }, v);
			})));
		}

		/**
		 * runner 类型选择（一期 codex-runner / 批 33 增 app-server）：未设/dsh/codex-cli/codex-app-server。
		 * disabled（UI-3/D-12）：busy 窗口内禁用。
		 */
		function RunnerSelect(props) {
			return h("select", {
				className: "tc-field",
				value: props.value || "",
				disabled: !!props.disabled,
				onChange: function (e) { props.onChange(e.target.value); },
			}, [
				h("option", { key: "", value: "" }, "dsh（默认——DSH 模型路由）"),
				h("option", { key: "dsh", value: "dsh" }, "dsh（显式——DSH 模型路由）"),
				h("option", { key: "codex-cli", value: "codex-cli" }, "codex-cli（本地 Codex CLI 子进程）"),
				h("option", { key: "codex-app-server", value: "codex-app-server" }, "codex-app-server（平台 codex provider · 只读）"),
			]);
		}

		/**
		 * 批 33（FR-4 · 设置页提示面）：`codex-app-server` 行的**能力边界与配置告知**（N-6 明写）。
		 * 与 `lib/codex-app-server.mjs` 的 CODEX_APP_SERVER_MODEL_EFFORT_NOTE 同义（浏览器 bundle
		 * 无法 import lib 的 mjs ⇒ 保留一份字面，两处必须同时改）。
		 */
		var APP_SERVER_HINT = "codex-app-server = 平台自带 codex provider 的 app-server 传输面：**只读定位**"
			+ "（无人值守对审批一律拒绝/cancel，不要用于写任务——写任务请选 codex-cli）；"
			+ "本通道不消费 model/effort，模型由本机 Codex 配置决定（这两个下拉只用于展示标签）；超时与 consult/advisor 预算照旧生效。";

		/** codex 模型下拉（GET /codex/models 动态发现；失败降级手输）。disabled（UI-3/D-12）：busy 窗口内禁用。 */
		function CodexModelInput(props) {
			var cat = props.catalog, value = props.value, onChange = props.onChange;
			var disabled = !!props.disabled;
			if (cat && cat.ok && cat.models && cat.models.length > 0) {
				// 评审 C2：hide 模型默认折叠——仅当前已选中的 hide 值保留显示（否则还原时丢失）
				var visible = cat.models.filter(function (m) { return m.visibility !== "hide"; });
				var known = cat.models.some(function (m) { return m.slug === value; });
				var valueHidden = value && cat.models.some(function (m) { return m.slug === value && m.visibility === "hide"; });
				var extra = value && !known ? [h("option", { key: "x" + value, value: value }, value + "（未在目录）")] : [];
				return h("div", { className: "tc-stack" }, [
					h("select", {
						className: "tc-field",
						value: value || "",
						disabled: disabled,
						onChange: function (e) { onChange(e.target.value); },
					}, [
						h("option", { key: "", value: "" }, "（未设——用 codex 自身默认模型）"),
					].concat(extra, visible.map(function (m) {
						return h("option", { key: m.slug, value: m.slug }, m.slug + "（effort: " + m.efforts.join("/") + "）");
					}), valueHidden ? [h("option", { key: "h" + value, value: value }, value + "（hide）")] : [])),
					h("div", { className: "tc-hint" }, "目录来源：" + cat.source + " · " + (cat.fetchedAt || "").slice(0, 19).replace("T", " ") + " UTC"),
				]);
			}
			return h("div", { className: "tc-stack" }, [
				h("input", {
					className: "tc-field", type: "text", placeholder: "codex 模型 slug（目录发现失败——手动输入）",
					value: value || "",
					disabled: disabled,
					onChange: function (e) { onChange(e.target.value); },
				}),
				h("div", { className: "tc-hint" }, "模型目录发现失败：" + ((cat && cat.error) || "未知错误") + "——已降级手动输入。"),
			]);
		}

		/** codex effort 下拉：随所选模型联动（目录可用时），否则手输（透传）。disabled（UI-3/D-12）：busy 窗口内禁用。 */
		function CodexEffortInput(props) {
			var cat = props.catalog, model = props.model, value = props.value, onChange = props.onChange;
			var disabled = !!props.disabled;
			if (cat && cat.ok && cat.models && cat.models.length > 0) {
				var m = cat.models.filter(function (x) { return x.slug === model; })[0];
				var efforts = m && Array.isArray(m.efforts) ? m.efforts : [];
				if (efforts.length > 0) {
					var inList = efforts.indexOf(value) !== -1;
					var extra = value && !inList ? [h("option", { key: "x" + value, value: value }, value + "（未在目录）")] : [];
					return h("select", {
						className: "tc-field",
						value: value || "",
						disabled: !model || disabled,
						onChange: function (e) { onChange(e.target.value); },
					}, [
						h("option", { key: "", value: "" }, model ? "（未设——模型默认 " + m.defaultEffort + "）" : "（先选模型）"),
					].concat(extra, efforts.map(function (v) { return h("option", { key: v, value: v }, v); })));
				}
			}
			return h("input", {
				className: "tc-field", type: "text", placeholder: "effort（透传，如 low/high/xhigh）",
				value: value || "",
				disabled: disabled,
				onChange: function (e) { onChange(e.target.value); },
			});
		}
		//#endregion

		//#region 会话视图（U4：当前会话生效摘要 + apply/reset；无会话 → 复制命令降级）

		function copyText(text) {
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(function () {}, function () {});
					return true;
				}
			} catch (e) { /* fall through */ }
			return false;
		}

		function routeLine(label, r) {
			if (!r || r.ok === false) return label + ": 无完整路由（回落主代理/未配置）";
			return label + ": " + r.provider + ":" + r.model
				+ " · effort " + (r.effort || "（未设）")
				+ " · timeoutMs " + r.timeoutMs + "ms"
				+ "\n   来源：model " + r.pairSource + " · effort " + (r.effortSource || "—") + " · timeout " + (r.timeoutSource || "—");
		}

		function SessionCard(props) {
			var sessionId = props.sessionId;
			var summary = props.summary; // describeSessionView 结果（override + effective）或 null
			var busy = props.busy;
			var onApply = props.onApply;
			var onReset = props.onReset;
			var onRefresh = props.onRefresh;
			var hasOverride = !!(summary && summary.override);

			if (!sessionId) {
				// 取不到活动会话 id（实施确认项 4 降级）：提供「复制 advisor_config 命令」替代交互
				var cmd = 'advisor_config request={"action":"get"}';
				return h("div", { className: "tc-card" }, [
					h("div", { className: "tc-card-title" }, "当前会话视图"),
					h("div", { className: "tc-hint" }, "无法获取当前活动会话 id——在此会话的对话里手动执行（复制到输入框发送）："),
					h("div", { className: "tc-row" }, [
						h("textarea", {
							className: "tc-field tc-cmd", readOnly: true, rows: 2,
							value: cmd,
							onFocus: function (e) { e.target.select(); },
						}),
						h("button", {
							className: "tc-btn ghost", type: "button",
							onClick: function () { copyText(cmd); },
						}, "复制命令"),
					]),
				]);
			}

			var eff = summary && summary.effective ? summary.effective : null;
			return h("div", { className: "tc-card" }, [
				h("div", { className: "tc-card-title" }, [
					"当前会话生效摘要",
					h("span", { className: "tc-badge " + (hasOverride ? "on" : "") }, hasOverride ? "有会话覆盖" : "无覆盖（会话默认）"),
				]),
				h("div", { className: "tc-hint" }, "会话 " + sessionId.slice(0, 20) + (sessionId.length > 20 ? "…" : "") + "（生效优先级：会话覆盖 > 全局自定义 > 内置默认）"),
				h("pre", { className: "tc-summary" }, [
					eff ? routeLine("round1", eff.round1) : "…",
					"\n",
					eff ? routeLine("convergence", eff.convergence) : "…",
					"\nincludeProjectGuide: " + (eff && eff.includeProjectGuide ? eff.includeProjectGuide.value + "（来源 " + eff.includeProjectGuide.source + "）" : "false（默认）"),
				]),
				h("div", { className: "tc-row" }, [
					h("button", {
						className: "tc-btn", type: "button", disabled: busy,
						onClick: onApply,
					}, "应用到当前会话（表单 advisor 值）"),
					h("button", {
						className: "tc-btn ghost danger", type: "button", disabled: busy,
						onClick: onReset,
					}, "恢复会话默认"),
					h("button", {
						className: "tc-btn ghost", type: "button", disabled: busy,
						onClick: onRefresh,
					}, "刷新"),
				]),
			]);
		}
		//#endregion

		//#region 主页面

		function ThincoderPage(props) {
			var api = props.api;              // connection.api（可为空对象）
			var sessions = props.sessions;    // sessions 服务（可为空；useSessions kit hook 为主源）
			var useSessions = props.useSessions; // root 标准 kit：读取当前会话 id（owner {close} 本页不必须）

			var snap = useSessions ? useSessions(function (s) { return s; }) : null;
			var currentSessionId = snap && snap.current ? String(snap.current) : "";

			// —— 全局配置视图（GET /config 快照，供来源标注与表单基线） ——
			var [view, setView] = useState(null); // {base, user, effective}
			// —— 会话视图（GET /session） ——
			var [summary, setSummary] = useState(null);
			// —— provider/model 目录（connection.api.llm.*；失败降级文本输入） ——
			var [catalog, setCatalog] = useState(null); // {ok, providers, byGroup} | {ok:false}
			// —— codex 模型目录（GET /codex/models 动态发现；失败降级手输） ——
			var [codexModels, setCodexModels] = useState(null); // {ok, source, fetchedAt, models} | {ok:false, error}
			var [codexLoading, setCodexLoading] = useState(false);
			// —— 草稿 ——
			var [draft, setDraft] = useState(null);
			// —— UI ——
			var [msg, setMsg] = useState(null);   // {kind:'ok'|'error'|'info', text}
			var [busy, setBusy] = useState(false);
			var [errors, setErrors] = useState([]);
			// UI-3（R4/D-12）保存竞态防护：
			// - busyRef = busy 的同步镜像（ref 即时生效——setBusy 触发的重渲染落地前发生的事件
			//   也能读到 true，消除 state 闭包陈旧窗口）；
			// - busyTouchedRef = busy 窗口内被触碰的草稿字段路径表（enterBusy 起算）——保存成功后
			//   refreshView 只重放未触碰字段，触碰字段保留用户值并出提示条（防静默覆盖）。
			var busyRef = useRef(false);
			var busyTouchedRef = useRef({});
			function enterBusy() {
				busyRef.current = true;
				busyTouchedRef.current = {}; // 自保存/操作发起时起算（此前的编辑已进本次载荷）
				setBusy(true);
			}
			function exitBusy() {
				busyRef.current = false;
				setBusy(false);
			}
			/** busy 窗口内的草稿编辑 → 记录触碰路径（refreshView 合并保留的依据）。 */
			function touchDuringBusy(paths) {
				if (!busyRef.current) return;
				for (var i = 0; i < paths.length; i++) busyTouchedRef.current[paths[i]] = true;
			}

			var refreshView = useCallback(function () {
				return apiCall("GET", "/config").then(function (d) {
					if (!d || d.ok !== true) { setMsg({ kind: "error", text: "config API 不可用：" + ((d && d.error) || "未知错误") }); return { response: null, preserved: false }; }
					var user = d.user && typeof d.user === "object" ? d.user : {};
					setView({ base: d.base || {}, user: user, effective: d.effective || {} });
					// 评审 #8：草稿从 user 层播种（base 值不预填——避免「无改动保存把 base 快照进 user 层」；
					// 生效值已在各组卡片「当前生效基线」行展示，来源标注齐全）
					var seeded = effectiveToDraft(user);
					// 分歧审计 D1：user 层已有池 → 初始即 poolDirty（PUT 是整体替换——保存时不带池
					// 会把 user 层既有池清空回落 base）
					if (Array.isArray(user.consultModels)) seeded.poolDirty = true;
					// UI-3（R4/D-12）：busy 窗口内有触碰 → 不整体替换草稿——未触碰字段重放新值、
					// 触碰字段保留用户值（preserved 返回给调用方附提示条文案）；无触碰 → 现行整体播种。
					var touched = busyTouchedRef.current || {};
					var preserved = false;
					for (var k in touched) {
						if (Object.prototype.hasOwnProperty.call(touched, k)) { preserved = true; break; }
					}
					busyTouchedRef.current = {};
					if (preserved) {
						setDraft(function (cur) { return mergeDraftPreservingTouched(seeded, cur, touched); });
					} else {
						setDraft(seeded);
					}
					return { response: d, preserved: preserved };
				});
			}, []);

			var refreshSession = useCallback(function (sid) {
				if (!sid) { setSummary(null); return; }
				return apiCall("GET", "/session?sessionId=" + encodeURIComponent(sid)).then(function (d) {
					setSummary(d && d.ok === true ? d : null);
					if (d && d.ok === false && d.reason) setMsg({ kind: "info", text: "会话视图：" + d.reason });
				});
			}, []);

			// 目录加载（评审修复：服务端 /catalog 优先——直读 llm-pi-ai settings 注册表，不依赖
			// 客户端 RPC；RPC 降级次之；都失败 → 手输，且失败原因渲染可见，不再静默）
			function loadCatalogViaRpc(cb) {
				var cat = { ok: false, providers: [], byGroup: {} };
				function finish() {
					if (cat.providers.length > 0) cat.ok = true;
					cb(cat);
				}
				if (!api || typeof api.llm !== "object" || api.llm === null) { cat.note = "connection.api.llm 不可用"; finish(); return; }
				var jobs = [];
				try {
					if (typeof api.llm.providers === "function") {
						jobs.push(Promise.resolve(api.llm.providers({})).then(function (r) {
							var val = r && r.result ? r.result : r;
							if (val && val.ok === false) throw new Error((val.error && val.error.message) || "providers RPC failed");
							var list = (val && val.ok === true ? val.value : val) || {};
							var arr = Array.isArray(list.providers) ? list.providers : [];
							arr.forEach(function (p) { if (p && p.provider) cat.providers.push({ id: p.provider, name: p.displayName || p.provider }); });
						}).catch(function (e) { cat.note = String(e && e.message ? e.message : e); }));
					}
					if (typeof api.llm.models === "function") {
						jobs.push(Promise.resolve(api.llm.models({})).then(function (r) {
							var val = r && r.result ? r.result : r;
							if (val && val.ok === false) throw new Error((val.error && val.error.message) || "models RPC failed");
							var list = (val && val.ok === true ? val.value : val) || {};
							var groups = Array.isArray(list.groups) ? list.groups : [];
							groups.forEach(function (g) {
								if (g && g.id && Array.isArray(g.models)) cat.byGroup[g.id] = { models: g.models };
							});
						}).catch(function (e) {
							if (!cat.note) cat.note = String(e && e.message ? e.message : e);
						}));
					}
				} catch (e) {
					cat.note = String(e && e.message ? e.message : e);
				}
				if (jobs.length === 0) { cat.note = "RPC 方法不存在"; finish(); return; }
				Promise.all(jobs).then(finish, finish);
			}

			useEffect(function () {
				var cancelled = false;
				function merge(settings, rpc) {
					if (cancelled) return;
					var pm = {};
					var bg = {};
					function add(id, name, models, src) {
						if (!id || pm[id]) return;
						pm[id] = { id: id, name: name || id };
						bg[id] = {
							models: (models || []).map(function (m) {
								return { id: m.id, name: m.name, efforts: m.efforts };
							}).filter(function (m) { return m.id; }),
							source: src,
						};
					}
					// settings 覆盖层优先（模型/effort 完整，含 reasoningEfforts 富化）
					(settings && settings.ok ? settings.providers : []).forEach(function (p) {
						add(p.id, p.displayName || p.id, p.models || [], "settings");
					});
					// RPC 运行时目录补充内置路由（如 deepseek-official——不在 settings 覆盖层）
					(rpc && rpc.ok ? rpc.providers : []).forEach(function (p) {
						if (!p.id || pm[p.id]) return;
						var g = rpc.byGroup && rpc.byGroup[p.id];
						add(p.id, p.name || p.id, (g && g.models) || [], "rpc");
					});
					var providers = Object.keys(pm).map(function (k) { return pm[k]; });
					if (providers.length === 0) {
						setCatalog({ ok: false, note: "provider/model 目录不可用（" + ((settings && settings.error) || "catalog 无数据") + "；" + ((rpc && rpc.note) || "RPC 亦不可用") + "）" });
						return;
					}
					setCatalog({ ok: true, providers: providers, byGroup: bg, source: "merged" });
				}
				// 宿主 /catalog（settings 兜底目录，模型/effort 权威）→ RPC（运行时全量目录）
				// → 合并；两者皆败才降级手输。settings 目录已含模型的 provider 保留 settings 侧
				// 数据，RPC 只补 settings 缺失的内置路由。
				apiCall("GET", "/catalog").then(function (d) {
					if (cancelled) return;
					var settings = (d && d.ok === true && Array.isArray(d.providers) && d.providers.length > 0)
						? { ok: true, providers: d.providers }
						: { ok: false, error: (d && d.error) || "catalog 端点无数据" };
					loadCatalogViaRpc(function (rpc) {
						if (cancelled) return;
						merge(settings, rpc);
					});
				}).catch(function (e) {
					if (cancelled) return;
					loadCatalogViaRpc(function (rpc) {
						if (cancelled) return;
						merge({ ok: false, error: String(e && e.message ? e.message : e) }, rpc);
					});
				});
				return function () { cancelled = true; };
			}, [api]);

			// codex 模型目录加载（5.6 发现 API；失败 → CodexModelInput 内联降级手输）。
			// 评审 C3：executable 参数透传——草稿里改了 executable 后立即刷新也用新值。
			var loadCodexModels = useCallback(function (refresh, executable) {
				setCodexLoading(true);
				var qs = [];
				if (refresh) qs.push("refresh=1");
				if (executable) qs.push("executable=" + encodeURIComponent(executable));
				return apiCall("GET", "/codex/models" + (qs.length > 0 ? "?" + qs.join("&") : "")).then(function (d) {
					setCodexModels(d && d.ok === true ? d : { ok: false, error: (d && d.error) || "发现失败" });
					return d;
				}).finally(function () { setCodexLoading(false); });
			}, []);

			// 初始加载
			useEffect(function () {
				refreshView();
				loadCodexModels(false);
			}, [refreshView, loadCodexModels]);
			useEffect(function () {
				refreshSession(currentSessionId);
			}, [currentSessionId, refreshSession]);

			function setField(parts, value) {
				setDraft(function (d) {
					if (!d) return d;
					var next = JSON.parse(JSON.stringify(d));
					var cur = next;
					for (var i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
					cur[parts[parts.length - 1]] = value;
					return next;
				});
				setErrors([]);
				touchDuringBusy([parts.join(".")]); // UI-3（R4/D-12）：busy 窗口内的编辑记触碰（合并保留依据）
			}

			// 批 36-补2（设计档 §十七 §17.4）：台账三键的草稿写入。**改动即置 ledgerDirty**
			// （否则这次编辑永远发不出去——user 层原本没有 ledger 时默认不发送，见 draftToPayload）。
			function setLedgerField(field, value) {
				setDraft(function (d) {
					if (!d) return d;
					var next = JSON.parse(JSON.stringify(d));
					if (!next.ledger) next.ledger = ledgerToDraft(null);
					next.ledger[field] = value;
					next.ledgerDirty = true;
					return next;
				});
				setErrors([]);
				touchDuringBusy(["ledger." + field]); // busy 窗口内的编辑同样要保留（合并依据）
			}

			// 评审 C5：codex 模型变更 → 清 effort（旧 effort 对新模型可能非法，留空回落模型默认）
			function setGroupField(gk, field, value) {
				setDraft(function (d) {
					if (!d) return d;
					var next = JSON.parse(JSON.stringify(d));
					if (!next.advisor) next.advisor = {};
					if (!next.advisor[gk]) next.advisor[gk] = { provider: "", model: "", effort: "", timeoutMs: "" };
					next.advisor[gk][field] = value;
					if (field === "provider") next.advisor[gk].model = ""; // provider 变更重置 model
					if (field === "codexModel") next.advisor[gk].codexEffort = ""; // 模型变更重置 effort（枚举随模型）
					return next;
				});
				setErrors([]);
				// UI-3（R4/D-12）：派生重置的字段一并记触碰——合并保留用户 provider 而重放服务端
				// model 会拼出不匹配对（合并必须维持「provider 变更清 model」的表单不变式）
				var touched = ["advisor." + gk + "." + field];
				if (field === "provider") touched.push("advisor." + gk + ".model");
				if (field === "codexModel") touched.push("advisor." + gk + ".codexEffort");
				touchDuringBusy(touched);
			}

			function saveGlobal() {
				// 批 36-补2（§17.4 / §17.5）：台账三键的**提前提示**与既有内联校验合并成一处
				// （前端校验只用 `ledgerDraftErrors`——规则不在这里重写；最终裁决仍是后端 PUT）。
				var errs = validateDraft(draft).concat(ledgerDraftErrors(draft));
				if (errs.length > 0) { setErrors(errs); return; }
				enterBusy();
				setMsg(null);
				apiCall("PUT", "/config", { config: draftToPayload(draft) }).then(function (d) {
					if (!d || d.ok !== true) {
						var list = (d && Array.isArray(d.errors) ? d.errors : []);
						setMsg({ kind: "error", text: list.length > 0 ? "保存失败：" + list.join("；") : ("保存失败：" + ((d && d.error) || "未知错误")) });
						return;
					}
					// UI-3（R4/D-12）：保存后刷新——若 busy 窗口内有触碰（表单被编辑），合并保留 +
					// 提示条；无触碰 → 常规整体播种（现行行为）。刷新失败时错误信息由 refreshView
					// 设置（不覆盖——下方分支在其后追加「保存已生效」info 行，双事实如实呈现）。
					return refreshView().then(function (r) {
						if (!r || !r.response) {
							// R4 收尾 #3（code review 跟进）：保存成功但刷新失败——refreshView 已
							// 设置错误信息（不覆盖），经 functional setMsg 在其后追加 info 行，双事实
							// 如实呈现（保存已生效 + 刷新视图失败）。functional 更新取到 refreshView
							// 先入队的最新 msg（闭包里的 msg 是陈旧 state 值，不可读）。
							setMsg(function (m) {
								return { kind: (m && m.kind) || "info", text: (m && m.text ? m.text + "\n" : "") + "保存已生效，但刷新视图失败" };
							});
							return;
						}
						var note = r.preserved ? "；保存期间有编辑，已保留你的修改" : "";
						setMsg({ kind: "ok", text: "已保存——写入自定义配置，无需重启，下次评审/工具调用即生效" + ((d.notes && d.notes.length > 0) ? "；注意：" + d.notes.join("；") : "") + note });
					});
				}).finally(function () { exitBusy(); });
			}

			function restoreGlobal() {
				if (typeof window !== "undefined" && window.confirm
					&& !window.confirm("恢复默认会删除你在本页保存的全部自定义配置，回落到插件内置默认。确定继续？")) {
					return;
				}
				enterBusy();
				setMsg(null);
				apiCall("DELETE", "/config").then(function (d) {
					if (!d || d.ok !== true) {
						setMsg({ kind: "error", text: "恢复默认失败：" + ((d && d.error) || "未知错误") });
						return;
					}
					return refreshView().then(function (r) {
						if (!r || !r.response) return; // 刷新失败：错误信息由 refreshView 设置（不覆盖）
						var note = r.preserved ? "；保存期间有编辑，已保留你的修改" : "";
						setMsg({ kind: "ok", text: "已恢复默认——自定义配置已删除，回落到内置默认（cordis.patch.yml 里的配置需重启 DSH 才重新读取）" + note });
					});
				}).finally(function () { exitBusy(); });
			}

			function applySession() {
				if (!currentSessionId) return;
				var errs = validateDraft(draft);
				if (errs.length > 0) { setErrors(errs); return; }
				var advisor = {};
				GROUP_KEYS.forEach(function (gk) {
					var g = draft.advisor[gk] || {};
					// D-13（R4 注释修正，登记表 D-23 残项）：服务端 sanitizeSessionAdvisor 一期即接受
					// runner 字段（validateAdvisorGroup/sanitizeGroup 归一化保留 codex-cli 行）——旧注释
					// 「不收 runner」与事实相反。本页「应用到会话」仍只发 provider/model/effort/timeoutMs
					// 是有意的 UX 取舍：runner/codex 模型属全局配置面（Codex CLI 卡片），会话级 runner
					// 覆盖走 advisor_config 工具 set roundN.runner（R4 后三面均接受）。
					// 批 33：app-server 组同款（它同样不经 provider/model 路由）。
					if (isCodexRunnerKind(g.runnerKind)) return;
					var out = {};
					if (g.provider) out.provider = g.provider;
					if (g.model) out.model = g.model;
					if (g.effort) out.effort = g.effort;
					if (g.timeoutMs !== "" && g.timeoutMs !== undefined && g.timeoutMs !== null) out.timeoutMs = Number(g.timeoutMs);
					if (Object.keys(out).length > 0) advisor[gk] = out;
				});
				if (draft.advisor && typeof draft.advisor.includeProjectGuide === "boolean") advisor.includeProjectGuide = draft.advisor.includeProjectGuide;
				enterBusy();
				apiCall("POST", "/apply-session", { sessionId: currentSessionId, advisor: advisor }).then(function (d) {
					if (!d || d.ok !== true) {
						var list = (d && Array.isArray(d.errors) ? d.errors : []);
						setMsg({ kind: "error", text: "应用到会话失败：" + (list.length > 0 ? list.join("；") : ((d && d.reason) || (d && d.error) || "未知错误")) });
						return;
					}
					setMsg({ kind: "ok", text: "已应用到当前会话（advisorOverride 更新）" });
					return refreshSession(currentSessionId);
				}).finally(function () { exitBusy(); });
			}

			function resetSession() {
				if (!currentSessionId) return;
				enterBusy();
				apiCall("DELETE", "/session?sessionId=" + encodeURIComponent(currentSessionId)).then(function (d) {
					if (!d || d.ok !== true) {
						setMsg({ kind: "error", text: "恢复会话默认失败：" + ((d && d.reason) || (d && d.error) || "未知错误") });
						return;
					}
					setMsg({ kind: "ok", text: "已恢复会话默认（advisorOverride 清除）" });
					return refreshSession(currentSessionId);
				}).finally(function () { exitBusy(); });
			}

			if (!view || !draft) {
				// 评审 #7：加载失败（config API 不可用等）时错误可见 + 可重试，而非永久 loading
				return h("div", { className: "tc-page" }, [
					msg ? h("div", { className: "tc-msg " + msg.kind }, msg.text) : null,
					h("p", { className: "tc-hint" }, view ? "正在初始化表单…" : "加载 Thincoder 配置…"),
					msg && msg.kind === "error"
						? h("button", { className: "tc-btn", type: "button", onClick: function () { setMsg(null); refreshView(); } }, "重试")
						: null,
				]);
			}

			var base = view.base;
			var user = view.user;

			// —— 每张组的当前生效基线（读视图快照，含来源标注：U2） ——
			function baseline(gk) {
				var effG = view.effective.advisor && view.effective.advisor[gk] ? view.effective.advisor[gk] : {};
				var parts = ["advisor", gk];
				var cells = [
					{ label: "provider", value: effG.provider, src: fieldSource(base, user, parts.concat(["provider"])) },
					{ label: "model", value: effG.model, src: fieldSource(base, user, parts.concat(["model"])) },
					{ label: "effort", value: effG.effort, src: fieldSource(base, user, parts.concat(["effort"])) },
					{ label: "timeoutMs", value: effG.timeoutMs, src: fieldSource(base, user, parts.concat(["timeoutMs"])) },
				];
				return cells.map(function (c) {
					var val = c.value === undefined || c.value === null ? "—" : String(c.value);
					return c.label + ": " + val + "（" + c.src + "）";
				}).join("  ·  ");
			}

			function groupCard(gk) {
				var g = draft.advisor[gk] || {};
				var desc = gk === "round1"
					? "第一次全量评审用这组模型——建议旗舰模型，预算给足（大范围审查最慢）。"
					: "复审（Round 2+）核销用这组——建议快档模型 + 低推理档，提速不降协议。";
				var isCodex = isCodexRunnerKind(g.runnerKind);
				var gridChildren = isCodex ? [
					label("codex 模型（动态目录）", h(CodexModelInput, {
						catalog: codexModels, value: g.codexModel, disabled: busy,
						onChange: function (v) { setGroupField(gk, "codexModel", v); },
					})),
					label("codex effort（随模型联动）", h(CodexEffortInput, {
						catalog: codexModels, model: g.codexModel, value: g.codexEffort, disabled: busy,
						onChange: function (v) { setGroupField(gk, "codexEffort", v); },
					})),
					label("单轮超时（毫秒）", h("input", {
						className: "tc-field", type: "number", min: TIMEOUT_MIN, max: TIMEOUT_MAX, step: 1000,
						placeholder: "缺省 " + (gk === "round1" ? "600000" : "300000"),
						value: g.timeoutMs,
						disabled: busy,
						onChange: function (e) { setGroupField(gk, "timeoutMs", e.target.value); },
					})),
				] : [
					label("provider（模型提供方）", h(ProviderInput, {
						catalog: catalog, value: g.provider, disabled: busy,
						onChange: function (v) { setGroupField(gk, "provider", v); },
					})),
					label("model（模型）", h(ModelInput, {
						catalog: catalog, provider: g.provider, value: g.model, disabled: busy,
						onChange: function (v) { setGroupField(gk, "model", v); },
					})),
					label("推理档 effort", h(EffortInput, {
						catalog: catalog, provider: g.provider, model: g.model,
						value: g.effort, disabled: busy,
						onChange: function (v) { setGroupField(gk, "effort", v); },
					})),
					label("单轮超时（毫秒）", h("input", {
						className: "tc-field", type: "number", min: TIMEOUT_MIN, max: TIMEOUT_MAX, step: 1000,
						placeholder: "缺省 " + (gk === "round1" ? "600000" : "300000"),
						value: g.timeoutMs,
						disabled: busy,
						onChange: function (e) { setGroupField(gk, "timeoutMs", e.target.value); },
					})),
				];
				return h("div", { className: "tc-card", key: gk }, [
					h("div", { className: "tc-card-title" }, GROUP_LABEL[gk]),
					h("div", { className: "tc-hint" }, desc + " 留空则跟随当前会话模型/默认值。"),
					g.runnerKind === "codex-app-server" ? h("div", { className: "tc-hint" }, APP_SERVER_HINT) : null,
					h("div", { className: "tc-grid" }, [
						label("执行后端 runner", h(RunnerSelect, {
							value: g.runnerKind, disabled: busy,
							onChange: function (v) { setGroupField(gk, "runnerKind", v); },
						})),
					].concat(gridChildren)),
					h("div", { className: "tc-baseline" }, "当前生效： " + baseline(gk)),
				]);
			}

			function label(text, control) {
				return h("label", { className: "tc-fieldbox" }, [
					h("span", { className: "tc-fieldname" }, text),
					control,
				]);
			}

			function consultPoolCard() {
				var rows = draft.consultModels || [];
				var effSrc = fieldSource(base, user, ["consultModels"]);
				return h("div", { className: "tc-card", key: "pool" }, [
					h("div", { className: "tc-card-title" }, "consult / escalate 模型池"),
					h("div", { className: "tc-hint" }, "会诊（多模型并行分析）与飞刀（交给更强模型改代码）共用此池；第一行是飞刀默认。增删行后点「保存全局默认」。来源：" + effSrc + "。"),
					rows.some(function (r) { return r.runnerKind === "codex-app-server"; })
						? h("div", { className: "tc-hint" }, APP_SERVER_HINT) : null,
					h("div", { className: "tc-colhead" }, [
						h("span", null, "runner"),
						h("span", null, "provider / codex 模型"),
						h("span", null, "model / effort"),
						h("span", { style: { textAlign: "right" } }, ""),
					]),
					rows.map(function (row, i) {
						var rowCodex = isCodexRunnerKind(row.runnerKind);
						return h("div", { className: "tc-row pool", key: "row" + i }, [
							h(RunnerSelect, {
								value: row.runnerKind || "", disabled: busy,
								onChange: function (v) { setPoolRow(i, "runnerKind", v); },
							}),
							rowCodex
								? h(CodexModelInput, {
									catalog: codexModels, value: row.codexModel, disabled: busy,
									onChange: function (v) { setPoolRow(i, "codexModel", v); },
								})
								: h(ProviderInput, {
									catalog: catalog, value: row.provider, disabled: busy,
									onChange: function (v) { setPoolRow(i, "provider", v); },
								}),
							rowCodex
								? h(CodexEffortInput, {
									catalog: codexModels, model: row.codexModel, value: row.codexEffort, disabled: busy,
									onChange: function (v) { setPoolRow(i, "codexEffort", v); },
								})
								: h("div", { className: "tc-stack" }, [
									h(ModelInput, {
										catalog: catalog, provider: row.provider, value: row.model, disabled: busy,
										onChange: function (v) { setPoolRow(i, "model", v); },
									}),
									// UI-1（R1）：dsh 行 effort 下拉按行 provider+model 从 /catalog 取档位（替换静态枚举）
									h(EffortInput, {
										catalog: catalog, provider: row.provider, model: row.model, narrow: true,
										value: row.effort, disabled: busy,
										onChange: function (v) { setPoolRow(i, "effort", v); },
									}),
								]),
							h("button", {
								className: "tc-btn ghost danger", type: "button", disabled: busy,
								onClick: function () { removePoolRow(i); },
							}, "删"),
						]);
					}),
					h("button", {
						className: "tc-btn ghost", type: "button", disabled: busy,
						onClick: addPoolRow,
					}, "+ 添加模型"),
				]);
			}

			function setPoolRow(i, field, value) {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true; // 评审 #4：池被编辑 → 保存时显式整体替换
					var rows = next.consultModels || (next.consultModels = []);
					if (!rows[i]) rows[i] = { provider: "", model: "", effort: "", runnerKind: "", codexModel: "", codexEffort: "" };
					rows[i][field] = value;
					if (field === "provider") rows[i].model = "";
					if (field === "runnerKind" && isCodexRunnerKind(value)) rows[i].model = ""; // 切到 codex 族：清 dsh model
					if (field === "codexModel") rows[i].codexEffort = ""; // 评审 C5：模型变更重置 effort
					return next;
				});
				setErrors([]);
				// UI-3（R4/D-12）：池按整池保留（行结构互相关联 + 保存侧净化可能重排索引——见 merge 注释）
				touchDuringBusy(["consultModels"]);
			}
			function addPoolRow() {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true;
					var rows = next.consultModels || (next.consultModels = []);
					if (rows.length >= 5) return d;
					rows.push({ provider: "", model: "", effort: "", runnerKind: "", codexModel: "", codexEffort: "" });
					return next;
				});
				setErrors([]);
				touchDuringBusy(["consultModels"]); // 结构性变更：整池保留
			}

			function codexCliCard() {
				var cc = draft.codexCli || {};
				var effSrc = fieldSource(base, user, ["codexCli"]);
				var catInfo = codexModels && codexModels.ok
					? "模型目录已拉取：" + codexModels.models.length + " 个模型（来源 " + codexModels.source + " · " + (codexModels.fetchedAt || "").slice(0, 19).replace("T", " ") + " UTC）"
					: "模型目录未拉取：" + ((codexModels && codexModels.error) || "…");
				return h("div", { className: "tc-card", key: "codex" }, [
					h("div", { className: "tc-card-title" }, "Codex CLI runner（codex-cli 后端全局默认）"),
					h("div", { className: "tc-hint" }, "advisor/consult 池行选 codex-cli 后，从这里取可执行/代理/AGENTS.md 策略/超时。全部可留空（内置默认：codex · inherit · disable · 600000）。当前来源：" + effSrc + "。"),
					h("div", { className: "tc-hint" }, "选 codex-app-server 的行**不读**本节（走平台 provider，只读；见上方池/组内提示）。"),
					h("div", { className: "tc-hint" }, catInfo),
					h("div", { className: "tc-grid" }, [
						label("executable（可执行名/绝对路径）", h("input", {
							className: "tc-field", type: "text", placeholder: "默认 codex（双安装机器建议填绝对路径）",
							value: cc.executable,
							disabled: busy,
							onChange: function (e) { setCodexField("executable", e.target.value); },
						})),
						label("codex 默认模型（行未选模型时用）", h(CodexModelInput, {
							catalog: codexModels, value: cc.model || "", disabled: busy,
							onChange: function (v) { setCodexField("model", v); },
						})),
						label("proxyMode（代理）", h("select", {
							className: "tc-field",
							value: cc.proxyMode || "",
							disabled: busy,
							onChange: function (e) { setCodexField("proxyMode", e.target.value); },
						}, [
							h("option", { key: "", value: "" }, "（未设——默认 inherit 继承环境）"),
							CODEX_PROXY_MODES.map(function (v) { return h("option", { key: v, value: v }, v); }),
						])),
						cc.proxyMode === "url" ? label("proxyUrl（http(s)://）", h("input", {
							className: "tc-field", type: "text", placeholder: "http://127.0.0.1:7897",
							value: cc.proxyUrl,
							disabled: busy,
							onChange: function (e) { setCodexField("proxyUrl", e.target.value); },
						})) : null,
						label("AGENTS.md 策略", h("select", {
							className: "tc-field",
							value: cc.agentsMdPolicy || "",
							disabled: busy,
							onChange: function (e) { setCodexField("agentsMdPolicy", e.target.value); },
						}, [
							h("option", { key: "", value: "" }, "（未设——默认 disable 防行为链劫持）"),
							CODEX_AGENTSMD.map(function (v) { return h("option", { key: v, value: v }, v); }),
						])),
						label("defaultTimeoutMs（单次超时）", h("input", {
							className: "tc-field", type: "number", min: 30000, max: 3600000, step: 1000,
							placeholder: "默认 600000",
							value: cc.defaultTimeoutMs,
							disabled: busy,
							onChange: function (e) { setCodexField("defaultTimeoutMs", e.target.value); },
						})),
						label("budgetCapMs（codex 预算上限，须低于 run_code maxWallMs）", h("input", {
							className: "tc-field", type: "number", min: 60000, max: 3600000, step: 100000,
							placeholder: "默认 540000（提高 run_code maxWallMs 后同步上调）",
							value: cc.budgetCapMs,
							disabled: busy,
							onChange: function (e) { setCodexField("budgetCapMs", e.target.value); },
						})),
						label("idleTimeoutMs（无输出判假死，二期）", h("input", {
							className: "tc-field", type: "number", min: 15000, max: 3600000, step: 1000,
							placeholder: "默认 300000（写任务；留空关闭）",
							value: cc.idleTimeoutMs,
							disabled: busy,
							onChange: function (e) { setCodexField("idleTimeoutMs", e.target.value); },
						})),
						label("maxConcurrent（全局 codex 进程上限，R2 UI-4）", h("input", {
							className: "tc-field", type: "number", min: 1, max: 64, step: 1,
							placeholder: "默认 8（全机制叠加共享；超限 fail-fast 不排队）",
							value: cc.maxConcurrent,
							disabled: busy,
							onChange: function (e) { setCodexField("maxConcurrent", e.target.value); },
						})),
						label("eng_coder 后端（二期 T2.2）", h("select", {
							className: "tc-field",
							value: cc.engCoderRunner || "",
							disabled: busy,
							onChange: function (e) { setCodexField("engCoderRunner", e.target.value); },
						}, [
							h("option", { key: "", value: "" }, "dsh（默认——DSH 实现子代理）"),
							h("option", { key: "dsh", value: "dsh" }, "dsh（显式）"),
							h("option", { key: "codex-cli", value: "codex-cli" }, "codex-cli（本地 Codex CLI 写任务）"),
						])),
					]),
					h("div", { className: "tc-row" }, [
						h("button", {
							className: "tc-btn ghost", type: "button", disabled: busy || codexLoading,
							onClick: function () {
								// 评审 C3/C4：刷新带草稿 executable；结果按 ok/error 分别反馈
								loadCodexModels(true, (draft.codexCli && draft.codexCli.executable) || "").then(function (d) {
									if (d && d.ok === true) setMsg({ kind: "ok", text: "模型目录已刷新：" + d.models.length + " 个模型（来源 " + d.source + "）" });
									else setMsg({ kind: "error", text: "模型目录刷新失败：" + ((d && d.error) || "未知错误") + "——下拉已降级手输" });
								});
							},
						}, codexLoading ? "刷新中…" : "刷新模型目录"),
					]),
				]);
			}

			function setCodexField(field, value) {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.codexDirty = true;
					if (!next.codexCli) next.codexCli = {};
					next.codexCli[field] = value;
					return next;
				});
				setErrors([]);
				touchDuringBusy(["codexCli." + field]); // UI-3（R4/D-12）：busy 窗口内的编辑记触碰
			}
			function removePoolRow(i) {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true;
					next.consultModels = (next.consultModels || []).filter(function (_, idx) { return idx !== i; });
					return next;
				});
				setErrors([]);
				touchDuringBusy(["consultModels"]); // 结构性变更：整池保留
			}

			function engCard() {
				var effSrcMax = fieldSource(base, user, ["engCoderMaxTokens"]);
				var effSrcEff = fieldSource(base, user, ["engCoderEffort"]);
				var effMax = view.effective.engCoderMaxTokens;
				var effEff = view.effective.engCoderEffort;
				// UI-1（R1）：engCoderEffort 下拉目录化——eng_coder 后端随 codexCli.engCoderRunner 联动：
				// codex-cli 后端 → 目标模型 = codexCli.model（codex models catalog 档位联动）；
				// dsh 后端 → 目标模型 = 父代理路由（设置页不可知）→ dsh 目录档位并集（运行时 L1 兜底）。
				var engCodexRunner = !!(draft.codexCli && draft.codexCli.engCoderRunner === "codex-cli");
				var engEffortControl = engCodexRunner
					? h(CodexEffortInput, {
						catalog: codexModels, model: (draft.codexCli && draft.codexCli.model) || "",
						value: draft.engCoderEffort, disabled: busy,
						onChange: function (v) { setField(["engCoderEffort"], v); },
					})
					: h(EffortInput, {
						catalog: catalog, value: draft.engCoderEffort, disabled: busy,
						onChange: function (v) { setField(["engCoderEffort"], v); },
					});
				return h("div", { className: "tc-card", key: "eng" }, [
					h("div", { className: "tc-card-title" }, "eng_coder 子代理资源（F9）"),
					h("div", { className: "tc-hint" }, "实现子代理输出预算与推理档（低档把预算留给正文）。当前生效：maxTokens " + (effMax === undefined ? "65536（默认）" : effMax) + "（" + effSrcMax + "） · effort " + (effEff || "low（默认）") + "（" + effSrcEff + "）"),
					h("div", { className: "tc-hint" }, engCodexRunner
						? "后端 codex-cli：effort 档位取 codex 模型目录（随 Codex CLI 卡片的默认模型联动）。"
						: "后端 dsh：effort 档位取本机 dsh 模型目录并集（实际目标模型 = 父代理路由，保存后由运行时按模型校验/回落）。"),
					h("div", { className: "tc-grid" }, [
						label("engCoderMaxTokens", h("input", {
							className: "tc-field", type: "number", min: 1, step: 1024,
							placeholder: "默认 65536",
							value: draft.engCoderMaxTokens,
							disabled: busy,
							onChange: function (e) { setField(["engCoderMaxTokens"], e.target.value); },
						})),
						label("engCoderEffort", engEffortControl),
					]),
				]);
			}

			// —————————— 批 36-补2（设计档 docs/2026-10-16-task-ledger-design.md §十七）：个人任务台账 ——————————
			// 三个键各一个控件，**逐条对齐 §17.4**：
			//   · `mode`  ⇒ 下拉（standalone / off）——合法值是闭集两元素，自由文本只会制造非法态；
			//   · `docPaths` ⇒ 多行文本域，**一行一个路径**（行序即数组序；split/join 双向无损）；
			//   · `copyTemplate` ⇒ 文本域（高 3 行）+ **实时字数 / 上限**提示。
			// 数据面：读 = `view.base/user/effective` 三栏口径（user 面可编辑、effective 面实际生效）；
			// 写 = 既有 `PUT /config`（不新增第二个写盘点）；恢复默认 = 既有 `DELETE /config`（整节恢复）。
			// 空态（§17.4）：`user.ledger` 不存在 ⇒ 控件显示**默认值**，并标注「未在 user 配置中显式设置」。
			function ledgerCard() {
				var lg = (draft && draft.ledger) || ledgerToDraft(null);
				var effLg = view.effective && view.effective.ledger && typeof view.effective.ledger === "object"
					? view.effective.ledger
					: {};
				var userHasLedger = hasPath(user, ["ledger"]);
				var lgSource = userHasLedger ? ("来源 " + fieldSource(base, user, ["ledger"])) : "未在 user 配置中显式设置 ⇒ 当前用内置默认";
				var tpl = typeof lg.copyTemplate === "string" ? lg.copyTemplate : "";
				var pathsArr = textToDocPaths(typeof lg.docPathsText === "string" ? lg.docPathsText : "");
				var effMode = typeof effLg.mode === "string" ? effLg.mode : LEDGER_DEFAULT_MODE;
				var effPaths = Array.isArray(effLg.docPaths) ? effLg.docPaths : [];
				var effTpl = typeof effLg.copyTemplate === "string" && effLg.copyTemplate.trim() !== ""
					? effLg.copyTemplate
					: LEDGER_DEFAULT_COPY_TEMPLATE;
				var tplOver = tpl.length > LEDGER_COPY_MAX_CHARS;
				var pathsOver = pathsArr.length > LEDGER_MAX_DOC_PATHS;
				return h("div", { className: "tc-card", key: "ledger" }, [
					h("div", { className: "tc-card-title" }, "个人任务台账（ledger）"),
					h("div", { className: "tc-hint" }, "任务台账的三个配置键：开关（mode）· 结构化文档路径清单（docPaths，看板上只读渲染成勾选态）· 复制话术模板（copyTemplate，「问这一项」按钮复制的那句话的模板）。不改这三个键也能用——缺省即内置默认。"),
					h("div", { className: "tc-hint" }, lgSource
						+ " · 当前生效（effective 面）：mode " + effMode
						+ " · 文档清单 " + effPaths.length + " 条"
						+ " · 话术 " + effTpl.length + " 字"),
					h("div", { className: "tc-grid" }, [
						label("台账分区开关（ledger.mode）", h("select", {
							className: "tc-field",
							value: lg.mode,
							disabled: busy,
							onChange: function (e) { setLedgerField("mode", e.target.value); },
						}, LEDGER_MODE_OPTIONS.map(function (v) {
							return h("option", { key: v, value: v }, LEDGER_MODE_LABEL[v] || v);
						}))),
						label("复制话术模板（ledger.copyTemplate）", h("textarea", {
							className: "tc-field tc-cmd",
							rows: 3,
							placeholder: "默认即「" + LEDGER_DEFAULT_COPY_TEMPLATE + "」",
							value: lg.copyTemplate,
							disabled: busy,
							onChange: function (e) { setLedgerField("copyTemplate", e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "话术模板字数：" + tpl.length + " / " + LEDGER_COPY_MAX_CHARS
						+ (tplOver ? "（已超上限——保存会被后端拒绝）" : "")
						+ " · 模板就是「问这一项」复制出来那句话的开头，后面会自动接上「要问的这一项 / 当前状态 / 怎么算完成」"),
					h("div", { className: "tc-fieldbox" }, [
						h("div", { className: "tc-fieldname" }, "结构化文档路径清单（ledger.docPaths，一行一个路径）"),
						h("textarea", {
							className: "tc-field tc-cmd",
							rows: 4,
							placeholder: "一行一个路径（相对工作区根）；留空 = 不看板渲染文档勾选态",
							value: lg.docPathsText,
							disabled: busy,
							onChange: function (e) { setLedgerField("docPathsText", e.target.value); },
						}),
					]),
					h("div", { className: "tc-hint" }, "已填 " + pathsArr.length + " / " + LEDGER_MAX_DOC_PATHS
						+ (pathsOver ? "（已超上限——保存会被后端拒绝）" : "")
						+ " 条 · 行序即清单顺序；空行自动忽略"),
					h("div", { className: "tc-hint" }, "恢复默认：用页面底部的「恢复默认（删除自定义配置）」——它与本页其它键共用一条整节恢复通道（不新增单键重置）。"),
				]);
			}

			var effIpg = view.effective.advisor;
			var ipgValue = effIpg && typeof effIpg.includeProjectGuide === "boolean" ? effIpg.includeProjectGuide : false;
			var ipgSource = fieldSource(base, user, ["advisor", "includeProjectGuide"]);
			var effMaxOut = effIpg && typeof effIpg.maxOutputTokens === "number" ? effIpg.maxOutputTokens : undefined;
			var maxOutSource = fieldSource(base, user, ["advisor", "maxOutputTokens"]);
			// 批 5（FR-CB5）：上下文窗口当前生效回显 = **仅配置层**（复用 fieldSource；不显示
			// runtime/fallback——那是评审时才知道的运行时事实，设置页进程取不到，故不新增 GET 载荷）
			var effCtxWin = effIpg && typeof effIpg.contextTokens === "number" ? effIpg.contextTokens : undefined;
			var ctxWinSource = fieldSource(base, user, ["advisor", "contextTokens"]);
			// 批 7（D-P4）· 批 13（R-6）：三个声明键的当前生效回显（仅配置层，复用 fieldSource；U2 来源标注）
			var effStdDoc = effIpg && typeof effIpg.standardsDoc === "string" ? effIpg.standardsDoc : undefined;
			var stdDocSource = fieldSource(base, user, ["advisor", "standardsDoc"]);
			var effMapDoc = effIpg && typeof effIpg.documentMapDoc === "string" ? effIpg.documentMapDoc : undefined;
			var mapDocSource = fieldSource(base, user, ["advisor", "documentMapDoc"]);
			var effCritDoc = effIpg && typeof effIpg.criteriaDoc === "string" ? effIpg.criteriaDoc : undefined;
			var critDocSource = fieldSource(base, user, ["advisor", "criteriaDoc"]);
			// UI-5（R5 §7.2 / D-27）：dsh 后台任务挂死兜底截止——当前生效 + 来源标注（U2）
			var effDshBg = view.effective.dshBackgroundTimeoutMs;
			var dshBgSource = fieldSource(base, user, ["dshBackgroundTimeoutMs"]);
			// D-29：会诊看门狗 / design token 有效期（两键此前只在 entry base 可改）
			var effConsultTo = view.effective.consultTimeoutMs;
			var consultToSource = fieldSource(base, user, ["consultTimeoutMs"]);
			var effEngTtl = view.effective.engTokenTtlMs;
			var engTtlSource = fieldSource(base, user, ["engTokenTtlMs"]);

			return h("div", { className: "tc-page" }, [
				h("h3", { className: "tc-heading" }, "Thincoder 全局配置"),
				h("div", { className: "tc-hint" }, "在这里配置 advisor 评审用的模型与超时（全局默认）。留空 = 跟随解析链（当前会话模型/内置默认）；保存后立即生效，无需重启。本页修改只影响之后的评审调用。"),
				msg ? h("div", { className: "tc-msg " + msg.kind }, msg.text) : null,
				errors.length > 0
					? h("div", { className: "tc-errors" }, errors.map(function (e, i) {
						return h("div", { key: i, className: "tc-errline" }, "✕ " + e);
					}))
					: null,
				h(SessionCard, {
					sessionId: currentSessionId, summary: summary, busy: busy,
					onApply: applySession, onReset: resetSession,
					onRefresh: function () { refreshSession(currentSessionId); },
				}),
				groupCard("round1"),
				groupCard("convergence"),
				h("div", { className: "tc-card", key: "ipg" }, [
					h("div", { className: "tc-card-title" }, "评审记忆开关"),
					h("label", { className: "tc-switchline" }, [
						h("input", {
							type: "checkbox",
							checked: !!(draft.advisor && draft.advisor.includeProjectGuide),
							disabled: busy,
							onChange: function (e) { setField(["advisor", "includeProjectGuide"], e.target.checked); },
						}),
						h("span", null, "includeProjectGuide（评审注入 AGENTS.md 项目记忆）"),
					]),
					h("div", { className: "tc-hint" }, "默认 false：评审只认显式 documents=[...]，保持独立。当前生效："
						+ ipgValue + "（来源 " + ipgSource + "）"),
				]),
				h("div", { className: "tc-card", key: "maxout" }, [
					h("div", { className: "tc-card-title" }, "评审输出预算（maxOutputTokens）"),
					h("div", { className: "tc-grid" }, [
						label("单次 LLM 输出 token 上限", h("input", {
							className: "tc-field", type: "number", min: MAX_OUTPUT_TOKENS_MIN, max: MAX_OUTPUT_TOKENS_MAX, step: 1024,
							placeholder: "默认 16384",
							value: draft.advisor.maxOutputTokens,
							disabled: busy,
							onChange: function (e) { setField(["advisor", "maxOutputTokens"], e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "推理型模型 high/max 档会先烧推理再出正文——预算不足时评审以空响应收场（D-01）。当前生效："
						+ (effMaxOut === undefined ? "16384（默认）" : effMaxOut) + "（" + maxOutSource + "）· 合法区间 " + MAX_OUTPUT_TOKENS_MIN + "~" + MAX_OUTPUT_TOKENS_MAX + "。"),
				]),
				h("div", { className: "tc-card", key: "ctxwin" }, [
					h("div", { className: "tc-card-title" }, "评审上下文窗口（contextTokens）"),
					h("div", { className: "tc-grid" }, [
						label("模型窗口（tokens）", h("input", {
							className: "tc-field", type: "number", min: CONTEXT_TOKENS_MIN, max: CONTEXT_TOKENS_MAX, step: 1024,
							placeholder: "留空 = 评审时自动跟随模型",
							value: draft.advisor.contextTokens,
							disabled: busy,
							onChange: function (e) { setField(["advisor", "contextTokens"], e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "口径 = 模型窗口（照抄模型规格页，不是判死线）：评审的压缩触发与判死线由它按 0.8／0.8 派生。"
						+ "留空 = 评审时自动跟随（运行时解析该路由的适配器窗口；不可得则保守兜底 131072，并在评审尾部注明原因）。"
						+ "合法区间 " + CONTEXT_TOKENS_MIN + "~" + CONTEXT_TOKENS_MAX + "。"
						+ "注意：若把上面的 maxOutputTokens 调得很大而本键窗口较小，20% 头寸可能盖不住输出预算——此时放宽本键或调低输出预算。"
						+ "当前生效（配置层）：" + (effCtxWin === undefined ? "未设置" : effCtxWin) + "（来源 " + ctxWinSource + "）。"),
				]),
				// 批 7（D-P4/D-P8/J8/J11）· 批 13（R-6）：三个「项目文档」声明键——一张卡片三个文本框。
				// 键 = advisor.standardsDoc（项目标准文档）· advisor.documentMapDoc（文档地图）·
				// advisor.criteriaDoc（code 评审的判据正文）。
				// 三者都是字符串文档路径（相对会话 cwd；无合法区间 ⇒ 无 min/max，D-P15）。
				// 撤销语义（AC-P12c / 锚 B11）：清空文本框 = 发送空串 = 撤销该键——空串必须照发
				// （见 draftToPayload），服务端据此删键；「空字段不发送」会把用户锁死在已声明态。
				// 注：本切片落在既有 T-CB9 的静态锁范围内（该锁断言渲染串零 markdown 强调泄漏），
				// 故本卡片源串内一律不写双星强调标记。
				h("div", { className: "tc-card", key: "projectdocs" }, [
					h("div", { className: "tc-card-title" }, "项目文档声明（standardsDoc / documentMapDoc / criteriaDoc）"),
					h("div", { className: "tc-hint" }, "这三个键把「评审按什么判」交给项目自己声明（不再写死任何文件名，故插件可移植）。留空/清空 = 未声明：注入器走显式降级句（不是静默跳过）。路径必须是文档文件（服务端用与写门禁同一个判据 isDocPath 预检）；是否可读在评审时判——声明了却读不到会响亮点名该配置键。"),
					h("div", { className: "tc-grid" }, [
						label("项目标准文档（advisor.standardsDoc）", h("input", {
							className: "tc-field", type: "text",
							placeholder: "path/to/standards.md（相对会话 cwd；清空=撤销声明）",
							value: draft.advisor.standardsDoc,
							disabled: busy,
							onChange: function (e) { setField(["advisor", "standardsDoc"], e.target.value); },
						})),
						label("文档地图（advisor.documentMapDoc）", h("input", {
							className: "tc-field", type: "text",
							placeholder: "path/to/doc-map.md（相对会话 cwd；清空=撤销声明）",
							value: draft.advisor.documentMapDoc,
							disabled: busy,
							onChange: function (e) { setField(["advisor", "documentMapDoc"], e.target.value); },
						})),
						label("代码评审判据文档（advisor.criteriaDoc）", h("input", {
							className: "tc-field", type: "text",
							placeholder: "path/to/criteria.md（相对会话 cwd；清空=撤销声明）",
							value: draft.advisor.criteriaDoc,
							disabled: busy,
							onChange: function (e) { setField(["advisor", "criteriaDoc"], e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "standardsDoc = 项目标准文档（设计评审的「标准符合性」维度据它评判；两个评审面 round1 都注入，与工程模式开关无关）。当前生效（配置层）："
						+ (effStdDoc === undefined ? "未声明" : effStdDoc) + "（来源 " + stdDocSource + "）。"),
					h("div", { className: "tc-hint" }, "documentMapDoc = 文档地图（设计评审的「文档归属」维度据它评判；只在设计评审 round1 注入，代码评审无此段）。当前生效（配置层）："
						+ (effMapDoc === undefined ? "未声明" : effMapDoc) + "（来源 " + mapDocSource + "）。"),
					h("div", { className: "tc-hint" }, "criteriaDoc = 代码评审的判据正文（替换「Review Criteria」段的内容；只在代码评审 round1 注入，设计评审无此段）。未声明时走遗留链（探 .thincoder/advisor.md → 内置五条判据）。当前生效（配置层）："
						+ (effCritDoc === undefined ? "未声明" : effCritDoc) + "（来源 " + critDocSource + "）。"),
				]),
				consultPoolCard(),
				codexCliCard(),
				engCard(),
				h("div", { className: "tc-card", key: "dshbg" }, [
					h("div", { className: "tc-card-title" }, "dsh 后台任务兜底（dshBackgroundTimeoutMs）"),
					h("div", { className: "tc-grid" }, [
						label("后台 dsh 任务兜底截止（毫秒）", h("input", {
							className: "tc-field", type: "number", min: DSHS_BG_TIMEOUT_MIN, max: DSHS_BG_TIMEOUT_MAX, step: 1000,
							placeholder: "默认 1800000（30 分钟）",
							value: draft.dshBackgroundTimeoutMs,
							disabled: busy,
							onChange: function (e) { setField(["dshBackgroundTimeoutMs"], e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "dsh 后台任务挂死兜底（R5 UI-5，D-27）：覆盖三条后台 dsh 路径——advisor 评审预算超 codexCli.budgetCapMs 自动派发的 job、escalate/eng_coder 传 background=true 派发的 job。到点 abort（子代理 abort / llm 流 abort）+ 超时信封（partial 保留），防挂起导致 job 永悬。当前生效："
						+ (effDshBg === undefined ? "1800000（默认）" : effDshBg) + "（" + dshBgSource + "）· 合法区间 " + DSHS_BG_TIMEOUT_MIN + "~" + DSHS_BG_TIMEOUT_MAX + "。"),
				]),
				h("div", { className: "tc-card", key: "consultTtl" }, [
					h("div", { className: "tc-card-title" }, "会诊看门狗 / design token 有效期（D-29）"),
					h("div", { className: "tc-grid" }, [
						label("会诊各模型看门狗（毫秒）", h("input", {
							className: "tc-field", type: "number", min: CONSULT_TIMEOUT_MIN, max: CONSULT_TIMEOUT_MAX, step: 60000,
							placeholder: "默认以 base 配置为准",
							value: draft.consultTimeoutMs,
							disabled: busy,
							onChange: function (e) { setField(["consultTimeoutMs"], e.target.value); },
						})),
						label("design token 有效期（毫秒）", h("input", {
							className: "tc-field", type: "number", min: ENG_TTL_MIN, max: ENG_TTL_MAX, step: 600000,
							placeholder: "默认以 base 配置为准",
							value: draft.engTokenTtlMs,
							disabled: busy,
							onChange: function (e) { setField(["engTokenTtlMs"], e.target.value); },
						})),
					]),
					h("div", { className: "tc-hint" }, "consultTimeoutMs＝会诊里单个模型的看门狗上限；超时只影响该模型（其结果记为超时失败），不终止整轮。当前生效："
						+ (effConsultTo === undefined ? "以 base 配置为准" : effConsultTo) + "（" + consultToSource + "）· 合法区间 " + CONSULT_TIMEOUT_MIN + "~" + CONSULT_TIMEOUT_MAX + "。"),
					h("div", { className: "tc-hint" }, "engTokenTtlMs＝advisor 设计评审通过后签发的 design token 有效期。过期后 eng_coder 会拒绝该 token，但有两条出路（D-30 / FR-T5）：设计文档集自评审通过起未变更（路径+内容指纹一致）时，eng_coder 自动续期——同一 uuid 顺延有效期并回传新令牌串，无需重跑评审（把手里那份副本换成新串即可）；只有文档集已变更、或该次评审未绑定文档集/记录来自旧版本插件时才需要重新发起设计评审。设得过短会提高续期与重评频率。当前生效："
						+ (effEngTtl === undefined ? "以 base 配置为准" : effEngTtl) + "（" + engTtlSource + "）· 合法区间 " + ENG_TTL_MIN + "~" + ENG_TTL_MAX + "。"),
				]),
				// 批 36-补2（设计档 §十七 §17.4）：个人任务台账三键（mode / docPaths / copyTemplate）
				ledgerCard(),
				h("div", { className: "tc-actions" }, [
					h("button", {
						className: "tc-btn primary", type: "button", disabled: busy,
						onClick: saveGlobal,
					}, "保存全局默认"),
					h("button", {
						className: "tc-btn ghost danger", type: "button", disabled: busy,
						onClick: restoreGlobal,
					}, "恢复默认（删除自定义配置）"),
				]),
			]);
		}

		//#endregion

		//#region apply / 注册（settings.section slot；样式一次性注入并在 dispose 时移除）

		var STYLE_ID = "thincoder-suite-settings-style";
		// 样式对齐宿主设置面板（v0.5）：全部使用宿主语义 token（--dsw-alias-*，主题随动）；
		// 正文 ≥13px、提示 ≥12px（UX 审查）。
		// ★ 批36-补3（设计档 §十八 ②）：卡片面自本批起是**毛玻璃**（半透明 + 模糊），不再是
		//   不透明表面 bg-layer-1 —— 保住用户的壁纸皮肤（那是他的选择，不是缺陷）。
		var STYLE_CSS = [
			// 批36-补3（§十八 ②）：毛玻璃的**唯一变量源**（面板与设置页共用）。
			// ★★ 底色**必须**用 color-mix 从主题基底色派生，**绝不硬编码白/黑**：
			//    `--dsw-alias-bg-base` 在深色主题下是深色，写死 #ffffff 会变成一块刺眼的白板。
			// ★ 62% 的不透明度是刻意的：既保住壁纸，又让文字比「全透明」清楚（可接受降级）。
			".tc-page,.tc-tasks{--tc-glass-bg:color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 62%, transparent);--tc-glass-brd:color-mix(in srgb, var(--dsw-alias-label-primary, #111111) 14%, transparent);--tc-glass-blur:blur(14px) saturate(1.08)}",
			".tc-page{display:flex;flex-direction:column;gap:14px;max-width:780px;padding:2px 0 20px;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}",
			".tc-heading{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".tc-card{background:var(--tc-glass-bg);border:1px solid var(--tc-glass-brd);border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;backdrop-filter:var(--tc-glass-blur)}",
			".tc-card-title{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-primary)}",
			".tc-badge{font-size:11px;padding:1px 8px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
			".tc-badge.on{background:transparent;border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".tc-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55}",
			".tc-baseline{font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border-left:2px solid var(--dsw-alias-border-l2);border-radius:0;padding:2px 0 2px 9px}",
			".tc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px 14px}",
			".tc-fieldbox{display:flex;flex-direction:column;gap:4px;min-width:0}",
			".tc-fieldname{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".tc-field{box-sizing:border-box;width:100%;min-width:0;font:inherit;font-size:13px;padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}",
			".tc-field:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}",
			".tc-field.narrow{width:auto;min-width:110px}",
			".tc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			".tc-row.pool{display:grid;grid-template-columns:1fr 1fr 150px 58px;gap:6px;align-items:center}",
			".tc-colhead{display:grid;grid-template-columns:1fr 1fr 150px 58px;gap:6px;font-size:11px;color:var(--dsw-alias-label-caption);padding:0 2px}",
			".tc-cmd{font-family:ui-monospace,monospace;font-size:11.5px;resize:vertical;color:var(--dsw-alias-label-primary)}",
			".tc-summary{margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;max-height:150px;overflow:auto;color:var(--dsw-alias-label-secondary)}",
			".tc-btn{font:inherit;font-size:12.5px;padding:5px 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}",
			".tc-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".tc-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}",
			".tc-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}",
			".tc-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:transparent}",
			".tc-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}",
			".tc-btn:disabled{opacity:.5;cursor:not-allowed}",
			".tc-btn:disabled:hover{background:transparent}",
			".tc-field:disabled{opacity:.55;cursor:not-allowed}",
			".tc-switchline{display:flex;gap:9px;align-items:center;cursor:pointer}",
			".tc-msg{padding:7px 11px;border-radius:8px;font-size:12.5px;white-space:pre-wrap}",
			".tc-msg.ok{background:transparent;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}",
			".tc-msg.error{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}",
			".tc-msg.info{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}",
			".tc-errors{background:transparent;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;padding:7px 11px;font-size:12.5px;color:var(--dsw-alias-state-error-primary)}",
			".tc-errline{margin:1px 0}",
			".tc-actions{display:flex;gap:9px}",
			// 批 36：任务台账看板（只读面）——沿用本档既有变量与半径，不引入新依赖
			// ★ 2026-10-17 视觉修复（父会话用 Win32 截图实证）：面板**没有底色** ⇒ 壁纸直接透过文字，
			//   折叠时整个正文区就是一块空壁纸（用户说的"样式不太对"主要来源）。
			//   better-sidebar 的 tab 容器本身不画底 ⇒ 由内容自画；变量用同档在用的 bg-base。
			// ★ 2026-10-17 视觉修复 v2（父会话 Win32 截图 + 读 better-sidebar 自身 CSS 取证）：
			//   v1 写的 `min-height:100%` 在 **flex 父容器**里会塌成内容高度 ⇒ 只有文字那条有底色，
			//   下面仍是壁纸（用户实测「切了 tab 还是不行」）。正确形态看 better-sidebar 自己的面板：
			//     .nArs4W_pane{background:var(--dsw-alias-bg-base); flex:1; min-height:0; ...}
			//     .bdiHEa_root{background:var(--dsw-alias-bg-base); height:100%; min-height:0; ...}
			//   ⇒ `flex:1 1 auto` + `height:100%` + `min-height:0`（+ `overflow:auto` 让长列表可滚）。
			".tc-tasks{display:flex;flex-direction:column;gap:8px;padding:10px;font-size:12.5px;color:var(--dsw-alias-label-primary);min-height:100%;box-sizing:border-box}",
			".tc-tasks-head{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}",
			// ★ 2026-10-17 缺陷修复：原为 `break-all` ⇒ Windows 长路径会在词中断字（用户实测 `tasks.j n`）；
			//   改成按词断，并在组件层把路径缩短成末两段（全文进 title）。
			".tc-tasks-meta{font-size:11.5px;color:var(--dsw-alias-label-caption);word-break:break-word;font-family:ui-monospace,monospace}",
			// ★ 长文本（目标 / 判据可达数百字）**只显示 2 行**，全文在 title 里
			".tc-tasks-clamp{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis}",
			// 批36-补3（§十八 ②）：卡片级元素套毛玻璃（分区 / 防漂移区 / 五态环图）；**行不套模糊**（性能）。
			".tc-tasks-drift{background:var(--tc-glass-bg);border:1px solid var(--tc-glass-brd);border-radius:10px;padding:7px 10px;display:flex;flex-direction:column;gap:3px;backdrop-filter:var(--tc-glass-blur)}",
			".tc-tasks-kv{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
			".tc-tasks-body{display:flex;flex-direction:column;gap:10px}",
			// 分区 = 卡片级（毛玻璃 + 模糊）；分区标题 12px / 正文 12.5px（§十八 ③ 两级字号）
			".tc-tasks-sec{display:flex;flex-direction:column;gap:6px;background:var(--tc-glass-bg);border:1px solid var(--tc-glass-brd);border-radius:10px;padding:10px;backdrop-filter:var(--tc-glass-blur)}",
			".tc-tasks-h{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			// ★ 任务行只给**半透明底**，刻意**不加** backdrop-filter（§18.5：长列表上每行一次模糊会掉帧）。
			".tc-tasks-row{background:var(--tc-glass-bg);border:1px solid var(--tc-glass-brd);border-radius:10px;padding:7px 10px;display:flex;flex-direction:column;gap:6px}",
			".tc-tasks-title{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}",
			".tc-tasks-id{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dsw-alias-label-caption)}",
			".tc-tasks-status{font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			// 批36-补3（§十八 ①）：优先级徽标 —— 只在 priority >= 1 时渲染（0/缺省/负数 ⇒ 没有该元素）。
			// 三档阈值：>=8 红 / 3..7 琥珀 / 1..2 灰；白字压深色底（对比度按 §18.3 表）。
			".tc-tasks-prio{display:inline-block;font-size:11px;line-height:1.5;padding:1px 6px;border-radius:999px;font-weight:600;letter-spacing:.02em;color:#FFFFFF;white-space:nowrap}",
			".tc-prio-high{background:#DC2626}",
			".tc-prio-mid{background:#D97706}",
			".tc-prio-low{background:#64748B}",
			// 批36-补3（五态环图；腿见设计档 §19.9「环图腿」）：纯手绘 SVG（零图表库）+ 图例；中心是总数。
			".tc-tasks-donut{display:flex;gap:14px;align-items:center;background:var(--tc-glass-bg);border:1px solid var(--tc-glass-brd);border-radius:10px;padding:10px 12px;backdrop-filter:var(--tc-glass-blur)}",
			".tc-tasks-donut-svg{flex:0 0 auto;display:block}",
			".tc-tasks-legend{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}",
			".tc-tasks-legend-row{display:flex;align-items:center;gap:6px;white-space:nowrap}",
			".tc-tasks-legend-dot{width:9px;height:9px;border-radius:3px;flex:0 0 auto;display:inline-block}",
			".tc-tasks-check{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
			".tc-tasks-actions{display:flex;gap:6px;flex-wrap:wrap}",
			".tc-tasks-detail{border-top:1px dashed var(--dsw-alias-border-l1);background:var(--tc-glass-bg);border-radius:8px;padding:6px 8px;display:flex;flex-direction:column;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}",
			".tc-tasks-note{font-size:11.5px;color:var(--dsw-alias-label-caption)}",
			".tc-tasks-empty{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".tc-tasks-manual{display:flex;flex-direction:column;gap:6px}",
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined") return null;
			var old = document.getElementById(STYLE_ID);
			// ★★ 2026-10-17 **实证出来的 bug**：原来这里写 `if (old) return old;` —— **只复用标签、从不更新内容**。
			//   后果：插件模块重载了（JS 是新的）而 `<style>` 还是旧的 ⇒ 用户实测「按钮变了、底色没变」。
			//   ⇒ 存在即**用新 CSS 覆盖**（幂等，代价是一次字符串赋值）。
			if (old) { old.textContent = STYLE_CSS; return old; }
			var tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "@dsh-external/dsh-thincoder-suite";
			tag.textContent = STYLE_CSS;
			document.head.appendChild(tag);
			return tag;
		}

		//#region 批 36：个人任务台账看板 tab（**只读渲染面**）
		//
		// 设计依据：docs/2026-10-16-task-ledger-design.md FR-5 / FR-7 / FR-11 · §7.3 · §7.4。
		// 四条硬约束（逐条对应腿）：
		//   ① **可选依赖一律 `ctx.get`，绝不写进 `inject`**：把 betterSidebar 声明进 inject ⇒
		//      没装该插件的部署上**整个客户端半边永久 pending**（连设置页一起死）——设计档 §五末的
		//      「可选依赖怎么表达」注 + 腿 T-8①；
		//   ② **零存储**（N-1）：本区块不写盘、不用 localStorage/sessionStorage、不落任何持久态；
		//      tab 的展开与选中由 better-sidebar 自己按会话管（§7.3）；
		//   ③ **数据只来自 host 的 `/tasks` 端点**——而那一端由 `readTasksView()` 派生（设计-D3 三面同源）。
		//      本区块**不解析 tasks.json**、不持有第二份任务状态；
		//   ④ **看板不可写**（设计-D9）：没有打勾、没有改进度——完成必须带凭据，写入口只有工具/对话。
		//
		// ★ U-1（「点一下就在侧边开一个会话」）**未经端到端实测** ⇒ 本批走设计档明写的**降级路径**：
		//   点任务 = **点开看详情（三要素）+ 一键复制话术**（不假装支持"点开就能聊"）。

		var TASKS_TAB_ID = "thincoder:tasks";
		var TASKS_POLL_MS = 15000; // 展开且可见时的拉取间隔（纯拉取，无推送——§7.4 C-2）

		// ★★ 2026-10-17 **缺口修复**（用户实测「重启后找不到面板」）：`betterSidebar.registerTab` 只是把
		//   **tab 类型**存进一个 Map（better-sidebar `lib/client.js:1415-1425`），**它不会让任何东西出现在侧栏**；
		//   内置面板同样走这条注册路、但各自另有**打开**入口 ⇒ 只注册不打开 = 「存在但不可见」。
		//   真正摆出来的动作是 `openTab({type})`（同档 `:1516`；别的插件写法见 `:24045`）。
		//   ★ 护栏用**纯内存标志**（本页面生命周期内只自动开一次）—— **刻意不用 sessionStorage**：
		//     N-1「看板零存储」的腿把任何 storage 写都计入违规（T-4a），而 better-sidebar 自己会持久化
		//     已打开的 tab ⇒ 无需我们记任何东西。打开失败只 warn，不连累设置页。
		var tasksAutoOpened = false;

		/** apply() 时捕获的 better-sidebar 服务（看板组件在 factory 层，拿不到 apply 里的 ctx）。 */
		var tasksSidebar = null;

		/**
		 * 打开一个**侧边会话**。★ U-1 实测结论（2026-10-17，回答「点任务能不能在侧边开个会话」）：
		 *   - `sidechat` 是 better-sidebar 的**内置 tab 类型**（其 `lib/client.js:24747`），
		 *     `openTab({ type: "sidechat" })` 可以打开（别的插件也这么用，见同档 `:24045`）；
		 *   - 但它的种子 `consumeSidechatSeed()`（`:23363-23372`）**只携带 threadId**，
		 *     **没有任何预填正文的通道** ⇒ **能开、不能预填**。
		 *   ⇒ 所以本面板的形态是「**复制话术 + 打开侧边会话**」，用户粘一下即可。
		 * @returns {boolean} 是否真的尝试打开了（false ⇒ 调用方**不要**声称"已打开"）
		 */
		function openSideChatTab() {
			try {
				if (tasksSidebar && typeof tasksSidebar.openTab === "function") {
					tasksSidebar.openTab({ type: "sidechat" });
					return true;
				}
			} catch (e0) { /* 打开失败 ⇒ 如实降级成"只复制" */ }
			return false;
		}

		/** 拉取看板载荷（GET /thincoder-suite/api/tasks；栅栏在 host 侧，本处只管取）。 */
		function fetchTasks(sessionId) {
			return apiCall("GET", "/tasks?sessionId=" + encodeURIComponent(sessionId || ""));
		}

		/**
		 * **接手**（批 36-补 · 设计档 §16.2 的交接动作）：`POST /tasks/claim`。
		 * ★ 这条路**不自己写盘、不自己判归属**：host 侧先 `readTasksView()` 拿 rev、再把请求送进
		 *   **同一道写门** `applyTaskClaim`（只改 owner/claimedFrom），然后把**刷新后的整份载荷**回给本页
		 *   ⇒ 本组件仍然只是「渲染 host 给的载荷」（零状态机、零第二份真源）。
		 */
		function claimTask(sessionId, id) {
			return apiCall("POST", "/tasks/claim", { sessionId: sessionId || "", id: String(id || "") });
		}

		/** 复制（复用既有 copyText：成功 true；失败 ⇒ 调用方把文本显示在可选中区块里）。 */
		function copyOrShow(text, setManual) {
			if (copyText(text)) return true;
			setManual(text);
			return false;
		}

		/** 台账路径的**显示用**短形式：只给末两段（全文在 `title` 里；路径本身一个字符都不改）。 */
		function shortLedgerPath(p) {
			var s = String(p || "");
			if (!s) return "（无路径）";
			var sep = s.indexOf("\\") >= 0 ? "\\" : "/";
			var parts = s.split(/[\\/]+/).filter(function (x) { return x !== ""; });
			if (parts.length <= 2) return s;
			return "…" + sep + parts.slice(-2).join(sep);
		}

		/**
		 * 漂移区的一行。★ 2026-10-17 缺陷修复：`goal.objective` 与 `criteria.check` 可能是**几百字**
		 * （用户实测：面板被一条 500 字的目标原文占满）⇒ **面板只给 2 行**，全文放 `title`（悬停可读）。
		 * 截断是**显示层**的，不改任何读数。
		 */
		function DriftLine(props) {
			var text = String(props.text == null ? "" : props.text);
			return h("div", { className: "tc-tasks-kv tc-tasks-clamp", title: props.label + "：" + text },
				props.label + "：" + text);
		}

		/** 防漂移状态区（FR-11；读数全部由 host 给，本区块零计算）。 */
		function DriftBlock(props) {
			var d = props.drift;
			if (!d) return h("div", { className: "tc-tasks-drift" }, "防漂移状态区：读数不可得（不影响任务台账）");
			return h("div", { className: "tc-tasks-drift" },
				h("div", { className: "tc-tasks-h" }, "防漂移状态区"),
				h(DriftLine, { label: "当前目标", text: (d.goal && d.goal.objective) || "（无活跃目标）" }),
				h(DriftLine, { label: "判据", text: (d.criteria && d.criteria.check) || "（无判据记录）" }),
				h(DriftLine, { label: "欠账", text: (d.debts && d.debts.length) ? d.debts.join(" · ") : "无" }),
				h(DriftLine, { label: "本回合被推回次数", text: String(d.pushback || 0) }));
		}

		//#region 批36-补3（设计档 §十八）：优先级徽标 + 五态环图（**纯渲染，零计算真源**）
		//
		// ★ 数据面零改动：`boardRowOf` 早已把 `priority` 传进载荷（lib/tool-tasks.mjs:166 一带）——
		//   本区块只负责把既有读数**露出来**，不新增任何状态字段、不写盘。

		/** 优先级徽标的档位类名（§18.3 ① 的三档阈值：>=8 红 / 3..7 琥珀 / 1..2 灰）。 */
		function priorityBadgeClass(p) {
			if (p >= 8) return "tc-prio-high";
			if (p >= 3) return "tc-prio-mid";
			return "tc-prio-low";
		}

		/**
		 * 行首 `P{priority}` 徽标（§18.3 ①）。
		 * @post `priority >= 1` ⇒ 渲染一个 span；**0 / 缺省 / 负数 / 非法 ⇒ 返回 null（不渲染任何元素）**
		 *       ——「满屏 P0」是噪音，用户明确裁定不显示。
		 * @post 文案取**原始数字**（`P10` 而不是映射后的档位名）⇒ 一眼看到真实权重。
		 */
		function PriorityBadge(props) {
			var p = Number(props && props.priority);
			if (!isFinite(p) || p < 1) return null;
			return h("span", { className: "tc-tasks-prio " + priorityBadgeClass(p) }, "P" + p);
		}

		/**
		 * 五态色板（用户裁定；腿见设计档 §19.9「环图腿」：待办 / 已接手 / 在做 / 卡住 / 完成）。
		 * 顺序即环图分段顺序与图例顺序。
		 */
		var TASK_RING = [
			{ status: "待办", color: "#94A3B8" },
			{ status: "已接手", color: "#6366F1" },
			{ status: "在做", color: "#0EA5E9" },
			{ status: "卡住", color: "#EF4444" },
			{ status: "完成", color: "#22C55E" },
		];

		/**
		 * 五态环图（用户裁定；腿见设计档 §19.9「环图腿」）：**纯手绘 SVG**（零图表库），中心总数，
		 * 旁边图例（名 · 计数 · 百分比）。
		 *
		 * ★★ 计数**必须**从 `payload.ledger` 的**行**（每行带 `status`）自己数，
		 *    **不许**读 `payload.counts`：`lib/tasks.mjs` 的 `counts.doing` 是「在做 + 已接手」的
		 *    **合并**数（本仓源码 :387-388 实测）——用它会让「已接手」永远显示 0，
		 *    **默默少一段**（用户看到的就是假数据）。这正是本条腿存在的理由。
		 *
		 * @post 总数 0（或载荷里没有 ledger / ledger.mode=off）⇒ 返回 null（**不渲染空环图**）
		 * @post 图例恒列五态（含 0 的态）⇒ 读者能确认「五态都在、只是没有那一态」
		 */
		function TasksStateDonut(props) {
			var ledger = props && props.ledger;
			if (!ledger || typeof ledger !== "object") return null;
			// ledger 的四个分区互斥且并集 = 整本账（决策 / 在办 / 卡住 / 完成）⇒ 拼起来就是全量行。
			var rows = [];
			var partKeys = ["decisions", "active", "blocked", "done"];
			for (var i = 0; i < partKeys.length; i++) {
				var arr = ledger[partKeys[i]];
				if (Array.isArray(arr)) rows = rows.concat(arr);
			}
			var total = rows.length;
			if (total < 1) return null;
			var counts = {};
			for (var k = 0; k < TASK_RING.length; k++) counts[TASK_RING[k].status] = 0;
			for (var r = 0; r < rows.length; r++) {
				var st = rows[r] && rows[r].status;
				if (Object.prototype.hasOwnProperty.call(counts, st)) counts[st]++;
			}
			// 环图几何：半径 46 / 线宽 14 的圆环；dasharray 按占比切段（首段从 12 点方向起）。
			var R = 46;
			var CIRC = 2 * Math.PI * R;
			var acc = 0;
			var arcs = [];
			var legend = [];
			for (var s = 0; s < TASK_RING.length; s++) {
				var status = TASK_RING[s].status;
				var n = counts[status];
				var len = CIRC * (n / total);
				if (n > 0) {
					arcs.push(h("circle", {
						key: "arc-" + status,
						cx: 60, cy: 60, r: R, fill: "none",
						stroke: TASK_RING[s].color,
						strokeWidth: 14,
						strokeDasharray: len.toFixed(2) + " " + (CIRC - len).toFixed(2),
						strokeDashoffset: (-acc).toFixed(2),
						transform: "rotate(-90 60 60)",
					}));
				}
				acc += len;
				legend.push(h("div", { key: "lg-" + status, className: "tc-tasks-legend-row" },
					h("span", { className: "tc-tasks-legend-dot", style: { background: TASK_RING[s].color } }),
					h("span", null, status + " · " + n + " · " + Math.round((n / total) * 100) + "%")));
			}
			return h("div", { className: "tc-tasks-donut" },
				h("svg", {
					className: "tc-tasks-donut-svg",
					viewBox: "0 0 120 120", width: 120, height: 120,
				},
					arcs,
					h("text", {
						className: "tc-tasks-donut-total",
						x: 60, y: 57, textAnchor: "middle",
						fontSize: 22, fontWeight: 700, fill: "currentColor",
					}, String(total)),
					h("text", {
						className: "tc-tasks-donut-cap",
						x: 60, y: 74, textAnchor: "middle",
						fontSize: 10, fill: "currentColor", opacity: 0.7,
					}, "总数")),
				h("div", { className: "tc-tasks-legend" }, legend));
		}
		//#endregion

		/** 单条任务行（**没有状态写操作**：详情 / 问这一项 / 在侧边聊 ＋「接手」只改归属）。 */
		function TaskRow(props) {
			var t = props.task;
			var onDetail = props.onDetail;
			var onCopy = props.onCopy;
			var isOpen = props.isOpen;
			// ★ 2026-10-17：U-1 实测后新增的「在侧边聊」动作（可选传入；缺省则不渲染该按钮）
			var onSideChat = props.onSideChat;
			// ★ 批 36-补：待接手区里的条目带「接手」按钮（`canClaim` 由 host 载荷判定，前端不自算）
			var onClaim = props.onClaim;
			return h("div", { className: "tc-tasks-row" },
				h("div", { className: "tc-tasks-title" },
					// 批36-补3（§十八 ①）：P{priority} 徽标**在行首**（id 之前）；priority<1 ⇒ 组件返回 null。
					h(PriorityBadge, { priority: t.priority }),
					h("span", { className: "tc-tasks-id" }, t.id),
					h("span", { className: "tc-tasks-status" }, "[" + t.statusTag + "]"),
					h("span", null, " " + t.title)),
				h("div", { className: "tc-tasks-check" }, "怎么算完成：" + (t.check || "（未写）")),
				// 归属一行（批 36-补）：谁建的 / 现在归谁 / 接手自谁 —— 三条都是**读数**，不是判据
				h("div", { className: "tc-tasks-note" },
					"归属：" + (t.owner ? t.owner : "无归属")
					+ (t.claimedFrom ? "（接手自 " + t.claimedFrom + "）" : "")
					+ (t.createdBy && t.createdBy !== t.owner ? " · 建单人：" + t.createdBy : "")),
				h("div", { className: "tc-tasks-actions" },
					h("button", { className: "tc-btn", onClick: function () { onDetail(t); } }, isOpen ? "收起详情" : "看详情"),
					h("button", { className: "tc-btn", onClick: function () { onCopy(t.copyPrompt); } }, "问这一项"),
					// ★ 2026-10-17：U-1 实测后新增 —— 点一下 = **复制话术 + 开一个侧边会话**。
					//   不能预填（better-sidebar 的 sidechat 种子只携带 threadId），故文案如实写「粘一下」。
					onSideChat ? h("button", { className: "tc-btn", onClick: function () { onSideChat(t); } }, "在侧边聊") : null,
					// ★ 批 36-补：接手（只改 owner；状态与凭据一字不动）
					t.canClaim && onClaim ? h("button", { className: "tc-btn primary", onClick: function () { onClaim(t); } }, "接手") : null),
				isOpen && t.click ? h("div", { className: "tc-tasks-detail" },
					h("div", { className: "tc-tasks-h" }, "人话说明"),
					h("div", null, t.click.plain),
					h("div", { className: "tc-tasks-h" }, "相关文档"),
					h("ul", null, (t.click.docs || []).map(function (p, i) { return h("li", { key: i }, p); })),
					h("div", { className: "tc-tasks-h" }, "核验进度"),
					h("ul", null, (t.click.progress || []).map(function (p, i) { return h("li", { key: i }, p); })),
					// ★ 2026-10-17：U-1 **已实测** —— 侧边会话能开，但 better-sidebar 的 `sidechat` 种子
					//   (`consumeSidechatSeed` :23363-23372) **只携带 threadId、没有预填正文的通道**
					//   ⇒ 本面板的形态 = 复制话术 + 开一个侧边会话，**粘一下**即可（不假装「点开就自动发」）。
					h("div", { className: "tc-tasks-note" },
						"（U-1 已实测：能打开侧边会话，但它的种子只携带 threadId、没有预填正文的通道 ⇒ "
						+ "本面板是「复制话术 + 打开侧边会话」，粘一下即可。）")) : null);
		}

		/**
		 * 看板正文（**纯渲染**：只吃 host 给的载荷；本函数即腿 T-14 的渲染面）。
		 * 分区顺序 = `data.sections` 给的顺序（host 侧保证**决策区置顶**）；**空分区不渲染**。
		 * ★ 批 36-补：**三区**（本会话 / 待接手（N）/ 全部）由 host 载荷的 `scopes` ＋ `views` 决定；
		 *   本组件只负责切换与渲染，**不算归属**（`canClaim` 也由 host 给）。
		 */
		function TasksBoardBody(props) {
			var data = props.data || {};
			var onDetail = props.onDetail;
			var onCopy = props.onCopy;
			var openId = props.openId;
			var onCopyAll = props.onCopyAll;
			// ★ 2026-10-17 U-1 实测后的新增动作：打开侧边会话（见 openSideChatTab 的注释）
			var onSideChat = props.onSideChat;
			// ★ 批 36-补：接手（只改归属）
			var onClaim = props.onClaim;
			var activeScope = props.activeScope;
			var onScope = props.onScope;
			var nodes = [];
			nodes.push(h(DriftBlock, { key: "drift", drift: data.drift }));
			// ★ 2026-10-17 缺陷修复：绝对路径整串铺在面板里会撑爆这一行（用户实测在 `tasks.j n` 处断字）
			//   ⇒ 只显示**末两段**，全文进 `title`（悬停可读）。路径本身一个字符都没改，只是显示。
			nodes.push(h("div", { key: "meta", className: "tc-tasks-meta", title: data.path || "" },
				"账本 rev=" + String(data.rev || 0) + " · " + shortLedgerPath(data.path)
				+ (data.malformed ? " · ⚠ 文件畸形（写面已 fail-closed）" : "")));
			if (data.offNote) {
				nodes.push(h("div", { key: "off", className: "tc-tasks-note" }, data.offNote));
				return h("div", { className: "tc-tasks-body" }, nodes);
			}
			// —— 三区切换（批 36-补）：计数由 host 给，本组件不自己数 ——
			var scopes = data.scopes || [];
			if (scopes.length > 0 && typeof onScope === "function") {
				nodes.push(h("div", { key: "scopes", className: "tc-tasks-actions" },
					scopes.map(function (s) {
						return h("button", {
							key: s.key,
							className: "tc-btn" + (s.key === activeScope ? " primary" : ""),
							onClick: function () { onScope(s.key); },
						}, s.title + "（" + (s.count || 0) + "）");
					})));
			}
			// 批36-补3（五态环图；腿见设计档 §19.9「环图腿」）—— 数据从 `payload.ledger` 的**行**自己数（**不读**
			//   `payload.counts`，理由见 TasksStateDonut 的注释：`counts.doing` 把「已接手」并进「在做」）。
			//   总数 0 / mode=off ⇒ 组件返回 null（不渲染空环图）。
			nodes.push(h(TasksStateDonut, { key: "donut", ledger: data.ledger }));
			// 当前区的渲染面（`views[scope]`；老载荷/无分区时回落顶层字段 ⇒ 行为与此前逐字相同）
			var view = (data.views && data.views[activeScope]) || data;
			if (view.emptyState) {
				nodes.push(h("div", { key: "empty", className: "tc-tasks-empty" }, view.emptyState));
				return h("div", { className: "tc-tasks-body" }, nodes);
			}
			var sections = view.sections || [];
			for (var i = 0; i < sections.length; i++) {
				var s = sections[i];
				if (s.countOnly) {
					// ★ 2026-10-17 规则统一（与 lib/tool-tasks.mjs 的 renderSections 同改）：
					//   T-14「空分区不渲染」原先漏了 countOnly 分支 ⇒ 没有已完成项时照样打「已完成（0）」。
					if ((s.count || 0) === 0) continue;
					nodes.push(h("div", { key: s.key, className: "tc-tasks-sec" }, "—— " + s.title + "（" + (s.count || 0) + "）——"));
					continue;
				}
				var list = s.tasks || [];
				if (list.length === 0) continue; // 空分区**不渲染**（T-14）
				nodes.push(h("div", { key: s.key, className: "tc-tasks-sec" },
					h("div", { className: "tc-tasks-h" }, s.title + "（" + list.length + "）" + (s.top ? " · 置顶" : "")),
					s.key === "decisions" && view.copyAllDecisions
						// ★ 2026-10-17 样式修复：原先是裸 button ⇒ 在 flex-column 容器里被拉成**整条绿色长条**
						//   （用户实测截图）。包进 `.tc-tasks-actions`（display:flex）⇒ 按内容自适应宽度。
						? h("div", { className: "tc-tasks-actions" },
							h("button", { className: "tc-btn primary", onClick: function () { onCopyAll(view.copyAllDecisions); } }, "复制全部待你决策的项"))
						: null,
					list.map(function (t) {
						return h(TaskRow, { key: t.id, task: t, isOpen: openId === t.id, onDetail: onDetail, onCopy: onCopy, onSideChat: onSideChat, onClaim: onClaim });
					})));
			}
			nodes.push(h("div", { key: "readonly", className: "tc-tasks-note" },
				"看板不能打勾/改进度——完成必须带凭据；唯一的归属写入是「接手」（只改 owner，不改状态）。"));
			// FR-8 / US-10：结构化文档只读源（勾选态 + 「验收五件齐没齐」；**不可写**）
			var docs = data.docs || [];
			if (docs.length > 0) {
				var docNodes = [h("div", { key: "docsh", className: "tc-tasks-h" }, "结构化文档（只读）")];
				for (var d = 0; d < docs.length; d++) {
					var doc = docs[d];
					if (!doc.ok) {
						docNodes.push(h("div", { key: "d" + d, className: "tc-tasks-check" }, doc.path + "：⚠ " + doc.error));
						continue;
					}
					var c = doc.counts || {};
					docNodes.push(h("div", { key: "d" + d, className: "tc-tasks-check" },
						doc.path + "：共 " + (c.total || 0) + " 条 · TODO " + (c.TODO || 0) + " · DOING " + (c.DOING || 0)
						+ " · BLOCKED " + (c.BLOCKED || 0) + " · PASS " + (c.PASS || 0) + " · FAIL " + (c.FAIL || 0)
						+ " · 未识别 " + (c.UNKNOWN || 0)));
					var rows = (doc.rows || []).slice(0, 12);
					for (var r = 0; r < rows.length; r++) {
						docNodes.push(h("div", { key: "d" + d + "r" + r, className: "tc-tasks-kv" },
							"  [" + (rows[r].status || "—") + "] " + rows[r].id + " " + rows[r].title
							+ (rows[r].piecesComplete ? " · 五件齐" : " · 五件不齐")));
					}
					if ((doc.rows || []).length > rows.length) {
						docNodes.push(h("div", { key: "d" + d + "more", className: "tc-tasks-note" }, "  …还有 " + ((doc.rows || []).length - rows.length) + " 条"));
					}
				}
				nodes.push(h("div", { key: "docs", className: "tc-tasks-sec" }, docNodes));
			}
			return h("div", { className: "tc-tasks-body" }, nodes);
		}

		/** 状态栏文案（折叠时也可见：用户不用展开就知道有没有待决策的项）。 */
		function tasksSummary(data) {
			if (!data) return "任务台账：加载中…";
			if (data.mode === "off") return "任务台账：已关闭（ledger.mode=off）";
			var c = data.counts || {};
			// ★ 2026-10-17 标签更正：`counts.active` 是 **待办+已接手+在做** 三态的合计，
			//   原标成「在做」会与行上的 `[待办]` 打架（用户实测截图就撞上了）⇒ 改「在办」。
			// ★ 批 36-补：折叠态也把「待接手」显示出来 —— 换了新会话时，**不展开也知道有前任留下的活**。
			var claimable = 0;
			var scopes = data.scopes || [];
			for (var si = 0; si < scopes.length; si++) { if (scopes[si].key === "claimable") claimable = scopes[si].count || 0; }
			return "任务台账：待你决策 " + (c.decisions || 0) + " · 在办 " + (c.active || 0)
				+ " · 卡住 " + (c.blocked || 0) + " · 完成 " + (c.done || 0)
				+ " · 待接手 " + claimable + " · rev " + String(data.rev || 0);
		}

		/**
		 * 侧栏 tab 组件（**默认展开**——用户定调；腿见设计档 §19.9「默认展开腿」：
		 * 打开就看到五态环图与任务，不用先点一下；折叠分支与「收起/展开」按钮**保留**，随时可切）。
		 */
		function TasksTab(props) {
			// ★ 2026-10-18 评审 #4：props 的 scope 与「当前选中的区」曾**同名 `var scope`**（后者遮蔽前者）——
			//   第二个声明之后任何人读 `scope.sessionId` 都会拿到字符串态。这里一拆为二：propsScope / scopeKey。
			var propsScope = (props && props.scope) || {};
			var sessionId = propsScope.sessionId || null;
			var visible = !(props && props.visible === false);
			var st = useState({ loading: true, data: null, error: null });
			var state = st[0], setState = st[1];
			var ex = useState(true);
			var expanded = ex[0], setExpanded = ex[1];
			var dt = useState(null);
			var openId = dt[0], setOpenId = dt[1];
			var mn = useState("");
			var manual = mn[0], setManual = mn[1];
			// ★ 批 36-补：三区切换（初值 null ⇒ 用 host 给的 `defaultScope`：有会话 = mine，无会话 = all）
			var sc = useState(null);
			var scopeKey = sc[0], setScopeKey = sc[1];
			var load = useCallback(function () {
				fetchTasks(sessionId).then(function (d) {
					if (d && d.ok !== false) setState({ loading: false, data: d, error: null });
					else setState({ loading: false, data: null, error: (d && d.error) || "配置 API 不可用" });
				}, function (e) {
					setState({ loading: false, data: null, error: String((e && e.message) || e) });
				});
			}, [sessionId]);
			var onCopy = useCallback(function (text) { copyOrShow(String(text || ""), setManual); }, []);
			var onCloseManual = useCallback(function () { setManual(""); }, []);
			// ★ 2026-10-17 U-1 实测后新增：**先复制话术，再打开侧边会话**。
			//   打不开也照样复制（复制是主收益）；能打开就省掉一次手动开 tab。
			var onSideChat = useCallback(function (t) {
				onCopy(t && t.copyPrompt);
				openSideChatTab();
			}, [onCopy]);
			// ★ 批 36-补：**接手**（交接那一下）。成功 ⇒ 用 host 回来的**刷新后载荷**直接重渲染；
			//   失败 ⇒ **如实降级**：把等价命令 `/task_claim <id>` ＋ 写门的拒绝原文交到用户手里
			//   （写门那侧已经保证零写入，这里绝不假装「已接手」）。
			var onClaim = useCallback(function (t) {
				if (!t || !t.id) return;
				claimTask(sessionId, t.id).then(function (d) {
					if (d && d.ok !== false && d.generatedFrom === "readTasksView") {
						setState({ loading: false, data: d, error: null });
						return;
					}
					copyOrShow("/task_claim " + t.id + " —— " + String((d && (d.text || d.error)) || "接手失败"), setManual);
				}, function (e) {
					copyOrShow("/task_claim " + t.id + " —— " + String((e && e.message) || e), setManual);
				});
			}, [sessionId]);
			useEffect(function () { if (visible) load(); }, [visible, sessionId]);
			useEffect(function () {
				if (!visible) return undefined;
				var t = setInterval(load, TASKS_POLL_MS);
				return function () { clearInterval(t); };
			}, [visible, sessionId]);
			var data = state.data;
			// 当前区（未选过 ⇒ 用 host 的 defaultScope；再没有 ⇒ mine）
			var activeScope = scopeKey || (data && data.defaultScope) || "mine";
			var head = h("div", { className: "tc-tasks-head" },
				h("span", null, tasksSummary(data)),
				h("button", { className: "tc-btn", onClick: load }, "刷新"),
				h("button", { className: "tc-btn", onClick: function () { setExpanded(!expanded); setOpenId(null); } }, expanded ? "收起" : "展开"));
			if (!expanded) return h("div", { className: "tc-tasks" }, head);
			// ★★ 2026-10-17 **止血 + 可见化**：用户实测「重启后面板 tab 在、内容全白」。
			//   若看板正文在渲染时抛错，React 会把整块吞掉 ⇒ 用户只看到空白，**连错都看不到**。
			//   `TasksBoardBody` 是**纯函数（零 hook，已核）** ⇒ 就地调用并用 try/catch 兜住，
			//   把异常变成**屏幕上可见的一行**（既止血又留下诊断线索）。
			var boardBody = null
			if (data) {
				try {
					boardBody = TasksBoardBody({
						data: data,
						openId: openId,
						activeScope: activeScope,
						onScope: function (k) { setScopeKey(k); setOpenId(null); },
						onDetail: function (t) { setOpenId(openId === t.id ? null : t.id); },
						onCopy: onCopy,
						onCopyAll: onCopy,
						onSideChat: onSideChat,
						onClaim: onClaim,
					})
				} catch (rendErr) {
					boardBody = h("div", { className: "tc-msg error" },
						"看板渲染失败（已兜住，面板不再空白）：" + (rendErr && rendErr.message ? rendErr.message : String(rendErr)))
				}
			}
			return h("div", { className: "tc-tasks" },
				head,
				state.error ? h("div", { className: "tc-msg error" }, "看板数据不可得：" + state.error) : null,
				boardBody,
				manual ? h("div", { className: "tc-tasks-manual" },
					h("div", { className: "tc-tasks-note" }, "剪贴板不可用：下面是可选中文本，请手动复制。"),
					h("pre", { className: "tc-cmd" }, manual),
					h("button", { className: "tc-btn", onClick: onCloseManual }, "知道了")) : null);
		}
		//#endregion

		var inject = ["slots", "connection"];

		function apply(ctx) {
			// 评审 #9：style 生命周期跟踪——effect dispose 时移除（注释与实现一致）
			var styleTag = ensureStyle();
			var connection = null;
			try { connection = ctx.get("connection"); } catch (e) { connection = null; }
			var api = (connection && connection.api) || null;
			ctx.effect(function () {
				var disposeSlot = ctx.slots.inject("settings.section", function () {
					return ctx.slots.register({
						name: "settings.section",
						id: "thincoder",
						order: 40,
						label: function () { return "Thincoder"; },
						inject: function () { return { api: api }; },
					}, ThincoderPage);
				});
				// —— 批 36：任务台账看板 tab（**可选依赖**：better-sidebar 缺席 ⇒ 静默跳过、绝不抛）——
				// ★ 用 `ctx.get` 取服务，**不写进 `inject`**（声明的服务在宿主缺席 ⇒ 整个客户端半边永久
				//   pending，连设置页一起死——设计档 §五末的注 + 腿 T-8①）。
				// ★ 注册失败（服务形状不认识 / registerTab 抛错）⇒ 只 warn，**不影响**设置页与其它功能。
				var disposeTab = null;
				// ★★ 2026-10-17 **真实事故修复**（DSH 0.2.0-rc.2 → 0.2.1-rc.2 更新后侧栏面板消失）：
				//   原实现**只取一次** `ctx.get("betterSidebar")`，拿不到就静默跳过注册 ⇒
				//   tab 的**描述符**还从持久化恢复着（标签条上仍有名字），但**渲染器没注册**
				//   ⇒ better-sidebar 显示「这类内容还没有可用的查看方式。」**且零 console 报错**。
				//   实测证据（父会话用 DevTools）：模块**已加载**（Sources 的 plugins/@dsh-external 下有我们），
				//   但 `thincoder` 在 Console 里 **0 条**（不是崩了，是根本没走到注册）。
				//   ⇒ 改成**有界重试**：服务在上层插件装配完才 provide，apply 时机可能更早。
				var tabRetryTimer = null;
				var tabRetries = 0;
				var TAB_RETRY_MAX = 24;      // 24 × 250ms = 6s 上限
				var TAB_RETRY_MS = 250;
				function registerTasksTab() {
					var betterSidebar = null;
					try { betterSidebar = ctx.get("betterSidebar"); } catch (e2) { betterSidebar = null; }
					tasksSidebar = betterSidebar; // 供「在侧边聊」按钮用（组件在 factory 层，拿不到这里的 ctx）
					if (!betterSidebar || typeof betterSidebar.registerTab !== "function") {
						tasksSidebar = null;
						return false;
					}
					disposeTab = betterSidebar.registerTab({
						id: TASKS_TAB_ID,
						title: function () { return "Thincoder 任务"; },
						description: function () { return "个人任务台账看板（只读）：待你决策的项置顶 · 卡住 · 在办 · 完成计数"; },
						order: 55,
						single: true,
						component: TasksTab,
					});
					// ★ 注册之后**必须再 openTab 一次**，否则类型已注册但侧栏里什么都不出现（缺口修复，见上方长注释）。
					try {
						if (typeof betterSidebar.openTab === "function" && !tasksAutoOpened) {
							tasksAutoOpened = true;
							betterSidebar.openTab({ type: TASKS_TAB_ID });
						}
					} catch (e6) {
						try { console.warn("[thincoder-suite] 任务看板 openTab 失败（tab 类型仍已注册，可由侧栏手动打开）：" + (e6 && e6.message ? e6.message : e6)); } catch (e7) { /* noop */ }
					}
					return true;
				}
				try {
					if (!registerTasksTab()) {
						// 服务还没就绪 ⇒ 有界重试（成功一次即停；上限到了只 warn 一条，不刷屏）
						tabRetryTimer = setInterval(function () {
							tabRetries += 1;
							var okNow = false;
							try { okNow = registerTasksTab(); } catch (e8) { okNow = false; }
							if (okNow || tabRetries >= TAB_RETRY_MAX) {
								if (tabRetryTimer) { clearInterval(tabRetryTimer); tabRetryTimer = null; }
								if (!okNow) {
									try { console.warn("[thincoder-suite] betterSidebar 服务在 " + (TAB_RETRY_MAX * TAB_RETRY_MS) + "ms 内未就绪 ⇒ 任务看板 tab 未注册（设置页与工具不受影响）"); } catch (e9) { /* noop */ }
								}
							}
						}, TAB_RETRY_MS);
					}
				} catch (e3) {
					disposeTab = null;
					try { console.warn("[thincoder-suite] better-sidebar tab 注册失败（已跳过，看板降级为会话内渲染）：" + (e3 && e3.message ? e3.message : e3)); } catch (e4) { /* noop */ }
				}
				return function () {
					try { if (tabRetryTimer) { clearInterval(tabRetryTimer); tabRetryTimer = null; } } catch (e0) { /* noop */ }
					try { if (typeof disposeTab === "function") disposeTab(); } catch (e5) { /* already disposed */ }
					try { disposeSlot(); } catch (e) { /* already disposed */ }
					if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
				};
			}, "thincoder-suite: settings page");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});


