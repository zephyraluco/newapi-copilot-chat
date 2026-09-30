'use strict';

/**
 * 最小 `vscode` 替身。
 *
 * 被测模块里 `import * as vscode from 'vscode'` 由 esbuild 标成 external，
 * 于是加载时走 `require('vscode')`——测试用这个替身顶上，就不必启动扩展宿主。
 *
 * 只实现**被测代码真正用到**的那部分：部件类（`instanceof` 判定靠它）、两个枚举、
 * 事件与取消错误。刻意不实现 UI 与命令，用到时应当补在这里而不是在测试里就地造。
 */

/** 文本部件。`messages.ts` / `tokenizer.ts` 用 `part.value`。 */
class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}

/** 助手发起的工具调用。 */
class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}

/** 工具执行结果。`content` 是部件数组。 */
class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}

/**
 * 二进制/结构化数据部件。
 *
 * `data` 按 VS Code 的语义是 `Uint8Array`，但字符串也接受（`DataPart.text()` 就是这么用的）。
 */
class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = typeof data === 'string' ? new TextEncoder().encode(data) : data;
		this.mimeType = mimeType;
	}

	static text(value, mimeType) {
		return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType);
	}

	static json(value, mimeType) {
		return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType);
	}
}

/** 角色枚举。`messages.ts` 只区分 Assistant，其余都当用户侧处理。 */
const LanguageModelChatMessageRole = { User: 1, Assistant: 2, System: 3 };

/** 工具选择模式。 */
const LanguageModelChatToolMode = { Auto: 1, Required: 2 };

/** 事件源。`chatProvider` 用它广播模型列表变化。 */
class EventEmitter {
	constructor() {
		this.listeners = [];
		this.event = listener => {
			this.listeners.push(listener);
			return { dispose: () => { } };
		};
	}

	fire(value) {
		for (const listener of this.listeners) {
			listener(value);
		}
	}

	dispose() {
		this.listeners = [];
	}
}

/** VS Code 的取消错误：注意 `name` 是 `Canceled` 而不是 `AbortError`（http.ts 专门认它）。 */
class CancellationError extends Error {
	constructor() {
		super('Canceled');
		this.name = 'Canceled';
	}
}

/**
 * 日志级别。数值与 VS Code 一致（越大越严重），`logger.ts` 会拿它比大小。
 *
 * 模块加载期就会读它来建级别映射表，因此即便测试不碰日志也必须有。
 */
const LogLevel = { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 };

/** 可释放对象。`LoggerService` 等类实现了它。 */
class Disposable {
	constructor(callOnDispose) {
		this.callOnDispose = callOnDispose;
	}

	dispose() {
		this.callOnDispose?.();
	}
}

/** 假的输出通道：只记下被写入的内容。 */
function createOutputChannel(name) {
	const lines = [];
	const append = (level, message) => { lines.push({ level, message }); };
	return {
		name,
		lines,
		append: message => append('info', message),
		appendLine: message => append('info', message),
		trace: message => append('trace', message),
		debug: message => append('debug', message),
		info: message => append('info', message),
		warn: message => append('warn', message),
		error: message => append('error', message),
		replace() { },
		clear() { lines.length = 0; },
		show() { },
		hide() { },
		dispose() { },
	};
}

/** `LanguageModelError` 的两个工厂方法；`chatProvider` 用它把 401/403/404 分类上报。 */
class LanguageModelError extends Error {
	constructor(message, code) {
		super(message);
		this.code = code;
	}

	static NoPermissions(message) {
		return new LanguageModelError(message, 'NoPermissions');
	}

	static NotFound(message) {
		return new LanguageModelError(message, 'NotFound');
	}
}

/**
 * 造一个替身。
 *
 * @param {{ thinkingPart?: boolean }} [options] `thinkingPart` 为真时挂上
 *   `LanguageModelThinkingPart`，用于覆盖 `thinking.ts` 的「宿主提供该部件」分支
 *   （默认不提供，走的是 Markdown 引用块那条真实路径）。
 */
function createVscodeStub(options = {}) {
	const stub = {
		LanguageModelTextPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
		LanguageModelDataPart,
		LanguageModelChatMessageRole,
		LanguageModelChatToolMode,
		EventEmitter,
		CancellationError,
		LanguageModelError,
		LogLevel,
		Disposable,
		window: {
			createOutputChannel,
			showInformationMessage: async () => undefined,
			showWarningMessage: async () => undefined,
			showErrorMessage: async () => undefined,
		},
		Uri: {
			parse: value => ({ toString: () => value }),
		},
	};

	if (options.thinkingPart === true) {
		stub.LanguageModelThinkingPart = class LanguageModelThinkingPart {
			constructor(value) {
				this.value = value;
			}
		};
	}

	return stub;
}

module.exports = { createVscodeStub, LogLevel, Disposable, LanguageModelTextPart, LanguageModelToolCallPart, LanguageModelToolResultPart, LanguageModelDataPart, LanguageModelChatMessageRole, LanguageModelChatToolMode };
