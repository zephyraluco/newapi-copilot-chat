import { randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

/** Resolve templates once per provider invocation, sharing one ID across all headers. */
export function resolveRequestHeaders(
	headers: Readonly<Record<string, string>>,
	options: vscode.ProvideLanguageModelChatResponseOptions,
	storageUri?: vscode.Uri,
): Record<string, string> {
	let conversationId: string | undefined;
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
		name,
		value.replaceAll('${conversationId}', () => {
			conversationId ??= resolveConversationId(options, storageUri);
			return conversationId;
		}),
	]));
}

function resolveConversationId(options: vscode.ProvideLanguageModelChatResponseOptions, storageUri?: vscode.Uri): string {
	const upstreamId = options.modelOptions?._conversationId;
	if (typeof upstreamId === 'string' && upstreamId.length > 0) {
		return upstreamId;
	}
	const directory = storageUri?.path.split('/').at(-2);
	if (directory) {
		return `workspace-${directory.replace(/^([0-9a-f]{32})-\d+$/i, '$1')}`;
	}
	const requestId = options.modelOptions?._capturingTokenCorrelationId;
	return `request-${typeof requestId === 'string' && requestId.length > 0 ? requestId : randomUUID()}`;
}
