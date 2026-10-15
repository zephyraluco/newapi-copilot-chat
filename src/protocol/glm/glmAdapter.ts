/**
 * GLM 适配器：把请求改写成 GLM 的形态。
 *
 * 1. **开关显式写入**：`thinking: { type: 'enabled' | 'disabled' }`，不依赖上游对「没给这个字段」
 *    的默认理解；`enabled` 在自动决策的型号上表示动态思考、在强制思考的型号上表示始终思考，两边都成立。
 * 2. **强制思考的型号不写 `disabled`**：5.3 系列与 4.7 传 `disabled` 会直接失败，关不了就不关。
 * 3. **辅助请求不思考**：它们的产出只有一行短文本（见 `../requestKind.ts`）。
 * 4. **思考原文要回填**：Preserved Thinking 要求把历史助手消息里**未修改**的 `reasoning_content`
 *    原样带回；字段名与通用回放一致，因此打开 `echoReasoningContent`。
 * 5. **`reasoning_effort` 只留合法档位**：合法值只有 `max` / `high` / `low`，`none` / `off` 从来不是；
 *    关掉思考时它也没有意义。
 *
 * 行为不随站点变化：New API 是网关，模型后面接的是哪个上游无法从地址判断。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../../shared/consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../shared/types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { classifyRequest, shouldDisableThinking } from '../requestKind';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** GLM 适配器。 */
export class GlmAdapter implements ModelAdapter {
	readonly id = 'glm';
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return /(?:^|\/)glm[-\d]/i.test(model.id);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const { model } = context;
		if (!model.reasoning) {
			// 没有思考可开关：留着强度字段只会撞上不认它的实现
			return dropReasoningEffort(request, context, '该模型不具备思考能力');
		}

		const helperRequest = shouldDisableThinking(classifyRequest(request));
		const invalidEffort = isThinkingDisabled(readThinkingEffort(request, context));
		// 强制思考的型号关不掉：传输会失败，因此关不了就不关
		const disable = !forcedThinking(model.id) && (helperRequest || invalidEffort);

		// 关掉思考时强度没有意义；`none` / `off` 也从不是 GLM 的合法档位
		const body = disable || invalidEffort
			? dropReasoningEffort(request, context, disable ? '本次不开启思考' : '不是 GLM 的合法档位')
			: request;

		const forced = !disable && forcedThinking(model.id);
		const reason = forced
			? (helperRequest ? '（请求关闭，但该型号强制思考）' : '（该型号强制思考）')
			: (helperRequest ? '（辅助请求）' : '');
		context.logger.debug(`${model.id}：thinking=${disable ? 'disabled' : 'enabled'}${reason}`);
		return { ...body, thinking: { type: disable ? 'disabled' : 'enabled' } };
	}
}

/**
 * 该 GLM 型号是否强制思考（无法关闭）。
 *
 * 5.3 系列与 4.7 是「始终思考」的形态：`thinking.type` 只接受 `enabled`，传 `disabled` 会直接失败。
 * 这里只按官方点名的代际判断，不从版本号臆测其它型号。
 */
function forcedThinking(id: string): boolean {
	return /(?:^|[/-])glm-(?:5\.3|4\.7)/i.test(id);
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
