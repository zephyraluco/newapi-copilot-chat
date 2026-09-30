'use strict';

/**
 * provider/stream.ts：chunk → 中立响应部件的翻译。
 *
 * 这一层最容易出错（分片归并、引用块排版、截断判定），因此用例集中在**排版与归并**上。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	stream: './src/provider/stream',
	// 必须与 stream.ts 在同一次加载里：它靠 `instanceof SseTruncatedError` 判截断，
	// 各拿一份副本的话判定永远不会成立
	sse: './src/client/sse',
});

const {
	StreamTranslator,
	extractStreamError,
	tryParseToolArguments,
	parseToolArguments,
	decideStreamFailure,
} = modules.stream;
const { SseTruncatedError, SseIdleTimeoutError } = modules.sse;

/** 造一个翻译器，并收集它发出的中立部件。 */
function makeTranslator(options = {}) {
	const parts = [];
	const logger = options.logger ?? createLogger();
	const translator = new StreamTranslator(
		part => parts.push(part),
		{
			includeReasoning: options.includeReasoning ?? true,
			thinkingParts: options.thinkingParts ?? false,
			logger,
			modelId: 'test-model',
		},
	);
	return { parts, logger, translator };
}

/** 只带 delta 的 chunk。 */
function chunk(delta) {
	return { choices: [{ index: 0, delta }] };
}

/** 只带 finish_reason 的 chunk。 */
function finishChunk(finishReason) {
	return { choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
}

/* -------------------------------------------------------------------------- */
/* 正文                                                                        */
/* -------------------------------------------------------------------------- */

test('正文分片按到达顺序透传，并累计字符数', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ content: '你好' }));
	translator.handle(chunk({ content: '，世界' }));
	const summary = translator.flush();

	assert.deepEqual(parts, [
		{ kind: 'text', text: '你好' },
		{ kind: 'text', text: '，世界' },
	]);
	assert.equal(summary.textLength, 5);
	assert.equal(translator.emittedParts, 2);
});

test('空 delta、空 content 与没有 choices 的 chunk 都被忽略', () => {
	const { parts, translator } = makeTranslator();

	translator.handle({ choices: [] });
	translator.handle(chunk({ content: '' }));
	translator.handle({ choices: [{ index: 0 }] });
	assert.equal(translator.flush().textLength, 0);
	assert.deepEqual(parts, []);
});

test('多个候选时只用第一个，并只警告一次', () => {
	const { parts, logger, translator } = makeTranslator();
	const twoChoices = {
		choices: [
			{ index: 0, delta: { content: '第一个' } },
			{ index: 1, delta: { content: '第二个' } },
		],
	};

	translator.handle(twoChoices);
	translator.handle(twoChoices);

	assert.deepEqual(parts, [{ kind: 'text', text: '第一个' }, { kind: 'text', text: '第一个' }]);
	assert.equal(logger.messages('warn').length, 1);
	assert.match(logger.messages('warn')[0], /2 个候选/);
});

/* -------------------------------------------------------------------------- */
/* 思维链排版                                                                  */
/* -------------------------------------------------------------------------- */

test('没有专用思考部件时，思维链包成 Markdown 引用块', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '想想' }));
	const summary = translator.flush();

	// 第二段是 flush 补的换行（见下面「只有思维链」那条用例）
	assert.equal(parts[0].text, '\n\n> **🧠 思考过程**\n>\n> 想想');
	assert.equal(summary.reasoningLength, 2);
	assert.equal(summary.reasoningText, '想想');
});

test('引用块里的每个换行都要补前缀', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '第一行\n第二行' }));

	// 首个分片自带标题与首个 `> `，内部换行逐个补上
	assert.equal(parts[0].text, '\n\n> **🧠 思考过程**\n>\n> 第一行\n> 第二行');
});

test('上一分片以换行结尾时，下一个分片要补行首前缀', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '第一段\n' }));
	translator.handle(chunk({ reasoning_content: '第二段' }));

	assert.equal(parts[1].text, '> 第二段');
});

test('思维链之后接正文时插一个空行，避免引用块与正文粘连', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '想想' }));
	translator.handle(chunk({ content: '答案' }));

	assert.deepEqual(parts[1], { kind: 'text', text: '\n\n' });
	assert.deepEqual(parts[2], { kind: 'text', text: '答案' });
});

test('只有思维链没有正文时，收尾补一个换行', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '只想了没答' }));
	translator.flush();

	assert.equal(parts[parts.length - 1].text, '\n');
});

test('宿主提供思考部件时，思维链单独发一个部件（不再包引用块）', () => {
	const { parts, translator } = makeTranslator({ thinkingParts: true });

	translator.handle(chunk({ reasoning_content: '想想' }));
	translator.handle(chunk({ content: '答案' }));

	assert.deepEqual(parts, [
		{ kind: 'reasoning', text: '想想' },
		{ kind: 'text', text: '答案' },
	]);
});

test('关掉回显时思维链不发出去，但原文照样留给回填历史', () => {
	const { parts, translator } = makeTranslator({ includeReasoning: false });

	translator.handle(chunk({ reasoning_content: '想了很久' }));
	translator.handle(chunk({ content: '答案' }));
	const summary = translator.flush();

	assert.deepEqual(parts, [{ kind: 'text', text: '答案' }]);
	// DeepSeek 要求思考态的工具调用历史回填原文，关掉回显也不能把这份原文丢掉
	assert.equal(summary.reasoningText, '想了很久');
	assert.equal(summary.reasoningLength, 4);
});

test('空字符串的思维链字段按「没有思维链」处理', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ reasoning_content: '' }));
	assert.equal(translator.flush().reasoningLength, 0);
	assert.deepEqual(parts, []);
});

test('思维链字段名：reasoning_content 优先于 reasoning', () => {
	const { translator } = makeTranslator({ includeReasoning: false });

	translator.handle(chunk({ reasoning: '别家叫法', reasoning_content: '正式叫法' }));
	assert.equal(translator.flush().reasoningText, '正式叫法');
});

/* -------------------------------------------------------------------------- */
/* 工具调用                                                                    */
/* -------------------------------------------------------------------------- */

/** 工具调用的 delta。 */
function callDelta(index, id, name, args) {
	const fn = {};
	if (name !== undefined) {
		fn.name = name;
	}
	if (args !== undefined) {
		fn.arguments = args;
	}
	const delta = { function: fn };
	if (index !== undefined) {
		delta.index = index;
	}
	if (id !== undefined) {
		delta.id = id;
	}
	return delta;
}

test('工具调用：分片按 index 归并，参数拼完才上报', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(0, 'call_1', 'read_file', '{"pa')] }));
	// 参数还没拼完，此时不该上报
	assert.deepEqual(parts, []);

	translator.handle(chunk({ tool_calls: [callDelta(0)] }));
	translator.handle(chunk({ tool_calls: [callDelta(0)] }));
	translator.handle(chunk({ tool_calls: [callDelta(0, undefined, undefined, 'th":"a"}')] }));

	translator.handle(finishChunk('tool_calls'));

	assert.deepEqual(parts, [
		{ kind: 'toolCall', callId: 'call_1', name: 'read_file', input: { path: 'a' } },
	]);
	assert.equal(translator.emittedParts, 1);
});

test('工具调用：上游给 finish_reason 时立刻上报，不必等流结束', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(0, 'call_1', 'read_file', '{}')] }));
	translator.handle(finishChunk('tool_calls'));

	assert.equal(parts.length, 1);
	// flush 不该重复上报
	translator.flush();
	translator.flush();
	assert.equal(parts.length, 1);
	assert.equal(translator.emittedParts, 1);
});

test('工具调用：网关省略 index 时，续传分片接在同一次调用上', () => {
	const { parts, translator } = makeTranslator();

	// 首个分片带 id，续传分片只有 arguments
	translator.handle(chunk({ tool_calls: [callDelta(undefined, 'call_1', 'read_file', '{"a"')] }));
	translator.handle(chunk({ tool_calls: [callDelta(undefined, undefined, undefined, ':1}')] }));
	translator.flush();

	assert.deepEqual(parts, [
		{ kind: 'toolCall', callId: 'call_1', name: 'read_file', input: { a: 1 } },
	]);
});

test('工具调用：两个都省略 index 的调用不会合成一个', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(undefined, 'call_1', 'a', '{}')] }));
	translator.handle(chunk({ tool_calls: [callDelta(undefined, 'call_2', 'b', '{}')] }));
	translator.flush();

	assert.deepEqual(parts.map(part => part.name), ['a', 'b']);
});

test('工具调用：多个调用按 index 升序上报', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(1, 'call_2', 'b', '{}')] }));
	translator.handle(chunk({ tool_calls: [callDelta(0, 'call_1', 'a', '{}')] }));
	translator.flush();

	assert.deepEqual(parts.map(part => part.callId), ['call_1', 'call_2']);
});

test('工具调用：没有函数名的槽位被跳过并留下警告', () => {
	const { parts, logger, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(0, 'call_1', undefined, '{}')] }));
	translator.flush();

	assert.deepEqual(parts, []);
	assert.equal(logger.messages('warn').length, 1);
	assert.match(logger.messages('warn')[0], /缺少函数名/);
});

test('工具调用：缺少 id 时补一个可用的 callId', () => {
	const { parts, translator } = makeTranslator();

	translator.handle(chunk({ tool_calls: [callDelta(0, undefined, 'read_file', '{}')] }));
	translator.flush();

	assert.match(parts[0].callId, /^call_0_/);
});

test('工具调用：流中断时丢掉参数不完整的调用，正常结束时用空对象上报', () => {
	const incomplete = { tool_calls: [callDelta(0, 'call_1', 'read_file', '{"half"')] };

	const dropped = makeTranslator();
	dropped.translator.handle(chunk(incomplete));
	dropped.translator.flush({ dropIncompleteToolCalls: true });
	assert.deepEqual(dropped.parts, []);
	assert.match(dropped.logger.messages('warn').join(' '), /参数不完整/);

	// 正常结束：上报空对象，让 VS Code 报出参数校验失败，模型能自我修正
	const kept = makeTranslator();
	kept.translator.handle(chunk(incomplete));
	kept.translator.flush();
	assert.deepEqual(kept.parts, [{ kind: 'toolCall', callId: 'call_1', name: 'read_file', input: {} }]);
	assert.match(kept.logger.messages('error').join(' '), /无法解析/);
});

/* -------------------------------------------------------------------------- */
/* 用量与收尾                                                                  */
/* -------------------------------------------------------------------------- */

test('用量取最后一个 chunk 里的值', () => {
	const { logger, translator } = makeTranslator();

	translator.handle({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 } });
	translator.handle({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });

	assert.equal(translator.latestUsage.total_tokens, 15);

	const summary = translator.flush();
	assert.equal(summary.usage.total_tokens, 15);
	assert.match(logger.messages('debug').join(' '), /用量/);
});

test('finish_reason=length 时留下警告，且被写进统计', () => {
	const { logger, translator } = makeTranslator();

	translator.handle(finishChunk('length'));
	const summary = translator.flush();

	assert.equal(summary.finishReason, 'length');
	assert.match(logger.messages('warn').join(' '), /长度上限/);
});

test('没有正文的 finish_reason 也照样记下来', () => {
	const { translator } = makeTranslator();

	translator.handle(finishChunk('stop'));
	assert.equal(translator.flush().finishReason, 'stop');
});

/* -------------------------------------------------------------------------- */
/* 错误提取                                                                    */
/* -------------------------------------------------------------------------- */

test('extractStreamError：消息与错误码都带上', () => {
	assert.equal(extractStreamError({ error: { message: 'rate limited', code: 429 } }), 'rate limited（429）');
	assert.equal(extractStreamError({ error: { message: 'boom' } }), 'boom');
	assert.equal(extractStreamError({ error: {} }), '上游返回了未说明的错误');
	assert.equal(extractStreamError({ error: { message: '' } }), '上游返回了未说明的错误');
});

test('extractStreamError：没有 error 字段时返回 undefined', () => {
	assert.equal(extractStreamError({}), undefined);
	assert.equal(extractStreamError({ error: undefined }), undefined);
	assert.equal(extractStreamError({ error: null }), undefined);
});

/* -------------------------------------------------------------------------- */
/* 工具参数解析                                                                */
/* -------------------------------------------------------------------------- */

test('tryParseToolArguments：空参数视为空对象', () => {
	const logger = createLogger();
	assert.deepEqual(tryParseToolArguments('   ', logger, 'read_file'), {});
	assert.deepEqual(tryParseToolArguments('{}', logger, 'read_file'), {});
});

test('tryParseToolArguments：参数被 Markdown 代码块包裹时自动剥离', () => {
	const logger = createLogger();

	assert.deepEqual(tryParseToolArguments('```json\n{"a":1}\n```', logger, 'read_file'), { a: 1 });
	assert.deepEqual(tryParseToolArguments('```\n{"a":2}\n```', logger, 'read_file'), { a: 2 });
	assert.equal(logger.messages('debug').length, 2);
	assert.match(logger.messages('debug')[0], /read_file/);
});

test('tryParseToolArguments：坏 JSON 返回 undefined，由调用方决定怎么处置', () => {
	const logger = createLogger();

	assert.equal(tryParseToolArguments('{"a":', logger, 'read_file'), undefined);
	assert.equal(tryParseToolArguments('```json\nnot json\n```', logger, 'read_file'), undefined);
	// 解析失败本身不记日志：调用方更清楚这次失败意味着「丢弃」还是「空对象上报」
	assert.equal(logger.lines.length, 0);
});

test('parseToolArguments：解析失败时返回空对象并记错误', () => {
	const logger = createLogger();

	assert.deepEqual(parseToolArguments('{"a":1}', logger, 'read_file'), { a: 1 });
	assert.deepEqual(parseToolArguments('不是 JSON', logger, 'read_file'), {});
	assert.equal(logger.messages('error').length, 1);
});

/* -------------------------------------------------------------------------- */
/* 失败处置                                                                    */
/* -------------------------------------------------------------------------- */

test('decideStreamFailure：只有「还没给用户看过内容」的截断才值得重发', () => {
	const truncated = () => new SseTruncatedError(3);

	// 什么都没发出：重发
	assert.equal(decideStreamFailure({ error: truncated(), emittedParts: 0, attempt: 0, maxRetries: 2, cancelled: false }), 'retry');
	// 已经流出一部分：保留半截，不能把两段回答拼在一起
	assert.equal(decideStreamFailure({ error: truncated(), emittedParts: 1, attempt: 0, maxRetries: 2, cancelled: false }), 'keep-partial');
	// 重试次数用尽
	assert.equal(decideStreamFailure({ error: truncated(), emittedParts: 0, attempt: 2, maxRetries: 2, cancelled: false }), 'fail');
});

test('decideStreamFailure：取消与非截断错误一律直接失败', () => {
	const truncated = new SseTruncatedError(3);

	assert.equal(decideStreamFailure({ error: truncated, emittedParts: 0, attempt: 0, maxRetries: 2, cancelled: true }), 'fail');
	assert.equal(decideStreamFailure({ error: new SseIdleTimeoutError(1_000), emittedParts: 0, attempt: 0, maxRetries: 2, cancelled: false }), 'fail');
	assert.equal(decideStreamFailure({ error: new Error('HTTP 400'), emittedParts: 0, attempt: 0, maxRetries: 2, cancelled: false }), 'fail');
});
