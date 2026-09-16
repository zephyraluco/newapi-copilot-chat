/**
 * New API 客户端：与 New API 交互的唯一入口（上层只依赖这里的方法与返回类型，不直接碰 HTTP）。
 *
 * - `GET  /api/status`           公开状态（探活、站点信息、版本）
 * - `GET  /v1/models`            模型列表
 * - `POST /v1/chat/completions`  对话补全（流式 / 非流式）
 */

import { ENDPOINTS, SSE_CONTENT_TYPE, runtimeInfo } from '../consts';
import { asNonEmptyString, isRecord, safeJsonParse, safeJsonStringify, truncate } from '../json';
import type { Logger } from '../logger';
import { redactText } from '../logger';
import type {
	ChatCompletionChunk,
	ChatCompletionRequest,
	ChatCompletionResponse,
	NewApiModel,
	NewApiModelListResponse,
	NewApiStatus,
	NewApiStatusResponse,
} from '../types';
import { HttpClient, HttpError, TransportError, joinUrl } from './http';
import { SseIdleTimeoutError, parseSseJson, readStreamText } from './sse';

/** 构造客户端的参数。 */
export interface NewApiClientOptions {
	/** 站点根地址，已由 `config.normalizeBaseUrl` 规范化 */
	baseUrl: string;
	/** 未设置时，`/v1/*` 端点会返回 401 */
	apiKey: string | undefined;
	/** 请求超时 */
	timeoutMs: number;
	/** 失败重试次数 */
	maxRetries: number;
	logger: Logger;
	/** 便于测试注入 */
	fetchImpl?: typeof fetch;
}

/** `/api/status` 的读取结果。该端点是 New API 自有扩展，可能被关闭，因此单独建模。 */
export interface StatusFetchResult {
	/** 端点是否可用 */
	readonly available: boolean;
	readonly status?: NewApiStatus;
	/** 不可用时的原因（已被脱敏） */
	readonly reason?: string;
}

/**
 * New API 客户端。
 *
 * 实例是「一次性」的：baseUrl / apiKey / 超时等参数在构造时固定，配置变化时
 * 由上层重建实例并 `dispose()` 掉旧的。这样能避免「请求发出后配置被改了」
 * 造成的不一致状态。
 */
export class NewApiClient {
	private readonly http: HttpClient;

	constructor(private readonly options: NewApiClientOptions) {
		this.http = new HttpClient({
			timeoutMs: options.timeoutMs,
			maxRetries: options.maxRetries,
			userAgent: buildUserAgent(),
			logger: options.logger.child('http'),
			fetchImpl: options.fetchImpl,
		});
	}

	/** 规范化后的站点地址。 */
	get baseUrl(): string {
		return this.options.baseUrl;
	}

	/** 是否已配置 API Key（不返回密钥本身）。 */
	get hasApiKey(): boolean {
		return this.options.apiKey !== undefined && this.options.apiKey.length > 0;
	}

	/* ---------------------------------------------------------------------- */
	/* 模型列表                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * 拉取模型列表。
	 *
	 * 兼容几种常见返回形态：`{data:[...]}`、`{data:{data:[...]}}`、裸数组。
	 * 结果按 id 排序，保证模型选择器顺序稳定（否则每次刷新顺序都会变）。
	 */
	async listModels(signal?: AbortSignal): Promise<NewApiModel[]> {
		const url = joinUrl(this.options.baseUrl, ENDPOINTS.models);
		const response = await this.http.requestText({
			url,
			method: 'GET',
			headers: this.authHeaders(),
			signal,
		});

		const parsed = safeJsonParse<NewApiModelListResponse | NewApiModel[]>(response.text);
		const models = extractModelList(parsed);
		if (models.length === 0) {
			// 有些网关不返回 data 字段，而是把错误塞在 200 响应里
			const message = isRecord(parsed) ? asNonEmptyString(parsed.message) : undefined;
			this.options.logger.warn(`模型列表为空${message ? `：${message}` : ''}`);
		}

		const deduped = new Map<string, NewApiModel>();
		for (const model of models) {
			const id = asNonEmptyString(model.id);
			if (id && !deduped.has(id)) {
				deduped.set(id, { ...model, id });
			}
		}
		return [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/* ---------------------------------------------------------------------- */
	/* 站点状态                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * 读取站点状态。
	 *
	 * 该端点是 New API 自有扩展且无需鉴权，第三方 OpenAI 兼容网关通常没有它，
	 * 因此失败时返回 `available: false` 而不是抛异常——它只是「锦上添花」的信息。
	 */
	async getStatus(signal?: AbortSignal): Promise<StatusFetchResult> {
		const url = joinUrl(this.options.baseUrl, ENDPOINTS.status);
		try {
			const response = await this.http.requestText({ url, method: 'GET', signal });
			const parsed = safeJsonParse<NewApiStatusResponse>(response.text);
			if (!isRecord(parsed) || !isRecord(parsed.data)) {
				return { available: false, reason: '响应结构不是 New API 的 /api/status 格式' };
			}
			return { available: true, status: parsed.data };
		} catch (error) {
			return { available: false, reason: describeError(error) };
		}
	}

	/* ---------------------------------------------------------------------- */
	/* 对话补全                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * 流式对话补全。
	 *
	 * 把「调用方取消」与「静默超时」都收敛到同一个 AbortSignal 上：
	 * 任意一方触发，底层的 fetch 与 SSE 读取都会立刻结束。
	 */
	async *streamChatCompletion(
		request: ChatCompletionRequest,
		signal?: AbortSignal,
	): AsyncGenerator<ChatCompletionChunk> {
		const url = joinUrl(this.options.baseUrl, ENDPOINTS.chatCompletions);
		const body = safeJsonStringify({
			...request,
			stream: true,
			stream_options: { include_usage: true },
		});
		if (body === undefined) {
			throw new TransportError('network', '请求体无法序列化为 JSON');
		}

		const controller = new AbortController();
		const forward = attachAbort(signal, controller);
		this.options.logger.trace(`→ POST ${url}`, redactText(truncate(body, 2000)));

		try {
			const response = await this.http.requestStream({
				url,
				method: 'POST',
				headers: this.authHeaders(),
				body,
				signal: controller.signal,
			});

			const contentType = response.headers.get('content-type') ?? '';
			if (!contentType.includes(SSE_CONTENT_TYPE)) {
				// 网关忽略了 stream:true，直接返回普通 JSON（部分中转/降级配置会这样）。
				// 这时如果继续按 SSE 解析，会把整段 JSON 当成一行数据而什么都拿不到，
				// 因此这里降级成「单块非流式响应」。
				this.options.logger.warn(`响应不是 SSE（content-type=${contentType || '未知'}），按单块 JSON 处理`);
				const text = await readStreamText(response.body, controller.signal);
				const chunk = completionToChunk(text);
				if (chunk === undefined) {
					throw new TransportError('network', `无法解析响应：${truncate(redactText(text), 300)}`);
				}
				yield chunk;
				return;
			}

			let chunkCount = 0;
			for await (const chunk of parseSseJson<ChatCompletionChunk>(response.body, {
				signal: controller.signal,
				idleTimeoutMs: this.options.timeoutMs,
				onIdleTimeout: () => controller.abort(new SseIdleTimeoutError(this.options.timeoutMs)),
				logger: this.options.logger,
			})) {
				chunkCount++;
				yield chunk;
			}
			this.options.logger.debug(`流式响应结束，共 ${chunkCount} 个数据块`);
		} finally {
			forward.dispose();
			// 提前退出（例如调用方 break）时要主动断流，否则连接会挂到超时
			controller.abort(new TransportError('aborted', '流式请求已结束'));
		}
	}

	/** 非流式对话补全。 */
	async chatCompletion(
		request: ChatCompletionRequest,
		signal?: AbortSignal,
	): Promise<ChatCompletionResponse> {
		const url = joinUrl(this.options.baseUrl, ENDPOINTS.chatCompletions);
		const body = safeJsonStringify({ ...request, stream: false });
		if (body === undefined) {
			throw new TransportError('network', '请求体无法序列化为 JSON');
		}

		const response = await this.http.requestText({
			url,
			method: 'POST',
			headers: this.authHeaders(),
			body,
			signal,
		});
		const parsed = safeJsonParse<ChatCompletionResponse>(response.text);
		if (parsed === undefined || parsed === null || typeof parsed !== 'object') {
			throw new TransportError('network', `响应不是合法 JSON：${truncate(redactText(response.text), 300)}`);
		}
		return parsed;
	}

	/* ---------------------------------------------------------------------- */

	/** 释放客户端，中断所有在途请求。 */
	dispose(): void {
		this.http.dispose();
	}

	/* ---------------------------------------------------------------------- */

	/** 构造鉴权头。 */
	private authHeaders(): Record<string, string> {
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.options.apiKey) {
			headers['Authorization'] = `Bearer ${this.options.apiKey}`;
		}
		return headers;
	}
}

/**
 * User-Agent：便于站点管理员在日志里识别流量来源。
 *
 * 每次构造客户端时读取，因此在 `activate()` 写入版本号之后再创建客户端即可拿到真实版本。
 */
function buildUserAgent(): string {
	return runtimeInfo.userAgent;
}

/**
 * 把外部信号转发到内部控制器，并返回解绑函数。
 *
 * 用内部控制器是为了把「调用方取消」与「静默超时」合并到同一条信号上：
 * 任意一方触发，底层的 fetch 与 SSE 读取都会立刻结束。
 */
function attachAbort(source: AbortSignal | undefined, controller: AbortController): { dispose(): void } {
	if (source === undefined) {
		return { dispose: () => { } };
	}
	if (source.aborted) {
		controller.abort(source.reason);
		return { dispose: () => { } };
	}
	const onAbort = () => controller.abort(source.reason);
	source.addEventListener('abort', onAbort, { once: true });
	return { dispose: () => source.removeEventListener('abort', onAbort) };
}

/**
 * 把非流式响应转成等价的 chunk，让上层只需要处理一种形态。
 *
 * 失败时返回 `undefined`（由调用方决定如何报错），不在这里抛异常。
 */
function completionToChunk(text: string): ChatCompletionChunk | undefined {
	const parsed = safeJsonParse<ChatCompletionResponse>(text);
	// 注意：这里不能用 `isRecord` 收窄——它会把类型变成 `Record<string, unknown>`，
	// 反而丢掉 `ChatCompletionResponse` 的字段类型。用 typeof 判断即可。
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
	return {
		id: asNonEmptyString(parsed.id),
		model: asNonEmptyString(parsed.model),
		created: typeof parsed.created === 'number' ? parsed.created : undefined,
		usage: parsed.usage,
		choices: choices.map((choice, index) => ({
			index: typeof choice.index === 'number' ? choice.index : index,
			finish_reason: choice.finish_reason ?? 'stop',
			delta: {
				role: choice.message?.role,
				content: choice.message?.content ?? undefined,
				reasoning_content: choice.message?.reasoning_content ?? undefined,
				tool_calls: choice.message?.tool_calls?.map((call, callIndex) => ({
					index: callIndex,
					id: call.id,
					type: call.type,
					function: call.function,
				})),
			},
		})),
	};
}

/** 从各种返回形态里提取模型数组。 */
function extractModelList(parsed: unknown): NewApiModel[] {
	if (Array.isArray(parsed)) {
		return parsed.map(toModel).filter(item => item !== undefined);
	}
	if (!isRecord(parsed)) {
		return [];
	}
	const direct = parsed.data;
	if (Array.isArray(direct)) {
		return direct.map(toModel).filter(item => item !== undefined);
	}
	// 部分网关把列表再包一层：{ data: { data: [...] } }
	if (isRecord(direct) && Array.isArray(direct.data)) {
		return direct.data.map(toModel).filter(item => item !== undefined);
	}
	if (Array.isArray(parsed.models)) {
		return parsed.models.map(toModel).filter(item => item !== undefined);
	}
	return [];
}

/**
 * 把原始条目转成模型对象。
 *
 * 接受两种 id 字段名：
 * - 标准 OpenAI `/v1/models`：`id`
 * - New API 自有 `/api/models`：`model_name`
 *
 * 两者都不存在时返回 `undefined`，由调用方计入 `invalidCount`。
 */
function toModel(value: unknown): NewApiModel | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const id = asNonEmptyString(value.id) ?? asNonEmptyString(value.model_name);
	return id === undefined ? undefined : { ...value, id };
}

/** 把任意异常描述成一句可展示的话（已脱敏）。 */
export function describeError(error: unknown): string {
	if (error === undefined) {
		return '未知错误';
	}
	if (error instanceof HttpError) {
		return redactText(error.message);
	}
	if (error instanceof TransportError || error instanceof SseIdleTimeoutError) {
		return redactText(error.message);
	}
	if (error instanceof Error) {
		return redactText(error.message);
	}
	return redactText(String(error));
}

/**
 * 针对常见失败给出可操作建议。
 *
 * 只根据错误本身判断，不读配置：调用方自己清楚密钥是否已设置。
 */
export function describeFailureHint(error: unknown, hasApiKey: boolean): string | undefined {
	if (error instanceof HttpError) {
		if (error.isAuthError) {
			return hasApiKey
				? 'API Key 被拒绝，请确认它在该站点有效且已启用。'
				: '尚未设置 API Key，请在「管理模型」界面中为本供应商填写。';
		}
		if (error.isNotFound) {
			return '接口不存在：请检查站点地址是否指向 New API 站点根目录（不要带 /v1）。';
		}
		if (error.status === 429) {
			return '请求被限流，请稍后重试或检查站点的速率限制。';
		}
		return undefined;
	}
	if (error instanceof TransportError) {
		if (error.kind === 'timeout') {
			return '请求超时：请检查网络，或调大 newapi-copilot-chat.request.timeoutMs。';
		}
		if (error.kind === 'network') {
			return '无法建立连接：请检查站点地址、DNS 以及是否需要代理。';
		}
	}
	return undefined;
}
