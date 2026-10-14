/**
 * 模型目录：编排「何时拉模型列表、原始数据怎么变成配置、失败了怎么办」。
 * 信息整合在 `modelConfig.ts`，网络交互在 `client`。
 *
 * 并发合并：VS Code 可能短时间内多次调用模型发现，用 in-flight promise 合并成一次请求。
 * 失败保留旧数据（stale-while-error）：刷新失败时返回上一次快照并附上错误。
 */

import * as vscode from 'vscode';
import { describeError, describeFailureHint, type NewApiClient } from '../client/newApiClient';
import { safeJsonStringify } from '../json';
import type { Logger } from '../logger';
import type { ModelSettings } from '../config';
import { buildModelConfigs, type ModelConfig } from './modelConfig';

/** 一次模型列表快照。 */
export interface ModelCatalogSnapshot {
	/** 整合后的模型配置 */
	readonly models: readonly ModelConfig[];
	/** 拉取时间（毫秒时间戳） */
	readonly fetchedAt: number;
	/**
	 * 本次刷新的错误描述。
	 *
	 * 有值时仍可能带着可用数据（来自上一次成功的结果），此时 `source` 为 `cache`。
	 */
	readonly error?: string;
	/** 针对该错误的可操作建议（例如「检查站点地址是否带了 /v1」） */
	readonly hint?: string;
	/** 数据来源：`network` 表示本次刷新成功，`cache` 表示沿用旧快照或空结果 */
	readonly source: 'network' | 'cache';
	/** 网关返回的原始条目数 */
	readonly rawCount: number;
	/** 因缺少可用 id 或构建失败而被跳过的条目数 */
	readonly invalidCount: number;
}

/** 目录依赖。用函数而不是值，保证配置/客户端变更后能拿到最新实例。 */
export interface ModelCatalogDeps {
	readonly logger: Logger;
	/** 取当前客户端（配置变更会重建客户端，因此每次拉取都要重新取） */
	getClient(): NewApiClient;
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
export class ModelCatalog implements vscode.Disposable {
	private snapshot: ModelCatalogSnapshot | undefined;
	private inFlight: Promise<ModelCatalogSnapshot> | undefined;
	private lastSettingsFingerprint: string | undefined;
	/** 上一次首拉失败的结果与时间，用于退避重试 */
	private lastFailure: { readonly at: number; readonly snapshot: ModelCatalogSnapshot } | undefined;
	private readonly emitter = new vscode.EventEmitter<ModelCatalogSnapshot>();

	/** 快照变化事件（含刷新失败导致的降级）。 */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly deps: ModelCatalogDeps) { }

	/** 当前快照；尚未成功加载过时为 `undefined`。 */
	get current(): ModelCatalogSnapshot | undefined {
		return this.snapshot;
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
		const settings = this.deps.getSettings();
		const fingerprint = fingerprintOf(settings);
		// 设置变了就必须重新计算，即使缓存还没过期
		const settingsChanged = this.lastSettingsFingerprint !== undefined
			&& this.lastSettingsFingerprint !== fingerprint;
		const force = options.force === true || settingsChanged;

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

		this.inFlight = this.refresh(settings, fingerprint, options.signal)
			.finally(() => {
				this.inFlight = undefined;
			});
		return await this.inFlight;
	}

	/** 丢弃缓存，下次 `getModels` 会强制刷新。 */
	invalidate(): void {
		this.snapshot = undefined;
		this.lastSettingsFingerprint = undefined;
		// 不清 lastFailure：配置变更后若依然连不上，不必立即再试一次
	}

	/** 按 ID 查一个模型配置。 */
	findModel(id: string): ModelConfig | undefined {
		return this.snapshot?.models.find(model => model.id === id);
	}

	dispose(): void {
		this.emitter.dispose();
	}

	/* ---------------------------------------------------------------------- */

	private async refresh(
		settings: ModelSettings,
		fingerprint: string,
		signal: AbortSignal | undefined,
	): Promise<ModelCatalogSnapshot> {
		const logger = this.deps.logger;
		const startedAt = Date.now();

		try {
			const client = this.deps.getClient();
			const raw = await client.listModels(signal);
			const built = buildModelConfigs(raw, { settings, logger });

			const snapshot: ModelCatalogSnapshot = {
				models: built.configs,
				fetchedAt: Date.now(),
				source: 'network',
				rawCount: raw.length,
				invalidCount: built.invalidCount,
			};
			const previous = this.snapshot;
			this.snapshot = snapshot;
			this.lastSettingsFingerprint = fingerprint;
			this.lastFailure = undefined;
			// debug 级：状态刷新会周期性强制重拉，每次打同样一行没有信息量
			logger.debug(
				`模型列表已刷新：${built.configs.length}/${raw.length} 可用，` +
				`耗时 ${Date.now() - startedAt}ms`,
			);
			this.emitIfChanged(previous, snapshot);
			return snapshot;
		} catch (error) {
			const message = describeError(error);
			const hint = describeFailureHint(error, this.deps.getClient().hasApiKey);
			logger.warn(`刷新模型列表失败：${message}`);

			if (this.snapshot !== undefined) {
				// 曾经成功过：保留旧数据（stale-while-error），只把错误标出来
				const stale: ModelCatalogSnapshot = { ...this.snapshot, source: 'cache', error: message, hint };
				this.emitIfChanged(this.snapshot, stale);
				this.snapshot = stale;
				return stale;
			}

			// 从未成功过：不把空结果写进 snapshot，
			// 否则一次瞬时失败会把「没有模型」缓存住整个 TTL
			const failure: ModelCatalogSnapshot = {
				models: [],
				fetchedAt: Date.now(),
				source: 'cache',
				rawCount: 0,
				invalidCount: 0,
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
	 * 周期性状态刷新会走到这里，因此没变就不能触发。
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
	const models = snapshot.models
		.map(model => [
			model.id,
			model.contextWindow,
			model.maxInputTokens,
			model.maxOutputTokens,
			model.imageInput ? 1 : 0,
			model.toolCalling ? 1 : 0,
			model.reasoning ? 1 : 0,
			model.reasoningEfforts.join('|'),
		].join(':'))
		.join(',');
	return `${snapshot.source}\u0000${snapshot.error ?? ''}\u0000${snapshot.hint ?? ''}\u0000${models}`;
}

/**
 * 首次拉取就失败时的退避时长。
 *
 * 失败（尤其是「未配置」）时没有快照可命中，不退避就会每次都发一轮请求。
 */
const FAILURE_BACKOFF_MS = 10_000;

/**
 * 计算模型设置指纹。
 *
 * 用设置内容而不是对象引用：`ConfigService` 每次读取都产生新对象，引用比较会误判成一直在变。
 */
export function fingerprintOf(settings: ModelSettings): string {
	return safeJsonStringify({
		defaultContextWindow: settings.defaultContextWindow,
		defaultMaxOutputTokens: settings.defaultMaxOutputTokens,
	}) ?? '';
}
