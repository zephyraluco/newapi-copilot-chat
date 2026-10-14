'use strict';

/**
 * 数据能力位与数据表的一致性。
 *
 * 适配器的改写行为在 `adapter.test.js` 里覆盖，这里守的是另一半：数据表里必须有这些记录、
 * 能力位必须齐全。数据表是生成产物，重新生成时丢了字段只会表现为模型信息变差或请求被上游拒绝。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	dataset: './src/models/dataset',
	modelConfig: './src/models/modelConfig',
});
const { installModelDataset } = modules.dataset;
const { resolveModelConfig } = modules.modelConfig;

const dataset = require('../../data/openrouter-models.json');

const settings = { defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 };

/** 装好数据表后解析一个模型。 */
function configOf(id, model = {}) {
	installModelDataset(dataset);
	return resolveModelConfig({ id, ...model }, { settings, logger: createLogger() });
}

/* -------------------------------------------------------------------------- */

test('gpt-6 Sol/Luna 在数据表里有可用的 Copilot 元数据', () => {
	for (const id of ['gpt-6-luna', 'gpt-6-sol']) {
		const model = dataset.models.find(item => item.id === id);
		if (model === undefined) {
			assert.fail(`数据表里没有 ${id}`);
		}

		assert.ok(model.contextWindow > 0, 'contextWindow');
		assert.ok(model.maxOutputTokens > 0, 'maxOutputTokens');
		assert.ok(model.maxOutputTokens < model.contextWindow, 'maxOutputTokens 必须小于 contextWindow');
		assert.equal(model.imageInput, true);
		assert.equal(model.toolCalling, true);
		// 能力位会把强度压成 none，数据表得认这个取值
		assert.ok(model.supportsReasoningEffort.includes('none'), 'supportsReasoningEffort 必须含 none');
	}
});

/* -------------------------------------------------------------------------- */

test('数据表里每条记录的形状都对', () => {
	// 生成脚本改了字段名却没人发现时，这里会先炸，而不是让模型信息静默降级
	for (const model of dataset.models) {
		assert.equal(typeof model.id, 'string', 'id');
		assert.ok(model.id.length > 0, 'id 不能为空');
		assert.ok(Number.isFinite(model.contextWindow), `${model.id} contextWindow`);
		assert.ok(Number.isFinite(model.maxOutputTokens), `${model.id} maxOutputTokens`);
		if (model.samplingParams !== undefined) {
			assert.ok(
				['never', 'when-thinking-off'].includes(model.samplingParams),
				`${model.id} samplingParams=${model.samplingParams}`,
			);
		}
	}
});

test('GPT-6.1 Sol 的档位里没有 none/minimal，因此不再需要适配器兜底', () => {
	const config = configOf('gpt-6.1-sol', { supported_parameters: ['tools'] });

	assert.equal(config.contextWindow, 1_050_000);
	assert.equal(config.imageInput, true);
	assert.equal(config.toolCalling, true);
	assert.equal(config.reasoningEfforts.includes('none'), false);
	assert.equal(config.reasoningEfforts.includes('minimal'), false);
});

/* -------------------------------------------------------------------------- */
/* 数据表载入的边界                                                            */
/* -------------------------------------------------------------------------- */

test('数值有客观来源：网关 > 数据表 > 默认值', () => {
	installModelDataset({ models: [{ id: 'demo', contextWindow: 100_000, maxOutputTokens: 10_000 }] });

	// 网关没表态时用数据表
	const fromDataset = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });
	assert.equal(fromDataset.contextWindow, 100_000);
	assert.equal(fromDataset.maxOutputTokens, 10_000);

	// 网关表态时以网关为准
	const fromRemote = resolveModelConfig(
		{ id: 'demo', context_window: 200_000 },
		{ settings, logger: createLogger() },
	);
	assert.equal(fromRemote.contextWindow, 200_000);
});

test('数据表没表态采样参数时保持缺省', () => {
	installModelDataset({ models: [{ id: 'demo', contextWindow: 100_000, maxOutputTokens: 10_000 }] });

	const config = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });
	assert.equal(config.samplingParams, undefined);
});

test('数据表不认识的采样参数取值当作没表态', () => {
	installModelDataset({
		models: [{ id: 'demo', contextWindow: 100_000, maxOutputTokens: 10_000, samplingParams: '有时候接受' }],
	});

	const config = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });
	assert.equal(config.samplingParams, undefined);
});

test('没有数据表时模型配置照常可用', () => {
	installModelDataset(undefined);

	const config = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });
	assert.equal(config.contextWindow, settings.defaultContextWindow);
	assert.equal(config.maxOutputTokens, settings.defaultMaxOutputTokens);
});
