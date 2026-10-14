import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** Kimi 的开关使用 thinking；工具轮次的思考原文由通用回放机制保存。 */
export class KimiAdapter implements ModelAdapter {
	readonly id = 'kimi';
	readonly priority = 90;
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)kimi[-\d]/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const effort = readThinkingEffort(request, context);
		if (!context.model.reasoning || effort === undefined || effort === 'auto') {
			return request;
		}
		const { reasoning_effort: _effort, ...body } = request;
		return { ...body, thinking: { type: isThinkingDisabled(effort) ? 'disabled' : 'enabled' } };
	}
}
