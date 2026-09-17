/**
 * 请求种类识别：区分「主对话」与宿主发起的各种辅助请求。
 *
 * Copilot Chat 会把一批内部请求也交给同一个 provider：起标题、写提交信息、生成分支名、
 * 生成重命名建议、整理待办、给提示分类……它们和主对话走同一条连接，能用来区分的只有
 * **首条消息（系统提示词）的前缀**，以及少数「只带一个工具」的请求。
 *
 * 识别结果有两个用途：适配器据此决定要不要关掉思考（辅助请求的输出只有一行短文本），
 * 日志里带上种类，排查「哪些请求被改写了」时不用靠猜。
 *
 * 前缀是识别用的**特征**，不是协议：宿主改了系统提示词的措辞，识别只会退化成
 * `background`（不触发任何改写），不会把请求改坏。
 */

import type { ChatContentPart, ChatRequestMessage, ChatToolDefinition } from '../../types';

/** 一次请求的种类。 */
export type ChatRequestKind =
	| 'main-agent'
	| 'terminal-steering'
	| 'todo-tracker'
	| 'settings-resolver'
	| 'prompt-categorizer'
	| 'chat-title'
	| 'inline-progress-message'
	| 'git-branch-name'
	| 'git-commit-message'
	| 'rename-suggestions'
	| 'background'
	| 'unknown';

/** 主对话（Agent 模式）的系统提示词前缀。 */
const MAIN_AGENT_PREFIX = 'You are an expert AI programming assistant';
/** 待办清单整理 */
const TODO_TRACKER_PREFIX = 'You are a background task tracker';
/** 提示词分类 */
const PROMPT_CATEGORIZER_PREFIX = 'You are an expert classifier for AI coding assistant prompts';
/** 设置项查询 */
const SETTINGS_RESOLVER_PREFIX =
	'You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings';
/** 会话标题（宿主改过几次措辞，两种都认） */
const CHAT_TITLE_PREFIXES: readonly string[] = [
	'You are an expert in crafting ultra-compact titles',
	'You are an expert in crafting pithy titles',
];
/** 进度提示语 */
const INLINE_PROGRESS_MESSAGE_PREFIX =
	'You are an expert in writing short, catchy, and encouraging progress messages';
/** 分支名 */
const GIT_BRANCH_NAME_PREFIX = 'You are an expert in crafting pithy branch names';
/** 提交信息 */
const GIT_COMMIT_MESSAGE_PREFIX =
	'You are an AI programming assistant, helping a software developer to come with the best git commit message';
/** 重命名建议 */
const RENAME_SUGGESTIONS_PREFIX = 'You are a distinguished software engineer';

/** 用户对正在运行的终端命令的补充说明（这些请求里带着它）。 */
const TERMINAL_NOTIFICATION_PATTERN = /^\[Terminal\s+\S+\s+notification:/;

/** 只带这一个工具的请求，说明它不是为了完成任务，而是内部用途。 */
const TODO_TRACKER_TOOL = 'manage_todo_list';
const PROMPT_CATEGORIZER_TOOL = 'categorize_prompt';

/**
 * 「开了思考也白开」的请求种类。
 *
 * 这些请求的产出是一行标题、一句提交信息、一个分支名之类，上游想出来的内容会被调用方
 * 直接丢掉，思考只会让它们慢几倍。
 */
const KINDS_WITHOUT_THINKING: ReadonlySet<ChatRequestKind> = new Set<ChatRequestKind>([
	'todo-tracker',
	'prompt-categorizer',
	'settings-resolver',
	'chat-title',
	'inline-progress-message',
	'git-branch-name',
	'git-commit-message',
	'rename-suggestions',
]);

/** 这种请求是否不该开启思考。 */
export function shouldDisableThinking(kind: ChatRequestKind): boolean {
	return KINDS_WITHOUT_THINKING.has(kind);
}

/** 识别所需的输入（已转换的上游请求体）。 */
export interface ClassifyRequestInput {
	readonly messages: readonly ChatRequestMessage[];
	readonly tools?: readonly ChatToolDefinition[];
}

/** 识别一次请求的种类。 */
export function classifyRequest(input: ClassifyRequestInput): ChatRequestKind {
	const firstText = messageText(input.messages[0]).trimStart();
	const latestUserText = latestUserTextOf(input.messages).trimStart();
	const toolNames = input.tools?.map(tool => tool.function.name) ?? [];

	if (TERMINAL_NOTIFICATION_PATTERN.test(latestUserText)) {
		return 'terminal-steering';
	}
	if (hasOnlyTool(toolNames, TODO_TRACKER_TOOL) || firstText.startsWith(TODO_TRACKER_PREFIX)) {
		return 'todo-tracker';
	}
	if (hasOnlyTool(toolNames, PROMPT_CATEGORIZER_TOOL) || firstText.startsWith(PROMPT_CATEGORIZER_PREFIX)) {
		return 'prompt-categorizer';
	}
	if (firstText.startsWith(SETTINGS_RESOLVER_PREFIX)) {
		return 'settings-resolver';
	}
	if (CHAT_TITLE_PREFIXES.some(prefix => firstText.startsWith(prefix))) {
		return 'chat-title';
	}
	if (firstText.startsWith(INLINE_PROGRESS_MESSAGE_PREFIX)) {
		return 'inline-progress-message';
	}
	if (firstText.startsWith(GIT_BRANCH_NAME_PREFIX)) {
		return 'git-branch-name';
	}
	if (firstText.startsWith(GIT_COMMIT_MESSAGE_PREFIX)) {
		return 'git-commit-message';
	}
	if (firstText.startsWith(RENAME_SUGGESTIONS_PREFIX)) {
		return 'rename-suggestions';
	}
	if (
		firstText.startsWith(MAIN_AGENT_PREFIX)
		|| firstText.includes('<skills>')
		|| firstText.includes('<agents>')
	) {
		return 'main-agent';
	}
	// 有内容但认不出来：当作普通后台请求，不做任何改写
	if (toolNames.length > 0 || firstText.length > 0) {
		return 'background';
	}
	return 'unknown';
}

/** 工具列表恰好只有这一个吗。 */
function hasOnlyTool(toolNames: readonly string[], toolName: string): boolean {
	return toolNames.length === 1 && toolNames[0] === toolName;
}

/** 取最后一条 user 消息的文本。 */
function latestUserTextOf(messages: readonly ChatRequestMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === 'user') {
			return messageText(message);
		}
	}
	return '';
}

/** 把一条消息的内容拼成纯文本；图片等非文本片段直接跳过。 */
function messageText(message: ChatRequestMessage | undefined): string {
	const content = message?.content;
	if (content === undefined || content === null) {
		return '';
	}
	if (typeof content === 'string') {
		return content;
	}
	let text = '';
	for (const part of content) {
		text += partText(part);
	}
	return text;
}

/** 单个内容片段的文本；非文本片段返回空串。 */
function partText(part: ChatContentPart): string {
	return part.type === 'text' ? part.text ?? '' : '';
}
