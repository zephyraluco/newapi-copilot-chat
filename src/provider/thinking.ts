/**
 * 思考内容部件（`LanguageModelThinkingPart`）。
 *
 * 它不在稳定 typings 里，运行时也未必存在，因此探测 / 构造 / 读取都收敛在这里：
 * 宿主提供时思考内容走它（渲染成可折叠的思考块），不提供时调用方回退到 Markdown 引用块。
 * 读取侧按形状识别而不只靠 `instanceof`：宿主回传的历史部件可能来自另一个模块实例。
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
 * 先试 `instanceof`（宿主提供了类时最可靠），再按构造函数名兜底。
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
