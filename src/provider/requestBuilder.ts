/**
 * 请求构造：把设置、模型配置与已转换的消息组装成 `/v1/chat/completions` 的请求体。
 *
 * 写入顺序是语义的一部分（后面的可以盖过前面的）：
 *
 * ```
 *   model + messages
 *   → temperature / top_p / tools（来自设置）
 *   → extraBody 里的额外字段
 *   → 思考强度（来自模型选择器里的选择，最具体，因此最后写）
 * ```
 *
 * `PROTECTED_REQUEST_KEYS` 把协议骨架（`model` / `messages` / `tools` …）挡在 `extraBody` 之外：
 * 让一个 JSON 设置项覆盖 `messages` 只会制造无从排查的故障。
 *
 * 适配器看到的是本函数产出的完整请求体，因此**这里不处理供应商差异**（见 `adapter/`）。
 */

import type * as vscode from 'vscode';
import type { NewApiSettings } from '../config';
import { PROTECTED_REQUEST_KEYS } from '../consts';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest, ChatToolDefinition } from '../types';
import { convertToolChoice } from './messages';
import { applyReasoningEffort } from './modelConfiguration';

/** 组装请求体。 */
export function buildRequest(input: {
	config: ModelConfig;
	settings: NewApiSettings;
	messages: ChatCompletionRequest['messages'];
	tools: ChatToolDefinition[] | undefined;
	toolMode: vscode.LanguageModelChatToolMode;
	reasoningEffort: string | undefined;
}): ChatCompletionRequest {
	const { config, settings, messages, tools, toolMode, reasoningEffort } = input;
	const request: ChatCompletionRequest = { model: config.id, messages };

	const { temperature, topP } = settings.request;
	if (temperature !== undefined) {
		request.temperature = temperature;
	}
	if (topP !== undefined) {
		request.top_p = topP;
	}
	if (tools !== undefined) {
		request.tools = tools;
		const choice = convertToolChoice(toolMode, true);
		if (choice !== undefined) {
			request.tool_choice = choice;
		}
	}

	// 额外字段：结构化字段被排除在外——让一个 JSON 设置项覆盖 `messages` 只会制造无从排查的故障。
	for (const [key, value] of Object.entries(settings.request.extraBody)) {
		if (!PROTECTED_REQUEST_KEYS.has(key) && value !== undefined) {
			request[key] = value;
		}
	}

	// 模型选择器里的选择比静态设置更具体，因此在额外字段之后写入，可以盖过它们。
	if (reasoningEffort !== undefined) {
		applyReasoningEffort(request, reasoningEffort);
	}

	return request;
}
