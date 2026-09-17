/**
 * DeepSeek 适配器：把请求改写成 DeepSeek 的形态。
 *
 * 所属目录 `adapter/deepseek/` 只服务这一个供应商，同目录的 `requestKind.ts` 是它的判据；
 * 其他供应商各自建同名目录，互不引用。
 *
 * 与 OpenAI 的差别（都在请求体侧，响应侧不需要改写）：
 *
 * 1. **思考要显式开关**：`thinking: { type: 'enabled' | 'disabled' }`。思考模型一律显式写上，
 *    不依赖上游对「没给这个字段」的默认理解。
 * 2. **`reasoning_effort` 只与「开启思考」共存**：关掉思考时把它一并去掉，否则就是一个
 *    自相矛盾的请求；模型不具备思考能力时也不该出现这个字段。
 * 3. **辅助请求不思考**：起标题、写提交信息、生成分支名这类请求的产出只有一行短文本，
 *    思考只会让它们慢几倍（类型清单见 `requestKind.ts`）。
 *
 * 行为**不随站点变化**：New API 是网关，同一个模型后面接的是哪一个上游、上游认不认这些字段
 * 都无法从地址上判断，因此不对地址做任何区分。
 *
 * `reasoning_effort` 的取值不做翻译：模型选择器里的档位来自数据表，本来就该是站点文档里的写法。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../../consts';
import type { ModelConfig } from '../../models/modelConfig';
import type { ChatCompletionRequest } from '../../types';
import type { AdapterContext, ModelAdapter } from '../adapter';
import { classifyRequest, shouldDisableThinking } from './requestKind';

/** 思考开关在请求体里的字段名（DeepSeek 官方）。 */
export const THINKING_FIELD = 'thinking';

/** 模型 ID 里出现这个片段就按 DeepSeek 处理（`deepseek-chat` / `deepseek-ai/DeepSeek-V4` …）。 */
const DEEPSEEK_ID_PATTERN = /deepseek/i;

/** 这个模型是不是 DeepSeek。 */
export function isDeepSeekModel(model: ModelConfig): boolean {
	if (model.meta.vendor?.toLowerCase() === 'deepseek') {
		return true;
	}
	return DEEPSEEK_ID_PATTERN.test(model.id);
}

/** DeepSeek 适配器。 */
export class DeepSeekAdapter implements ModelAdapter {
	readonly id = 'deepseek';
	readonly description = 'DeepSeek：显式写入思考开关，辅助请求关闭思考';
	readonly priority = 100;

	supports(model: ModelConfig): boolean {
		return isDeepSeekModel(model);
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const kind = classifyRequest({ messages: request.messages, tools: request.tools });
		const note = `[${kind}] ${context.model.id}`;

		if (!context.model.reasoning) {
			// 没有思考可开关：留着强度字段只会撞上不认它的实现
			if (removeField(request, DEFAULT_REASONING_EFFORT_FIELD)) {
				context.logger.debug(
					`${note}：该模型不具备思考能力，已去掉 ${DEFAULT_REASONING_EFFORT_FIELD}`,
				);
			}
			return request;
		}

		const disable = shouldDisableThinking(kind);
		request[THINKING_FIELD] = { type: disable ? 'disabled' : 'enabled' };
		if (disable) {
			// 关闭思考时强度没有意义：它只与「开启思考」同时成立
			removeField(request, DEFAULT_REASONING_EFFORT_FIELD);
		}

		const reason = disable ? '（辅助请求强制关闭）' : '';
		context.logger.debug(`${note}：thinking=${disable ? 'disabled' : 'enabled'}${reason}`);
		return request;
	}
}

/** 删除请求体里的一个字段；返回它原本是否存在。 */
function removeField(request: ChatCompletionRequest, key: string): boolean {
	const fields = request as Record<string, unknown>;
	if (!(key in fields)) {
		return false;
	}
	delete fields[key];
	return true;
}
