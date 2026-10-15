/** Chat Completions 思考选择的共享语义；具体字段形状仍由厂商适配器决定。 */
import { DEFAULT_REASONING_EFFORT_FIELD } from '../shared/consts';
import type { ChatCompletionRequest } from '../shared/types';
import type { AdapterContext } from './adapter';

export function readThinkingEffort(request: ChatCompletionRequest, context: AdapterContext): string | undefined {
	const value = request[DEFAULT_REASONING_EFFORT_FIELD] ?? context.reasoningEffort;
	return typeof value === 'string' ? value : undefined;
}

export function isThinkingDisabled(effort: unknown): boolean {
	return effort === 'none' || effort === 'off';
}
