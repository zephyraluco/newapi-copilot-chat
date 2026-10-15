import * as vscode from 'vscode';
import { CONFIG_SECTION, DEFAULTS } from '../utils/consts';
import { asBoolean, asNumber, isRecord } from '../utils/json';
import type { Logger } from '../utils/log';
import type { NewApiSettings } from '../utils/settings';

function positiveInt(value: unknown, fallback: number, minimum: number): number {
	const number = asNumber(value);
	return number === undefined || number <= 0 ? fallback : Math.max(minimum, Math.round(number));
}

export function readSettings(): NewApiSettings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const record = (key: string): Record<string, unknown> => {
		const value: unknown = config.get(key);
		return isRecord(value) ? value : {};
	};
	return {
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
			includeReasoning: asBoolean(config.get('request.includeReasoning')) ?? true,
			extraBody: record('request.extraBody'),
		},
		status: {
			showStatusBar: asBoolean(config.get('status.showStatusBar')) ?? true,
			refreshIntervalMs: positiveInt(config.get('status.refreshInterval'), DEFAULTS.statusRefreshIntervalMs, 10000),
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
		this.current = readSettings();
		this.listener = vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(CONFIG_SECTION)) {
				this.current = readSettings();
				logger.info('配置已更新', this.summary());
				this.emitter.fire(this.current);
			}
		});
	}
	get settings(): NewApiSettings { return this.current; }
	summary(): Record<string, unknown> {
		const { headers: _headers, extraBody: _extraBody, ...request } = this.current.request;
		return { models: this.current.models, request, status: this.current.status };
	}
	dispose(): void { this.listener.dispose(); this.emitter.dispose(); }
}
