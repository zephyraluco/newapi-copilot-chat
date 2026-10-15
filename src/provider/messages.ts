/**
 * 消息格式转换：VS Code ⇄ New API（OpenAI 兼容）。
 *
 * | 概念 | VS Code | OpenAI 兼容 |
 * | --- | --- | --- |
 * | 角色 | 只有 `User` / `Assistant` | `system` / `user` / `assistant` / `tool` |
 * | 工具调用 | 助手消息里的 `LanguageModelToolCallPart` | 助手消息的 `tool_calls` |
 * | 工具结果 | 用户消息里的 `LanguageModelToolResultPart` | 独立的 `role: 'tool'` 消息，带 `tool_call_id` |
 * | 图片 | `LanguageModelDataPart`（mimeType + Uint8Array） | `image_url`，URL 为 `data:` 形式 |
 *
 * 一个 VS Code 消息可能被拆成多条上游消息，且顺序敏感：assistant(tool_calls) 之后
 * 必须紧跟若干条 tool 消息，顺序错了上游会报 400。
 *
 * 思考部件（宿主提供时才有）与回放标记（见 `replay.ts`）也不能当正文发出去。
 */

import * as vscode from 'vscode';
import { SUPPORTED_IMAGE_MIME_TYPES } from '../consts';
import { safeJsonStringify } from '../json';
import type { Logger } from '../logger';
import { REASONING_ECHO_FIELD } from '../reasoning';
import type {
	ChatContentPart,
	ChatRequestMessage,
	ChatRequestToolCall,
	ChatToolDefinition,
} from '../types';
import { isReplayMarkerPart, readReplayedReasoning } from './replay';
import { readThinkingText } from './thinking';
import { splitCjkChars } from './tokenizer';
import type { RequestTextMeasure } from './tokenizer';

/** 转换结果。 */
export interface ConvertedMessages {
	readonly messages: ChatRequestMessage[];
	/** 因为没有内容而被跳过的消息数 */
	readonly skipped: number;
	/** 转换过程中值得记录但不致命的问题 */
	readonly warnings: readonly string[];
}

/** 转换选项。 */
export interface ConvertMessagesOptions {
	readonly nativeImageInput?: boolean;
	/**
	 * 是否把历史里的思考内容回填成上一轮的思维链字段（`REASONING_ECHO_FIELD`）。
	 *
	 * 只有需要它的上游才打开（如 `adapter/deepseek`）；其余上游多送这个字段可能被拒。
	 */
	readonly echoReasoningContent?: boolean;
}

/** 把 VS Code 的消息数组转换成 OpenAI 兼容格式。 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	logger: Logger,
	options: ConvertMessagesOptions = {},
): ConvertedMessages {
	const echoReasoning = options.echoReasoningContent ?? false;
	const nativeImageInput = options.nativeImageInput ?? true;
	const result: ChatRequestMessage[] = [];
	const warnings: string[] = [];
	let skipped = 0;

	for (const message of messages) {
		const parts = message.content ?? [];
		const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;

		if (isAssistant) {
			const converted = convertAssistantMessage(message, parts, warnings, echoReasoning, nativeImageInput);
			if (converted === undefined) {
				skipped++;
				continue;
			}
			result.push(converted);
			continue;
		}

		// 用户消息：工具结果必须拆成独立的 tool 消息，并且要排在用户内容之前
		const toolMessages: ChatRequestMessage[] = [];
		const contentParts: ChatContentPart[] = [];
		let textBuffer = '';

		for (const part of parts) {
			if (part instanceof vscode.LanguageModelToolResultPart) {
				toolMessages.push({
					role: 'tool',
					tool_call_id: part.callId,
					content: convertToolResultContent(part, warnings, nativeImageInput),
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelTextPart) {
				textBuffer += part.value;
				contentParts.push({ type: 'text', text: part.value });
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				// 回放标记是元数据，不是图片也不是正文
				if (isReplayMarkerPart(part)) {
					continue;
				}
				const image = nativeImageInput ? dataPartToImage(part, warnings) : undefined;
				if (image !== undefined) {
					contentParts.push(image);
				}
				continue;
			}
			// 仅兼容字符串和文本部件形状；未知宿主元数据不能作为正文。
			const fallback = partToText(part);
			if (fallback !== undefined && fallback.length > 0) {
				textBuffer += fallback;
				contentParts.push({ type: 'text', text: fallback });
			}
		}

		result.push(...toolMessages);

		const hasText = textBuffer.length > 0;
		const hasImages = contentParts.some(part => part.type === 'image_url');
		if (!hasText && !hasImages) {
			if (toolMessages.length === 0) {
				skipped++;
			}
			continue;
		}

		// VS Code 的消息模型没有 system 角色，宿主有时把系统提示按用户消息下发并用 `name` 标记来源，
		// 这类消息会被提升为 `system` 角色。
		const name = normalizeName(message.name);
		const role = name === 'system' ? 'system' : 'user';
		const content: ChatRequestMessage['content'] = hasImages
			? contentParts
			: textBuffer;

		result.push(role === 'system'
			? { role: 'system', content: textBuffer }
			: { role: 'user', content, ...(name !== undefined && role === 'user' ? { name } : {}) });
	}

	if (skipped > 0) {
		logger.debug(`转换消息时跳过了 ${skipped} 条空消息`);
	}
	return { messages: result, skipped, warnings };
}

/* -------------------------------------------------------------------------- */
/* 助手消息                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 转换助手消息。返回 `undefined` 表示该消息没有任何有效内容。
 *
 * `echoReasoningContent` 打开时，思考内容回填成 `reasoning_content`（见 `replay.ts`）；
 * 优先用回放标记里的文本，标记缺失时才退回宿主给的思考部件。
 */
function convertAssistantMessage(
	message: vscode.LanguageModelChatRequestMessage,
	parts: readonly unknown[],
	warnings: string[],
	echoReasoningContent: boolean,
	nativeImageInput: boolean,
): ChatRequestMessage | undefined {
	let text = '';
	let thinking = '';
	const toolCalls: ChatRequestToolCall[] = [];
	const images: ChatContentPart[] = [];

	for (const part of parts) {
		if (part instanceof vscode.LanguageModelTextPart) {
			text += part.value;
			continue;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			toolCalls.push({
				id: part.callId,
				type: 'function',
				function: {
					name: part.name,
					arguments: safeJsonStringify(part.input) ?? '{}',
				},
			});
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			if (isReplayMarkerPart(part)) {
				continue;
			}
			const image = nativeImageInput ? dataPartToImage(part, warnings) : undefined;
			if (image !== undefined) {
				images.push(image);
			}
			continue;
		}
		const partThinking = readThinkingText(part);
		if (partThinking !== undefined) {
			thinking += partThinking;
			continue;
		}
		const fallback = partToText(part);
		if (fallback !== undefined) {
			text += fallback;
		}
	}

	if (text.length === 0 && toolCalls.length === 0 && images.length === 0) {
		return undefined;
	}

	// Thinking providers replay assistant content as a string, including tool-only turns.
	const content: ChatRequestMessage['content'] = images.length > 0
		? buildMultimodalContent(text, images)
		: (text.length > 0 || echoReasoningContent ? text : null);

	const name = normalizeName(message.name);
	const reasoning = echoReasoningContent
		? (readReplayedReasoning(message) ?? thinking)
		: '';
	return {
		role: 'assistant',
		content,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		...(name !== undefined && name !== 'system' ? { name } : {}),
		...(echoReasoningContent ? { [REASONING_ECHO_FIELD]: reasoning } : {}),
	};
}

/**
 * 统计请求体里的文本字符构成，用于按上游返回的真实用量校准 token 估算比例。
 *
 * 口径与估算器一致：工具定义计入，CJK 与非 CJK 分开数，图片不计。
 */
export function measureRequestText(
	messages: readonly ChatRequestMessage[],
	tools: readonly ChatToolDefinition[] | undefined,
): RequestTextMeasure {
	const measure = { cjkChars: 0, otherChars: 0 };
	const add = (text: string | undefined): void => {
		if (text === undefined || text.length === 0) {
			return;
		}
		const part = splitCjkChars(text);
		measure.cjkChars += part.cjkChars;
		measure.otherChars += part.otherChars;
	};

	for (const message of messages) {
		const content = message.content;
		if (typeof content === 'string') {
			add(content);
		} else if (content !== null) {
			for (const part of content) {
				if (part.type === 'text') {
					add(part.text);
				}
			}
		}
		add(message.reasoning_content);
		for (const call of message.tool_calls ?? []) {
			add(call.function.name);
			add(call.function.arguments);
		}
	}
	for (const tool of tools ?? []) {
		add(tool.function.name);
		add(tool.function.description);
		add(safeJsonStringify(tool.function.parameters) ?? undefined);
	}
	return measure;
}

/* -------------------------------------------------------------------------- */
/* 部件 → 文本                                                                 */
/* -------------------------------------------------------------------------- */

/** 组装多模态内容数组。 */
function buildMultimodalContent(text: string, images: readonly ChatContentPart[]): ChatContentPart[] {
	const parts: ChatContentPart[] = [];
	if (text.length > 0) {
		parts.push({ type: 'text', text });
	}
	parts.push(...images);
	return parts;
}

/** 把数据部件转成图片内容；不是受支持的图片类型时返回 `undefined`。 */
function dataPartToImage(part: vscode.LanguageModelDataPart, warnings: string[]): ChatContentPart | undefined {
	const mime = part.mimeType.toLowerCase();
	if (!SUPPORTED_IMAGE_MIME_TYPES.includes(mime as typeof SUPPORTED_IMAGE_MIME_TYPES[number])) {
		return undefined;
	}
	if (part.data.byteLength === 0) {
		warnings.push('收到空的图片数据部件，已跳过');
		return undefined;
	}
	// 上游要求 data URL 形式
	const base64 = Buffer.from(part.data).toString('base64');
	return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
}

/** 工具图片保留为 image_url；非图片数据部件直接忽略。 */
function convertToolResultContent(
	part: vscode.LanguageModelToolResultPart,
	warnings: string[],
	nativeImageInput: boolean,
): ChatRequestMessage['content'] {
	const chunks: string[] = [];
	const images: ChatContentPart[] = [];
	for (const item of part.content ?? []) {
		if (item instanceof vscode.LanguageModelTextPart) {
			chunks.push(item.value);
			continue;
		}
		if (item instanceof vscode.LanguageModelDataPart) {
			const image = nativeImageInput ? dataPartToImage(item, warnings) : undefined;
			if (image !== undefined) {
				images.push(image);
			}
			continue;
		}
		const text = partToText(item);
		if (text !== undefined) {
			chunks.push(text);
		}
	}
	const joined = chunks.join('\n');
	if (images.length > 0) {
		return buildMultimodalContent(joined, images);
	}
	// 上游对 role:'tool' 的 content 要求非空字符串
	return joined.length > 0 ? joined : '(工具没有返回内容)';
}

/** 只接受文本；未知对象和控制部件不序列化进上下文。 */
function partToText(part: unknown): string | undefined {
	if (typeof part === 'string') {
		return part;
	}
	if (part === null || part === undefined) {
		return undefined;
	}
	if (typeof part === 'object') {
		// 鸭子类型兜底：宿主对象可能来自另一个模块实例，`instanceof` 会失效
		const maybeText = (part as { value?: unknown }).value;
		if (typeof maybeText === 'string') {
			return maybeText;
		}
	}
	return undefined;
}

/** 规整消息名：空字符串视为未设置。上游对 name 有字符集要求，异常值直接丢弃。 */
function normalizeName(name: string | undefined): string | undefined {
	if (name === undefined) {
		return undefined;
	}
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		return undefined;
	}
	return /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed) ? trimmed : undefined;
}

/* -------------------------------------------------------------------------- */
/* 工具定义                                                                    */
/* -------------------------------------------------------------------------- */

/** 零参数工具的 `parameters`：上游要求是 JSON Schema 对象，空 object schema 即「不收参数」。 */
export const NO_PARAMETER_SCHEMA: object = { type: 'object', properties: {} };

/**
 * 把 VS Code 的工具声明转换成上游的 `tools` 数组。
 *
 * `inputSchema` 缺失是合法情况：宿主对零参数工具不声明 schema（如内置的
 * `terminal_last_command`），此时补成空 object schema。
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	logger: Logger,
): ChatToolDefinition[] | undefined {
	if (tools === undefined || tools.length === 0) {
		return undefined;
	}
	const result: ChatToolDefinition[] = [];
	for (const tool of tools) {
		const schema = tool.inputSchema;
		const usable = schema !== undefined && schema !== null && typeof schema === 'object';
		if (!usable) {
			logger.debug(`工具 ${tool.name} 没有可用的 inputSchema，按零参数工具发送`);
		}
		result.push({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: usable ? schema : NO_PARAMETER_SCHEMA,
			},
		});
	}
	return result.length > 0 ? result : undefined;
}
