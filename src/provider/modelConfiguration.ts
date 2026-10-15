/**
 * 模型配置：VS Code 模型选择器里的可调项。
 *
 * provider 可以为每个模型下发一份 JSON Schema（`configurationSchema`），VS Code 据此渲染控件，
 * 用户选定的值在下次请求时随 `options.modelConfiguration` 交回。本扩展用它暴露「思考强度」。
 *
 * 三条硬性约束（依据 VS Code 实现）：
 * - 属性必须带 `enum` 才会被渲染；`group` 用 `navigation`（模型卡片主控件区）。
 * - 属性的 `default` 会被合并进模型配置，每次请求都带上它。
 * - `selectReasoningEffort` 解析改变后的选择，请求准备层将其与模型默认档位合并。
 *
 * 档位取自数据表的 `supportsReasoningEffort`，没有兜底列表：没给出档位时不声明控件。
 * 选项文字就是上游原值，不翻译不缩写。请求体字段名是 `reasoning_effort`；
 * 需要别的字段名或嵌套形态的网关交给适配器层改写。
 */

import type { ModelConfig } from '../models/modelConfig';
import { asNonEmptyString, isRecord } from '../json';
import {
	DEFAULT_REASONING_EFFORT_FIELD,
	REASONING_EFFORT_KEY,
} from '../consts';

/**
 * 模型配置中的一项。
 *
 * 只声明本扩展用到的字段；VS Code 还认 `enumItemLabels` / `enumDescriptions` 与
 * `defaultSnippets`，本扩展不使用。
 */
export interface ModelConfigurationProperty {
	readonly type: 'string' | 'number' | 'boolean';
	readonly title?: string;
	readonly description?: string;
	/** 候选项；没有它就不会渲染控件 */
	readonly enum?: readonly (string | number)[];
	/** 预选项；会被 VS Code 带进每一次请求 */
	readonly default?: string | number | boolean;
	/** `navigation` = 模型卡片主控件区，`tokens` = 上下文区 */
	readonly group?: string;
}

/** 一个模型的配置 schema。 */
export interface ModelConfigurationSchema {
	readonly properties: Readonly<Record<string, ModelConfigurationProperty>>;
}

/**
 * 构造模型配置 schema。
 *
 * 两种情况返回 `undefined`：模型不支持思考、数据表没给出可选档位
 * （后者是「会思考但不能调强度」的模型）。
 *
 * 候选项用模型自己的强度列表，因此不同模型看到的档位可能不同；有 `defaultReasoningEffort`
 * 时把它作为 `default`。
 */
export function buildModelConfigurationSchema(config: ModelConfig): ModelConfigurationSchema | undefined {
	if (!config.reasoning || config.reasoningEfforts.length === 0) {
		return undefined;
	}
	return {
		properties: {
			[REASONING_EFFORT_KEY]: {
				type: 'string',
				title: '思考强度',
				description: buildEffortDescription(config),
				enum: [...config.reasoningEfforts],
				// 只在数据表给出默认档位时才声明：没有它控件就是空选中，不编造一个值
				...(config.defaultReasoningEffort === undefined
					? {}
					: { default: config.defaultReasoningEffort }),
				group: 'navigation',
			},
		},
	};
}

/**
 * 属性的说明文字。知道 `defaultReasoningEffort` 时把它写出来（既是预选项也是实际生效的档位）。
 */
function buildEffortDescription(config: ModelConfig): string {
	const base = `发送 ${DEFAULT_REASONING_EFFORT_FIELD} 到 ${config.id}，控制模型在回答前思考多少。`;
	if (config.defaultReasoningEffort === undefined) {
		return base;
	}
	return `${base}默认 ${config.defaultReasoningEffort}（来自模型数据表）。`;
}

/**
 * 取本次请求生效的模型配置。
 *
 * 两个来源都不是 stable typings 的一部分，因此做运行时探测：
 * - `modelConfiguration`：VS Code 依据 schema 合并出来的配置（界面选择走这条）；
 * - `modelOptions`：通过扩展 API 直接调用模型的调用方显式传入的选项，优先级更高。
 */
export function readModelConfiguration(options: unknown): Record<string, unknown> | undefined {
	if (!isRecord(options)) {
		return undefined;
	}
	const stored = isRecord(options.modelConfiguration) ? options.modelConfiguration : undefined;
	const explicit = isRecord(options.modelOptions) ? options.modelOptions : undefined;
	if (stored === undefined) {
		return explicit;
	}
	return explicit === undefined ? stored : { ...stored, ...explicit };
}

/** 一次思考强度选择的结果。 */
export interface ReasoningEffortSelection {
	/** 用户改变后的强度；`undefined` 时请求准备层使用模型默认档位 */
	readonly effort?: string;
	/** 被忽略的取值及原因，供调用方写日志 */
	readonly ignored?: string;
}

/**
 * 解析本次请求该用的思考强度。
 *
 * 模型不支持思考、没有可选档位、用户未修改或选中默认档位时返回空选择。
 * 请求准备层负责合并数据表默认值，按协议显式发送有效档位。
 */
export function selectReasoningEffort(options: unknown, config: ModelConfig): ReasoningEffortSelection {
	if (!config.reasoning || config.reasoningEfforts.length === 0) {
		return {};
	}
	const raw = asNonEmptyString(readModelConfiguration(options)?.[REASONING_EFFORT_KEY]);
	if (raw === undefined || raw === config.defaultReasoningEffort) {
		return {};
	}
	if (!config.reasoningEfforts.includes(raw)) {
		return { ignored: `思考强度 ${raw} 不是该模型的可选取值（${config.reasoningEfforts.join(' / ')}），已忽略` };
	}
	return { effort: raw };
}
