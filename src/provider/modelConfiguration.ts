/**
 * 模型配置：VS Code 模型选择器里的可调项。
 *
 * provider 可以为每个模型下发一份 JSON Schema（`configurationSchema`），VS Code 据此渲染控件，
 * 用户选定的值在下次请求时随 `options.modelConfiguration` 交回。本扩展用它暴露「思考强度」。
 *
 * 三条硬性约束（依据 VS Code 实现）：
 * - 属性**必须带 `enum`** 才会被渲染；`group` 用 `navigation`（模型卡片主控件区）。
 * - 属性的 `default` 会被合并进模型配置，**每次请求都带上它**。这里填数据表的
 *   `defaultReasoningEffort`，控件因此能预选出实际生效的档位。
 * - 因此发请求时**值等于默认档位就不发**（见 `selectReasoningEffort`）：预选只是让界面反映现状，
 *   不该改变线上行为。数据表没给默认档位时不声明 `default`，控件保持空选中。
 *
 * 档位取自数据表的 `supportsReasoningEffort`（生成脚本从上游 `reasoning.supported_efforts` 抄下），
 * **没有兜底列表**：没给出档位时不声明控件，凭空造一组值只会发出站点不认的请求。
 * 选项文字就是上游原值，不翻译不缩写（自己维护映射，出现新档位时只会显示一个猜出来的名字）。
 * 请求体字段名是 `reasoning_effort`；需要别的字段名或嵌套形态的网关交给适配器层改写。
 */

import type { ModelConfig } from '../models/modelConfig';
import { asNonEmptyString, isRecord } from '../json';
import {
	DEFAULT_REASONING_EFFORT_FIELD,
	PROTECTED_REQUEST_KEYS,
	REASONING_EFFORT_KEY,
} from '../consts';
import type { ChatCompletionRequest } from '../types';

/**
 * 模型配置中的一项。
 *
 * 只声明本扩展用到的字段；VS Code 还认 `enumItemLabels` / `enumDescriptions`（选项文字与逐项
 * 说明）与 `defaultSnippets`（「配置模型」命令的设置片段），本扩展刻意都不加：选项直接用
 * 数据表里的原值。
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
 * 两种情况返回 `undefined`（不声明 schema 时 VS Code 不会展示任何控件，也不会向请求里
 * 塞入模型配置）：模型不支持思考，或数据表没给出可选档位。后者是「会思考但不能调强度」
 * 的模型（上游只给 `mandatory` / `default_enabled`），对它们没有可选项可言。
 *
 * 候选项用**模型自己的**强度列表（来自数据表），因此不同模型看到的档位可能不同，
 * 并且直接用上游的原值；有 `defaultReasoningEffort` 时把它作为 `default`，控件会预选它。
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
 * 属性的说明文字。
 *
 * 知道 `defaultReasoningEffort` 时把它写出来：它既是控件的预选项，也是不指定时实际生效的档位。
 * 这里同样用原值。
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
	/** 要写进请求体的强度；`undefined` 表示本次不发送该字段 */
	readonly effort?: string;
	/** 被忽略的取值及原因，供调用方写日志——静默丢弃会让「为什么没生效」无从排查 */
	readonly ignored?: string;
}

/**
 * 解析本次请求该用的思考强度。
 *
 * 以下情况都返回「不发送」：模型不支持思考、数据表没给出可选档位（本来就不该有控件）、
 * 用户没选过，以及**选中的就是该模型的默认档位**。
 *
 * 最后一条很关键：控件会预选 `defaultReasoningEffort`（见上文），所以“保持默认”是最常见的
 * 状态。那个值本来就是站点自己在用的，显式发出去没有意义，只会给每个请求多带一个字段
 * （还会撞上不认 `reasoning_effort` 的实现）。因此只发“用户真的改了档位”的情况。
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

/**
 * 把思考强度写进请求体。
 *
 * 字段名是常量，因此不存在「路径写坏协议骨架」的风险；但额外字段（`request.extraBody`）
 * 可能已经写了同名字段，而模型选择器里的选择比静态设置更具体，所以这里直接盖过它。
 */
export function applyReasoningEffort(request: ChatCompletionRequest, effort: string): void {
	if (PROTECTED_REQUEST_KEYS.has(DEFAULT_REASONING_EFFORT_FIELD)) {
		// 协议字段不可被覆盖；常量本身落在这里只说明有人改错了常量
		return;
	}
	request[DEFAULT_REASONING_EFFORT_FIELD] = effort;
}
