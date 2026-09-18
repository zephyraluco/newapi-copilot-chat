/**
 * 模型适配器接口：上游协议差异的唯一出口。
 *
 * 不同上游对 OpenAI 协议的实现并不一致，例如思考开关字段名各异
 * （`enable_thinking` / `thinking` / `reasoning_effort`）、推理模型不接受 `temperature`
 * 且只认 `max_completion_tokens`、有的网关不支持 `tool_choice: required`。
 * 这些差异如果全写进 provider，会散落大量 `if (model.id.startsWith('xxx'))`。
 *
 * `DefaultModelAdapter` 的全部钩子都是恒等变换。新增适配器只需三步，**不需要改动 provider**：
 * 1. 在 `adapter/<supplier>/`（以供应商命名，例如 `deepseek/`）下实现 `ModelAdapter`，
 *    目录内的文件只服务该供应商；
 * 2. 在 `registry.ts` 的 `createDefaultAdapterRegistry()` 里注册；
 * 3. 写好单测。
 *
 * 只有确实存在的差异才值得写成钩子。**通用容错不属于这里**——例如「思维链字段名各家不同」
 * 由 `reasoning.ts` 统一认，而不是让每个适配器各写一遍。
 */

import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest } from '../types';

/** 适配器运行上下文。每次请求构造一次，适配器内部应视为只读。 */
export interface AdapterContext {
	/** 本次请求使用的模型配置（含已解析的能力与窗口） */
	readonly model: ModelConfig;
	readonly logger: Logger;
}

/** 模型适配器。全部钩子都是可选的。 */
export interface ModelAdapter {
	/** 唯一标识，用于日志与调试 */
	readonly id: string;
	/** 人类可读说明（未直接展示，供日志与调试使用） */
	readonly description: string;
	/** 优先级，数值大的先被选中；缺省为 0 */
	readonly priority?: number;
	/** 判断是否由本适配器处理该模型 */
	supports(model: ModelConfig): boolean;
	/**
	 * 历史里的助手消息是否要回填思考内容（`reasoning_content`）。
	 *
	 * 打开后 provider 会把上一次响应用**回放标记**留下的思考文本写回 assistant 消息
	 * （见 `provider/replay.ts`）——宿主不会把思考内容放回历史里，不回填就永远拿不回来。
	 * 只有确实要求这个字段的上游才该打开：对不认它的实现，多一个字段就是多一个 400 的理由。
	 */
	readonly echoReasoningContent?: boolean;
	/** 请求发出前的最后一道改写（删除不支持的参数、补网关专属字段）；必须返回请求对象。 */
	transformRequest?(
		request: ChatCompletionRequest,
		context: AdapterContext,
	): ChatCompletionRequest | Promise<ChatCompletionRequest>;
}
