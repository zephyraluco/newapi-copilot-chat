/**
 * VS Code 配置读取。
 *
 * 职责边界：
 * - 把 `contributes.configuration` 里的原始值（`unknown`）校验、收敛成强类型结构；
 * - 监听配置变化并广播。
 *
 * **站地址与 API Key 不在这里**：它们由 VS Code 的 provider 配置组提供
 * （见 `provider/target.ts`）。这里只有与连接无关的调整项（模型过滤与覆盖、
 * 请求参数、状态栏、日志级别），因此对所有配置组共享。
 */

import * as vscode from 'vscode';
import {
	CONFIG_SECTION,
	DEFAULTS,
	MIN_STATUS_REFRESH_MS,
} from './consts';
import {
	asBoolean,
	asNonEmptyString,
	asNumber,
	asStringArray,
	isRecord,
} from './json';
import type { Logger, LogLevelName } from './logger';
import { parseLogLevelName } from './logger';

/** `models.overrides` 中单个模型的覆盖项。所有字段可选，未设置则沿用下层结果。 */
export interface ModelOverride {
	/** 覆盖展示名（模型选择器里显示的名字） */
	name?: string;
	/** 覆盖副标题（模型选择器里跟在名字后面的说明） */
	detail?: string;
	/** 覆盖 family，影响 VS Code 的模型归类 */
	family?: string;
	/** 覆盖上下文窗口 */
	contextWindow?: number;
	/** 直接覆盖 maxInputTokens（优先于由 contextWindow 推导） */
	maxInputTokens?: number;
	/** 覆盖最大输出 token */
	maxOutputTokens?: number;
	/** 覆盖图片输入能力 */
	imageInput?: boolean;
	/** 覆盖工具调用能力 */
	toolCalling?: boolean;
	/** tooltip 中展示的描述文本 */
	description?: string;
	/** tooltip 中展示的文档链接 */
	docsUrl?: string;
	/** 透传给该模型的额外请求体字段（例如网关特有的思考开关） */
	extraBody?: Record<string, unknown>;
}

/** 模型发现与过滤相关设置。 */
export interface ModelSettings {
	/** 白名单 glob；为空表示全部保留 */
	readonly include: readonly string[];
	/** 黑名单 glob；优先级高于 include */
	readonly exclude: readonly string[];
	/** 按模型 ID 精确覆盖 */
	readonly overrides: Readonly<Record<string, ModelOverride>>;
	/** 模型列表缓存有效期 */
	readonly cacheTtlMs: number;
	/** 未知模型的兜底上下文窗口 */
	readonly defaultContextWindow: number;
	/** 未知模型的兜底最大输出 */
	readonly defaultMaxOutputTokens: number;
}

/** 请求相关设置。 */
export interface RequestSettings {
	/** 超时：非流式是整体超时，流式是「两个分片之间的静默超时」 */
	readonly timeoutMs: number;
	/** 失败重试次数（不含首次尝试） */
	readonly maxRetries: number;
	/** 采样温度；未设置则不发送该字段，交由服务端默认值 */
	readonly temperature: number | undefined;
	/** 核采样；未设置则不发送 */
	readonly topP: number | undefined;
	/** 是否把思维链（reasoning_content）作为正文回显 */
	readonly includeReasoning: boolean;
	/** 透传给所有模型的额外请求体字段 */
	readonly extraBody: Readonly<Record<string, unknown>>;
}

/** 状态栏与面板设置。 */
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
 * 规范化 baseUrl。
 *
 * 使用者粘贴的地址形态五花八门（带尾斜杠、带 `/v1`、带 `/v1/chat/completions`），
 * 这里统一收敛成「协议 + 主机 + 可选路径前缀」的形式，端点由 `ENDPOINTS` 拼上去。
 *
 * 幂等：对已规范化的地址再调一次不会有副作用。
 */
export function normalizeBaseUrl(raw: string | undefined): string {
	const trimmed = (raw ?? '').trim();
	if (trimmed.length === 0) {
		return '';
	}
	// 去掉末尾斜杠
	let value = trimmed.replace(/\/+$/, '');
	// 用户常常复制了完整的兼容端点地址，这里把已知后缀剥掉
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

/** 解析 `models.overrides`。非法条目会被记录并跳过，不会让整份配置失效。 */
function readModelOverrides(
	config: vscode.WorkspaceConfiguration,
	logger: Logger,
): Record<string, ModelOverride> {
	const raw = readRecord(config, 'models.overrides');
	const result: Record<string, ModelOverride> = {};
	for (const [modelId, entry] of Object.entries(raw)) {
		const id = modelId.trim();
		if (id.length === 0) {
			continue;
		}
		if (!isRecord(entry)) {
			logger.warn(`配置 models.overrides.${modelId} 不是对象，已忽略`);
			continue;
		}
		result[id] = {
			name: asNonEmptyString(entry.name),
			detail: asNonEmptyString(entry.detail),
			family: asNonEmptyString(entry.family),
			contextWindow: asNumber(entry.contextWindow),
			maxInputTokens: asNumber(entry.maxInputTokens),
			maxOutputTokens: asNumber(entry.maxOutputTokens),
			imageInput: asBoolean(entry.imageInput),
			toolCalling: asBoolean(entry.toolCalling),
			description: asNonEmptyString(entry.description),
			docsUrl: asNonEmptyString(entry.docsUrl),
			extraBody: isRecord(entry.extraBody) ? entry.extraBody : undefined,
		};
	}
	return result;
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
			include: asStringArray(config.get('models.include')) ?? [],
			exclude: asStringArray(config.get('models.exclude')) ?? [],
			overrides: readModelOverrides(config, logger),
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
			timeoutMs: readPositiveInt(config.get('request.timeoutMs'), DEFAULTS.requestTimeoutMs, 5_000),
			maxRetries: Math.min(5, Math.max(0, Math.round(asNumber(config.get('request.maxRetries')) ?? DEFAULTS.maxRetries))),
			temperature: readTemperature(config, logger),
			topP: readTopP(config, logger),
			includeReasoning: asBoolean(config.get('request.includeReasoning')) ?? false,
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

/** 配置服务：读取、广播变更、并提供脱敏摘要。 */
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

	/** 摘要，用于日志与面板展示。 */
	summary(): Record<string, unknown> {
		const { logLevel, models, request, status } = this.current;
		return {
			logLevel,
			models: {
				include: models.include,
				exclude: models.exclude,
				overrideCount: Object.keys(models.overrides).length,
				cacheTtlMs: models.cacheTtlMs,
			},
			request: {
				timeoutMs: request.timeoutMs,
				maxRetries: request.maxRetries,
				temperature: request.temperature,
				topP: request.topP,
				includeReasoning: request.includeReasoning,
			},
			status,
		};
	}

	dispose(): void {
		this.listener.dispose();
		this.emitter.dispose();
	}
}
