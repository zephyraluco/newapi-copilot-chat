/**
 * DeepSeek 适配器：把请求改写成 DeepSeek 的形态。
 *
 * 所属目录只服务这一个供应商，同目录的 `requestKind.ts` 是它的判据。
 *
 * 与 OpenAI 的差别都在请求体侧（响应侧无需改写）：
 *
 * 1. **思考要显式开关**：`thinking: { type: 'enabled' | 'disabled' }`，不依赖上游对
 *    「没给这个字段」的默认理解。
 * 2. **`reasoning_effort` 只与「开启思考」共存**：关掉思考时一并去掉；模型不具备思考能力时
 *    也不该出现这个字段。
 * 3. **辅助请求不思考**：它们的产出只有一行短文本，思考只会让它们慢几倍。
 * 4. **思考内容要回填历史**：思考态下历史里缺 `reasoning_content` 会被上游**整次拒掉**——
 *    不只是工具调用那几条，每一条助手消息都算，宿主自己插入的（例如读取后台终端输出）
 *    同样算。已知的原文由 provider 用回放标记带回来（见 `provider/replay.ts`）；谁都拿不到
 *    原文的那些（宿主插入的消息、重启后不再带回思考的历史）由这里补占位，
 *    因为「字段缺席」本身就是错误。
 *
 * 行为不随站点变化：New API 是网关，模型后面接的是哪个上游、上游认不认这些字段都无法从
 * 地址上判断。`reasoning_effort` 的取值也不做翻译，档位本来就来自数据表。
 */

import { DEFAULT_REASONING_EFFORT_FIELD, DEFAULT_THINKING_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import { REASONING_ECHO_FIELD, REASONING_PLACEHOLDER } from '../../reasoning';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { classifyRequest, shouldDisableThinking } from './requestKind';
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
 * 思考态下上游要求**每一条**助手消息都带回 `reasoning_content`，缺了就整次请求被拒
 * （`The reasoning_content in the thinking mode must be passed back to the API.`）。
 * 已知的原文由 provider 从回放标记 / 思考部件里回填，这里只补它填不了的那些：
 *
 * - 宿主自己插入的助手消息（读取后台终端输出的工具调用就是这样出现的）；
 * - 会话重启后不再带回思考内容的历史。
 *
 * 这些消息本来就没有思考可回填，写占位是唯一能同时满足「字段在且非空」与「不编造思维链」的做法
 * （见 `REASONING_PLACEHOLDER`）。只在**开启思考**时补：关掉思考的请求不欠上游这个字段，
 * 多送一个反而多一种被拒的可能。
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
