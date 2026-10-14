'use strict';

/**
 * provider/requestRepair.ts：HTTP 400 的自愈阶梯。
 *
 * 边界：只对 400 生效、没有线索就不猜、每轮改动必须真的发生。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { modules } = load({
	requestRepair: './src/provider/requestRepair',
	consts: './src/consts',
});

const { planRequestRepair } = modules.requestRepair;
const { RepairMemory, applyRememberedRepair } = modules.requestRepair;
const { DEFAULT_REASONING_EFFORT_FIELD } = modules.consts;

/** 一个「什么可选字段都带着」的请求体。 */
function fullRequest() {
	return {
		model: 'deepseek-chat',
		messages: [{ role: 'user', content: 'hi' }],
		stream: true,
		temperature: 0.5,
		top_p: 0.9,
		tool_choice: 'auto',
		[DEFAULT_REASONING_EFFORT_FIELD]: 'high',
	};
}

/** 只有协议骨架的请求体。 */
function minimalRequest() {
	return {
		model: 'deepseek-chat',
		messages: [{ role: 'user', content: 'hi' }],
		stream: true,
	};
}

function plan(input) {
	return planRequestRepair({
		status: 400,
		responseBody: undefined,
		apiMessage: undefined,
		request: fullRequest(),
		sendsStreamOptions: false,
		tried: [],
		...input,
	});
}

/* -------------------------------------------------------------------------- */

test('只有 400 走自愈：其它状态码去掉字段也救不回来', () => {
	for (const status of [401, 403, 404, 413, 429, 500]) {
		assert.equal(
			plan({ status, apiMessage: "Unknown parameter: 'temperature'" }),
			undefined,
			String(status),
		);
	}
});

test('服务端什么都没说时不猜', () => {
	assert.equal(plan({ apiMessage: undefined, responseBody: undefined }), undefined);
	assert.equal(plan({ apiMessage: '', responseBody: '   ' }), undefined);
});

/* -------------------------------------------------------------------------- */
/* stream_options                                                              */
/* -------------------------------------------------------------------------- */

test('站点不认 stream_options 时改为不要求用量（它不在请求体里）', () => {
	const request = fullRequest();
	const result = plan({
		request,
		sendsStreamOptions: true,
		apiMessage: 'Unrecognized request argument supplied: stream_options',
	});

	assert.equal(result.id, 'stream_options');
	assert.equal(result.includeUsage, false);
	// 请求体原样保留：这个字段是客户端按设置加上去的
	assert.deepEqual(result.request, request);
});

test('这次没带 stream_options 就不该拿这条规则去试', () => {
	const result = plan({ sendsStreamOptions: false, apiMessage: 'unknown field stream_options' });

	// 落到下面的通用规则上，而请求里没有任何被点名的可选字段
	assert.equal(result, undefined);
});

/* -------------------------------------------------------------------------- */
/* 上游点名某个字段                                                            */
/* -------------------------------------------------------------------------- */

test('上游点名的字段会被单独去掉', () => {
	const result = plan({ apiMessage: "Unknown parameter: 'temperature'" });

	assert.equal(result.id, 'field:temperature');
	assert.equal('temperature' in result.request, false);
	// 只去掉被点名的那个，其余保持原样
	assert.equal(result.request.top_p, 0.9);
	assert.match(result.note, /temperature/);
});

test('上游用别的措辞时也认得出来', () => {
	for (const message of [
		'unknown field "top_p"',
		'Unsupported parameter: top_p',
		'{"error":{"message":"Unrecognized request argument supplied: top_p"}}',
	]) {
		const result = plan({ apiMessage: message });
		assert.equal(result?.id, 'field:top_p', message);
	}
});

test('协议骨架字段不会被自愈删掉', () => {
	// 上游说「model 不认识」时，去掉它请求就不成立了
	for (const message of ["Unknown parameter: 'model'", "Unknown parameter: 'messages'", "Unknown parameter: 'stream'"]) {
		assert.equal(plan({ apiMessage: message }), undefined, message);
	}
});

test('上游点名了请求里不存在的字段时不动手', () => {
	// 去掉一个本来就没有的字段什么也不会改变
	assert.equal(plan({ apiMessage: '{"error":{"message":"Unknown parameter: \'logit_bias\'"}}' }), undefined);
});

/* -------------------------------------------------------------------------- */
/* 白名单：只去掉我们自己加的可选项                                            */
/* -------------------------------------------------------------------------- */

test('工具 schema 不合法时绝不能把 tools 删掉', () => {
	// 否则响应体里任何带引号且请求里存在的字段名都会被当成「上游不认的字段」而删掉
	const request = { ...fullRequest(), tools: [{ type: 'function', function: { name: 'read_file' } }] };

	for (const message of [
		'{"error":{"message":"Invalid schema for function \'read_file\'","param":"tools"}}',
		"Unknown parameter: 'tools'",
		'tools is not supported',
		'Invalid schema for function read_file',
	]) {
		assert.equal(plan({ request, apiMessage: message }), undefined, message);
	}
});

test('白名单之外的请求字段一律不动', () => {
	const request = { ...fullRequest(), extra_knob: 1 };

	// 不是我们加的字段：不动手
	assert.equal(plan({ request, apiMessage: "Unknown parameter: 'extra_knob'" }), undefined);
	// 用户自己填进 extraBody 的键由调用方传进来，那时才允许去掉
	const result = plan({
		request,
		apiMessage: "Unknown parameter: 'extra_knob'",
		optionalFields: ['extra_knob'],
	});
	assert.equal(result.id, 'field:extra_knob');
	assert.equal('extra_knob' in result.request, false);
});

test('DeepSeek 的 thinking 属可自愈字段', () => {
	const request = { ...fullRequest(), thinking: { type: 'enabled' } };
	const result = plan({ request, apiMessage: 'unknown field "thinking"' });

	assert.equal(result.id, 'field:thinking');
	assert.equal('thinking' in result.request, false);
});

/* -------------------------------------------------------------------------- */
/* 自愈记忆                                                                    */
/* -------------------------------------------------------------------------- */

test('RepairMemory：按会话 + 模型记住已经确认过的不兼容字段', () => {
	const memory = new RepairMemory();

	assert.equal(memory.get('t1', 'm1'), undefined);
	memory.remember('t1', 'm1', { id: 'field:temperature', request: {}, note: '' });
	// 重复记住同一个字段不会重复累积
	memory.remember('t1', 'm1', { id: 'field:temperature', request: {}, note: '' });

	assert.deepEqual(memory.get('t1', 'm1'), { fields: ['temperature'], includeUsage: undefined });
	// 另一个站点或另一个模型互不影响
	assert.equal(memory.get('t2', 'm1'), undefined);
	assert.equal(memory.get('t1', 'm2'), undefined);
});

test('RepairMemory：stream_options 记为「不再要求用量」', () => {
	const memory = new RepairMemory();
	memory.remember('t1', 'm1', { id: 'stream_options', request: {}, note: '', includeUsage: false });

	assert.deepEqual(memory.get('t1', 'm1'), { fields: [], includeUsage: false });
});

test('RepairMemory：超过上限时淘汰最久未使用的条目', () => {
	const memory = new RepairMemory(2);
	memory.remember('t', 'a', { id: 'field:temperature', request: {}, note: '' });
	memory.remember('t', 'b', { id: 'field:temperature', request: {}, note: '' });
	// 命中 a，使它成为最近使用
	assert.ok(memory.get('t', 'a') !== undefined);
	memory.remember('t', 'c', { id: 'field:temperature', request: {}, note: '' });

	assert.equal(memory.size, 2);
	assert.equal(memory.get('t', 'b'), undefined);
	assert.ok(memory.get('t', 'a') !== undefined);
	assert.ok(memory.get('t', 'c') !== undefined);
});

test('applyRememberedRepair：把记忆里的字段预先去掉，且不改原请求', () => {
	const request = { ...fullRequest() };

	assert.deepEqual(applyRememberedRepair(request, undefined), request);
	assert.deepEqual(applyRememberedRepair(request, { fields: [], includeUsage: false }), request);

	const next = applyRememberedRepair(request, { fields: ['temperature'], includeUsage: undefined });
	assert.equal('temperature' in next, false);
	assert.equal(next.top_p, 0.9);
	// 原请求不被改动
	assert.equal(request.temperature, 0.5);
});

/* --------------------------------------------------------------------------- */
/* 内置阶梯：不靠引号也能认出来                                                */
/* --------------------------------------------------------------------------- */

test('响应体里出现字段名（没带引号）时，按内置阶梯去掉它', () => {
	const sampling = plan({ apiMessage: 'unsupported sampling parameters temperature / top_p' });
	assert.equal(sampling.id, 'sampling');
	assert.equal('temperature' in sampling.request, false);
	assert.equal('top_p' in sampling.request, false);

	const toolChoice = plan({ apiMessage: 'unsupported tool_choice value auto' });
	assert.equal(toolChoice.id, 'tool_choice');
	assert.equal('tool_choice' in toolChoice.request, false);

	const effort = plan({ apiMessage: `unsupported ${DEFAULT_REASONING_EFFORT_FIELD} value high` });
	assert.equal(effort.id, DEFAULT_REASONING_EFFORT_FIELD);
	assert.equal(DEFAULT_REASONING_EFFORT_FIELD in effort.request, false);
});

test('阶梯顺序固定：先采样参数，再思考强度，最后 tool_choice', () => {
	const result = plan({ apiMessage: 'temperature top_p tool_choice reasoning_effort are all unsupported' });

	assert.equal(result.id, 'sampling');
});

test('请求里没有该字段时这条规则不生效', () => {
	const request = minimalRequest();

	assert.equal(plan({ request, apiMessage: 'unsupported temperature' }), undefined);
	assert.equal(plan({ request, apiMessage: 'unsupported tool_choice' }), undefined);
	assert.equal(plan({ request, apiMessage: `unsupported ${DEFAULT_REASONING_EFFORT_FIELD}` }), undefined);
});

/* -------------------------------------------------------------------------- */
/* 去重与不可变性                                                              */
/* -------------------------------------------------------------------------- */

test('试过的步骤不会再来一遍', () => {
	assert.equal(plan({ apiMessage: 'unsupported temperature top_p', tried: ['sampling'] }), undefined);
	// 用一条没有内置规则兼顾的字段来验证去重：上游说的字段试过了，但阶梯也接不上这句话
	const request = { ...fullRequest(), max_tokens: 1_000 };
	assert.equal(plan({ request, apiMessage: "Unknown parameter: 'max_tokens'", tried: ['field:max_tokens'] }), undefined);
	// 「去掉一个字段」与「整条规则」是两套标识，互不干扰
	assert.ok(plan({ apiMessage: "Unknown parameter: 'temperature'", tried: ['sampling'] }).id === 'field:temperature');
});

test('试过被点名的字段后，还能退回内置阶梯', () => {
	const result = plan({
		apiMessage: "Unknown parameter: 'temperature'",
		tried: ['field:temperature'],
	});

	// 字段路径已经走过了，但 sampling 规则仍然认这句话
	assert.equal(result.id, 'sampling');
});

test('改写不回改原请求体', () => {
	const request = fullRequest();
	const result = plan({ request, apiMessage: "Unknown parameter: 'temperature'" });

	assert.equal(request.temperature, 0.5);
	assert.equal(result.request.temperature, undefined);
	// 其余字段是浅拷贝过去的
	assert.deepEqual(result.request.messages, request.messages);
});
