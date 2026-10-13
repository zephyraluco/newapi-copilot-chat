/** OpenAI 新一代推理模型的 Chat Completions 兼容处理。 */
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { stripSamplingParams } from '../samplingParams';

/**
 * GPT-5 之后（含 Codex）把采样参数与推理请求分开处理：网关通常会直接
 * 拒绝 temperature/top_p/logprobs。模型 ID 可能带渠道前缀、版本或路由后缀，
 * 因此只匹配核心名称并保留后缀边界。
 */
const OPENAI_REASONING_MODEL = /(?:^|\/)(?:gpt-(?:5(?:\.[1-9]\d*)?|6)(?:-(?:code|codex|spark))?|gpt-(?:astra|luna|mini|sol|terra)-latest)(?:$|[@:./-])/i;

export class OpenAIReasoningAdapter implements ModelAdapter {
	readonly id = 'openai-reasoning';
	readonly description = 'OpenAI 新一代推理模型：移除采样参数、改写输出上限字段名';
	readonly priority = 80;

	supports(model: ModelConfig): boolean {
		return OPENAI_REASONING_MODEL.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		// 采样参数：数据表**已经表态**的模型交给 `capabilityAdapter`（它还能表达
		// 「关掉思考时才接受」这种更细的形态），这里只兜底数据表没覆盖到的模型。
		if (context.model.samplingParams === undefined && stripSamplingParams(request)) {
			context.logger.debug(`${context.model.id} 不接受采样参数，已从 Chat Completions 请求中移除`);
		}

		// 这一族只认 `max_completion_tokens`：上层默认写的是 `max_tokens`，这里改名。
		if (request.max_tokens !== undefined) {
			request.max_completion_tokens = request.max_tokens;
			delete request.max_tokens;
			context.logger.debug(`${context.model.id} 只接受 max_completion_tokens，已改写输出上限字段`);
		}

		return request;
	}
}
