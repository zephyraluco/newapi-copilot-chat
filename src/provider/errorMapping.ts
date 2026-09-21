/**
 * 错误映射：把内部错误翻译成交给 VS Code 的错误。
 *
 * 消息已经是面向用户的：网络故障是「分类 + 错误码 + 站点 + 该改什么」（`src/errors.ts`），
 * HTTP 错误是上游原话。这里只做两件事：
 *
 * - **清掉 `stack`**：Copilot 会把 `name: message` 与堆栈一起渲染（`extChatEndpoint` 的
 *   `toErrorMessage(e, true)`），而用户要的是原因；原始异常已经写进日志。
 * - **只在语义真正吻合时换用工厂方法**：401/403 → `NoPermissions`、404 → `NotFound`；
 *   `Blocked` 表示「被策略阻止」，与限流/超时不是一回事，硬套会误导用户。
 *
 * 唯一的加工是密钥脱敏（`describeError` 里的 `redactText`）。
 */

import * as vscode from 'vscode';
import { HttpError } from '../client/http';
import { describeError } from '../client/newApiClient';

/** 把内部错误交给 VS Code。 */
export function toLanguageModelError(error: unknown): Error {
	const message = describeError(error);
	const result = error instanceof HttpError && error.isAuthError
		? vscode.LanguageModelError.NoPermissions(message)
		: error instanceof HttpError && error.isNotFound
			? vscode.LanguageModelError.NotFound(message)
			: new Error(message);
	result.stack = undefined;
	return result;
}
