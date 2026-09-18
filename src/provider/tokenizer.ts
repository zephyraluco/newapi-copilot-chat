/**
 * Token 估算。
 *
 * VS Code 用它判断「这段历史能不能塞进上下文」以决定是否裁剪。拿不到目标模型的真实分词器
 * （各家不同、网关也不暴露），只能估算：CJK 按 1 字符 ≈ 1 token，其余按若干字符 ≈ 1 token，
 * 再加消息/工具/图片的固定开销。
 *
 * **偏差方向很重要**：宁可高估。高估会让 VS Code 更早裁剪历史，代价只是少一点上下文；
 * 低估则会把超长请求发给上游而被拒绝——后者对用户来说是完全失败。
 *
 * 比例本身不是常量：上游返回的真实用量可以用来反推「这次请求大概多少字符对应一个 token」
 * （`calibrateCharsPerToken`），比例因此会随模型、随内容语种缓慢移动。比例由调用方保存并传进来，
 * 这里保持纯函数——估算不该偷偷改全局状态，否则测试与并发请求都会互相干扰。
 */

import * as vscode from 'vscode';
import { TOKEN_ESTIMATION } from '../consts';
import { safeJsonStringify } from '../json';
import { NO_PARAMETER_SCHEMA } from './messages';
import { REPLAY_MARKER_MIME } from './replay';
import { readThinkingText } from './thinking';

/** 校准后的比例允许落在什么区间：上游给出离谱用量时不能让它把估算带偏一个量级。 */
const CHARS_PER_TOKEN_RANGE = { min: 1, max: 16 } as const;

/** 新观测在指数移动平均里的权重。 */
const CALIBRATION_WEIGHT = 0.3;

/** CJK 汉字、日文假名、韩文、全角标点与符号。 */
const CJK_PATTERN = /[\u2e80-\u303f\u3040-\u30ff\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;

/** 估算纯文本的 token 数。 */
export function estimateTextTokens(
	text: string,
	charsPerToken: number = TOKEN_ESTIMATION.charsPerToken,
): number {
	if (text.length === 0) {
		return 0;
	}
	const cjkCount = text.match(CJK_PATTERN)?.length ?? 0;
	const otherCount = Math.max(0, text.length - cjkCount);
	return cjkCount + Math.ceil(otherCount / charsPerToken);
}

/**
 * 用上游返回的真实用量校准「多少字符约等于一个 token」。
 *
 * 只有双方都为正数时才能算：没有用量（站点关掉了 `stream_options`）或空请求都不能校准。
 * 用指数移动平均而不是直接采用观测值——单次请求的比例会因内容构成（代码 / 中文 / 工具调用
 * 占比）跳动很大，直接跟进会让上下文预算忽大忽小。
 */
export function calibrateCharsPerToken(
	requestChars: number,
	promptTokens: number | undefined,
	current: number = TOKEN_ESTIMATION.charsPerToken,
): number {
	if (promptTokens === undefined || promptTokens <= 0 || requestChars <= 0) {
		return current;
	}
	const observed = Math.min(
		CHARS_PER_TOKEN_RANGE.max,
		Math.max(CHARS_PER_TOKEN_RANGE.min, requestChars / promptTokens),
	);
	const blended = current * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT;
	return Math.min(
		CHARS_PER_TOKEN_RANGE.max,
		Math.max(CHARS_PER_TOKEN_RANGE.min, blended),
	);
}

/**
 * 估算一条 VS Code 消息的 token 数。
 *
 * 内部复用 `messages.ts` 的思路但不做转换——估算不需要构造完整请求体。
 */
export function estimateMessageTokens(
	message: vscode.LanguageModelChatRequestMessage,
	charsPerToken: number = TOKEN_ESTIMATION.charsPerToken,
): number {
	let total = TOKEN_ESTIMATION.messageOverhead;
	for (const part of message.content ?? []) {
		if (part instanceof vscode.LanguageModelTextPart) {
			total += estimateTextTokens(part.value, charsPerToken);
			continue;
		}
		if (part instanceof vscode.LanguageModelToolCallPart) {
			total += estimateTextTokens(part.name, charsPerToken);
			total += estimateTextTokens(safeJsonStringify(part.input) ?? '', charsPerToken);
			continue;
		}
		if (part instanceof vscode.LanguageModelToolResultPart) {
			for (const item of part.content ?? []) {
				if (item instanceof vscode.LanguageModelTextPart) {
					total += estimateTextTokens(item.value, charsPerToken);
				} else if (item instanceof vscode.LanguageModelDataPart) {
					total += estimateDataPartTokens(item, charsPerToken);
				} else if (typeof item === 'string') {
					total += estimateTextTokens(item, charsPerToken);
				}
			}
			continue;
		}
		if (part instanceof vscode.LanguageModelDataPart) {
			total += estimateDataPartTokens(part, charsPerToken);
			continue;
		}
		const thinking = readThinkingText(part);
		if (thinking !== undefined) {
			total += estimateTextTokens(thinking, charsPerToken);
			continue;
		}
		if (typeof part === 'string') {
			total += estimateTextTokens(part, charsPerToken);
		}
	}
	return total;
}

/** 图片按固定开销估算；其它类型的二进制按长度粗略折算。 */
function estimateDataPartTokens(
	part: vscode.LanguageModelDataPart,
	charsPerToken: number,
): number {
	// 回放标记（见 replay.ts）是我们自己写进历史的元数据，不会被发给上游，也不占上下文
	if (part.mimeType === REPLAY_MARKER_MIME) {
		return 0;
	}
	const mime = part.mimeType.toLowerCase();
	if (mime.startsWith('image/')) {
		// 视口大小与细节等级都会影响实际消耗，这里取一个常见的中间值。
		// 高估无妨（见文件头部说明）。
		return TOKEN_ESTIMATION.imageOverhead;
	}
	if (mime.startsWith('text/') || mime.includes('json')) {
		return estimateTextTokens(new TextDecoder('utf-8').decode(part.data), charsPerToken);
	}
	return Math.ceil(part.data.byteLength / 512);
}

/**
 * `provideTokenCount` 的统一入口。
 *
 * `text` 既可能是字符串，也可能是完整的消息对象（VS Code 两种都会传）。
 */
export function estimateTokens(
	text: string | vscode.LanguageModelChatRequestMessage,
	charsPerToken: number = TOKEN_ESTIMATION.charsPerToken,
): number {
	if (typeof text === 'string') {
		return estimateTextTokens(text, charsPerToken);
	}
	return estimateMessageTokens(text, charsPerToken);
}

/** 按工具声明估算 `tools` 参数带来的固定开销。 */
export function estimateToolsTokens(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
	charsPerToken: number = TOKEN_ESTIMATION.charsPerToken,
): number {
	if (tools === undefined || tools.length === 0) {
		return 0;
	}
	let total = 0;
	for (const tool of tools) {
		total += TOKEN_ESTIMATION.toolOverhead;
		total += estimateTextTokens(tool.name, charsPerToken);
		total += estimateTextTokens(tool.description ?? '', charsPerToken);
		// 与实际下发的请求体保持一致：没有 schema 的工具按空 object schema 发送
		total += estimateTextTokens(safeJsonStringify(tool.inputSchema ?? NO_PARAMETER_SCHEMA) ?? '', charsPerToken);
	}
	return total;
}
