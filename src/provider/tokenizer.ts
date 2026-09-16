/**
 * Token 估算。
 *
 * VS Code 用它判断「这段历史能不能塞进上下文」以决定是否裁剪。拿不到目标模型的真实分词器
 * （各家不同、网关也不暴露），只能估算：CJK 按 1 字符 ≈ 1 token，其余按 4 字符 ≈ 1 token，
 * 再加消息/工具/图片的固定开销。
 *
 * **偏差方向很重要**：宁可高估。高估会让 VS Code 更早裁剪历史，代价只是少一点上下文；
 * 低估则会把超长请求发给上游而被拒绝——后者对用户来说是完全失败。
 */

import * as vscode from 'vscode';
import { TOKEN_ESTIMATION } from '../consts';
import { safeJsonStringify } from '../json';

/** CJK 汉字、日文假名、韩文、全角标点与符号。 */
const CJK_PATTERN = /[\u2e80-\u303f\u3040-\u30ff\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;

/** 估算纯文本的 token 数。 */
export function estimateTextTokens(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
	const otherCount = Math.max(0, text.length - cjkCount);
	return cjkCount + Math.ceil(otherCount / TOKEN_ESTIMATION.charsPerToken);
}

/**
 * 估算一条 VS Code 消息的 token 数。
 *
 * 内部复用 `messages.ts` 的思路但不做转换——估算不需要构造完整请求体。
 */
export function estimateMessageTokens(message: vscode.LanguageModelChatRequestMessage): number {
	let total = TOKEN_ESTIMATION.messageOverhead;
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += estimateTextTokens(part.value);
			continue;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			total += estimateTextTokens(part.name);
			total += estimateTextTokens(safeJsonStringify(part.input) ?? '');
			continue;
		}
		if (part instanceof vscode.LanguageModelToolResultPart) {
			for (const item of part.content ?? []) {
				if (item instanceof vscode.LanguageModelTextPart) {
					total += estimateTextTokens(item.value);
				} else if (item instanceof vscode.LanguageModelDataPart) {
					total += estimateDataPartTokens(item);
				} else if (typeof item === 'string') {
					total += estimateTextTokens(item);
				}
			}
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			total += estimateDataPartTokens(part);
			continue;
		}
		if (typeof part === 'string') {
			total += estimateTextTokens(part);
		}
	}
	return total;
}

/** 图片按固定开销估算；其它类型的二进制按长度粗略折算。 */
function estimateDataPartTokens(part: vscode.LanguageModelDataPart): number {
	const mime = part.mimeType.toLowerCase();
	if (mime.startsWith('image/')) {
		// 视口大小与细节等级都会影响实际消耗，这里取一个常见的中间值。
		// 高估无妨（见文件头部说明）。
		return TOKEN_ESTIMATION.imageOverhead;
	}
	if (mime.startsWith('text/') || mime.includes('json')) {
		return estimateTextTokens(new TextDecoder('utf-8').decode(part.data));
	}
	return Math.ceil(part.data.byteLength / 512);
}

/**
 * `provideTokenCount` 的统一入口。
 *
 * `text` 既可能是字符串，也可能是完整的消息对象（VS Code 两种都会传）。
 */
export function estimateTokens(text: string | vscode.LanguageModelChatRequestMessage): number {
	if (typeof text === 'string') {
		return estimateTextTokens(text);
	}
	return estimateMessageTokens(text);
}

/** 按工具声明估算 `tools` 参数带来的固定开销。 */
export function estimateToolsTokens(tools: readonly vscode.LanguageModelChatTool[] | undefined): number {
	if (tools === undefined || tools.length === 0) {
		return 0;
	}
	let total = 0;
	for (const tool of tools) {
		total += TOKEN_ESTIMATION.toolOverhead;
		total += estimateTextTokens(tool.name);
		total += estimateTextTokens(tool.description ?? '');
		total += estimateTextTokens(safeJsonStringify(tool.inputSchema) ?? '');
	}
	return total;
}
