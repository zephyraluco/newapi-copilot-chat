import type { Message, MessagePart } from '../utils/messages';
import type { ChatContentPart, ChatRequestMessage, ChatToolDefinition } from '../utils/types';
import type { Logger } from '../utils/log';
import { safeJsonStringify } from '../utils/json';
import { splitCjkChars, type RequestTextMeasure } from './tokenizer';
import { REASONING_ECHO_FIELD } from './reasoning';

export interface ConvertMessagesOptions { readonly nativeImageInput?: boolean; readonly echoReasoningContent?: boolean }
export function convertMessages(messages: readonly Message[], logger: Logger, options: ConvertMessagesOptions = {}) {
	const result: ChatRequestMessage[] = [];
	const warnings: string[] = [];
	let skipped = 0;
	const content = (parts: readonly MessagePart[]): ChatContentPart[] => parts.flatMap<ChatContentPart>(part => {
		if (part.kind === 'text') { return [{ type: 'text' as const, text: part.text }]; }
		if (options.nativeImageInput !== false && part.kind === 'image') {
			return [{ type: 'image_url' as const, image_url: {
				url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`,
			} }];
		}
		if (options.nativeImageInput !== false && part.kind === 'emptyImage') { warnings.push('收到空的图片数据部件，已跳过'); }
		return [];
	});
	for (const message of messages) {
		const name = message.name?.trim();
		const validName = name && /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : undefined;
		const parts = content(message.parts);
		const text = parts.filter(part => part.type === 'text').map(part => part.text).join('');
		const hasImages = parts.some(part => part.type === 'image_url');
		if (message.role === 'assistant') {
			const calls = message.parts.filter(part => part.kind === 'call').map(part => ({
				id: part.callId, type: 'function' as const,
				function: { name: part.name, arguments: safeJsonStringify(part.input) ?? '{}' },
			}));
			if (!text && !hasImages && calls.length === 0) { skipped++; continue; }
			const replay = message.parts.find(part => part.kind === 'replay' && part.text);
			const reasoning = replay?.kind === 'replay' ? replay.text ?? ''
				: message.parts.filter(part => part.kind === 'thinking').map(part => part.text).join('');
			result.push({ role: 'assistant',
				content: hasImages ? parts : text || (options.echoReasoningContent ? '' : null),
				...(calls.length ? { tool_calls: calls } : {}),
				...(validName && validName !== 'system' ? { name: validName } : {}),
				...(options.echoReasoningContent ? { [REASONING_ECHO_FIELD]: reasoning } : {}),
			});
			continue;
		}
		const results = message.parts.filter(part => part.kind === 'result');
		for (const tool of results) {
			const toolParts = content(tool.parts);
			const toolText = toolParts.filter(part => part.type === 'text').map(part => part.text).join('\n');
			result.push({ role: 'tool', tool_call_id: tool.callId,
				content: toolParts.some(part => part.type === 'image_url') ? toolParts : toolText || '(工具没有返回内容)' });
		}
		if (!text && !hasImages) { if (!results.length) { skipped++; } continue; }
		const role = validName === 'system' ? 'system' : 'user';
		result.push({ role, content: role === 'system' ? text : hasImages ? parts : text,
			...(role === 'user' && validName ? { name: validName } : {}) });
	}
	if (skipped) { logger.debug(`转换消息时跳过了 ${skipped} 条空消息`); }
	return { messages: result, skipped, warnings };
}

/** Measure the exact wire text, excluding base64 image bytes. */
export function measureRequestText(messages: readonly ChatRequestMessage[], tools: readonly ChatToolDefinition[] | undefined): RequestTextMeasure {
	const measure = { cjkChars: 0, otherChars: 0 };
	const add = (text: string | undefined) => {
		const count = splitCjkChars(text ?? '');
		measure.cjkChars += count.cjkChars; measure.otherChars += count.otherChars;
	};
	for (const message of messages) {
		if (typeof message.content === 'string') { add(message.content); }
		else { for (const part of message.content ?? []) { if (part.type === 'text') { add(part.text); } } }
		add(message.reasoning_content);
		for (const call of message.tool_calls ?? []) { add(call.function.name); add(call.function.arguments); }
	}
	for (const tool of tools ?? []) {
		add(tool.function.name); add(tool.function.description); add(safeJsonStringify(tool.function.parameters));
	}
	return measure;
}
