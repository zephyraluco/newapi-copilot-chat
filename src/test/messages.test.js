'use strict';

/**
 * provider/messages.ts（加上它消费的 replay / thinking 两个部件模块）：VS Code ⇄ OpenAI 兼容的消息转换。
 *
 * 转换靠 `instanceof` 认部件，因此替身里的类必须与被测模块看到的是同一批（同一次 `load` 里加载）。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { createVscodeStub } = require('./fakes');

const { modules, vscode } = load({
	messages: './src/host/messages',
	protocolMessages: './src/protocol/messages',
	replay: './src/host/replay',
	thinking: './src/host/thinking',
});

const { convertMessages } = modules.messages;
const { measureRequestText } = modules.protocolMessages;
const { createReplayMarkerPart, REPLAY_MARKER_MIME } = modules.replay;

/** 默认替身不提供思考部件。 */
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

test('工具结果里的非图片数据部件被忽略，已知文本照常保留', () => {
	const json = new vscode.LanguageModelDataPart(new TextEncoder().encode('{"a":1}'), 'application/json');
	const binary = new vscode.LanguageModelDataPart(new Uint8Array(300), 'application/octet-stream');

	const result = convertMessages([userMessage([toolResult('call_1', [text('ok'), json, binary])])], logger);

	assert.equal(result.messages[0].content, 'ok');
});

test('cache_control 与未知控制部件不会污染用户、助手和工具正文', () => {
	const control = new vscode.LanguageModelDataPart(new Uint8Array(9), 'cache_control');
	const unknown = { type: 'metadata', internal: true };
	const result = convertMessages([
		userMessage([text('hi'), control, unknown]),
		assistantMessage([text('ok'), control, unknown]),
		userMessage([toolResult('call_1', [text('done'), control, unknown, createReplayMarkerPart('内部思考')])]),
	], logger);
	assert.deepEqual(result.messages, [
		{ role: 'user', content: 'hi' },
		{ role: 'assistant', content: 'ok' },
		{ role: 'tool', tool_call_id: 'call_1', content: 'done' },
	]);
});

test('工具结果图片与文字保留为多模态内容，多个结果保持调用对应关系', () => {
	const png = new vscode.LanguageModelDataPart(new Uint8Array([137, 80, 78, 71]), 'image/png');
	const result = convertMessages([
		assistantMessage([toolCall('shot', 'screenshot', {}), toolCall('file', 'read_file', {})]),
		userMessage([toolResult('shot', [text('截图'), png]), toolResult('file', [text('代码')]), text('继续')]),
	], logger);
	assert.deepEqual(result.messages.slice(1), [
		{ role: 'tool', tool_call_id: 'shot', content: [
			{ type: 'text', text: '截图' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw==' } },
		] },
		{ role: 'tool', tool_call_id: 'file', content: '代码' },
		{ role: 'user', content: '继续' },
	]);
});

test('工具结果只有图片时保留图片，只有未知数据时保留工具结果占位', () => {
	const png = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3, 4]), 'image/png');
	const control = new vscode.LanguageModelDataPart(new Uint8Array(9), 'cache_control');
	const result = convertMessages([userMessage([
		toolResult('image', [png]), toolResult('empty', [control]),
	])], logger);
	assert.deepEqual(result.messages, [
		{ role: 'tool', tool_call_id: 'image', content: [
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } },
		] },
		{ role: 'tool', tool_call_id: 'empty', content: '(工具没有返回内容)' },
	]);
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

test('不支持的图片类型被忽略，不生成二进制占位文本', () => {
	const bmp = new vscode.LanguageModelDataPart(new Uint8Array(10), 'image/bmp');
	const result = convertMessages([userMessage([bmp])], logger);

	assert.deepEqual(result.messages, []);
	assert.equal(result.skipped, 1);
});

test('空的图片数据不作为图片发送，只留警告', () => {
	const empty = new vscode.LanguageModelDataPart(new Uint8Array(0), 'image/png');
	const result = convertMessages([userMessage([empty])], logger);

	assert.equal(result.warnings.length, 1);
	assert.match(result.warnings[0], /空的图片/);
	assert.deepEqual(result.messages, []);
	assert.equal(result.skipped, 1);
});

test('助手只有图片时也保留多模态内容', () => {
	const png = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3, 4]), 'image/png');
	const result = convertMessages([assistantMessage([png])], logger);
	assert.deepEqual(result.messages, [{ role: 'assistant', content: [
		{ type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } },
	] }]);
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
			messages: './src/host/messages',
			replay: './src/host/replay',
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
			messages: './src/host/messages',
			replay: './src/host/replay',
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

test('measureRequestText：只数文本、工具调用、工具定义与回填的思考，且 CJK 分开数', () => {
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
				// 图片以 data URL 传输，字符数与 token 无关，不计入
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
			],
		},
	];
	const tools = [
		{ type: 'function', function: { name: 'lookup', description: 'abcd', parameters: { a: 1 } } },
	];

	// CJK：想想(2) + 看这个(3)
	// 非 CJK：read_file(9) + {"path":"a"}(12) + lookup(6) + abcd(4) + {"a":1}(7)
	assert.deepEqual(measureRequestText(messages, tools), { cjkChars: 5, otherChars: 38 });
});

test('measureRequestText：工具定义要计入（漏掉会把校准比例压到下限）', () => {
	const messages = [{ role: 'user', content: 'abcd' }];
	const tools = [{ type: 'function', function: { name: 'lookup' } }];

	assert.equal(measureRequestText(messages, undefined).otherChars, 4);
	assert.equal(measureRequestText(messages, tools).otherChars, 4 + 6);
	assert.equal(measureRequestText(messages, []).otherChars, 4);
});
