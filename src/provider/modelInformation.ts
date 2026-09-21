/**
 * 模型信息：把内部 `ModelConfig` 映射成 VS Code 的 `LanguageModelChatInformation`。
 *
 * 这一层只做映射、不发请求也不读设置，因此只依赖 vscode 的**类型**（`import type`），
 * 不引入运行时依赖。
 */

import type * as vscode from 'vscode';
import type { ModelConfig } from '../models/modelConfig';
import type { ProviderTarget } from '../runtime/target';
import { buildModelConfigurationSchema } from './modelConfiguration';
import type { ModelConfigurationSchema } from './modelConfiguration';

/**
 * 提供给 VS Code 的模型信息。
 *
 * 通过泛型参数携带额外字段：VS Code 会把 `provideLanguageModelChatInformation`
 * 返回的对象原样传回 `provideLanguageModelChatResponse`，因此这里挂上的内容
 * 在响应阶段可以放心使用（也是官方泛型设计的目的）。
 *
 * 注意只挂**目标指纹**而不是目标本身：这些字段会随模型元数据留在 VS Code 的
 * 模型缓存里，而 `ProviderTarget` 含有明文 API Key。
 */
export interface NewApiModelInformation extends vscode.LanguageModelChatInformation {
	/** 整合后的完整配置 */
	readonly config: ModelConfig;
	/**
	 * 模型级配置项（当前只有「思考强度」）。
	 *
	 * 这个字段不在 stable typings 里，但 VS Code 会把它当模型元数据收下，
	 * 并据此在模型选择器里渲染控件。
	 */
	readonly configurationSchema?: ModelConfigurationSchema;
	/** 该模型所属连接目标的指纹，用于在响应阶段找回同一个会话 */
	readonly targetKey: string;
	/** 目标标签，仅用于错误提示 */
	readonly targetLabel: string;
}

/** 把内部配置映射成 VS Code 需要的模型信息。 */
export function toModelInformation(config: ModelConfig, target: ProviderTarget): NewApiModelInformation {
	return {
		id: config.id,
		name: config.name,
		family: config.family,
		version: config.version,
		detail: config.detail,
		tooltip: config.tooltip,
		maxInputTokens: config.maxInputTokens,
		maxOutputTokens: config.maxOutputTokens,
		capabilities: {
			imageInput: config.imageInput,
			// 上游对单次请求的工具数量通常没有硬上限，用布尔值表达「支持」
			toolCalling: config.toolCalling,
		},
		// 空值时表示「不展示任何模型级控件」（模型不支持思考，或没有可选的思考强度档位）
		configurationSchema: buildModelConfigurationSchema(config),
		config,
		// 只带指纹与标签，不带 target 本体（后者含明文密钥）
		targetKey: target.key,
		targetLabel: target.label,
	};
}
