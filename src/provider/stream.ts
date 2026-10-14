/**
 * 流式响应翻译：上游 chunk → 中立响应部件。
 *
 * 几件琐事：工具调用参数分片到达（按 `index` 归并、按到达顺序拼接，最后才能 parse）；
 * 思维链字段名各家不同（统一由 `reasoning.ts` 认）；usage 只在最后一个 chunk 出现，
 * 单独记下用于统计；多 choice 时只取 `index === 0`。
 *
 * 本模块不依赖 `vscode`：产出的是下面 `ResponsePart` 那三种中立部件，翻成宿主认的响应部件
 * 由上报层（`streamFlow.ts`）负责。
 */

import { SseTruncatedError } from '../client/sse';
import { safeJsonParse } from '../json';
import type { Logger } from '../logger';
import { readReasoningText } from '../reasoning';
import type { ChatCompletionChunk, ChatToolCallDelta, ChatUsage } from '../types';

/**
 * 一个响应部件：本模块的输出契约。
 *
 * 本模块的输出契约。三种形状互不重叠的判别式联合，上报层用一处 `switch` 即可穷尽。
 */
export type ResponsePart =
	/** 正式回答的正文 */
	| { readonly kind: 'text'; readonly text: string }
	/** 思维链；宿主有专用思考部件时用它渲染 */
	| { readonly kind: 'reasoning'; readonly text: string }
	/** 一次工具调用 */
	| {
		readonly kind: 'toolCall';
		readonly callId: string;
		readonly name: string;
		readonly input: object;
	};

/** 接收中立部件的回调。 */
export type ResponsePartSink = (part: ResponsePart) => void;

/** 本次流式响应的统计结果。 */
export interface StreamSummary {
	/** 正式回答的字符数 */
	readonly textLength: number;
	/** 思维链的字符数 */
	readonly reasoningLength: number;
	/**
	 * 思维链原文。
	 *
	 * 与「是否回显思考」无关：回填历史要用（见 `replay.ts`）。
	 */
	readonly reasoningText: string;
	/** 上报的工具调用数量 */
	readonly toolCallCount: number;
	/** 上游给出的结束原因 */
	readonly finishReason?: string;
	/** 上游给出的用量 */
	readonly usage?: ChatUsage;
}

/** 翻译器配置。 */
export interface StreamTranslatorOptions {
	/** 是否把思维链回显给用户 */
	readonly includeReasoning: boolean;
	/**
	 * 宿主是否提供专用思考部件（`LanguageModelThinkingPart`）。
	 *
	 * 由上报层探测后传进来——翻译层不碰 `vscode`，不能自己问宿主。
	 * 为 `false` 时思维链包成 Markdown 引用块当正文发出。
	 */
	readonly thinkingParts: boolean;
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
 * 把 chunk 流翻译成中立响应部件。
 *
 * 用法：循环里调用 `handle`，结束后调用 `flush` 取摘要。
 */
export class StreamTranslator {
	private textLength = 0;
	private reasoningLength = 0;
	/** 思维链原文，回放要用（与是否回显无关） */
	private reasoningBuffer = '';
	private finishReason: string | undefined;
	private usage: ChatUsage | undefined;
	private readonly toolCalls = new Map<number, ToolCallAccumulator>();
	/** 最近一次写入的工具调用槽位；网关省略 `index` 时，续传分片要接在它上面 */
	private lastToolCallIndex: number | undefined;
	/** 已经上报给 VS Code 的部件数 */
	private emitted = 0;
	private toolCallCount = 0;
	private reasoningStarted = false;
	/** 思维链渲染时是否处于行首（决定要不要补 `> ` 前缀） */
	private reasoningAtLineStart = true;
	private contentStarted = false;
	private warnedMultipleChoices = false;
	/** 走专用思考部件（而不是 Markdown 引用块） */
	private readonly thinkingParts: boolean;

	constructor(
		private readonly sink: ResponsePartSink,
		private readonly options: StreamTranslatorOptions,
	) {
		this.thinkingParts = options.thinkingParts;
	}

	/** 已上报的部件数。 */
	get emittedParts(): number {
		return this.emitted;
	}

	/** 上游给出的用量快照（可能出现在任意一个 chunk 里，取最后一个）。 */
	get latestUsage(): ChatUsage | undefined {
		return this.usage;
	}

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

		// 思维链：字段名由通用层统一认
		const reasoning = readReasoningText(delta);
		if (reasoning !== undefined) {
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

		// 收尾信号出现说明参数已到齐，立即上报；网关不发 finish_reason 时剩下的分片在 flush 里补报。
		if (this.finishReason === 'tool_calls' || this.finishReason === 'stop') {
			this.reportToolCalls({});
		}
	}

	/**
	 * 结束本次流式响应：补报剩下的工具调用并返回统计。
	 *
	 * @param options.dropIncompleteToolCalls 参数还没拼完的工具调用直接丢掉：
	 *   例如流被中途掐断，此时参数通常是半截 JSON。
	 */
	flush(options: { dropIncompleteToolCalls?: boolean } = {}): StreamSummary {
		if (!this.thinkingParts && this.reasoningStarted && !this.contentStarted && this.options.includeReasoning) {
			// 只有思维链、没有正式回答（例如被截断）时补一个换行，避免格式粘连；
			// 走专用思考部件时它不在正文里，没有这个问题。
			this.report('\n');
		}

		this.reportToolCalls({ dropIncomplete: options.dropIncompleteToolCalls === true });

		if (this.finishReason === 'length') {
			this.options.logger.warn('响应因达到长度上限被截断（finish_reason=length）');
		}
		if (this.usage !== undefined) {
			// debug 级：这是每轮响应的诊断细节，会话用量已由状态栏展示
			this.options.logger.debug(
				`用量：输入 ${this.usage.prompt_tokens ?? '?'} / 输出 ${this.usage.completion_tokens ?? '?'} / ` +
				`合计 ${this.usage.total_tokens ?? '?'} token`,
				this.options.modelId,
			);
		}

		return {
			textLength: this.textLength,
			reasoningLength: this.reasoningLength,
			reasoningText: this.reasoningBuffer,
			toolCallCount: this.toolCallCount,
			finishReason: this.finishReason,
			usage: this.usage,
		};
	}

	/**
	 * 上报已累积的工具调用。
	 *
	 * 只有流结束才能确定参数拼完整：上游给了 `finish_reason` 就报一次，没给才等到 `flush`。
	 */
	private reportToolCalls(options: { dropIncomplete?: boolean }): void {
		const indices = [...this.toolCalls.keys()].sort((a, b) => a - b);
		for (const index of indices) {
			const call = this.toolCalls.get(index);
			this.toolCalls.delete(index);
			if (call === undefined) {
				continue;
			}
			if (call.name.length === 0) {
				this.options.logger.warn(`工具调用缺少函数名，已跳过（index=${index}）`);
				continue;
			}
			const input = tryParseToolArguments(call.arguments, this.options.logger, call.name);
			if (input === undefined) {
				if (options.dropIncomplete === true) {
					this.options.logger.warn(`工具 ${call.name} 的参数不完整（流已中断），已丢弃这次调用`);
					continue;
				}
				this.options.logger.error(`无法解析工具 ${call.name} 的参数`, call.arguments.trim());
			}
			const callId = call.id ?? `call_${index}_${Date.now().toString(36)}`;
			this.sink({ kind: 'toolCall', callId, name: call.name, input: input ?? {} });
			this.emitted++;
			this.toolCallCount++;
		}
		// 槽位已清空：下一个不带 index 的分片会开新槽，而不是接到已上报的那次调用上
		this.lastToolCallIndex = undefined;
	}

	/* ---------------------------------------------------------------------- */

	/** 输出正式回答。 */
	private emitContent(text: string): void {
		if (!this.contentStarted) {
			this.contentStarted = true;
			if (this.reasoningStarted && !this.thinkingParts) {
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
	 * `thinkingParts` 为真时发中立部件，交由上报层构造宿主的思考部件；为假时退回 Markdown
	 * 引用块（排版逻辑因此落在这一层）。无论回显与否都会累积原文，回填历史要用（见 `replay.ts`）。
	 */
	private emitReasoning(text: string): void {
		this.reasoningBuffer += text;
		this.reasoningLength += text.length;
		if (!this.options.includeReasoning) {
			return;
		}
		if (this.thinkingParts) {
			this.reasoningStarted = true;
			this.sink({ kind: 'reasoning', text });
			this.emitted++;
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
		const index = this.resolveToolCallIndex(delta);
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

	/**
	 * 判断分片归属哪个槽位。
	 *
	 * 规范里 `index` 必填，但兼容网关可能省略它，此时用最近一次写入的槽位；
	 * 带 `id` 的分片（一次工具调用的首个分片）则开新槽。
	 */
	private resolveToolCallIndex(delta: ChatToolCallDelta): number {
		if (typeof delta.index === 'number') {
			this.lastToolCallIndex = delta.index;
			return delta.index;
		}
		const startsNewCall = typeof delta.id === 'string' && delta.id.length > 0;
		if (startsNewCall || this.lastToolCallIndex === undefined) {
			this.lastToolCallIndex = this.nextToolCallIndex();
			return this.lastToolCallIndex;
		}
		return this.lastToolCallIndex;
	}

	/** 下一个空槽位：取已用索引最大值 +1，避免稀疏索引（网关只发 `index: 5`）时撞号。 */
	private nextToolCallIndex(): number {
		let max = -1;
		for (const key of this.toolCalls.keys()) {
			if (key > max) {
				max = key;
			}
		}
		return max + 1;
	}

	private report(text: string): void {
		this.sink({ kind: 'text', text });
		this.emitted++;
	}
}

/**
 * 解析工具调用参数。
 *
 * 上游偶尔把 JSON 包在 Markdown 代码块里，因此直接解析失败后会剥掉围栏重试。
 * 仍失败时返回 `undefined`，由调用方决定丢掉这次调用还是用空对象上报（让 VS Code
 * 报出参数校验失败，模型可据此自我修正）。
 */
export function tryParseToolArguments(raw: string, logger: Logger, toolName: string): object | undefined {
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

	return undefined;
}

/** 解析工具调用参数；失败时返回空对象并记录错误。 */
export function parseToolArguments(raw: string, logger: Logger, toolName: string): object {
	const parsed = tryParseToolArguments(raw, logger, toolName);
	if (parsed === undefined) {
		logger.error(`无法解析工具 ${toolName} 的参数`, raw.trim());
		return {};
	}
	return parsed;
}

/**
 * 一次流式请求失败后的处置。
 *
 * - `retry`：重发整次请求，前提是还没上报过任何部件（用户什么都还没看到）。
 * - `fail-truncated`：内容已流出一部分但流没正常收尾；调用方先冲刷已有内容再抛错。
 * - `fail`：抛给 VS Code。
 */
export type StreamFailureAction = 'retry' | 'fail-truncated' | 'fail';

/**
 * 决定一次流式失败该怎么处置。
 *
 * 只有「流在正常收尾前结束」才值得重发，且先决条件是 `emittedParts === 0`：
 * 用户看到过内容后再补一段完整回答会把两段回答拼在一起。
 *
 * 内容已流出一部分时返回 `fail-truncated` 而不是成功，否则 Agent 循环会把半截回答
 * 当作本轮已完成。
 */
export function decideStreamFailure(input: {
	error: unknown;
	/** 已经上报给 VS Code 的部件数 */
	emittedParts: number;
	/** 这是第几次尝试（从 0 开始） */
	attempt: number;
	maxRetries: number;
	cancelled: boolean;
}): StreamFailureAction {
	if (input.cancelled) {
		return 'fail';
	}
	if (!(input.error instanceof SseTruncatedError)) {
		return 'fail';
	}
	if (input.emittedParts > 0) {
		return 'fail-truncated';
	}
	return input.attempt < input.maxRetries ? 'retry' : 'fail';
}
