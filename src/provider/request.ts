import type * as vscode from 'vscode';
import type { AdapterRegistry } from '../adapter/registry';
import type { NewApiSettings } from '../config';
import { DEFAULT_REASONING_EFFORT_FIELD, PROTECTED_REQUEST_KEYS } from '../consts';
import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest } from '../types';
import { convertMessages, convertTools } from './messages';
import { selectReasoningEffort } from './modelConfiguration';

/** Resolve the complete wire request once, before starting network I/O. */
export async function prepareChatRequest(input: {
	config: ModelConfig;
	settings: NewApiSettings;
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
	adapters: AdapterRegistry;
	logger: Logger;
}): Promise<{ request: ChatCompletionRequest; echoReasoningContent: boolean; hasImages: boolean }> {
	const { config, settings, messages, options, adapters, logger } = input;
	const resolvedAdapters = adapters.resolveAll(config);
	const echoReasoningContent = config.reasoning
		&& resolvedAdapters.some(adapter => adapter.echoReasoningContent === true);
	const converted = convertMessages(messages, logger, { echoReasoningContent, nativeImageInput: config.imageInput });
	for (const warning of converted.warnings) {
		logger.warn(warning);
	}
	if (converted.messages.length === 0) {
		throw new Error('本次请求没有任何可发送的内容');
	}
	const effort = selectReasoningEffort(options, config);
	if (effort.ignored !== undefined) {
		logger.warn(`${config.id}：${effort.ignored}`);
	}
	const tools = config.toolCalling ? convertTools(options.tools, logger) : undefined;
	const request: ChatCompletionRequest = {
		model: config.id,
		messages: converted.messages,
		stream: true,
		max_tokens: config.maxOutputTokens,
		...(tools ? { tools, tool_choice: 'auto' as const } : {}),
		...(settings.request.temperature !== undefined ? { temperature: settings.request.temperature } : {}),
		...(settings.request.topP !== undefined ? { top_p: settings.request.topP } : {}),
	};
	for (const [key, value] of Object.entries(settings.request.extraBody)) {
		if (!PROTECTED_REQUEST_KEYS.has(key) && value !== undefined) {
			request[key] = value;
		}
	}
	const reasoningEffort = effort.effort ?? config.defaultReasoningEffort;
	if (config.reasoning && reasoningEffort !== undefined) {
		request[DEFAULT_REASONING_EFFORT_FIELD] = reasoningEffort;
	}
	const transformed = await adapters.transformRequest(request, {
		model: config,
		logger,
		reasoningEffort,
	}, resolvedAdapters);
	const hasImages = transformed.messages.some(message => Array.isArray(message.content)
		&& message.content.some(part => part.type === 'image_url'));
	logger.debug(`→ ${config.id}：${transformed.messages.length} 条消息，${tools?.length ?? 0} 个工具`);
	return { request: transformed, echoReasoningContent, hasImages };
}
