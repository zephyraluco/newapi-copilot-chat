import { EventEmitter } from '../shared/event';
import type { Logger } from '../shared/log';
import type { NewApiSettings } from '../shared/settings';
import type { ChatUsage } from '../shared/types';
import { readUsageDelta } from '../protocol/usage';
import { describeError } from '../transport/newApiClient';
import { isTargetUsable } from './target';
import type { ProviderSession, SessionRegistry } from './session';

export interface TargetStatus {
	readonly key: string;
	readonly label: string;
	readonly usable: boolean;
	readonly issues: readonly string[];
	readonly models: { readonly count: number; readonly error?: string; readonly hint?: string };
	readonly refreshing: boolean;
	readonly latencyMs?: number;
}
export interface UsageStats {
	readonly requests: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	readonly cachedTokens: number;
	readonly cacheReported: boolean;
	readonly reasoningTokens: number;
	readonly toolCalls: number;
	readonly lastRequestAt?: number;
	readonly lastModelId?: string;
}
export interface StatusState {
	readonly targets: readonly TargetStatus[];
	readonly anyUsable: boolean;
	readonly totalModels: number;
	readonly statusBarEnabled: boolean;
	readonly usage: UsageStats;
}
function emptyUsage(): UsageStats {
	return { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
		cachedTokens: 0, cacheReported: false, reasoningTokens: 0, toolCalls: 0 };
}

/** Application state and refresh scheduling. No host configuration subscriptions or UI. */
export class StatusService {
	private readonly emitter = new EventEmitter<StatusState>();
	private readonly sessionListener: { dispose(): void };
	private readonly controller = new AbortController();
	private timer: ReturnType<typeof setInterval> | undefined;
	private task: Promise<void> | undefined;
	private pendingForce = false;
	private runningForce = false;
	private revision = 0;
	private runningRevision = 0;
	private started = false;
	private disposed = false;
	private readonly refreshing = new Set<string>();
	private readonly latencies = new Map<string, number>();
	private usage = emptyUsage();
	readonly onDidChange = this.emitter.event;

	constructor(private readonly deps: {
		logger: Logger;
		sessions: Pick<SessionRegistry, 'list' | 'onDidChange'>;
		getSettings(): NewApiSettings;
	}) {
		this.sessionListener = deps.sessions.onDidChange(() => this.emit());
	}

	get state(): StatusState {
		const targets = this.deps.sessions.list().map(session => this.describeTarget(session));
		return { targets, anyUsable: targets.some(target => target.usable),
			totalModels: targets.reduce((sum, target) => sum + target.models.count, 0),
			statusBarEnabled: this.deps.getSettings().status.showStatusBar, usage: this.usage };
	}

	start(): void {
		if (this.started || this.disposed) { return; }
		this.started = true;
		this.settingsChanged(true);
		void this.refresh();
	}

	/** Called by the single configuration-change coordinator. */
	settingsChanged(restartTimer: boolean): void {
		if (this.disposed) { return; }
		this.revision++;
		if (restartTimer && this.started) {
			if (this.timer !== undefined) { clearInterval(this.timer); }
			this.timer = setInterval(() => { void this.refresh(); }, this.deps.getSettings().status.refreshIntervalMs);
		}
		this.emit();
	}

	/** Join concurrent refreshes; a forced call upgrades a running cached refresh once. */
	refresh(options: { forceModels?: boolean } = {}): Promise<void> {
		if (this.disposed) { return Promise.resolve(); }
		if (this.task !== undefined) {
			if (options.forceModels && (!this.runningForce || this.runningRevision !== this.revision)) { this.pendingForce = true; }
			return this.task;
		}
		this.pendingForce = options.forceModels === true;
		this.task = Promise.resolve().then(async () => {
			do {
				this.runningForce = this.pendingForce;
				this.runningRevision = this.revision;
				this.pendingForce = false;
				const sessions = this.deps.sessions.list();
				const keys = new Set(sessions.map(session => session.target.key));
				for (const key of this.latencies.keys()) {
					if (!keys.has(key)) { this.latencies.delete(key); }
				}
				await Promise.all(sessions.map(session => this.refreshSession(session, this.runningForce)));
			} while (this.pendingForce && !this.disposed);
		}).finally(() => {
			this.task = undefined;
			this.runningForce = false;
			this.emit();
		});
		return this.task;
	}

	private async refreshSession(session: ProviderSession, force: boolean): Promise<void> {
		if (this.disposed || !isTargetUsable(session.target)) { return; }
		const key = session.target.key;
		this.refreshing.add(key);
		this.emit();
		try {
			const started = Date.now();
			const [snapshot, probe] = await Promise.all([
				session.catalog.getModels({ force, signal: this.controller.signal }),
				session.client.getStatus(this.controller.signal),
			]);
			if (!this.disposed) { this.latencies.set(key, Date.now() - started); }
			if (!probe.available) { this.deps.logger.debug(`${session.target.label}：状态端点不可用：${probe.reason}`); }
			if (snapshot.error !== undefined) { this.deps.logger.warn(`${session.target.label}：${snapshot.error}`); }
		} catch (error) {
			if (!this.disposed) { this.deps.logger.error(`刷新失败：${session.target.label}`, describeError(error)); }
		} finally {
			this.refreshing.delete(key);
			this.emit();
		}
	}

	recordUsage(modelId: string, usage: ChatUsage | undefined, summary: { readonly toolCallCount: number }): void {
		const delta = readUsageDelta(usage);
		this.usage = { requests: this.usage.requests + 1,
			promptTokens: this.usage.promptTokens + delta.promptTokens,
			completionTokens: this.usage.completionTokens + delta.completionTokens,
			totalTokens: this.usage.totalTokens + delta.totalTokens,
			cachedTokens: this.usage.cachedTokens + delta.cachedTokens,
			cacheReported: this.usage.cacheReported || delta.reportsCache,
			reasoningTokens: this.usage.reasoningTokens + delta.reasoningTokens,
			toolCalls: this.usage.toolCalls + summary.toolCallCount,
			lastRequestAt: Date.now(), lastModelId: modelId };
		this.emit();
	}
	resetUsage(): void { this.usage = emptyUsage(); this.emit(); }
	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) { clearInterval(this.timer); }
		this.controller.abort();
		this.sessionListener.dispose();
		this.emitter.dispose();
	}
	private describeTarget(session: ProviderSession): TargetStatus {
		const { target, catalog } = session;
		return { key: target.key, label: target.label, usable: isTargetUsable(target), issues: target.issues,
			models: { count: catalog.current?.models.length ?? 0, error: catalog.current?.error, hint: catalog.current?.hint },
			refreshing: this.refreshing.has(target.key), latencyMs: this.latencies.get(target.key) };
	}
	private emit(): void { if (!this.disposed) { this.emitter.fire(this.state); } }
}
