import { EventEmitter } from '../utils/event';
import { asNumber, isRecord } from '../utils/json';
import type { ChatUsage } from '../utils/types';
import { buildReportedUsage } from '../protocol/usage';

export interface UsageStats {
	readonly requests: number;
	readonly reportedRequests: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly cachedTokens: number;
	readonly cacheReported: boolean;
	readonly reasoningTokens: number;
	readonly toolCalls: number;
	readonly lastRequestAt?: number;
	readonly lastModelId?: string;
	readonly lastTargetLabel?: string;
}

/** Extension-host lifetime totals; per-response Copilot usage remains independent. */
export class UsageTracker {
	private readonly emitter = new EventEmitter<void>();
	private totals: UsageStats = { requests: 0, reportedRequests: 0, promptTokens: 0, completionTokens: 0,
		totalTokens: 0, cachedTokens: 0, cacheReported: false, reasoningTokens: 0, toolCalls: 0 };
	readonly onDidChange = this.emitter.event;
	get snapshot(): UsageStats { return this.totals; }

	record(targetLabel: string, modelId: string, usage: ChatUsage | undefined, toolCalls: number): void {
		const normalized = buildReportedUsage(usage);
		const cacheReported = asNumber(usage?.prompt_cache_hit_tokens) !== undefined
			|| (isRecord(usage?.prompt_tokens_details) && asNumber(usage.prompt_tokens_details.cached_tokens) !== undefined);
		this.totals = {
			requests: this.totals.requests + 1,
			reportedRequests: this.totals.reportedRequests + (normalized ? 1 : 0),
			promptTokens: this.totals.promptTokens + (normalized?.prompt_tokens ?? 0),
			completionTokens: this.totals.completionTokens + (normalized?.completion_tokens ?? 0),
			totalTokens: this.totals.totalTokens + (normalized?.total_tokens ?? 0),
			cachedTokens: this.totals.cachedTokens + (normalized?.prompt_tokens_details.cached_tokens ?? 0),
			cacheReported: this.totals.cacheReported || cacheReported,
			reasoningTokens: this.totals.reasoningTokens + (normalized?.completion_tokens_details?.reasoning_tokens ?? 0),
			toolCalls: this.totals.toolCalls + toolCalls,
			lastRequestAt: Date.now(), lastModelId: modelId, lastTargetLabel: targetLabel,
		};
		this.emitter.fire();
	}

	dispose(): void { this.emitter.dispose(); }
}
