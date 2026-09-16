/**
 * 网络层的测试替身：可控的 `fetch`、假响应，以及可编排的字节流。
 *
 * 刻意**不**用全局的 `Response` / `ReadableStream` 构造真实对象：
 * - 网络层测试真正关心的是「第几次调用返回什么」「响应头、状态码是什么」、
 *   「字节流在哪个位置切片」「连接什么时候卡住」，手工替身能精确控制这些，
 *   而真实对象还要绕一圈才能编排；
 * - 替身不依赖运行环境提供哪些全局对象，换 Node 版本或换测试宿主都不会失效。
 *
 * 文件名不含 `.test.`，因此不会被 `.vscode-test.mjs` 的 glob 收集成用例。
 */

/** 一次 `fetch` 调用的记录。 */
export interface FetchCall {
	readonly url: string;
	readonly init: RequestInit | undefined;
}

/** 注入用的假 `fetch`：既是 `typeof fetch`，也留下调用记录。 */
export interface FakeFetch {
	readonly impl: typeof fetch;
	/** 按发生顺序记录的调用；断言「重试了几次」「URL 拼对没有」都靠它 */
	readonly calls: readonly FetchCall[];
}

/**
 * 按调用序号决定返回什么的假 `fetch`。
 *
 * `handler` 抛出的异常会变成 reject，与真实 `fetch` 连接失败的表现一致。
 */
export function fakeFetch(handler: (call: FetchCall, index: number) => Promise<Response> | Response): FakeFetch {
	const calls: FetchCall[] = [];
	const impl = (async (url: unknown, init?: RequestInit): Promise<Response> => {
		const call: FetchCall = { url: String(url), init };
		const index = calls.length;
		calls.push(call);
		return await handler(call, index);
	}) as unknown as typeof fetch;
	return { impl, calls };
}

/**
 * 永远不结算、但在信号中断时 reject 的假 `fetch`。
 *
 * 必须认信号：真实 `fetch` 被中断时会立刻 reject，若替身只是「不结算」，
 * 超时与取消路径就永远不会返回（`HttpClient` 等的是 `fetch`，不是计时器）。
 */
export function hangingFetch(): FakeFetch {
	return fakeFetch(call =>
		new Promise<Response>((_resolve, reject) => {
			const signal = call.init?.signal ?? undefined;
			const onAbort = () => {
				const error = new Error('The operation was aborted');
				error.name = 'AbortError';
				reject(error);
			};
			if (signal?.aborted === true) {
				onAbort();
				return;
			}
			signal?.addEventListener('abort', onAbort, { once: true });
		}));
}

/** 假的响应头集合：只实现被用到的 `get`。 */
function fakeHeaders(init: Record<string, string> = {}): Response['headers'] {
	const entries = new Map(Object.entries(init).map(([key, value]) => [key.toLowerCase(), value]));
	return {
		get: (name: string): string | null => entries.get(name.toLowerCase()) ?? null,
	} as unknown as Response['headers'];
}

/** 构造假响应的公共字段。 */
function baseResponse(
	status: number,
	url: string,
	headers: Record<string, string>,
	statusText: string,
): Record<string, unknown> {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText,
		url,
		headers: fakeHeaders(headers),
	};
}

/** 一个响应体已经读完的假响应（`requestText` 用）。 */
export function jsonResponse(
	body: unknown,
	options: { status?: number; statusText?: string; headers?: Record<string, string>; url?: string } = {},
): Response {
	const status = options.status ?? 200;
	const text = typeof body === 'string' ? body : JSON.stringify(body);
	return {
		...baseResponse(
			status,
			options.url ?? 'https://api.example.com/v1/models',
			options.headers ?? {},
			options.statusText ?? (status < 300 ? 'OK' : 'Error'),
		),
		text: async (): Promise<string> => text,
		// 一次性读完的响应没有可读取的流：`requestStream` 会据此报错
		body: null,
	} as unknown as Response;
}

/** 一个带未读完字节流的假响应（`requestStream` 用）。 */
export function streamResponse(
	chunks: readonly (string | Uint8Array)[],
	options: { status?: number; headers?: Record<string, string>; url?: string; hang?: boolean } = {},
): Response {
	const status = options.status ?? 200;
	return {
		...baseResponse(
			status,
			options.url ?? 'https://api.example.com/v1/chat/completions',
			options.headers ?? {},
			status < 300 ? 'OK' : 'Error',
		),
		text: async (): Promise<string> => '',
		body: scriptedStream(chunks, options.hang === true ? { hang: true } : {}).stream,
	} as unknown as Response;
}

/** 一个可编排的字节流：既能精确控制分片位置，也能模拟「连接卡死」。 */
export interface ScriptedStream {
	readonly stream: ReadableStream<Uint8Array>;
	/** 读取器是否被取消（`parseSseStream` 的 `finally` 会做这件事） */
	cancelled(): boolean;
	/** 读取锁是否被释放 */
	released(): boolean;
}

/**
 * 按给定的分片顺序产出字节，然后结束（或永远不结束）。
 *
 * `hang: true` 用来模拟「连接没断，但再也不吐数据」，这是静默超时唯一的触发方式。
 */
export function scriptedStream(
	chunks: readonly (string | Uint8Array)[],
	options: { hang?: boolean } = {},
): ScriptedStream {
	const encoder = new TextEncoder();
	const queue = chunks.map(chunk => (typeof chunk === 'string' ? encoder.encode(chunk) : chunk));
	let index = 0;
	let cancelled = false;
	let released = false;

	const reader = {
		read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
			if (index < queue.length) {
				const value = queue[index];
				index++;
				return { done: false, value };
			}
			if (options.hang === true) {
				// 永不结算：连接还在，但不再产生数据
				return await new Promise<never>(() => { /* 故意挂着 */ });
			}
			return { done: true };
		},
		cancel: async (): Promise<void> => {
			cancelled = true;
		},
		releaseLock: (): void => {
			released = true;
		},
	};

	return {
		stream: { getReader: () => reader } as unknown as ReadableStream<Uint8Array>,
		cancelled: () => cancelled,
		released: () => released,
	};
}
