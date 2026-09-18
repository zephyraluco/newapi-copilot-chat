import * as assert from 'assert';
import * as vscode from 'vscode';
import { createDefaultAdapterRegistry } from '../adapter/registry';
import { SseTruncatedError } from '../client/sse';
import type { NewApiSettings } from '../config';
import { USAGE_DATA_MIME_TYPE } from '../consts';
import type { ModelConfig } from '../models/modelConfig';
import { NewApiChatProvider } from '../provider/chatProvider';
import type { ChatProviderDeps } from '../provider/chatProvider';
import { convertMessages, convertToolChoice, convertTools } from '../provider/messages';
import { REPLAY_MARKER_MIME, createReplayMarkerPart, parseReplayMarker } from '../provider/replay';
import type { SessionRegistry } from '../runtime/session';
import { parseToolArguments, tryParseToolArguments } from '../provider/stream';
import { supportsThinkingPart } from '../provider/thinking';
import { calibrateCharsPerToken, estimateTextTokens } from '../provider/tokenizer';
import {
	createPreflightCallId,
	filterPreflightMessages,
	inspectActivatePreflight,
} from '../provider/toolFlow';
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

/** 一份最小的模型配置。 */
function createConfig(id = 'test-model'): ModelConfig {
	return {
		id,
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
function createSettings(overrides: { stabilizeToolList?: boolean } = {}): NewApiSettings {
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
			stabilizeToolList: overrides.stabilizeToolList ?? false,
			extraBody: {},
		},
		status: { showStatusBar: false, refreshIntervalMs: 60_000 },
	};
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

suite('provider / 响应回传', () => {
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
	async function runProvider(client: unknown, modelId?: string): Promise<{
		parts: vscode.LanguageModelResponsePart[];
		error: unknown;
	}> {
		const config = createConfig(modelId);
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

	/* ---------------------------------------------------------------------- */
	/* 流被掐断时的处置（重发门）                                              */
	/* ---------------------------------------------------------------------- */

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

	/* ---------------------------------------------------------------------- */
	/* 用量部件（会话信息里的上下文窗口靠它显示 token 数）                      */
	/* ---------------------------------------------------------------------- */

	/** 取出 `usage` 数据部件的载荷。 */
	function usagePayload(parts: readonly vscode.LanguageModelResponsePart[]): Record<string, unknown> | undefined {
		const part = parts.find(
			(item): item is vscode.LanguageModelDataPart =>
				item instanceof vscode.LanguageModelDataPart && item.mimeType === USAGE_DATA_MIME_TYPE,
		);
		return part === undefined
			? undefined
			: JSON.parse(new TextDecoder().decode(part.data)) as Record<string, unknown>;
	}

	test('响应结束时报上用量，且三个数字字段齐（Copilot 的采纳条件）', async () => {
		const client = scriptedClient([[
			{ choices: [{ index: 0, delta: { content: '你好' } }] },
			{
				choices: [],
				usage: {
					prompt_tokens: 1200,
					completion_tokens: 30,
					completion_tokens_details: { reasoning_tokens: 20 },
					prompt_tokens_details: { cached_tokens: 900 },
				},
			},
		]]);

		const result = await runProvider(client);

		assert.strictEqual(result.error, undefined);
		const payload = usagePayload(result.parts);
		assert.ok(payload !== undefined, '没有用量部件时会话信息会一直显示 0/上限');
		assert.strictEqual(payload.prompt_tokens, 1200);
		assert.strictEqual(payload.completion_tokens, 30);
		assert.strictEqual(payload.total_tokens, 1230);
		assert.deepStrictEqual(payload.prompt_tokens_details, { cached_tokens: 900 });
		assert.deepStrictEqual(payload.completion_tokens_details, { reasoning_tokens: 20 });
	});

	test('上游只给部分用量时也把缺的字段补成数字', async () => {
		const client = scriptedClient([[
			{ choices: [{ index: 0, delta: { content: '你好' } }] },
			{ choices: [], usage: { completion_tokens: 7 } },
		]]);

		const payload = usagePayload((await runProvider(client)).parts);

		assert.ok(payload !== undefined);
		assert.strictEqual(payload.prompt_tokens, 0);
		assert.strictEqual(payload.completion_tokens, 7);
		assert.strictEqual(payload.total_tokens, 7, '缺 total_tokens 时按分项补齐');
	});

	test('上游没给用量时不发部件（不是发一个全 0 的）', async () => {
		const client = scriptedClient([[
			{ choices: [{ index: 0, delta: { content: '你好' } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
		]]);

		const result = await runProvider(client);

		assert.strictEqual(usagePayload(result.parts), undefined);
		assert.deepStrictEqual(textsOf(result.parts), ['你好'], '回答本身照常给出去');
	});

	test('流被掐断但内容已给出时同样报用量（token 已经花掉了）', async () => {
		const client = scriptedClient([[
			{ choices: [{ index: 0, delta: { content: '前半段' } }] },
			{ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } },
			new SseTruncatedError(2),
		]]);

		const result = await runProvider(client);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(usagePayload(result.parts)?.prompt_tokens, 100);
	});

	/* ---------------------------------------------------------------------- */
	/* 思考内容的回放标记（下次请求要回填 reasoning_content）                    */
	/* ---------------------------------------------------------------------- */

	/** 取出回放标记部件。 */
	function markerOf(parts: readonly vscode.LanguageModelResponsePart[]): vscode.LanguageModelDataPart | undefined {
		return parts.find(
			(part): part is vscode.LanguageModelDataPart =>
				part instanceof vscode.LanguageModelDataPart && part.mimeType === REPLAY_MARKER_MIME,
		);
	}

	/** 一段「思考 + 正文 + 收尾」的响应。 */
	function scriptWithReasoning(): readonly ChatCompletionChunk[] {
		return [
			{ choices: [{ index: 0, delta: { reasoning_content: '先看调用链' } }] },
			{ choices: [{ index: 0, delta: { content: '答案' } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
		];
	}

	test('DeepSeek：思考内容随响应一起留下，供下次请求回填', async () => {
		const client = scriptedClient([scriptWithReasoning()]);

		const result = await runProvider(client, 'deepseek-chat');

		assert.strictEqual(result.error, undefined);
		const marker = markerOf(result.parts);
		assert.ok(marker !== undefined, '没有标记，下一轮就凑不出 DeepSeek 要求的 reasoning_content');
		assert.strictEqual(parseReplayMarker(marker.data), '先看调用链');
		assert.strictEqual(result.parts[result.parts.length - 1], marker, '标记必须在回答之后');
	});

	test('非 DeepSeek 模型不留标记（上游不认这个字段）', async () => {
		const client = scriptedClient([scriptWithReasoning()]);

		const result = await runProvider(client);

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(markerOf(result.parts), undefined);
		assert.deepStrictEqual(textsOf(result.parts), ['答案']);
	});

	test('上游没给思考内容时不发空标记', async () => {
		const client = scriptedClient([[
			{ choices: [{ index: 0, delta: { content: '答案' } }] },
			{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
		]]);

		const result = await runProvider(client, 'deepseek-chat');

		assert.strictEqual(markerOf(result.parts), undefined);
	});
});

/* -------------------------------------------------------------------------- */
/* 思考内容回填                                                                */
/* -------------------------------------------------------------------------- */

suite('provider / 思考内容回填', () => {
	/** 一条「助手回答了正文，并把思考留在回放标记里」的历史消息。 */
	function historyWithReasoning(): vscode.LanguageModelChatRequestMessage {
		return createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
			new vscode.LanguageModelTextPart('答案'),
			createReplayMarkerPart('我想过了'),
		]);
	}

	test('上游要求回填时，标记里的思考变成 reasoning_content', () => {
		const result = convertMessages([historyWithReasoning()], testLogger(), { echoReasoningContent: true });

		assert.strictEqual(result.messages[0].reasoning_content, '我想过了');
		assert.strictEqual(result.messages[0].content, '答案', '标记本身不是内容');
	});

	test('默认不回填：标记既不进正文，也不会被当成内容发出去', () => {
		const result = convertMessages([historyWithReasoning()], testLogger());

		assert.strictEqual(result.messages[0].reasoning_content, undefined);
		assert.strictEqual(result.messages[0].content, '答案');
	});

	test('标记落在用户消息里时也不会变成正文', () => {
		const result = convertMessages([
			createMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelTextPart('继续'),
				createReplayMarkerPart('早先的思考'),
			]),
		], testLogger());

		assert.strictEqual(result.messages.length, 1);
		assert.strictEqual(result.messages[0].content, '继续');
	});

	test('没有标记时退回到宿主给的思考部件', () => {
		if (!supportsThinkingPart()) {
			return;
		}
		const Part = (vscode as unknown as {
			LanguageModelThinkingPart: new (value: string) => object;
		}).LanguageModelThinkingPart;
		const result = convertMessages([
			createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelTextPart('答案'),
				new Part('来自思考部件'),
			]),
		], testLogger(), { echoReasoningContent: true });

		assert.strictEqual(result.messages[0].reasoning_content, '来自思考部件');
		assert.strictEqual(result.messages[0].content, '答案', '思考内容不能混进正文');
	});
});

/* -------------------------------------------------------------------------- */
/* 工具组预激活                                                                */
/* -------------------------------------------------------------------------- */

suite('provider / 工具组预激活', () => {
	/** 宿主给出的虚拟「工具组」工具。 */
	function activateTool(name: string): vscode.LanguageModelChatTool {
		return { name, description: '' };
	}

	/** 一个「被调用就记一次」的假客户端。 */
	function scriptedClient(): {
		readonly calls: number;
		streamChatCompletion(): AsyncGenerator<ChatCompletionChunk>;
	} {
		let calls = 0;
		return {
			get calls(): number {
				return calls;
			},
			async *streamChatCompletion(): AsyncGenerator<ChatCompletionChunk> {
				calls++;
				yield { choices: [{ index: 0, delta: { content: '回答' } }] };
			},
		};
	}

	/** 走一遍真实的 provider，只关心「有没有请求上游」与上报了哪些部件。 */
	async function run(input: {
		client: unknown;
		tools: readonly vscode.LanguageModelChatTool[];
		messages: readonly vscode.LanguageModelChatRequestMessage[];
	}): Promise<{ parts: vscode.LanguageModelResponsePart[]; error: unknown }> {
		const deps = {
			logger: capturingLogger().logger,
			sessions: {
				find: () => ({ client: input.client }),
				onDidChange: () => ({ dispose: () => { /* 用例里不关心模型列表变化 */ } }),
			},
			adapters: createDefaultAdapterRegistry(),
			getSettings: () => createSettings({ stabilizeToolList: true }),
		} as unknown as ChatProviderDeps;
		const provider = new NewApiChatProvider(deps);
		const tokenSource = new vscode.CancellationTokenSource();
		const parts: vscode.LanguageModelResponsePart[] = [];
		let error: unknown;

		try {
			await provider.provideLanguageModelChatResponse(
				{
					id: 'test-model',
					name: 'Test Model',
					family: 'test-model',
					version: '1',
					maxInputTokens: 120_000,
					maxOutputTokens: 8_192,
					capabilities: { imageInput: false, toolCalling: true },
					config: createConfig(),
					targetKey: 'key',
					targetLabel: '测试组',
				},
				input.messages,
				{
					tools: input.tools,
					toolMode: vscode.LanguageModelChatToolMode.Auto,
				} as vscode.ProvideLanguageModelChatResponseOptions,
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

	/** 一条普通用户消息。 */
	function ask(): vscode.LanguageModelChatRequestMessage {
		return createMessage(vscode.LanguageModelChatMessageRole.User, [
			new vscode.LanguageModelTextPart('帮我看看这个仓库'),
		]);
	}

	test('过滤：伪调用与它们的结果不会发给上游', () => {
		const callId = createPreflightCallId(1, 'activate_gitkraken');
		const filtered = filterPreflightMessages([
			createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelToolCallPart(callId, 'activate_gitkraken', {}),
				new vscode.LanguageModelTextPart(''),
			]),
			createMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart('已展开')]),
				new vscode.LanguageModelTextPart('继续'),
			]),
		]);

		assert.strictEqual(filtered.length, 1, '只剩伪调用的那条消息应当整条丢掉');
		assert.strictEqual(filtered[0].content.length, 1, '伪调用的结果也要删掉，但用户的话要保留');
		assert.ok(filtered[0].content[0] instanceof vscode.LanguageModelTextPart);
	});

	test('识别：已经激活过的工具组不再重复激活', () => {
		const callId = createPreflightCallId(1, 'activate_a');
		// 真实顺序：用户开口 → 助手上报伪调用 → 用户消息里带回它的结果
		const messages = [
			ask(),
			createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelToolCallPart(callId, 'activate_a', {}),
			]),
			createMessage(vscode.LanguageModelChatMessageRole.User, [
				new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart('已展开')]),
			]),
		];

		const preflight = inspectActivatePreflight(messages, [activateTool('activate_a'), activateTool('activate_b')]);

		assert.strictEqual(preflight.rounds, 1);
		assert.deepStrictEqual(preflight.remaining, ['activate_b']);
	});

	test('有待激活的工具组时只上报伪调用，不请求上游', async () => {
		const client = scriptedClient();

		const result = await run({ client, tools: [activateTool('activate_pylance')], messages: [ask()] });

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(client.calls, 0, '展开工具组要用一次请求换下一轮，不必先问上游');
		const calls = result.parts.filter(
			(part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart,
		);
		assert.deepStrictEqual(calls.map(call => call.name), ['activate_pylance']);
		assert.ok(calls[0].callId.startsWith('newapi-preflight-'), '伪调用要能被下一轮认出来');
	});

	test('工具组已经激活过时正常请求上游', async () => {
		const callId = createPreflightCallId(1, 'activate_pylance');
		const client = scriptedClient();

		const result = await run({
			client,
			tools: [activateTool('activate_pylance')],
			messages: [
				ask(),
				createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
					new vscode.LanguageModelToolCallPart(callId, 'activate_pylance', {}),
				]),
				createMessage(vscode.LanguageModelChatMessageRole.User, [
					new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart('已展开')]),
				]),
			],
		});

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(client.calls, 1);
	});

	test('没有 activate_* 工具时不受影响', async () => {
		const client = scriptedClient();

		const result = await run({ client, tools: [activateTool('read_file')], messages: [ask()] });

		assert.strictEqual(result.error, undefined);
		assert.strictEqual(client.calls, 1);
	});

	test('工具组迟迟展不开时报错，而不是一轮接一轮地重试', async () => {
		const client = scriptedClient();
		const messages = [
			ask(),
			createMessage(vscode.LanguageModelChatMessageRole.Assistant, [
				new vscode.LanguageModelToolCallPart(createPreflightCallId(1, 'activate_a'), 'activate_a', {}),
				new vscode.LanguageModelToolCallPart(createPreflightCallId(2, 'activate_a'), 'activate_a', {}),
			]),
		];

		const result = await run({
			client,
			tools: [activateTool('activate_a'), activateTool('activate_b')],
			messages,
		});

		assert.ok(result.error instanceof Error);
		assert.strictEqual(client.calls, 0);
	});
});

/* -------------------------------------------------------------------------- */
/* token 比例校准                                                              */
/* -------------------------------------------------------------------------- */

suite('provider / token 比例校准', () => {
	test('朝观测值缓慢移动，而不是一步到位', () => {
		assert.strictEqual(calibrateCharsPerToken(4_000, 1_000, 4), 4, '观测值与当前一致时不变');
		const lowered = calibrateCharsPerToken(4_000, 2_000, 4);
		assert.ok(Math.abs(lowered - 3.4) < 1e-9, `期望 4×0.7 + 2×0.3 = 3.4，实际 ${lowered}`);
	});

	test('拿不到用量或请求为空时保持不变', () => {
		assert.strictEqual(calibrateCharsPerToken(1_000, undefined, 4), 4);
		assert.strictEqual(calibrateCharsPerToken(1_000, 0, 4), 4, '上游报 0 不能拿来当除数');
		assert.strictEqual(calibrateCharsPerToken(0, 100, 4), 4);
	});

	test('离谱的观测值被夹在合理区间内', () => {
		// 上游少报 token（观测比例 0.001）不能让估算一路涨上去
		const lowered = calibrateCharsPerToken(10, 10_000, 4);
		assert.ok(lowered >= 1 && lowered < 4, `实际 ${lowered}`);

		// 上游多报 token（观测比例 100000）也不能把比例推到天上
		const raised = calibrateCharsPerToken(1_000_000, 10, 4);
		assert.ok(raised <= 16, `实际 ${raised}`);
	});
});