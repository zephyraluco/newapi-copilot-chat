/**
 * 模型配置整合：把三路信息合并成一份完整、可用、可解释的 `ModelConfig`。
 *
 * ```
 *   ① New API 返回的模型对象（可能带 context_length / supported_parameters 等扩展字段）
 *   ② 随包的模型数据表（按模型 ID 查表）
 *   ③ 设置里的兜底默认值
 *            ↓
 *      ModelConfig（纯模型事实与每个字段的来源标注）
 * ```
 *
 * 优先级：网关返回值 > 数据表 > 默认值。两者显著不一致时以网关为准，
 * `meta.provenance` 记录每个字段的来源，差异写进日志。
 *
 * 各家网关的字段名归 `./remoteHints.ts`，窗口/输出/输入的一致性校正归 `./limits.ts`；
 * 本模块只负责按优先级合并与记录来源。
 *
 * 「数值被谁覆盖、被怎么校正」的出口是日志（debug 级）与 `meta.provenance`，不放进模型信息。
 */

import { formatTokens } from '../shared/format';
import { asNonEmptyString } from '../shared/json';
import type { Logger } from '../shared/log';
import type { ModelSettings } from '../shared/settings';
import type { NewApiModel } from '../shared/types';
import { matchModelDataset } from './dataset';
import type { ModelSamplingParams } from './dataset';
import { isSignificantlyDifferent, reconcileLimits } from './limits';
import { extractRemoteHints } from './remoteHints';

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
 * 不依赖 `vscode` 类型：本模块是纯数据转换，便于单测；
 * 到 LanguageModelChatInformation 的映射与 tooltip 生成放在 host 层。
 */
export interface ModelConfig {
	/** 模型 ID，必须原样回传给 `/v1/chat/completions` */
	readonly id: string;
	/**
	 * 模型选择器里显示的名字：优先展示名，没有则用 ID。
	 *
	 * ID 不会丢：悬浮提示的第一行带着它。
	 */
	readonly name: string;
	/** family：影响 VS Code 的模型归类 */
	readonly family: string;
	/** 版本字符串 */
	readonly version: string;
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
	 * 为 `true` 且 `reasoningEfforts` 非空时，模型选择器里才出现「思考强度」选项
	 * （见 `provider/modelConfiguration.ts`）。
	 */
	readonly reasoning: boolean;
	/**
	 * 该模型可选的思考强度；只在数据表给出 `supportsReasoningEffort` 时非空。
	 *
	 * 没有这个信息时不编造档位：不知道站点能接受哪些值。
	 */
	readonly reasoningEfforts: readonly string[];
	/** 不指定思考强度时的上游默认取值；未知时为 `undefined` */
	readonly defaultReasoningEffort?: string;
	/**
	 * 采样参数（`temperature` / `top_p` / `logprobs`…）在 Chat Completions 里的接受情况。
	 *
	 * `undefined` 表示「始终接受」：数据表没表态时不动请求。取值只来自模型数据表
	 * （生成脚本按上游的 `supported_parameters` 判定）；网关的 `/v1/models` 不返回这类信息。
	 */
	readonly samplingParams?: ModelSamplingParams;
	readonly meta: ModelConfigMeta;
}

/** 构建配置所需的上下文。 */
export interface BuildModelConfigsOptions {
	readonly settings: ModelSettings;
	readonly logger: Logger;
}

/** 构建结果。除了可用的配置，还带上无法构建的条目数，便于解释为何少了某些模型。 */
export interface BuildModelConfigsResult {
	readonly configs: readonly ModelConfig[];
	/** 缺少可用 id 或构建失败的条目数 */
	readonly invalidCount: number;
}

/* -------------------------------------------------------------------------- */
/* 单个模型解析                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 整合单个模型的信息。
 *
 * 无论数据表是否命中、网关是否返回元数据，本函数一定返回一份可用的配置。
 */
export function resolveModelConfig(model: NewApiModel, options: BuildModelConfigsOptions): ModelConfig {
	const { settings, logger } = options;
	const remote = extractRemoteHints(model);
	const dataset = matchModelDataset(model.id);
	// 冲突与被校正的数值：只在日志里交代，不进模型信息
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
	// 图像生成模型不接受 Chat Completions 的 tools；部分网关会把它们误标成通用 GPT 模型，
	// 因此按模型名纠正能力，避免 VS Code 下发工具。
	if (/(?:^|\/)(?:gpt-image|gpt-5(?:\.[0-9]+)?-image|gemini-[^/]*image|grok-[^/]*image)(?:$|[@:.-])/i.test(model.id)) {
		if (toolCalling) {
			toolCalling = false;
			provenance.toolCalling = 'default';
			adjustments.push('图像模型不支持 Chat Completions 工具调用，已禁用工具能力。');
		}
	}

	// ---- 思考能力 --------------------------------------------------------
	// 网关只能给出「肯定」（见 `RemoteModelHints.reasoning`），因此数据表先落地、
	// 网关的肯定最后覆盖。
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
	// 强度列表与默认强度只有数据表会给出（网关的 /v1/models 不返回它们），不回退到内置列表
	const reasoningEfforts = dataset?.entry.supportsReasoningEffort ?? [];
	// 默认强度会作为控件的预选项，因此必须落在可选档位里
	const fallback = dataset?.entry.defaultReasoningEffort;
	const defaultReasoningEffort = fallback !== undefined && reasoningEfforts.includes(fallback)
		? fallback
		: undefined;
	// 采样参数只有数据表会表态：网关的 /v1/models 不返回它，因此不存在远端覆盖这一路。
	const samplingParams = dataset?.entry.samplingParams;
	if (samplingParams !== undefined) {
		provenance.samplingParams = 'dataset';
	}

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
		// 数值被网关覆盖或校正过：debug 级出口，供排查用
		logger.debug(`模型 ${model.id} 的数值差异或校正：${adjustments.join(' ')}`);
	}

	return {
		id: model.id,
		name: displayName ?? model.id,
		family,
		version: remote.version ?? '1',
		contextWindow: facts.contextWindow,
		maxInputTokens: facts.maxInputTokens,
		maxOutputTokens: facts.maxOutputTokens,
		imageInput,
		toolCalling,
		reasoning,
		reasoningEfforts,
		defaultReasoningEffort,
		samplingParams,
		meta,
	};
}

/**
 * 在本地模型数据表与网关都没有给出 family 时，从 ID 里猜一个 family。
 *
 * 只做「去掉版本/日期后缀」这种保守处理：猜错的代价很小，猜得过细会让同类模型被拆散。
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
 * 批量构建模型配置。
 *
 * 单个模型构建失败不影响其他条目：只计数并记一条 error 日志。
 */
export function buildModelConfigs(
	raw: readonly NewApiModel[],
	options: BuildModelConfigsOptions,
): BuildModelConfigsResult {
	const { logger } = options;
	const configs: ModelConfig[] = [];
	let invalidCount = 0;

	for (const model of raw) {
		const id = asNonEmptyString(model.id);
		if (id === undefined) {
			invalidCount++;
			continue;
		}

		try {
			configs.push(resolveModelConfig({ ...model, id }, options));
		} catch (error) {
			// 单个模型构建失败只计数
			invalidCount++;
			logger.error(`构建模型配置失败：${id}`, error);
		}
	}

	return { configs, invalidCount };
}
