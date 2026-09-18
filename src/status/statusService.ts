/**
 * 状态服务：「扩展当前处于什么状态」的唯一真相来源——有哪些配置组、各自是否可用、
 * 各有多少模型、本次会话消耗了多少 token。
 *
 * 状态栏订阅这里并渲染，不自己去发请求。状态是**按目标聚合**的，每个目标一行，
 * 整体可用性取「是否存在任一可用目标」。
 */

import * as vscode from 'vscode';
import { createAbortHandle, type AbortSignalHandle } from '../cancellation';
import { describeError } from '../client/newApiClient';
import type { NewApiSettings } from '../config';
import type { Logger } from '../logger';
import type { ModelCatalogSnapshot } from '../models/catalog';
import type { ProviderTarget } from '../runtime/target';
import { isTargetUsable } from '../runtime/target';
import type { ChatUsage } from '../types';
import { readUsageDelta } from '../usage';

/** 单个目标的模型列表概要。 */
export interface ModelSummary {
	/** 可用模型数（已过滤） */
	readonly count: number;
	/** 被 include/exclude 过滤掉的数量 */
	readonly filteredCount: number;
	/** 上次刷新的错误 */
	readonly error?: string;
	/** 针对该错误的可操作建议 */
	readonly hint?: string;
}

/** 单个目标的连接与模型状态。 */
export interface TargetStatus {
	/** 配置指纹（同 vendor 的多个组据此区分） */
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
	/** 最近一次探测耗时（毫秒），「测试连接」命令会报告它 */
	readonly latencyMs?: number;
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

/** 供状态栏渲染的状态快照。 */
export interface StatusState {
	/** 所有已知的配置组 */
	readonly targets: readonly TargetStatus[];
	/** 是否存在任一可用目标 */
	readonly anyUsable: boolean;
	/** 可用目标的模型总数 */
	readonly totalModels: number;
	/** 用户是否关闭了状态栏 */
	readonly statusBarEnabled: boolean;
	/** 会话用量 */
	readonly usage: UsageStats;
}

/** 一次响应里与状态有关的那部分（`StreamSummary` 天然满足它）。 */
export interface UsageDeltaSummary {
	/** 本次响应上报的工具调用数 */
	readonly toolCallCount: number;
}

/**
 * 状态服务看到的会话视图：**只列它真正用到的东西**。
 *
 * 刻意不写成 `ProviderSession` / `SessionRegistry`——状态层需要的只是「有哪些目标、各自能不能发请求、
 * 当前模型快照是什么」，绑到 provider 的具体实现上会同时带来两个坏处：依赖方向横着走，
 * 以及任何用例都得先拼装真实客户端与目录才能测这一层。
 */
export interface StatusSessionView {
	readonly target: ProviderTarget;
	readonly catalog: {
		readonly current?: ModelCatalogSnapshot;
		getModels(options?: { force?: boolean; signal?: AbortSignal }): Promise<ModelCatalogSnapshot>;
	};
	readonly client: {
		getStatus(signal?: AbortSignal): Promise<{ readonly status?: { readonly system_name?: string; readonly version?: string } }>;
	};
}

/** 会话来源（`SessionRegistry` 天然满足它）。 */
export interface StatusSessionSource {
	list(): readonly StatusSessionView[];
	readonly onDidChange: vscode.Event<void>;
	/** 让各会话丢弃缓存（模型过滤设置变化时用） */
	invalidate(): void;
}

/** 配置来源（`ConfigService` 天然满足它）。 */
export interface StatusConfigSource {
	readonly settings: NewApiSettings;
	readonly onDidChange: vscode.Event<NewApiSettings>;
}

/** 状态服务依赖。 */
export interface StatusServiceDeps {
	readonly logger: Logger;
	readonly config: StatusConfigSource;
	/** 会话注册表。状态来源就是它持有的那些快照 */
	readonly sessions: StatusSessionSource;
}

/** 探测结果：站点可达性与延迟。 */
interface ProbeResult {
	readonly latencyMs: number;
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
			statusBarEnabled: this.deps.config.settings.status.showStatusBar,
			usage: this.usage,
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
			// 状态栏与「测试连接」命令会指出这一点。
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
	private async refreshSession(session: StatusSessionView, forceModels: boolean): Promise<void> {
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
			// 因此状态里显示的数量就是模型选择器里的数量）。
			// 同时探一下 /api/status：它给出这段往返的耗时，也顺带确认这个端点是否可用
			//（第三方兼容网关往往没有它，但客户端不会因此报错）。
			const startedAt = Date.now();
			const [snapshot] = await Promise.all([
				session.catalog.getModels({ force: forceModels, signal: this.inFlight?.signal }),
				session.client.getStatus(this.inFlight?.signal),
			]);
			this.probes.set(key, { latencyMs: Date.now() - startedAt });
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
	 * 与周期性刷新走同一条路径，因此状态栏与命令的口径完全一致。
	 */
	async probe(session: StatusSessionView): Promise<TargetStatus> {
		await this.refreshSession(session, true);
		return this.describeTarget(session);
	}

	/** 记录一次请求的用量。 */
	recordUsage(
		targetLabel: string,
		modelId: string,
		usage: ChatUsage | undefined,
		summary: UsageDeltaSummary,
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
	private describeTarget(session: StatusSessionView): TargetStatus {
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
				filteredCount: snapshot?.filtered.length ?? 0,
				error: snapshot?.error,
				hint: snapshot?.hint,
			},
			refreshing: this.refreshing.has(target.key),
			latencyMs: probe?.latencyMs,
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
