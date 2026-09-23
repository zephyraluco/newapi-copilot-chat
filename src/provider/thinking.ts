/**
 * 思考内容部件（`LanguageModelThinkingPart`）。
 *
 * 它不在稳定 typings（`@types/vscode`）里，运行时也未必存在，因此「探测 / 构造 / 读取」
 * 都收敛在这里：
 *
 * - 扩展**不声明** `enabledApiProposals`（提案 API 不允许发布到 Marketplace），
 *   所以不能指望这个部件一定存在，一切访问都必须经过运行时探测；
 * - 宿主提供了这个部件时，思考内容走它，Copilot 把它渲染成可折叠的思考块，
 *   并且 `chat.agent.thinkingStyle` 之类的外观设置才会生效；
 * - 宿主没提供时调用方回退到 Markdown 引用块（见 `provider/stream.ts`）；
 * - 读取侧按形状识别而不只靠 `instanceof`：宿主回传的历史部件可能来自**另一个模块实例**，
 *   那时 `instanceof` 会失效（`messages.ts` 里转换文本部件时也踩过同一个坑）。
 */

import * as vscode from 'vscode';

/** 思考部件的构造器形状。 */
interface ThinkingPartConstructor {
	new (value: string | string[]): object;
}

/** 运行时的 VS Code 提供思考部件吗。 */
export function supportsThinkingPart(): boolean {
	const ctor = (vscode as unknown as { LanguageModelThinkingPart?: unknown }).LanguageModelThinkingPart;
	return typeof ctor === 'function';
}

/** 构造一个思考部件；宿主不提供该部件时返回 `undefined`。 */
export function createThinkingPart(text: string): vscode.LanguageModelResponsePart | undefined {
	if (!supportsThinkingPart()) {
		return undefined;
	}
	const Part = (vscode as unknown as { LanguageModelThinkingPart: ThinkingPartConstructor })
		.LanguageModelThinkingPart;
	return new Part(text) as unknown as vscode.LanguageModelResponsePart;
}

/** 读出思考部件的文本；不是思考部件或内容不可读时返回 `undefined`。 */
export function readThinkingText(part: unknown): string | undefined {
	if (!isThinkingPart(part)) {
		return undefined;
	}
	const value = (part as { value?: unknown }).value;
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value) && value.every(item => typeof item === 'string')) {
		return value.join('');
	}
	return undefined;
}

/**
 * 这是思考部件吗。
 *
 * 先试 `instanceof`（宿主确实提供了类时最可靠），再按构造函数名兜底——
 * 只认名字不会再进一步校验 `value`，避免把形状相近的部件误判成思考内容。
 */
export function isThinkingPart(part: unknown): boolean {
	if (part === null || part === undefined || typeof part !== 'object') {
		return false;
	}
	const ctor = (vscode as unknown as { LanguageModelThinkingPart?: Function }).LanguageModelThinkingPart;
	if (typeof ctor === 'function' && part instanceof (ctor as new (...args: never[]) => object)) {
		return true;
	}
	const name = (part as { constructor?: { name?: string } }).constructor?.name;
	return name === 'LanguageModelThinkingPart';
}
