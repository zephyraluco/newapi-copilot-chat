import type * as vscode from 'vscode';
import { normalizeMessage } from './messageContent';
import { estimateMessageTokens as estimateNormalizedMessage, estimateTextTokens } from '../protocol/tokenizer';

export function estimateMessageTokens(message: vscode.LanguageModelChatRequestMessage, ratio?: number): number {
	return estimateNormalizedMessage(normalizeMessage(message), ratio);
}
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage, ratio?: number): number {
	return typeof text === 'string' ? estimateTextTokens(text, ratio) : estimateMessageTokens(text, ratio);
}
