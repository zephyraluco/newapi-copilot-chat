/**
 * DeepSeek 适配器：把请求改写成 DeepSeek 的形态；请求种类判据在框架层 `../requestKind.ts`。
 *
 * 1. **思考要显式开关**：`thinking: { type: 'enabled' | 'disabled' }`。
 * 2. **`reasoning_effort` 只与「开启思考」共存**：关掉思考或模型无思考能力时去掉。
 * 3. **辅助请求不思考**：它们的产出只有一行短文本（见 `../requestKind.ts`）。
 * 4. **思考内容要回填历史**：思考态下历史里缺 `reasoning_content` 会被上游整次拒掉，
 *    每一条助手消息都算。已知原文由 provider 用回放标记带回（见 `provider/replay.ts`），
 *    拿不到原文的由这里补占位。
 *
 * 行为不随站点变化：New API 是网关，模型后面接的是哪个上游无法从地址判断。
 * `reasoning_effort` 的取值不做翻译，档位本来就来自数据表。
 */

import { DEFAULT_REASONING_EFFORT_FIELD, DEFAULT_THINKING_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import { REASONING_ECHO_FIELD, REASONING_PLACEHOLDER } from '../../reasoning';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { classifyRequest, shouldDisableThinking } from '../requestKind';
import { isThinkingDisabled, readThinkingEffort } from '../thinkingMode';

/** 这个模型是不是 DeepSeek。 */
export function isDeepSeekModel(model: ModelConfig): boolean {
	return model.meta.vendor?.toLowerCase() === 'deepseek' || /deepseek/i.test(model.id);
}

/** DeepSeek 适配器。 */
export class DeepSeekAdapter implements ModelAdapter {
	readonly id = 'deepseek';
	readonly priority = 100;
	readonly echoReasoningContent = true;

	supports(model: ModelConfig): boolean {
		return isDeepSeekModel(model);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const kind = classifyRequest(request);
		const note = `[${kind}] ${context.model.id}`;

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

		const helperRequest = shouldDisableThinking(kind);
		const disable = helperRequest || isThinkingDisabled(readThinkingEffort(request, context));
		request[DEFAULT_THINKING_FIELD] = { type: disable ? 'disabled' : 'enabled' };
		if (disable) {
			// 关闭思考时强度没有意义：它只与「开启思考」同时成立
			delete request[DEFAULT_REASONING_EFFORT_FIELD];
		} else {
			const padded = padMissingReasoningContent(request);
			if (padded > 0) {
				context.logger.debug(
					`${note}：${padded} 条历史助手消息缺思考内容，已补上占位（思考态下缺这个字段会被上游拒掉）`,
				);
			}
		}

		const reason = helperRequest ? '（辅助请求强制关闭）' : '';
		context.logger.debug(`${note}：thinking=${disable ? 'disabled' : 'enabled'}${reason}`);
		return request;
	}
}

/**
 * 给历史里缺思考内容的助手消息补上占位；返回补了几条。
 *
 * 思考态下上游要求每一条助手消息都带回 `reasoning_content`。已知原文由 provider 从回放标记 /
 * 思考部件回填，这里只补它填不了的那些：宿主插入的助手消息、重启后不再带回思考的历史。
 * 只在**开启思考**时补，关掉思考的请求不欠上游这个字段。
 */
function padMissingReasoningContent(request: ChatCompletionRequest): number {
	let padded = 0;
	for (const message of request.messages) {
		if (message.role !== 'assistant') {
			continue;
		}
		const current = message[REASONING_ECHO_FIELD];
		if (typeof current === 'string' && current.trim().length > 0) {
			continue;
		}
		message[REASONING_ECHO_FIELD] = REASONING_PLACEHOLDER;
		padded++;
	}
	return padded;
}
