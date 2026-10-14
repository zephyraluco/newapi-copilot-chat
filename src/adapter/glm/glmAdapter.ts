import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** GLM：开关使用 thinking，具体强度保留 reasoning_effort。 */
export class GlmAdapter implements ModelAdapter {
	readonly id = 'glm';
	readonly priority = 90;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)glm[-\d]/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		if (!context.model.reasoning || !isThinkingDisabled(readThinkingEffort(request, context))) {
			return request;
		}
		const { reasoning_effort: _effort, ...body } = request;
		return { ...body, thinking: { type: 'disabled' } };
	}
}
