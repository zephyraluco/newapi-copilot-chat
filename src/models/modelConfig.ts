/**
 * 模型配置整合：把三路信息合并成一份完整、可用、可解释的 `ModelConfig`。
 *
 * ```
 *   ① New API 返回的模型对象（可能带 context_length / supported_parameters 等扩展字段）
 *   ② 随包的模型数据表（按模型 ID 查表）
 *   ③ 设置里的兜底默认值
 *            ↓
 *      ModelConfig（含 tooltip 与每个字段的来源标注）
 * ```
 *
 * 优先级：**网关返回值 > 数据表 > 默认值**——网关最清楚自己那条链路，数据表只是生成时的
 * 快照。两者显著不一致时以网关为准（`meta.provenance` 把每个字段的来源记下来），差异本身写进日志。
 *
 * 相邻的两件事各有自己的模块：**各家网关的字段名**归 `./remoteHints.ts`（唯一知道它们的地方），
 * **窗口/输出/输入之间的一致性校正**归 `./limits.ts`。本模块只负责按优先级合并与记录来源。
 *
 * 「数值被谁覆盖、被怎么校正」的出口是**日志**（debug 级）与 `meta.provenance`。
 * 模型信息里刻意不带这类说明：tooltip 是「悬停一瞥」，塞满解释就没人看了。
 */

import { formatTokens } from '../format';
import { asNonEmptyString } from '../json';
import type { Logger } from '../logger';
import type { ModelSettings } from '../config';
import type { NewApiModel } from '../types';
import { matchModelDataset } from './dataset';
import { isSignificantlyDifferent, reconcileLimits } from './limits';
import { findFilteringPattern } from './matcher';
import { extractRemoteHints } from './remoteHints';
import { buildModelDetail, buildModelTooltip } from './tooltip';

/** 单个字段的取值来源。 */
export type ModelConfigSource = 'dataset' | 'remote' | 'default';

/** 整合后的模型元数据（不参与 VS Code 协议，供日志与溯源查看）。 */
export interface ModelConfigMeta {
	/** `/v1/models` 中的 `owned_by` */
	readonly ownedBy?: string;
	/** 厂商 */
	readonly vendor?: string;
	/** 命中的模型数据表键 */
	readonly datasetKey?: string;
	/** 每个字段的取值来源 */
	readonly provenance: Readonly<Record<string, ModelConfigSource>>;
}

/**
 * 一个模型的完整配置。
 *
 * 刻意不依赖 `vscode` 类型：本模块是纯数据转换，方便单测；
 * 到 `LanguageModelChatInformation` 的映射放在 provider 层。
 */
export interface ModelConfig {
	/** 模型 ID，必须原样回传给 `/v1/chat/completions` */
	readonly id: string;
	/**
	 * 模型选择器里显示的名字：优先展示名，没有则用 ID。
	 *
	 * ID（`anthropic/claude-sonnet-4.5` 这种）是给程序看的，拿它当列表项没人愿意读；
	 * 但 ID 也不会丢——悬浮提示的第一行就带着它。
	 */
	readonly name: string;
	/** 模型选择器里的副标题 */
	readonly detail: string;
	/** family：影响 VS Code 的模型归类 */
	readonly family: string;
	/** 版本字符串 */
	readonly version: string;
	/** 悬浮窗 Markdown */
	readonly tooltip: string;
	/** 校正后的上下文窗口 */
	readonly contextWindow: number;
	/** 同步给 VS Code 的输入上限 */
	readonly maxInputTokens: number;
	/** 同步给 VS Code 的最大输出 */
	readonly maxOutputTokens: number;
	readonly imageInput: boolean;
	readonly toolCalling: boolean;
	/**
	 * 模型是否具备思考（思维链）能力。
	 *
	 * 为 `true` **且** `reasoningEfforts` 非空时，模型选择器里才会出现
	 * 「思考强度」选项（见 `provider/modelConfiguration.ts`）。
	 */
	readonly reasoning: boolean;
	/**
	 * 该模型可选的思考强度；只在数据表给出了 `supportsReasoningEffort` 时才非空。
	 *
	 * 没有这个信息时**不编造**一组合适用的档位：那些模型确实会思考，但我们并不知道
	 * 站点能接受哪些值，凭空造一个列表只会发出一堆被拒的请求。
	 */
	readonly reasoningEfforts: readonly string[];
	/** 不指定思考强度时的上游默认取值；未知时为 `undefined` */
	readonly defaultReasoningEffort?: string;
	readonly meta: ModelConfigMeta;
}

/** 构建配置所需的上下文。 */
export interface BuildModelConfigsOptions {
	readonly settings: ModelSettings;
	readonly logger: Logger;
}

/** 构建结果。除了可用的配置，还带上被过滤/被判定为非法的模型，便于解释「为何少了某些模型」。 */
export interface BuildModelConfigsResult {
	readonly configs: readonly ModelConfig[];
	/** 被 include/exclude 规则挡掉的模型 */
	readonly filtered: readonly { readonly id: string; readonly reason: string }[];
	/** 缺少可用 id 而无法构建的条目数 */
	readonly invalidCount: number;
}

/* -------------------------------------------------------------------------- */
/* 单个模型解析                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 整合单个模型的信息。
 *
 * 无论数据表是否命中、网关是否返回元数据，本函数**一定**返回一份可用的配置——
 * 模型选择器里出现一个保守配置，远比整个列表加载失败要好。
 */
export function resolveModelConfig(model: NewApiModel, options: BuildModelConfigsOptions): ModelConfig {
	const { settings, logger } = options;
	const remote = extractRemoteHints(model);
	const dataset = matchModelDataset(model.id);
	// 冲突与被校正的数值：只在日志里交代，不进模型信息（见文件头）
	const adjustments: string[] = [];
	const provenance: Record<string, ModelConfigSource> = {};

	// ---- 上下文窗口 ------------------------------------------------------
	let contextWindow = settings.defaultContextWindow;
	provenance.contextWindow = 'default';
	if (dataset) {
		contextWindow = dataset.entry.contextWindow;
		provenance.contextWindow = 'dataset';
	}
	if (remote.contextWindow !== undefined) {
		if (dataset && isSignificantlyDifferent(remote.contextWindow, dataset.entry.contextWindow)) {
			adjustments.push(
				`网关报告的上下文窗口（${formatTokens(remote.contextWindow)}）与模型数据表（${formatTokens(dataset.entry.contextWindow)}）不一致，已采用网关值。`,
			);
		}
		contextWindow = remote.contextWindow;
		provenance.contextWindow = 'remote';
	}

	// ---- 最大输出 --------------------------------------------------------
	let maxOutputTokens = settings.defaultMaxOutputTokens;
	provenance.maxOutputTokens = 'default';
	if (dataset) {
		maxOutputTokens = dataset.entry.maxOutputTokens;
		provenance.maxOutputTokens = 'dataset';
	}
	if (remote.maxOutputTokens !== undefined) {
		maxOutputTokens = remote.maxOutputTokens;
		provenance.maxOutputTokens = 'remote';
	}

	// ---- 输入上限 --------------------------------------------------------
	let maxInputTokens = 0;
	let hasExplicitMaxInput = false;
	provenance.maxInputTokens = provenance.contextWindow;
	if (remote.maxInputTokens !== undefined) {
		maxInputTokens = remote.maxInputTokens;
		hasExplicitMaxInput = true;
		provenance.maxInputTokens = 'remote';
	}

	// ---- 能力 ------------------------------------------------------------
	let imageInput = false;
	provenance.imageInput = 'default';
	if (dataset) {
		imageInput = dataset.entry.imageInput;
		provenance.imageInput = 'dataset';
	}
	if (remote.imageInput !== undefined) {
		if (dataset && dataset.entry.imageInput !== remote.imageInput) {
			adjustments.push(
				`网关报告${remote.imageInput ? '支持' : '不支持'}图片输入，模型数据表认为${dataset.entry.imageInput ? '支持' : '不支持'}，已采用网关值。`,
			);
		}
		imageInput = remote.imageInput;
		provenance.imageInput = 'remote';
	}

	let toolCalling = false;
	provenance.toolCalling = 'default';
	if (dataset) {
		toolCalling = dataset.entry.toolCalling;
		provenance.toolCalling = 'dataset';
	}
	if (remote.toolCalling !== undefined) {
		toolCalling = remote.toolCalling;
		provenance.toolCalling = 'remote';
	}

	// ---- 思考能力 --------------------------------------------------------
	// 网关只能给出「肯定」（见 `RemoteModelHints.reasoning`），因此数据表先落地、
	// 网关的肯定最后覆盖：数据表没写时靠网关开启，两者都表态时以网关为准
	let reasoning = false;
	provenance.reasoning = 'default';
	if (dataset?.entry.reasoning !== undefined) {
		reasoning = dataset.entry.reasoning;
		provenance.reasoning = 'dataset';
	}
	if (remote.reasoning === true) {
		reasoning = true;
		provenance.reasoning = 'remote';
	}
	// 强度列表与默认强度只有数据表会给（网关的 /v1/models 不返回它们）；
	// 没有就是没有，不回退到任何内置列表
	const reasoningEfforts = dataset?.entry.supportsReasoningEffort ?? [];
	// 默认强度会作为控件的预选项，因此必须落在可选档位里；不在就当作没有
	const fallback = dataset?.entry.defaultReasoningEffort;
	const defaultReasoningEffort = fallback !== undefined && reasoningEfforts.includes(fallback)
		? fallback
		: undefined;

	// ---- 一致性校正 ------------------------------------------------------
	const reconciled = reconcileLimits({
		contextWindow,
		maxOutputTokens,
		maxInputTokens: hasExplicitMaxInput ? maxInputTokens : undefined,
	});
	adjustments.push(...reconciled.adjustments);

	// ---- 名字与 family ---------------------------------------------------
	const vendor = dataset?.entry.vendor;
	const displayName = dataset?.entry.displayName ?? remote.displayName;
	const family = remote.family ?? deriveFamily(model.id);

	const meta: ModelConfigMeta = {
		ownedBy: asNonEmptyString(model.owned_by),
		vendor,
		datasetKey: dataset?.key,
		provenance,
	};

	const facts = {
		id: model.id,
		vendor,
		contextWindow: reconciled.contextWindow,
		maxInputTokens: reconciled.maxInputTokens,
		maxOutputTokens: reconciled.maxOutputTokens,
		imageInput,
		toolCalling,
		reasoning,
	};

	logger.trace(
		`模型 ${model.id}：窗口 ${facts.contextWindow}，输入 ${facts.maxInputTokens}，输出 ${facts.maxOutputTokens}，` +
		`图片 ${imageInput}，工具 ${toolCalling}，思考 ${reasoning}`,
	);
	if (adjustments.length > 0) {
		// 数值被网关覆盖过、或被校正过：这类事实必须有出口，否则用户碰到
		// 「站点明明支持更大窗口」时无从排查。debug 级：平时不吵，需要时能查。
		logger.debug(`模型 ${model.id} 的数值差异或校正：${adjustments.join(' ')}`);
	}

	return {
		id: model.id,
		name: displayName ?? model.id,
		detail: buildModelDetail({ vendor, ownedBy: meta.ownedBy, contextWindow: facts.contextWindow, toolCalling }),
		family,
		version: remote.version ?? '1',
		tooltip: buildModelTooltip(facts),
		contextWindow: facts.contextWindow,
		maxInputTokens: facts.maxInputTokens,
		maxOutputTokens: facts.maxOutputTokens,
		imageInput,
		toolCalling,
		reasoning,
		reasoningEfforts,
		defaultReasoningEffort,
		meta,
	};
}

/**
 * 在本地模型数据表与网关都没有给出 family 时，从 ID 里猜一个 family。
 *
 * 只做「去掉版本/日期后缀」这种保守处理：family 主要影响 VS Code 的模型归类，
 * 猜错的代价很小，猜得过细反而会让同类模型被拆散。
 */
export function deriveFamily(modelId: string): string {
	let value = modelId.trim().toLowerCase();
	// New API 中转常见的渠道/分组后缀
	value = value.replace(/@[\w.-]+$/, '');
	// 日期版本：2024-08-06 / 20240806
	value = value.replace(/[-_.]\d{4}-\d{2}-\d{2}$/, '');
	value = value.replace(/[-_.]?\d{8}$/, '');
	// 语义化后缀
	value = value.replace(/[-_.](latest|preview|stable|beta|experimental|exp|alpha|rc|free|thinking|nothinking)$/, '');
	// 显式版本号：v1 / v1.2
	value = value.replace(/[-_.]v\d+(\.\d+)*$/, '');
	return value.length > 0 ? value : modelId.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/* 批量构建                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 批量构建模型配置，并应用 include / exclude 过滤。
 *
 * 过滤语义：
 * - `exclude` 优先于 `include`；
 * - `include` 为空数组表示「全部保留」，非空表示白名单。
 */
export function buildModelConfigs(
	raw: readonly NewApiModel[],
	options: BuildModelConfigsOptions,
): BuildModelConfigsResult {
	const { settings, logger } = options;
	const configs: ModelConfig[] = [];
	const filtered: { id: string; reason: string }[] = [];
	let invalidCount = 0;

	for (const model of raw) {
		const id = asNonEmptyString(model.id);
		if (id === undefined) {
			invalidCount++;
			continue;
		}
		const filter = findFilteringPattern(id, settings.include, settings.exclude);
		if (filter !== undefined) {
			const reason = filter.kind === 'exclude'
				? `命中排除规则 ${filter.pattern}`
				: `未命中包含规则（${filter.pattern}）`;
			filtered.push({ id, reason });
			continue;
		}

		try {
			configs.push(resolveModelConfig({ ...model, id }, options));
		} catch (error) {
			// 单个模型构建失败不应该拖垮整个列表
			invalidCount++;
			logger.error(`构建模型配置失败：${id}`, error);
		}
	}

	if (filtered.length > 0) {
		logger.info(`已按 include/exclude 过滤 ${filtered.length} 个模型`);
	}
	return { configs, filtered, invalidCount };
}
