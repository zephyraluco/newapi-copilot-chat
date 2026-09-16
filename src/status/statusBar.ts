/**
 * 状态栏 UI：只做渲染，不发请求、不做判断（状态全部来自 `StatusService`）。
 *
 * 状态栏只有一格位置，因此文本必须极短（`$(cloud) 12 模型`）。悬浮提示讲的是**本次会话**：
 * 请求次数、输入输出 token、缓存命中——用户盯的是「刚刚这一下贵不贵」。站点地址、网关版本、
 * 延迟、模型数量这些**站点细节在状态面板**里（那里铺得开，还能刷新），这里不复述。
 *
 * 两件刻意的事：
 *
 * - **没有会话数据时不弹提示**。空闲时悬停给出一句「还没有请求」是纯噪声，还容易被当成出错。
 * - 提示里唯一保留的站点信息是「哪里出了问题」，因为状态栏此时已被着色，用户需要一个理由。
 */

import * as vscode from 'vscode';
import { COMMANDS, MANAGE_MODELS_COMMAND, STATUS_BAR_PRIORITY } from '../consts';
import { formatRelativeTime, formatTokens } from '../format';
import type { Logger } from '../logger';
import type { StatusState, TargetStatus, UsageStats } from './statusService';
import { describeCacheHit } from './usage';

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
		// `undefined` 表示「这次没什么可说的」，VS Code 会连悬浮框一起省掉
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

/**
 * 悬浮提示：只讲本次会话的消耗，外加需要用户动手的问题。
 *
 * **没有会话数据、也没有问题时返回 `undefined`**——那样悬停不该弹出任何东西。空壳提示
 * （一句「还没有请求」）既没信息量，又让人以为扩展在报错；状态栏文本自己就说明了可用性。
 *
 * 导出供测试：它需要 `vscode` 才能构造 MarkdownString，但逻辑是纯的（同输入同输出），
 * 而「空闲时不弹提示」正是容易在后续改动中被弄丢的约定。
 */
export function buildTooltip(state: StatusState): vscode.MarkdownString | undefined {
	// 还没配置站点是唯一「悬停就该知道怎么办」的场景：状态栏本身只有「New API」两个字
	if (state.targets.length === 0) {
		const tooltip = createTooltip();
		tooltip.appendMarkdown('$(warning) **尚未配置任何站点**\n\n');
		tooltip.appendMarkdown('点击开始配置，或执行命令「New API: 管理模型」。');
		return tooltip;
	}

	const blocks: string[] = [];
	if (state.usage.requests > 0) {
		blocks.push(describeUsage(state.usage));
	}
	const problems = state.targets.flatMap(describeProblems);
	if (problems.length > 0) {
		blocks.push(problems.join('\n'));
	}
	if (blocks.length === 0) {
		return undefined;
	}

	blocks.push('点击打开状态面板，查看站点与模型详情。');
	const tooltip = createTooltip();
	tooltip.appendMarkdown(blocks.join('\n\n'));
	return tooltip;
}

/** 空提示：带标题与主题图标支持。图标（`$(warning)` 等）没有这个开关会按字面显示。 */
function createTooltip(): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString();
	tooltip.supportThemeIcons = true;
	tooltip.appendMarkdown('**New API for Copilot Chat**\n\n');
	return tooltip;
}

/**
 * 本次会话的消耗。
 *
 * 全程用**空行**分段（Markdown 里单个 `\n` 只是软换行，渲染时会并成一行）。
 */
function describeUsage(usage: UsageStats): string {
	const counts = [`${usage.requests} 次请求`];
	if (usage.toolCalls > 0) {
		counts.push(`${usage.toolCalls} 次工具调用`);
	}

	const lines = [`**本次会话**：${counts.join(' · ')}`, ''];
	// 上游没返回 usage 时不要显示一排 0：那看起来像是真的没消耗
	if (usage.totalTokens === 0) {
		lines.push('- 上游未返回 token 用量');
	} else {
		lines.push(`- 输入：${formatTokens(usage.promptTokens)}`);
		lines.push(`- 输出：${formatTokens(usage.completionTokens)}`);
		const cache = describeCache(usage);
		if (cache !== undefined) {
			lines.push(`- 缓存命中：${cache}`);
		}
		if (usage.reasoningTokens > 0) {
			lines.push(`- 其中思考：${formatTokens(usage.reasoningTokens)}`);
		}
	}

	if (usage.lastRequestAt !== undefined) {
		const model = usage.lastModelId === undefined ? '' : ` · ${usage.lastModelId}`;
		lines.push('', `最近请求：${formatRelativeTime(usage.lastRequestAt)}${model}`);
	}
	return lines.join('\n');
}

/**
 * 缓存命中一行；不该显示时返回 `undefined`。
 *
 * 「命中 0」与「上游不报缓存」是两件事：前者说明缓存没帮上忙（可能有价值，比如上下文每次都在变），
 * 后者说明这个数字根本不存在。前者值得显示，后者显示出来只会让人怀疑扩展坏了。
 */
function describeCache(usage: UsageStats): string | undefined {
	if (!usage.cacheReported) {
		return undefined;
	}
	// 命中数已经大于 0 却拿不到输入量时，`describeCacheHit` 会只给数量不编比例
	return usage.cachedTokens === 0
		? '无'
		: describeCacheHit(usage.cachedTokens, usage.promptTokens);
}

/**
 * 只列需要用户动手的问题。
 *
 * 健康的站点不在这里出现——它的细节（地址、网关版本、延迟、模型数）都在面板里。
 */
function describeProblems(target: TargetStatus): string[] {
	if (!target.usable) {
		return [`$(warning) ${target.label} 配置不完整：${target.issues.join('；')}`];
	}
	if (target.models.error === undefined) {
		return [];
	}
	const lines = [`$(error) ${target.label}：${target.models.error}`];
	if (target.models.hint !== undefined) {
		lines.push(`　　建议：${target.models.hint}`);
	}
	return lines;
}
