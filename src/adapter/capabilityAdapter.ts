/**
 * 数据驱动的适配器：把 `ModelConfig` 里的**能力位**变成请求改写。
 *
 * 与其它适配器的分工：别的适配器按**协议**（模型名判据）改写，本适配器按**数据**（能力位）改写。
 *
 * `supports` 恒为 `true`：它没有自己的适用模型，改不改写完全由能力位决定。
 * 优先级低于供应商适配器，因此它看到的是那些适配器改写之后的请求。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../consts';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest } from '../types';
import type { AdapterContext, ModelAdapter } from './adapter';
import { stripSamplingParams } from './samplingParams';
import { isRecord } from '../json';
import { isThinkingDisabled } from './thinkingMode';

export class ModelCapabilityAdapter implements ModelAdapter {
	readonly id = 'model-capabilities';
	readonly priority = 50;

	supports(): boolean {
		return true;
	}

	transformRequest(request: ChatCompletionRequest, context: AdapterContext): ChatCompletionRequest {
		const { model } = context;

		if (!acceptsSamplingParams(model, request) && stripSamplingParams(request)) {
			context.logger.debug(
				`${model.id}：数据表标注当前形态不接受采样参数，已从 Chat Completions 请求中移除`,
			);
		}

		return request;
	}
}

/**
 * 这个模型在当前请求形态下接受采样参数吗。
 *
 * `undefined` 表示始终接受：数据表没表态时不动请求。
 */
function acceptsSamplingParams(model: ModelConfig, request: ChatCompletionRequest): boolean {
	if (model.samplingParams === 'never') {
		return false;
	}
	if (model.samplingParams === 'when-thinking-off') {
		return isThinkingDisabled(request[DEFAULT_REASONING_EFFORT_FIELD])
			|| request.enable_thinking === false
			|| (isRecord(request.thinking) && request.thinking.type === 'disabled');
	}
	return true;
}
