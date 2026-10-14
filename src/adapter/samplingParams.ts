/**
 * 采样参数：Chat Completions 里推理/思考模型通常不接受的那几个字段。
 *
 * 两个消费者：`openai/openaiAdapter.ts` 按**协议**（模型名），
 * `capabilityAdapter.ts` 按**数据**（数据表能力位）。
 */

import type { ChatCompletionRequest } from '../types';

/** 采样参数：推理模型会直接拒绝它们，而不是忽略。 */
export const SAMPLING_PARAM_FIELDS = ['temperature', 'top_p', 'logprobs', 'top_logprobs'] as const;

/**
 * 删掉请求体里的采样参数，返回是否真的删掉了：调用方据此决定要不要写日志。
 */
export function stripSamplingParams(request: ChatCompletionRequest): boolean {
	let changed = false;
	for (const key of SAMPLING_PARAM_FIELDS) {
		if (key in request) {
			delete request[key];
			changed = true;
		}
	}
	return changed;
}
