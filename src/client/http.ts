/**
 * HTTP 传输层。
 *
 * 只关心四件事：拼接 URL、超时、重试、把各种失败归一化成可判别的错误类型。
 * 不关心业务语义——业务在 `newApiClient.ts` 里。
 */

import { DEFAULTS } from '../consts';
import { asNonEmptyString, isRecord, safeJsonParse, truncate } from '../json';
import { redactText, type Logger } from '../logger';
import type { ApiErrorBody } from '../types';

/* -------------------------------------------------------------------------- */
/* URL                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 拼接 baseUrl 与端点路径。
 *
 * `baseUrl` 已经由 `config.normalizeBaseUrl` 去掉尾斜杠与 `/v1` 后缀，
 * 这里再兜一次重复斜杠，保证 `https://host//v1/models` 这类拼接不会出现。
 */
export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${base}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

/** 传输层失败的种类，便于调用方决定是否重试、如何提示。 */
export type TransportErrorKind = 'network' | 'timeout' | 'aborted';

/** 网络/超时/取消类错误。 */
export class TransportError extends Error {
	constructor(
		readonly kind: TransportErrorKind,
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = 'TransportError';
	}
}

/** 收到响应但状态码非 2xx。 */
export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly statusText: string,
		readonly url: string,
		/** 已按可读长度截断的响应体 */
		readonly responseBody: string | undefined,
		/** 从响应体里解析出的服务端错误描述 */
		readonly apiMessage: string | undefined,
		/** `Retry-After` 解析出的等待毫秒数 */
		readonly retryAfterMs: number | undefined,
	) {
		super(buildHttpErrorMessage(status, statusText, url, apiMessage, responseBody, retryAfterMs));
		this.name = 'HttpError';
	}

	/** 401/403：密钥无效或无权限。 */
	get isAuthError(): boolean {
		return this.status === 401 || this.status === 403;
	}

	/** 404：地址写错，或该网关不提供此端点。 */
	get isNotFound(): boolean {
		return this.status === 404;
	}

	/** 是否值得重试：限流与服务端错误可重试，4xx 业务错误不可。 */
	get isRetryable(): boolean {
		return this.status === 408 || this.status === 409 || this.status === 425 || this.status === 429 || this.status >= 500;
	}
}

function buildHttpErrorMessage(
	status: number,
	statusText: string,
	url: string,
	apiMessage: string | undefined,
	responseBody: string | undefined,
	retryAfterMs: number | undefined,
): string {
	const detail = apiMessage ?? (responseBody ? truncate(responseBody, 300) : undefined);
	const suffix = detail ? `：${detail}` : '';
	// 限流时把服务端要求的等待时间写出来：只说「429」会让人以为马上重试就行
	const wait = retryAfterMs !== undefined && retryAfterMs >= 1_000
		? `，服务端要求约 ${Math.ceil(retryAfterMs / 1_000)} 秒后重试`
		: '';
	return `New API 返回 ${status} ${statusText}${wait}${suffix}（${url}）`;
}

/**
 * VS Code 的 `CancellationError` 用的名字。
 *
 * 取消信号带 reason 时 `fetch` 会把 reason **原样**抛出，而 `new vscode.CancellationError()`
 * 的 `name` 是 `Canceled` 而不是 `AbortError`（见 microsoft/vscode 的 `base/common/errors.ts`）。
 * 漏认它会把用户主动取消当成网络故障，然后白白重试几次。
 */
const CANCELLATION_ERROR_NAME = 'Canceled';

/** 判断错误是否为「调用方主动取消」。取消不应被当成失败上报，也不该触发重试。 */
export function isAbortError(error: unknown): boolean {
	if (error instanceof TransportError) {
		return error.kind === 'aborted';
	}
	if (error instanceof Error) {
		return error.name === 'AbortError' || error.name === CANCELLATION_ERROR_NAME;
	}
	return false;
}

/** 从响应体文本里尽力提取服务端给出的错误说明。 */
function extractApiMessage(text: string | undefined): string | undefined {
	if (!text) {
		return undefined;
	}
	const parsed = safeJsonParse<ApiErrorBody>(text);
	if (isRecord(parsed)) {
		const nested = parsed.error;
		if (isRecord(nested)) {
			const message = asNonEmptyString(nested.message);
			if (message) {
				return message;
			}
		}
		const topLevel = asNonEmptyString(parsed.message);
		if (topLevel) {
			return topLevel;
		}
	}
	return undefined;
}

/**
 * `Retry-After` 的解析上限。
 *
 * 保留真实值（而不是提前夹到退避上限）才能把「服务端要求等多久」如实告诉用户；
 * 真要等到天荒地老的值也没有参考意义，这里只挡掉明显异常的输入。
 */
const RETRY_AFTER_MAX_MS = 24 * 60 * 60_000;

/** 解析 `Retry-After`，兼容秒数与 HTTP 日期两种格式。 */
function parseRetryAfter(header: string | null): number | undefined {
	const trimmed = header?.trim() ?? '';
	if (trimmed.length === 0) {
		return undefined;
	}
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds) && seconds >= 0) {
		return Math.min(seconds * 1_000, RETRY_AFTER_MAX_MS);
	}
	const date = Date.parse(trimmed);
	if (!Number.isNaN(date)) {
		return Math.max(0, Math.min(date - Date.now(), RETRY_AFTER_MAX_MS));
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* 请求/响应                                                                   */
/* -------------------------------------------------------------------------- */

/** 一次 HTTP 调用的参数。 */
export interface RequestOptions {
	/** 完整 URL（由调用方用 {@link joinUrl} 拼好） */
	url: string;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	/** 已序列化的请求体 */
	body?: string;
	/** 调用方信号（通常来自 CancellationToken） */
	signal?: AbortSignal;
	/** 覆盖该次请求的超时 */
	timeoutMs?: number;
	/** 是否允许重试，默认允许 */
	retryable?: boolean;
}

/** 非流式响应：响应体已经读完。 */
export interface TextResponse {
	status: number;
	statusText: string;
	url: string;
	headers: Response['headers'];
	text: string;
}

/** 流式响应：响应体交给调用方继续消费。 */
export interface StreamResponse {
	status: number;
	statusText: string;
	url: string;
	headers: Response['headers'];
	body: NonNullable<Response['body']>;
}

/** 构造 HttpClient 的参数。 */
export interface HttpClientOptions {
	timeoutMs: number;
	maxRetries: number;
	userAgent: string;
	logger: Logger;
	/** 便于测试注入；默认用全局 `fetch` */
	fetchImpl?: typeof fetch;
}

/**
 * 带超时与重试的 HTTP 客户端。
 *
 * 超时策略：
 * - 非流式请求：整体超时（连接 + 读取）不得超过 `timeoutMs`；
 * - 流式请求：`timeoutMs` 只作为「等响应头」的上限，响应体开始到达后由
 *   `sse.ts` 的静默超时接管——否则一个长回答会被整体超时误杀。
 */
export class HttpClient {
	private readonly rootController = new AbortController();
	private disposed = false;

	constructor(private readonly options: HttpClientOptions) { }

	/**
	 * 发送请求并一次性读完响应体。
	 *
	 * 非 2xx 会抛出 {@link HttpError}；网络/超时/取消抛 {@link TransportError}。
	 */
	async requestText(options: RequestOptions): Promise<TextResponse> {
		const response = await this.fetchWithRetry(options, false);
		const text = await response.text();
		return {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headers: response.headers,
			text,
		};
	}

	/**
	 * 发送请求并返回未读完的响应体。
	 *
	 * 重试只覆盖「拿到响应头」这一步；一旦开始消费 body 就不再重试，
	 * 因为服务端可能已经开始计费。
	 */
	async requestStream(options: RequestOptions): Promise<StreamResponse> {
		const response = await this.fetchWithRetry(options, true);
		const body = response.body;
		if (body === null) {
			throw new TransportError('network', `响应没有可读取的流（${response.url}）`);
		}
		return {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headers: response.headers,
			body,
		};
	}

	/** 中断所有在途请求。 */
	dispose(): void {
		this.disposed = true;
		this.rootController.abort(new TransportError('aborted', '客户端已释放'));
	}

	/** 是否已释放。释放后所有请求立即失败，便于在配置变更时重建客户端。 */
	get isDisposed(): boolean {
		return this.disposed;
	}

	/* ---------------------------------------------------------------------- */

	/** 执行带重试的 fetch，直到拿到响应头。 */
	private async fetchWithRetry(options: RequestOptions, streaming: boolean): Promise<Response> {
		if (this.disposed) {
			throw new TransportError('aborted', '客户端已释放');
		}

		const maxRetries = options.retryable === false ? 0 : Math.max(0, this.options.maxRetries);
		const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;
		let lastError: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = resolveRetryDelay(attempt, lastError);
				this.options.logger.debug(`第 ${attempt}/${maxRetries} 次重试，等待 ${delay}ms`);
				await delay_(delay);
			}

			const guard = createSignalGuard(options.signal, timeoutMs, this.rootController.signal, streaming);
			// 在 try 里判定「不重试」的错误要靠这个标记带出来：`throw` 会被下面的 catch 接住，
			// 而 catch 只看 `isRetryable` / `attempt` 时会把它当成可重试的网络故障。
			let decidedToGiveUp: unknown;
			try {
				const response = await this.doFetch(options, guard.signal);
				if (response.ok) {
					return response;
				}

				// 非 2xx：把响应体读出来（通常很小），构造可判别的错误
				const bodyText = await readBodySafely(response);
				const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
				const error = new HttpError(
					response.status,
					response.statusText,
					response.url,
					bodyText ? truncate(bodyText, 1000) : undefined,
					extractApiMessage(bodyText),
					retryAfter,
				);
				lastError = error;
				// 服务端明确要求等很久的限流不值得重试：等到一半再撞一次 429，
				// 最后给出的错误还看不出真正原因。直接把带等待时间的错误报出去。
				const retryAfterTooLong = retryAfter !== undefined && retryAfter > DEFAULTS.retryAfterMaxWaitMs;
				if (!error.isRetryable || attempt === maxRetries || retryAfterTooLong) {
					if (retryAfter !== undefined && retryAfterTooLong) {
						this.options.logger.warn(
							`服务端要求 ${Math.ceil(retryAfter / 1_000)} 秒后重试，` +
							`超过 ${DEFAULTS.retryAfterMaxWaitMs / 1_000} 秒上限，不再重试`,
						);
					}
					decidedToGiveUp = error;
					throw error;
				}
				this.options.logger.warn(`请求失败（HTTP ${response.status}），将重试`, error.message);
			} catch (error) {
				// 已经决定不再重试的错误直接抛出去
				if (error === decidedToGiveUp) {
					throw error;
				}
				const transport = normalizeTransportError(error, guard.didTimeout(), streaming);
				lastError = transport;
				if (transport.kind === 'aborted' || attempt === maxRetries) {
					throw transport;
				}
				this.options.logger.warn(`请求失败（${transport.kind}），将重试`, transport.message);
			} finally {
				guard.cleanup();
			}
		}

		throw lastError instanceof Error ? lastError : new TransportError('network', '请求失败且没有可用的错误信息');
	}

	/** 单次 fetch。 */
	private async doFetch(options: RequestOptions, signal: AbortSignal): Promise<Response> {
		const fetchImpl = this.options.fetchImpl ?? fetch;
		this.options.logger.trace(`→ ${options.method ?? 'GET'} ${options.url}`);
		return await fetchImpl(options.url, {
			method: options.method ?? 'GET',
			headers: {
				'User-Agent': this.options.userAgent,
				...(options.headers ?? {}),
			},
			body: options.body,
			signal,
		});
	}
}

/** 读取响应体，失败时返回空串（错误路径上的兜底，不能因为读 body 失败而丢掉原始错误）。 */
async function readBodySafely(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/** 超时文案：流式请求只等响应头，提示里要说清这一点。 */
function timeoutMessage(streaming: boolean): string {
	return streaming ? '等待 New API 响应头超时' : '请求 New API 超时';
}

/** 把任意异常归一化成 TransportError。 */
function normalizeTransportError(error: unknown, didTimeout: boolean, streaming: boolean): TransportError {
	if (error instanceof TransportError) {
		return error;
	}
	if (error instanceof HttpError) {
		return new TransportError('network', error.message, error);
	}
	if (didTimeout) {
		return new TransportError('timeout', timeoutMessage(streaming), error);
	}
	if (isAbortError(error)) {
		return new TransportError('aborted', '请求已取消', error);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new TransportError('network', `无法连接 New API：${redactText(message)}`, error);
}

/** 计算退避时长：指数增长 + 抖动，并尊重服务端给出的 Retry-After。 */
function resolveRetryDelay(attempt: number, lastError: unknown): number {
	if (lastError instanceof HttpError && lastError.retryAfterMs !== undefined) {
		return lastError.retryAfterMs;
	}
	const exponential = DEFAULTS.retryBaseDelayMs * 2 ** (attempt - 1);
	const capped = Math.min(exponential, DEFAULTS.retryMaxDelayMs);
	// 抖动：避免多个请求在同一时刻一起重试
	return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/** 可等待的延时。放在这里避免与 Node 全局 `setTimeout` 的返回类型纠缠。 */
function delay_(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** 信号守卫：把「调用方信号 + 超时 + 客户端释放」合并成一个 AbortSignal。 */
interface SignalGuard {
	signal: AbortSignal;
	didTimeout(): boolean;
	cleanup(): void;
}

function createSignalGuard(
	callerSignal: AbortSignal | undefined,
	timeoutMs: number,
	disposedSignal: AbortSignal,
	streaming: boolean,
): SignalGuard {
	const controller = new AbortController();
	let timedOut = false;

	const timer = timeoutMs > 0
		? setTimeout(() => {
			timedOut = true;
			// 信号带 reason 时 `fetch` 会把 reason 原样抛出，所以这句话就是用户最终看到的文案
			controller.abort(new TransportError('timeout', timeoutMessage(streaming)));
		}, timeoutMs)
		: undefined;

	const forward = (source: AbortSignal) => {
		const onAbort = () => controller.abort(source.reason);
		if (source.aborted) {
			onAbort();
			return () => { };
		}
		source.addEventListener('abort', onAbort, { once: true });
		return () => source.removeEventListener('abort', onAbort);
	};

	const detachCaller = callerSignal ? forward(callerSignal) : () => { };
	const detachDisposed = forward(disposedSignal);

	return {
		signal: controller.signal,
		didTimeout: () => timedOut,
		cleanup: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
			detachCaller();
			detachDisposed();
		},
	};
}
