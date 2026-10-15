/**
 * 模型目录：编排「何时拉模型列表、原始数据怎么变成配置、失败了怎么办」。
 * 信息整合在 `modelConfig.ts`，网络交互在 `client`。
 *
 * 并发合并：VS Code 可能短时间内多次调用模型发现，用 in-flight promise 合并成一次请求。
 * 失败保留旧数据（stale-while-error）：刷新失败时返回上一次快照并附上错误。
 */

import { EventEmitter } from '../utils/event';
import { describeError, describeFailureHint, type NewApiClient } from '../transport/newApiClient';
import { safeJsonStringify } from '../utils/json';
import type { Logger } from '../utils/log';
import type { ModelSettings } from '../utils/settings';
import { buildModelConfigs, type ModelConfig } from '../models/modelConfig';

/** 一次模型列表快照。 */
export interface ModelCatalogSnapshot {
	/** 整合后的模型配置 */
	readonly models: readonly ModelConfig[];
	/** 拉取时间（毫秒时间戳） */
	readonly fetchedAt: number;
	/**
	 * 本次刷新的错误描述。
	 *
	 * 有值时仍可能带着来自上一次成功结果的可用数据。
	 */
	readonly error?: string;
	/** 针对该错误的可操作建议（例如「检查站点地址是否带了 /v1」） */
	readonly hint?: string;
}

/** A catalog belongs to one session and one fixed client. */
export interface ModelCatalogDeps {
	readonly logger: Logger;
	readonly client: Pick<NewApiClient, 'listModels' | 'hasApiKey'>;
	/** 取当前的模型相关设置 */
	getSettings(): ModelSettings;
}

/** 拉取选项。 */
export interface GetModelsOptions {
	/** 忽略缓存强制刷新 */
	force?: boolean;
	/** 取消信号 */
	signal?: AbortSignal;
}

/** 模型目录。 */
export class ModelCatalog {
	private snapshot: ModelCatalogSnapshot | undefined;
	private inFlight: Promise<ModelCatalogSnapshot> | undefined;
	/** 上一次首拉失败的结果与时间，用于退避重试 */
	private lastFailure: { readonly at: number; readonly snapshot: ModelCatalogSnapshot } | undefined;
	private readonly emitter = new EventEmitter<ModelCatalogSnapshot>();
	private generation = 0;
	private disposed = false;

	/** 快照变化事件（含刷新失败导致的降级）。 */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly deps: ModelCatalogDeps) { }

	/** Latest discovery result, including an initial failure for the status view. */
	get current(): ModelCatalogSnapshot | undefined {
		return this.snapshot ?? this.lastFailure?.snapshot;
	}

	/**
	 * 取模型列表。
	 *
	 * 命中缓存（未过期且设置未变）时直接返回；否则走一次网络请求，
	 * 并与同时到达的其他调用共享同一个请求。
	 *
	 * @param options.signal 取消信号。模型列表是共享资源，接入某个调用方的信号会连带取消
	 * 所有人的请求，因此 provider 层不传该参数。
	 */
	async getModels(options: GetModelsOptions = {}): Promise<ModelCatalogSnapshot> {
		if (this.disposed) { throw new Error('ModelCatalog 已释放'); }
		const settings = this.deps.getSettings();
		const force = options.force === true;

		if (!force && this.snapshot !== undefined && Date.now() - this.snapshot.fetchedAt < settings.cacheTtlMs) {
			return this.snapshot;
		}
		// 从未成功过且刚失败过：退避，避免反复调用打爆网关
		if (!force && this.snapshot === undefined && this.lastFailure !== undefined
			&& Date.now() - this.lastFailure.at < FAILURE_BACKOFF_MS) {
			return this.lastFailure.snapshot;
		}
		if (this.inFlight !== undefined) {
			return await this.inFlight;
		}

		const generation = this.generation;
		const pending = this.refresh(settings, options.signal, generation)
			.finally(() => {
				if (this.inFlight === pending) { this.inFlight = undefined; }
			});
		this.inFlight = pending;
		return await pending;
	}

	/** 丢弃缓存，下次 `getModels` 会强制刷新。 */
	invalidate(): void {
		this.generation++;
		this.inFlight = undefined;
		this.snapshot = undefined;
		this.lastFailure = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.invalidate();
		this.emitter.dispose();
	}

	/* ---------------------------------------------------------------------- */

	private async refresh(
		settings: ModelSettings,
		signal: AbortSignal | undefined,
		generation: number,
	): Promise<ModelCatalogSnapshot> {
		const logger = this.deps.logger;
		const startedAt = Date.now();

		try {
			const client = this.deps.client;
			const raw = await client.listModels(signal);
			const built = buildModelConfigs(raw, { settings, logger });

			const snapshot: ModelCatalogSnapshot = {
				models: built.configs,
				fetchedAt: Date.now(),
			};
			if (generation !== this.generation || this.disposed) { return snapshot; }
			const previous = this.snapshot;
			this.snapshot = snapshot;
			this.lastFailure = undefined;
			logger.debug(
				`模型列表已刷新：${built.configs.length}/${raw.length} 可用，` +
				`耗时 ${Date.now() - startedAt}ms`,
			);
			this.emitIfChanged(previous, snapshot);
			return snapshot;
		} catch (error) {
			const message = describeError(error);
			const hint = describeFailureHint(error, this.deps.client.hasApiKey);
			logger.warn(`刷新模型列表失败：${message}`);
			if (generation !== this.generation || this.disposed) {
				return { models: [], fetchedAt: Date.now(), error: message, hint };
			}

			if (this.snapshot !== undefined) {
				// 曾经成功过：保留旧数据（stale-while-error），只把错误标出来
				const stale: ModelCatalogSnapshot = { ...this.snapshot, error: message, hint };
				const previous = this.snapshot;
				this.snapshot = stale;
				this.emitIfChanged(previous, stale);
				return stale;
			}

			// 从未成功过：不把空结果写进 snapshot，
			// 否则一次瞬时失败会把「没有模型」缓存住整个 TTL
			const failure: ModelCatalogSnapshot = {
				models: [],
				fetchedAt: Date.now(),
				error: message,
				hint,
			};
			const previousFailure = this.lastFailure?.snapshot;
			this.lastFailure = { at: Date.now(), snapshot: failure };
			this.emitIfChanged(previousFailure, failure);
			return failure;
		}
	}

	/**
	 * 只在快照真的变了时触发事件。
	 *
	 * 事件链的终点是 `onDidChangeLanguageModelChatInformation`，VS Code 收到它就会重新拉模型列表；
	 * 重复发现或手动刷新时，结果没变就不触发。
	 */
	private emitIfChanged(previous: ModelCatalogSnapshot | undefined, next: ModelCatalogSnapshot): void {
		if (previous !== undefined && snapshotSignature(previous) === snapshotSignature(next)) {
			return;
		}
		this.emitter.fire(next);
	}
}

/**
 * 快照里会影响「模型选择器」的那部分。
 *
 * 不含 `fetchedAt`：它每次都会变，算进去等于永远「变了」。
 */
function snapshotSignature(snapshot: ModelCatalogSnapshot): string {
	return safeJsonStringify({ models: snapshot.models, error: snapshot.error, hint: snapshot.hint }) ?? '';
}

/**
 * 首次拉取就失败时的退避时长。
 *
 * 失败（尤其是「未配置」）时没有快照可命中，不退避就会每次都发一轮请求。
 */
const FAILURE_BACKOFF_MS = 10_000;
