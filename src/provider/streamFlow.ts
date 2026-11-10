import * as vscode from 'vscode';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../utils/types';
import { USAGE_DATA_MIME_TYPE } from '../utils/consts';
import type { Logger } from '../utils/log';
import { buildReportedUsage } from '../protocol/usage';
import { createReplayMarkerPart } from './replay';
import { StreamTranslator, extractStreamError } from '../protocol/stream';
import type { ResponsePart, StreamSummary } from '../protocol/stream';
import { createReasoningDonePart, createThinkingPart, supportsThinkingPart } from './thinking';

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

/**
 * 逐个上报中立部件，并把同一段思考的分片串成一个思维链块。
 *
 * 宿主的思考部件按 `id` 归组：没有 `id` 时每个部件各成一块，而流式思维链每片只有几个字，
 * 界面上就会碎成一串「Thought for Ns」。所以同一段思考共用一个 `id`；思考结束（转正文、
 * 发工具调用、流结束）时再补一个 `vscode_reasoning_done` 标记让宿主收口。
 */
export class ResponsePartReporter {
	private reasoningSegment = 0;
	private reasoningId: string | undefined;
	private reasoningOpen = false;

	constructor(
		private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		private readonly logger: Logger,
		private readonly modelId: string,
	) { }

	/** 上报一个中立部件。 */
	report(part: ResponsePart): void {
		if (part.kind === 'reasoning') {
			this.reportReasoning(part.text);
			return;
		}
		// 正文或工具调用出现，说明这一段思考已经结束
		this.closeReasoning();
		if (part.kind === 'text') {
			this.progress.report(new vscode.LanguageModelTextPart(part.text));
			return;
		}
		this.progress.report(new vscode.LanguageModelToolCallPart(part.callId, part.name, part.input));
	}

	/** 流结束收口：思考若还开着，补结束标记，免得下一轮内容被并进同一块。 */
	finish(): void {
		this.closeReasoning();
	}

	private reportReasoning(text: string): void {
		if (this.reasoningId === undefined) {
			// 同一次响应内各段编号，响应之间用随机后缀隔开，避免并行请求撞号
			this.reasoningSegment++;
			this.reasoningId = `reasoning-${Date.now().toString(36)}-${randomSuffix()}-${this.reasoningSegment}`;
		}
		const thinking = createThinkingPart(text, this.reasoningId);
		if (thinking === undefined) {
			this.logger.warn(`${this.modelId}：宿主不支持思考部件`);
			return;
		}
		this.reasoningOpen = true;
		this.progress.report(thinking);
	}

	private closeReasoning(): void {
		if (!this.reasoningOpen) {
			return;
		}
		this.reasoningOpen = false;
		this.reasoningId = undefined;
		const done = createReasoningDonePart();
		if (done !== undefined) {
			this.progress.report(done);
		}
	}
}

/** 六位随机后缀，只求并行请求的思考 id 不重复。 */
function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

/** One provider invocation corresponds to exactly one upstream request. */
export async function streamResponse(input: StreamResponseInput): Promise<StreamSummary> {
	const { source, progress, logger, modelId } = input;
	const reporter = new ResponsePartReporter(progress, logger, modelId);
	const translator = new StreamTranslator(part => reporter.report(part), {
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
	reporter.finish();
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
