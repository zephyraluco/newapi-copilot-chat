import type { AdapterRegistry } from './registry';
import type { RequestSettings } from '../utils/settings';
import type { Message } from '../utils/messages';
import { DEFAULT_REASONING_EFFORT_FIELD, PROTECTED_REQUEST_KEYS } from '../utils/consts';
import type { Logger } from '../utils/log';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest, ChatToolDefinition } from '../utils/types';
import { convertMessages } from './messages';

/** Resolve the complete wire request once, before starting network I/O. */
export function prepareChatRequest(input: {
	config: ModelConfig;
	settings: RequestSettings;
	messages: readonly Message[];
	tools?: ChatToolDefinition[];
	reasoningEffort?: string;
	adapters: AdapterRegistry;
	logger: Logger;
}): { request: ChatCompletionRequest; echoReasoningContent: boolean; hasImages: boolean } {
	const { config, settings, messages, adapters, logger } = input;
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
	const tools = config.toolCalling ? input.tools : undefined;
	const request: ChatCompletionRequest = {
		model: config.id,
		messages: converted.messages,
		stream: true,
		max_tokens: config.maxOutputTokens,
		...(tools ? { tools, tool_choice: 'auto' as const } : {}),
	};
	for (const [key, value] of Object.entries(settings.extraBody)) {
		if (!PROTECTED_REQUEST_KEYS.has(key) && value !== undefined) {
			request[key] = value;
		}
	}
	const reasoningEffort = input.reasoningEffort ?? config.defaultReasoningEffort;
	if (config.reasoning && reasoningEffort !== undefined) {
		request[DEFAULT_REASONING_EFFORT_FIELD] = reasoningEffort;
	}
	const transformed = adapters.transformRequest(request, {
		model: config,
		logger,
		reasoningEffort,
	}, resolvedAdapters);
	const hasImages = transformed.messages.some(message => Array.isArray(message.content)
		&& message.content.some(part => part.type === 'image_url'));
	logger.debug(`→ ${config.id}：${transformed.messages.length} 条消息，${tools?.length ?? 0} 个工具`);
	return { request: transformed, echoReasoningContent, hasImages };
}
