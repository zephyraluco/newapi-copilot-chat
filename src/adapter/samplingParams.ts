/**
 * 采样参数：Chat Completions 里推理/思考模型通常不接受的那几个字段。
 *
 * 抽成独立模块是因为它有两个消费者，判断依据完全不同：
 *
 * - `openai/openaiReasoningAdapter.ts`：**按协议**——模型名属于新一代推理模型就移除；
 * - `capabilityAdapter.ts`：**按数据**——数据表说这个模型不接受才移除。
 *
 * 两份实现各写一遍就会随时间漂移：新加一个字段时只改了一处，另一处就悄悄漏掉。
 */

import type { ChatCompletionRequest } from '../types';

/** 采样参数：推理模型会直接拒绝它们，而不是忽略。 */
export const SAMPLING_PARAM_FIELDS = ['temperature', 'top_p', 'logprobs', 'top_logprobs'] as const;

/**
 * 删掉请求体里的采样参数。
 *
 * 返回是否真的删掉了：调用方据此决定要不要写日志（「什么都没删」不该刷屏）。
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
