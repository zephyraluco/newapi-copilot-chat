import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** Qwen 的 OpenAI 兼容接口使用 enable_thinking，而不是 reasoning_effort。 */
export class QwenAdapter implements ModelAdapter {
	readonly id = 'qwen';
	readonly priority = 90;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)qwen(?:\d|[-/])/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const effort = readThinkingEffort(request, context);
		if (!context.model.reasoning || effort === undefined) {
			return request;
		}
		const { reasoning_effort: _effort, ...body } = request;
		if (effort === 'auto') {
			return body;
		}
		return { ...body, enable_thinking: !isThinkingDisabled(effort) };
	}
}
