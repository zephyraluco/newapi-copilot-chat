import * as vscode from 'vscode';
import type { Message, MessagePart } from '../shared/messages';
import { SUPPORTED_IMAGE_MIME_TYPES } from '../shared/consts';
import { isReplayMarkerPart, parseReplayMarker } from './replay';
import { readThinkingText } from './thinking';

/** The only decoder of host content parts used by requests and token estimation. */
export function normalizeMessage(message: vscode.LanguageModelChatRequestMessage): Message {
	return { role: message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant' : 'user',
		name: message.name, parts: normalizeParts(message.content ?? []) };
}
function normalizeParts(parts: readonly unknown[]): MessagePart[] {
	const result: MessagePart[] = [];
	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			result.push({ kind: 'text', text: part.value });
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			result.push({ kind: 'call', callId: part.callId, name: part.name, input: part.input });
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			result.push({ kind: 'result', callId: part.callId, parts: normalizeParts(part.content ?? []) });
		} else if (isReplayMarkerPart(part)) {
			result.push({ kind: 'replay', text: parseReplayMarker(part.data) });
		} else if (part instanceof vscode.LanguageModelDataPart) {
			const mimeType = part.mimeType.toLowerCase();
			if (SUPPORTED_IMAGE_MIME_TYPES.includes(mimeType as typeof SUPPORTED_IMAGE_MIME_TYPES[number])) {
				result.push(part.data.byteLength > 0 ? { kind: 'image', mimeType, data: part.data } : { kind: 'emptyImage' });
			}
		} else {
			const thinking = readThinkingText(part);
			if (thinking !== undefined) { result.push({ kind: 'thinking', text: thinking }); }
			else if (typeof part === 'string') { result.push({ kind: 'text', text: part }); }
			else if (part !== null && typeof part === 'object' && 'value' in part && typeof part.value === 'string') {
				result.push({ kind: 'text', text: part.value });
			}
		}
	}
	return result;
}
