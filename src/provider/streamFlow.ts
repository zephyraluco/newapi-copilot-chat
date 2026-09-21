/**
 * 消费一次流式响应，并在上游提前断开时决定怎么办。
 *
 * 上游在给出正常收尾信号之前断开连接（网关掉线、代理重置）时，只要**还没有向上报过任何部件**
 * 就重发整次请求。这个门很关键：provider 抛错时 VS Code 会先冲刷已经流出的部件再显示错误，
 * 一旦用户看到过内容，再补一段完整回答就会把两段回答拼在一起。
 *
 * 每次尝试都重建 `StreamTranslator`——重发只发生在「什么都没上报」时，
 * 因此丢弃上一次的累积不会丢内容。
 *
 * 「能不能重发」的判定本身是纯函数（`decideStreamFailure`），这里只负责循环与日志。
 *
 * ## 传输边界
 *
 * 本模块消费的是 `ChatStreamSource`——一个只要求「能吐出一串 chunk」的窄接口，而不是
 * `NewApiClient` 类。因此换一种传输（别的端点形态、别的 chunk 形状）只需要换一个实现：
 * 这个接口就是传输维度的锚点，`chatProvider` 不必知道请求是怎么发出去的。
 * chunk 形状由 `types.ts` 的 `ChatCompletionChunk` 描述，翻译在 `stream.ts`。
 */

import * as vscode from 'vscode';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../types';
import { DEFAULTS } from '../consts';
import { HttpError } from '../client/http';
import type { Logger } from '../logger';
import type { ResponsePart, ResponsePartSink } from './parts';
import { planRequestRepair } from './requestRepair';
import { reportUsagePart } from './responseParts';
import { StreamTranslator, decideStreamFailure, extractStreamError } from './stream';
import type { StreamSummary } from './stream';
import { createThinkingPart, supportsThinkingPart } from './thinking';

/** 单次请求可覆盖的传输选项。 */
export interface StreamRequestOptions {
	/** 是否要求上游返回用量；`undefined` 表示沿用客户端级的设置 */
	readonly includeUsage?: boolean;
}

/**
 * provider 对传输层的要求：把请求变成一串 chunk。
 *
 * 刻意只声明这一个方法（而不是整个客户端）：这样重发门可以被喂一个按脚本产出的假实现，
 * 也让「换成另一种传输」成为替换实现而不是改动调用方。
 */
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
}

/**
 * 把一个中立部件上报给宿主。
 *
 * **这里是流式翻译与 VS Code 之间的唯一边界**：`stream.ts` 只产出中立部件，
 * 由这一处决定它们变成哪种响应部件（`LanguageModelTextPart` / `LanguageModelToolCallPart` /
 * 可选的思考部件）。
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
				// 只有探测到宿主提供思考部件时，翻译层才会发出这种部件；
				// 这里兑住「探测与实际不符」，宁可少一种渲染方式，不能少内容。
				logger.warn(`${modelId}：无法构造思考部件，思维链按正文回显`);
				progress.report(new vscode.LanguageModelTextPart(responsePart.text));
				return;
			}
			progress.report(part);
		}
	}
}

/**
 * 消费一次流式响应；上游提前断开且用户还没看到任何内容时重发。
 *
 * 返回值是本次响应的摘要（正文/思考长度、工具调用数、用量、结束原因），供调用方上报与校准。
 */
export async function streamResponse(input: StreamResponseInput): Promise<StreamSummary> {
	const { source, modelId, logger, progress } = input;
	// 渲染路径在整次响应里定死：同一次回答里忽冷忽热地换渲染方式更糟
	const thinkingParts = supportsThinkingPart();
	const sink: ResponsePartSink = part => reportResponsePart(progress, part, logger, modelId);

	/** 当前要发出去的请求体：自愈会把它换成「去掉了那个字段」的版本 */
	let request = input.request;
	/** 站点抱怨过 `stream_options` 之后，后续尝试都不能再带上它 */
	let sendsStreamOptions = input.sendsStreamOptions;
	/** 已经用过的自愈步骤与轮数 */
	const repairs: string[] = [];
	/** 已经用掉几次重发额度（自愈不占额度，因此单独计数） */
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
			logger.debug(
				`响应结束：${chunkCount} 个数据块，正文 ${summary.textLength} 字，` +
				`思考 ${summary.reasoningLength} 字，工具调用 ${summary.toolCallCount} 次，` +
				`结束原因 ${summary.finishReason ?? '未提供'}`,
			);
			return summary;
		} catch (error) {
			// 站点不认某个可选字段（400）：去掉它再试一次。用户还什么都没看到，重发是安全的，
			// 而且这不算「重发额度」——去掉字段之后是一次不同的请求，不是把同一个请求再发一遍。
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
				})
				: undefined;
			if (repair !== undefined) {
				repairs.push(repair.id);
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
				// 已经改过请求还是被拒：把「改过什么」写下来，否则用户只会看到一个没道理的 400
				logger.error(`${modelId}：已尝试去掉 ${repairs.join('、')}，请求仍被拒绝`);
			}
			// 诊断用：「上游报了输出 token 但一个部件都没解出来」通常意味着响应格式没被认出来，
			// 而用户看到的只是一个空回答。
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
			if (action === 'keep-partial') {
				// 内容已经流给用户了，此时抛错只会让 VS Code 在一个已经能用的回答上弹出重试按钮。
				// 保留已有内容，但把参数不完整的工具调用丢掉：半截 JSON 拿去执行工具只会更糟。
				logger.warn(
					`上游连接在回答完成前断开，已保留已收到的 ${translator.emittedParts} 个部件：${modelId}`,
				);
				const summary = translator.flush({ dropIncompleteToolCalls: true });
				reportUsagePart(progress, summary, logger);
				return summary;
			}
			throw error;
		}
	}
}
