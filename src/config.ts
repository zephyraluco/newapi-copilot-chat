/**
 * VS Code 配置读取：把 `contributes.configuration` 的原始值校验成强类型，并广播变化。
 *
 * 只有与连接无关的共享调整项：模型列表缓存与兜底值、请求参数、状态栏、日志级别。
 * 站点地址与 API Key 由 provider 配置组提供，模型元数据由只读的模型数据表提供。
 */

import * as vscode from 'vscode';
import {
	CONFIG_SECTION,
	DEFAULTS,
	MIN_STATUS_REFRESH_MS,
} from './consts';
import {
	asBoolean,
	asNumber,
	isRecord,
} from './json';
import type { Logger, LogLevelName } from './logger';
import { parseLogLevelName } from './logger';

/** 模型发现相关设置。 */
export interface ModelSettings {
	/** 模型列表缓存有效期 */
	readonly cacheTtlMs: number;
	/** 未知模型的兜底上下文窗口 */
	readonly defaultContextWindow: number;
	/** 未知模型的兜底最大输出 */
	readonly defaultMaxOutputTokens: number;
}

/** 请求相关设置。 */
export interface RequestSettings {
	readonly headers: Readonly<Record<string, string>>;
	/** 超时：非流式是整体超时，流式是「等响应头」的上限 */
	readonly timeoutMs: number;
	/** 流式响应两个数据块之间的静默超时 */
	readonly streamIdleTimeoutMs: number;
	/** 是否要求上游在流式响应里返回用量（部分站点不认 `stream_options`） */
	readonly includeUsage: boolean;
	/** 模型发现与站点状态的重试次数；聊天 POST 始终只发送一次 */
	readonly maxRetries: number;
	/** 采样温度；未设置则不发送该字段，交由服务端默认值 */
	readonly temperature: number | undefined;
	/** 核采样；未设置则不发送 */
	readonly topP: number | undefined;
	/** 是否把思维链（reasoning_content）回显给用户 */
	readonly includeReasoning: boolean;
	/** 是否在请求上游之前先激活 activate_* 工具组，让每轮的工具列表保持一致 */
	readonly stabilizeToolList: boolean;
	/** 透传给所有模型的额外请求体字段 */
	readonly extraBody: Readonly<Record<string, unknown>>;
}

/** 状态栏设置。 */
export interface StatusSettings {
	/** 是否显示状态栏项 */
	readonly showStatusBar: boolean;
	/** 状态刷新间隔 */
	readonly refreshIntervalMs: number;
}

/** 本扩展的全部设置。 */
export interface NewApiSettings {
	/** 本扩展的日志级别 */
	readonly logLevel: LogLevelName;
	readonly models: ModelSettings;
	readonly request: RequestSettings;
	readonly status: StatusSettings;
}

/**
 * 一次设置变更的影响面。
 *
 * `ConfigService` 对 `newapi-copilot-chat.*` 下任何设置变化都会广播，而下游的反应不同。
 */
export interface SettingsChangeScope {
	/** client 的构造参数变了（超时、静默超时、是否要用量、重试次数）：需要按新设置重建 client */
	readonly client: boolean;
	/** 模型设置变了（缓存有效期、兜底窗口/输出）：模型缓存与解析结果要重算 */
	readonly models: boolean;
	/** 状态设置变了（显示开关、刷新间隔） */
	readonly status: boolean;
	/** 日志级别变了 */
	readonly logLevel: boolean;
}

/**
 * 判断一次设置变更影响了哪些部分。
 *
 * 只比较需要动作的字段：`request` 下的采样参数、思考回显、工具组预激活、`extraBody`
	 * 与请求头都是每次请求现读的，因此不出现在这里。
 */
export function classifySettingsChange(
	previous: NewApiSettings,
	next: NewApiSettings,
): SettingsChangeScope {
	return {
		client: previous.request.timeoutMs !== next.request.timeoutMs
			|| previous.request.streamIdleTimeoutMs !== next.request.streamIdleTimeoutMs
			|| previous.request.includeUsage !== next.request.includeUsage
			|| previous.request.maxRetries !== next.request.maxRetries,
		models: previous.models.cacheTtlMs !== next.models.cacheTtlMs
			|| previous.models.defaultContextWindow !== next.models.defaultContextWindow
			|| previous.models.defaultMaxOutputTokens !== next.models.defaultMaxOutputTokens,
		status: previous.status.showStatusBar !== next.status.showStatusBar
			|| previous.status.refreshIntervalMs !== next.status.refreshIntervalMs,
		logLevel: previous.logLevel !== next.logLevel,
	};
}

/**
 * 规范化 baseUrl：收敛成「协议 + 主机 + 可选路径前缀」，端点由 `ENDPOINTS` 拼上去。
 * 会剥掉末尾斜杠与已知的 `/v1`、`/v1/chat/completions` 后缀。幂等。
 */
export function normalizeBaseUrl(raw: string | undefined): string {
	const trimmed = (raw ?? '').trim();
	if (trimmed.length === 0) {
		return '';
	}
	// 去掉末尾斜杠
	let value = trimmed.replace(/\/+$/, '');
	// 剥掉常见的完整兼容端点后缀
	value = value.replace(/\/(v1\/)?chat\/completions$/i, '');
	value = value.replace(/\/v1$/i, '');
	value = value.replace(/\/+$/, '');
	return value;
}

/** 判断 baseUrl 是否形如合法的 http(s) 地址。 */
export function isValidBaseUrl(baseUrl: string): boolean {
	if (baseUrl.length === 0) {
		return false;
	}
	try {
		const url = new URL(baseUrl);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch {
		return false;
	}
}

/** 读取配置节中的原始对象。 */
function readRecord(config: vscode.WorkspaceConfiguration, key: string): Record<string, unknown> {
	const value: unknown = config.get(key);
	return isRecord(value) ? value : {};
}

/** 读取温度：合法范围 0–2，越界视为未设置。 */
function readTemperature(config: vscode.WorkspaceConfiguration, logger: Logger): number | undefined {
	const value = asNumber(config.get('request.temperature'));
	if (value === undefined) {
		return undefined;
	}
	if (value < 0 || value > 2) {
		logger.warn(`配置 request.temperature=${value} 超出 [0, 2]，已忽略`);
		return undefined;
	}
	return value;
}

/** 读取 top_p：合法范围 0–1，越界视为未设置。 */
function readTopP(config: vscode.WorkspaceConfiguration, logger: Logger): number | undefined {
	const value = asNumber(config.get('request.topP'));
	if (value === undefined) {
		return undefined;
	}
	if (value <= 0 || value > 1) {
		logger.warn(`配置 request.topP=${value} 超出 (0, 1]，已忽略`);
		return undefined;
	}
	return value;
}

/** 读取正整数并夹到下限。 */
function readPositiveInt(value: unknown, fallback: number, minimum: number): number {
	const parsed = asNumber(value);
	if (parsed === undefined || parsed <= 0) {
		return fallback;
	}
	return Math.max(minimum, Math.round(parsed));
}

/** 从 VS Code 读取并收敛全部设置。 */
export function readSettings(logger: Logger): NewApiSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

	return {
		logLevel: parseLogLevelName(config.get('logLevel')),
		models: {
			cacheTtlMs: readPositiveInt(config.get('models.cacheTtl'), DEFAULTS.modelCacheTtlMs, 5_000),
			defaultContextWindow: readPositiveInt(
				config.get('models.defaultContextWindow'),
				DEFAULTS.contextWindow,
				DEFAULTS.minContextWindow,
			),
			defaultMaxOutputTokens: readPositiveInt(
				config.get('models.defaultMaxOutputTokens'),
				DEFAULTS.maxOutputTokens,
				256,
			),
		},
		request: {
			headers: Object.fromEntries(Object.entries(readRecord(config, 'request.headers'))
				.filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
			timeoutMs: readPositiveInt(config.get('request.timeoutMs'), DEFAULTS.requestTimeoutMs, 5_000),
			streamIdleTimeoutMs: readPositiveInt(
				config.get('request.streamIdleTimeoutMs'),
				DEFAULTS.streamIdleTimeoutMs,
				5_000,
			),
			includeUsage: asBoolean(config.get('request.includeUsage')) ?? true,
			maxRetries: Math.min(5, Math.max(0, Math.round(asNumber(config.get('request.maxRetries')) ?? DEFAULTS.maxRetries))),
			temperature: readTemperature(config, logger),
			topP: readTopP(config, logger),
			includeReasoning: asBoolean(config.get('request.includeReasoning')) ?? true,
			stabilizeToolList: asBoolean(config.get('request.stabilizeToolList')) ?? false,
			extraBody: readRecord(config, 'request.extraBody'),
		},
		status: {
			showStatusBar: asBoolean(config.get('status.showStatusBar')) ?? true,
			refreshIntervalMs: readPositiveInt(
				config.get('status.refreshInterval'),
				DEFAULTS.statusRefreshIntervalMs,
				MIN_STATUS_REFRESH_MS,
			),
		},
	};
}

/** 配置服务：读取、广播变更并提供摘要。 */
export class ConfigService implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<NewApiSettings>();
	private readonly listener: vscode.Disposable;
	private current: NewApiSettings;

	/** 配置变化事件。事件参数是重新读取后的完整设置。 */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly logger: Logger) {
		this.current = readSettings(logger);
		this.listener = vscode.workspace.onDidChangeConfiguration(event => {
			if (!event.affectsConfiguration(CONFIG_SECTION)) {
				return;
			}
			this.current = readSettings(this.logger);
			this.logger.info('配置已更新', this.summary());
			this.emitter.fire(this.current);
		});
	}

	/** 当前设置快照。 */
	get settings(): NewApiSettings {
		return this.current;
	}

	/** 摘要，用于日志与状态展示。 */
	summary(): Record<string, unknown> {
		const { logLevel, models, request, status } = this.current;
		return {
			logLevel,
			models: {
				cacheTtlMs: models.cacheTtlMs,
			},
			request: {
				timeoutMs: request.timeoutMs,
				streamIdleTimeoutMs: request.streamIdleTimeoutMs,
				includeUsage: request.includeUsage,
				maxRetries: request.maxRetries,
				temperature: request.temperature,
				topP: request.topP,
				includeReasoning: request.includeReasoning,
				stabilizeToolList: request.stabilizeToolList,
			},
			status,
		};
	}

	dispose(): void {
		this.listener.dispose();
		this.emitter.dispose();
	}
}
