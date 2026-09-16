/**
 * 状态栏 UI：只做渲染，不发请求、不做判断（状态全部来自 `StatusService`）。
 *
 * 状态栏只有一格位置，因此文本必须极短（`$(cloud) 12 模型`），细节放进 Markdown tooltip；
 * 颜色只在「需要用户行动」时使用（尚未配置、或已配置的站点连不上）。
 */

import * as vscode from 'vscode';
import { COMMANDS, MANAGE_MODELS_COMMAND, STATUS_BAR_PRIORITY } from '../consts';
import { formatDurationMs, formatRelativeTime, formatTokens } from '../format';
import type { Logger } from '../logger';
import type { StatusState, TargetStatus } from './statusService';

/** 状态栏项。 */
export class NewApiStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private visible = false;

	constructor(private readonly logger: Logger) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
		this.item.name = 'New API for Copilot Chat';
		this.item.command = COMMANDS.showPanel;
	}

	/** 按状态渲染。 */
	render(state: StatusState): void {
		if (!state.statusBarEnabled) {
			this.hide();
			return;
		}

		// 还没有可用配置时，点击直接进「管理模型」界面，
		// 省掉一次「打开面板 → 再找配置入口」。
		this.item.command = state.anyUsable ? COMMANDS.showPanel : MANAGE_MODELS_COMMAND;
		this.item.text = buildText(state);
		this.item.backgroundColor = needsAttention(state)
			? new vscode.ThemeColor('statusBarItem.warningBackground')
			: undefined;
		this.item.tooltip = buildTooltip(state);
		this.show();
	}

	dispose(): void {
		this.item.dispose();
	}

	private show(): void {
		if (this.visible) {
			return;
		}
		this.logger.trace('显示状态栏项');
		this.visible = true;
		this.item.show();
	}

	private hide(): void {
		if (!this.visible) {
			return;
		}
		this.logger.trace('隐藏状态栏项');
		this.visible = false;
		this.item.hide();
	}
}

/** 需要用户注意（着色）的状态。 */
function needsAttention(state: StatusState): boolean {
	if (!state.anyUsable) {
		return true;
	}
	// 有可用目标时，只有在「所有目标都连不上」的情况下才告警：
	// 配了多个站点时，其中一个临时挂掉不该让状态栏常亮。
	const attempted = state.targets.filter(target => target.usable);
	return attempted.length > 0 && attempted.every(target => target.models.error !== undefined);
}

/** 状态栏文本。必须极短。 */
function buildText(state: StatusState): string {
	if (!state.anyUsable) {
		return '$(warning) New API';
	}
	if (isRefreshing(state)) {
		return '$(sync~spin) New API';
	}
	return `$(cloud) ${state.totalModels} 模型`;
}

function isRefreshing(state: StatusState): boolean {
	return state.targets.some(target => target.refreshing) && state.totalModels === 0;
}

/** 悬浮提示。这里是用户了解细节的入口，可以详细一些。 */
function buildTooltip(state: StatusState): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString();
	tooltip.supportThemeIcons = true;
	tooltip.appendMarkdown('**New API for Copilot Chat**\n\n');

	if (state.targets.length === 0) {
		tooltip.appendMarkdown('$(warning) **尚未配置任何站点**\n\n');
		tooltip.appendMarkdown('点击开始配置，或执行命令「New API: 管理模型」。');
		return tooltip;
	}

	for (const target of state.targets) {
		appendTarget(tooltip, target);
	}

	if (state.usage.requests > 0) {
		const tokens = state.usage.totalTokens > 0
			? `${formatTokens(state.usage.totalTokens)} token`
			: '用量未返回';
		tooltip.appendMarkdown(`\n会话用量：${state.usage.requests} 次请求 / ${tokens}\n`);
	}

	tooltip.appendMarkdown('\n点击打开状态面板。');
	return tooltip;
}

/** 追加一个目标的详情。 */function appendTarget(tooltip: vscode.MarkdownString, target: TargetStatus): void {
	tooltip.appendMarkdown(`**${target.label}**\n\n`);

	if (!target.usable) {
		for (const issue of target.issues) {
			tooltip.appendMarkdown(`- $(warning) ${issue}\n`);
		}
		tooltip.appendMarkdown('\n');
		return;
	}

	tooltip.appendMarkdown(`- 站点：\`${target.baseUrl}\`\n`);
	if (target.siteName !== undefined) {
		const version = target.gatewayVersion === undefined ? '' : ` (v${target.gatewayVersion})`;
		tooltip.appendMarkdown(`- 网关：${target.siteName}${version}\n`);
	}
	if (target.refreshing) {
		tooltip.appendMarkdown('- 状态：$(sync~spin) 正在刷新…\n');
	} else if (target.models.error !== undefined) {
		tooltip.appendMarkdown(`- 状态：$(error) ${target.models.error}\n`);
		if (target.models.hint !== undefined) {
			tooltip.appendMarkdown(`- 建议：${target.models.hint}\n`);
		}
	} else {
		tooltip.appendMarkdown('- 状态：$(pass) 可用\n');
	}
	if (target.latencyMs !== undefined) {
		tooltip.appendMarkdown(`- 延迟：${formatDurationMs(target.latencyMs)}\n`);
	}
	tooltip.appendMarkdown(`- 模型：${target.models.count} 个`);
	if (target.models.filteredCount > 0) {
		tooltip.appendMarkdown(`（已过滤 ${target.models.filteredCount} 个）`);
	}
	tooltip.appendMarkdown('\n');
	if (target.models.fetchedAt !== undefined) {
		tooltip.appendMarkdown(`- 最近刷新：${formatRelativeTime(target.models.fetchedAt)}\n`);
	}
	tooltip.appendMarkdown('\n');
}
