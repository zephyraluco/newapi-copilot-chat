/**
 * 响应侧的回传部件：把一次响应的元数据交给宿主。
 *
 * 两类部件、两个用途：
 * - **用量**（`mimeType: 'usage'`）：Copilot 的「会话信息 → 上下文窗口」读它显示 token 数；
 *   不报时 Copilot 会自己拼一个 `prompt_tokens: 0` 的兑底值，于是永远显示 `0/上限`。
 * - **回放标记**（`mimeType: 'stateful_marker'`）：把本次的思考内容随响应留下，
 *   下次请求时读回来填进 `reasoning_content`（机制见 `replay.ts`）。
 *
 * 两者都不参与回答本身，因此上报失败**不能影响已经流出的内容**：这里兜住异常只记一条警告。
 */

import * as vscode from 'vscode';
import type { ModelAdapter } from '../adapter/adapter';
import { USAGE_DATA_MIME_TYPE } from '../consts';
import type { Logger } from '../logger';
import { buildReportedUsage } from '../usage';
import { createReplayMarkerPart } from './replay';
import type { StreamSummary } from './stream';

/** 把用量回传给 Copilot（会话信息里的「上下文窗口」靠它显示 token 数）。 */
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
 * 把本次的思考内容随响应一起留下（回放标记）。
 *
 * 只有声明了 `echoReasoningContent` 的适配器才需要它：标记的唯一用途就是在下一次请求里
 * 变回 `reasoning_content`（DeepSeek 的思考态工具调用历史要求这个字段）。
 */
export function reportReplayMarker(
	progress: vscode.Progress<vscode.LanguageModelResponsePart>,
	summary: StreamSummary,
	adapter: ModelAdapter,
	modelId: string,
	logger: Logger,
): void {
	if (adapter.echoReasoningContent !== true || summary.reasoningText.length === 0) {
		return;
	}
	try {
		progress.report(createReplayMarkerPart(summary.reasoningText));
	} catch (error) {
		logger.warn(`${modelId}：思考内容的回放标记上报失败，后续请求将缺少 reasoning_content`, error);
	}
}
