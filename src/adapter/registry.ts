/**
 * 适配器注册表：保存已注册的适配器，并按模型解析出应该用哪些。
 * provider 只与这里交互，新增适配器不会波及 provider。
 */

import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { AdapterContext, ModelAdapter } from './adapter';
import type { ChatCompletionRequest } from '../types';
import { ModelCapabilityAdapter } from './capabilityAdapter';
import { DeepSeekAdapter } from './deepseek/deepseekAdapter';
import { OpenAIAdapter } from './openai/openaiAdapter';
import { QwenAdapter } from './qwen/qwenAdapter';
import { GlmAdapter } from './glm/glmAdapter';
import { KimiAdapter } from './kimi/kimiAdapter';

/** 适配器注册表。 */
export class AdapterRegistry {
	private readonly adapters: ModelAdapter[] = [];

	/**
	 * 注册适配器。
	 *
	 * 重复注册同一个 id 会被忽略并留下警告，避免静默覆盖导致适配器不生效。
	 */
	register(adapter: ModelAdapter, logger?: Logger): void {
		if (this.adapters.some(item => item.id === adapter.id)) {
			logger?.warn(`适配器 ${adapter.id} 已存在，跳过重复注册`);
			return;
		}
		this.adapters.push(adapter);
		// 高优先级在前，保证 resolveAll 的顺序稳定
		this.adapters.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/**
	 * 解析模型应使用的**全部**适配器，按 `priority` 从高到低。
	 *
	 * 差异按「一个协议特性」拆分，一个模型常常同时命中多条；无匹配项时返回空数组，请求直接透传。
	 */
	resolveAll(model: ModelConfig): readonly ModelAdapter[] {
		return this.adapters.filter(adapter => adapter.supports(model));
	}

	/** 在独立请求副本上按优先级串接改写，支持同步与异步适配器。 */
	async transformRequest(
		request: ChatCompletionRequest,
		context: AdapterContext,
		adapters: readonly ModelAdapter[] = this.resolveAll(context.model),
	): Promise<ChatCompletionRequest> {
		// 复制请求，避免原地改写污染调用方持有的历史与请求模板
		let current = structuredClone(request);
		for (const adapter of adapters) {
			if (adapter.transformRequest !== undefined) {
				current = await adapter.transformRequest(current, context);
			}
		}
		return current;
	}
}

/**
 * 创建内置默认配置的注册表。
 *
 * 供应商适配器各自放在以供应商命名的子目录里（例如 `deepseek/`）；
 * `capabilityAdapter` 作为框架层留在本目录，在厂商适配器之后处理数据驱动的能力位。
 */
export function createDefaultAdapterRegistry(logger?: Logger): AdapterRegistry {
	const registry = new AdapterRegistry();

	registry.register(new DeepSeekAdapter(), logger);
	registry.register(new QwenAdapter(), logger);
	registry.register(new GlmAdapter(), logger);
	registry.register(new KimiAdapter(), logger);
	registry.register(new OpenAIAdapter(), logger);
	// 数据驱动的能力位：优先级低于供应商适配器，看到的是它们改写之后的请求
	registry.register(new ModelCapabilityAdapter(), logger);

	return registry;
}
