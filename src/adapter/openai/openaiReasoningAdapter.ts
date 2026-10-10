/** OpenAI 新一代推理模型的 Chat Completions 兼容处理。 */
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';

/**
 * GPT-5 之后（含 Codex）把采样参数与推理请求分开处理：网关通常会直接
 * 拒绝 temperature/top_p/logprobs。模型 ID 可能带渠道前缀、版本或路由后缀，
 * 因此只匹配核心名称并保留后缀边界。
 */
const OPENAI_REASONING_MODEL = /(?:^|\/)(?:gpt-(?:5(?:\.[1-9]\d*)?|6)(?:-(?:code|codex|spark))?|gpt-(?:astra|luna|mini|sol|terra)-latest)(?:$|[@:./-])/i;

export class OpenAIReasoningAdapter implements ModelAdapter {
	readonly id = 'openai-reasoning';
	readonly description = 'OpenAI 新一代推理模型：移除 Chat Completions 不接受的采样参数';
	readonly priority = 80;

	supports(model: ModelConfig): boolean {
		return OPENAI_REASONING_MODEL.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		// 推理模型只接受 reasoning_effort（若用户选择了该项则由上层写入）；
		// 其余采样参数即使是 extraBody 合并进来的，也必须一并移除。
		const removed = ['temperature', 'top_p', 'top_logprobs', 'logprobs'] as const;
		let changed = false;
		for (const key of removed) {
			if (key in request) {
				delete request[key];
				changed = true;
			}
		}
		if (changed) {
			context.logger.debug(`${context.model.id} 不接受采样参数，已从 Chat Completions 请求中移除`);
		}
		return request;
	}
}
