/**
 * 状态面板 UI（Webview）。
 *
 * 分工：状态栏的悬浮提示只讲**本次会话的消耗**，站点与模型的细节都落在这里——
 * 站点信息（地址、网关版本、延迟、最近刷新、列表来源）、配置问题、模型清单
 * （含每个数值的来源）、会话用量、适配器链、日志入口。
 *
 * 渲染：HTML 骨架只生成一次，状态通过 `postMessage` 增量下发；模型清单可能上百条，
 * 不放进每次下发的 state 里，而是按需请求一次。Webview 脚本**全部用 DOM API 构造节点**
 * （`textContent`）而不拼 innerHTML——模型 ID、站点名都来自外部，拼字符串必然要处理转义，
 * 而转义写错就是注入漏洞。
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { PANEL_VIEW_TYPE } from '../consts';
import type { Logger } from '../logger';
import type { StatusService, StatusState } from './statusService';

/** 面板里展示的模型行。字段都已转成「可展示」的形式或原始数值。 */
export interface PanelModelRow {
	readonly id: string;
	readonly name: string;
	readonly detail: string;
	/** 所属配置组（配置组名缺失时为供应商显示名） */
	readonly group: string;
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly imageInput: boolean;
	readonly toolCalling: boolean;
	/** 是否具备思考能力（模型选择器里会出现思考强度选项） */
	readonly reasoning: boolean;
	readonly vendor?: string;
	readonly ownedBy?: string;
	/** 命中的本地模型数据表键（未命中时为空） */
	readonly datasetKey?: string;
	/** 上下文窗口的来源，便于用户判断该不该信任这个数值 */
	readonly contextSource: string;
}

/** 模型清单负载（按需下发）。 */
export interface PanelModelsPayload {
	readonly rows: readonly PanelModelRow[];
	readonly filtered: readonly { readonly id: string; readonly reason: string }[];
	readonly error?: string;
}

/** 面板能触发的动作。由 extension.ts 注入，避免面板直接依赖命令实现。 */
export interface StatusPanelActions {
	refresh(forceModels: boolean): Promise<void>;
	/** 打开 VS Code 的「管理语言模型」界面（在那里配置站点与密钥） */
	openModelManagement(): Promise<void>;
	openSettings(): Promise<void>;
	showLogs(): void;
	resetUsage(): void;
}

/** 面板依赖。 */
export interface StatusPanelDeps {
	readonly logger: Logger;
	readonly service: StatusService;
	readonly actions: StatusPanelActions;
	/** 取当前模型清单 */
	getModels(): PanelModelsPayload;
}

/** Webview → 扩展的消息。 */
type WebviewMessage =
	| { type: 'ready' }
	| { type: 'refresh'; force?: boolean }
	| { type: 'openModelManagement' }
	| { type: 'openSettings' }
	| { type: 'showLogs' }
	| { type: 'resetUsage' }
	| { type: 'copy'; text?: string };

/** 状态面板。同一时间只允许一个实例。 */
export class StatusPanel implements vscode.Disposable {
	private panel: vscode.WebviewPanel | undefined;
	/** 与当前 panel 生命周期绑定的订阅 */
	private panelDisposables: vscode.Disposable[] = [];
	private readonly serviceListener: vscode.Disposable;

	constructor(private readonly deps: StatusPanelDeps) {
		// 面板未打开时也要订阅：用户可能先开了面板再关掉，这里只在有 panel 时做实际工作
		this.serviceListener = this.deps.service.onDidChange(state => this.postState(state));
	}

	/** 打开（或聚焦）面板。 */
	show(): void {
		if (this.panel !== undefined) {
			this.panel.reveal(undefined, true);
			this.postState();
			return;
		}

		const panel = vscode.window.createWebviewPanel(
			PANEL_VIEW_TYPE,
			'New API 状态',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				// 面板内容很小，恢复状态比保留上下文更省内存
				retainContextWhenHidden: false,
				localResourceRoots: [],
			},
		);
		panel.iconPath = new vscode.ThemeIcon('cloud');
		panel.webview.html = buildHtml(panel.webview);
		this.panel = panel;

		this.panelDisposables = [
			panel.webview.onDidReceiveMessage(message => void this.handleMessage(message as WebviewMessage)),
			panel.onDidChangeViewState(() => {
				if (panel.visible) {
					this.postState();
				}
			}),
			panel.onDidDispose(() => this.handleDispose()),
		];

		this.deps.logger.debug('状态面板已打开');
	}

	dispose(): void {
		this.serviceListener.dispose();
		this.disposePanel();
	}

	/* ---------------------------------------------------------------------- */

	/** 处理来自 Webview 的消息。 */
	private async handleMessage(message: WebviewMessage): Promise<void> {
		try {
			switch (message.type) {
				case 'ready':
					this.postState();
					return;
				case 'refresh':
					await this.deps.actions.refresh(message.force === true);
					return;
				case 'openModelManagement':
					await this.deps.actions.openModelManagement();
					return;
				case 'openSettings':
					await this.deps.actions.openSettings();
					return;
				case 'showLogs':
					this.deps.actions.showLogs();
					return;
				case 'resetUsage':
					this.deps.actions.resetUsage();
					return;
				case 'copy':
					if (typeof message.text === 'string' && message.text.length > 0) {
						await vscode.env.clipboard.writeText(message.text);
					}
					return;
				default:
					this.deps.logger.warn('收到未知的面板消息', message);
			}
		} catch (error) {
			this.deps.logger.error('处理面板消息失败', message.type, error);
		}
	}

	/** 下发状态。面板已关闭时什么也不做。 */
	private postState(state?: StatusState): void {
		if (this.panel === undefined) {
			return;
		}
		const payload = {
			type: 'state',
			state: state ?? this.deps.service.state,
			models: this.deps.getModels(),
		};
		void this.panel.webview.postMessage(payload);
	}

	private handleDispose(): void {
		this.deps.logger.debug('状态面板已关闭');
		this.disposePanel();
	}

	private disposePanel(): void {
		for (const disposable of this.panelDisposables) {
			disposable.dispose();
		}
		this.panelDisposables = [];
		this.panel = undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* HTML                                                                        */
/* -------------------------------------------------------------------------- */

function buildHtml(webview: vscode.Webview): string {
	const nonce = randomBytes(16).toString('hex');
	const csp = [
		"default-src 'none'",
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		"img-src data:",
	].join('; ');

	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>New API 状态</title>
<style nonce="${nonce}">
	:root { color-scheme: light dark; }
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: transparent;
		margin: 0;
		padding: 16px 20px 48px;
	}
	h1 { font-size: 1.35em; margin: 0 0 4px; }
	h2 { font-size: 1.05em; margin: 24px 0 8px; }
	.muted { color: var(--vscode-descriptionForeground); }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.spacer { flex: 1; }
	.badge {
		display: inline-flex; align-items: center; gap: 4px;
		padding: 1px 8px; border-radius: 10px; font-size: 0.9em;
		border: 1px solid var(--vscode-panel-border);
	}
	.badge.ok { border-color: var(--vscode-testing-iconPassed); color: var(--vscode-testing-iconPassed); }
	.badge.bad { border-color: var(--vscode-testing-iconFailed); color: var(--vscode-testing-iconFailed); }
	.badge.warn { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
	.alert {
		margin: 12px 0; padding: 10px 12px; border-radius: 6px;
		border: 1px solid var(--vscode-editorWarning-foreground);
		background: var(--vscode-inputValidation-warningBackground, transparent);
	}
	.alert ul { margin: 6px 0 0; padding-left: 20px; }
	.facts {
		display: grid; grid-template-columns: max-content 1fr;
		gap: 6px 16px; margin-top: 12px;
	}
	.facts dt { color: var(--vscode-descriptionForeground); }
	.facts dd { margin: 0; word-break: break-all; }
	table { border-collapse: collapse; width: 100%; font-size: 0.95em; }
	th, td {
		text-align: left; padding: 5px 8px;
		border-bottom: 1px solid var(--vscode-panel-border);
		vertical-align: top;
	}
	th { color: var(--vscode-descriptionForeground); font-weight: 600; }
	tbody tr:hover { background: var(--vscode-list-hoverBackground); }
	code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
	.caps { white-space: nowrap; }
	.caps span { margin-right: 4px; }
	.empty { padding: 12px; color: var(--vscode-descriptionForeground); }
	.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
	button {
		font-family: inherit; font-size: inherit;
		color: var(--vscode-button-foreground);
		background: var(--vscode-button-background);
		border: none; border-radius: 2px; padding: 4px 12px; cursor: pointer;
	}
	button:hover { background: var(--vscode-button-hoverBackground); }
	button.secondary {
		color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
		background: var(--vscode-button-secondaryBackground, transparent);
		border: 1px solid var(--vscode-panel-border);
	}
	button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
	details { margin-top: 8px; }
	summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
(function () {
	var api = acquireVsCodeApi();
	var root = document.getElementById('root');

	/* 与扩展侧 format.ts 保持一致的口径；这里刻意用极简实现，避免为了几个格式化函数引入构建步骤 */
	function fmtTokens(n) {
		if (!n || !isFinite(n) || n <= 0) { return '未知'; }
		if (n >= 1000000) { return trim(n / 1000000) + 'M'; }
		if (n >= 1000) { return trim(n / 1000) + 'K'; }
		return String(Math.round(n));
	}
	function trim(v) { return v.toFixed(1).replace(/\\.0$/, ''); }
	function fmtDuration(ms) {
		if (ms === undefined || ms === null || !isFinite(ms) || ms < 0) { return '未知'; }
		if (ms < 1000) { return Math.round(ms) + 'ms'; }
		var s = ms / 1000;
		if (s < 60) { return trim(s) + 's'; }
		var m = Math.floor(s / 60);
		var rest = Math.round(s % 60);
		return rest === 0 ? m + 'm' : m + 'm' + rest + 's';
	}
	function fmtRelative(ts) {
		if (!ts) { return '从未'; }
		var diff = Math.max(0, Date.now() - ts);
		var s = Math.floor(diff / 1000);
		if (s < 10) { return '刚刚'; }
		if (s < 60) { return s + ' 秒前'; }
		var m = Math.floor(s / 60);
		if (m < 60) { return m + ' 分钟前'; }
		var h = Math.floor(m / 60);
		if (h < 24) { return h + ' 小时前'; }
		return Math.floor(h / 24) + ' 天前';
	}

	/* DOM 构造辅助：所有外部字符串都走 textContent，从根本上避免注入 */
	function h(tag, attrs, children) {
		var node = document.createElement(tag);
		if (attrs) {
			Object.keys(attrs).forEach(function (key) {
				var value = attrs[key];
				if (value === undefined || value === null || value === false) { return; }
				if (key === 'class') { node.className = value; }
				else if (key === 'text') { node.textContent = value; }
				else if (key === 'title') { node.title = value; }
				else if (key === 'onClick') { node.addEventListener('click', value); }
				else { node.setAttribute(key, value === true ? '' : value); }
			});
		}
		(children || []).forEach(function (child) {
			if (child === undefined || child === null || child === false) { return; }
			node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
		});
		return node;
	}

	function button(label, onClick, secondary) {
		return h('button', { onClick: onClick, class: secondary ? 'secondary' : undefined, text: label });
	}

	function factList(pairs) {
		var list = h('dl', { class: 'facts' });
		pairs.forEach(function (pair) {
			if (pair === null || pair === undefined) { return; }
			list.appendChild(h('dt', { text: pair[0] }));
			list.appendChild(h('dd', {}, pair[1]));
		});
		return list;
	}

	function badge(text, kind) {
		return h('span', { class: 'badge ' + (kind || ''), text: text });
	}

	function renderHeader(state) {
		var statusBadge;
		if (!state.anyUsable) {
			statusBadge = badge(state.targets.length === 0 ? '未配置' : '配置不完整', 'warn');
		} else if (state.targets.some(function (t) { return t.refreshing; })) {
			statusBadge = badge('刷新中…', '');
		} else if (state.targets.some(function (t) { return t.usable && t.models.error; })) {
			statusBadge = badge('部分不可用', 'bad');
		} else {
			statusBadge = badge('已连接', 'ok');
		}
		return h('div', {}, [
			h('div', { class: 'row' }, [
				h('h1', { text: 'New API for Copilot Chat' }),
				statusBadge,
				h('span', { class: 'spacer' }),
				button('刷新', function () { api.postMessage({ type: 'refresh' }); }),
				button('强制刷新模型', function () { api.postMessage({ type: 'refresh', force: true }); }, true),
			]),
			h('div', { class: 'muted', text: '当前状态由扩展实时维护；站点与密钥在 VS Code 的「管理模型」界面配置。' }),
		]);
	}

	/** 尚未配置任何站点时的引导。 */
	function renderEmptyState() {
		return h('div', { class: 'alert' }, [
			h('strong', { text: '尚未配置 New API 站点' }),
			h('div', { class: 'muted', text: '点击下方「打开配置界面」，在列表中找到 New API，填入站点地址与 API Key。可以为多个站点各建一个配置组。' }),
		]);
	}

	/** 配置不完整的站点：这些是需要用户处理的。 */
	function renderIssues(state) {
		var broken = state.targets.filter(function (t) { return !t.usable; });
		if (broken.length === 0) { return null; }
		var nodes = [h('strong', { text: '需要处理的配置' })];
		broken.forEach(function (target) {
			var item = h('div', { class: 'row' }, [
				h('strong', { text: target.label }),
				h('span', { text: '：' + target.issues.join('；') }),
			]);
			nodes.push(item);
		});
		return h('div', { class: 'alert' }, nodes);
	}

	function renderTargets(state) {
		if (state.targets.length === 0) { return null; }
		var rows = state.targets.map(function (target) {
			var statusCell;
			if (!target.usable) {
				statusCell = badge('未配置完整', 'warn');
			} else if (target.refreshing) {
				statusCell = badge('刷新中…', '');
			} else if (target.models.error) {
				statusCell = badge('不可用', 'bad');
			} else {
				statusCell = badge('可用', 'ok');
			}
			var endpoints = target.usable && target.gatewayVersion !== undefined
				? '/api/status 可用'
				: '/api/status 不可用';
			var capabilities = h('td', {}, [h('code', { text: endpoints })]);
			var statusDetail = null;
			if (target.usable && target.models.error) {
				statusDetail = h('div', { class: 'muted', text: target.models.hint || target.models.error });
			}
			var modelDetail = (target.models.filteredCount || target.models.invalidCount)
				? h('div', {
					class: 'muted',
					text: '过滤 ' + (target.models.filteredCount || 0) + ' · 无效 ' + (target.models.invalidCount || 0),
				})
				: null;
			// 列表是从网关新拉的还是沿用缓存，决定了「看到的数量」有多新鲜
			var fetchedDetail = target.models.fetchedAt
				? h('div', {
					class: 'muted',
					text: target.models.source === 'cache' ? '沿用缓存' : '本次拉取',
				})
				: null;
			return h('tr', {}, [
				h('td', {}, [
					h('div', { text: target.label }),
					target.siteName
						? h('div', {
							class: 'muted',
							text: target.siteName + (target.gatewayVersion ? ' (v' + target.gatewayVersion + ')' : ''),
						})
						: null,
				]),
				h('td', {}, [h('code', { text: target.baseUrl || '(未配置)' })]),
				h('td', {}, [statusCell, statusDetail]),
				h('td', {}, [h('div', { text: target.models.count + ' / ' + (target.models.rawCount || 0) }), modelDetail]),
				h('td', { text: target.latencyMs === undefined ? '—' : fmtDuration(target.latencyMs) }),
				h('td', { class: 'muted' }, [
					h('div', { text: target.models.fetchedAt ? fmtRelative(target.models.fetchedAt) : '—' }),
					fetchedDetail,
				]),
				capabilities,
			]);
		});
		return h('table', {}, [
			h('thead', {}, [h('tr', {}, [
				h('th', { text: '配置组' }),
				h('th', { text: '站点' }),
				h('th', { text: '状态' }),
				h('th', { text: '模型（可用 / 网关返回）' }),
				h('th', { text: '延迟' }),
				h('th', { text: '最近刷新' }),
				h('th', { text: '可选端点' }),
			])]),
			h('tbody', {}, rows),
		]);
	}

	function renderFacts(state) {
		var pairs = [
			['配置组数量', String(state.targets.length)],
			['可用模型总数', String(state.totalModels)],
			['日志级别', state.logLevel],
		];
		var filtered = state.targets.reduce(function (sum, t) { return sum + t.models.filteredCount; }, 0);
		if (filtered > 0) {
			pairs.push(['已过滤', filtered + ' 个（见下方「被过滤的模型」）']);
		}
		return factList(pairs);
	}

	function renderUsage(state) {
		var usage = state.usage;
		var tokens = usage.totalTokens > 0
			? fmtTokens(usage.promptTokens) + ' 输入 + ' + fmtTokens(usage.completionTokens) + ' 输出'
			: '上游未返回用量';
		// 缓存与思考只在真实存在时出现："命中 0" 与 "上游不报缓存" 是两件事（口径见 status/usage.ts）
		var cache = !usage.cacheReported
			? null
			: usage.cachedTokens > 0
				? fmtTokens(usage.cachedTokens)
					+ (usage.promptTokens > 0
						? '（' + Math.round(usage.cachedTokens / usage.promptTokens * 100) + '%）'
						: '')
				: '无命中';
		return factList([
			['请求次数', String(usage.requests)],
			['工具调用', String(usage.toolCalls)],
			['Token', tokens],
			['缓存命中', cache],
			['其中思考', usage.reasoningTokens > 0 ? fmtTokens(usage.reasoningTokens) : null],
			['最近请求', usage.lastRequestAt
				? fmtRelative(usage.lastRequestAt)
					+ (usage.lastModelId ? '（' + usage.lastModelId + '）' : '')
					+ (usage.lastTargetLabel ? ' · ' + usage.lastTargetLabel : '')
				: '本次会话尚无请求'],
		]);
	}

	function renderModels(payload) {
		if (!payload) {
			return h('div', { class: 'empty', text: '正在加载模型清单…' });
		}
		var nodes = [];
		if (payload.error) {
			nodes.push(h('div', { class: 'alert' }, [h('strong', { text: '模型列表可能不完整：' }), payload.error]));
		}
		if (!payload.rows || payload.rows.length === 0) {
			nodes.push(h('div', { class: 'empty', text: '没有可用的模型。请检查配置是否完整，以及 include/exclude 过滤设置。' }));
		} else {
			var head = h('tr', {}, [
				h('th', { text: '模型' }),
				h('th', { text: '配置组' }),
				h('th', { text: '上下文' }),
				h('th', { text: '最大输出' }),
				h('th', { text: '能力' }),
				h('th', { text: '窗口来源' }),
			]);
			var body = h('tbody', {});
			payload.rows.forEach(function (row) {
				var caps = h('span', { class: 'caps' }, [
					h('span', { text: row.imageInput ? '🖼' : '', title: row.imageInput ? '支持图片输入' : undefined }),
					h('span', { text: row.toolCalling ? '🔧' : '', title: row.toolCalling ? '支持工具调用' : undefined }),
					h('span', { text: row.reasoning ? '🧠' : '', title: row.reasoning ? '支持思考强度调整' : undefined }),
					h('span', { text: (!row.imageInput && !row.toolCalling && !row.reasoning) ? '📝' : '', title: '纯文本' }),
				]);
				var nameCell = h('div', {}, [
					h('div', { text: row.name }),
					h('div', { class: 'muted', text: row.id + (row.vendor ? ' · ' + row.vendor : '') }),
					row.detail ? h('div', { class: 'muted', text: row.detail }) : null,
				]);
				body.appendChild(h('tr', {}, [
					h('td', {}, [nameCell]),
					h('td', { class: 'muted', text: row.group }),
					h('td', { text: fmtTokens(row.contextWindow) }),
					h('td', { text: fmtTokens(row.maxOutputTokens) }),
					h('td', {}, [caps]),
					h('td', { class: 'muted', text: row.contextSource + (row.datasetKey ? '（' + row.datasetKey + '）' : '') }),
				]));
			});
			nodes.push(h('table', {}, [h('thead', {}, [head]), body]));
		}

		if (payload.filtered && payload.filtered.length > 0) {
			var items = h('ul', {});
			payload.filtered.forEach(function (item) {
				items.appendChild(h('li', { text: item.id + ' —— ' + item.reason }));
			});
			nodes.push(h('details', {}, [
				h('summary', { text: '被过滤的模型（' + payload.filtered.length + '）' }),
				items,
			]));
		}
		return h('div', {}, nodes);
	}

	function renderAdapters(state) {
		if (!state.adapters || state.adapters.length === 0) { return null; }
		var items = h('ul', {});
		state.adapters.forEach(function (adapter) {
			items.appendChild(h('li', { text: adapter.id + ' —— ' + adapter.description }));
		});
		return h('div', {}, [
			items,
			h('div', { class: 'muted', text: '适配器按模型处理上游的协议差异；只命中默认适配器时不对请求做任何改写。' }),
		]);
	}

	function renderActions() {
		return h('div', { class: 'actions' }, [
			button('打开配置界面', function () { api.postMessage({ type: 'openModelManagement' }); }),
			button('打开设置', function () { api.postMessage({ type: 'openSettings' }); }, true),
			button('显示日志', function () { api.postMessage({ type: 'showLogs' }); }, true),
			button('重置用量统计', function () { api.postMessage({ type: 'resetUsage' }); }, true),
		]);
	}

	var latest = { state: null, models: null };

	function render() {
		if (!latest.state) { return; }
		var state = latest.state;
		while (root.firstChild) { root.removeChild(root.firstChild); }
		root.appendChild(renderHeader(state));
		if (state.targets.length === 0) {
			root.appendChild(renderEmptyState());
		} else {
			var issues = renderIssues(state);
			if (issues) { root.appendChild(issues); }
		}
		root.appendChild(h('h2', { text: '配置组' }));
		var targets = renderTargets(state);
		root.appendChild(targets || h('div', { class: 'empty', text: '尚无配置组。' }));
		root.appendChild(h('h2', { text: '概览' }));
		root.appendChild(renderFacts(state));
		root.appendChild(h('h2', { text: '模型清单' }));
		root.appendChild(renderModels(latest.models));
		root.appendChild(h('h2', { text: '会话用量' }));
		root.appendChild(renderUsage(state));
		var adapters = renderAdapters(state);
		if (adapters) {
			root.appendChild(h('h2', { text: '模型适配器' }));
			root.appendChild(adapters);
		}
		root.appendChild(h('h2', { text: '操作' }));
		root.appendChild(renderActions());
	}

	window.addEventListener('message', function (event) {
		var message = event.data;
		if (!message || message.type !== 'state') { return; }
		latest.state = message.state;
		latest.models = message.models;
		render();
	});

	api.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
