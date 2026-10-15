import type { ChatUsage } from '../utils/types';
import { asNumber, isRecord } from '../utils/json';

/** The complete numeric payload required by Copilot's context-window display. */
export interface ReportedUsagePayload {
	readonly prompt_tokens: number;
	readonly completion_tokens: number;
	readonly total_tokens: number;
	readonly prompt_tokens_details: { readonly cached_tokens: number };
	readonly completion_tokens_details?: { readonly reasoning_tokens: number };
}

/** Normalize one response's usage; no global counters or fabricated zero-usage events. */
export function buildReportedUsage(usage: ChatUsage | undefined): ReportedUsagePayload | undefined {
	if (usage === undefined) { return undefined; }
	const prompt = asNumber(usage.prompt_tokens) ?? 0;
	const completion = asNumber(usage.completion_tokens) ?? 0;
	const cachedDetails = isRecord(usage.prompt_tokens_details)
		? asNumber(usage.prompt_tokens_details.cached_tokens) : undefined;
	const reasoningDetails = isRecord(usage.completion_tokens_details)
		? asNumber(usage.completion_tokens_details.reasoning_tokens) : undefined;
	const reasoning = reasoningDetails ?? asNumber(usage.reasoning_tokens) ?? 0;
	return {
		prompt_tokens: prompt,
		completion_tokens: completion,
		total_tokens: asNumber(usage.total_tokens) ?? prompt + completion,
		prompt_tokens_details: { cached_tokens: Math.min(cachedDetails ?? asNumber(usage.prompt_cache_hit_tokens) ?? 0, prompt) },
		...(reasoning > 0 ? { completion_tokens_details: { reasoning_tokens: reasoning } } : {}),
	};
}
