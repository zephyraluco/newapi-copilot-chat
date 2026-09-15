import * as assert from 'assert';
import * as vscode from 'vscode';
import { convertMessages, convertToolChoice, convertTools } from '../provider/messages';
import { parseToolArguments } from '../provider/stream';
import { estimateTextTokens } from '../provider/tokenizer';
import { testLogger } from './helpers';

/** 这些测试覆盖「格式转换」这类最容易出错、也最难靠肉眼发现的逻辑。 */

/** 构造一个 VS Code 请求消息。 */
function createMessage(
	role: vscode.LanguageModelChatMessageRole,
	content: readonly unknown[],
	name?: string,
): vscode.LanguageModelChatRequestMessage {
	return { role, content, name };
}

suite('provider / token 估算', () => {
	test('英文按 4 字符 ≈ 1 token', () => {
		assert.strictEqual(estimateTextTokens(''), 0);
		assert.strictEqual(estimateTextTokens('abcd'), 1);
		assert.strictEqual(estimateTextTokens('abcde'), 2);
	});

	test('中文按 1 字符 ≈ 1 token', () => {
		assert.strictEqual(estimateTextTokens('你好世界'), 4);
	});

	test('中英混排分别计算', () => {
		// 4 个汉字 + 4 个 ASCII 字符 → 4 + 1
		assert.strictEqual(estimateTextTokens('你好世界abcd'), 5);
	});

	test('高估优于低估：长文本估算值不小于字符数除以 4', () => {
		const text = 'This is a fairly long English sentence used for estimation.';
		assert.ok(estimateTextTokens(text) >= Math.floor(text.length / 4));
	});
});

suite('provider / 消息转换', () => {
	test('普通用户消息转成 user 角色', () => {
		const result = convertMessages(
			[createMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart('你好')])],
			testLogger(),
		);
		assert.strictEqual(result.messages.length, 1);
		assert.strictEqual(result.messages[0].role, 'user');
		assert.strictEqual(result.messages[0].content, '你好');
	});

	test('name 为 system 的用户消息被提升为 system 角色', () => {
		const result = convertMessages(
			[createMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart('你是助手')], 'system')],
			testLogger(),
		);
		assert.strictEqual(result.messages[0].role, 'system');
	});

	test('助手消息里的工具调用转成 tool_calls，且 content 为 null', () => {
		const result = convertMessages(
			[createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelToolCallPart('call_1', 'file_search', { query: 'abc' }),
			])],
			testLogger(),
		);
		const message = result.messages[0];
		assert.strictEqual(message.role, 'assistant');
		// OpenAI 约定：带 tool_calls 时 content 必须是 null
		assert.strictEqual(message.content, null);
		assert.strictEqual(message.tool_calls?.[0].id, 'call_1');
		assert.strictEqual(message.tool_calls?.[0].function.name, 'file_search');
		assert.strictEqual(message.tool_calls?.[0].function.arguments, '{"query":"abc"}');
	});

	test('工具结果被拆成独立的 tool 消息，且排在用户内容之前', () => {
		const result = convertMessages(
			[
				createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelToolCallPart('call_1', 'file_search', {}),
				]),
				createMessage(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('结果是 42')]),
					new vscode.LanguageModelTextPart('继续'),
				]),
			],
			testLogger(),
		);
		assert.strictEqual(result.messages.length, 3);
		assert.deepStrictEqual(result.messages.map(m => m.role), ['assistant', 'tool', 'user']);
		assert.strictEqual(result.messages[1].tool_call_id, 'call_1');
		assert.strictEqual(result.messages[1].content, '结果是 42');
		assert.strictEqual(result.messages[2].content, '继续');
	});

	test('图片被转成 data URL 形式的多模态内容', () => {
		const result = convertMessages(
			[createMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart('看这张图'),
				new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
			])],
			testLogger(),
		);
		const content = result.messages[0].content;
		assert.ok(Array.isArray(content), '含图片时应使用内容片段数组');
		assert.strictEqual(content[0].type, 'text');
		assert.strictEqual(content[1].type, 'image_url');
		assert.ok(content[1].image_url?.url.startsWith('data:image/png;base64,'));
	});

	test('空消息被跳过并计数', () => {
		const result = convertMessages(
			[
				createMessage(vscode.LanguageModelChatMessageRole.User, []),
				createMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart('有效')]),
			],
			testLogger(),
		);
		assert.strictEqual(result.messages.length, 1);
		assert.strictEqual(result.skipped, 1);
	});
});

suite('provider / 工具转换', () => {
	test('缺少 inputSchema 的工具被跳过', () => {
		const tools = convertTools(
			[
				{ name: 'with_schema', description: 'ok', inputSchema: { type: 'object' } },
				{ name: 'without_schema', description: 'skip' },
			],
			testLogger(),
		);
		assert.strictEqual(tools?.length, 1);
		assert.strictEqual(tools?.[0].function.name, 'with_schema');
	});

	test('没有工具时返回 undefined 而不是空数组', () => {
		assert.strictEqual(convertTools(undefined, testLogger()), undefined);
		assert.strictEqual(convertTools([], testLogger()), undefined);
	});

	test('工具选择模式映射正确', () => {
		assert.strictEqual(convertToolChoice(vscode.LanguageModelChatToolMode.Required, true), 'required');
		assert.strictEqual(convertToolChoice(vscode.LanguageModelChatToolMode.Auto, true), 'auto');
		// 没有工具时不能下发 tool_choice，否则部分上游会报错
		assert.strictEqual(convertToolChoice(vscode.LanguageModelChatToolMode.Auto, false), undefined);
	});
});

suite('provider / 工具参数解析', () => {
	test('直接解析合法 JSON', () => {
		assert.deepStrictEqual(parseToolArguments('{"path":"a.ts"}', testLogger(), 'read'), { path: 'a.ts' });
	});

	test('空字符串视为空参数', () => {
		assert.deepStrictEqual(parseToolArguments('', testLogger(), 'read'), {});
	});

	test('剥离 Markdown 代码块后解析', () => {
		const raw = '```json\n{"path":"a.ts"}\n```';
		assert.deepStrictEqual(parseToolArguments(raw, testLogger(), 'read'), { path: 'a.ts' });
	});

	test('无法解析时返回空对象而不是抛异常', () => {
		// 返回空对象能让 VS Code 报出参数校验失败，模型有机会自我修正；
		// 直接抛异常会中断整个回答。
		assert.deepStrictEqual(parseToolArguments('not json at all', testLogger(), 'read'), {});
	});
});
