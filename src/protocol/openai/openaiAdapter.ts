/** OpenAI 新一代推理模型的 Chat Completions 兼容处理。 */
import { DEFAULT_REASONING_EFFORT_FIELD } from '../../shared/consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../shared/types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { stripSamplingParams } from '../samplingParams';

/**
 * OpenAI 推理模型的 Chat Completions 兼容处理。
 *
 * 两代推理模型都只认 `max_completion_tokens` 且拒绝采样参数：o 系列（`o1` / `o3` / `o4-mini`）
 * 与 GPT-5 之后（含 Codex、Spark）。模型 ID 可能带渠道前缀、版本或路由后缀，因此只匹配核心名称。
 *
 * 采样参数与输出上限按「这一族都这么做」处理；是否具备思考能力仍按模型自己的能力位判断
 * ——同一个名称下也有不支持思考的形态（例如 `*-chat`、`*-image`）。
 */
const OPENAI_REASONING_MODEL = /(?:^|\/)(?:gpt-(?:5(?:\.[1-9]\d*)?|6)(?:-(?:code|codex|spark))?|gpt-(?:astra|luna|mini|sol|terra)-latest|o[1-9](?:-mini|-pro)?(?:-high)?)(?:$|[@:./-])/i;

export class OpenAIAdapter implements ModelAdapter {
	readonly id = 'openai-reasoning';

	supports(model: ModelConfig): boolean {
		return OPENAI_REASONING_MODEL.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		// 采样参数：数据表已表态的模型交给 `capabilityAdapter`（它还能表达
		// 「关掉思考时才接受」），这里只兜底数据表没覆盖到的模型。
		if (context.model.samplingParams === undefined && stripSamplingParams(request)) {
			context.logger.debug(`${context.model.id} 不接受采样参数，已从 Chat Completions 请求中移除`);
		}

		// 这一族只认 `max_completion_tokens`：把上层的 `max_tokens` 改名。
		if (request.max_tokens !== undefined) {
			request.max_completion_tokens = request.max_tokens;
			delete request.max_tokens;
			context.logger.debug(`${context.model.id} 只接受 max_completion_tokens，已改写输出上限字段`);
		}

		// 名称在这一族里但模型不具备思考能力时，强度字段没有意义
		if (!context.model.reasoning && DEFAULT_REASONING_EFFORT_FIELD in request) {
			delete request[DEFAULT_REASONING_EFFORT_FIELD];
			context.logger.debug(`${context.model.id}：该模型不具备思考能力，已去掉 ${DEFAULT_REASONING_EFFORT_FIELD}`);
		}

		return request;
	}
}
