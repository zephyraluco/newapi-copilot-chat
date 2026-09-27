/** GPT-6 Sol/Luna 在 Chat Completions 中调用函数时只接受 reasoning_effort=none。 */
import { DEFAULT_REASONING_EFFORT_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';

const GPT6_CHAT_MODEL = /(?:^|\/)gpt-6-(?:sol|luna)(?:$|[@:])/i;

export class Gpt6ChatAdapter implements ModelAdapter {
	readonly id = 'gpt6-chat';
	readonly description = 'GPT-6 Sol/Luna：适配 Chat Completions 的工具调用与采样参数';
	readonly priority = 100;

	supports(model: ModelConfig): boolean {
		return GPT6_CHAT_MODEL.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const usesTools = (request.tools?.length ?? 0) > 0
			|| request.messages.some(message => message.role === 'tool' || (message.tool_calls?.length ?? 0) > 0);
		if (usesTools) {
			if (request[DEFAULT_REASONING_EFFORT_FIELD] !== 'none') {
				context.logger.debug(`${context.model.id}：Chat Completions 工具调用要求 reasoning_effort=none，已覆盖本次思考强度`);
			}
			request[DEFAULT_REASONING_EFFORT_FIELD] = 'none';
		}

		if (request[DEFAULT_REASONING_EFFORT_FIELD] !== 'none') {
			// 未指定时上游默认 medium，也不接受这些采样参数。
			delete request.temperature;
			delete request.top_p;
			delete request.top_logprobs;
			delete request.logprobs;
		}
		return request;
	}
}
