/**
 * 日志。基于 VS Code 的 `LogOutputChannel`：用户在「输出」面板里可直接调整级别、
 * 也能拿到时间戳与来源渲染，不需要自己实现一套日志 UI。
 *
 * 额外做两件事：一是 `newapi-copilot-chat.logLevel` 设置（我们自己的级别闸门，
 * 与通道级别是两回事，见 `warnIfChannelLevelBlocks`）；二是 `redactSecret` / `redactText`，
 * 确保 API Key 永远不会写进日志。
 */

import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from './consts';
import { describeErrorCause } from './errors';
import { safeJsonStringify, truncate } from './json';

/** 日志级别名。用于 package.json 的枚举设置。 */
export type LogLevelName = 'off' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** 数值越大越详细。用于比较两个级别。 */
const LEVEL_ORDER: Record<LogLevelName, number> = {
	off: 0,
	error: 1,
	warn: 2,
	info: 3,
	debug: 4,
	trace: 5,
};

/** 我们的级别 → VS Code 通道级别。用于判断通道是否会把日志吞掉。 */
const CHANNEL_LEVEL: Record<LogLevelName, vscode.LogLevel> = {
	off: vscode.LogLevel.Off,
	error: vscode.LogLevel.Error,
	warn: vscode.LogLevel.Warning,
	info: vscode.LogLevel.Info,
	debug: vscode.LogLevel.Debug,
	trace: vscode.LogLevel.Trace,
};

/** 把设置里的字符串收敛成合法级别，非法值回退到 `info`。 */
export function parseLogLevelName(value: unknown): LogLevelName {
	if (typeof value === 'string' && value in LEVEL_ORDER) {
		return value as LogLevelName;
	}
	return 'info';
}

/**
 * 脱敏密钥：只保留头尾少量字符，便于确认「是不是同一把 key」，但无法还原。
 *
 * 任何把 key 输出到日志、状态、面板的路径都必须先经过它。
 */
export function redactSecret(value: string | undefined): string {
	if (!value) {
		return '(未设置)';
	}
	if (value.length <= 12) {
		return '***';
	}
	return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	// 常见网关/厂商密钥前缀
	/\b(sk|pk|api|key)[-_][A-Za-z0-9_-]{8,}/gi,
	// Authorization 头
	/\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
	// 任意长串里以 sk- 开头的
	/\bsk-[A-Za-z0-9_-]{8,}/gi,
];

/**
 * 对任意文本做脱敏，用于日志与错误消息。
 *
 * 兜底手段：即使调用点忘了用 `redactSecret`，也不会把整个 key 泄漏出去。
 */
export function redactText(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, match => redactSecret(match));
	}
	return result;
}

/**
 * 日志服务：持有唯一的输出通道，并负责级别判定与格式化。
 *
 * 全局只应创建一次（在 extension.ts 里），其余模块通过 `logger.child('scope')`
 * 取得带作用域的写入口。
 */
export class LoggerService implements vscode.Disposable {
	private readonly channel: vscode.LogOutputChannel;
	private level: LogLevelName = 'info';
	private readonly levelChangeListener: vscode.Disposable;
	private warnedAboutChannelLevel = false;

	constructor(initialLevel: LogLevelName) {
		this.channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
		this.level = initialLevel;
		// 用户在「输出」面板里调整通道级别后，我们可能就有机会把之前被吞掉的日志放出来了。
		this.levelChangeListener = this.channel.onDidChangeLogLevel(() => {
			this.warnedAboutChannelLevel = false;
			this.warnIfChannelLevelBlocks();
		});
	}

	/** 输出通道本体。状态模块会把它暴露给用户，方便从面板直接跳转到日志。 */
	get outputChannel(): vscode.LogOutputChannel {
		return this.channel;
	}

	/** 设置本扩展自己的日志级别。 */
	setLevel(level: LogLevelName): void {
		if (this.level === level) {
			return;
		}
		this.level = level;
		this.warnedAboutChannelLevel = false;
		this.channel.info(`[logger] 日志级别已切换为 ${level}`);
		this.warnIfChannelLevelBlocks();
	}

	/** 当前级别是否允许输出。 */
	isEnabled(level: Exclude<LogLevelName, 'off'>): boolean {
		return LEVEL_ORDER[this.level] >= LEVEL_ORDER[level];
	}

	/** 判断「配置的级别」是否会被「通道级别」吞掉。 */
	get isBlockedByChannelLevel(): boolean {
		return LEVEL_ORDER[this.level] > channelLevelOrder(this.channel.logLevel);
	}

	/**
	 * 一次性提示：本扩展配置的级别比输出通道级别更详细，用户将看不到那些日志。
	 * 这类「配了却看不到」的问题极难自查，所以主动说清楚该去哪里改。
	 */
	warnIfChannelLevelBlocks(): void {
		if (this.warnedAboutChannelLevel || !this.isBlockedByChannelLevel) {
			return;
		}
		this.warnedAboutChannelLevel = true;
		this.channel.warn(
			`[logger] 本扩展日志级别为 "${this.level}"，但该输出通道自身级别为 "${channelLevelName(this.channel.logLevel)}"，` +
			'更详细的日志会被通道过滤掉。请在「输出」面板中选择该通道后把级别调高。',
		);
	}

	/** 内部写入口。所有 Logger 实例最终都走到这里。 */
	write(level: Exclude<LogLevelName, 'off'>, scope: string, message: string, args: readonly unknown[]): void {
		if (!this.isEnabled(level)) {
			return;
		}
		const line = `[${scope}] ${redactText(message)}${formatArgs(args)}`;
		switch (level) {
			case 'error':
				this.channel.error(line);
				break;
			case 'warn':
				this.channel.warn(line);
				break;
			case 'info':
				this.channel.info(line);
				break;
			case 'debug':
				this.channel.debug(line);
				break;
			case 'trace':
				this.channel.trace(line);
				break;
		}
	}

	dispose(): void {
		this.levelChangeListener.dispose();
		this.channel.dispose();
	}
}

function channelLevelOrder(level: vscode.LogLevel): number {
	switch (level) {
		case vscode.LogLevel.Off:
			return LEVEL_ORDER.off;
		case vscode.LogLevel.Error:
			return LEVEL_ORDER.error;
		case vscode.LogLevel.Warning:
			return LEVEL_ORDER.warn;
		case vscode.LogLevel.Info:
			return LEVEL_ORDER.info;
		case vscode.LogLevel.Debug:
			return LEVEL_ORDER.debug;
		case vscode.LogLevel.Trace:
			return LEVEL_ORDER.trace;
		default:
			return LEVEL_ORDER.info;
	}
}

function channelLevelName(level: vscode.LogLevel): string {
	switch (level) {
		case vscode.LogLevel.Off:
			return 'off';
		case vscode.LogLevel.Error:
			return 'error';
		case vscode.LogLevel.Warning:
			return 'warn';
		case vscode.LogLevel.Info:
			return 'info';
		case vscode.LogLevel.Debug:
			return 'debug';
		case vscode.LogLevel.Trace:
			return 'trace';
		default:
			return 'unknown';
	}
}

/** 把附加参数拼成一行可读文本。 */
function formatArgs(args: readonly unknown[]): string {
	if (args.length === 0) {
		return '';
	}
	return ' ' + args.map(formatArg).join(' ');
}

function formatArg(value: unknown): string {
	if (value === undefined) {
		return 'undefined';
	}
	if (value === null) {
		return 'null';
	}
	if (value instanceof Error) {
		// 用 describeErrorCause 而不是 value.message：`fetch` 失败时原因在 `cause` 里，
		// 而 stack 并不包含它，只打 name + message 等于把原因丢了。
		const chain = describeErrorCause(value);
		const stack = value.stack ? `\n${value.stack}` : '';
		return `${value.name}: ${chain}${stack}`;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'object') {
		return truncate(safeJsonStringify(value) ?? '[unserializable]', 4000);
	}
	return String(value);
}

/**
 * 带作用域的日志写入口。
 *
 * 作用域用于在日志行里定位来源，例如 `[client]`、`[models]`、`[provider]`。
 */
export class Logger {
	constructor(
		private readonly service: LoggerService,
		private readonly scope: string,
	) { }

	/** 派生子作用域：`logger.child('http')` → `[client:http]`。 */
	child(scope: string): Logger {
		return new Logger(this.service, `${this.scope}:${scope}`);
	}

	error(message: string, ...args: readonly unknown[]): void {
		this.service.write('error', this.scope, message, args);
	}

	warn(message: string, ...args: readonly unknown[]): void {
		this.service.write('warn', this.scope, message, args);
	}

	info(message: string, ...args: readonly unknown[]): void {
		this.service.write('info', this.scope, message, args);
	}

	debug(message: string, ...args: readonly unknown[]): void {
		this.service.write('debug', this.scope, message, args);
	}

	trace(message: string, ...args: readonly unknown[]): void {
		this.service.write('trace', this.scope, message, args);
	}

	/** 输出通道，便于在命令里执行 `outputChannel.show()`。 */
	get outputChannel(): vscode.LogOutputChannel {
		return this.service.outputChannel;
	}
}
