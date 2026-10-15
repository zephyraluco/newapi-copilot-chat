import * as vscode from 'vscode';
import { OUTPUT_CHANNEL_NAME } from '../utils/consts';
import { describeErrorCause } from '../transport/errors';
import { safeJsonStringify, truncate } from '../utils/json';
import { redactText } from '../utils/log';

type LogMethod = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** One native log channel. VS Code owns level selection and filtering. */
export class LoggerService implements vscode.Disposable {
	private readonly channel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME, { log: true });
	get outputChannel(): vscode.LogOutputChannel { return this.channel; }

	write(level: LogMethod, scope: string, message: string, args: readonly unknown[]): void {
		const suffix = args.length ? ` ${args.map(formatArg).join(' ')}` : '';
		this.channel[level](redactText(`[${scope}] ${message}${suffix}`));
	}

	dispose(): void { this.channel.dispose(); }
}

function formatArg(value: unknown): string {
	if (value instanceof Error) {
		const stack = value.stack ? `\n${value.stack}` : '';
		return `${value.name}: ${describeErrorCause(value)}${stack}`;
	}
	if (value !== null && typeof value === 'object') {
		return truncate(safeJsonStringify(value) ?? '[unserializable]', 4000);
	}
	return String(value);
}

/** Scoped logging port; each severity is forwarded to the corresponding native method. */
export class Logger {
	constructor(private readonly service: LoggerService, private readonly scope: string) {}
	child(scope: string): Logger { return new Logger(this.service, `${this.scope}:${scope}`); }
	error(message: string, ...args: readonly unknown[]): void { this.service.write('error', this.scope, message, args); }
	warn(message: string, ...args: readonly unknown[]): void { this.service.write('warn', this.scope, message, args); }
	info(message: string, ...args: readonly unknown[]): void { this.service.write('info', this.scope, message, args); }
	debug(message: string, ...args: readonly unknown[]): void { this.service.write('debug', this.scope, message, args); }
	trace(message: string, ...args: readonly unknown[]): void { this.service.write('trace', this.scope, message, args); }
	get outputChannel(): vscode.LogOutputChannel { return this.service.outputChannel; }
}
