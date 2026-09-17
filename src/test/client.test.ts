import * as assert from 'assert';
import { HttpError, TransportError } from '../client/http';
import { NewApiClient, describeError, describeFailureHint } from '../client/newApiClient';
import type { NewApiClientOptions } from '../client/newApiClient';
import { SseIdleTimeoutError, SseTruncatedError } from '../client/sse';
import type { ChatCompletionChunk, ChatCompletionRequest } from '../types';
import { fakeFetch, jsonResponse, streamResponse } from './fakes';
import { capturingLogger, testLogger } from './helpers';

/**
 * 客户端端点的测试。
 *
 * 这里钉住四类容易静默变化的东西：
 * - **响应形态的兼容**：网关返回 `{data:[...]}`、裸数组、甚至再包一层的都有；
 * - **鉴权头的出现与否**：`/api/status` 刻意不带密钥（它认的是用户 token，带 API Key 没用）；
 * - **降级路径**：网关忽略 `stream: true` 时，必须把整段 JSON 包装成一个等价的 chunk，
 *   否则上层会什么都不显示；
 * - **流是怎么结束的**：半截回答必须报出来（没报就是用户把半截回答当成了完整的），
 *   而「没有 `[DONE]` 但有 `finish_reason`」是合法收尾，不能误报。
 */

/** 构造一个注入了假 `fetch` 的客户端。 */
function createClient(impl: typeof fetch, patch: Partial<NewApiClientOptions> = {}): NewApiClient {
	return new NewApiClient({
		baseUrl: 'https://api.example.com',
		apiKey: 'sk-test-key',
		timeoutMs: 5_000,
		maxRetries: 0,
		logger: testLogger(),
		fetchImpl: impl,
		...patch,
	});
}

/** 取出请求头（假 `fetch` 记录下来的原始 init）。 */
function headersOf(call: { init: RequestInit | undefined }): Record<string, string> {
	return (call.init?.headers ?? {}) as unknown as Record<string, string>;
}

/** 一个最小的对话请求体。 */
function chatRequest(): ChatCompletionRequest {
	return { model: 'gpt-4o', messages: [{ role: 'user', content: '你好' }] };
}

suite('client / New API 端点', () => {
	/* ---------------------------------------------------------------------- */
	/* 模型列表                                                                */
	/* ---------------------------------------------------------------------- */

	test('模型列表兼容 {data:[...]}、裸数组、再包一层与 models 字段四种形态', async () => {
		const bodies: readonly unknown[] = [
			{ object: 'list', data: [{ id: 'b' }, { id: 'a' }] },
			[{ id: 'b' }, { id: 'a' }],
			{ data: { data: [{ id: 'b' }, { id: 'a' }] } },
			{ models: [{ id: 'b' }, { id: 'a' }] },
		];
		for (const body of bodies) {
			const fake = fakeFetch(() => jsonResponse(body));
			const models = await createClient(fake.impl).listModels();
			assert.deepStrictEqual(models.map(model => model.id), ['a', 'b'], JSON.stringify(body));
		}
	});

	test('模型列表按 id 排序，保证选择器的顺序稳定', async () => {
		const fake = fakeFetch(() => jsonResponse({ data: [{ id: 'z' }, { id: 'a' }, { id: 'm' }] }));
		const models = await createClient(fake.impl).listModels();
		assert.deepStrictEqual(models.map(model => model.id), ['a', 'm', 'z']);
	});

	test('认得 New API 自有的 model_name 字段，并去掉重复与无 id 的条目', async () => {
		const fake = fakeFetch(() => jsonResponse({
			data: [
				{ model_name: 'gpt-4o' },
				{ id: 'gpt-4o', object: 'model' },
				{ id: 'gpt-4o', object: 'model', owned_by: '后出现的' },
				{ object: 'model' },
			],
		}));
		const models = await createClient(fake.impl).listModels();

		assert.strictEqual(models.length, 1);
		assert.strictEqual(models[0].id, 'gpt-4o');
		assert.strictEqual(models[0].owned_by, undefined, '重复条目保留先出现的那个');
	});

	test('模型列表为空时记下警告（有些网关把错误塞在 200 响应里）', async () => {
		const logs = capturingLogger();
		const fake = fakeFetch(() => jsonResponse({ success: false, message: '站点维护中' }));
		const models = await createClient(fake.impl, { logger: logs.logger }).listModels();

		assert.deepStrictEqual(models, []);
		assert.ok(logs.messages('warn').some(line => line.includes('站点维护中')));
	});

	test('请求带 Bearer 鉴权头，并拼对端点地址', async () => {
		const fake = fakeFetch(() => jsonResponse({ data: [] }));
		await createClient(fake.impl, { apiKey: 'sk-abc' }).listModels();

		assert.strictEqual(fake.calls[0].url, 'https://api.example.com/v1/models');
		const headers = headersOf(fake.calls[0]);
		assert.strictEqual(headers['Authorization'], 'Bearer sk-abc');
		assert.strictEqual(headers['Content-Type'], 'application/json');
	});

	test('没有密钥时不发送鉴权头', async () => {
		const fake = fakeFetch(() => jsonResponse({ data: [] }));
		const client = createClient(fake.impl, { apiKey: undefined });

		assert.strictEqual(client.hasApiKey, false);
		await client.listModels();

		assert.strictEqual(headersOf(fake.calls[0])['Authorization'], undefined);
	});

	/* ---------------------------------------------------------------------- */
	/* 站点状态                                                                */
	/* ---------------------------------------------------------------------- */

	test('读取站点名称与网关版本', async () => {
		const fake = fakeFetch(() => jsonResponse({ success: true, data: { system_name: '我的站点', version: '0.9.0' } }));
		const result = await createClient(fake.impl).getStatus();

		assert.strictEqual(result.available, true);
		assert.strictEqual(result.status?.system_name, '我的站点');
		assert.strictEqual(result.status?.version, '0.9.0');
		assert.strictEqual(fake.calls[0].url, 'https://api.example.com/api/status');
	});

	test('站点状态端点刻意不带密钥（它认的是用户 token，API Key 没用）', async () => {
		const fake = fakeFetch(() => jsonResponse({ data: {} }));
		const client = createClient(fake.impl, { apiKey: 'sk-should-not-be-sent' });

		await client.getStatus();

		assert.strictEqual(headersOf(fake.calls[0])['Authorization'], undefined);
	});

	test('站点状态端点不可用时不抛异常，只标记为不可用', async () => {
		const notFound = fakeFetch(() => jsonResponse({ error: { message: 'not found' } }, { status: 404 }));
		const missing = await createClient(notFound.impl).getStatus();
		assert.strictEqual(missing.available, false);
		assert.ok((missing.reason ?? '').includes('404'));

		const wrongShape = fakeFetch(() => jsonResponse({ data: 'nope' }));
		const mismatched = await createClient(wrongShape.impl).getStatus();
		assert.strictEqual(mismatched.available, false);
		assert.ok((mismatched.reason ?? '').includes('/api/status'));
	});

	/* ---------------------------------------------------------------------- */
	/* 流式补全                                                                */
	/* ---------------------------------------------------------------------- */

	test('流式补全逐块解析 SSE，并在请求体里要求返回用量', async () => {
		const fake = fakeFetch(() => streamResponse([
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"好"}}]}\n\n',
			'data: {"id":"1","choices":[],"usage":{"total_tokens":3}}\n\n',
			'data: [DONE]\n\n',
		], { headers: { 'content-type': 'text/event-stream' } }));

		const chunks: ChatCompletionChunk[] = [];
		for await (const chunk of createClient(fake.impl).streamChatCompletion(chatRequest())) {
			chunks.push(chunk);
		}

		assert.strictEqual(chunks.length, 3, '[DONE] 不算一个数据块');
		assert.strictEqual(chunks[0].choices?.[0]?.delta?.content, '你');
		assert.strictEqual(chunks[1].choices?.[0]?.delta?.content, '好');
		assert.strictEqual(chunks[2].usage?.total_tokens, 3);

		const body = JSON.parse(String(fake.calls[0].init?.body)) as Record<string, unknown>;
		assert.strictEqual(body.model, 'gpt-4o');
		assert.strictEqual(body.stream, true);
		assert.deepStrictEqual(body.stream_options, { include_usage: true });
	});

	test('网关忽略 stream 参数时把整段 JSON 包装成一个等价的 chunk', async () => {
		const logs = capturingLogger();
		const fake = fakeFetch(() => streamResponse([JSON.stringify({
			id: '1',
			model: 'gpt-4o',
			created: 1_700_000_000,
			choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '你好' } }],
			usage: { total_tokens: 7 },
		})], { headers: { 'content-type': 'application/json' } }));

		const chunks: ChatCompletionChunk[] = [];
		for await (const chunk of createClient(fake.impl, { logger: logs.logger }).streamChatCompletion(chatRequest())) {
			chunks.push(chunk);
		}

		assert.strictEqual(chunks.length, 1, '降级后只产出单块响应');
		assert.strictEqual(chunks[0].choices?.[0]?.delta?.content, '你好');
		assert.strictEqual(chunks[0].choices?.[0]?.finish_reason, 'stop');
		assert.strictEqual(chunks[0].usage?.total_tokens, 7);
		assert.ok(logs.messages('warn').some(line => line.includes('不是 SSE')));
	});

	test('降级路径下响应不是合法 JSON 时报传输错误', async () => {
		const fake = fakeFetch(() => streamResponse(['<html>502</html>'], {
			headers: { 'content-type': 'text/html' },
		}));

		let caught: unknown;
		try {
			for await (const _chunk of createClient(fake.impl).streamChatCompletion(chatRequest())) {
				// 不应该产出任何数据块
			}
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof TransportError);
		assert.strictEqual((caught as TransportError).kind, 'network');
		assert.ok((caught as TransportError).message.includes('无法解析响应'));
		// 这类错误是我们自己合成的，没有 DNS/TLS 那种分类句子可依靠，
		// 因此建议必须写在消息里——最常见的成因就是地址指向了一个网页
		assert.ok((caught as TransportError).message.includes('站点地址'), (caught as TransportError).message);
	});

	/* ---------------------------------------------------------------------- */
	/* 流的收尾与截断                                                          */
	/* ---------------------------------------------------------------------- */

	test('流没有正常收尾时报截断错误（半截回答不能当成功）', async () => {
		const fake = fakeFetch(() => streamResponse([
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"前半段"}}]}\n\n',
			// 连接在这里断开：既没有 [DONE]，也没有 finish_reason
		], { headers: { 'content-type': 'text/event-stream' } }));

		const chunks: ChatCompletionChunk[] = [];
		let caught: unknown;
		try {
			for await (const chunk of createClient(fake.impl).streamChatCompletion(chatRequest())) {
				chunks.push(chunk);
			}
		} catch (error) {
			caught = error;
		}

		assert.strictEqual(chunks.length, 1, '断开前收到的数据块要照常吐出来');
		assert.ok(caught instanceof SseTruncatedError, `实际是 ${String(caught)}`);
		assert.strictEqual((caught as SseTruncatedError).blocks, 1);
	});

	test('没有 [DONE] 但给了 finish_reason 也算正常收尾', async () => {
		const fake = fakeFetch(() => streamResponse([
			'data: {"id":"1","choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
			'data: {"id":"1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
		], { headers: { 'content-type': 'text/event-stream' } }));

		const chunks: ChatCompletionChunk[] = [];
		for await (const chunk of createClient(fake.impl).streamChatCompletion(chatRequest())) {
			chunks.push(chunk);
		}

		assert.strictEqual(chunks.length, 2, '不该把合法收尾当成截断');
	});

	test('一个数据块都没解析出来时不判定为截断（分不清空响应与格式不认识）', async () => {
		const fake = fakeFetch(() => streamResponse([': keep-alive\n\n'], {
			headers: { 'content-type': 'text/event-stream' },
		}));

		const chunks: ChatCompletionChunk[] = [];
		for await (const chunk of createClient(fake.impl).streamChatCompletion(chatRequest())) {
			chunks.push(chunk);
		}

		assert.deepStrictEqual(chunks, []);
	});

	test('关掉 includeUsage 后不再下发 stream_options', async () => {
		const fake = fakeFetch(() => streamResponse(['data: [DONE]\n\n'], {
			headers: { 'content-type': 'text/event-stream' },
		}));
		const client = createClient(fake.impl, { includeUsage: false });

		for await (const _chunk of client.streamChatCompletion(chatRequest())) {
			// 流是空的
		}

		const body = JSON.parse(String(fake.calls[0].init?.body)) as Record<string, unknown>;
		assert.strictEqual(body.stream_options, undefined, '不认这个字段的站点要能绕过它');
		assert.strictEqual(body.stream, true, 'stream 本身不能被弄丢');
	});

	/* ---------------------------------------------------------------------- */
	/* 静默超时                                                                */
	/* ---------------------------------------------------------------------- */

	test('SSE 路径用 streamIdleTimeoutMs，而不是 timeoutMs', async () => {
		const fake = fakeFetch(() => streamResponse(
			['data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n'],
			{ headers: { 'content-type': 'text/event-stream' }, hang: true },
		));
		// timeoutMs 故意很大：如果静默超时还在用它，这个用例会一直等到测试超时
		const client = createClient(fake.impl, { timeoutMs: 60_000, streamIdleTimeoutMs: 30 });

		const chunks: ChatCompletionChunk[] = [];
		let caught: unknown;
		try {
			for await (const chunk of client.streamChatCompletion(chatRequest())) {
				chunks.push(chunk);
			}
		} catch (error) {
			caught = error;
		}

		assert.strictEqual(chunks.length, 1, '超时前收到的数据块要照常吐出来');
		assert.ok(caught instanceof SseIdleTimeoutError, `实际是 ${String(caught)}`);
	});

	test('降级路径同样受 streamIdleTimeoutMs 保护', async () => {
		const fake = fakeFetch(() => streamResponse(['{"choices":'], {
			headers: { 'content-type': 'application/json' },
			hang: true,
		}));
		const client = createClient(fake.impl, { timeoutMs: 60_000, streamIdleTimeoutMs: 30 });

		let caught: unknown;
		try {
			for await (const _chunk of client.streamChatCompletion(chatRequest())) {
				// 不该产出数据块
			}
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof SseIdleTimeoutError, `实际是 ${String(caught)}`);
	});

	/* ---------------------------------------------------------------------- */
	/* 非流式补全                                                              */
	/* ---------------------------------------------------------------------- */

	test('非流式补全解析响应，并显式带上 stream:false', async () => {
		const fake = fakeFetch(() => jsonResponse({
			id: '1',
			choices: [{ index: 0, message: { role: 'assistant', content: '你好' } }],
		}));
		const response = await createClient(fake.impl).chatCompletion(chatRequest());

		assert.strictEqual(response.choices?.[0]?.message.content, '你好');
		const body = JSON.parse(String(fake.calls[0].init?.body)) as Record<string, unknown>;
		assert.strictEqual(body.stream, false);
	});

	test('非流式响应不是合法 JSON 时报传输错误', async () => {
		const fake = fakeFetch(() => jsonResponse('这不是 JSON'));
		let caught: unknown;
		try {
			await createClient(fake.impl).chatCompletion(chatRequest());
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof TransportError);
		assert.ok((caught as TransportError).message.includes('响应不是合法 JSON'));
		assert.ok((caught as TransportError).message.includes('站点地址'), (caught as TransportError).message);
	});

	/* ---------------------------------------------------------------------- */
	/* 错误描述与建议                                                          */
	/* ---------------------------------------------------------------------- */

	test('错误描述始终是可展示的一行文本', () => {
		assert.strictEqual(describeError(undefined), '未知错误');
		assert.strictEqual(describeError(new Error('连不上')), '连不上');
		assert.strictEqual(describeError('字符串错误'), '字符串错误');
	});

	test('鉴权失败的建议区分「密钥被拒」与「还没设置密钥」', () => {
		const unauthorized = new HttpError(401, 'Unauthorized', 'u', undefined, undefined, undefined);
		const withKey = describeFailureHint(unauthorized, true);
		const withoutKey = describeFailureHint(unauthorized, false);

		assert.ok((withKey ?? '').includes('被拒绝'));
		assert.ok((withoutKey ?? '').includes('尚未设置'));
	});

	test('地址写错与限流给出各自的可操作建议', () => {
		const notFound = new HttpError(404, 'Not Found', 'u', undefined, undefined, undefined);
		assert.ok((describeFailureHint(notFound, true) ?? '').includes('站点地址'));

		const rateLimited = new HttpError(429, 'Too Many Requests', 'u', undefined, undefined, undefined);
		assert.ok((describeFailureHint(rateLimited, true) ?? '').includes('限流'));
	});

	test('超时给出建议，网络类不再重复给（消息里已经有了）', () => {
		assert.ok((describeFailureHint(new TransportError('timeout', '超时'), true) ?? '').includes('timeoutMs'));
		// 连接失败的建议在错误消息里（分类句子 + 错误码 + 站点），这里再来一句就是同一件事说两遍
		assert.strictEqual(describeFailureHint(new TransportError('network', '[ENOTFOUND] 域名解析失败'), true), undefined);
		assert.strictEqual(describeFailureHint(new TransportError('aborted', '已取消'), true), undefined);
		assert.strictEqual(describeFailureHint(new Error('别的错'), true), undefined);
	});

	test('中断与截断各给一条可操作的建议', () => {
		const stalled = describeFailureHint(new SseIdleTimeoutError(60_000), true) ?? '';
		assert.ok(stalled.includes('streamIdleTimeoutMs'), '要告诉用户去哪个设置放宽');

		const cut = describeFailureHint(new SseTruncatedError(3), true) ?? '';
		assert.ok(cut.includes('不完整'));
	});

	test('限流建议带上服务端要求的等待时间', () => {
		const withWait = new HttpError(429, 'Too Many Requests', 'u', undefined, undefined, 120_000);
		assert.ok((describeFailureHint(withWait, true) ?? '').includes('120 秒'));

		const withoutWait = new HttpError(429, 'Too Many Requests', 'u', undefined, undefined, undefined);
		assert.ok((describeFailureHint(withoutWait, true) ?? '').includes('限流'));
	});
});
