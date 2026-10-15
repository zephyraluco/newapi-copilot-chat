import type { ModelConfig } from '../models/modelConfig';
import type { AdapterContext, ModelAdapter } from './adapter';
import type { ChatCompletionRequest } from '../utils/types';
import { ModelCapabilityAdapter } from './capabilityAdapter';
import { DeepSeekAdapter } from './deepseek/deepseekAdapter';
import { OpenAIAdapter } from './openai/openaiAdapter';
import { QwenAdapter } from './qwen/qwenAdapter';
import { GlmAdapter } from './glm/glmAdapter';
import { KimiAdapter } from './kimi/kimiAdapter';

/** Fixed order: supplier protocols first, shared capability constraints last. */
export class AdapterRegistry {
	constructor(private readonly adapters: readonly ModelAdapter[] = []) {}
	resolveAll(model: ModelConfig): readonly ModelAdapter[] {
		return this.adapters.filter(adapter => adapter.supports(model));
	}
	transformRequest(request: ChatCompletionRequest, context: AdapterContext,
		adapters = this.resolveAll(context.model)): ChatCompletionRequest {
		let current = structuredClone(request);
		for (const adapter of adapters) {
			if (adapter.transformRequest !== undefined) { current = adapter.transformRequest(current, context); }
		}
		return current;
	}
}
export function createDefaultAdapterRegistry(): AdapterRegistry {
	return new AdapterRegistry([new DeepSeekAdapter(), new QwenAdapter(), new GlmAdapter(),
		new KimiAdapter(), new OpenAIAdapter(), new ModelCapabilityAdapter()]);
}
