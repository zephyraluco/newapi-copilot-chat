/**
 * DeepSeek 请求参数：自定义网关保留用户所选的思考强度。
 *
 * 1. **思考要显式开关**：`thinking: { type: 'enabled' | 'disabled' }`。
 * 2. **`reasoning_effort` 只与「开启思考」共存**：关掉思考或模型无思考能力时去掉。
 * 3. **思考内容回填历史**：消息转换层恢复原文，缺失时使用空字符串。
 *
 * 行为不随站点变化：New API 是网关，模型后面接的是哪个上游无法从地址判断。
 * `reasoning_effort` 的取值不做翻译，档位本来就来自数据表。
 */

import { DEFAULT_REASONING_EFFORT_FIELD, DEFAULT_THINKING_FIELD } from '../../shared/consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../shared/types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** 这个模型是不是 DeepSeek。 */
export function isDeepSeekModel(model: ModelConfig): boolean {
	return model.meta.vendor?.toLowerCase() === 'deepseek' || /deepseek/i.test(model.id);
}

/** DeepSeek 适配器。 */
export class DeepSeekAdapter implements ModelAdapter {
	readonly id = 'deepseek';
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return isDeepSeekModel(model);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const note = context.model.id;

		if (!context.model.reasoning) {
			// 没有思考可开关：留着强度字段只会撞上不认它的实现
			if (DEFAULT_REASONING_EFFORT_FIELD in request) {
				delete request[DEFAULT_REASONING_EFFORT_FIELD];
				context.logger.debug(
					`${note}：该模型不具备思考能力，已去掉 ${DEFAULT_REASONING_EFFORT_FIELD}`,
				);
			}
			return request;
		}

		const disable = isThinkingDisabled(readThinkingEffort(request, context));
		request[DEFAULT_THINKING_FIELD] = { type: disable ? 'disabled' : 'enabled' };
		if (disable) {
			// 关闭思考时强度没有意义：它只与「开启思考」同时成立
			delete request[DEFAULT_REASONING_EFFORT_FIELD];
		}

		context.logger.debug(`${note}：thinking=${disable ? 'disabled' : 'enabled'}`);
		return request;
	}
}
