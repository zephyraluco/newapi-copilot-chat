/**
 * 流式响应翻译：上游 chunk → VS Code 响应部件。
 *
 * 需要处理的几件琐事：
 * 1. **工具调用是分片到达的**：`function.arguments` 会被切成多个片段，
 *    必须按 `index` 归并、按到达顺序拼接，最后才能 parse 成对象。
 * 2. **思维链字段有两种命名**：DeepSeek 用 `reasoning_content`，
 *    OpenRouter 等用 `reasoning`，需要统一。
 * 3. **usage 只在最后一个 chunk 出现**：要单独记下来，用于统计与日志。
 * 4. **多 choice**：VS Code 的响应模型是单条回答，只取 `index === 0`。
 */

import * as vscode from 'vscode';
import { safeJsonParse } from '../json';
import type { Logger } from '../logger';
import type { ChatCompletionChunk, ChatToolCallDelta, ChatUsage } from '../types';

/** 本次流式响应的统计结果。 */
export interface StreamSummary {
	/** 正式回答的字符数 */
	readonly textLength: number;
	/** 思维链的字符数 */
	readonly reasoningLength: number;
	/** 上报的工具调用数量 */
	readonly toolCallCount: number;
	/** 上游给出的结束原因 */
	readonly finishReason?: string;
	/** 上游给出的用量 */
	readonly usage?: ChatUsage;
}

/** 翻译器配置。 */
export interface StreamTranslatorOptions {
	/** 是否把思维链作为正文回显 */
	readonly includeReasoning: boolean;
	readonly logger: Logger;
	/** 仅用于日志 */
	readonly modelId: string;
}

/** 工具调用的累积状态。 */
interface ToolCallAccumulator {
	id?: string;
	name: string;
	arguments: string;
}

/** 从 chunk 中提取上游错误描述；没有错误时返回 `undefined`。 */
export function extractStreamError(chunk: ChatCompletionChunk): string | undefined {
	if (chunk.error === undefined || chunk.error === null) {
		return undefined;
	}
	const error = chunk.error;
	const message = typeof error.message === 'string' && error.message.length > 0
		? error.message
		: '上游返回了未说明的错误';
	const code = error.code !== undefined ? `（${String(error.code)}）` : '';
	return `${message}${code}`;
}

/**
 * 把 chunk 流翻译成 `LanguageModelResponsePart`。
 *
 * 使用方式：
 * ```ts
 * const translator = new StreamTranslator(progress, options);
 * for await (const chunk of stream) { translator.handle(chunk); }
 * const summary = translator.flush();
 * ```
 */
export class StreamTranslator {
	private textLength = 0;
	private reasoningLength = 0;
	private finishReason: string | undefined;
	private usage: ChatUsage | undefined;
	private readonly toolCalls = new Map<number, ToolCallAccumulator>();
	private reasoningStarted = false;
	/** 思维链渲染时是否处于行首（决定要不要补 `> ` 前缀） */
	private reasoningAtLineStart = true;
	private contentStarted = false;
	private warnedMultipleChoices = false;

	constructor(
		private readonly progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		private readonly options: StreamTranslatorOptions,
	) { }

	/** 处理一个 chunk。 */
	handle(chunk: ChatCompletionChunk): void {
		if (chunk.usage !== undefined) {
			// 部分网关每个 chunk 都带 usage，取最后一个即可
			this.usage = chunk.usage;
		}

		const choices = chunk.choices ?? [];
		if (choices.length === 0) {
			return;
		}
		if (choices.length > 1 && !this.warnedMultipleChoices) {
			this.warnedMultipleChoices = true;
			this.options.logger.warn(
				`上游返回了 ${choices.length} 个候选（n>1），只使用第一个；` +
				'请确认该模型未被配置为多候选输出。',
			);
		}

		const choice = choices[0];
		if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
			this.finishReason = choice.finish_reason;
		}

		const delta = choice.delta;
		if (delta === undefined) {
			return;
		}

		// 思维链：两种字段名都认
		const reasoning = delta.reasoning_content ?? delta.reasoning;
		if (typeof reasoning === 'string' && reasoning.length > 0) {
			this.emitReasoning(reasoning);
		}

		if (typeof delta.content === 'string' && delta.content.length > 0) {
			this.emitContent(delta.content);
		}

		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				this.accumulateToolCall(call);
			}
		}
	}

	/**
	 * 结束本次流式响应：上报工具调用并返回统计。
	 *
	 * 工具调用统一在这里上报，因为只有流结束时才能确定参数已经拼完整。
	 */
	flush(): StreamSummary {
		if (this.reasoningStarted && !this.contentStarted && this.options.includeReasoning) {
			// 只有思维链、没有正式回答（例如被截断），补一个换行避免格式粘连
			this.report('\n');
		}

		let toolCallCount = 0;
		const indices = [...this.toolCalls.keys()].sort((a, b) => a - b);
		for (const index of indices) {
			const call = this.toolCalls.get(index);
			if (call === undefined) {
				continue;
			}
			if (call.name.length === 0) {
				this.options.logger.warn(`工具调用缺少函数名，已跳过（index=${index}）`);
				continue;
			}
			const input = parseToolArguments(call.arguments, this.options.logger, call.name);
			const callId = call.id ?? `call_${index}_${Date.now().toString(36)}`;
			this.progress.report(new vscode.LanguageModelToolCallPart(callId, call.name, input));
			toolCallCount++;
		}

		if (this.finishReason === 'length') {
			this.options.logger.warn('响应因达到长度上限被截断（finish_reason=length）');
		}
		if (this.usage !== undefined) {
			this.options.logger.info(
				`用量：输入 ${this.usage.prompt_tokens ?? '?'} / 输出 ${this.usage.completion_tokens ?? '?'} / ` +
				`合计 ${this.usage.total_tokens ?? '?'} token`,
				this.options.modelId,
			);
		}

		return {
			textLength: this.textLength,
			reasoningLength: this.reasoningLength,
			toolCallCount,
			finishReason: this.finishReason,
			usage: this.usage,
		};
	}

	/* ---------------------------------------------------------------------- */

	/** 输出正式回答。 */
	private emitContent(text: string): void {
		if (!this.contentStarted) {
			this.contentStarted = true;
			if (this.reasoningStarted) {
				// 与思维链分隔开，避免引用块和正文连在一起
				this.report('\n\n');
			}
		}
		this.textLength += text.length;
		this.report(text);
	}

	/**
	 * 输出思维链。
	 *
	 * 稳定的 VS Code API 目前没有专门的「思考内容」响应部件，因此思维链只能当正文发出。
	 * 为了让它在视觉上与正式回答区分开，这里包成 Markdown 引用块。
	 *
	 * 一旦 VS Code 暴露专用部件（例如 `LanguageModelThinkingPart`），
	 * 只需要改这一个方法即可——这也是把渲染收敛在此处的原因。
	 */
	private emitReasoning(text: string): void {
		this.reasoningLength += text.length;
		if (!this.options.includeReasoning) {
			return;
		}
		let output = '';
		if (!this.reasoningStarted) {
			this.reasoningStarted = true;
			output += '\n\n> **🧠 思考过程**\n>\n';
			this.reasoningAtLineStart = true;
		}
		if (this.reasoningAtLineStart) {
			output += '> ';
		}
		output += text.replace(/\n/g, '\n> ');
		this.reasoningAtLineStart = text.endsWith('\n');
		this.report(output);
	}

	/** 累积工具调用分片。 */
	private accumulateToolCall(delta: ChatToolCallDelta): void {
		const index = typeof delta.index === 'number' ? delta.index : this.toolCalls.size;
		const existing = this.toolCalls.get(index) ?? { name: '', arguments: '' };
		if (delta.id !== undefined && delta.id.length > 0) {
			existing.id = delta.id;
		}
		if (delta.function?.name !== undefined && delta.function.name.length > 0) {
			existing.name += delta.function.name;
		}
		if (delta.function?.arguments !== undefined) {
			existing.arguments += delta.function.arguments;
		}
		this.toolCalls.set(index, existing);
	}

	private report(text: string): void {
		this.progress.report(new vscode.LanguageModelTextPart(text));
	}
}

/**
 * 解析工具调用参数。
 *
 * 上游偶尔会把 JSON 包在 Markdown 代码块里（尤其是被中转做过格式化的场景），
 * 因此这里会先尝试直接解析，失败后再剥掉围栏重试。
 * 仍然失败时返回空对象并记录错误——让 VS Code 报出参数校验失败（模型可自我修正），
 * 比直接丢掉这次工具调用更好。
 */
export function parseToolArguments(raw: string, logger: Logger, toolName: string): object {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return {};
	}

	const direct = safeJsonParse<object>(trimmed);
	if (direct !== undefined && typeof direct === 'object' && direct !== null) {
		return direct;
	}

	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
	if (fenced) {
		const inner = safeJsonParse<object>(fenced[1]);
		if (inner !== undefined && typeof inner === 'object' && inner !== null) {
			logger.debug(`工具 ${toolName} 的参数被 Markdown 代码块包裹，已自动剥离`);
			return inner;
		}
	}

	logger.error(`无法解析工具 ${toolName} 的参数`, trimmed);
	return {};
}
