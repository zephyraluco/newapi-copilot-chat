import type * as vscode from 'vscode';
import type { AdapterRegistry } from '../protocol/registry';
import type { NewApiSettings } from '../utils/settings';
import type { Logger } from '../utils/log';
import type { ModelConfig } from '../models/modelConfig';
import { prepareChatRequest as prepareNormalizedRequest } from '../protocol/request';
import { selectReasoningEffort } from '../protocol/modelConfiguration';
import { normalizeMessage } from './messageContent';
import { convertTools } from './messages';

/** Decode host options and messages, then hand off to the pure protocol pipeline. */
export function prepareChatRequest(input: {
	config: ModelConfig; settings: NewApiSettings; logger: Logger; adapters: AdapterRegistry;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
}) {
	const effort = selectReasoningEffort(input.options, input.config);
	if (effort.ignored) { input.logger.warn(`${input.config.id}：${effort.ignored}`); }
	return prepareNormalizedRequest({ ...input, settings: input.settings.request,
		messages: input.messages.map(normalizeMessage),
		tools: input.config.toolCalling ? convertTools(input.options.tools, input.logger) : undefined,
		reasoningEffort: effort.effort });
}
