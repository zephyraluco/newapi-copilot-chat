/**
 * 模型适配器接口。
 *
 * ## 为什么需要这一层
 *
 * 不同上游对 OpenAI 协议的实现并不一致，例如：
 * - 思考开关的字段名各不相同（`enable_thinking` / `thinking` / `reasoning_effort`）；
 * - o 系列不接受 `temperature`，且只认 `max_completion_tokens`；
 * - 有的网关把工具调用拆成多个 chunk，有的则一次性给全；
 * - 有的模型不支持 `tool_choice: required`，必须降级成 `auto`。
 *
 * 这些差异如果全写进 provider，provider 里会散落大量
 * `if (model.id.startsWith('xxx'))`。适配器就是这层差异的唯一出口：
 * provider 只调用 `transformRequest` / `transformChunk` / `finalize`，
 * 具体怎么改由适配器决定。
 *
 * ## 当前状态：占位
 *
 * 按需求，本期只建立接口与装配点，不实现具体的差异处理。
 * `DefaultModelAdapter` 的全部钩子都是恒等变换。
 *
 * 后续新增适配器只需三步，**不需要改动 provider**：
 * 1. 实现 `ModelAdapter`；
 * 2. 在 `registry.ts` 的 `createDefaultAdapterRegistry()` 里注册；
 * 3. 写好单测。
 */

import type { RequestSettings } from '../config';
import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../types';

/** 适配器运行上下文。每次请求构造一次，适配器内部应视为只读。 */
export interface AdapterContext {
	/** 本次请求使用的模型配置（含已解析的能力与窗口） */
	readonly model: ModelConfig;
	/** 当前请求相关设置 */
	readonly settings: RequestSettings;
	readonly logger: Logger;
	/**
	 * 用户在模型选择器里选定的思考强度；未选择（或不适用）时为 `undefined`。
	 *
	 * provider 已经按固定的 `reasoning_effort` 字段名把它写进请求体，
	 * 这里再传一份是为了让「字段名或取值词汇与本扩展不同」的网关能被适配器改写
	 * （例如改成 `{ thinking: { type: 'enabled', budget_tokens: ... } }`）。
	 */
	readonly reasoningEffort?: string;
}

/**
 * 一次请求内的可变状态。
 *
 * 流式响应会分多次调用 `transformChunk`，适配器往往需要跨 chunk 累积信息
 * （例如工具调用参数分片）。把状态显式传进来，而不是让适配器自己持有实例字段，
 * 这样同一个适配器实例可以被多个并发请求安全复用。
 */
export interface AdapterRequestState {
	/** 已累计输出的文本长度 */
	textLength: number;
	/** 适配器存放自定义数据的空间 */
	readonly scratch: Map<string, unknown>;
}

/** 模型适配器。全部钩子都是可选的。 */
export interface ModelAdapter {
	/** 唯一标识，用于日志与调试 */
	readonly id: string;
	/** 人类可读说明，展示在状态面板里 */
	readonly description: string;
	/** 优先级，数值大的先被选中；缺省为 0 */
	readonly priority?: number;
	/** 判断是否由本适配器处理该模型 */
	supports(model: ModelConfig): boolean;
	/**
	 * 请求发出前的最后一道改写。
	 *
	 * 典型用途：删除模型不支持的参数、补充网关专属字段。
	 * 必须返回请求对象（可以是同一个实例，也可以是新建的）。
	 */
	transformRequest?(
		request: ChatCompletionRequest,
		context: AdapterContext,
	): ChatCompletionRequest | Promise<ChatCompletionRequest>;
	/**
	 * 处理单个流式 chunk。
	 *
	 * 返回 `undefined` 表示丢弃该 chunk（例如适配器要把多个 chunk 合并后再吐出一个）。
	 */
	transformChunk?(
		chunk: ChatCompletionChunk,
		context: AdapterContext,
		state: AdapterRequestState,
	): ChatCompletionChunk | undefined | Promise<ChatCompletionChunk | undefined>;
	/**
	 * 请求结束时的冲刷钩子。
	 *
	 * 典型用途：把适配器内部缓冲的、还没凑齐的内容补发出去。
	 * provider 会在流结束后、上报结果前调用一次。
	 */
	finalize?(
		context: AdapterContext,
		state: AdapterRequestState,
	): readonly ChatCompletionChunk[] | Promise<readonly ChatCompletionChunk[]>;
}

/** 创建一次请求的状态对象。 */
export function createRequestState(): AdapterRequestState {
	return { textLength: 0, scratch: new Map<string, unknown>() };
}
