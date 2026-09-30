'use strict';

/**
 * client 层：URL 拼接、错误判别、SSE 解析、带超时与重试的 HTTP 客户端。
 *
 * 这一层不 import `vscode`，但会用到全局 `fetch`，因此需要临时替换它。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger, streamOf, collect } = require('./helpers');

const { modules } = load({
	http: './src/client/http',
	sse: './src/client/sse',
	newApiClient: './src/client/newApiClient',
});

const {
	joinUrl,
	HttpClient,
	HttpError,
	TransportError,
	isAbortError,
} = modules.http;
const {
	parseSseStream,
	parseSseJson,
	isDoneEvent,
	readStreamText,
	SseIdleTimeoutError,
	SseTruncatedError,
} = modules.sse;
const { describeError, describeFailureHint } = modules.newApiClient;

const encode = text => new TextEncoder().encode(text);

/* -------------------------------------------------------------------------- */
/* URL 拼接                                                                    */
/* -------------------------------------------------------------------------- */

test('joinUrl：不多不少一个斜杠', () => {
	assert.equal(joinUrl('https://api.example.com', '/v1/models'), 'https://api.example.com/v1/models');
	// 站点地址尾部多打的斜杠不能变成 `//v1`
	assert.equal(joinUrl('https://api.example.com/', '/v1/models'), 'https://api.example.com/v1/models');
	assert.equal(joinUrl('https://api.example.com///', '/v1/models'), 'https://api.example.com/v1/models');
	// 端点常量统一带前导斜杠，但拼接不该依赖这一点
	assert.equal(joinUrl('https://api.example.com', 'v1/models'), 'https://api.example.com/v1/models');
});

/* -------------------------------------------------------------------------- */
/* 错误判别                                                                    */
/* -------------------------------------------------------------------------- */

test('HttpError：只把「值得重试」的状态码当可重试', () => {
	const retryable = [408, 409, 425, 429, 500, 502, 503];
	const fatal = [400, 401, 403, 404, 422];

	for (const status of retryable) {
		const error = new HttpError(status, 'x', 'https://api.example.com/v1/models', undefined, undefined, undefined);
		assert.equal(error.isRetryable, true, String(status));
	}
	for (const status of fatal) {
		const error = new HttpError(status, 'x', 'https://api.example.com/v1/models', undefined, undefined, undefined);
		assert.equal(error.isRetryable, false, String(status));
	}
});

test('HttpError：401/403 是鉴权错误，404 是地址错误', () => {
	const make = status => new HttpError(status, 'x', 'https://api.example.com/v1/models', undefined, undefined, undefined);

	assert.equal(make(401).isAuthError, true);
	assert.equal(make(403).isAuthError, true);
	assert.equal(make(404).isAuthError, false);
	assert.equal(make(404).isNotFound, true);
	assert.equal(make(500).isNotFound, false);
});

test('HttpError：消息里带状态、服务端说明与地址', () => {
	const error = new HttpError(400, 'Bad Request', 'https://api.example.com/v1/chat/completions',
		'{"error":{"message":"Unknown parameter"}}', 'Unknown parameter', undefined);

	assert.match(error.message, /400/);
	assert.match(error.message, /Unknown parameter/);
	assert.match(error.message, /https:\/\/api\.example\.com\/v1\/chat\/completions/);
});

test('HttpError：限流时把服务端要求的等待时间写进消息', () => {
	const error = new HttpError(429, 'Too Many Requests', 'https://api.example.com/v1/models',
		undefined, undefined, 12_000);

	assert.equal(error.retryAfterMs, 12_000);
	assert.match(error.message, /12 秒/);

	// 小于 1 秒不值得提，写出来只是噪音
	const brief = new HttpError(429, 'Too Many Requests', 'https://api.example.com', undefined, undefined, 200);
	assert.doesNotMatch(brief.message, /秒/);
});

test('isAbortError：认得 VS Code 的 Canceled，也认得标准的 AbortError', () => {
	assert.equal(isAbortError(new TransportError('aborted', '取消')), true);
	assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
	// new vscode.CancellationError().name 是 Canceled 而不是 AbortError
	assert.equal(isAbortError(Object.assign(new Error('x'), { name: 'Canceled' })), true);

	assert.equal(isAbortError(new TransportError('timeout', '超时')), false);
	assert.equal(isAbortError(new TransportError('network', '断网')), false);
	assert.equal(isAbortError(new Error('x')), false);
	assert.equal(isAbortError('not an error'), false);
	assert.equal(isAbortError(undefined), false);
});

/* -------------------------------------------------------------------------- */
/* SSE 解析                                                                    */
/* -------------------------------------------------------------------------- */

test('isDoneEvent：只看裁剪后的 data', () => {
	assert.equal(isDoneEvent({ data: '[DONE]' }), true);
	assert.equal(isDoneEvent({ data: '  [DONE]  ' }), true);
	assert.equal(isDoneEvent({ data: '{"a":1}' }), false);
	assert.equal(isDoneEvent({ data: 'DONE' }), false);
});

test('parseSseStream：按空行分帧', async () => {
	const events = await collect(parseSseStream(streamOf([
		'data: {"a":1}\n\n',
		'data: {"b":2}\n\n',
	])));

	assert.deepEqual(events.map(event => event.data), ['{"a":1}', '{"b":2}']);
});

test('parseSseStream：容忍 \\r\\n 与心跳注释行', async () => {
	const events = await collect(parseSseStream(streamOf([
		': keep-alive\r\n\r\n',
		'data: {"a":1}\r\n\r\n',
	])));

	assert.equal(events.length, 1);
	assert.equal(events[0].data, '{"a":1}');
});

test('parseSseStream：多行 data 按规范用换行拼接', async () => {
	const events = await collect(parseSseStream(streamOf(['data: line1\ndata: line2\n\n'])));

	assert.equal(events.length, 1);
	assert.equal(events[0].data, 'line1\nline2');
});

test('parseSseStream：保留 event 与 id 字段', async () => {
	const events = await collect(parseSseStream(streamOf(['event: ping\nid: 7\ndata: {}\n\n'])));

	assert.equal(events[0].event, 'ping');
	assert.equal(events[0].id, '7');
});

test('parseSseStream：缓冲区里残留的半行也要处理', async () => {
	// 部分网关的最后一条事件没有结尾换行
	const events = await collect(parseSseStream(streamOf(['data: {"a":1}\n\ndata: [DONE]'])));

	assert.deepEqual(events.map(event => event.data), ['{"a":1}', '[DONE]']);
});

test('parseSseStream：分片从中间切断时不会丢字符', async () => {
	// UTF-8 多字节字符被切在两片之间，也必须能正确解码回来
	const bytes = encode('data: {"a":"中文"}\n\n');
	const events = await collect(parseSseStream(streamOf([
		bytes.slice(0, 14),
		bytes.slice(14),
	])));

	assert.deepEqual(JSON.parse(events[0].data), { a: '中文' });
});

test('parseSseStream：静默超时抛 SseIdleTimeoutError 并回调', async () => {
	let notified = 0;
	const generator = parseSseStream(
		streamOf(['data: {"a":1}\n\n'], { hang: true }),
		{ idleTimeoutMs: 30, onIdleTimeout: () => { notified++; } },
	);

	await assert.rejects(
		(async () => {
			for await (const _event of generator) {
				// 第一条之后连接就不吐数据了
			}
		})(),
		error => {
			assert.ok(error instanceof SseIdleTimeoutError);
			assert.equal(error.idleTimeoutMs, 30);
			return true;
		},
	);
	assert.equal(notified, 1);
});

test('parseSseStream：结束后一定会释放读取锁', async () => {
	let cancelled = false;
	const body = {
		getReader() {
			let index = 0;
			const chunks = ['data: {"a":1}\n\n'];
			return {
				async read() {
					return index < chunks.length
						? { done: false, value: encode(chunks[index++]) }
						: { done: true, value: undefined };
				},
				async cancel() { cancelled = true; },
				releaseLock() { },
			};
		},
	};

	await collect(parseSseStream(body));
	assert.equal(cancelled, true);
});

test('parseSseJson：跳过非 JSON 数据块并统计收尾信息', async () => {
	const logger = createLogger();
	const outcome = { sawDone: false, blocks: 0 };

	const chunks = await collect(parseSseJson(streamOf([
		'data: {"i":1}\n\n',
		'data: not json\n\n',
		'data:\n\n',
		'data: [DONE]\n\n',
		'data: {"i":2}\n\n',
	]), { logger, outcome }));

	assert.deepEqual(chunks, [{ i: 1 }]);
	assert.equal(outcome.sawDone, true);
	// 只统计成功解析的块
	assert.equal(outcome.blocks, 1);
	assert.equal(logger.messages('debug').length, 1);
});

test('readStreamText：把非 SSE 的响应体整体读出来', async () => {
	const text = await readStreamText(streamOf(['{"choices":[]}']));
	assert.equal(text, '{"choices":[]}');
});

test('readStreamText：信号已取消时立刻失败，不回传半截文本', async () => {
	const controller = new AbortController();
	controller.abort(new Error('用户取消'));

	await assert.rejects(
		readStreamText(streamOf(['abc']), controller.signal),
		/用户取消/,
	);
});

/* -------------------------------------------------------------------------- */
/* HttpClient                                                                  */
/* -------------------------------------------------------------------------- */

/** 假的 `Response`。只实现被测代码读到的那几个成员。 */
function fakeResponse(options = {}) {
	const status = options.status ?? 200;
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: options.statusText ?? 'OK',
		url: options.url ?? 'https://api.example.com/v1/models',
		headers: {
			get: name => (options.headers ?? {})[String(name).toLowerCase()] ?? null,
		},
		async text() { return options.body ?? ''; },
		body: options.bodyStream ?? null,
	};
}

/** 临时替换全局 `fetch`；无论成败都还原。 */
async function withFetch(stub, run) {
	const original = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

/** 造一个客户端；默认零重试，重试路径要单独指定。 */
function makeClient(options = {}) {
	return new HttpClient({
		timeoutMs: options.timeoutMs ?? 5_000,
		maxRetries: options.maxRetries ?? 0,
		userAgent: 'newapi-copilot-chat/test',
		logger: options.logger ?? createLogger(),
	});
}

test('HttpClient：成功时返回状态、地址与响应体', async () => {
	const client = makeClient();
	const response = await withFetch(
		async () => fakeResponse({ body: '{"data":[]}' }),
		() => client.requestText({ url: 'https://api.example.com/v1/models' }),
	);

	assert.equal(response.status, 200);
	assert.equal(response.text, '{"data":[]}');
	assert.equal(response.url, 'https://api.example.com/v1/models');
});

test('HttpClient：请求带上 User-Agent 与调用方给的请求头', async () => {
	let seen;
	const client = makeClient();

	await withFetch(
		async (url, init) => {
			seen = { url, init };
			return fakeResponse({});
		},
		() => client.requestText({
			url: 'https://api.example.com/v1/models',
			method: 'POST',
			headers: { Authorization: 'Bearer secret' },
			body: '{"a":1}',
		}),
	);

	assert.equal(seen.url, 'https://api.example.com/v1/models');
	assert.equal(seen.init.method, 'POST');
	assert.equal(seen.init.body, '{"a":1}');
	assert.equal(seen.init.headers.Authorization, 'Bearer secret');
	assert.match(seen.init.headers['User-Agent'], /newapi-copilot-chat/);
});

test('HttpClient：服务端错误提炼出可读说明', async () => {
	const client = makeClient();

	await withFetch(
		async () => fakeResponse({
			status: 400,
			statusText: 'Bad Request',
			body: '{"error":{"message":"Unknown parameter: \'temperature\'"}}',
		}),
		async () => {
			await assert.rejects(
				client.requestText({ url: 'https://api.example.com/v1/chat/completions' }),
				error => {
					assert.ok(error instanceof HttpError);
					assert.equal(error.status, 400);
					assert.equal(error.apiMessage, "Unknown parameter: 'temperature'");
					return true;
				},
			);
		},
	);
});

test('HttpClient：5xx 会重试，成功即返回', async () => {
	const logger = createLogger();
	const client = makeClient({ maxRetries: 1, logger });
	let calls = 0;

	const response = await withFetch(
		async () => {
			calls++;
			return calls === 1
				? fakeResponse({ status: 503, statusText: 'Service Unavailable' })
				: fakeResponse({ body: 'ok' });
		},
		() => client.requestText({ url: 'https://api.example.com/v1/models' }),
	);

	assert.equal(calls, 2);
	assert.equal(response.text, 'ok');
	assert.equal(logger.messages('warn').length, 1);
});

test('HttpClient：4xx 业务错误不重试', async () => {
	const client = makeClient({ maxRetries: 2 });
	let calls = 0;

	await withFetch(
		async () => {
			calls++;
			return fakeResponse({ status: 401, statusText: 'Unauthorized' });
		},
		async () => {
			await assert.rejects(client.requestText({ url: 'https://api.example.com/v1/models' }));
		},
	);

	assert.equal(calls, 1);
});

test('HttpClient：服务端要求等太久时不再重试，直接把等待时间报出去', async () => {
	const logger = createLogger();
	const client = makeClient({ maxRetries: 2, logger });
	let calls = 0;

	await withFetch(
		async () => {
			calls++;
			return fakeResponse({
				status: 429,
				statusText: 'Too Many Requests',
				headers: { 'retry-after': '3600' },
			});
		},
		async () => {
			await assert.rejects(
				client.requestText({ url: 'https://api.example.com/v1/models' }),
				error => {
					assert.equal(error.retryAfterMs, 3_600_000);
					assert.match(error.message, /3600 秒/);
					return true;
				},
			);
		},
	);

	// 等到一半再撞一次 429 只是白拖时间
	assert.equal(calls, 1);
	assert.equal(logger.messages('warn').length, 1);
});

test('HttpClient：整体超时抛 kind=timeout', async () => {
	const client = makeClient({ timeoutMs: 40 });

	await withFetch(
		(_url, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener('abort', () => reject(init.signal.reason));
		}),
		async () => {
			await assert.rejects(
				client.requestText({ url: 'https://api.example.com/v1/models' }),
				error => {
					assert.ok(error instanceof TransportError);
					assert.equal(error.kind, 'timeout');
					assert.equal(isAbortError(error), false);
					return true;
				},
			);
		},
	);
});

test('HttpClient：调用方取消抛 kind=aborted，且不重试', async () => {
	const client = makeClient({ maxRetries: 2 });
	const controller = new AbortController();
	let calls = 0;

	const promise = withFetch(
		(_url, init) => {
			calls++;
			return new Promise((_resolve, reject) => {
				init.signal.addEventListener('abort', () => reject(init.signal.reason));
			});
		},
		() => client.requestText({ url: 'https://api.example.com/v1/models', signal: controller.signal }),
	);

	setTimeout(() => controller.abort(), 10);

	await assert.rejects(promise, error => {
		assert.ok(error instanceof TransportError);
		assert.equal(error.kind, 'aborted');
		return true;
	});
	assert.equal(calls, 1);
});

test('HttpClient：连接失败归一化成 kind=network', async () => {
	const client = makeClient();

	await withFetch(
		async () => {
			const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
			throw Object.assign(new TypeError('fetch failed'), { cause });
		},
		async () => {
			await assert.rejects(
				client.requestText({ url: 'https://api.example.com/v1/models' }),
				error => {
					assert.ok(error instanceof TransportError);
					assert.equal(error.kind, 'network');
					return true;
				},
			);
		},
	);
});

test('HttpClient：流式响应没有 body 时给出可操作的错误', async () => {
	const client = makeClient();

	await withFetch(
		async () => fakeResponse({ bodyStream: null }),
		async () => {
			await assert.rejects(
				client.requestStream({ url: 'https://api.example.com/v1/chat/completions' }),
				error => {
					assert.ok(error instanceof TransportError);
					assert.equal(error.kind, 'network');
					return true;
				},
			);
		},
	);
});

test('HttpClient：流式响应正常返回未读完的 body', async () => {
	const client = makeClient();
	const bodyStream = streamOf(['data: [DONE]\n\n']);

	const response = await withFetch(
		async () => fakeResponse({ bodyStream }),
		() => client.requestStream({ url: 'https://api.example.com/v1/chat/completions' }),
	);

	assert.equal(response.body, bodyStream);
});

test('HttpClient：dispose 之后所有请求立刻失败', async () => {
	const client = makeClient();
	assert.equal(client.isDisposed, false);

	client.dispose();
	assert.equal(client.isDisposed, true);

	await assert.rejects(
		client.requestText({ url: 'https://api.example.com/v1/models' }),
		error => {
			assert.ok(error instanceof TransportError);
			assert.equal(error.kind, 'aborted');
			return true;
		},
	);
});

/* -------------------------------------------------------------------------- */
/* 错误 → 用户文案                                                              */
/* -------------------------------------------------------------------------- */

test('describeError：运输层错误原样使用，其余走错误链', () => {
	assert.equal(describeError(undefined), '未知错误');
	assert.match(describeError(new TransportError('timeout', '请求 New API 超时')), /请求 New API 超时/);

	// 外壳（「XXX 失败」）没有信息量，要挖到 cause 里
	const wrapped = new Error('流式请求失败', { cause: new Error('连接被重置') });
	assert.match(describeError(wrapped), /连接被重置/);
});

test('describeFailureHint：鉴权失败要区分「未设置」与「被拒绝」', () => {
	const unauthorized = new HttpError(401, 'Unauthorized', 'https://api.example.com/v1/models', undefined, undefined, undefined);
	const forbidden = new HttpError(403, 'Forbidden', 'https://api.example.com/v1/models', undefined, undefined, undefined);

	assert.match(describeFailureHint(unauthorized, true), /被拒绝/);
	assert.match(describeFailureHint(unauthorized, false), /尚未设置/);
	assert.match(describeFailureHint(forbidden, true), /被拒绝/);
});

test('describeFailureHint：404 提示别把 /v1 写进站点地址', () => {
	const notFound = new HttpError(404, 'Not Found', 'https://api.example.com/v1/models', undefined, undefined, undefined);
	assert.match(describeFailureHint(notFound, true), /\/v1/);
});

test('describeFailureHint：限流按是否有 Retry-After 给不同措辞', () => {
	const withWait = new HttpError(429, 'Too Many Requests', 'https://api.example.com', undefined, undefined, 5_000);
	const withoutWait = new HttpError(429, 'Too Many Requests', 'https://api.example.com', undefined, undefined, undefined);

	assert.match(describeFailureHint(withWait, true), /5 秒/);
	assert.match(describeFailureHint(withoutWait, true), /限流/);

	// 服务端只说「1 秒内别来」时按普通限流处理
	const brief = new HttpError(429, 'Too Many Requests', 'https://api.example.com', undefined, undefined, 500);
	assert.match(describeFailureHint(brief, true), /限流/);
});

test('describeFailureHint：超时指向可调的配置项，网络故障不重复啰嗦', () => {
	assert.match(describeFailureHint(new TransportError('timeout', '超时'), true), /timeoutMs/);
	// 网络错误的消息里已经带了分类与处置
	assert.equal(describeFailureHint(new TransportError('network', '断网'), true), undefined);
});

test('describeFailureHint：静默超时与截断各有各的建议', () => {
	assert.match(describeFailureHint(new SseIdleTimeoutError(60_000), true), /streamIdleTimeoutMs/);
	assert.match(describeFailureHint(new SseTruncatedError(3), true), /重发/);
});

test('describeFailureHint：无法归类的错误不给建议', () => {
	assert.equal(describeFailureHint(new Error('???'), true), undefined);
	assert.equal(describeFailureHint(undefined, false), undefined);
	assert.equal(describeFailureHint(new HttpError(400, 'Bad Request', 'https://api.example.com', undefined, undefined, undefined), true), undefined);
});
