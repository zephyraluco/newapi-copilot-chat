'use strict';

/**
 * provider/thinking.ts + streamFlow：思考部件的归组契约。
 *
 * 宿主的思考块按部件 `id` 归组：同一个 `id` 的连续部件合并成一块，没有 `id` 时每个部件
 * 各成一块。流式思维链每片只有几个字，若不带 `id`，界面上就会碎成一串「Thought for Ns」。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { createVscodeStub } = require('./fakes');

/** 加载 streamFlow；`thinkingPart` 为真时宿主提供思考部件。 */
function loadFlow(options = {}) {
	return load({ flow: './src/provider/streamFlow' }, { vscode: createVscodeStub(options) });
}

function chunk(delta) {
	return { choices: [{ index: 0, delta }] };
}

/** 跑一次 streamResponse，收集上报给宿主的部件。 */
async function run({ flow }, chunks, options = {}) {
	const parts = [];
	const logger = { ...createLogger(), child() { return this; } };
	const summary = await flow.streamResponse({
		source: { async *streamChatCompletion() { for (const item of chunks) { yield item; } } },
		request: { model: 'test-model', stream: true },
		modelId: 'test-model',
		includeReasoning: options.includeReasoning ?? true,
		progress: { report: part => parts.push(part) },
		signal: new AbortController().signal,
		cancelled: () => false,
		logger,
	});
	return { parts, summary };
}

const kindOf = part => part?.constructor?.name;

/** 思考内容部件（不含收口标记）。 */
const isReasoning = part => kindOf(part) === 'LanguageModelThinkingPart' &&
	part.metadata?.vscode_reasoning_done !== true;

/** 「思考已结束」的收口标记。 */
const isDone = part => part.metadata?.vscode_reasoning_done === true;

test('思维链分片共用一个思考 id，宿主才能并成一块', async () => {
	const { modules } = loadFlow({ thinkingPart: true });

	const { parts } = await run(modules, [
		chunk({ reasoning_content: '第一' }),
		chunk({ reasoning_content: '第二' }),
		chunk({ reasoning_content: '第三' }),
		chunk({ content: '答案' }),
	]);

	const thinking = parts.filter(isReasoning);
	assert.equal(thinking.length, 3);
	assert.ok(thinking[0].id, '没有 id 的部件在宿主里各成一块');
	assert.equal(new Set(thinking.map(part => part.id)).size, 1);
	assert.deepEqual(thinking.map(part => part.value), ['第一', '第二', '第三']);
});

test('思考转正文时补结束标记，正文排在标记之后', async () => {
	const { modules } = loadFlow({ thinkingPart: true });

	const { parts } = await run(modules, [
		chunk({ reasoning_content: '想想' }),
		chunk({ content: '答案' }),
	]);

	assert.deepEqual(parts.map(kindOf), [
		'LanguageModelThinkingPart',
		'LanguageModelThinkingPart',
		'LanguageModelTextPart',
	]);
	assert.equal(isDone(parts[1]), true);
	assert.equal(parts[2].value, '答案');
});

test('只有思考没有正文时，流结束补一个结束标记', async () => {
	const { modules } = loadFlow({ thinkingPart: true });

	const { parts } = await run(modules, [chunk({ reasoning_content: '只想不答' })]);

	assert.equal(parts.length, 2);
	assert.equal(isReasoning(parts[0]), true);
	assert.equal(isDone(parts[1]), true);
});

test('两段思考之间夹了正文时，两段用不同的 id 分开', async () => {
	const { modules } = loadFlow({ thinkingPart: true });

	const { parts } = await run(modules, [
		chunk({ reasoning_content: '甲' }),
		chunk({ content: '答' }),
		chunk({ reasoning_content: '乙' }),
	]);

	const thinking = parts.filter(isReasoning);
	assert.equal(thinking.length, 2);
	assert.notEqual(thinking[0].id, thinking[1].id);
	assert.equal(parts.filter(isDone).length, 2);
});

test('关掉思考回显时不发思考部件，也不发结束标记', async () => {
	const { modules } = loadFlow({ thinkingPart: true });

	const { parts, summary } = await run(modules, [
		chunk({ reasoning_content: '想了' }),
		chunk({ content: '答案' }),
	], { includeReasoning: false });

	assert.deepEqual(parts.map(kindOf), ['LanguageModelTextPart']);
	assert.equal(summary.reasoningText, '想了');
});

test('宿主不支持思考部件时退回 Markdown 引用块', async () => {
	const { modules } = loadFlow();

	const { parts } = await run(modules, [
		chunk({ reasoning_content: '想想' }),
		chunk({ content: '答案' }),
	]);

	assert.equal(parts.some(part => kindOf(part) === 'LanguageModelThinkingPart'), false);
	assert.match(parts[0].value, /思考过程/);
});
