'use strict';

/**
 * GPT-6 Sol/Luna 与**随包数据表**的一致性。
 *
 * 适配器的改写行为在 `adapter.test.js` 里覆盖，这里守的是另一半：数据表里必须真的有这两条记录、
 * 且能力字段齐全（窗口/输出/图片/工具/思考档位）。数据表是生成产物，重新生成时丢了字段不会
 * 有别的环节报警——只会表现为 Copilot 里模型信息变差。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { modules } = load({
	gpt6: './src/adapter/openai/gpt6ChatAdapter',
	gpt61: './src/adapter/openai/gpt61ChatAdapter',
	dataset: './src/models/dataset',
	modelConfig: './src/models/modelConfig',
});
const { Gpt6ChatAdapter } = modules.gpt6;
const { Gpt61ChatAdapter } = modules.gpt61;
const { installModelDataset } = modules.dataset;
const { resolveModelConfig } = modules.modelConfig;
const { createLogger } = require('./helpers');

const dataset = require('../../data/openrouter-models.json');
const adapter = new Gpt6ChatAdapter();

for (const id of ['gpt-6-luna', 'gpt-6-sol']) {
	test(`${id} 在数据表里有可用的 Copilot 元数据`, () => {
		const model = dataset.models.find(item => item.id === id);
		if (model === undefined) {
			assert.fail(`数据表里没有 ${id}`);
		}

		assert.ok(model.contextWindow > 0, 'contextWindow');
		assert.ok(model.maxOutputTokens > 0, 'maxOutputTokens');
		assert.ok(model.maxOutputTokens < model.contextWindow, 'maxOutputTokens 必须小于 contextWindow');
		assert.equal(model.imageInput, true);
		assert.equal(model.toolCalling, true);
		// 适配器把工具调用时的强度压成 none，数据表得认这个取值
		assert.ok(model.supportsReasoningEffort.includes('none'), 'supportsReasoningEffort 必须含 none');
		assert.equal(adapter.supports({ id }), true);
	});
}

test('数据表里每条记录的形状都对', () => {
	// 生成脚本改了字段名却没人发现时，这里会先炸，而不是让模型信息静默降级
	for (const model of dataset.models) {
		assert.equal(typeof model.id, 'string', 'id');
		assert.ok(model.id.length > 0, 'id 不能为空');
		assert.ok(Number.isFinite(model.contextWindow), `${model.id} contextWindow`);
		assert.ok(Number.isFinite(model.maxOutputTokens), `${model.id} maxOutputTokens`);
	}
});

test('GPT-6.1 Sol 有窗口、视觉、工具和正确的思考档位', () => {
	const entry = dataset.models.find(item => item.id === 'gpt-6.1-sol');
	assert.ok(entry);
	assert.equal(entry.contextWindow, 1050000);
	assert.equal(entry.maxOutputTokens, 128000);
	assert.equal(entry.imageInput, true);
	assert.deepEqual(entry.supportsReasoningEffort, ['max', 'xhigh', 'high', 'medium', 'low']);
	installModelDataset(dataset);
	const config = resolveModelConfig({ id: 'gpt-6.1-sol', supported_parameters: ['tools'] }, {
		settings: { defaultContextWindow: 128000, defaultMaxOutputTokens: 8192 },
		logger: createLogger(),
	});
	assert.equal(config.contextWindow, 1050000);
	assert.equal(config.imageInput, true);
	assert.equal(config.toolCalling, true);
	assert.equal(config.reasoningEfforts.includes('none'), false);
});

test('GPT-6.1 Sol 支持工具的 Chat Completions 请求', () => {
	const adapter = new Gpt61ChatAdapter();
	const context = { model: { id: 'gpt-6.1-sol' }, logger: createLogger() };
	assert.equal(adapter.supports({ id: 'gpt-6.1-sol' }), true);
	assert.equal(adapter.supports({ id: 'gpt-6-sol' }), false);
	const request = adapter.transformRequest({
		model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hello' }],
		reasoning_effort: 'none', temperature: 0.5, top_p: 0.9,
	}, context);
	assert.equal(request.reasoning_effort, 'low');
	assert.equal('temperature' in request, false);
	assert.equal('top_p' in request, false);
	const withTools = adapter.transformRequest({
		model: 'gpt-6.1-sol', messages: [{ role: 'user', content: 'hello' }],
		tools: [{ type: 'function', function: { name: 'read_file' } }],
	}, context);
	assert.equal(withTools.tools.length, 1);
});

test('OpenAI 新推理模型移除不兼容的采样参数', () => {
	const { OpenAIReasoningAdapter } = load({ adapter: './src/adapter/openai/openaiReasoningAdapter' }).modules.adapter;
	const adapter = new OpenAIReasoningAdapter();
	const context = { model: { id: 'gpt-5.4' }, logger: createLogger() };
	assert.equal(adapter.supports({ id: 'gpt-5.4' }), true);
	assert.equal(adapter.supports({ id: 'gpt-5-code' }), true);
	assert.equal(adapter.supports({ id: 'gpt-6-astra' }), true);
	assert.equal(adapter.supports({ id: 'gpt-4.1' }), false);
	const request = adapter.transformRequest({
		model: 'gpt-5.4', messages: [{ role: 'user', content: 'hello' }],
		temperature: 0.2, top_p: 0.8, logprobs: true, top_logprobs: 2,
		reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'lookup' } }],
	}, context);
	assert.equal(request.reasoning_effort, 'high');
	assert.equal(request.tools.length, 1);
	for (const key of ['temperature', 'top_p', 'logprobs', 'top_logprobs']) {
		assert.equal(key in request, false);
	}
});
