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
		// R5 §7.2（D-27 / UI-5）：dsh 后台任务挂死兜底截止合法区间（与后端 PUT 校验同规则）
		var DSHS_BG_TIMEOUT_MIN = 60000;
		var DSHS_BG_TIMEOUT_MAX = 3600000;

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

		//#region 内联校验（U3，与 host validateGlobalUserConfig 同规则；不重复后端实现）
		function validateDraft(draft) {
			var errors = [];
			var advisor = draft.advisor || {};
			GROUP_KEYS.forEach(function (gk) {
				var g = advisor[gk] || {};
				// 一期 codex-runner：runnerKind=codex-cli 的组免 provider/model 成对（model 走 codex 下拉）
				if (g.runnerKind === "codex-cli") {
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
			(draft.consultModels || []).forEach(function (row, i) {
				// 一期 codex-runner：runnerKind=codex-cli 的行免 provider/model 成对
				if (row.runnerKind === "codex-cli") {
					return;
				}
				// 半行（只填 provider 或 model）报错；全空行（刚「+ 添加模型」）静默跳过
				if ((row.provider && !row.model) || (!row.provider && row.model)) {
					errors.push("模型池第 " + (i + 1) + " 行：provider/model 必须成对（全空行保存时忽略）");
				}
				if (row.effort && EFFORTS.indexOf(row.effort) === -1) errors.push("模型池第 " + (i + 1) + " 行：effort 非法");
			});
			// codexCli 全局节（runnerKind=codex-cli 的行/组实际使用这些全局值）
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
					errors.push("codexCli.engCoderRunner 必须是 dsh|codex-cli");
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
			return errors;
		}

		/** 草稿 → PUT /config 载荷（空字段不发送 = 不覆盖 base；池行按 poolDirty 显式表达）。 */
		/** 组/池行 → runner 字段（draft 扁平字段 runnerKind/codexModel/codexEffort → schema 形态）。 */
		function runnerFromDraft(g) {
			if (g.runnerKind === "codex-cli") {
				var runner = { kind: "codex-cli" };
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
				if (g.runnerKind !== "codex-cli") {
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
			var config = {};
			if (Object.keys(advisor).length > 0) config.advisor = advisor;
			// 评审 #4：池被用户动过（增/删/改）才发——完整行过滤后整体替换；全删 = 显式清空 []
			if (draft.poolDirty) {
				config.consultModels = (draft.consultModels || []).filter(function (r) {
					if (r.runnerKind === "codex-cli") return true;
					return r.provider && r.model;
				}).map(function (r) {
					var out = {};
					var runner = runnerFromDraft(r);
					if (runner !== undefined) out.runner = runner;
					if (r.runnerKind !== "codex-cli") {
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
					// 评审 C1：runner 契约允许字符串简写（"dsh"/"codex-cli"）——归一化两种形态，
					// 否则字符串形态加载时显示为默认 dsh、保存时丢失 codex 行
					runnerKind: (function () {
						var rk = g.runner ? (typeof g.runner === "string" ? g.runner : g.runner.kind) : "";
						return (rk === "codex-cli" || rk === "dsh") ? rk : "";
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
				},
				// 池行扁平化：runner 对象/字符串 → runnerKind/codexModel/codexEffort 草稿字段（评审 C1 同源）
				consultModels: (Array.isArray(effective && effective.consultModels) ? effective.consultModels : []).map(function (r) {
					var rk = r && r.runner ? (typeof r.runner === "string" ? r.runner : r.runner.kind) : "";
					var flat = {
						provider: r && typeof r.provider === "string" ? r.provider : "",
						model: r && typeof r.model === "string" ? r.model : "",
						effort: r && typeof r.effort === "string" ? r.effort : "",
						runnerKind: (rk === "codex-cli" || rk === "dsh") ? rk : "", codexModel: "", codexEffort: "",
					};
					if (rk === "codex-cli" && r.runner && typeof r.runner === "object") {
						flat.codexModel = typeof r.runner.model === "string" ? r.runner.model : "";
						flat.codexEffort = typeof r.runner.effort === "string" ? r.runner.effort : "";
					}
					return flat;
				}),
				engCoderMaxTokens: effective && effective.engCoderMaxTokens !== undefined ? String(effective.engCoderMaxTokens) : "",
				engCoderEffort: effective && typeof effective.engCoderEffort === "string" ? effective.engCoderEffort : "",
				// UI-5（R5 §7.2）：dsh 后台任务挂死兜底截止（顶层全局字段——effective 数字 → 表单串）
				dshBackgroundTimeoutMs: effective && effective.dshBackgroundTimeoutMs !== undefined ? String(effective.dshBackgroundTimeoutMs) : "",
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
			if (touched["engCoderMaxTokens"]) next.engCoderMaxTokens = curOf(["engCoderMaxTokens"], "");
			if (touched["engCoderEffort"]) next.engCoderEffort = curOf(["engCoderEffort"], "");
			if (touched["dshBackgroundTimeoutMs"]) next.dshBackgroundTimeoutMs = curOf(["dshBackgroundTimeoutMs"], ""); // R5 UI-5：busy 窗口内的编辑保留
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
					className: "tc-field", type: "text", placeholder: "provider 路由键（如 qax）",
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

		/** runner 类型选择（一期 codex-runner）：未设/dsh/codex-cli。disabled（UI-3/D-12）：busy 窗口内禁用。 */
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
			]);
		}

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
				var errs = validateDraft(draft);
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
					if (g.runnerKind === "codex-cli") return;
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
				var isCodex = g.runnerKind === "codex-cli";
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
					h("div", { className: "tc-colhead" }, [
						h("span", null, "runner"),
						h("span", null, "provider / codex 模型"),
						h("span", null, "model / effort"),
						h("span", { style: { textAlign: "right" } }, ""),
					]),
					rows.map(function (row, i) {
						var rowCodex = row.runnerKind === "codex-cli";
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
					if (field === "runnerKind" && value === "codex-cli") rows[i].model = ""; // 切到 codex：清 dsh model
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

			var effIpg = view.effective.advisor;
			var ipgValue = effIpg && typeof effIpg.includeProjectGuide === "boolean" ? effIpg.includeProjectGuide : false;
			var ipgSource = fieldSource(base, user, ["advisor", "includeProjectGuide"]);
			var effMaxOut = effIpg && typeof effIpg.maxOutputTokens === "number" ? effIpg.maxOutputTokens : undefined;
			var maxOutSource = fieldSource(base, user, ["advisor", "maxOutputTokens"]);
			// UI-5（R5 §7.2 / D-27）：dsh 后台任务挂死兜底截止——当前生效 + 来源标注（U2）
			var effDshBg = view.effective.dshBackgroundTimeoutMs;
			var dshBgSource = fieldSource(base, user, ["dshBackgroundTimeoutMs"]);

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
		// 样式对齐宿主设置面板（v0.5）：全部使用宿主语义 token（--dsw-alias-*，主题随动），
		// 卡片用不透明表面 bg-layer-1 + border-l1；正文 ≥13px、提示 ≥12px（UX 审查）。
		var STYLE_CSS = [
			".tc-page{display:flex;flex-direction:column;gap:14px;max-width:780px;padding:2px 0 20px;font-size:13.5px;line-height:1.6;color:var(--dsw-alias-label-primary)}",
			".tc-heading{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".tc-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px}",
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
		].join("\n");

		function ensureStyle() {
			if (typeof document === "undefined") return null;
			var old = document.getElementById(STYLE_ID);
			if (old) return old;
			var tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.dataset.plugin = "@dsh-external/dsh-thincoder-suite";
			tag.textContent = STYLE_CSS;
			document.head.appendChild(tag);
			return tag;
		}

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
				return function () {
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
