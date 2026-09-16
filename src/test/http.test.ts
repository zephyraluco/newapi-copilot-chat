import * as assert from 'assert';
import {
	HttpClient,
	HttpError,
	TransportError,
	isAbortError,
	joinUrl,
} from '../client/http';
import type { HttpClientOptions } from '../client/http';
import { fakeFetch, hangingFetch, jsonResponse, streamResponse } from './fakes';
import { capturingLogger, testLogger } from './helpers';

/**
 * 传输层的测试。
 *
 * 覆盖的是这个扩展里**最难手工验证**的一段：重试几次、等多久、什么错误算超时、
 * 取消会不会被误当成失败。这些行为平时看不见（只在网络抖动时生效），
 * 出了偏差也只会表现为「偶尔很慢」或「停止按钮不好用」，因此必须用测试固定住。
 *
 * 时间相关的用例全部把超时压到几十毫秒，并让可重试的响应带上 `Retry-After: 0`，
 * 避免为了验证退避逻辑而真的等待。
 */

/** 构造一个注入了假 `fetch` 的客户端。 */
function createClient(impl: typeof fetch, patch: Partial<HttpClientOptions> = {}): HttpClient {
	return new HttpClient({
		timeoutMs: 5_000,
		maxRetries: 2,
		userAgent: 'newapi-copilot-chat/test',
		logger: testLogger(),
		fetchImpl: impl,
		...patch,
	});
}

/** 执行一段预期会失败的调用，并把错误取出来。 */
async function expectError(action: () => Promise<unknown>): Promise<Error> {
	try {
		await action();
	} catch (error) {
		if (error instanceof Error) {
			return error;
		}
		throw new Error(`预期是 Error，实际抛出 ${String(error)}`);
	}
	throw new Error('预期调用会失败，但它成功了');
}

/** 取传输层错误，并检查类型。 */
async function expectTransportError(action: () => Promise<unknown>): Promise<TransportError> {
	const error = await expectError(action);
	if (!(error instanceof TransportError)) {
		throw new Error(`预期是 TransportError，实际是 ${error.name}：${error.message}`);
	}
	return error;
}

/** 取 HTTP 错误，并检查类型。 */
async function expectHttpError(action: () => Promise<unknown>): Promise<HttpError> {
	const error = await expectError(action);
	if (!(error instanceof HttpError)) {
		throw new Error(`预期是 HttpError，实际是 ${error.name}：${error.message}`);
	}
	return error;
}

suite('client / HTTP 传输层', () => {
	/* ---------------------------------------------------------------------- */
	/* URL 与错误类型                                                          */
	/* ---------------------------------------------------------------------- */

	test('拼接 URL 时兜住端点路径与尾斜杠的重复斜杠', () => {
		assert.strictEqual(
			joinUrl('https://api.example.com/', '/v1/models'),
			'https://api.example.com/v1/models',
		);
		assert.strictEqual(
			joinUrl('https://api.example.com', 'v1/models'),
			'https://api.example.com/v1/models',
		);
		assert.strictEqual(
			joinUrl('https://api.example.com/sub/path///', '/api/status'),
			'https://api.example.com/sub/path/api/status',
		);
	});

	test('鉴权错误与「端点不存在」被单独识别', () => {
		assert.strictEqual(new HttpError(401, 'Unauthorized', 'u', undefined, undefined, undefined).isAuthError, true);
		assert.strictEqual(new HttpError(403, 'Forbidden', 'u', undefined, undefined, undefined).isAuthError, true);
		assert.strictEqual(new HttpError(429, 'Too Many Requests', 'u', undefined, undefined, undefined).isAuthError, false);
		assert.strictEqual(new HttpError(404, 'Not Found', 'u', undefined, undefined, undefined).isNotFound, true);
		assert.strictEqual(new HttpError(500, 'Server Error', 'u', undefined, undefined, undefined).isNotFound, false);
	});

	test('只有限流与服务端错误算可重试', () => {
		for (const status of [408, 409, 425, 429, 500, 502, 503]) {
			const error = new HttpError(status, 'x', 'u', undefined, undefined, undefined);
			assert.strictEqual(error.isRetryable, true, `HTTP ${status} 应该可以重试`);
		}
		for (const status of [400, 401, 403, 404, 422]) {
			const error = new HttpError(status, 'x', 'u', undefined, undefined, undefined);
			assert.strictEqual(error.isRetryable, false, `HTTP ${status} 不应该重试`);
		}
	});

	test('取消类错误被单独识别出来', () => {
		assert.strictEqual(isAbortError(new TransportError('aborted', '已取消')), true);
		assert.strictEqual(isAbortError(new TransportError('timeout', '超时')), false);
		const abortError = new Error('aborted');
		abortError.name = 'AbortError';
		assert.strictEqual(isAbortError(abortError), true);
		assert.strictEqual(isAbortError('字符串'), false);
	});

	/* ---------------------------------------------------------------------- */
	/* 请求与响应                                                              */
	/* ---------------------------------------------------------------------- */

	test('请求带上 User-Agent、调用方给出的头与请求体', async () => {
		const fake = fakeFetch(() => jsonResponse({ ok: true }));
		const client = createClient(fake.impl, { userAgent: 'newapi-copilot-chat/9.9.9' });

		const response = await client.requestText({
			url: 'https://api.example.com/v1/chat/completions',
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{"model":"gpt-4o"}',
		});

		assert.strictEqual(response.status, 200);
		assert.deepStrictEqual(JSON.parse(response.text), { ok: true });
		const init = fake.calls[0].init;
		assert.strictEqual(init?.method, 'POST');
		assert.strictEqual(init?.body, '{"model":"gpt-4o"}');
		const headers = init?.headers as unknown as Record<string, string>;
		assert.strictEqual(headers['User-Agent'], 'newapi-copilot-chat/9.9.9');
		assert.strictEqual(headers['Content-Type'], 'application/json');
	});

	test('从响应体里提取服务端给出的错误说明', async () => {
		const fake = fakeFetch(() => jsonResponse(
			{ error: { message: 'invalid api key' } },
			{ status: 401, statusText: 'Unauthorized' },
		));
		const error = await expectHttpError(() => createClient(fake.impl, { maxRetries: 0 })
			.requestText({ url: 'https://api.example.com/v1/models' }));

		assert.strictEqual(error.status, 401);
		assert.strictEqual(error.isAuthError, true);
		assert.strictEqual(error.apiMessage, 'invalid api key');
		assert.ok(error.message.includes('invalid api key'), '错误信息里应该带上服务端说明');
		assert.ok(error.message.includes('401'));
	});

	test('顶层 message 也能当错误说明', async () => {
		const fake = fakeFetch(() => jsonResponse({ message: '站点已关闭' }, { status: 503 }));
		const error = await expectHttpError(() => createClient(fake.impl, { maxRetries: 0 })
			.requestText({ url: 'u' }));

		assert.strictEqual(error.apiMessage, '站点已关闭');
	});

	test('非 JSON 响应体被截断后放进错误信息，而不是整段塞进去', async () => {
		const body = `<html>${'x'.repeat(5_000)}</html>`;
		const fake = fakeFetch(() => jsonResponse(body, { status: 500 }));
		const error = await expectHttpError(() => createClient(fake.impl, { maxRetries: 0 })
			.requestText({ url: 'u' }));

		assert.strictEqual(error.apiMessage, undefined);
		const stored = error.responseBody ?? '';
		assert.ok(stored.startsWith('<html>'));
		assert.ok(stored.endsWith('…'), '截断处要有省略号，用户才知道内容被掐掉了');
		assert.ok(stored.length <= 1_001, `响应体应该被截断到 1000 个字符，实际 ${stored.length}`);
		assert.ok(error.message.includes('New API 返回 500'));
	});

	/* ---------------------------------------------------------------------- */
	/* 重试                                                                    */
	/* ---------------------------------------------------------------------- */

	test('限流会重试，且第二次成功就返回结果', async () => {
		const fake = fakeFetch((_call, index) => (index === 0
			? jsonResponse({ error: { message: 'rate limited' } }, {
				status: 429,
				headers: { 'retry-after': '0' },
			})
			: jsonResponse({ data: [] })));
		const client = createClient(fake.impl);

		const response = await client.requestText({ url: 'https://api.example.com/v1/models' });

		assert.strictEqual(response.status, 200);
		assert.strictEqual(fake.calls.length, 2, '应该重试一次');
	});

	test('重试会留下日志，便于排查「为什么变慢了」', async () => {
		const logs = capturingLogger();
		const fake = fakeFetch((_call, index) => (index === 0
			? jsonResponse({}, { status: 429, headers: { 'retry-after': '0' } })
			: jsonResponse({})));
		const client = createClient(fake.impl, { logger: logs.logger, maxRetries: 1 });

		await client.requestText({ url: 'u' });

		assert.ok(
			logs.messages('warn').some(line => line.includes('将重试')),
			'重试必须留下痕迹，否则用户只能看到「偶尔很慢」',
		);
	});

	test('4xx 业务错误不重试（重试只会重复失败）', async () => {
		const fake = fakeFetch(() => jsonResponse({ error: { message: 'bad request' } }, { status: 400 }));
		await expectHttpError(() => createClient(fake.impl).requestText({ url: 'u' }));

		assert.strictEqual(fake.calls.length, 1);
	});

	test('调用方可以显式禁止重试', async () => {
		const fake = fakeFetch(() => jsonResponse({}, { status: 500 }));
		await expectHttpError(() => createClient(fake.impl).requestText({ url: 'u', retryable: false }));

		assert.strictEqual(fake.calls.length, 1);
	});

	test('超过重试次数后把最后一次的错误抛出去', async () => {
		const fake = fakeFetch(() => jsonResponse({}, { status: 500, headers: { 'retry-after': '0' } }));
		const error = await expectHttpError(() => createClient(fake.impl, { maxRetries: 2 })
			.requestText({ url: 'u' }));

		assert.strictEqual(error.status, 500);
		assert.strictEqual(fake.calls.length, 3, '首次 + 两次重试');
	});

	/* ---------------------------------------------------------------------- */
	/* 超时与取消                                                              */
	/* ---------------------------------------------------------------------- */

	test('等不到响应时归一化成 timeout', async () => {
		const client = createClient(hangingFetch().impl, { timeoutMs: 30, maxRetries: 0 });
		const error = await expectTransportError(() => client.requestText({ url: 'u' }));

		assert.strictEqual(error.kind, 'timeout');
		assert.ok(error.message.includes('超时'));
	});

	test('流式请求的超时提示指向「等待响应头」', async () => {
		const client = createClient(hangingFetch().impl, { timeoutMs: 30, maxRetries: 0 });
		const error = await expectTransportError(() => client.requestStream({ url: 'u' }));

		assert.strictEqual(error.kind, 'timeout');
		assert.ok(error.message.includes('响应头'), '流式请求的 timeout 只覆盖「等响应头」');
	});

	test('调用方取消算 aborted，而且不会被重试', async () => {
		const controller = new AbortController();
		const fake = hangingFetch();
		const client = createClient(fake.impl, { maxRetries: 2 });

		const pending = expectTransportError(() => client.requestText({ url: 'u', signal: controller.signal }));
		controller.abort();
		const error = await pending;

		assert.strictEqual(error.kind, 'aborted');
		assert.strictEqual(fake.calls.length, 1, '用户点「停止」不该触发重试');
	});

	test('连不上服务器归一化成 network', async () => {
		const fake = fakeFetch(() => {
			throw new TypeError('fetch failed');
		});
		const error = await expectTransportError(() => createClient(fake.impl, { maxRetries: 0 })
			.requestText({ url: 'u' }));

		assert.strictEqual(error.kind, 'network');
		assert.ok(error.message.includes('无法连接 New API'));
	});

	/* ---------------------------------------------------------------------- */
	/* 生命周期与流式响应                                                      */
	/* ---------------------------------------------------------------------- */

	test('释放后立刻失败，并且不会发出请求', async () => {
		const fake = fakeFetch(() => jsonResponse({}));
		const client = createClient(fake.impl);
		client.dispose();

		assert.strictEqual(client.isDisposed, true);
		const error = await expectTransportError(() => client.requestText({ url: 'u' }));

		assert.strictEqual(error.kind, 'aborted');
		assert.strictEqual(fake.calls.length, 0);
	});

	test('释放会中断在途请求（配置变更时重建客户端靠这个）', async () => {
		const fake = hangingFetch();
		const client = createClient(fake.impl);

		const pending = expectTransportError(() => client.requestText({ url: 'u' }));
		client.dispose();

		assert.strictEqual((await pending).kind, 'aborted');
	});

	test('流式响应把未读完的响应体交给调用方', async () => {
		const fake = fakeFetch(() => streamResponse(['data: {}\n\n'], {
			headers: { 'content-type': 'text/event-stream' },
		}));
		const response = await createClient(fake.impl).requestStream({ url: 'u' });

		assert.strictEqual(response.status, 200);
		assert.strictEqual(response.headers.get('content-type'), 'text/event-stream');
		assert.ok(response.body, '流式响应必须给出可读取的响应体');
	});

	test('流式响应没有可读取的响应体时报传输错误', async () => {
		const fake = fakeFetch(() => jsonResponse({}));
		const error = await expectTransportError(() => createClient(fake.impl, { maxRetries: 0 })
			.requestStream({ url: 'u' }));

		assert.strictEqual(error.kind, 'network');
		assert.ok(error.message.includes('没有可读取的流'));
	});
});
