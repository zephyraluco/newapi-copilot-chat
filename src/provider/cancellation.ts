import * as vscode from 'vscode';

/** Host cancellation adapter. AbortSignal is the sole cancellation state. */
export function fromCancellationToken(token: vscode.CancellationToken): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const cancel = () => controller.abort(new vscode.CancellationError());
	const listener = token.onCancellationRequested(cancel);
	if (token.isCancellationRequested) { cancel(); }
	return { signal: controller.signal, dispose: () => listener.dispose() };
}
