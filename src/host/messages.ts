import type * as vscode from 'vscode';
import type { Logger } from '../shared/log';
import type { ChatToolDefinition } from '../shared/types';
import { convertMessages as convertNormalizedMessages, type ConvertMessagesOptions } from '../protocol/messages';
import { normalizeMessage } from './messageContent';

export function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], logger: Logger, options?: ConvertMessagesOptions) {
	return convertNormalizedMessages(messages.map(normalizeMessage), logger, options);
}

export function convertTools(tools: readonly vscode.LanguageModelChatTool[] | undefined, logger: Logger): ChatToolDefinition[] | undefined {
	if (!tools?.length) { return undefined; }
	return tools.map(tool => {
		const usable = tool.inputSchema !== undefined && tool.inputSchema !== null && typeof tool.inputSchema === 'object';
		if (!usable) { logger.debug(`工具 ${tool.name} 没有可用的 inputSchema，按零参数工具发送`); }
		return { type: 'function', function: { name: tool.name, description: tool.description,
			parameters: usable ? tool.inputSchema : { type: 'object', properties: {} } } };
	});
}
