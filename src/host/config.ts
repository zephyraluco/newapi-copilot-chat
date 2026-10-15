import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULTS, MIN_STATUS_REFRESH_MS } from '../shared/consts';
import { asBoolean, asNumber, isRecord } from '../shared/json';
import type { Logger } from '../shared/log';
import type { NewApiSettings } from '../shared/settings';
import { parseLogLevelName } from './logger';

function positiveInt(value: unknown, fallback: number, minimum: number): number {
	const number = asNumber(value);
	return number === undefined || number <= 0 ? fallback : Math.max(minimum, Math.round(number));
}

function sampling(config: vscode.WorkspaceConfiguration, key: string, maximum: number, logger: Logger): number | undefined {
	const value = asNumber(config.get(key));
	if (value !== undefined && (value < 0 || value > maximum || (key === 'request.topP' && value === 0))) {
		logger.warn(`配置 ${key}=${value} 超出合法范围，已忽略`);
		return undefined;
	}
	return value;
}

export function readSettings(logger: Logger): NewApiSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const record = (key: string): Record<string, unknown> => {
		const value: unknown = config.get(key);
		return isRecord(value) ? value : {};
	};
	return {
		logLevel: parseLogLevelName(config.get('logLevel')),
		models: {
			cacheTtlMs: positiveInt(config.get('models.cacheTtl'), DEFAULTS.modelCacheTtlMs, 5000),
			defaultContextWindow: positiveInt(config.get('models.defaultContextWindow'), DEFAULTS.contextWindow, DEFAULTS.minContextWindow),
			defaultMaxOutputTokens: positiveInt(config.get('models.defaultMaxOutputTokens'), DEFAULTS.maxOutputTokens, 256),
		},
		request: {
			headers: Object.fromEntries(Object.entries(record('request.headers')).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
			timeoutMs: positiveInt(config.get('request.timeoutMs'), DEFAULTS.requestTimeoutMs, 5000),
			streamIdleTimeoutMs: positiveInt(config.get('request.streamIdleTimeoutMs'), DEFAULTS.streamIdleTimeoutMs, 5000),
			includeUsage: asBoolean(config.get('request.includeUsage')) ?? true,
			maxRetries: Math.min(5, Math.max(0, Math.round(asNumber(config.get('request.maxRetries')) ?? DEFAULTS.maxRetries))),
			temperature: sampling(config, 'request.temperature', 2, logger),
			topP: sampling(config, 'request.topP', 1, logger),
			includeReasoning: asBoolean(config.get('request.includeReasoning')) ?? true,
			stabilizeToolList: asBoolean(config.get('request.stabilizeToolList')) ?? false,
			extraBody: record('request.extraBody'),
		},
		status: {
			showStatusBar: asBoolean(config.get('status.showStatusBar')) ?? true,
			refreshIntervalMs: positiveInt(config.get('status.refreshInterval'), DEFAULTS.statusRefreshIntervalMs, MIN_STATUS_REFRESH_MS),
		},
	};
}

/** Host settings adapter; the application owns all reactions to these changes. */
export class ConfigService implements vscode.Disposable {
	private readonly emitter = new vscode.EventEmitter<NewApiSettings>();
	private readonly listener: vscode.Disposable;
	private current: NewApiSettings;
	readonly onDidChange = this.emitter.event;
	constructor(logger: Logger) {
		this.current = readSettings(logger);
		this.listener = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				this.current = readSettings(logger);
				logger.info('配置已更新', this.summary());
				this.emitter.fire(this.current);
			}
		});
	}
	get settings(): NewApiSettings { return this.current; }
	summary(): Record<string, unknown> {
		const { headers: _headers, extraBody: _extraBody, ...request } = this.current.request;
		return { logLevel: this.current.logLevel, models: this.current.models, request, status: this.current.status };
	}
	dispose(): void { this.listener.dispose(); this.emitter.dispose(); }
}
