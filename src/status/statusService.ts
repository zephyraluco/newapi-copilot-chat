/**
 * 状态服务：「扩展当前处于什么状态」的唯一真相来源——有哪些配置组、各自是否可用、
 * 各有多少模型、本次会话消耗了多少 token。
 *
 * 状态栏与面板只订阅这里并渲染，不各自去发请求：既避免重复轮询，也保证两处显示一致。
 * 状态是**按目标聚合**的，每个目标一行，整体可用性取「是否存在任一可用目标」。
 */

import * as vscode from 'vscode';
import { createAbortHandle, type AbortSignalHandle } from '../cancellation';
import { describeError } from '../client/newApiClient';
import type { ConfigService } from '../config';
import type { Logger } from '../logger';
import type { ProviderSession, SessionRegistry } from '../provider/session';
import { isTargetUsable } from '../provider/target';
import type { ChatUsage } from '../types';
import type { StreamSummary } from '../provider/stream';
import { readUsageDelta } from '../usage';

/** 单个目标的模型列表概要。 */
export interface ModelSummary {
	/** 可用模型数（已过滤） */
	readonly count: number;
	/** 网关返回的原始条目数 */
	readonly rawCount: number;
	/** 被 include/exclude 过滤掉的数量 */
	readonly filteredCount: number;
	/** 无效条目数 */
	readonly invalidCount: number;
	/** 数据来源 */
	readonly source?: 'network' | 'cache';
	/** 拉取时间 */
	readonly fetchedAt?: number;
	/** 上次刷新的错误 */
	readonly error?: string;
	/** 针对该错误的可操作建议 */
	readonly hint?: string;
}

/** 单个目标的连接与模型状态。 */
export interface TargetStatus {
	/** 配置指纹，用于区分同一 vendor 下的多个组 */
	readonly key: string;
	readonly group: string | undefined;
	readonly label: string;
	readonly baseUrl: string;
	/** 该目标的配置是否完整 */
	readonly usable: boolean;
	/** 配置不完整时的原因 */
	readonly issues: readonly string[];
	readonly models: ModelSummary;
	/** 该目标是否正在刷新 */
	readonly refreshing: boolean;
	/** 最近一次探测耗时（毫秒） */
	readonly latencyMs?: number;
	/** 最近一次探测时间 */
	readonly checkedAt?: number;
	/** 站点名称（来自 `/api/status`，第三方网关可能没有） */
	readonly siteName?: string;
	/** 网关版本（来自 `/api/status`） */
	readonly gatewayVersion?: string;
}

/** 会话用量统计。 */
export interface UsageStats {
	/** 请求次数 */
	readonly requests: number;
	readonly promptTokens: number;
	readonly completionTokens: number;
	readonly totalTokens: number;
	/** 命中前缀缓存的输入 token 数 */
	readonly cachedTokens: number;
	/** 是否见过携帯缓存字段的响应（用于区分「没命中」与「上游不报缓存」） */
	readonly cacheReported: boolean;
	/** 思维链 token 数 */
	readonly reasoningTokens: number;
	/** 工具调用次数 */
	readonly toolCalls: number;
	/** 最近一次请求时间 */
	readonly lastRequestAt?: number;
	/** 最近一次请求的模型 */
	readonly lastModelId?: string;
	/** 最近一次请求所属的配置组 */
	readonly lastTargetLabel?: string;
}

/** 供 UI 渲染的完整状态快照。 */
export interface StatusState {
	/** 所有已知的配置组 */
	readonly targets: readonly TargetStatus[];
	/** 是否存在任一可用目标 */
	readonly anyUsable: boolean;
	/** 可用目标的模型总数 */
	readonly totalModels: number;
	/** 日志级别（用于在面板里提示「日志看不到」的问题） */
	readonly logLevel: string;
	/** 用户是否关闭了状态栏 */
	readonly statusBarEnabled: boolean;
	/** 会话用量 */
	readonly usage: UsageStats;
	/** 已注册的适配器（id + 说明） */
	readonly adapters: readonly { readonly id: string; readonly description: string }[];
}

/** 状态服务依赖。 */
export interface StatusServiceDeps {
	readonly logger: Logger;
	readonly config: ConfigService;
	/** 会话注册表。状态来源就是它持有的那些 catalog */
	readonly sessions: SessionRegistry;
	/** 已注册的适配器摘要 */
	getAdapters(): readonly { readonly id: string; readonly description: string }[];
}

/** 探测结果：站点信息与延迟。 */
interface ProbeResult {
	readonly latencyMs: number;
	readonly siteName?: string;
	readonly gatewayVersion?: string;
}

/** 当前状态快照。 */
export class StatusService implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<StatusState>();
	private readonly disposables: vscode.Disposable[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	private inFlight: AbortSignalHandle | undefined;
	private readonly refreshing = new Set<string>();
	private readonly probes = new Map<string, ProbeResult>();
	private usage: UsageStats = {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheReported: false,
		reasoningTokens: 0,
		toolCalls: 0,
	};

	/** 状态变化事件。任何 UI 都应订阅它。 */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly deps: StatusServiceDeps) {
		this.disposables.push(
			this.deps.sessions.onDidChange(() => this.emit()),
			this.deps.config.onDidChange(() => {
				// 模型过滤设置变了，各会话的缓存需要失效——直接丢弃会话，
				// 下一次模型发现会按新设置重建。
				this.deps.sessions.invalidate();
				this.restartTimer();
				this.emit();
			}),
		);
	}

	/** 取当前状态快照。 */
	get state(): StatusState {
		const targets = this.deps.sessions.list().map(session => this.describeTarget(session));
		return {
			targets,
			anyUsable: targets.some(target => target.usable),
			totalModels: targets.reduce((sum, target) => sum + target.models.count, 0),
			logLevel: this.deps.config.settings.logLevel,
			statusBarEnabled: this.deps.config.settings.status.showStatusBar,
			usage: this.usage,
			adapters: this.deps.getAdapters(),
		};
	}

	/** 启动周期性刷新。 */
	start(): void {
		this.restartTimer();
		void this.refresh({ forceModels: false });
	}

	/**
	 * 刷新所有目标。
	 *
	 * @param options.forceModels 是否跳过模型缓存（用户手动刷新时为 `true`）
	 */
	async refresh(options: { forceModels?: boolean } = {}): Promise<void> {
		const sessions = this.deps.sessions.list();
		if (sessions.length === 0) {
			// 用户还没在本扩展里配置任何站点。这不是错误，只是「没有可探测的目标」；
			// 面板会展示配置引导。
			this.deps.logger.debug('尚无可用的配置组，跳过探测');
			this.emit();
			return;
		}

		this.inFlight = createAbortHandle();
		try {
			await Promise.all(sessions.map(session => this.refreshSession(session, options.forceModels === true)));
		} finally {
			this.inFlight?.dispose();
			this.inFlight = undefined;
			this.emit();
		}
	}

	/** 刷新单个目标。 */
	private async refreshSession(session: ProviderSession, forceModels: boolean): Promise<void> {
		const target = session.target;
		if (!isTargetUsable(target)) {
			this.deps.logger.debug(`配置不完整，跳过探测：${target.label}`);
			return;
		}

		const key = target.key;
		if (this.refreshing.has(key)) {
			return;
		}
		this.refreshing.add(key);
		this.emit();

		try {
			// 模型列表交给 catalog（它与 provider 共享同一份缓存，
			// 因此状态里显示的数量就是模型选择器里的数量）；
			// 站点信息用 /api/status 单独取，该端点失败不影响可用性判断。
			const startedAt = Date.now();
			const [snapshot, status] = await Promise.all([
				session.catalog.getModels({ force: forceModels, signal: this.inFlight?.signal }),
				session.client.getStatus(this.inFlight?.signal),
			]);
			this.probes.set(key, {
				latencyMs: Date.now() - startedAt,
				siteName: status.status?.system_name,
				gatewayVersion: status.status?.version,
			});
			if (snapshot.error !== undefined) {
				this.deps.logger.warn(`刷新模型列表失败：${target.label}：${snapshot.error}`);
			}
		} catch (error) {
			// getModels 自己会吞掉失败，这里兜的是「意料之外」的错误
			this.deps.logger.error(`刷新状态失败：${target.label}`, describeError(error));
		} finally {
			this.refreshing.delete(key);
			this.emit();
		}
	}

	/**
	 * 探测单个目标（供「测试连接」命令使用）。
	 *
	 * 与周期性刷新走同一条路径，因此状态栏、面板与命令三者的口径完全一致。
	 */
	async probe(session: ProviderSession): Promise<TargetStatus> {
		await this.refreshSession(session, true);
		return this.describeTarget(session);
	}

	/** 记录一次请求的用量。 */
	recordUsage(
		targetLabel: string,
		modelId: string,
		usage: ChatUsage | undefined,
		summary: StreamSummary,
	): void {
		const delta = readUsageDelta(usage);
		this.usage = {
			requests: this.usage.requests + 1,
			promptTokens: this.usage.promptTokens + delta.promptTokens,
			completionTokens: this.usage.completionTokens + delta.completionTokens,
			totalTokens: this.usage.totalTokens + delta.totalTokens,
			cachedTokens: this.usage.cachedTokens + delta.cachedTokens,
			cacheReported: this.usage.cacheReported || delta.reportsCache,
			reasoningTokens: this.usage.reasoningTokens + delta.reasoningTokens,
			toolCalls: this.usage.toolCalls + summary.toolCallCount,
			lastRequestAt: Date.now(),
			lastModelId: modelId,
			lastTargetLabel: targetLabel,
		};
		this.emit();
	}

	/** 清空用量统计。 */
	resetUsage(): void {
		this.usage = {
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheReported: false,
			reasoningTokens: 0,
			toolCalls: 0,
		};
		this.emit();
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.inFlight?.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.emitter.dispose();
	}

	/* ---------------------------------------------------------------------- */

	/** 把会话整理成可渲染的状态。 */
	private describeTarget(session: ProviderSession): TargetStatus {
		const target = session.target;
		const snapshot = session.catalog.current;
		const probe = this.probes.get(target.key);
		return {
			key: target.key,
			group: target.group,
			label: target.label,
			baseUrl: target.baseUrl,
			usable: isTargetUsable(target),
			issues: target.issues,
			models: {
				count: snapshot?.models.length ?? 0,
				rawCount: snapshot?.rawCount ?? 0,
				filteredCount: snapshot?.filtered.length ?? 0,
				invalidCount: snapshot?.invalidCount ?? 0,
				source: snapshot?.source,
				fetchedAt: snapshot?.fetchedAt,
				error: snapshot?.error,
				hint: snapshot?.hint,
			},
			refreshing: this.refreshing.has(target.key),
			latencyMs: probe?.latencyMs,
			checkedAt: probe === undefined ? undefined : Date.now(),
			siteName: probe?.siteName,
			gatewayVersion: probe?.gatewayVersion,
		};
	}

	/** 按当前设置重启定时器。 */
	private restartTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		const interval = this.deps.config.settings.status.refreshIntervalMs;
		this.timer = setInterval(() => {
			void this.refresh({ forceModels: true });
		}, interval);
		this.deps.logger.debug(`状态刷新间隔：${Math.round(interval / 1000)}s`);
	}

	private emit(): void {
		this.emitter.fire(this.state);
	}
}
