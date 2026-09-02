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
		//#endregion

		var API = "/thincoder-suite/api";
		var EFFORTS = ["off", "low", "medium", "high", "max"];
		var GROUP_KEYS = ["round1", "convergence"];
		var GROUP_LABEL = { round1: "Round 1（首次全量评审）", convergence: "收敛轮（Round 2+）" };
		var TIMEOUT_MIN = 1000;
		var TIMEOUT_MAX = 3600000;

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
			if (hasPath(base, parts)) return "entry base";
			return "默认";
		}
		//#endregion

		//#region 内联校验（U3，与 host validateGlobalUserConfig 同规则；不重复后端实现）
		function validateDraft(draft) {
			var errors = [];
			var advisor = draft.advisor || {};
			GROUP_KEYS.forEach(function (gk) {
				var g = advisor[gk] || {};
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
			(draft.consultModels || []).forEach(function (row, i) {
				// 半行（只填 provider 或 model）报错；全空行（刚「+ 添加模型」）静默跳过
				if ((row.provider && !row.model) || (!row.provider && row.model)) {
					errors.push("模型池第 " + (i + 1) + " 行：provider/model 必须成对（全空行保存时忽略）");
				}
				if (row.effort && EFFORTS.indexOf(row.effort) === -1) errors.push("模型池第 " + (i + 1) + " 行：effort 非法");
			});
			if (draft.engCoderMaxTokens !== "" && draft.engCoderMaxTokens !== undefined && draft.engCoderMaxTokens !== null) {
				var mt = Number(draft.engCoderMaxTokens);
				if (!Number.isFinite(mt) || mt <= 0 || !Number.isInteger(mt)) errors.push("engCoderMaxTokens 必须是正整数");
			}
			if (draft.engCoderEffort && EFFORTS.indexOf(draft.engCoderEffort) === -1) {
				errors.push("engCoderEffort 必须是 off|low|medium|high|max");
			}
			return errors;
		}

		/** 草稿 → PUT /config 载荷（空字段不发送 = 不覆盖 base；池行按 poolDirty 显式表达）。 */
		function draftToPayload(draft) {
			var advisor = {};
			GROUP_KEYS.forEach(function (gk) {
				var g = draft.advisor[gk] || {};
				var out = {};
				if (g.provider) out.provider = g.provider;
				if (g.model) out.model = g.model;
				if (g.effort) out.effort = g.effort;
				if (g.timeoutMs !== "" && g.timeoutMs !== undefined && g.timeoutMs !== null) out.timeoutMs = Number(g.timeoutMs);
				if (Object.keys(out).length > 0) advisor[gk] = out;
			});
			if (draft.advisor && typeof draft.advisor.includeProjectGuide === "boolean") advisor.includeProjectGuide = draft.advisor.includeProjectGuide;
			var config = {};
			if (Object.keys(advisor).length > 0) config.advisor = advisor;
			// 评审 #4：池被用户动过（增/删/改）才发——完整行过滤后整体替换；全删 = 显式清空 []
			if (draft.poolDirty) {
				config.consultModels = (draft.consultModels || []).filter(function (r) { return r.provider && r.model; }).map(function (r) {
					var out = { provider: r.provider, model: r.model };
					if (r.effort) out.effort = r.effort;
					return out;
				});
			}
			if (draft.engCoderMaxTokens !== "" && draft.engCoderMaxTokens !== undefined && draft.engCoderMaxTokens !== null) {
				config.engCoderMaxTokens = Number(draft.engCoderMaxTokens);
			}
			if (draft.engCoderEffort) config.engCoderEffort = draft.engCoderEffort;
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
				};
			}
			return {
				advisor: {
					round1: group(a.round1),
					convergence: group(a.convergence),
					includeProjectGuide: typeof a.includeProjectGuide === "boolean" ? a.includeProjectGuide : false,
				},
				consultModels: Array.isArray(effective && effective.consultModels) ? effective.consultModels : [],
				engCoderMaxTokens: effective && effective.engCoderMaxTokens !== undefined ? String(effective.engCoderMaxTokens) : "",
				engCoderEffort: effective && typeof effective.engCoderEffort === "string" ? effective.engCoderEffort : "",
			};
		}
		//#endregion

		//#region 输入控件（catalog 可用 → select；不可用 → 文本输入 + 提示，实施确认项 5）

		/** provider 下拉/文本。catalog: {ok, providers: [{id,name}], byId}；draftValue 未出现在目录时补一行。 */
		function ProviderInput(props) {
			var catalog = props.catalog, value = props.value, onChange = props.onChange;
			if (catalog && catalog.ok && catalog.providers.length > 0) {
				var ids = catalog.providers.map(function (p) { return p.id; });
				var extra = value && ids.indexOf(value) === -1 ? [value] : [];
				return h("select", {
					className: "tc-field",
					value: value || "",
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
					onChange: function (e) { onChange(e.target.value); },
				}),
				h("div", { className: "tc-hint" }, "provider/model 目录不可用——手动输入 provider 路由键（保存时后端尽力校验存在性）。"),
			]);
		}

		function ModelInput(props) {
			var catalog = props.catalog, provider = props.provider, value = props.value, onChange = props.onChange;
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
					disabled: !provider,
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
				onChange: function (e) { onChange(e.target.value); },
			});
		}

		function EffortInput(props) {
			return h("select", {
				className: "tc-field",
				value: props.value || "",
				onChange: function (e) { props.onChange(e.target.value); },
			}, [
				h("option", { key: "", value: "" }, "（不设——适配器默认）"),
				EFFORTS.map(function (v) {
					return h("option", { key: v, value: v }, v);
				}),
			]);
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
				h("div", { className: "tc-hint" }, "会话 " + sessionId.slice(0, 20) + (sessionId.length > 20 ? "…" : "") + "（覆盖来源标注：会话覆盖 > 全局 user 层 > entry base）"),
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
			// —— 草稿 ——
			var [draft, setDraft] = useState(null);
			// —— UI ——
			var [msg, setMsg] = useState(null);   // {kind:'ok'|'error'|'info', text}
			var [busy, setBusy] = useState(false);
			var [errors, setErrors] = useState([]);

			var refreshView = useCallback(function () {
				return apiCall("GET", "/config").then(function (d) {
					if (!d || d.ok !== true) { setMsg({ kind: "error", text: "config API 不可用：" + ((d && d.error) || "未知错误") }); return null; }
					var user = d.user && typeof d.user === "object" ? d.user : {};
					setView({ base: d.base || {}, user: user, effective: d.effective || {} });
					// 评审 #8：草稿从 user 层播种（base 值不预填——避免「无改动保存把 base 快照进 user 层」；
					// 生效值已在各组卡片「当前生效基线」行展示，来源标注齐全）
					var seeded = effectiveToDraft(user);
					// 分歧审计 D1：user 层已有池 → 初始即 poolDirty（PUT 是整体替换——保存时不带池
					// 会把 user 层既有池清空回落 base）
					if (Array.isArray(user.consultModels)) seeded.poolDirty = true;
					setDraft(seeded);
					return d;
				});
			}, []);

			var refreshSession = useCallback(function (sid) {
				if (!sid) { setSummary(null); return; }
				return apiCall("GET", "/session?sessionId=" + encodeURIComponent(sid)).then(function (d) {
					setSummary(d && d.ok === true ? d : null);
					if (d && d.ok === false && d.reason) setMsg({ kind: "info", text: "会话视图：" + d.reason });
				});
			}, []);

			// 目录加载（实施确认项 5：connection.api.llm.providers/models；失败 → 文本输入降级）
			useEffect(function () {
				var cancelled = false;
				var cat = { ok: false, providers: [], byGroup: {} };
				function finish() {
					if (!cancelled) {
						if (cat.providers.length > 0) cat.ok = true;
						setCatalog(cat);
					}
				}
				if (!api || typeof api.llm !== "object" || api.llm === null) { finish(); return; }
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
				if (jobs.length === 0) { finish(); return; }
				Promise.all(jobs).then(finish, finish);
				return function () { cancelled = true; };
			}, [api]);

			// 初始加载
			useEffect(function () {
				refreshView();
			}, [refreshView]);
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
			}

			function setGroupField(gk, field, value) {
				setDraft(function (d) {
					if (!d) return d;
					var next = JSON.parse(JSON.stringify(d));
					if (!next.advisor) next.advisor = {};
					if (!next.advisor[gk]) next.advisor[gk] = { provider: "", model: "", effort: "", timeoutMs: "" };
					next.advisor[gk][field] = value;
					if (field === "provider") next.advisor[gk].model = ""; // provider 变更重置 model
					return next;
				});
				setErrors([]);
			}

			function saveGlobal() {
				var errs = validateDraft(draft);
				if (errs.length > 0) { setErrors(errs); return; }
				setBusy(true);
				setMsg(null);
				apiCall("PUT", "/config", { config: draftToPayload(draft) }).then(function (d) {
					if (!d || d.ok !== true) {
						var list = (d && Array.isArray(d.errors) ? d.errors : []);
						setMsg({ kind: "error", text: list.length > 0 ? "保存失败：" + list.join("；") : ("保存失败：" + ((d && d.error) || "未知错误")) });
						return;
					}
					setMsg({ kind: "ok", text: "已保存到 config.json user 层（无需重启，评审/工具下次调用即生效）" + ((d.notes && d.notes.length > 0) ? "；注意：" + d.notes.join("；") : "") });
					return refreshView();
				}).finally(function () { setBusy(false); });
			}

			function restoreGlobal() {
				setBusy(true);
				setMsg(null);
				apiCall("DELETE", "/config").then(function (d) {
					if (!d || d.ok !== true) {
						setMsg({ kind: "error", text: "恢复默认失败：" + ((d && d.error) || "未知错误") });
						return;
					}
					setMsg({ kind: "ok", text: "已清空 user 层——生效配置回落 entry base（cordis.patch.yml 启动快照，改 base 需重启）" });
					return refreshView();
				}).finally(function () { setBusy(false); });
			}

			function applySession() {
				if (!currentSessionId) return;
				var errs = validateDraft(draft);
				if (errs.length > 0) { setErrors(errs); return; }
				var advisor = {};
				GROUP_KEYS.forEach(function (gk) {
					var g = draft.advisor[gk] || {};
					var out = {};
					if (g.provider) out.provider = g.provider;
					if (g.model) out.model = g.model;
					if (g.effort) out.effort = g.effort;
					if (g.timeoutMs !== "" && g.timeoutMs !== undefined && g.timeoutMs !== null) out.timeoutMs = Number(g.timeoutMs);
					if (Object.keys(out).length > 0) advisor[gk] = out;
				});
				if (draft.advisor && typeof draft.advisor.includeProjectGuide === "boolean") advisor.includeProjectGuide = draft.advisor.includeProjectGuide;
				setBusy(true);
				apiCall("POST", "/apply-session", { sessionId: currentSessionId, advisor: advisor }).then(function (d) {
					if (!d || d.ok !== true) {
						var list = (d && Array.isArray(d.errors) ? d.errors : []);
						setMsg({ kind: "error", text: "应用到会话失败：" + (list.length > 0 ? list.join("；") : ((d && d.reason) || (d && d.error) || "未知错误")) });
						return;
					}
					setMsg({ kind: "ok", text: "已应用到当前会话（advisorOverride 更新）" });
					return refreshSession(currentSessionId);
				}).finally(function () { setBusy(false); });
			}

			function resetSession() {
				if (!currentSessionId) return;
				setBusy(true);
				apiCall("DELETE", "/session?sessionId=" + encodeURIComponent(currentSessionId)).then(function (d) {
					if (!d || d.ok !== true) {
						setMsg({ kind: "error", text: "恢复会话默认失败：" + ((d && d.reason) || (d && d.error) || "未知错误") });
						return;
					}
					setMsg({ kind: "ok", text: "已恢复会话默认（advisorOverride 清除）" });
					return refreshSession(currentSessionId);
				}).finally(function () { setBusy(false); });
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
				return h("div", { className: "tc-card", key: gk }, [
					h("div", { className: "tc-card-title" }, GROUP_LABEL[gk]),
					h("div", { className: "tc-baseline" }, "当前生效： " + baseline(gk)),
					h("div", { className: "tc-grid" }, [
						label("provider", h(ProviderInput, {
							catalog: catalog, value: g.provider,
							onChange: function (v) { setGroupField(gk, "provider", v); },
						})),
						label("model", h(ModelInput, {
							catalog: catalog, provider: g.provider, value: g.model,
							onChange: function (v) { setGroupField(gk, "model", v); },
						})),
						label("effort", h(EffortInput, {
							value: g.effort,
							onChange: function (v) { setGroupField(gk, "effort", v); },
						})),
						label("timeoutMs", h("input", {
							className: "tc-field", type: "number", min: TIMEOUT_MIN, max: TIMEOUT_MAX, step: 1000,
							placeholder: "缺省 " + (gk === "round1" ? "600000" : "300000"),
							value: g.timeoutMs,
							onChange: function (e) { setGroupField(gk, "timeoutMs", e.target.value); },
						})),
					]),
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
					h("div", { className: "tc-hint" }, "会诊与飞刀共用该池（escalate 读同一配置；首个为飞刀默认）。当前 " + rows.length + " 行（来源：" + effSrc + "）。保存后下次调用生效。"),
					rows.map(function (row, i) {
						return h("div", { className: "tc-row pool", key: "row" + i }, [
							h(ProviderInput, {
								catalog: catalog, value: row.provider,
								onChange: function (v) { setPoolRow(i, "provider", v); },
							}),
							h(ModelInput, {
								catalog: catalog, provider: row.provider, value: row.model,
								onChange: function (v) { setPoolRow(i, "model", v); },
							}),
							h("select", {
								className: "tc-field narrow", value: row.effort || "",
								onChange: function (e) { setPoolRow(i, "effort", e.target.value); },
							}, [
								h("option", { key: "", value: "" }, "effort: 默认"),
								EFFORTS.map(function (v) { return h("option", { key: v, value: v }, v); }),
							]),
							h("button", {
								className: "tc-btn ghost danger", type: "button",
								onClick: function () { removePoolRow(i); },
							}, "删"),
						]);
					}),
					h("button", {
						className: "tc-btn ghost", type: "button",
						onClick: addPoolRow,
					}, "+ 添加模型"),
				]);
			}

			function setPoolRow(i, field, value) {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true; // 评审 #4：池被编辑 → 保存时显式整体替换
					var rows = next.consultModels || (next.consultModels = []);
					if (!rows[i]) rows[i] = { provider: "", model: "", effort: "" };
					rows[i][field] = value;
					if (field === "provider") rows[i].model = "";
					return next;
				});
				setErrors([]);
			}
			function addPoolRow() {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true;
					var rows = next.consultModels || (next.consultModels = []);
					if (rows.length >= 5) return d;
					rows.push({ provider: "", model: "", effort: "" });
					return next;
				});
				setErrors([]);
			}
			function removePoolRow(i) {
				setDraft(function (d) {
					var next = JSON.parse(JSON.stringify(d));
					next.poolDirty = true;
					next.consultModels = (next.consultModels || []).filter(function (_, idx) { return idx !== i; });
					return next;
				});
				setErrors([]);
			}

			function engCard() {
				var effSrcMax = fieldSource(base, user, ["engCoderMaxTokens"]);
				var effSrcEff = fieldSource(base, user, ["engCoderEffort"]);
				var effMax = view.effective.engCoderMaxTokens;
				var effEff = view.effective.engCoderEffort;
				return h("div", { className: "tc-card", key: "eng" }, [
					h("div", { className: "tc-card-title" }, "eng_coder 子代理资源（F9）"),
					h("div", { className: "tc-hint" }, "实现子代理输出预算与推理档（低档把预算留给正文）。当前生效：maxTokens " + (effMax === undefined ? "65536（默认）" : effMax) + "（" + effSrcMax + "） · effort " + (effEff || "low（默认）") + "（" + effSrcEff + "）"),
					h("div", { className: "tc-grid" }, [
						label("engCoderMaxTokens", h("input", {
							className: "tc-field", type: "number", min: 1, step: 1024,
							placeholder: "默认 65536",
							value: draft.engCoderMaxTokens,
							onChange: function (e) { setField(["engCoderMaxTokens"], e.target.value); },
						})),
						label("engCoderEffort", h(EffortInput, {
							value: draft.engCoderEffort,
							onChange: function (v) { setField(["engCoderEffort"], v); },
						})),
					]),
				]);
			}

			var effIpg = view.effective.advisor;
			var ipgValue = effIpg && typeof effIpg.includeProjectGuide === "boolean" ? effIpg.includeProjectGuide : false;
			var ipgSource = fieldSource(base, user, ["advisor", "includeProjectGuide"]);

			return h("div", { className: "tc-page" }, [
				h("h3", { className: "tc-heading" }, "Thincoder 全局配置"),
				h("div", { className: "tc-hint" }, "编辑会写入 $DSH_HOME/.thincoder/config.json 的 user 层（字段级覆盖 cordis.patch.yml 的 entry base）；评审与工具每次调用时读取，保存即生效无需重启。"),
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
							onChange: function (e) { setField(["advisor", "includeProjectGuide"], e.target.checked); },
						}),
						h("span", null, "includeProjectGuide（评审注入 AGENTS.md 项目记忆）"),
					]),
					h("div", { className: "tc-hint" }, "默认 false：评审只认显式 documents=[...]，保持独立。当前生效："
						+ ipgValue + "（来源 " + ipgSource + "）"),
				]),
				consultPoolCard(),
				engCard(),
				h("div", { className: "tc-actions" }, [
					h("button", {
						className: "tc-btn primary", type: "button", disabled: busy,
						onClick: saveGlobal,
					}, "保存全局默认"),
					h("button", {
						className: "tc-btn ghost danger", type: "button", disabled: busy,
						onClick: restoreGlobal,
					}, "恢复默认（清 user 层）"),
				]),
			]);
		}

		//#endregion

		//#region apply / 注册（settings.section slot；样式一次性注入并在 dispose 时移除）

		var STYLE_ID = "thincoder-suite-settings-style";
		var STYLE_CSS = [
			".tc-page{display:flex;flex-direction:column;gap:12px;max-width:760px;padding:2px 0 18px;font-size:13px;line-height:1.55}",
			".tc-heading{margin:0;font-size:15px;font-weight:600}",
			".tc-card{border:1px solid rgba(128,128,128,.28);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}",
			".tc-card-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px}",
			".tc-badge{font-size:10px;padding:1px 8px;border-radius:10px;border:1px solid rgba(128,128,128,.4);color:#8a8a8a}",
			".tc-badge.on{background:rgba(46,204,113,.14);border-color:#2ecc71;color:#2ecc71}",
			".tc-hint{color:#8a8a8a;font-size:11.5px}",
			".tc-baseline{font-size:11.5px;color:#6a6a6a;background:rgba(128,128,128,.08);border-radius:6px;padding:4px 8px}",
			".tc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px}",
			".tc-fieldbox{display:flex;flex-direction:column;gap:3px;min-width:0}",
			".tc-fieldname{font-size:11px;color:#6a6a6a}",
			".tc-field{box-sizing:border-box;width:100%;min-width:0;font:inherit;padding:4px 7px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:inherit}",
			".tc-field:focus{outline:none;border-color:rgba(90,150,255,.7)}",
			".tc-field.narrow{width:auto;min-width:110px}",
			".tc-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}",
			".tc-row.pool>*{flex:1 1 140px}",
			".tc-cmd{font-family:ui-monospace,monospace;font-size:11.5px;resize:vertical}",
			".tc-summary{margin:0;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11.5px;background:rgba(128,128,128,.07);border-radius:6px;padding:6px 9px;max-height:150px;overflow:auto}",
			".tc-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;cursor:pointer}",
			".tc-btn.primary{background:#4a7dff;border-color:#4a7dff;color:#fff}",
			".tc-btn.ghost:hover{background:rgba(128,128,128,.12)}",
			".tc-btn.danger{border-color:rgba(221,51,51,.65);color:#d33}",
			".tc-btn:disabled{opacity:.5;cursor:not-allowed}",
			".tc-switchline{display:flex;gap:8px;align-items:center;cursor:pointer}",
			".tc-msg{padding:6px 10px;border-radius:7px;font-size:12px;white-space:pre-wrap}",
			".tc-msg.ok{background:rgba(46,204,113,.12);border:1px solid rgba(46,204,113,.4)}",
			".tc-msg.error{background:rgba(221,51,51,.1);border:1px solid rgba(221,51,51,.45)}",
			".tc-msg.info{background:rgba(90,150,255,.1);border:1px solid rgba(90,150,255,.35)}",
			".tc-errors{background:rgba(221,51,51,.1);border:1px solid rgba(221,51,51,.4);border-radius:7px;padding:6px 10px;font-size:12px;color:#d33}",
			".tc-errline{margin:1px 0}",
			".tc-actions{display:flex;gap:8px}",
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
