'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger, collect } = require('./helpers');
const { createVscodeStub } = require('./fakes');

const { modules, vscode } = load({
	request: './src/provider/request',
	headers: './src/provider/headers',
	registry: './src/protocol/registry',
	replay: './src/provider/replay',
	flow: './src/provider/streamFlow',
	client: './src/transport/newApiClient',
	provider: './src/provider/chatProvider',
}, { vscode: createVscodeStub({ thinkingPart: true }) });

const logger = { ...createLogger(), child() { return this; } };
const settings = { request: { extraBody: {}, headers: {}, includeReasoning: true, includeUsage: true } };
const config = {
	id: 'deepseek-v4-pro', reasoning: true, toolCalling: true, imageInput: true,
	maxOutputTokens: 8192, reasoningEfforts: ['none', 'high'], defaultReasoningEffort: 'high', meta: {},
};
const user = content => ({ role: vscode.LanguageModelChatMessageRole.User, content });
const assistant = content => ({ role: vscode.LanguageModelChatMessageRole.Assistant, content });
const text = value => new vscode.LanguageModelTextPart(value);
const image = () => new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png');

function prepare(messages, overrides = {}) {
	return modules.request.prepareChatRequest({
		config, settings, messages, options: {},
		adapters: modules.registry.createDefaultAdapterRegistry(), logger, ...overrides,
	});
}

test('工具组由模型正常调用：激活工具直接发送，不生成预激活伪调用', async () => {
	const sent = [];
	const parts = [];
	const provider = new modules.provider.NewApiChatProvider({
		logger, adapters: modules.registry.createDefaultAdapterRegistry(), getSettings: () => settings,
		sessions: { onDidChange: () => ({ dispose() {} }), find: () => ({ client: {
			async *streamChatCompletion(request) {
				sent.push(request);
				yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'model-call',
					function: { name: 'activate_group', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
			},
		} }) },
	});
	try {
		await provider.provideLanguageModelChatResponse({ config, targetKey: 'site', targetLabel: 'site' },
			[user([text('use a tool')])], { tools: [{ name: 'activate_group', description: 'Activate' }] },
			{ report: part => parts.push(part) },
			{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].tools[0].function.name, 'activate_group');
		assert.equal(parts.length, 1);
		assert.equal(parts[0].callId, 'model-call');
	} finally { provider.dispose(); }
});

test('请求准备：辅助请求与默认强度按参考插件发送，协议字段不能被 extraBody 覆盖', async () => {
	const { request } = await prepare([user([text('You are an expert in crafting pithy titles for chat sessions')])], {
		settings: { request: { extraBody: { model: 'wrong', messages: [], temperature: 0.3 } } },
		options: { tools: [{ name: 'read_file', description: 'Read' }], toolMode: vscode.LanguageModelChatToolMode.Required },
	});
	assert.equal(request.model, config.id);
	assert.equal(request.messages.length, 1);
	assert.deepEqual(request.thinking, { type: 'enabled' });
	assert.equal(request.reasoning_effort, 'high');
	assert.equal(request.stream, true);
	assert.equal(request.max_tokens, 8192);
	assert.equal(request.tool_choice, 'auto');
	assert.deepEqual(request.tools[0].function.parameters, { type: 'object', properties: {} });
});

test('请求准备：工具续轮优先恢复回放原文，缺失推理为空串，工具结果 ID 保持一致', async () => {
	const messages = [
		user([text('Read')]),
		assistant([
			new vscode.LanguageModelThinkingPart('宿主思考'),
			modules.replay.createReplayMarkerPart('真实推理'),
			new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' }),
		]),
		user([new vscode.LanguageModelToolResultPart('call-1', [text('result')])]),
		assistant([text('answer')]),
	];
	const { request } = await prepare(messages);
	assert.equal(request.messages[1].content, '');
	assert.equal(request.messages[1].reasoning_content, '真实推理');
	assert.equal(request.messages[1].tool_calls[0].id, 'call-1');
	assert.equal(request.messages[2].tool_call_id, 'call-1');
	assert.equal(request.messages[3].reasoning_content, '');
	const disabled = await prepare(messages, { options: { modelOptions: { reasoningEffort: 'none' } } });
	assert.deepEqual(disabled.request.thinking, { type: 'disabled' });
	assert.equal('reasoning_effort' in disabled.request, false);
});

test('请求准备：图片位置保持不变，文本模型不发送图片字节或工具定义', async () => {
	const messages = [user([text('before'), image(), text('after')])];
	const vision = await prepare(messages);
	assert.equal(vision.hasImages, true);
	assert.deepEqual(vision.request.messages[0].content.map(part => part.type), ['text', 'image_url', 'text']);
	const plain = await prepare(messages, {
		config: { ...config, imageInput: false, toolCalling: false },
		options: { tools: [{ name: 'unused' }] },
	});
	assert.equal(plain.hasImages, false);
	assert.equal(plain.request.messages[0].content, 'beforeafter');
	assert.equal(plain.request.tools, undefined);
});

test('采样参数统一来自 extraBody，未指定时省略，仍受模型能力约束', async () => {
	const plainConfig = { ...config, id: 'plain-model', reasoning: false, samplingParams: undefined };
	const messages = [user([text('hello')])];
	const empty = await prepare(messages, { config: plainConfig });
	assert.equal('temperature' in empty.request, false);
	assert.equal('top_p' in empty.request, false);
	const settings = { request: { extraBody: { temperature: 0.7, top_p: 0.9 } } };
	const configured = await prepare(messages, { config: plainConfig, settings });
	assert.equal(configured.request.temperature, 0.7);
	assert.equal(configured.request.top_p, 0.9);
	const restricted = await prepare(messages, { config: { ...plainConfig, samplingParams: 'never' }, settings });
	assert.equal('temperature' in restricted.request, false);
	assert.equal('top_p' in restricted.request, false);
});

test('请求头模板：会话、工作区、请求 ID 优先级和同次请求随机 ID 一致', () => {
	const resolve = (options, storageUri) => modules.headers.resolveRequestHeaders({
		'a': '${conversationId}', 'b': 'prefix-${conversationId}-${conversationId}',
	}, options, storageUri);
	assert.equal(resolve({ modelOptions: { _conversationId: 'conversation' } }).a, 'conversation');
	assert.equal(resolve({}, { path: '/storage/0123456789abcdef0123456789abcdef-2/publisher.extension' }).a,
		'workspace-0123456789abcdef0123456789abcdef');
	assert.equal(resolve({ modelOptions: { _capturingTokenCorrelationId: 'correlation' } }).a, 'request-correlation');
	const random = resolve({});
	assert.match(random.a, /^request-[0-9a-f-]{36}$/);
	assert.equal(random.b, `prefix-${random.a}-${random.a}`);
});

test('请求准备：工具结果图片遵循模型能力，普通模型不发送 reasoning_content', async () => {
	const messages = [assistant([new vscode.LanguageModelToolCallPart('image-call', 'screenshot', {})]),
		user([new vscode.LanguageModelToolResultPart('image-call', [text('screen'), image()])])];
	const native = await prepare(messages);
	assert.equal(native.hasImages, true);
	assert.equal(native.request.messages[1].content[1].type, 'image_url');
	const plain = await prepare(messages, { config: { ...config, id: 'plain', reasoning: false, imageInput: false } });
	assert.equal(plain.request.messages[1].content, 'screen');
	assert.equal('reasoning_content' in plain.request.messages[0], false);
});

test('Provider：同模型的并行站点请求按 targetKey 隔离，回放标记正常回传', async () => {
	const calls = [];
	const sessions = new Map(['site-a', 'site-b'].map(key => [key, {
		client: { async *streamChatCompletion(request, signal, options) {
			calls.push({ key, request, options });
			yield { choices: [{ delta: { reasoning_content: key, content: 'answer' }, finish_reason: 'stop' }] };
		} },
	}]));
	const provider = new modules.provider.NewApiChatProvider({
		logger, sessions: { onDidChange: () => ({ dispose() {} }), find: key => sessions.get(key) },
		adapters: modules.registry.createDefaultAdapterRegistry(), getSettings: () => ({
			request: { ...settings.request, headers: { 'x-conversation': '${conversationId}' } },
		}),
	});
	try {
		const results = await Promise.all(['site-a', 'site-b'].map(async key => {
			const parts = [];
			await provider.provideLanguageModelChatResponse({ config, targetKey: key, targetLabel: key },
				[user([text(key)])], { modelOptions: { _conversationId: key } }, { report: part => parts.push(part) },
				{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
			return parts;
		}));
		assert.equal(calls.length, 2);
		for (const call of calls) {
			assert.equal(call.request.messages[0].content, call.key);
			assert.equal(call.options.headers['x-conversation'], call.key);
		}
		for (const parts of results) {
			assert.ok(parts.some(part => part instanceof vscode.LanguageModelDataPart));
		}
	} finally { provider.dispose(); }
});

test('真实发送边界：URL、鉴权覆盖、请求体和分块 SSE；usage 只上报最后一次', async () => {
	const originalFetch = globalThis.fetch;
	const seen = [];
	globalThis.fetch = async (url, init) => {
		seen.push({ url, init });
		const chunks = [
			'data: {"choices":[{"delta":{"reasoning_content":"think"}}],"usage":{"prompt_tokens":1}}\r\n\r\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"read_","arguments":"{\\\"a\\\":"}}]}}]}\n\n',
			'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"file","arguments":"1}"}}]},"finish_reason":"tool_calls"}]}\n\n',
			'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24}}\n\ndata: [DONE]',
		];
		return new Response(new ReadableStream({ start(controller) {
			for (const chunk of chunks) {
				const bytes = new TextEncoder().encode(chunk);
				controller.enqueue(bytes.slice(0, 13));
				controller.enqueue(bytes.slice(13));
			}
			controller.close();
		} }), { headers: { 'content-type': 'text/event-stream' } });
	};
	const client = new modules.client.NewApiClient({
		baseUrl: 'https://gateway.example/prefix', apiKey: 'key', timeoutMs: 5000, maxRetries: 2, logger,
	});
	try {
		const prepared = await prepare([user([text('hello')])]);
		const parts = [];
		const summary = await modules.flow.streamResponse({
			source: client, request: prepared.request, modelId: config.id, includeReasoning: true,
			progress: { report: part => parts.push(part) }, signal: new AbortController().signal,
			cancelled: () => false, logger, headers: { authorization: 'Bearer override', 'x-session': 'session' },
		});
		assert.equal(seen.length, 1);
		assert.equal(seen[0].url, 'https://gateway.example/prefix/v1/chat/completions');
		const headers = new Headers(seen[0].init.headers);
		assert.equal(headers.get('authorization'), 'Bearer override');
		assert.equal(headers.get('x-session'), 'session');
		assert.deepEqual(JSON.parse(seen[0].init.body).stream_options, { include_usage: true });
		assert.equal(summary.usage.prompt_tokens, 20);
		assert.equal(parts.filter(part => part.mimeType === 'usage').length, 1);
		assert.equal(parts[0].value, 'think');
		const tool = parts.find(part => part instanceof vscode.LanguageModelToolCallPart);
		assert.equal(tool.name, 'read_file');
		assert.deepEqual(tool.input, { a: 1 });
	} finally {
		globalThis.fetch = originalFetch;
		client.dispose();
	}
});

test('失败边界：400、429、503、网络失败和截断均只发送一次，不自动删除字段', async () => {
	const originalFetch = globalThis.fetch;
	try {
		for (const failure of [400, 429, 503, 'network', 'truncated']) {
			let calls = 0;
			globalThis.fetch = async () => {
				calls++;
				if (failure === 'network') { throw new TypeError('fetch failed'); }
				if (failure === 'truncated') {
					return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
						{ headers: { 'content-type': 'text/event-stream' } });
				}
				return new Response('{"error":{"message":"Unsupported parameter: thinking"}}', { status: failure });
			};
			const client = new modules.client.NewApiClient({ baseUrl: 'https://gateway.example', apiKey: 'key',
				timeoutMs: 5000, maxRetries: 2, logger });
			try {
				await assert.rejects(collect(client.streamChatCompletion({ model: 'test', messages: [], thinking: { type: 'enabled' } })));
				assert.equal(calls, 1, String(failure));
			} finally { client.dispose(); }
		}
	} finally { globalThis.fetch = originalFetch; }
});

test('响应控制流：上报异常直接传播，取消后不冲刷工具或上报用量', async () => {
	const failure = new Error('sink failed');
	const controller = new AbortController();
	const input = {
		request: { model: 'test', messages: [] }, modelId: 'test', includeReasoning: true,
		logger, signal: controller.signal, cancelled: () => false,
		progress: { report() { throw failure; } },
		source: { async *streamChatCompletion() { yield { choices: [{ delta: { content: 'text' } }] }; } },
	};
	await assert.rejects(modules.flow.streamResponse(input), error => error === failure);
	const parts = [];
	await assert.rejects(modules.flow.streamResponse({ ...input, progress: { report: part => parts.push(part) },
		source: { async *streamChatCompletion() {
			yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{}' } }] } }] };
			controller.abort();
		} },
	}), error => error.name === 'AbortError');
	assert.equal(parts.length, 0);
});

test('聊天取消：响应头到达后取消仍能中断正在等待的数据流', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => new Response(new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'));
			init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
		},
	}), { headers: { 'content-type': 'text/event-stream' } });
	const controller = new AbortController();
	const client = new modules.client.NewApiClient({ baseUrl: 'https://gateway.example', apiKey: 'key',
		timeoutMs: 5000, maxRetries: 2, logger });
	try {
		const stream = client.streamChatCompletion({ model: 'test', messages: [] }, controller.signal);
		assert.equal((await stream.next()).value.choices[0].delta.content, 'start');
		const pending = stream.next();
		controller.abort();
		await assert.rejects(pending, error => error.name === 'AbortError');
	} finally {
		client.dispose();
		globalThis.fetch = originalFetch;
	}
});
