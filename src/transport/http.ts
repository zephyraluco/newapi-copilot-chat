/**
 * HTTP 传输层：拼接 URL、超时、重试、把失败归一化成可判别的错误类型。
 * 不含业务语义（业务在 `newApiClient.ts`）。
 */

import { DEFAULTS } from '../shared/consts';
import {
	describeErrorCause,
	getNetworkErrorCauseInfo,
	getNetworkErrorCode,
	getNetworkErrorMessage,
	hostOfUrl,
} from './errors';
import { asNonEmptyString, isRecord, safeJsonParse, truncate } from '../shared/json';
import type { Logger } from '../shared/log';
import type { ApiErrorBody } from '../shared/types';

/* -------------------------------------------------------------------------- */
/* URL                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * 拼接 baseUrl 与端点路径。
 *
 * `baseUrl` 已由 `config.normalizeBaseUrl` 去掉尾斜杠与 `/v1` 后缀，这里再兜一次重复斜杠。
 */
export function joinUrl(baseUrl: string, path: string): string {
	const base = baseUrl.replace(/\/+$/, '');
	const suffix = path.startsWith('/') ? path : `/${path}`;
	return `${base}${suffix}`;
}

/* -------------------------------------------------------------------------- */
/* 错误                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 传输层失败的种类，便于调用方决定是否重试、如何提示。
 *
 * `aborted` 是用户取消（正常流程，不该报错）；`disposed` 是客户端被退役/释放
 * （配置变更、扩展停用）。两者不能混为一谈。
 */
export type TransportErrorKind = 'network' | 'timeout' | 'aborted' | 'disposed';

/** 客户端退役/释放后请求被中断时给用户看的话。 */
const DISPOSED_MESSAGE = '连接配置已变更，本次请求已中断（请重试）';

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
	const detail = apiMessage ?? responseBody;
	const suffix = detail ? `：${detail}` : '';
	// 限流时在错误里带上服务端要求的等待时间
	const wait = retryAfterMs !== undefined && retryAfterMs >= 1_000
		? `，服务端要求约 ${Math.ceil(retryAfterMs / 1_000)} 秒后重试`
		: '';
	return `New API 返回 ${status} ${statusText}${wait}${suffix}（${url}）`;
}

/**
 * VS Code `CancellationError` 的 `name` 取值。
 *
 * 取消信号带 reason 时 `fetch` 会把 reason 原样抛出，其 `name` 是 `Canceled`
 * 而不是 `AbortError`，需要一并识别。
 */
const CANCELLATION_ERROR_NAME = 'Canceled';

/**
 * 判断错误是否为「调用方主动取消」；取消不上报失败，也不触发重试。
 *
 * `TransportError` 只有 `kind === 'aborted'` 才算取消，`'disposed'` 不算。
 */
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

/** `Retry-After` 的解析上限，仅用于挡掉明显异常的输入。 */
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
	/** Per-request override: chat POSTs must never be silently replayed. */
	maxRetries?: number;
	/** 完整 URL（由调用方用 {@link joinUrl} 拼好） */
	url: string;
	method?: 'GET' | 'POST';
	headers?: Record<string, string>;
	/** 已序列化的请求体 */
	body?: string;
	/** 调用方信号（通常来自 CancellationToken） */
	signal?: AbortSignal;
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
}

/**
 * 带超时与重试的 HTTP 客户端。
 *
 * 超时策略：
 * - 非流式请求：整体超时（连接 + 读取）不超过 `timeoutMs`；
 * - 流式请求：`timeoutMs` 只是等响应头的上限，响应体到达后由 `sse.ts` 的静默超时接管。
 */
export class HttpClient {
	private readonly rootController = new AbortController();
	private disposed = false;
	/** 当前在途请求数（含正在被调用方消费的流式响应体） */
	private inFlight = 0;
	private readonly idleWaiters = new Set<() => void>();

	whenIdle(): Promise<void> {
		return this.inFlight === 0 ? Promise.resolve() : new Promise(resolve => this.idleWaiters.add(resolve));
	}

	constructor(private readonly options: HttpClientOptions) { }

	/**
	 * 发送请求并一次性读完响应体。
	 *
	 * 非 2xx 会抛出 {@link HttpError}；网络/超时/取消抛 {@link TransportError}。
	 */
	async requestText(options: RequestOptions): Promise<TextResponse> {
		const release = this.beginInFlight();
		try {
			const { response, text } = await this.fetchWithRetry(options, false);
			return {
				status: response.status,
				statusText: response.statusText,
				url: response.url,
				headers: response.headers,
				text: text ?? '',
			};
		} finally {
			release();
		}
	}

	/**
	 * 发送请求并返回未读完的响应体。
	 *
	 * 重试只覆盖「拿到响应头」这一步，开始消费 body 后不再重试。
	 *
	 * 在途登记由调用方负责：调用方必须用 {@link beginInFlight} 覆盖
	 * 「取响应头 + 读响应体」的整个过程，否则 `retire()` 会在读到一半时中断连接。
	 */
	async requestStream(options: RequestOptions): Promise<StreamResponse> {
		const { response } = await this.fetchWithRetry(options, true);
		const body = response.body;
		if (body === null) {
			throw new TransportError(
				'network',
				`响应没有可读取的流（${response.url}）：通常来自站点或中间的代理异常。`,
			);
		}
		return {
			status: response.status,
			statusText: response.statusText,
			url: response.url,
			headers: response.headers,
			body,
		};
	}

	/**
	 * 登记一次在途请求，返回必须调用一次的释放函数。
	 *
	 * `retire()` 依靠在途计数判断何时中断；流式请求的响应体在 `requestStream`
	 * 返回之后才被消费，因此需要调用方参与登记。
	 */
	beginInFlight(): () => void {
		this.inFlight++;
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			this.inFlight--;
			if (this.inFlight === 0) {
				for (const resolve of this.idleWaiters) { resolve(); }
				this.idleWaiters.clear();
			}
			if (this.disposed && this.inFlight === 0) {
				this.abortRoot();
			}
		};
	}

	/**
	 * 优雅退役：不再接受新请求，等在途请求跑完再中断。
	 *
	 * 与 {@link dispose} 的区别：退役让在途请求自然结束，避免正在生成的回答被掐断。
	 */
	retire(): void {
		this.disposed = true;
		if (this.inFlight === 0) {
			this.abortRoot();
		}
	}

	/** 立即中断所有在途请求（扩展停用时用）。 */
	dispose(): void {
		this.disposed = true;
		this.abortRoot();
	}

	/* ---------------------------------------------------------------------- */

	private abortRoot(): void {
		this.rootController.abort(new TransportError('disposed', DISPOSED_MESSAGE));
	}

	/** 执行带重试的 fetch，直到拿到响应头。 */
	private async fetchWithRetry(options: RequestOptions, streaming: boolean): Promise<{ response: Response; text?: string }> {
		if (this.disposed) {
			throw new TransportError('disposed', DISPOSED_MESSAGE);
		}

		const maxRetries = Math.max(0, options.maxRetries ?? this.options.maxRetries);
		const timeoutMs = this.options.timeoutMs;
		let lastError: unknown;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = resolveRetryDelay(attempt, lastError);
				this.options.logger.debug(`第 ${attempt}/${maxRetries} 次重试，等待 ${delay}ms`);
				await delay_(delay, AbortSignal.any([this.rootController.signal, ...(options.signal ? [options.signal] : [])]));
			}

			const guard = createSignalGuard(options.signal, timeoutMs, this.rootController.signal, streaming);
			// 记录已决定不重试的错误：throw 会被下面的 catch 接住，需要靠它区分
			let decidedToGiveUp: unknown;
			try {
				const response = await this.doFetch(options, guard.signal);
				if (response.ok) {
					return { response, text: streaming ? undefined : await response.text() };
				}

				// 非 2xx：读出响应体，构造可判别的错误
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
				// 服务端要求等待超过上限时不重试，直接报出带等待时间的错误
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
				const transport = normalizeTransportError(error, guard.didTimeout(), streaming, options.url);
				lastError = transport;
				if (transport.kind === 'aborted' || attempt === maxRetries) {
					throw transport;
				}
				this.options.logger.warn(
					`请求失败（${transport.kind}），将重试：${describeErrorCause(transport.cause)}`,
				);
			} finally {
				guard.cleanup();
			}
		}

		throw lastError instanceof Error ? lastError : new TransportError('network', '请求失败且没有可用的错误信息');
	}

	/** 单次 fetch。 */
	private async doFetch(options: RequestOptions, signal: AbortSignal): Promise<Response> {
		this.options.logger.trace(`→ ${options.method ?? 'GET'} ${options.url}`);
		return await fetch(options.url, {
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

/** 读取响应体，失败时返回空串（错误路径兜底，不因读 body 失败而丢掉原始错误）。 */
async function readBodySafely(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/** 超时文案：流式请求只等响应头。 */
function timeoutMessage(streaming: boolean): string {
	return streaming ? '等待 New API 响应头超时' : '请求 New API 超时';
}

/* -------------------------------------------------------------------------- */
/* 错误归一化                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 把任意异常归一化成 TransportError。
 *
 * 消息面向用户：分类句子 + 错误码 + 站点（分类见 `src/errors.ts`）；原始对象挂在 `cause` 上。
 */
function normalizeTransportError(
	error: unknown,
	didTimeout: boolean,
	streaming: boolean,
	url: string | undefined,
): TransportError {
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

	// 分类依据是 `cause` 里的码：外壳（`fetch failed`）不带码也不带信息
	const causeInfo = getNetworkErrorCauseInfo(error);
	const message = getNetworkErrorMessage(getNetworkErrorCode(causeInfo), hostOfUrl(url));
	return new TransportError('network', message, error);
}

/** 计算退避时长：指数增长 + 抖动，并尊重服务端给出的 Retry-After。 */
function resolveRetryDelay(attempt: number, lastError: unknown): number {
	if (lastError instanceof HttpError && lastError.retryAfterMs !== undefined) {
		return lastError.retryAfterMs;
	}
	const exponential = DEFAULTS.retryBaseDelayMs * 2 ** (attempt - 1);
	const capped = Math.min(exponential, DEFAULTS.retryMaxDelayMs);
	// 抖动，避免多个请求在同一时刻一起重试
	return Math.round(capped * (0.5 + Math.random() * 0.5));
}

/** 可等待的延时（避免与 Node 全局 `setTimeout` 的返回类型纠缠）。 */
function delay_(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) { return Promise.reject(signal.reason); }
	return new Promise((resolve, reject) => {
		const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
		const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
		signal.addEventListener('abort', abort, { once: true });
	});
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
			// 信号带 reason 时 `fetch` 会原样抛出，这就是用户最终看到的文案
			controller.abort(new TransportError('timeout', timeoutMessage(streaming)));
		}, timeoutMs)
		: undefined;

	return {
		// Clearing the header timer must not disconnect cancellation during body reads.
		signal: AbortSignal.any([controller.signal, disposedSignal, ...(callerSignal ? [callerSignal] : [])]),
		didTimeout: () => timedOut,
		cleanup: () => {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		},
	};
}
