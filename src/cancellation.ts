/**
 * CancellationToken → AbortSignal 桥接：VS Code 的异步 API 用 `CancellationToken`，
 * 标准网络 API 用 `AbortSignal`。
 */

import * as vscode from 'vscode';

/** `AbortSignal` 的包装。 */
export interface AbortSignalHandle {
	/** 传给 `fetch` / SSE 解析器的信号 */
	readonly signal: AbortSignal;
	/** 是否因取消而中断 */
	readonly aborted: boolean;
	/** 信号来源描述 */
	readonly source: string;
	/** 移除监听 */
	dispose(): void;
}

/** 把 `CancellationToken` 转换成 `AbortSignal`；已取消的 token 得到「创建即中断」的信号。 */
export function fromCancellationToken(token: vscode.CancellationToken | undefined, source = 'token'): AbortSignalHandle {
	const controller = new AbortController();
	let aborted = token?.isCancellationRequested ?? false;
	if (aborted) {
		controller.abort(new vscode.CancellationError());
		return {
			signal: controller.signal,
			aborted: true,
			source,
			dispose: () => { },
		};
	}

	const listener = token?.onCancellationRequested(() => {
		aborted = true;
		controller.abort(new vscode.CancellationError());
	});

	return {
		signal: controller.signal,
		get aborted() {
			return aborted;
		},
		source,
		dispose: () => listener?.dispose(),
	};
}

/** 创建一个由调用方手动控制的信号，可主动 `abort`。 */
export function createAbortHandle(): AbortSignalHandle & { abort(reason?: unknown): void } {
	const controller = new AbortController();
	return {
		signal: controller.signal,
		get aborted() {
			return controller.signal.aborted;
		},
		source: 'manual',
		abort: (reason?: unknown) => controller.abort(reason),
		dispose: () => { },
	};
}
