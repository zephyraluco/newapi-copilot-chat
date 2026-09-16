import * as assert from 'assert';
import {
	SseIdleTimeoutError,
	isDoneEvent,
	parseSseJson,
	parseSseStream,
	readStreamText,
} from '../client/sse';
import type { SseEvent, SseStreamOptions } from '../client/sse';
import { scriptedStream } from './fakes';
import { capturingLogger } from './helpers';

/**
 * SSE 解析的测试。
 *
 * 这一段直接决定「回答能不能一个字一个字地流出来」，而分片边界完全由网络决定：
 * 一个事件可能被切成两半、UTF-8 字符可能被从中间切开、心跳行会插在事件之间、
 * 最后一条事件可能没有结尾换行。这些情况在真实网关上偶发，靠手工测试基本碰不到。
 */

/** 收集流里的全部事件。 */
async function collect(stream: ReadableStream<Uint8Array>, options: SseStreamOptions = {}): Promise<SseEvent[]> {
	const events: SseEvent[] = [];
	for await (const event of parseSseStream(stream, options)) {
		events.push(event);
	}
	return events;
}

/** 只取 `data` 字段，方便断言。 */
async function collectData(chunks: readonly (string | Uint8Array)[]): Promise<string[]> {
	const events = await collect(scriptedStream(chunks).stream);
	return events.map(event => event.data);
}

suite('client / SSE 解析', () => {
	test('按空行分隔事件，并去掉 data 后的一个空格', async () => {
		assert.deepStrictEqual(
			await collectData(['data: {"n":1}\n\ndata: {"n":2}\n\n']),
			['{"n":1}', '{"n":2}'],
		);
	});

	test('多行 data 按规范用换行拼接成一个事件', async () => {
		assert.deepStrictEqual(await collectData(['data: first\ndata: second\n\n']), ['first\nsecond']);
	});

	test('CRLF 换行与 LF 等价', async () => {
		assert.deepStrictEqual(await collectData(['data: {"n":1}\r\n\r\n']), ['{"n":1}']);
	});

	test('CRLF 正好被切在两个分片之间时也能正确分帧', async () => {
		assert.deepStrictEqual(await collectData(['data: {"n":1}\r', '\n\r\n']), ['{"n":1}']);
	});

	test('以冒号开头的心跳注释行被忽略', async () => {
		assert.deepStrictEqual(
			await collectData([': keep-alive\n\ndata: {"n":1}\n\n: ping\n\n']),
			['{"n":1}'],
		);
	});

	test('event 与 id 字段被保留下来', async () => {
		const events = await collect(scriptedStream(['event: message\nid: 7\ndata: x\n\n']).stream);
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event, 'message');
		assert.strictEqual(events[0].id, '7');
		assert.strictEqual(events[0].data, 'x');
	});

	test('事件被切成多个分片、且 UTF-8 字符被从中间切开时不会乱码', async () => {
		const bytes = new TextEncoder().encode('data: 中文内容\n\n');
		// 第 8 个字节落在「中」的中间，解码器必须自己把半截字符攒起来
		const events = await collect(scriptedStream([bytes.slice(0, 8), bytes.slice(8)]).stream);
		assert.deepStrictEqual(events.map(event => event.data), ['中文内容']);
	});

	test('最后一条事件没有结尾换行时也会被产出', async () => {
		assert.deepStrictEqual(await collectData(['data: {"n":1}\n\ndata: {"n":2}']), ['{"n":1}', '{"n":2}']);
	});

	test('识别流结束标记', () => {
		assert.strictEqual(isDoneEvent({ data: '[DONE]' }), true);
		assert.strictEqual(isDoneEvent({ data: '  [DONE]  ' }), true);
		assert.strictEqual(isDoneEvent({ data: '{"n":1}' }), false);
	});

	test('解析成 JSON 时遇到 [DONE] 立刻停止', async () => {
		const values: unknown[] = [];
		const stream = scriptedStream([
			'data: {"n":1}\n\n',
			'data: [DONE]\n\n',
			'data: {"n":2}\n\n',
		]).stream;

		for await (const value of parseSseJson<{ n: number }>(stream)) {
			values.push(value);
		}

		assert.deepStrictEqual(values, [{ n: 1 }], '[DONE] 之后的数据块不应该再被读取');
	});

	test('无法解析的数据块被跳过并记日志，而不是让整个回答失败', async () => {
		const logs = capturingLogger();
		const values: unknown[] = [];
		const stream = scriptedStream([
			'data: {"n":1}\n\n',
			'data: 这不是 JSON\n\n',
			'data:\n\n',
			'data: {"n":2}\n\n',
		]).stream;

		for await (const value of parseSseJson<{ n: number }>(stream, { logger: logs.logger })) {
			values.push(value);
		}

		assert.deepStrictEqual(values, [{ n: 1 }, { n: 2 }]);
		assert.ok(logs.messages('debug').some(line => line.includes('忽略无法解析')));
	});

	/* ---------------------------------------------------------------------- */
	/* 静默超时                                                                */
	/* ---------------------------------------------------------------------- */

	test('静默过久抛超时错误、回调通知调用方，并释放读取锁', async () => {
		const handle = scriptedStream(['data: {"n":1}\n\n'], { hang: true });
		let notified = false;

		let caught: unknown;
		const seen: SseEvent[] = [];
		try {
			for await (const event of parseSseStream(handle.stream, {
				idleTimeoutMs: 30,
				onIdleTimeout: () => {
					notified = true;
				},
			})) {
				seen.push(event);
			}
		} catch (error) {
			caught = error;
		}

		if (!(caught instanceof SseIdleTimeoutError)) {
			throw new Error(`预期是 SseIdleTimeoutError，实际是 ${String(caught)}`);
		}
		assert.strictEqual(caught.idleTimeoutMs, 30);
		assert.strictEqual(notified, true, '调用方要靠这个回调去中断底层连接');
		assert.deepStrictEqual(seen.map(event => event.data), ['{"n":1}'], '超时前收到的数据不应该丢');
		assert.strictEqual(handle.cancelled(), true, '超时后必须取消读取，否则连接会一直挂着');
		assert.strictEqual(handle.released(), true);
	});

	test('关闭静默超时（0）时按原样读取', async () => {
		const handle = scriptedStream(['data: 1\n\n']);
		const events = await collect(handle.stream, { idleTimeoutMs: 0 });

		assert.deepStrictEqual(events.map(event => event.data), ['1']);
	});

	/* ---------------------------------------------------------------------- */
	/* 非 SSE 降级路径                                                         */
	/* ---------------------------------------------------------------------- */

	test('一次性读取整段文本（网关忽略 stream 参数时的降级路径）', async () => {
		const handle = scriptedStream(['{"choices"', ':[{"message":{"content":"hi"}}]}']);
		assert.strictEqual(await readStreamText(handle.stream), '{"choices":[{"message":{"content":"hi"}}]}');
		assert.strictEqual(handle.cancelled(), true);
	});

	test('一次性读取时信号已经中断则立刻失败', async () => {
		const controller = new AbortController();
		controller.abort(new Error('已取消'));
		let caught: unknown;
		try {
			await readStreamText(scriptedStream(['{}']).stream, controller.signal);
		} catch (error) {
			caught = error;
		}

		assert.ok(caught instanceof Error);
		assert.strictEqual((caught as Error).message, '已取消');
	});
});
