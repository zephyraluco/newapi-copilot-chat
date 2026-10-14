/**
 * Kimi 适配器：把请求改写成 Kimi 的形态。
 *
 * 1. **开关的字段随代际变化**：只有 K2.x 用嵌套的 `thinking.type` 表达开关；K3 与 K2.7-code
 *    不接受它，改用顶层 `reasoning_effort`，因此这两种形态一律透传。
 * 2. **辅助请求不思考**：它们的产出只有一行短文本（见 `../requestKind.ts`）。
 *    只对能真正关掉思考的 K2.x 生效——K3 思考常开，删掉强度只会回落到默认 `max`，反而更慢。
 * 3. **非思考模型清掉强度字段**：留着它只会撞上不认该字段的实现。
 * 4. **思考原文要回填**：Preserved Thinking 要求把历史助手消息里**未修改**的 `reasoning_content`
 *    原样带回，由通用回放机制完成。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { classifyRequest, shouldDisableThinking } from '../requestKind';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** Kimi 适配器。 */
export class KimiAdapter implements ModelAdapter {
	readonly id = 'kimi';
	readonly priority = 90;
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)kimi[-\d]/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const { model } = context;
		if (!model.reasoning) {
			return dropReasoningEffort(request, context, '该模型不具备思考能力');
		}
		// K3 / K2.7-code：思考常开，开关字段不是 `thinking`，强度原样留给上游
		if (usesTopLevelEffort(model)) {
			if (shouldDisableThinking(classifyRequest(request))) {
				// 关不掉：删掉强度只会回落到默认 `max`，比用户选的更慢
				context.logger.debug(`${model.id}：该型号思考始终开启，辅助请求也保留 ${DEFAULT_REASONING_EFFORT_FIELD}`);
			}
			return request;
		}

		const helperRequest = shouldDisableThinking(classifyRequest(request));
		const disable = helperRequest || isThinkingDisabled(readThinkingEffort(request, context));
		const body = disable
			? dropReasoningEffort(request, context, helperRequest ? '辅助请求不需要思考' : '本次不开启思考')
			: request;

		context.logger.debug(
			`${model.id}：thinking=${disable ? 'disabled' : 'enabled'}${helperRequest ? '（辅助请求）' : ''}`,
		);
		return { ...body, thinking: { type: disable ? 'disabled' : 'enabled' } };
	}
}

/**
 * 该 Kimi 模型是否用顶层 `reasoning_effort` 表达思考（而不是嵌套的 `thinking`）。
 *
 * 三条判据，任一成立即成立：
 *
 * - **数据表给出强度档位**：Kimi 官方只在 K3 支持顶层 `reasoning_effort`，K2.x 明确不支持；
 *   数据表能给出一组档位，就说明这个模型走的是 K3 那条路（`kimi-latest` 这类别名因此也能正确分流，
 *   不必去猜版本号）。
 * - **K3 命名**：`kimi-k3` / `k3`，以及带渠道前缀、后缀的形态。
 * - **K2.7-code**：思考常开，只接受 `{"type":"enabled","keep":"all"}`，其余取值直接报错，
 *   所以同样不该由这里写 `thinking`。
 */
function usesTopLevelEffort(model: ModelConfig): boolean {
	return model.reasoningEfforts.length > 0
		|| /(?:^|[/-])k3(?:$|[@:./-])/i.test(model.id)
		|| /(?:^|[/-])k2[.-]7/i.test(model.id);
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
