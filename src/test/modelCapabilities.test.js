'use strict';

/**
 * 数据能力位与手工覆盖表的一致性。
 *
 * 适配器的改写行为在 `adapter.test.js` 里覆盖，这里守的是另一半：数据表里必须真的有这些记录、
 * 覆盖表必须真的被读进来、能力位必须齐全。数据表是生成产物，重新生成时丢了字段不会有别的环节
 * 报警——只会表现为 Copilot 里模型信息变差，或者请求被上游拒绝。
 *
 * 早先这些差异写在按模型名匹配的适配器里（`gpt6ChatAdapter` / `gpt61ChatAdapter`），
 * 与 `ARCHITECTURE.md §11`「只针对某个模型名的特判属于模型元数据」冲突；现在它们是数据。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	dataset: './src/models/dataset',
	modelConfig: './src/models/modelConfig',
});
const { installModelDataset, MODEL_OVERRIDES_FILE } = modules.dataset;
const { resolveModelConfig } = modules.modelConfig;

const dataset = require('../../data/openrouter-models.json');
const overrides = require('../../data/model-overrides.json');

const settings = { defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 };

/** 装好数据表（含覆盖表）后解析一个模型。 */
function configOf(id, model = {}) {
	installModelDataset(dataset, overrides);
	return resolveModelConfig({ id, ...model }, { settings, logger: createLogger() });
}

/* -------------------------------------------------------------------------- */

test('覆盖表文件存在且形态正确', () => {
	assert.equal(MODEL_OVERRIDES_FILE, 'model-overrides.json');
	assert.ok(overrides.models, '必须有 models 对象');
});

test('覆盖表把「带工具时强度只能是 none」写进能力位', () => {
	for (const id of ['gpt-6-sol', 'gpt-6-sol-pro', 'gpt-6-luna', 'gpt-6-luna-pro']) {
		const config = configOf(id);
		assert.equal(config.toolCallingReasoningEffort, 'none', id);
		assert.equal(config.samplingParams, 'when-thinking-off', id);
	}
});

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
	// 它没有「带工具强制改写强度」的能力位，因此思考强度控件照常显示
	assert.equal(config.toolCallingReasoningEffort, undefined);
});

/* -------------------------------------------------------------------------- */
/* 覆盖表的边界                                                                */
/* -------------------------------------------------------------------------- */

test('覆盖表只能改能力位：窗口与输出上限不受它影响', () => {
	installModelDataset(
		{ models: [{ id: 'demo', contextWindow: 100_000, maxOutputTokens: 10_000 }] },
		{
			models: {
				demo: { contextWindow: 999_999, maxOutputTokens: 999_999, toolCallingReasoningEffort: 'none' },
			},
		},
	);
	const config = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });

	// 数值有客观来源（网关 > 数据表 > 默认值），手工文件不许改
	assert.equal(config.contextWindow, 100_000);
	assert.equal(config.maxOutputTokens, 10_000);
	assert.equal(config.toolCallingReasoningEffort, 'none');
});

test('覆盖表的键大小写不敏感', () => {
	installModelDataset(
		{ models: [{ id: 'Demo-Model', contextWindow: 100_000, maxOutputTokens: 10_000 }] },
		{ models: { 'demo-model': { samplingParams: 'never' } } },
	);

	const config = resolveModelConfig({ id: 'Demo-Model' }, { settings, logger: createLogger() });
	assert.equal(config.samplingParams, 'never');
});

test('覆盖表不认识的值当作没表态', () => {
	installModelDataset(
		{ models: [{ id: 'demo', contextWindow: 100_000, maxOutputTokens: 10_000 }] },
		{ models: { demo: { samplingParams: '有时候接受' } } },
	);

	const config = resolveModelConfig({ id: 'demo' }, { settings, logger: createLogger() });
	assert.equal(config.samplingParams, undefined);
});

test('没有覆盖表时数据表照常可用', () => {
	installModelDataset(dataset);
	const config = resolveModelConfig({ id: 'gpt-6-sol' }, { settings, logger: createLogger() });

	assert.equal(config.contextWindow, 1_050_000);
	// 覆盖表是可选的：少了它只是少了几个「上游目录给不出」的能力位
	assert.equal(config.toolCallingReasoningEffort, undefined);
});
