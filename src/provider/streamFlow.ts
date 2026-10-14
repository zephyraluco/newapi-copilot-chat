/**
 * 消费一次流式响应，并在上游提前断开时决定怎么办。
 *
 * 上游在给出正常收尾信号之前断开连接时，只要还没上报过任何部件就重发整次请求：
 * 用户看到过内容后再补一段完整回答会把两段回答拼在一起。
 *
 * 每次尝试都重建 `StreamTranslator`；重发只发生在「什么都没上报」时，因此不会丢内容。
 * 「能不能重发」的判定是纯函数（`decideStreamFailure`），这里只负责循环与日志。
 *
 * ## 传输边界
 *
 * 本模块消费的是 `ChatStreamSource`——只要求「能吐出一串 chunk」的窄接口，而不是
 * `NewApiClient` 类；换一种传输只需要换一个实现。chunk 形状由 `types.ts` 的
 * `ChatCompletionChunk` 描述，翻译在 `stream.ts`。
 *
 * ## 响应侧的两件收尾事
 *
 * `reportUsagePart` 报用量（Copilot 的「会话信息 → 上下文窗口」靠它显示 token 数），
 * `reportReplayMarker` 留下思考内容（下次请求读回来填 `reasoning_content`）。
 * 两者都不参与回答本身，上报失败不能影响已经流出的内容，因此这里兜住异常只记一条警告。
 */

import * as vscode from 'vscode';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../types';
import { DEFAULTS, USAGE_DATA_MIME_TYPE } from '../consts';
import { HttpError } from '../client/http';
import type { Logger } from '../logger';
import { buildReportedUsage } from '../usage';
import { applyRememberedRepair, planRequestRepair } from './requestRepair';
import type { RepairMemory, RepairPlan } from './requestRepair';
import { createReplayMarkerPart } from './replay';
import { StreamTranslator, decideStreamFailure, extractStreamError } from './stream';
import type { ResponsePart, ResponsePartSink, StreamSummary } from './stream';
import { createThinkingPart, supportsThinkingPart } from './thinking';

/** 单次请求可覆盖的传输选项。 */
export interface StreamRequestOptions {
	/** 是否要求上游返回用量；`undefined` 表示沿用客户端级的设置 */
	readonly includeUsage?: boolean;
}

/** provider 对传输层的要求：把请求变成一串 chunk；只声明这一个方法，便于替换实现。 */
export interface ChatStreamSource {
	streamChatCompletion(
		request: ChatCompletionRequest,
		signal: AbortSignal,
		options?: StreamRequestOptions,
	): AsyncGenerator<ChatCompletionChunk, void, unknown>;
}

/** 一次流式响应的输入。 */
export interface StreamResponseInput {
	readonly source: ChatStreamSource;
	readonly request: ChatCompletionRequest;
	readonly modelId: string;
	readonly includeReasoning: boolean;
	readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	readonly signal: AbortSignal;
	/** 用户是否已取消（取消不重发，也不报错） */
	readonly cancelled: () => boolean;
	readonly logger: Logger;
	/** 本次请求是否带着 `stream_options`（自愈时要去掉它） */
	readonly sendsStreamOptions: boolean;
	/** 该模型所属目标的指纹，用于按会话记住自愈结果 */
	readonly targetKey: string;
	/** 自愈结果记忆（跨请求共享） */
	readonly repairMemory: RepairMemory;
	/** 用户在 `extraBody` 里填的键；它们也是「去掉之后请求仍然成立」的可选字段 */
	readonly optionalFields: readonly string[];
}

/**
 * 把一个中立部件上报给宿主：这是流式翻译与 VS Code 之间的边界，
 * 由这里决定中立部件变成哪种响应部件。
 */
export function reportResponsePart(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	responsePart: ResponsePart,
	logger: Logger,
	modelId: string,
): void {
	switch (responsePart.kind) {
		case 'text':
			progress.report(new vscode.LanguageModelTextPart(responsePart.text));
			return;
		case 'toolCall':
			progress.report(
				new vscode.LanguageModelToolCallPart(responsePart.callId, responsePart.name, responsePart.input),
			);
			return;
		case 'reasoning': {
			const part = createThinkingPart(responsePart.text);
			if (part === undefined) {
				// 翻译层只在探测到宿主提供思考部件时才发出这种部件；这里兜住探测与实际不符的情况
				logger.warn(`${modelId}：无法构造思考部件，思维链按正文回显`);
				progress.report(new vscode.LanguageModelTextPart(responsePart.text));
				return;
			}
			progress.report(part);
		}
	}
}

/** 消费一次流式响应，上游提前断开且用户还没看到内容时重发；返回本次响应摘要。 */
export async function streamResponse(input: StreamResponseInput): Promise<StreamSummary> {
	const { source, modelId, logger, progress } = input;
	// 渲染路径在整次响应里定死
	const thinkingParts = supportsThinkingPart();
	const sink: ResponsePartSink = part => reportResponsePart(progress, part, logger, modelId);

	/** 该会话 + 模型已确认过的不兼容字段：首次尝试前先去掉 */
	const remembered = input.repairMemory.get(input.targetKey, modelId);
	/** 当前要发出去的请求体；自愈会把它换成去掉那个字段的版本 */
	let request = applyRememberedRepair(input.request, remembered);
	/** 站点抱怨过 `stream_options` 后，后续尝试不再带上它 */
	let sendsStreamOptions = remembered?.includeUsage === false ? false : input.sendsStreamOptions;
	/** 已经用过的自愈步骤与轮数 */
	const repairs: string[] = [];
	/** 本次请求生效过的自愈步骤；整次响应成功后才写进记忆 */
	const appliedRepairs: RepairPlan[] = [];
	/** 已用掉的重发次数（自愈不占额度，单独计数） */
	let attempts = 0;

	for (;;) {
		const translator = new StreamTranslator(sink, {
			includeReasoning: input.includeReasoning,
			thinkingParts,
			logger,
			modelId,
		});
		let chunkCount = 0;

		try {
			const stream = source.streamChatCompletion(
				request,
				input.signal,
				sendsStreamOptions ? undefined : { includeUsage: false },
			);
			for await (const chunk of stream) {
				const streamError = extractStreamError(chunk);
				if (streamError !== undefined) {
					throw new Error(`上游返回错误：${streamError}`);
				}
				chunkCount++;
				translator.handle(chunk);
			}

			const summary = translator.flush();
			reportUsagePart(progress, summary, logger);
			// 自愈确实成功才记住，后续请求不必再挨一次 400
			for (const repair of appliedRepairs) {
				input.repairMemory.remember(input.targetKey, modelId, repair);
			}
			logger.debug(
				`响应结束：${chunkCount} 个数据块，正文 ${summary.textLength} 字，` +
				`思考 ${summary.reasoningLength} 字，工具调用 ${summary.toolCallCount} 次，` +
				`结束原因 ${summary.finishReason ?? '未提供'}`,
			);
			return summary;
		} catch (error) {
			// 站点不认某个可选字段（400）时去掉它再试一次；此时还没上报部件，且这不算重发额度。
			const repair = translator.emittedParts === 0
				&& repairs.length < DEFAULTS.requestRepairRounds
				&& !input.cancelled()
				? planRequestRepair({
					status: error instanceof HttpError ? error.status : 0,
					responseBody: error instanceof HttpError ? error.responseBody : undefined,
					apiMessage: error instanceof HttpError ? error.apiMessage : undefined,
					request,
					sendsStreamOptions,
					tried: repairs,
					optionalFields: input.optionalFields,
				})
				: undefined;
			if (repair !== undefined) {
				repairs.push(repair.id);
				appliedRepairs.push(repair);
				request = repair.request;
				if (repair.includeUsage === false) {
					sendsStreamOptions = false;
				}
				logger.warn(
					`${modelId}：${repair.note}（第 ${repairs.length}/${DEFAULTS.requestRepairRounds} 次自愈）`,
				);
				continue;
			}
			if (repairs.length > 0) {
				// 已经改过请求还是被拒：把「改过什么」写下来
				logger.error(`${modelId}：已尝试去掉 ${repairs.join('、')}，请求仍被拒绝`);
			}
			// 诊断用：上游报了输出 token 但没解出任何部件，通常意味着响应格式没被认出来。
			if (translator.emittedParts === 0 && translator.latestUsage?.completion_tokens) {
				logger.warn(
					`上游报告了 ${translator.latestUsage.completion_tokens} 个输出 token，` +
					`但没有任何可展示内容：${modelId}`,
				);
			}

			const action = decideStreamFailure({
				error,
				emittedParts: translator.emittedParts,
				attempt: attempts,
				maxRetries: DEFAULTS.streamTruncationRetries,
				cancelled: input.cancelled(),
			});
			if (action === 'retry') {
				logger.warn(
					`上游连接在回答完成前断开（已收到 ${chunkCount} 个数据块），` +
					`正在重发第 ${attempts + 1}/${DEFAULTS.streamTruncationRetries} 次：${modelId}`,
				);
				attempts++;
				continue;
			}
			if (action === 'fail-truncated') {
				// 内容已流给用户但流没正常收尾：先冲刷已有内容、上报用量，再报错
				const summary = translator.flush({ dropIncompleteToolCalls: true });
				reportUsagePart(progress, summary, logger);
				logger.warn(
					`上游连接在回答完成前断开，已冲刷 ${translator.emittedParts} 个部件后报错：${modelId}`,
				);
			}
			throw error;
		}
	}
}

/**
 * 把用量回传给 Copilot（会话信息里的「上下文窗口」靠它显示 token 数）。
 * 不报时 Copilot 会兜底成 `prompt_tokens: 0`，上下文窗口一直显示 `0/上限`。
 */
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
		const data = new TextEncoder().encode(JSON.stringify(payload));
		progress.report(new vscode.LanguageModelDataPart(data, USAGE_DATA_MIME_TYPE));
	} catch (error) {
		logger.warn('上报用量部件失败（不影响本次回答）', error);
	}
}

/**
 * 把本次的思考内容随响应一起留下（回放标记）：下一次请求会把它变回 `reasoning_content`。
 * 是否需要由适配器链决定（任一适配器声明 `echoReasoningContent` 即为真）。
 */
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
		logger.warn(`${modelId}：思考内容的回放标记上报失败，后续请求将缺少 reasoning_content`, error);
	}
}
