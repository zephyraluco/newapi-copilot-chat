/**
 * 思考内容的回放。
 *
 * 稳定 API 里 VS Code 不会把「思考内容」作为可用部件交还给 provider——历史消息里只剩正文与
 * 工具调用，思考过程拿不回来。而 DeepSeek 在**思考态的工具调用历史**里要求助手消息带回
 * `reasoning_content`（缺了这次请求会被拒），所以必须自己留一份。
 *
 * 做法与参考实现一致：响应结束时额外上报一个 **data 部件**，`mimeType` 用 VS Code 约定的
 * `stateful_marker`——宿主不会渲染它，但会把它留在会话历史里、并在后续请求中原样传回。
 * 下次构造请求时再从历史消息里把它取出来，回填成 `reasoning_content`。
 *
 * 载荷格式（自产自销，只为向前兼容留了余地）：
 *
 * ```text
 * newapi-copilot\json:<base64url(JSON)>
 * ```
 *
 * 前缀是**写入者标识**，解析时用它确认标记来自本扩展；`\` 之后是载荷，`json:` 表示载荷是
 * base64url 编码的 JSON。任何一步不合预期（前缀不符、base64 非法、JSON 不是对象）都当作
 * 「没有标记」返回 `undefined`，不会抛异常——一个坏标记不该把整次请求弄崩。
 */

import * as vscode from 'vscode';

/** 标记部件的 mimeType：VS Code 按它把部件原样保留并回传给 provider。 */
export const REPLAY_MARKER_MIME = 'stateful_marker';

/** 写入者标识，同时是标记的文本前缀。 */
export const REPLAY_MARKER_WRITER_ID = 'newapi-copilot';

/** 前缀与载荷之间的分隔符。 */
const MARKER_SEPARATOR = '\\';

/** 载荷编码前缀：base64url 编码的 JSON。 */
const ENCODED_JSON_PREFIX = 'json:';

/** base64url 字母表（去掉填充符）。 */
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** 生成携带思考文本的标记部件。 */
export function createReplayMarkerPart(reasoningText: string): vscode.LanguageModelDataPart {
	const json = JSON.stringify({ reasoning: { text: reasoningText } });
	const payload = `${ENCODED_JSON_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
	const raw = `${REPLAY_MARKER_WRITER_ID}${MARKER_SEPARATOR}${payload}`;
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(raw), REPLAY_MARKER_MIME);
}

/** 这是一个回放标记部件吗。 */
export function isReplayMarkerPart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType === REPLAY_MARKER_MIME;
}

/** 从一条消息里取出回放的思考文本；没有标记或标记不可用时返回 `undefined`。 */
export function readReplayedReasoning(
	message: vscode.LanguageModelChatRequestMessage,
): string | undefined {
	for (const part of message.content ?? []) {
		if (!isReplayMarkerPart(part)) {
			continue;
		}
		const text = parseReplayMarker(part.data);
		if (text !== undefined) {
			return text;
		}
	}
	return undefined;
}

/** 解析标记载荷里的思考文本；任何一步不合预期都返回 `undefined`。 */
export function parseReplayMarker(data: Uint8Array): string | undefined {
	const decoded = new TextDecoder().decode(data);
	const separatorIndex = decoded.indexOf(MARKER_SEPARATOR);
	if (separatorIndex < 0) {
		return undefined;
	}
	if (decoded.slice(0, separatorIndex) !== REPLAY_MARKER_WRITER_ID) {
		return undefined;
	}

	const payload = decoded.slice(separatorIndex + 1);
	if (!payload.startsWith(ENCODED_JSON_PREFIX)) {
		return undefined;
	}
	const encoded = payload.slice(ENCODED_JSON_PREFIX.length);
	if (encoded.length === 0 || !BASE64URL_PATTERN.test(encoded)) {
		return undefined;
	}

	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
	} catch {
		return undefined;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const reasoning = (value as { reasoning?: unknown }).reasoning;
	if (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
		return undefined;
	}
	const text = (reasoning as { text?: unknown }).text;
	return typeof text === 'string' && text.length > 0 ? text : undefined;
}
