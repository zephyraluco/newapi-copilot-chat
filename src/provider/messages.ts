/**
 * 消息格式转换：VS Code ⇄ New API（OpenAI 兼容）。
 *
 * | 概念 | VS Code | OpenAI 兼容 |
 * | --- | --- | --- |
 * | 角色 | 只有 `User` / `Assistant` | `system` / `user` / `assistant` / `tool` |
 * | 工具调用 | 助手消息里的 `LanguageModelToolCallPart` | 助手消息的 `tool_calls` |
 * | 工具结果 | 用户消息里的 `LanguageModelToolResultPart` | **独立**的 `role: 'tool'` 消息，带 `tool_call_id` |
 * | 图片 | `LanguageModelDataPart`（mimeType + Uint8Array） | `image_url`，URL 为 `data:` 形式 |
 *
 * 因此一个 VS Code 消息可能被拆成**多条**上游消息，且顺序敏感：assistant(tool_calls) 之后
 * 必须紧跟若干条 tool 消息，顺序错了上游会直接报 400。
 */

import * as vscode from 'vscode';
import { SUPPORTED_IMAGE_MIME_TYPES } from '../consts';
import { safeJsonStringify } from '../json';
import type { Logger } from '../logger';
import type {
	ChatContentPart,
	ChatRequestMessage,
	ChatRequestToolCall,
	ChatToolDefinition,
	ChatToolChoice,
} from '../types';

/** 转换结果。 */
export interface ConvertedMessages {
	readonly messages: ChatRequestMessage[];
	/** 因为没有内容而被跳过的消息数 */
	readonly skipped: number;
	/** 转换过程中遇到的、值得记录但不足以失败的问题 */
	readonly warnings: readonly string[];
}

/** 转换选项。 */
export interface ConvertMessagesOptions {
	/**
	 * 是否把 `name === 'system'` 的用户消息提升为 `system` 角色。
	 *
	 * VS Code 的消息模型没有 system 角色，宿主有时会把系统提示按用户消息下发并
	 * 用 `name` 标记来源。稳妥起见默认开启，并在没有命中时保持原样。
	 */
	readonly promoteNamedSystemMessages?: boolean;
}

/** 把 VS Code 的消息数组转换成 OpenAI 兼容格式。 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	logger: Logger,
	options: ConvertMessagesOptions = {},
): ConvertedMessages {
	const promoteSystem = options.promoteNamedSystemMessages ?? true;
	const result: ChatRequestMessage[] = [];
	const warnings: string[] = [];
	let skipped = 0;

	for (const message of messages) {
		const parts = message.content ?? [];
		const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;

		if (isAssistant) {
			const converted = convertAssistantMessage(message, parts, warnings);
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
					content: toolResultToText(part),
				});
				continue;
			}
			if (part instanceof vscode.LanguageModelTextPart) {
				textBuffer += part.value;
				continue;
			}
			if (part instanceof vscode.LanguageModelDataPart) {
				const image = dataPartToImage(part, warnings);
				if (image !== undefined) {
					contentParts.push(image);
				} else {
					textBuffer += `\n\`\`\`\n${dataPartToText(part)}\n\`\`\`\n`;
				}
				continue;
			}
			// 未知部件：尽力转成文本，而不是丢掉（丢掉会让模型失去上下文）
			const fallback = partToText(part);
			if (fallback !== undefined && fallback.length > 0) {
				textBuffer += fallback;
			}
		}

		result.push(...toolMessages);

		const hasText = textBuffer.length > 0;
		const hasImages = contentParts.length > 0;
		if (!hasText && !hasImages) {
			if (toolMessages.length === 0) {
				skipped++;
			}
			continue;
		}

		const name = normalizeName(message.name);
		const role = promoteSystem && name === 'system' ? 'system' : 'user';
		const content: ChatRequestMessage['content'] = hasImages
			? buildMultimodalContent(textBuffer, contentParts)
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

/** 转换助手消息。返回 `undefined` 表示该消息没有任何有效内容。 */
function convertAssistantMessage(
	message: vscode.LanguageModelChatRequestMessage,
	parts: readonly unknown[],
	warnings: string[],
): ChatRequestMessage | undefined {
	let text = '';
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
			const image = dataPartToImage(part, warnings);
			if (image !== undefined) {
				images.push(image);
			}
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

	// OpenAI 约定：带 tool_calls 时 content 必须为 null（部分上游对空字符串也会报错）
	const content: ChatRequestMessage['content'] = text.length > 0
		? (images.length > 0 ? buildMultimodalContent(text, images) : text)
		: (toolCalls.length > 0 ? null : '');

	const name = normalizeName(message.name);
	return {
		role: 'assistant',
		content,
		...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
		...(name !== undefined && name !== 'system' ? { name } : {}),
	};
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
	// 上游需要 data URL 形式；直接透传二进制在 OpenAI 协议里没有位置
	const base64 = Buffer.from(part.data).toString('base64');
	return { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } };
}

/** 把非图片的数据部件转成文本。 */
function dataPartToText(part: vscode.LanguageModelDataPart): string {
	const text = new TextDecoder('utf-8').decode(part.data);
	const mime = part.mimeType.toLowerCase();
	if (mime.includes('json') || mime.includes('markdown') || mime.startsWith('text/')) {
		return text;
	}
	// 二进制：只给出说明，不把乱码塞进上下文
	return `[${part.mimeType} 数据，${part.data.byteLength} 字节]`;
}

/** 把工具结果部件转成上游需要的纯文本。 */
function toolResultToText(part: vscode.LanguageModelToolResultPart): string {
	const chunks: string[] = [];
	for (const item of part.content ?? []) {
		if (item instanceof vscode.LanguageModelTextPart) {
			chunks.push(item.value);
			continue;
		}
		if (item instanceof vscode.LanguageModelDataPart) {
			chunks.push(dataPartToText(item));
			continue;
		}
		const text = partToText(item);
		if (text !== undefined) {
			chunks.push(text);
		}
	}
	const joined = chunks.join('\n');
	// 上游对 role:'tool' 的 content 要求非空字符串
	return joined.length > 0 ? joined : '(工具没有返回内容)';
}

/** 尽力把未知部件转成文本。 */
function partToText(part: unknown): string | undefined {
	if (typeof part === 'string') {
		return part;
	}
	if (part === null || part === undefined) {
		return undefined;
	}
	if (typeof part === 'object') {
		// LanguageModelTextPart 的鸭子类型兜底：宿主可能来自另一个模块实例，
		// `instanceof` 会失效，因此这里再按形状识别一次。
		const maybeText = (part as { value?: unknown }).value;
		if (typeof maybeText === 'string') {
			return maybeText;
		}
		return safeJsonStringify(part) ?? undefined;
	}
	return String(part);
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

/**
 * 把 VS Code 的工具声明转换成上游的 `tools` 数组。
 *
 * 没有 `inputSchema` 的工具会被跳过：上游要求 `parameters` 是一个 JSON Schema 对象，
 * 缺了它调用方会在校验阶段失败，不如提前过滤。
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
		if (tool.inputSchema === undefined) {
			logger.warn(`工具 ${tool.name} 缺少 inputSchema，已跳过`);
			continue;
		}
		result.push({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.inputSchema,
			},
		});
	}
	return result.length > 0 ? result : undefined;
}

/** 把 VS Code 的工具选择模式转换成上游的 `tool_choice`。 */
export function convertToolChoice(
	mode: vscode.LanguageModelChatToolMode,
	hasTools: boolean,
): ChatToolChoice | undefined {
	if (!hasTools) {
		// 没有工具时下发 tool_choice 会被部分上游拒绝
		return undefined;
	}
	return mode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto';
}
