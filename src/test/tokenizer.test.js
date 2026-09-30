'use strict';

/**
 * provider/tokenizer.ts：token 估算与比例校准。
 *
 * 估算会直接决定 VS Code 何时裁剪历史，因此偏差方向（宁可高估）与校准的边界都要有用例。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { createVscodeStub } = require('./fakes');

const { modules, vscode } = load({
	tokenizer: './src/provider/tokenizer',
	replay: './src/provider/replay',
});

const { estimateTextTokens, calibrateCharsPerToken, estimateMessageTokens, estimateTokens } = modules.tokenizer;
const { createReplayMarkerPart } = modules.replay;

const text = value => new vscode.LanguageModelTextPart(value);

/* -------------------------------------------------------------------------- */
/* 纯文本                                                                      */
/* -------------------------------------------------------------------------- */

test('estimateTextTokens：空文本是 0', () => {
	assert.equal(estimateTextTokens(''), 0);
});

test('estimateTextTokens：非 CJK 按每 4 个字符约 1 个 token，向上取整', () => {
	assert.equal(estimateTextTokens('abcd'), 1);
	assert.equal(estimateTextTokens('abcde'), 2);
	assert.equal(estimateTextTokens('a'.repeat(40)), 10);
});

test('estimateTextTokens：CJK 按 1 字符 1 token 计', () => {
	assert.equal(estimateTextTokens('你好'), 2);
	assert.equal(estimateTextTokens('中文 mixed'), 2 + Math.ceil(6 / 4));
	// 全角标点同样按 CJK 计
	assert.equal(estimateTextTokens('，。'), 2);
});

test('estimateTextTokens：比例可以由调用方覆盖', () => {
	assert.equal(estimateTextTokens('abcdefgh', 8), 1);
	assert.equal(estimateTextTokens('abcdefgh', 1), 8);
});

/* -------------------------------------------------------------------------- */
/* 比例校准                                                                    */
/* -------------------------------------------------------------------------- */

test('calibrateCharsPerToken：没有可用观测时保持原值', () => {
	assert.equal(calibrateCharsPerToken(1_000, undefined), 4);
	assert.equal(calibrateCharsPerToken(1_000, 0), 4);
	assert.equal(calibrateCharsPerToken(1_000, -1), 4);
	assert.equal(calibrateCharsPerToken(0, 100), 4);
});

test('calibrateCharsPerToken：新观测按 0.3 的权重混进现有比例', () => {
	// 观测 1000 / 100 = 10，与默认的 4 混合：4 * 0.7 + 10 * 0.3 = 5.8
	assert.equal(calibrateCharsPerToken(1_000, 100), 5.8);
});

test('calibrateCharsPerToken：观测值被夹在 1 ~ 16 之间', () => {
	// 上游给出离谱用量时不能让它把估算带偏一个量级
	assert.equal(calibrateCharsPerToken(1_000_000, 1), 4 * 0.7 + 16 * 0.3);
	assert.equal(calibrateCharsPerToken(10, 1_000), 4 * 0.7 + 1 * 0.3);
});

test('calibrateCharsPerToken：混合结果同样夹在区间内', () => {
	for (const [chars, tokens] of [[1, 1], [1e9, 1], [1, 1e9]]) {
		const value = calibrateCharsPerToken(chars, tokens);
		assert.ok(value >= 1 && value <= 16, String(value));
	}
});

/* -------------------------------------------------------------------------- */
/* 消息估算                                                                    */
/* -------------------------------------------------------------------------- */

test('estimateMessageTokens：每条消息有固定结构开销', () => {
	assert.equal(estimateMessageTokens({ role: 1, content: [] }), 4);
	assert.equal(estimateMessageTokens({ role: 1 }), 4);
});

test('estimateMessageTokens：文本部件按内容计', () => {
	assert.equal(estimateMessageTokens({ role: 1, content: [text('abcd')] }), 4 + 1);
	assert.equal(estimateMessageTokens({ role: 1, content: [text('你好'), text('abcd')] }), 4 + 2 + 1);
});

test('estimateMessageTokens：工具调用数函数名与参数', () => {
	const message = {
		role: 2,
		content: [new vscode.LanguageModelToolCallPart('call_1', 'read_file', { a: 1 })],
	};

	// 函数名 9 字符 → 3；参数 '{"a":1}' 7 字符 → 2
	assert.equal(estimateMessageTokens(message), 4 + 3 + 2);
});

test('estimateMessageTokens：工具结果里的文本与数据部件都要数', () => {
	const message = {
		role: 1,
		content: [
			new vscode.LanguageModelToolResultPart('call_1', [
				text('abcd'),
				new vscode.LanguageModelDataPart(new TextEncoder().encode('你好'), 'text/plain'),
			]),
		],
	};

	assert.equal(estimateMessageTokens(message), 4 + 1 + 2);
});

test('estimateMessageTokens：图片按固定开销估算', () => {
	const message = {
		role: 1,
		content: [new vscode.LanguageModelDataPart(new Uint8Array(4), 'image/png')],
	};

	assert.equal(estimateMessageTokens(message), 4 + 1_024);
});

test('estimateMessageTokens：其它二进制按长度粗略折算', () => {
	const small = { role: 1, content: [new vscode.LanguageModelDataPart(new Uint8Array(512), 'application/octet-stream')] };
	const large = { role: 1, content: [new vscode.LanguageModelDataPart(new Uint8Array(5_120), 'application/octet-stream')] };

	assert.equal(estimateMessageTokens(small), 4 + 1);
	assert.equal(estimateMessageTokens(large), 4 + 10);
});

test('estimateMessageTokens：回放标记不占上下文', () => {
	const message = { role: 2, content: [createReplayMarkerPart('很长的思考内容'), text('abcd')] };

	assert.equal(estimateMessageTokens(message), 4 + 1);
});

test('estimateMessageTokens：字符串部件与认不出的部件都有兜底', () => {
	assert.equal(estimateMessageTokens({ role: 1, content: ['abcd'] }), 4 + 1);
	// 认不出的对象：只算结构开销，不会崩
	assert.equal(estimateMessageTokens({ role: 1, content: [{ weird: true }] }), 4);
	assert.equal(estimateMessageTokens({ role: 1, content: [undefined] }), 4);
});

test('estimateMessageTokens：思考部件按内容计', () => {
	const withThinking = load(
		{ tokenizer: './src/provider/tokenizer' },
		{ vscode: createVscodeStub({ thinkingPart: true }) },
	);

	const message = {
		role: 2,
		content: [new withThinking.vscode.LanguageModelThinkingPart('想想')],
	};

	assert.equal(withThinking.modules.tokenizer.estimateMessageTokens(message), 4 + 2);
});

/* -------------------------------------------------------------------------- */
/* 统一入口                                                                    */
/* -------------------------------------------------------------------------- */

test('estimateTokens：字符串与消息走不同的路', () => {
	assert.equal(estimateTokens('abcd'), 1);
	assert.equal(estimateTokens({ role: 1, content: [text('abcd')] }), 4 + 1);
});
