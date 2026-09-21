import * as assert from 'assert';
import { SseIdleTimeoutError, SseTruncatedError } from '../client/sse';
import type { ResponsePart, ResponsePartSink } from '../provider/parts';
import { StreamTranslator, decideStreamFailure } from '../provider/stream';
import type { ChatCompletionChunk, ChatToolCallDelta } from '../types';
import { capturingLogger } from './helpers';

/**
 * 流式响应翻译的测试。
 *
 * 这里钉住两件在真实网关上偶发、但一发生就很难从现象反推原因的事：
 * - **工具调用按 `index` 归并**：兼容网关可能不发 `index`，这时参数续传分片必须接在同一个
 *   调用上，否则参数会落进一个没有函数名的空槽并被丢弃（症状是「工具被执行了但参数全空」）；
 * - **已上报部件数**：provider 拿它当「截断后能不能重发」的门，数错了要么丢内容要么重复回答。
 *
 * 翻译层产出的是中立部件（`provider/parts.ts`），因此本文件不需要 VS Code 宿主。
 */

/** 收集上报部件的假 sink。 */
interface Recorder {
	readonly sink: ResponsePartSink;
	readonly parts: ResponsePart[];
}

function createRecorder(): Recorder {
	const parts: ResponsePart[] = [];
	return { parts, sink: part => parts.push(part) };
}

function createTranslator(options: { includeReasoning?: boolean; thinkingParts?: boolean } = {}): {
	translator: StreamTranslator;
	recorder: Recorder;
	logs: ReturnType<typeof capturingLogger>;
} {
	const recorder = createRecorder();
	const logs = capturingLogger();
	const translator = new StreamTranslator(recorder.sink, {
		includeReasoning: options.includeReasoning ?? false,
		thinkingParts: options.thinkingParts ?? false,
		logger: logs.logger,
		modelId: 'test-model',
	});
	return { translator, recorder, logs };
}

function contentChunk(text: string): ChatCompletionChunk {
	return { choices: [{ index: 0, delta: { content: text } }] };
}

function reasoningChunk(text: string): ChatCompletionChunk {
	return { choices: [{ index: 0, delta: { reasoning_content: text } }] };
}

function toolCallChunk(calls: readonly ChatToolCallDelta[]): ChatCompletionChunk {
	return { choices: [{ index: 0, delta: { tool_calls: [...calls] } }] };
}

/** 取出上报的文本。 */
function texts(recorder: Recorder): string[] {
	return recorder.parts
		.filter((part): part is Extract<ResponsePart, { kind: 'text' }> => part.kind === 'text')
		.map(part => part.text);
}

/** 取出上报的工具调用部件。 */
function toolCalls(recorder: Recorder): Extract<ResponsePart, { kind: 'toolCall' }>[] {
	return recorder.parts.filter(
		(part): part is Extract<ResponsePart, { kind: 'toolCall' }> => part.kind === 'toolCall',
	);
}

suite('provider / 工具调用归并', () => {
	test('网关省略 index 时，参数续传分片接在同一个工具调用上', () => {
		const { translator, recorder, logs } = createTranslator();

		// 首个分片带 id 与函数名，续传分片只有参数——两者都不带 index
		translator.handle(toolCallChunk([{ id: 'call_1', function: { name: 'read_file', arguments: '' } }]));
		translator.handle(toolCallChunk([{ function: { arguments: '{"path":"a.ts"}' } }]));
		const summary = translator.flush();

		const calls = toolCalls(recorder);
		assert.strictEqual(calls.length, 1, '不该多出一条没有函数名的工具调用');
		assert.strictEqual(calls[0].name, 'read_file');
		assert.deepStrictEqual(calls[0].input, { path: 'a.ts' }, '参数不能被丢掉');
		assert.strictEqual(summary.toolCallCount, 1);
		assert.strictEqual(
			logs.messages('warn').some(line => line.includes('缺少函数名')),
			false,
			'参数拼全了就不该再出现「缺少函数名」的警告',
		);
	});

	test('并行工具调用都不带 index 时各自独立', () => {
		const { translator, recorder } = createTranslator();

		translator.handle(toolCallChunk([{ id: 'a', function: { name: 't1', arguments: '' } }]));
		translator.handle(toolCallChunk([{ function: { arguments: '{"x":1}' } }]));
		translator.handle(toolCallChunk([{ id: 'b', function: { name: 't2', arguments: '' } }]));
		translator.handle(toolCallChunk([{ function: { arguments: '{"y":2}' } }]));
		translator.flush();

		const calls = toolCalls(recorder);
		assert.strictEqual(calls.length, 2);
		assert.deepStrictEqual(
			calls.map(call => [call.name, call.input]),
			[['t1', { x: 1 }], ['t2', { y: 2 }]],
		);
	});

	test('规范网关的 index 分片照常归并', () => {
		const { translator, recorder } = createTranslator();

		translator.handle(toolCallChunk([{ index: 0, id: 'c0', function: { name: 't', arguments: '{' } }]));
		translator.handle(toolCallChunk([{ index: 0, function: { arguments: '"a":1}' } }]));
		translator.flush();

		const calls = toolCalls(recorder);
		assert.strictEqual(calls.length, 1);
		assert.deepStrictEqual(calls[0].input, { a: 1 });
	});

	test('索引稀疏（网关只发 index: 5）时新调用不会撞到已有槽位', () => {
		const { translator, recorder } = createTranslator();

		translator.handle(toolCallChunk([{ index: 5, id: 'c5', function: { name: 't1', arguments: '{}' } }]));
		translator.handle(toolCallChunk([{ id: 'c6', function: { name: 't2', arguments: '{}' } }]));
		translator.flush();

		assert.deepStrictEqual(toolCalls(recorder).map(call => call.name), ['t1', 't2']);
	});

	test('参数不完整的工具调用：正常结束时照常上报，流被截断时丢弃', () => {
		const incomplete: readonly ChatToolCallDelta[] = [
			{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{"path":"a' } },
		];

		const kept = createTranslator();
		kept.translator.handle(toolCallChunk(incomplete));
		const keptSummary = kept.translator.flush();
		assert.strictEqual(keptSummary.toolCallCount, 1, '正常结束时上报空参数，让 VS Code 报参数错误更好');
		assert.deepStrictEqual(toolCalls(kept.recorder)[0].input, {});

		const cut = createTranslator();
		cut.translator.handle(toolCallChunk(incomplete));
		const cutSummary = cut.translator.flush({ dropIncompleteToolCalls: true });
		assert.strictEqual(toolCalls(cut.recorder).length, 0, '半截 JSON 不该拿去执行工具');
		assert.strictEqual(cutSummary.toolCallCount, 0);
		assert.ok(cut.logs.messages('warn').some(line => line.includes('参数不完整')));
	});
});

suite('provider / 工具调用与思考内容的时序', () => {
	test('上游给出 finish_reason 就先报工具调用，不等流结束', () => {
		const { translator, recorder } = createTranslator();

		translator.handle(toolCallChunk([{ index: 0, id: 'c', function: { name: 'read_file', arguments: '{}' } }]));
		assert.strictEqual(toolCalls(recorder).length, 0, '还没收到收尾信号时先攒着');

		translator.handle({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
		assert.strictEqual(toolCalls(recorder).length, 1, '参数已到齐就报，agent 循环不必多等一个往返');

		const summary = translator.flush();
		assert.strictEqual(toolCalls(recorder).length, 1, 'flush 不能重复上报同一次调用');
		assert.strictEqual(summary.toolCallCount, 1);
	});

	test('网关不发 finish_reason 时，工具调用在 flush 里补报', () => {
		const { translator, recorder } = createTranslator();

		translator.handle(toolCallChunk([{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }]));
		const summary = translator.flush();

		assert.strictEqual(toolCalls(recorder).length, 1);
		assert.strictEqual(summary.toolCallCount, 1);
	});

	test('思考原文始终累积，与是否回显无关（回填 reasoning_content 要用）', () => {
		const hidden = createTranslator({ includeReasoning: false });
		hidden.translator.handle(reasoningChunk('想'));
		hidden.translator.handle(reasoningChunk('一下'));
		assert.strictEqual(hidden.translator.flush().reasoningText, '想一下');

		const shown = createTranslator({ includeReasoning: true });
		shown.translator.handle(reasoningChunk('想'));
		assert.strictEqual(shown.translator.flush().reasoningText, '想');
	});

	test('没有思考部件时，思维链以 Markdown 引用块回显', () => {
		const { translator, recorder } = createTranslator({ includeReasoning: true, thinkingParts: false });

		translator.handle(reasoningChunk('想一下'));
		translator.handle(contentChunk('答案'));
		translator.flush();

		const parts = texts(recorder);
		assert.ok(
			parts.some(text => text.includes('思考过程') && text.includes('> 想一下')),
			'回退路径要把思维链包成引用块',
		);
		assert.ok(parts.includes('答案'));
	});

	test('走专用思考部件时，思维链不再当正文发出去', () => {
		const { translator, recorder } = createTranslator({ includeReasoning: true, thinkingParts: true });

		translator.handle(reasoningChunk('想一下'));
		translator.handle(contentChunk('答案'));
		translator.flush();

		assert.deepStrictEqual(texts(recorder), ['答案'], '思维链走专用部件，正文里不该再出现它');
		assert.strictEqual(
			recorder.parts.filter(part => part.kind === 'reasoning').length,
			1,
			'思维链应以独立的 reasoning 部件上报',
		);
	});
});

suite('provider / 已上报部件数', () => {
	test('正文计入，未开启回显的思维链不计入', () => {
		const { translator } = createTranslator({ includeReasoning: false });

		assert.strictEqual(translator.emittedParts, 0);
		translator.handle(reasoningChunk('想一下'));
		assert.strictEqual(translator.emittedParts, 0, '不回显的思维链对用户不可见，重发是安全的');

		translator.handle(contentChunk('你'));
		assert.strictEqual(translator.emittedParts, 1);

		translator.handle(contentChunk('好'));
		assert.strictEqual(translator.emittedParts, 2);
	});

	test('开启回显时思维链也计入', () => {
		const { translator } = createTranslator({ includeReasoning: true });
		translator.handle(reasoningChunk('想一下'));
		assert.strictEqual(translator.emittedParts, 1);
	});

	test('还没 flush 的工具调用不计入（它只在上报时才可能被用户看到）', () => {
		const { translator } = createTranslator();
		translator.handle(toolCallChunk([{ index: 0, id: 'c', function: { name: 't', arguments: '{}' } }]));
		assert.strictEqual(translator.emittedParts, 0);
	});

	test('用量快照取最后一个 chunk 里的值', () => {
		const { translator } = createTranslator();
		translator.handle({ usage: { completion_tokens: 1 }, choices: [] });
		translator.handle({ usage: { completion_tokens: 8 }, choices: [] });

		assert.strictEqual(translator.latestUsage?.completion_tokens, 8);
	});
});

suite('provider / 流式失败处置', () => {
	/** 默认参数：一次截断、什么都没上报、第一次尝试。 */
	const base = {
		error: new SseTruncatedError(1) as unknown,
		emittedParts: 0,
		attempt: 0,
		maxRetries: 2,
		cancelled: false,
	};

	test('还没给用户看过内容时重发整次请求', () => {
		assert.strictEqual(decideStreamFailure(base), 'retry');
	});

	test('只有「流被截断」才重发，其它错误重发也好不了', () => {
		assert.strictEqual(
			decideStreamFailure({ ...base, error: new SseIdleTimeoutError(60_000) }),
			'fail',
		);
		assert.strictEqual(decideStreamFailure({ ...base, error: new Error('上游返回错误：xxx') }), 'fail');
	});

	test('已经给用户看过内容时保留半截回答，而不是再补一段', () => {
		// provider 抛错时 VS Code 会先冲刷已经流出的部件，重发会让两段回答拼在一起
		assert.strictEqual(decideStreamFailure({ ...base, emittedParts: 3 }), 'keep-partial');
	});

	test('重试次数用尽后交给 VS Code 报错', () => {
		assert.strictEqual(decideStreamFailure({ ...base, attempt: 2 }), 'fail');
		assert.strictEqual(decideStreamFailure({ ...base, attempt: 1 }), 'retry', '边界上还剩一次机会');
	});

	test('取消时不重发', () => {
		assert.strictEqual(decideStreamFailure({ ...base, cancelled: true }), 'fail');
	});
});
