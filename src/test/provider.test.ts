import * as assert from 'assert';
import * as vscode from 'vscode';
import { createDefaultAdapterRegistry } from '../adapter/registry';
import { SseTruncatedError } from '../client/sse';
import type { NewApiSettings } from '../config';
import type { ModelConfig } from '../models/modelConfig';
import { NewApiChatProvider } from '../provider/chatProvider';
import type { ChatProviderDeps } from '../provider/chatProvider';
import { convertMessages, convertToolChoice, convertTools } from '../provider/messages';
import type { SessionRegistry } from '../provider/session';
import { parseToolArguments, tryParseToolArguments } from '../provider/stream';
import { estimateTextTokens } from '../provider/tokenizer';
import type { ChatCompletionChunk } from '../types';
import { capturingLogger, testLogger } from './helpers';

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
	test('缺少 inputSchema 的工具按零参数工具发送', () => {
		// 宿主对零参数工具不声明 schema（如 activate_* / terminal_last_command），
		// 丢掉它们会让模型完全看不到这些工具。
		const captured = capturingLogger();
		const tools = convertTools(
			[
				{ name: 'with_schema', description: 'ok', inputSchema: { type: 'object' } },
				{ name: 'without_schema', description: 'no args' },
			],
			captured.logger,
		);
		assert.strictEqual(tools?.length, 2);
		assert.strictEqual(tools?.[1].function.name, 'without_schema');
		assert.deepStrictEqual(tools?.[1].function.parameters, { type: 'object', properties: {} });
		// 这是正常情况，不该刷警告
		assert.deepStrictEqual(captured.messages('warn'), []);
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

	test('tryParseToolArguments 用 undefined 区分「能不能解析」', () => {
		// flush 靠这个区分来决定是「丢掉这次调用」（流被截断）还是「空参数上报」
		assert.deepStrictEqual(tryParseToolArguments('{"path":"a.ts"}', testLogger(), 'read'), { path: 'a.ts' });
		assert.deepStrictEqual(tryParseToolArguments('', testLogger(), 'read'), {}, '零参数工具是合法情况');
		assert.strictEqual(tryParseToolArguments('{"path":"a', testLogger(), 'read'), undefined);
	});
});

suite('provider / 流被掐断后的重发', () => {
	/** 一份最小的模型配置。 */
	function createConfig(): ModelConfig {
		return {
			id: 'test-model',
			name: 'Test Model',
			detail: '',
			family: 'test-model',
			version: '1',
			tooltip: '',
			contextWindow: 128_000,
			maxInputTokens: 120_000,
			maxOutputTokens: 8_192,
			imageInput: false,
			toolCalling: false,
			reasoning: false,
			reasoningEfforts: [],
			meta: { provenance: {} },
		};
	}

	/** 一份最小的设置。 */
	function createSettings(): NewApiSettings {
		return {
			logLevel: 'off',
			models: {
				include: [],
				exclude: [],
				cacheTtlMs: 300_000,
				defaultContextWindow: 128_000,
				defaultMaxOutputTokens: 8_192,
			},
			request: {
				timeoutMs: 60_000,
				streamIdleTimeoutMs: 60_000,
				includeUsage: true,
				maxRetries: 0,
				temperature: undefined,
				topP: undefined,
				includeReasoning: false,
				extraBody: {},
			},
			status: { showStatusBar: false, refreshIntervalMs: 60_000 },
		};
	}

	/**
	 * 按脚本产出 chunk 的假客户端：脚本项是 `Error` 就抛出来（模拟连接被掐断），否则依次吐出。
	 * 轮次超出脚本长度时重复最后一段，便于写「每一轮都一样」的用例。
	 */
	function scriptedClient(scripts: readonly (readonly (ChatCompletionChunk | Error)[])[]): {
		readonly calls: number;
		streamChatCompletion(): AsyncGenerator<ChatCompletionChunk>;
	} {
		let calls = 0;
		return {
			get calls(): number {
				return calls;
			},
			async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
				const script = scripts[Math.min(calls, scripts.length - 1)] ?? [];
				calls++;
				for (const item of script) {
					if (item instanceof Error) {
						throw item;
					}
					yield item;
				}
			},
		};
	}

	/** 走一遍真实的 `provideLanguageModelChatResponse`。 */
	async function runProvider(client: unknown): Promise<{
		parts: vscode.LanguageModelResponsePart[];
		error: unknown;
	}> {
		const config = createConfig();
		const deps = {
			logger: capturingLogger().logger,
			sessions: {
				find: () => ({ client }),
				onDidChange: () => ({ dispose: () => { /* 用例里不关心模型列表变化 */ } }),
			},
			adapters: createDefaultAdapterRegistry(),
			getSettings: () => createSettings(),
		} as unknown as ChatProviderDeps;
		const provider = new NewApiChatProvider(deps);
		const tokenSource = new vscode.CancellationTokenSource();
		const parts: vscode.LanguageModelResponsePart[] = [];
		let error: unknown;

		try {
			await provider.provideLanguageModelChatResponse(
				{
					id: config.id,
					name: config.name,
					family: config.family,
					version: config.version,
					maxInputTokens: config.maxInputTokens,
					maxOutputTokens: config.maxOutputTokens,
					capabilities: { imageInput: false, toolCalling: false },
					config,
					targetKey: 'key',
					targetLabel: '测试组',
				},
				[createMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart('你好')])],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto } as vscode.ProvideLanguageModelChatResponseOptions,
				{ report: part => parts.push(part) },
				tokenSource.token,
			);
		} catch (caught) {
			error = caught;
		} finally {
			tokenSource.dispose();
			provider.dispose();
		}

		return { parts, error };
	}

	/** 取出上报的文本。 */
	function textsOf(parts: readonly vscode.LanguageModelResponsePart[]): string[] {
		return parts
			.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
			.map(part => part.value);
	}

	test('什么都没上报就被掐断时重发整次请求', async () => {
		const client = scriptedClient([
			[new SseTruncatedError(0)],
			[
				{ choices: [{ index: 0, delta: { content: '完整的回答' } }] },
				{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
			],
		]);

		const result = await runProvider(client);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(client.calls, 2, '第一次什么都没上报，重发是安全的');
		assert.deepStrictEqual(textsOf(result.parts), ['完整的回答']);
	});

	test('已经流给用户的内容不会重发（否则两段回答会拼在一起）', async () => {
		const client = scriptedClient([
			[
				{ choices: [{ index: 0, delta: { content: '前半段' } }] },
				new SseTruncatedError(1),
			],
			[{ choices: [{ index: 0, delta: { content: '不该出现' } }] }],
		]);

		const result = await runProvider(client);

		assert.strictEqual(result.error, undefined, '已经有能用的回答，不该再弹错误让人重试');
		assert.strictEqual(client.calls, 1);
		assert.deepStrictEqual(textsOf(result.parts), ['前半段']);
	});

	test('重发次数用尽后把截断错误报给 VS Code', async () => {
		const client = scriptedClient([[new SseTruncatedError(0)]]);

		const result = await runProvider(client);

		assert.ok(result.error instanceof Error);
		assert.ok((result.error as Error).message.includes('断开'));
		assert.strictEqual(client.calls, 3, '首次 + 两次重发');
	});
});
