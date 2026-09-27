'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { buildSync } = require('esbuild');
const dataset = require('../data/openrouter-models.json');

const bundle = buildSync({
	entryPoints: [path.join(__dirname, '..', 'src', 'adapter', 'openai', 'gpt6ChatAdapter.ts')],
	bundle: true,
	platform: 'node',
	format: 'cjs',
	write: false,
}).outputFiles[0].text;
const loaded = { exports: {} };
new Function('module', 'exports', 'require', bundle)(loaded, loaded.exports, require);
const { Gpt6ChatAdapter } = loaded.exports;

const adapter = new Gpt6ChatAdapter();
const logger = { debug() {} };

for (const id of ['gpt-6-luna', 'gpt-6-sol']) {
	test(`${id} has usable Copilot metadata`, () => {
		const model = dataset.models.find(item => item.id === id);
		assert.ok(model);
		assert.equal(model.contextWindow, 1050000);
		assert.equal(model.maxOutputTokens, 128000);
		assert.equal(model.imageInput, true);
		assert.equal(model.toolCalling, true);
		assert.ok(model.supportsReasoningEffort.includes('none'));
		assert.equal(adapter.supports({ id }), true);
	});

	test(`${id} uses none with tools and preserves tools`, () => {
		const tools = [{ type: 'function', function: { name: 'lookup', parameters: {} } }];
		const request = {
			model: id,
			messages: [{ role: 'user', content: 'hello' }],
			tools,
			tool_choice: 'auto',
			reasoning_effort: 'high',
		};
		const result = adapter.transformRequest(request, { model: { id }, logger });
		assert.equal(result.reasoning_effort, 'none');
		assert.equal(result.tools, tools);
		assert.equal(result.tool_choice, 'auto');
	});

	test(`${id} removes sampling parameters when reasoning is active`, () => {
		const request = {
			model: id,
			messages: [{ role: 'user', content: 'hello' }],
			temperature: 0.5,
			top_p: 0.9,
			logprobs: true,
			top_logprobs: 2,
		};
		const result = adapter.transformRequest(request, { model: { id }, logger });
		assert.equal(result.reasoning_effort, undefined);
		for (const key of ['temperature', 'top_p', 'logprobs', 'top_logprobs']) {
			assert.equal(result[key], undefined);
		}
	});
}

test('other GPT-6 models keep their own adapter', () => {
	assert.equal(adapter.supports({ id: 'gpt-6-astra' }), false);
});
