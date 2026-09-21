/**
 * 远端字段提取：把网关返回的模型对象翻译成 `RemoteModelHints`。
 *
 * 这里是**唯一**知道各家网关用什么字段名的地方。不同网关暴露的字段名都不一样：
 * - New API / one-api 扩展：`context_length`、`max_tokens`
 * - OpenRouter：`context_length`、`top_provider.max_completion_tokens`、
 *   `architecture.input_modalities`、`supported_parameters`
 * - vLLM / 自建：`max_model_len`
 * - 通用猜测：`supports_vision`、`capabilities.*`
 *
 * 提取结果全部可选，拿不到就交给本地模型数据表与默认值兜底（优先级见 `modelConfig.ts`）。
 * 本模块是纯数据转换、不依赖 `vscode`，因此可以被单测直接覆盖。
 */

import { asBoolean, asStringArray, isRecord, pickBoolean, pickNumber, pickRecord, pickString } from '../json';
import type { NewApiModel } from '../types';

/**
 * 从网关返回值里能提取到的信息。
 *
 * 全部可选：提取不到就交给本地模型数据表与默认值兜底。
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
	/** 网关给出的 family */
	family?: string;
	/** 网关给出的版本号 */
	version?: string;
}

/** 从网关返回的模型对象里提取可用元数据。 */
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
