/**
 * 用量的读出与翻译。
 *
 * 这里只做算术，不碰 UI（状态栏与面板各自渲染）：把「一次响应的 `usage`」翻译成两种消费形态——
 * 可累加的 `UsageDelta`（供状态面板统计），以及回传给 Copilot 的 `ReportedUsagePayload`
 * （供会话信息里的上下文窗口显示）。
 *
 * 需要在这层吸收的差异有三类：
 *
 * 1. **缓存命中的字段名不统一**：OpenAI / New API 放在 `prompt_tokens_details.cached_tokens`，
 *    DeepSeek 直接用 `prompt_cache_hit_tokens`。两者都认，取到哪个算哪个。
 * 2. **分项与总量可能缺一个**：只给 `total_tokens` 时按分项之和补齐，只给分项时反过来算总量。
 * 3. **有的网关根本不返回 `usage`**（流式请求尤其常见，除非显式要求）。这种情况不能记成 0
 *    然后展示「本次会话 0 token」——那看起来像是真的没消耗。因此 `reportsCache` 与
 *    调用方看到的 `totalTokens === 0` 一起用于区分「没报告」与「报告了 0」。
 */

import type { ChatUsage } from './types';
import { formatTokens } from './format';
import { asNumber, isRecord } from './json';

/** 一次响应能提供的可累加计数（缺失一律按 0）。 */
export interface UsageDelta {
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	/** 命中前缀缓存的输入 token 数 */
	readonly cachedTokens: number;
	/** 思维链 token 数 */
	readonly reasoningTokens: number;
	/** 这次响应是否真的带了缓存字段（用于区分「没有缓存」与「上游没报告缓存」） */
	readonly reportsCache: boolean;
}

/** 空增量：没有 `usage` 时用它。 */
export const EMPTY_USAGE_DELTA: UsageDelta = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	reasoningTokens: 0,
	reportsCache: false,
};

/** 读出一次响应的用量增量。 */
export function readUsageDelta(usage: ChatUsage | undefined): UsageDelta {
	if (usage === undefined) {
		return EMPTY_USAGE_DELTA;
	}

	const promptTokens = asNumber(usage.prompt_tokens) ?? 0;
	const completionTokens = asNumber(usage.completion_tokens) ?? 0;
	// 总量与分项互为兜底：网关偶尔只给一边
	const totalTokens = asNumber(usage.total_tokens) ?? promptTokens + completionTokens;
	const cached = readCachedTokens(usage);

	return {
		promptTokens,
		completionTokens,
		totalTokens,
		// 命中数不该超过输入总量；上游偶尔会给出这种矛盾组合，钳一下免得算出 >100% 的命中率
		cachedTokens: Math.min(cached ?? 0, promptTokens),
		reasoningTokens: readReasoningTokens(usage),
		reportsCache: cached !== undefined,
	};
}

/**
 * 回传给 Copilot 的用量载荷（OpenAI 的字段名）。
 *
 * Copilot 用一个鸭子类型校验器（要求 `prompt_tokens` / `completion_tokens` / `total_tokens`
 * **都是数字**）决定要不要采纳这份用量；任一字段缺失或不是数字，整块载荷会被丢弃，
 * 会话信息里的上下文窗口就退回 `0/最大值`。因此这里**始终补齐三个数字**，
 * 并只用 `undefined` 表达「根本没有用量可报」。
 */
export interface ReportedUsagePayload {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly prompt_tokens_details: { readonly cached_tokens: number };
	readonly completion_tokens_details?: { readonly reasoning_tokens: number };
}

/**
 * 把上游的 `usage` 转成 Copilot 认识的载荷。
 *
 * 上游完全没给用量时返回 `undefined`——那与 Copilot 自己的兑底值同义，不必发一个全是 0 的载荷。
 */
export function buildReportedUsage(usage: ChatUsage | undefined): ReportedUsagePayload | undefined {
	if (usage === undefined) {
		return undefined;
	}
	const delta = readUsageDelta(usage);
	return {
		prompt_tokens: delta.promptTokens,
		completion_tokens: delta.completionTokens,
		total_tokens: delta.totalTokens,
		prompt_tokens_details: { cached_tokens: delta.cachedTokens },
		...(delta.reasoningTokens > 0
			? { completion_tokens_details: { reasoning_tokens: delta.reasoningTokens } }
			: {}),
	};
}

/**
 * 缓存命中的比例（0–1）；无法计算时返回 `undefined`。
 *
 * 命中率的分母是**输入**：缓存只作用于 prompt，用它除以总 token 会得到一个偏低的假数字。
 */
export function cacheHitRate(cachedTokens: number, promptTokens: number): number | undefined {
	if (cachedTokens <= 0 || promptTokens <= 0) {
		return undefined;
	}
	return Math.min(1, cachedTokens / promptTokens);
}

/** 缓存命中的人话说法：`8.2K（67%）`。两处 UI 共用，免得百分比口径分叉。 */
export function describeCacheHit(cachedTokens: number, promptTokens: number): string {
	const rate = cacheHitRate(cachedTokens, promptTokens);
	const prefix = formatTokens(cachedTokens);
	return rate === undefined ? prefix : `${prefix}（${Math.round(rate * 100)}%）`;
}

/** 命中数：OpenAI 风格与 DeepSeek 风格都认。字段完全不存在时返回 `undefined`。 */
function readCachedTokens(usage: ChatUsage): number | undefined {
	const details = isRecord(usage.prompt_tokens_details)
		? asNumber(usage.prompt_tokens_details.cached_tokens)
		: undefined;
	// 有的网关只给命中与未命中两个数，那也算「报告了缓存」
	const deepSeekStyle = asNumber(usage.prompt_cache_hit_tokens);
	return details ?? deepSeekStyle;
}

/** 思维链 token：优先看明细，其次看顶层字段。 */
function readReasoningTokens(usage: ChatUsage): number {
	const details = isRecord(usage.completion_tokens_details)
		? asNumber(usage.completion_tokens_details.reasoning_tokens)
		: undefined;
	return details ?? asNumber(usage.reasoning_tokens) ?? 0;
}
