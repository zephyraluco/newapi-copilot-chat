import * as vscode from 'vscode';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../types';
import { USAGE_DATA_MIME_TYPE } from '../consts';
import type { Logger } from '../logger';
import { buildReportedUsage } from '../usage';
import { createReplayMarkerPart } from './replay';
import { StreamTranslator, extractStreamError } from './stream';
import type { ResponsePart, StreamSummary } from './stream';
import { createThinkingPart, supportsThinkingPart } from './thinking';

export interface StreamRequestOptions {
	readonly headers?: Readonly<Record<string, string>>;
}

export interface ChatStreamSource {
	streamChatCompletion(
		request: ChatCompletionRequest,
		signal: AbortSignal,
		options?: StreamRequestOptions,
	): AsyncGenerator<ChatCompletionChunk, void, unknown>;
}

export interface StreamResponseInput {
	readonly source: ChatStreamSource;
	readonly request: ChatCompletionRequest;
	readonly modelId: string;
	readonly includeReasoning: boolean;
	readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	readonly signal: AbortSignal;
	readonly cancelled: () => boolean;
	readonly logger: Logger;
	readonly headers?: Readonly<Record<string, string>>;
}

export function reportResponsePart(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	part: ResponsePart,
	logger: Logger,
	modelId: string,
): void {
	switch (part.kind) {
		case 'text':
			progress.report(new vscode.LanguageModelTextPart(part.text));
			return;
		case 'toolCall':
			progress.report(new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input));
			return;
		case 'reasoning': {
			const thinking = createThinkingPart(part.text);
			if (thinking === undefined) {
				logger.warn(`${modelId}：宿主不支持思考部件`);
				return;
			}
			progress.report(thinking);
		}
	}
}

/** One provider invocation corresponds to exactly one upstream request. */
export async function streamResponse(input: StreamResponseInput): Promise<StreamSummary> {
	const { source, progress, logger, modelId } = input;
	const translator = new StreamTranslator(part => reportResponsePart(progress, part, logger, modelId), {
		includeReasoning: input.includeReasoning,
		thinkingParts: supportsThinkingPart(),
		logger,
		modelId,
	});
	for await (const chunk of source.streamChatCompletion(input.request, input.signal, { headers: input.headers })) {
		if (input.cancelled() || input.signal.aborted) {
			throw input.signal.reason ?? new DOMException('Request cancelled', 'AbortError');
		}
		const error = extractStreamError(chunk);
		if (error !== undefined) {
			throw new Error(`上游返回错误：${error}`);
		}
		translator.handle(chunk);
	}
	if (input.cancelled() || input.signal.aborted) {
		throw input.signal.reason ?? new DOMException('Request cancelled', 'AbortError');
	}
	const summary = translator.flush();
	reportUsagePart(progress, summary, logger);
	return summary;
}

export function reportUsagePart(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	summary: StreamSummary,
	logger: Logger,
): void {
	const payload = buildReportedUsage(summary.usage);
	if (payload === undefined) {
		return;
	}
	try {
		progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(payload)), USAGE_DATA_MIME_TYPE));
	} catch (error) {
		logger.warn('上报用量部件失败（不影响本次回答）', error);
	}
}

export function reportReplayMarker(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	summary: StreamSummary,
	echoReasoningContent: boolean,
	modelId: string,
	logger: Logger,
): void {
	if (!echoReasoningContent || summary.reasoningText.length === 0) {
		return;
	}
	try {
		progress.report(createReplayMarkerPart(summary.reasoningText));
	} catch (error) {
		logger.warn(`${modelId}：思考内容的回放标记上报失败`, error);
	}
}
