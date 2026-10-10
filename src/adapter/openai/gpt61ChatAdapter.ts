/** GPT-6.1 Sol 的 Chat Completions 兼容范围：支持工具，且不接受采样参数。 */
import { DEFAULT_REASONING_EFFORT_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';

export class Gpt61ChatAdapter implements ModelAdapter {
	readonly id = 'gpt61-chat';
	readonly description = 'GPT-6.1 Sol：支持工具的 Chat Completions 请求';
	readonly priority = 100;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)gpt-6\.1-sol(?:$|[@:])/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		if (request[DEFAULT_REASONING_EFFORT_FIELD] === 'none'
			|| request[DEFAULT_REASONING_EFFORT_FIELD] === 'minimal') {
			context.logger.warn(`${context.model.id} 不支持该思考强度，已改为 low`);
			request[DEFAULT_REASONING_EFFORT_FIELD] = 'low';
		}
		delete request.temperature;
		delete request.top_p;
		delete request.top_logprobs;
		delete request.logprobs;
		return request;
	}
}
