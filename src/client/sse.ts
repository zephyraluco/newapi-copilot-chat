/**
 * Server-Sent Events（SSE）解析。
 *
 * OpenAI 兼容的流式接口用的是 SSE：一行行纯文本，空行分隔事件。
 * 这里只做「字节流 → 事件」的翻译，不涉及任何业务字段；
 * 业务字段的解释在 `newApiClient.ts` 完成。
 */

import { SSE_DONE } from '../consts';
import { safeJsonParse } from '../json';
import type { Logger } from '../logger';

/** 一个 SSE 事件。 */
export interface SseEvent {
	/** `event:` 字段；OpenAI 兼容接口通常不发送 */
	event?: string;
	/** `data:` 字段；多行会用 `\n` 拼接（符合 SSE 规范） */
	data: string;
	/** `id:` 字段 */
	id?: string;
}

/** 解析参数。 */
export interface SseStreamOptions {
	/** 调用方信号；用于在取消时让读取立刻失败 */
	signal?: AbortSignal;
	/**
	 * 静默超时：连续多久没有收到任何字节就认为连接已死。
	 *
	 * 流式请求不能复用「整体超时」——一个长回答很容易超过整体超时，
	 * 但正常的长回答一定在持续吐字节，所以用「静默」来判定。
	 */
	idleTimeoutMs?: number;
	/** 静默超时触发时回调，由调用方负责中断底层连接 */
	onIdleTimeout?: () => void;
}

/** `reader.read()` 的返回类型。不直接引用 `ReadableStreamReadResult`，因为它并不在所有 lib 组合中全局声明。 */
type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

/** 静默超时错误。与用户主动取消区分开，便于给出不同提示。 */
export class SseIdleTimeoutError extends Error {
	constructor(readonly idleTimeoutMs: number) {
		super(`New API 流式响应中断：${idleTimeoutMs}ms 内没有收到新数据`);
		this.name = 'SseIdleTimeoutError';
	}
}

/**
 * 流在给出正常收尾信号之前就结束了。
 *
 * 与 {@link SseIdleTimeoutError} 的区别：那个是「连接还在，但不再吐数据」，这个是
 * 「连接已经关闭，却既没有 `[DONE]` 也没有 `finish_reason`」——后半截回答被掐掉了。
 * 两者必须分开：上层需要知道「能不能安全重发」（还没给用户看过任何内容时可以），
 * 而静默超时是不吐数据、截断是连接已断。
 */
export class SseTruncatedError extends Error {
	constructor(
		/** 断流前成功解析出的数据块数，仅用于诊断 */
		readonly blocks: number,
	) {
		super(`上游连接在回答完成前断开（已收到 ${blocks} 个数据块，没有 [DONE] 也没有 finish_reason）`);
		this.name = 'SseTruncatedError';
	}
}

/** 判断事件是否表示流结束。 */
export function isDoneEvent(event: SseEvent): boolean {
	return event.data.trim() === SSE_DONE;
}

/**
 * 把字节流解析成 SSE 事件序列。
 *
 * 容错处理：
 * - 按 `\n` 分帧，并容忍 `\r\n`（行尾的回车会被削掉）；单独 `\r` 不分帧；
 * - 以 `:` 开头的心跳注释行会被忽略；
 * - 流结束时缓冲区里残留的半行也会被处理（部分网关不发送结尾空行）。
 */
export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	options: SseStreamOptions = {},
): AsyncGenerator<SseEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');

	let buffer = '';
	let event: string | undefined;
	let id: string | undefined;
	let dataLines: string[] = [];

	const flush = (): SseEvent | undefined => {
		if (dataLines.length === 0 && event === undefined) {
			return undefined;
		}
		const result: SseEvent = { data: dataLines.join('\n'), event, id };
		event = undefined;
		id = undefined;
		dataLines = [];
		return result;
	};

	try {
		while (true) {
			const chunk = await readWithIdleTimeout(reader, options);
			if (chunk.done) {
				break;
			}
			buffer += decoder.decode(chunk.value, { stream: true });

			let newlineIndex: number;
			while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
				let line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.endsWith('\r')) {
					line = line.slice(0, -1);
				}

				if (line.length === 0) {
					const parsed = flush();
					if (parsed) {
						yield parsed;
					}
					continue;
				}
				if (line.startsWith(':')) {
					// 心跳/注释行，忽略
					continue;
				}
				const separator = line.indexOf(':');
				const field = separator < 0 ? line : line.slice(0, separator);
				let value = separator < 0 ? '' : line.slice(separator + 1);
				if (value.startsWith(' ')) {
					value = value.slice(1);
				}
				switch (field) {
					case 'data':
						dataLines.push(value);
						break;
					case 'event':
						event = value;
						break;
					case 'id':
						id = value;
						break;
					default:
						// retry / 其它扩展字段：与本次解析无关
						break;
				}
			}
		}

		// 流结束：把残留内容补上（部分网关的最后一条事件没有结尾换行）
		buffer += decoder.decode();
		if (buffer.length > 0) {
			const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
			if (line.startsWith('data:')) {
				let value = line.slice('data:'.length);
				if (value.startsWith(' ')) {
					value = value.slice(1);
				}
				dataLines.push(value);
			}
		}
		const trailing = flush();
		if (trailing) {
			yield trailing;
		}
	} finally {
		// 无论是正常结束、超时还是取消，都要释放读取锁，否则连接会一直挂着
		try {
			await reader.cancel();
		} catch {
			// 连接已经断开时会抛错，这里无需处理
		}
		reader.releaseLock();
	}
}

/** 逐条读取，并在静默过久时中断。 */
async function readWithIdleTimeout(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	options: SseStreamOptions,
): Promise<StreamReadResult> {
	const { idleTimeoutMs, onIdleTimeout } = options;
	if (!idleTimeoutMs || idleTimeoutMs <= 0) {
		return await reader.read();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const pending = reader.read();
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			onIdleTimeout?.();
			reject(new SseIdleTimeoutError(idleTimeoutMs));
		}, idleTimeoutMs);
	});

	try {
		return await Promise.race([pending, timeout]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
		// 超时分支会让 `pending` 悬空；连接被中断后它会 reject，
		// 挂一个空 catch 避免变成 unhandled rejection。
		void pending.catch(() => { });
	}
}

/**
 * 一次性读完字节流并解码成文本。
 *
 * 用于「网关忽略了 stream 参数」的降级路径：拿到的是普通 JSON，不是 SSE。
 * `options.idleTimeoutMs` 与 SSE 路径语义一致：连续多久没有新字节就判定连接已死。
 * 这条路上必须自己带超时：HTTP 层的超时守卫在拿到响应头之后就已经撤掉了。
 */
export async function readStreamText(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	options: SseStreamOptions = {},
): Promise<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let text = '';
	try {
		while (true) {
			if (signal?.aborted) {
				throw signal.reason instanceof Error ? signal.reason : new Error('请求已取消');
			}
			const chunk = await readWithIdleTimeout(reader, options);
			if (chunk.done) {
				break;
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		try {
			await reader.cancel();
		} catch {
			// 连接已断开时忽略
		}
		reader.releaseLock();
	}
}

/**
 * `parseSseJson` 会回填的收尾信息。
 *
 * 生成器的返回值拿不到（`for await` 会把它丢掉），因此用这个可变对象把
 * 「流是怎么结束的」带出来——判断响应是不是被截断全靠它。
 */
export interface SseJsonOutcome {
	/** 是否收到了 `[DONE]` 结束标记 */
	sawDone: boolean;
	/** 成功解析出的数据块数 */
	blocks: number;
}

/** `parseSseJson` 的参数。 */
export interface SseJsonOptions extends SseStreamOptions {
	readonly logger?: Logger;
	/** 收尾信息的落点；不传则不统计 */
	readonly outcome?: SseJsonOutcome;
}

/**
 * 把 SSE 事件流解析成 JSON 对象流。
 *
 * 用于 OpenAI 兼容接口的 `data: {...}` chunk。遇到 `[DONE]` 直接结束；
 * 单个 chunk 解析失败只记日志并跳过——网关偶尔会插入非 JSON 的心跳或日志行，
 * 不应该因此让整个回答失败。
 */
export async function* parseSseJson<T>(
	body: ReadableStream<Uint8Array>,
	options: SseJsonOptions = {},
): AsyncGenerator<T> {
	const outcome = options.outcome;
	for await (const event of parseSseStream(body, options)) {
		if (isDoneEvent(event)) {
			if (outcome !== undefined) {
				outcome.sawDone = true;
			}
			return;
		}
		const data = event.data.trim();
		if (data.length === 0) {
			continue;
		}
		const parsed = safeJsonParse<T>(data);
		if (parsed === undefined) {
			options.logger?.debug('忽略无法解析的 SSE 数据块', data);
			continue;
		}
		if (outcome !== undefined) {
			outcome.blocks++;
		}
		yield parsed;
	}
}
