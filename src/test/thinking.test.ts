import * as assert from 'assert';
import * as vscode from 'vscode';
import { createThinkingPart, isThinkingPart, readThinkingText, supportsThinkingPart } from '../provider/thinking';

/**
 * 思考部件（proposed API）的测试。
 *
 * 这个部件是**可选**的：宿主提供它时思维链走可折叠的思考块，不提供时调用方回退到
 * Markdown 引用块。因此这里不假设它一定存在，而是钉住那条契约——
 * 「造不出来」当且仅当「宿主没有提供」，「造得出来」就必须读得回来。
 */

suite('provider / 思考部件', () => {
	test('宿主提供思考部件时，构造出来的部件能原样读回', () => {
		const part = createThinkingPart('先看调用链');

		if (part === undefined) {
			assert.strictEqual(supportsThinkingPart(), false, '返回 undefined 只允许出现在宿主没提供该部件时');
			return;
		}

		assert.strictEqual(readThinkingText(part), '先看调用链');
		assert.strictEqual(isThinkingPart(part), true);
	});

	test('多段思考内容会被拼成一段文本', () => {
		if (!supportsThinkingPart()) {
			return;
		}
		const Part = (vscode as unknown as { LanguageModelThinkingPart: new (value: string[]) => object })
			.LanguageModelThinkingPart;
		assert.strictEqual(readThinkingText(new Part(['a', 'b', 'c'])), 'abc');
	});

	test('普通部件不是思考部件，也读不出思考文本', () => {
		const parts: readonly unknown[] = [
			new vscode.LanguageModelTextPart('正文'),
			new vscode.LanguageModelToolCallPart('call_1', 'read_file', {}),
			new vscode.LanguageModelDataPart(new Uint8Array([1]), 'image/png'),
			{ value: '长得像但没有正确的类型' },
			undefined,
			null,
		];

		for (const part of parts) {
			assert.strictEqual(isThinkingPart(part), false);
			assert.strictEqual(readThinkingText(part), undefined);
		}
	});
});
