'use strict';

/**
 * provider/messages.ts（加上它消费的 replay / thinking 两个部件模块）：VS Code ⇄ OpenAI 兼容的消息转换。
 *
 * 这里用 `fakes.js` 里的 `vscode` 替身——转换靠 `instanceof` 认部件，因此替身里的类必须与
 * 被测模块看到的是同一批（同一次 `load` 里加载即可）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { createVscodeStub } = require('./fakes');

const { modules, vscode } = load({
	messages: './src/provider/messages',
	replay: './src/provider/replay',
	thinking: './src/provider/thinking',
});

const { convertMessages, countRequestChars } = modules.messages;
const { createReplayMarkerPart, REPLAY_MARKER_MIME } = modules.replay;

/** 不提供思考部件的宿主（默认情形）。 */
const logger = createLogger();

/** 用户在消息里发文字。 */
function userMessage(content) {
	return { role: vscode.LanguageModelChatMessageRole.User, content };
}

/** 助手回消息。 */
function assistantMessage(content) {
	return { role: vscode.LanguageModelChatMessageRole.Assistant, content };
}

const text = value => new vscode.LanguageModelTextPart(value);
const toolCall = (callId, name, input) => new vscode.LanguageModelToolCallPart(callId, name, input);
const toolResult = (callId, content) => new vscode.LanguageModelToolResultPart(callId, content);

/* -------------------------------------------------------------------------- */
/* 基础转换                                                                    */
/* -------------------------------------------------------------------------- */

test('文本消息按角色直译', () => {
	const result = convertMessages([
		userMessage([text('你好')]),
		assistantMessage([text('在的')]),
	], logger);

	assert.deepEqual(result.messages, [
		{ role: 'user', content: '你好' },
		{ role: 'assistant', content: '在的' },
	]);
	assert.equal(result.skipped, 0);
});

test('同一条消息里的多个文本部件会拼起来', () => {
	const result = convertMessages([userMessage([text('前半'), text('后半')])], logger);
	assert.deepEqual(result.messages, [{ role: 'user', content: '前半后半' }]);
});

test('名为 system 的用户消息被提升为 system 角色', () => {
	const result = convertMessages([
		{ role: vscode.LanguageModelChatMessageRole.User, name: 'system', content: [text('你是助手')] },
		// 普通用户消息上的 name 会保留
		{ role: vscode.LanguageModelChatMessageRole.User, name: 'nickel', content: [text('你好')] },
	], logger);

	assert.deepEqual(result.messages, [
		{ role: 'system', content: '你是助手' },
		{ role: 'user', content: '你好', name: 'nickel' },
	]);
});

test('空消息被跳过并计数', () => {
	const result = convertMessages([
		userMessage([text('')]),
		userMessage([]),
		assistantMessage([text('')]),
		userMessage([text('有内容')]),
	], logger);

	assert.deepEqual(result.messages, [{ role: 'user', content: '有内容' }]);
	assert.equal(result.skipped, 3);
	assert.match(logger.messages('debug').join(' '), /跳过/);
});

test('没有 name 的助手消息不会带 name 字段', () => {
	const result = convertMessages([assistantMessage([text('答案')])], logger);
	assert.equal('name' in result.messages[0], false);
});

/* -------------------------------------------------------------------------- */
/* 工具调用与工具结果                                                          */
/* -------------------------------------------------------------------------- */

test('助手的工具调用转成 tool_calls，且 content 为 null', () => {
	const result = convertMessages([
		assistantMessage([toolCall('call_1', 'read_file', { path: 'a.ts' })]),
	], logger);

	assert.deepEqual(result.messages, [
		{
			role: 'assistant',
			content: null,
			tool_calls: [
				{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
			],
		},
	]);
});

test('助手既有正文又有工具调用时，两者都保留', () => {
	const result = convertMessages([
		assistantMessage([text('我看一下'), toolCall('call_1', 'read_file', {})]),
	], logger);

	assert.equal(result.messages[0].content, '我看一下');
	assert.equal(result.messages[0].tool_calls.length, 1);
});

test('工具结果被拆成独立的 tool 消息，且排在用户内容之前', () => {
	const result = convertMessages([
		userMessage([toolResult('call_1', [text('文件内容')]), text('继续')]),
	], logger);

	assert.deepEqual(result.messages, [
		{ role: 'tool', tool_call_id: 'call_1', content: '文件内容' },
		{ role: 'user', content: '继续' },
	]);
});

test('只有工具结果的用户消息会被整体丢掉', () => {
	const result = convertMessages([userMessage([toolResult('call_1', [text('ok')])])], logger);

	assert.deepEqual(result.messages, [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }]);
	assert.equal(result.skipped, 0);
});

test('工具结果为空时给一个占位文本：上游要求 role:tool 的 content 非空', () => {
	const result = convertMessages([userMessage([toolResult('call_1', [])])], logger);

	assert.equal(result.messages[0].content, '(工具没有返回内容)');
});

test('工具结果里的数据部件按 MIME 变成文本', () => {
	const json = new vscode.LanguageModelDataPart(new TextEncoder().encode('{"a":1}'), 'application/json');
	const binary = new vscode.LanguageModelDataPart(new Uint8Array(300), 'application/octet-stream');

	const result = convertMessages([userMessage([toolResult('call_1', [json, binary])])], logger);

	assert.match(result.messages[0].content, /\{"a":1\}/);
	// 二进制不会把乱码塞进上下文，只给一句说明
	assert.match(result.messages[0].content, /300 字节/);
});

/* -------------------------------------------------------------------------- */
/* 图片                                                                        */
/* -------------------------------------------------------------------------- */

test('受支持的图片变成 data URL，并与文本组成多模态内容', () => {
	const png = new vscode.LanguageModelDataPart(new Uint8Array([137, 80, 78, 71]), 'image/png');
	const result = convertMessages([userMessage([text('这是什么'), png])], logger);

	assert.deepEqual(result.messages[0].content, [
		{ type: 'text', text: '这是什么' },
		{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
	]);
});

test('只有图片没有文字时也组成多模态内容', () => {
	const jpeg = new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), 'image/jpeg');
	const result = convertMessages([userMessage([jpeg])], logger);

	assert.equal(result.messages.length, 1);
	assert.equal(Array.isArray(result.messages[0].content), true);
});

test('不支持的图片类型退化成代码块文本，而不是被丢掉', () => {
	const bmp = new vscode.LanguageModelDataPart(new Uint8Array(10), 'image/bmp');
	const result = convertMessages([userMessage([bmp])], logger);

	assert.equal(typeof result.messages[0].content, 'string');
	assert.match(result.messages[0].content, /image\/bmp/);
	assert.match(result.messages[0].content, /```/);
});

test('空的图片数据不作为图片发送，只留警告与占位文本', () => {
	const empty = new vscode.LanguageModelDataPart(new Uint8Array(0), 'image/png');
	const result = convertMessages([userMessage([empty])], logger);

	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /空的图片/);
	// 空图片发出去上游会报错，因此退化成一段文本，而不是把整条消息丢掉
	assert.equal(typeof result.messages[0].content, 'string');
	assert.equal(result.messages[0].content.includes('data:'), false);
});

/* -------------------------------------------------------------------------- */
/* 回放标记与思考部件                                                          */
/* -------------------------------------------------------------------------- */

test('回放标记不会发给上游', () => {
	const marker = createReplayMarkerPart('之前的思考');
	assert.equal(marker.mimeType, REPLAY_MARKER_MIME);

	const result = convertMessages([assistantMessage([text('答案'), marker])], logger);

	assert.deepEqual(result.messages, [{ role: 'assistant', content: '答案' }]);
	// 只有标记的助手消息等于空消息
	assert.equal(convertMessages([assistantMessage([marker])], logger).skipped, 1);
});

test('打开回填时，思考内容写进 reasoning_content', () => {
	const result = convertMessages([
		assistantMessage([text('答案'), createReplayMarkerPart('回放里的思考')]),
	], logger, { echoReasoningContent: true });

	assert.equal(result.messages[0].reasoning_content, '回放里的思考');
});

test('标记缺失时退回宿主给的思考部件', () => {
	const withThinking = load(
		{
			messages: './src/provider/messages',
			replay: './src/provider/replay',
		},
		{ vscode: createVscodeStub({ thinkingPart: true }) },
	);

	const thinking = new withThinking.vscode.LanguageModelThinkingPart('部件里的思考');
	const result = withThinking.modules.messages.convertMessages(
		[{ role: withThinking.vscode.LanguageModelChatMessageRole.Assistant, content: [thinking, new withThinking.vscode.LanguageModelTextPart('答案')] }],
		logger,
		{ echoReasoningContent: true },
	);

	assert.equal(result.messages[0].reasoning_content, '部件里的思考');
});

test('关掉回填时思考内容既不当正文也不写进请求', () => {
	const withThinking = load(
		{
			messages: './src/provider/messages',
			replay: './src/provider/replay',
		},
		{ vscode: createVscodeStub({ thinkingPart: true }) },
	);

	const thinking = new withThinking.vscode.LanguageModelThinkingPart('想了半天');
	const result = withThinking.modules.messages.convertMessages(
		[
			{ role: withThinking.vscode.LanguageModelChatMessageRole.Assistant, content: [thinking, new withThinking.vscode.LanguageModelTextPart('答案')] },
		],
		logger,
	);

	assert.deepEqual(result.messages, [{ role: 'assistant', content: '答案' }]);
});

/* -------------------------------------------------------------------------- */
/* 字符统计                                                                    */
/* -------------------------------------------------------------------------- */

test('countRequestChars：只数文本、工具调用与回填的思考', () => {
	const messages = [
		{
			role: 'assistant',
			content: null,
			tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }],
			reasoning_content: '想想',
		},
		{
			role: 'user',
			content: [
				{ type: 'text', text: '看这个' },
				// 图片以 data URL 传输，字符数与 token 无关，不该计入
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
			],
		},
	];

	// 9 + 12 + 2 + 3
	assert.equal(countRequestChars(messages), 26);
});
