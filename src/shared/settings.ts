import type { LogLevelName } from './log';

export interface ModelSettings {
	readonly cacheTtlMs: number;
	readonly defaultContextWindow: number;
	readonly defaultMaxOutputTokens: number;
}
export interface RequestSettings {
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly streamIdleTimeoutMs: number;
	readonly includeUsage: boolean;
	readonly maxRetries: number;
	readonly temperature: number | undefined;
	readonly topP: number | undefined;
	readonly includeReasoning: boolean;
	readonly stabilizeToolList: boolean;
	readonly extraBody: Readonly<Record<string, unknown>>;
}
export interface StatusSettings {
	readonly showStatusBar: boolean;
	readonly refreshIntervalMs: number;
}
export interface NewApiSettings {
	readonly logLevel: LogLevelName;
	readonly models: ModelSettings;
	readonly request: RequestSettings;
	readonly status: StatusSettings;
}
export function classifySettingsChange(previous: NewApiSettings, next: NewApiSettings) {
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
