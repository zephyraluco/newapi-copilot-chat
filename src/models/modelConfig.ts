/**
 * 模型配置整合。
 *
 * 这是 `models` 模块的核心：把三路信息合并成一份**完整、可用、可解释**的模型配置。
 *
 * ```
 *   ① New API 返回的模型对象（可能带 context_length / supported_parameters 等扩展字段）
 *   ② 随包的模型数据表（`data/openrouter-models.json`，按模型 ID 查表）
 *   ③ 设置里的兜底默认值
 *            ↓
 *      ModelConfig（含 tooltip 与「每个字段来自哪里」的来源标注）
 * ```
 *
 * 优先级：**网关返回值 > 数据表 > 默认值**。
 * 越靠前的越可信：网关最清楚自己那条链路，而数据表只是生成时的快照
 * （同一模型在不同渠道的窗口确实可能不同）。两者显著不一致时会写成 note，
 * 在 tooltip 里说明已采用网关值。
 */

import { DEFAULTS } from '../consts';
import { formatTokens } from '../format';
import {
	asBoolean,
	asNonEmptyString,
	asNumber,
	asStringArray,
	isRecord,
	pickBoolean,
	pickNumber,
	pickRecord,
	pickString,
} from '../json';
import type { Logger } from '../logger';
import type { ModelSettings } from '../config';
import type { NewApiModel } from '../types';
import { matchModelDataset } from './dataset';
import { findFilteringPattern } from './matcher';
import { buildModelDetail, buildModelTooltip } from './tooltip';

/** 单个字段的取值来源。 */
export type ModelConfigSource = 'dataset' | 'remote' | 'default';

/**
 * 从网关返回值里能提取到的信息。
 *
 * 全部可选：不同网关（New API 本体、OpenRouter、vLLM、各家自建中转）暴露的字段名
 * 都不一样，提取不到就交给本地模型数据表与默认值兜底。
 */
export interface RemoteModelHints {
	/** 上下文窗口（输入 + 输出） */
	contextWindow?: number;
	/** 输入侧上限 */
	maxInputTokens?: number;
	/** 输出侧上限 */
	maxOutputTokens?: number;
	imageInput?: boolean;
	toolCalling?: boolean;
	/**
	 * 网关明确声明支持思考参数时为 `true`。
	 *
	 * 只有「肯定」一种取值：网关没列出来并不代表模型不会思考
	 * （New API 的 `/v1/models` 根本不返回 `supported_parameters`），
	 * 因此这里不允许据此推断 `false`，否则会把数据表里已知的思考能力抹掉。
	 */
	reasoning?: true;
	/** 网关给出的展示名 */
	displayName?: string;
	/** 网关给出的描述 */
	description?: string;
	/** 网关给出的 family */
	family?: string;
	/** 网关给出的版本号 */
	version?: string;
}

/** 整合后的模型元数据（供面板与 tip 使用，不参与 VS Code 协议）。 */
export interface ModelConfigMeta {
	/** `/v1/models` 中的 `owned_by` */
	readonly ownedBy?: string;
	/** 模型创建时间（Unix 秒） */
	readonly created?: number;
	/** 厂商 */
	readonly vendor?: string;
	/** 规范展示名 */
	readonly displayName?: string;
	readonly description?: string;
	/** 命中的模型数据表键 */
	readonly datasetKey?: string;
	/** 每个字段的取值来源 */
	readonly provenance: Readonly<Record<string, ModelConfigSource>>;
	/** 需要提示用户的注意事项 */
	readonly notes: readonly string[];
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
	/** 模型选择器里显示的名字 */
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

/** 构建结果。除了可用的配置，还带上被过滤/被判定为非法的模型，便于在面板里解释。 */
export interface BuildModelConfigsResult {
	readonly configs: readonly ModelConfig[];
	/** 被 include/exclude 规则挡掉的模型 */
	readonly filtered: readonly { readonly id: string; readonly reason: string }[];
	/** 缺少可用 id 而无法构建的条目数 */
	readonly invalidCount: number;
}

/* -------------------------------------------------------------------------- */
/* 远端字段提取                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 从网关返回的模型对象里提取可用元数据。
 *
 * 覆盖的字段名来自实际观察到的几种风格：
 * - New API / one-api 扩展：`context_length`、`max_tokens`
 * - OpenRouter：`context_length`、`top_provider.max_completion_tokens`、
 *   `architecture.input_modalities`、`supported_parameters`
 * - vLLM / 自建：`max_model_len`
 * - 通用猜测：`supports_vision`、`capabilities.*`
 */
export function extractRemoteHints(model: NewApiModel): RemoteModelHints {
	const hints: RemoteModelHints = {};
	const topProvider = pickRecord(model, 'top_provider');
	const capabilities = pickRecord(model, 'capabilities');
	const architecture = pickRecord(model, 'architecture');
	const topLevel = isRecord(model) ? model : undefined;

	// ---- 上下文窗口 ------------------------------------------------------
	const explicitContext = pickNumber(model, [
		'context_length',
		'context_window',
		'contextWindow',
		'max_context_tokens',
		'max_model_len',
		'max_sequence_length',
		'input_token_limit',
	]);
	const outputHints = pickNumber(model, ['max_output_tokens', 'max_completion_tokens', 'max_output_length'])
		?? pickNumber(topProvider, ['max_completion_tokens']);
	const inputHints = pickNumber(model, ['max_input_tokens']);
	const genericMaxTokens = pickNumber(model, ['max_tokens']);

	if (outputHints !== undefined) {
		hints.maxOutputTokens = outputHints;
	}
	if (inputHints !== undefined) {
		hints.maxInputTokens = inputHints;
	}

	if (explicitContext !== undefined) {
		hints.contextWindow = explicitContext;
		if (hints.maxOutputTokens === undefined && genericMaxTokens !== undefined && genericMaxTokens < explicitContext) {
			// 有明确上下文、又有更小的 max_tokens：后者应理解为输出上限
			hints.maxOutputTokens = genericMaxTokens;
		}
	} else if (genericMaxTokens !== undefined) {
		// 只有 max_tokens：多数网关在此语义下表示「生成长度上限」，
		// 但把它当成上下文窗口更接近其他工具的处理方式，因此这里宁可保守：
		// 既当作输出上限，也不去猜测上下文窗口（留给本地模型数据表）。
		// New API 的 `/v1/models` 正是这种形态，因此数据表的命中率很关键。
		if (hints.maxOutputTokens === undefined) {
			hints.maxOutputTokens = genericMaxTokens;
		}
	} else if (hints.maxInputTokens !== undefined && hints.maxOutputTokens !== undefined) {
		hints.contextWindow = hints.maxInputTokens + hints.maxOutputTokens;
	}

	// ---- 图片输入 --------------------------------------------------------
	const modalities = asStringArray(topLevel?.input_modalities)
		?? asStringArray(architecture?.input_modalities)
		?? asStringArray(topLevel?.modalities)
		?? asStringArray(topLevel?.input_types);
	if (modalities !== undefined) {
		hints.imageInput = modalities.some(item => item.toLowerCase().includes('image'));
	} else {
		hints.imageInput = pickBoolean(model, [
			'supports_vision',
			'supports_image_input',
			'image_input',
			'vision',
			'multimodal',
		]) ?? pickBoolean(capabilities, ['vision', 'image_input', 'imageInput', 'imageInputSupported']);
	}

	// ---- 工具调用 --------------------------------------------------------
	const supportedParameters = asStringArray(topLevel?.supported_parameters);
	if (supportedParameters !== undefined) {
		const lowered = supportedParameters.map(item => item.toLowerCase());
		hints.toolCalling = lowered.includes('tools') || lowered.includes('tool_choice') || lowered.includes('functions');
	} else {
		hints.toolCalling = pickBoolean(model, [
			'supports_tools',
			'supports_tool_calling',
			'supports_function_calling',
			'function_calling',
			'tool_calling',
		]) ?? pickBoolean(capabilities, ['tool_calling', 'toolCalling', 'tools', 'function_calling']);
	}

	// ---- 思考能力 --------------------------------------------------------
	// 只认「肯定」：列出推理参数说明支持；没有列出来只说明网关不暴露这些参数
	// （New API 的 `/v1/models` 就完全不返回 `supported_parameters`），
	// 因此这里不下 `false` 的结论——否定由数据表（即生成脚本）负责。
	const reasoningParameters = ['reasoning', 'include_reasoning', 'reasoning_effort', 'thinking', 'enable_thinking'];
	if (supportedParameters !== undefined
		&& supportedParameters.some(item => reasoningParameters.includes(item.toLowerCase()))) {
		hints.reasoning = true;
	} else if (pickBoolean(capabilities, ['reasoning', 'thinking', 'supports_reasoning']) === true
		|| pickBoolean(model, ['supports_reasoning', 'reasoning']) === true) {
		hints.reasoning = true;
	}

	// ---- 文本字段 --------------------------------------------------------
	hints.displayName = pickString(model, ['display_name', 'model_name', 'label']);
	hints.description = pickString(model, ['description', 'summary', 'desc']);
	hints.family = pickString(model, ['family', 'model_family']);
	hints.version = pickString(model, ['version']);

	// 网关返回的 displayName 常常就是 id 本身，没有信息量，去掉以免 tooltip 重复
	if (hints.displayName === model.id) {
		hints.displayName = undefined;
	}
	// 过滤掉明显是错误值的布尔
	if (asBoolean(hints.imageInput) === undefined) {
		hints.imageInput = undefined;
	}
	if (asBoolean(hints.toolCalling) === undefined) {
		hints.toolCalling = undefined;
	}

	return hints;
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
	const notes: string[] = [];
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
			notes.push(
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
			notes.push(
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
	if (reconciled.notes.length > 0) {
		notes.push(...reconciled.notes);
	}

	// ---- 名字与 family ---------------------------------------------------
	const vendor = dataset?.entry.vendor;
	const displayName = dataset?.entry.displayName ?? remote.displayName;
	const family = remote.family ?? deriveFamily(model.id);

	const meta: ModelConfigMeta = {
		ownedBy: asNonEmptyString(model.owned_by),
		created: asNumber(model.created),
		vendor,
		displayName,
		description: remote.description,
		datasetKey: dataset?.key,
		provenance,
		notes,
	};

	const facts = {
		id: model.id,
		displayName,
		family,
		ownedBy: meta.ownedBy,
		vendor,
		created: meta.created,
		contextWindow: reconciled.contextWindow,
		maxInputTokens: reconciled.maxInputTokens,
		maxOutputTokens: reconciled.maxOutputTokens,
		imageInput,
		toolCalling,
		reasoning,
		reasoningEfforts,
		defaultReasoningEffort,
		description: meta.description,
		datasetKey: meta.datasetKey,
		provenance,
		notes,
	};

	logger.trace(
		`模型 ${model.id}：窗口 ${facts.contextWindow}，输入 ${facts.maxInputTokens}，输出 ${facts.maxOutputTokens}，` +
		`图片 ${imageInput}，工具 ${toolCalling}，思考 ${reasoning}`,
	);

	return {
		id: model.id,
		name: model.id,
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

/** 单个模型注解：保证模型至少能输出这么多 token，否则它的价值低于成本。 */
const MIN_OUTPUT_TOKENS = 256;

/** 判断两个窗口是否「显著不同」：差值超过 10% 才算，避免把 128000 与 128k 当成冲突。 */
function isSignificantlyDifferent(a: number, b: number): boolean {
	const larger = Math.max(a, b);
	const smaller = Math.min(a, b);
	if (larger <= 0) {
		return false;
	}
	return (larger - smaller) / larger > 0.1;
}

/**
 * 校正窗口/输出/输入三者之间的关系。
 *
 * 三层来源合起来很容易得到自相矛盾的数值（例如数据表说窗口 8K，网关却说输出上限 16K），
 * 直接透传给 VS Code 会导致请求被上游拒绝，或者出现「输入上限 > 上下文窗口」的怪状态。
 * 这里统一收敛，并把每一次修正记录成 note 供用户查看。
 */
function reconcileLimits(input: {
	contextWindow: number;
	maxOutputTokens: number;
	maxInputTokens: number | undefined;
}): { contextWindow: number; maxOutputTokens: number; maxInputTokens: number; notes: string[] } {
	const notes: string[] = [];

	let contextWindow = Math.round(input.contextWindow);
	if (!Number.isFinite(contextWindow) || contextWindow < DEFAULTS.minContextWindow) {
		notes.push(`上下文窗口 ${input.contextWindow} 过小，已按最小值 ${DEFAULTS.minContextWindow} 处理。`);
		contextWindow = DEFAULTS.minContextWindow;
	}

	let maxOutputTokens = Math.round(input.maxOutputTokens);
	if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < MIN_OUTPUT_TOKENS) {
		maxOutputTokens = MIN_OUTPUT_TOKENS;
	}

	// 至少给输入留 1/4 窗口（且不低于 minInputTokens），否则把输出压回来
	const minInput = Math.max(DEFAULTS.minInputTokens, Math.floor(contextWindow / 4));
	if (contextWindow - maxOutputTokens < minInput) {
		const clamped = Math.max(MIN_OUTPUT_TOKENS, contextWindow - minInput);
		if (clamped !== maxOutputTokens) {
			notes.push(
				`最大输出 ${formatTokens(maxOutputTokens)} 会挤占输入空间，已下调为 ${formatTokens(clamped)}。`,
			);
			maxOutputTokens = clamped;
		}
	}

	const ceiling = Math.max(DEFAULTS.minInputTokens, contextWindow - maxOutputTokens);
	let maxInputTokens = input.maxInputTokens === undefined
		? ceiling
		: Math.max(DEFAULTS.minInputTokens, Math.min(Math.round(input.maxInputTokens), contextWindow));
	if (input.maxInputTokens !== undefined && maxInputTokens > ceiling) {
		notes.push(
			`输入上限 ${formatTokens(input.maxInputTokens)} 与上下文窗口冲突，已收敛为 ${formatTokens(ceiling)}。`,
		);
		maxInputTokens = ceiling;
	}

	return { contextWindow, maxOutputTokens, maxInputTokens, notes };
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
