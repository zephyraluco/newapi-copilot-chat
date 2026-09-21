/**
 * `vscode` 的最小替身。
 *
 * 只给「不需要扩展宿主」的测试用（见 `scripts/unit-test-setup.cjs` 与 `npm run test:unit`）：
 * 那些用例覆盖的是纯逻辑（SSE 分帧、字段名兼容、chunk 归并、适配器改写…），把它们拖进
 * 扩展宿主只会让 CI 白白下载一个 VS Code。
 *
 * 替身只提供**被真正用到的那几个形状**，不追求完整，也不模拟行为。一旦某个用例开始依赖
 * 真实行为（事件、取消、通道、类身份），它就不该留在纯逻辑套件里——那正是这个替身存在的
 * 边界：它让「哪些测试需要宿主」变成一个显式清单，而不是一句含糊的约定。
 */

class Disposable {
	dispose() {}
}

class LanguageModelTextPart {
	constructor(value) {
		this.value = value;
	}
}

class LanguageModelToolCallPart {
	constructor(callId, name, input) {
		this.callId = callId;
		this.name = name;
		this.input = input;
	}
}

class LanguageModelToolResultPart {
	constructor(callId, content) {
		this.callId = callId;
		this.content = content;
	}
}

class LanguageModelDataPart {
	constructor(data, mimeType) {
		this.data = data;
		this.mimeType = mimeType;
	}
}

/** 与 `vscode.LogLevel` 一致：只要互不相同，级别比较的逻辑就成立。 */
const LogLevel = { Off: 0, Error: 1, Warning: 2, Info: 3, Debug: 4, Trace: 5 };

/** 什么都不做的输出通道：`logger.ts` 在构造时要一个，写进去的内容没人看。 */
function createOutputChannel(name) {
	return {
		name,
		logLevel: LogLevel.Off,
		onDidChangeLogLevel() {
			return new Disposable();
		},
		info() {},
		warn() {},
		error() {},
		debug() {},
		trace() {},
		append() {},
		appendLine() {},
		clear() {},
		show() {},
		dispose() {},
	};
}

module.exports = {
	Disposable,
	LogLevel,
	LanguageModelDataPart,
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	LanguageModelToolResultPart,
	window: { createOutputChannel },
};
