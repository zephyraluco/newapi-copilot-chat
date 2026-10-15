export interface Logger {
	child(scope: string): Logger;
	error(message: string, ...args: readonly unknown[]): void;
	warn(message: string, ...args: readonly unknown[]): void;
	info(message: string, ...args: readonly unknown[]): void;
	debug(message: string, ...args: readonly unknown[]): void;
	trace(message: string, ...args: readonly unknown[]): void;
}
export function redactText(text: string): string {
	return text.replace(/\b(?:sk|pk|api|key)[-_][A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
		value => value.length <= 12 ? '***' : `${value.slice(0, 6)}…${value.slice(-4)}`);
}
