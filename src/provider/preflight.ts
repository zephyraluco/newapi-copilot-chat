/**
 * 工具组预激活的宿主侧部分：需要时把 `activate_*` 伪调用上报给宿主。
 *
 * 判据与过滤是纯函数，在 `toolFlow.ts`；这里只负责与 VS Code 打交道的那一半
 * （上报 `LanguageModelToolCallPart`），从而让 `toolFlow.ts` 保持无 vscode 依赖。
 *
 * 上报完就**结束本次请求**：宿主执行这些伪调用、展开工具组，然后带着完整工具列表重新发起。
 * 这段控制流不会到上游——伪调用与它们的结果在后续请求里会被 `filterPreflightMessages` 过滤掉。
 */

import * as vscode from 'vscode';
import type { Logger } from '../logger';
import {
	MAX_PREFLIGHT_ROUNDS,
	createPreflightCallId,
	inspectActivatePreflight,
} from './toolFlow';

/**
 * 需要预激活工具组时上报伪调用并返回 `true`（调用方应结束本次请求），否则返回 `false`。
 *
 * 消息必须传**未过滤**的那一份：已经激活过哪些工具组，只有伪调用还在历史里时才看得出来。
 */
export function runToolGroupPreflight(input: {
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	tools: readonly vscode.LanguageModelChatTool[] | undefined;
	progress: vscode.Progress<vscode.LanguageModelResponsePart>;
	logger: Logger;
}): boolean {
	const { messages, tools, progress, logger } = input;
	const preflight = inspectActivatePreflight(messages, tools);
	if (preflight.remaining.length === 0) {
		return false;
	}
	if (preflight.rounds >= MAX_PREFLIGHT_ROUNDS) {
		throw new Error(
			`连续 ${MAX_PREFLIGHT_ROUNDS} 轮都没有完成工具组展开，` +
			'请关闭 request.stabilizeToolList 或减少启用的工具组。',
		);
	}

	const round = preflight.rounds + 1;
	logger.debug(
		`预激活 ${preflight.remaining.length} 个工具组（第 ${round} 轮）：` +
		preflight.remaining.join('、'),
	);
	for (const name of preflight.remaining) {
		progress.report(new vscode.LanguageModelToolCallPart(createPreflightCallId(round, name), name, {}));
	}
	return true;
}
