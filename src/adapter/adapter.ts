/**
 * 模型适配器接口：上游协议差异的唯一出口。
 *
 * 差异例如思考开关字段名各异（`enable_thinking` / `thinking` / `reasoning_effort`）、
 * 推理模型不接受 `temperature` 且只认 `max_completion_tokens`。
 *
 * 新增适配器：在 `adapter/<supplier>/` 下实现 `ModelAdapter`，在 `registry.ts` 的
 * `createDefaultAdapterRegistry()` 里注册，并补单测；不需要改动 provider。
 *
 * 只有确实存在的差异才写成钩子；通用容错（例如各家不同的思维链字段名）由 `reasoning.ts` 统一处理。
 */

import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest } from '../types';

/** 适配器运行上下文。每次请求构造一次，适配器内部应视为只读。 */
export interface AdapterContext {
	/** 本次请求使用的模型配置（含已解析的能力与窗口） */
	readonly model: ModelConfig;
	readonly logger: Logger;
	/** 已校验的模型选择（含 schema 默认值），用于原生思考开关；不强制发送强度字段。 */
	readonly reasoningEffort?: string;
}

/** 模型适配器。全部钩子都是可选的。 */
export interface ModelAdapter {
	/** 唯一标识，用于日志与调试 */
	readonly id: string;
	/** 优先级，数值大的先被选中；缺省为 0 */
	readonly priority?: number;
	/** 判断是否由本适配器处理该模型 */
	supports(model: ModelConfig): boolean;
	/**
	 * 历史里的助手消息是否要回填思考内容（`reasoning_content`）：打开后 provider 会把上次响应
	 * 留下的思考文本写回 assistant 消息（见 `provider/replay.ts`）。宿主不会把思考内容放回历史。
	 * 只有确实要求这个字段的上游才该打开。
	 */
	readonly echoReasoningContent?: boolean;
	/** 请求发出前的改写（删除不支持的参数、补网关专属字段）；必须返回请求对象。 */
	transformRequest?(
		request: ChatCompletionRequest,
		context: AdapterContext,
	): ChatCompletionRequest | Promise<ChatCompletionRequest>;
}
