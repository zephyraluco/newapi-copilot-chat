/**
 * Qwen 适配器：把请求改写成 Qwen 的形态。
 *
 * 1. **只有二值开关的型号转成 `enable_thinking`**：`reasoning_effort` 不是 Qwen 的开关字段，
 *    因此在「数据表没给出强度档位」的型号上把它翻译成布尔开关，然后删掉原字段。
 * 2. **给出强度档位的型号保留 `reasoning_effort`**：数据表能列档位说明上游本身接受它
 *    （Qwen 官方文档也说明部分型号用 `reasoning_effort` 调强度），此时不做翻译。
 * 3. **`auto` 不新增开关**：保留「让上游自己决定」的语义。
 * 4. **非思考模型清掉强度字段**，辅助请求则无须改写——Qwen 没有可靠的关闭思考手段，
 *    把强度改写成「关闭」只会发一个上游不认的布尔值。
 * 5. **思考原文要回填**：与 DeepSeek 同形的回放契约，由通用回放机制完成。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../../shared/consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../shared/types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** Qwen 适配器。 */
export class QwenAdapter implements ModelAdapter {
	readonly id = 'qwen';
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)qwen(?:\d|[-/])/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const { model } = context;
		if (!model.reasoning) {
			// 没有思考可开关：留着强度字段只会撞上不认它的实现
			return dropReasoningEffort(request, context, '该模型不具备思考能力');
		}
		// 上游自己接受强度档位，`enable_thinking` 不是更具体的表达，翻译反而丢信息
		if (model.reasoningEfforts.length > 0) {
			return request;
		}

		const effort = readThinkingEffort(request, context);
		if (effort === undefined) {
			return request;
		}
		const body = dropReasoningEffort(request, context, 'Qwen 用 enable_thinking 表达开关');
		if (effort === 'auto') {
			return body;
		}
		return { ...body, enable_thinking: !isThinkingDisabled(effort) };
	}
}

/** 去掉请求体里的思考强度；字段本来不在时原样返回，不留下没有信息量的日志。 */
function dropReasoningEffort(
	request: ChatCompletionRequest,
	context: AdapterContext,
	reason: string,
): ChatCompletionRequest {
	if (!(DEFAULT_REASONING_EFFORT_FIELD in request)) {
		return request;
	}
	const { [DEFAULT_REASONING_EFFORT_FIELD]: _dropped, ...body } = request;
	context.logger.debug(`${context.model.id}：已去掉 ${DEFAULT_REASONING_EFFORT_FIELD}（${reason}）`);
	return body;
}
