/**
 * 工具列表稳定化：预激活 `activate_*` 虚拟工具。
 *
 * 宿主把 MCP 工具组以 `activate_<组名>` 的虚拟工具形式给出，模型调用它之后，宿主才会把组里的
 * 真实工具展开到下一轮的 `tools` 里。
 *
 * 打开 `request.stabilizeToolList` 后，provider 在请求上游之前把还没激活的 `activate_*` 逐个上报成
 * 工具调用，宿主执行它们并展开工具组，provider 再带着完整工具列表重新发起本次请求。
 *
 * 这些伪调用与它们的结果都带可识别前缀，任何请求里都会被 `filterPreflightMessages` 过滤掉。
 *
 * 代价是每轮多带一批工具定义的输入 token，因此默认关闭。
 */

import * as vscode from 'vscode';

/** 宿主用来表示「工具组」的工具名前缀。 */
export const ACTIVATE_TOOL_PREFIX = 'activate_';

/** 预激活伪调用的 ID 前缀，也是过滤它们的判据。 */
export const PREFLIGHT_CALL_ID_PREFIX = 'newapi-preflight-';

/** ID 里轮次与工具名的分隔符。 */
const CALL_ID_SEPARATOR = '_';

/** 同一个用户请求里最多预激活几轮；宿主没展开工具组时避免一直循环，达到上限即报错。 */
export const MAX_PREFLIGHT_ROUNDS = 2;

/** 预激活检查结果。 */
export interface ActivatePreflightInspection {
	/** 本次用户请求里已经预激活过几轮 */
	readonly rounds: number;
	/** 还没被激活的 `activate_*` 工具名 */
	readonly remaining: readonly string[];
}

/** 统计还需要激活哪些工具组，以及已经激活过几轮。 */
export function inspectActivatePreflight(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): ActivatePreflightInspection {
	const activatorNames = collectActivateToolNames(tools);
	const called = new Set<string>();
	let rounds = 0;

	// 只看最后一条人类消息之后的轮次，上一轮用户请求的激活记录不算数
	const start = findLatestHumanUserMessageIndex(messages) + 1;
	for (let index = start; index < messages.length; index++) {
		for (const part of messages[index].content ?? []) {
			const round = parsePreflightRound(part);
			if (round === undefined) {
				continue;
			}
			rounds = Math.max(rounds, round);
			const name = (part as vscode.LanguageModelToolCallPart).name;
			if (typeof name === 'string' && name.startsWith(ACTIVATE_TOOL_PREFIX)) {
				called.add(name);
			}
		}
	}

	return {
		rounds,
		remaining: activatorNames.filter(name => !called.has(name)),
	};
}

/** 去掉预激活伪调用与它们的结果；没有任何变化时返回原数组。 */
export function filterPreflightMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): readonly vscode.LanguageModelChatRequestMessage[] {
	let changed = false;
	const result: vscode.LanguageModelChatRequestMessage[] = [];
	for (const message of messages) {
		const content = message.content ?? [];
		const hasPreflight = content.some(isPreflightPart);
		if (!hasPreflight) {
			result.push(message);
			continue;
		}
		changed = true;
		// 伪调用旁边常跟着一个空文本部件，一起删掉，免得给上游留一条空消息
		const kept = content.filter(part => !(isPreflightPart(part) || isEmptyTextPart(part)));
		if (kept.length > 0) {
			result.push({ ...message, content: kept });
		}
	}
	return changed ? result : messages;
}

/** 生成预激活伪调用的 ID。 */
export function createPreflightCallId(round: number, toolName: string): string {
	const safeName = toolName.replace(/[^A-Za-z0-9_-]/g, '_');
	return `${PREFLIGHT_CALL_ID_PREFIX}${round}${CALL_ID_SEPARATOR}${safeName}`;
}

/* -------------------------------------------------------------------------- */

/** 工具列表里出现的 `activate_*` 工具名（去重、保持顺序）。 */
function collectActivateToolNames(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const tool of tools ?? []) {
		if (!tool.name.startsWith(ACTIVATE_TOOL_PREFIX) || seen.has(tool.name)) {
			continue;
		}
		seen.add(tool.name);
		names.push(tool.name);
	}
	return names;
}

/** 这是预激活伪调用或它的结果吗。 */
function isPreflightPart(part: unknown): boolean {
	return (
		(part instanceof vscode.LanguageModelToolCallPart
			|| part instanceof vscode.LanguageModelToolResultPart)
		&& part.callId.startsWith(PREFLIGHT_CALL_ID_PREFIX)
	);
}

/** 从伪调用/结果里读出轮次；不是预激活部件时返回 `undefined`。 */
function parsePreflightRound(part: unknown): number | undefined {
	if (!isPreflightPart(part)) {
		return undefined;
	}
	const rest = (part as vscode.LanguageModelToolCallPart).callId
		.slice(PREFLIGHT_CALL_ID_PREFIX.length);
	const separator = rest.indexOf(CALL_ID_SEPARATOR);
	const round = Number.parseInt(separator < 0 ? rest : rest.slice(0, separator), 10);
	return Number.isSafeInteger(round) && round > 0 ? round : undefined;
}

/** 找到最后一条由人发出的消息（只带工具结果的用户消息不算）。 */
function findLatestHumanUserMessageIndex(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== vscode.LanguageModelChatMessageRole.User) {
			continue;
		}
		if ((message.content ?? []).some(isHumanUserMessagePart)) {
			return index;
		}
	}
	return -1;
}

/** 这个部件说明消息是人发的吗（工具结果不算）。 */
function isHumanUserMessagePart(part: unknown): boolean {
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return false;
	}
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value.length > 0;
	}
	return true;
}

/** 空文本部件：只是宿主留下的占位，没有内容。 */
function isEmptyTextPart(part: unknown): boolean {
	return part instanceof vscode.LanguageModelTextPart && part.value.length === 0;
}
