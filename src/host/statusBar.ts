import * as vscode from 'vscode';
import { STATUS_BAR_PRIORITY } from '../shared/consts';
import { escapeMarkdown, formatTokens } from '../shared/format';
import type { Logger } from '../shared/log';
import type { ModelStatus } from '../application/modelStatus';
import type { UsageStats } from '../application/usage';
import type { SiteHealth } from '../application/siteHealth';

/** Renders model snapshots, independent probe results and session usage without network I/O. */
export class NewApiStatusBar implements vscode.Disposable {
	private readonly item: vscode.StatusBarItem;
	private visible = false;

	constructor(private readonly logger: Logger) {
		this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, STATUS_BAR_PRIORITY);
		this.item.name = 'New API for Copilot Chat';
	}

	render(state: ModelStatus, enabled: boolean, usage?: UsageStats, probes: ReadonlyMap<string, SiteHealth> = new Map()): void {
		if (!enabled) {
			if (this.visible) {
				this.item.hide();
				this.visible = false;
			}
			return;
		}
		const hasError = state.targets.some(target => target.error !== undefined || probes.get(target.key)?.available === false);
		this.item.text = hasError ? state.totalModels ? `$(warning) ${state.totalModels} 模型` : '$(warning) New API'
			: state.targets.length ? `$(cloud) ${state.totalModels} 模型` : '$(cloud) New API';
		this.item.backgroundColor = hasError ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		if (hasError) {
			this.item.tooltip = undefined;
			this.show();
			return;
		}
		const tooltip = new vscode.MarkdownString();
		tooltip.supportThemeIcons = true;
		tooltip.appendMarkdown('**New API for Copilot Chat**\n\n');
		if (!state.targets.length) {
			tooltip.appendMarkdown('尚未加载模型');
		} else {
			tooltip.appendMarkdown(`已加载 ${state.totalModels} 个模型`);
			for (const target of state.targets) {
				const probe = probes.get(target.key);
				tooltip.appendMarkdown(`\n\n**${escapeMarkdown(target.label)}** · `);
				if (!probe) { tooltip.appendMarkdown('尚未完成探活'); }
				else {
					tooltip.appendMarkdown(`${probe.latencyMs}ms`);
					tooltip.appendMarkdown(` · ${new Date(probe.checkedAt).toLocaleTimeString()}`);
				}
			}
		}
		if (usage && usage.requests > 0) { tooltip.appendMarkdown(`\n\n${describeUsage(usage)}`); }
		this.item.tooltip = tooltip;
		this.show();
	}

	private show(): void {
		if (!this.visible) {
			this.logger.trace('显示模型状态栏');
			this.item.show();
			this.visible = true;
		}
	}

	dispose(): void { this.item.dispose(); }
}

function describeUsage(usage: UsageStats): string {
	const tokens = (value: number) => value === 0 ? '0' : formatTokens(value);
	const lines = [`**本次扩展会话**：${usage.requests} 次请求 · ${usage.toolCalls} 次工具调用`];
	if (usage.reportedRequests === 0) { lines.push('上游未返回 token 用量'); }
	else {
		lines.push(`输入：${tokens(usage.promptTokens)} · 输出：${tokens(usage.completionTokens)} · 合计：${tokens(usage.totalTokens)} token`);
		if (usage.cacheReported) {
			const rate = usage.promptTokens > 0 ? `（${Math.round(usage.cachedTokens / usage.promptTokens * 100)}%）` : '';
			lines.push(`缓存命中：${tokens(usage.cachedTokens)}${rate}`);
		}
		if (usage.reasoningTokens > 0) { lines.push(`其中思考：${tokens(usage.reasoningTokens)} token`); }
		if (usage.reportedRequests < usage.requests) { lines.push(`${usage.reportedRequests} 次请求返回了 token 用量`); }
	}
	if (usage.lastRequestAt !== undefined) {
		lines.push(`最近请求：${new Date(usage.lastRequestAt).toLocaleTimeString()} · ${escapeMarkdown(usage.lastTargetLabel ?? '')} · ${escapeMarkdown(usage.lastModelId ?? '')}`);
	}
	return lines.join('\n\n');
}
