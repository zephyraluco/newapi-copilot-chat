'use strict';

/**
 * application/catalog.ts：快照变化事件。宿主收到事件后会重新拉一遍模型列表，
 * 因此「没变就不触发」是要求。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({ catalog: './src/application/catalog' });
const { ModelCatalog } = modules.catalog;

/** 造一个模型列表由外部控制的目录。 */
function makeCatalog(initialModels) {
	let models = initialModels;
	let listCalls = 0;
	const client = {
		hasApiKey: true,
		async listModels() {
			listCalls++;
			return models;
		},
	};
	const catalog = new ModelCatalog({
		logger: createLogger(),
		client,
		// 缓存有效期设为 0，强制每次调用都走网络
		getSettings: () => ({ cacheTtlMs: 0, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 }),
	});
	let fires = 0;
	catalog.onDidChange(() => { fires++; });
	return {
		catalog,
		setModels: next => { models = next; },
		calls: () => listCalls,
		fires: () => fires,
	};
}

/* -------------------------------------------------------------------------- */

test('模型列表没变时不再触发事件', async () => {
	const { catalog, calls, fires } = makeCatalog([{ id: 'b' }, { id: 'a' }]);

	await catalog.getModels({ force: true });
	assert.equal(fires(), 1, '首帧要触发');

	await catalog.getModels({ force: true });
	await catalog.getModels({ force: true });
	assert.equal(calls(), 3, '每次都真的重新拉取了');
	assert.equal(fires(), 1, '列表没变就不能再触发');
});

test('模型列表变了才触发事件', async () => {
	const { catalog, setModels, fires } = makeCatalog([{ id: 'a' }]);

	await catalog.getModels({ force: true });
	assert.equal(fires(), 1);

	setModels([{ id: 'a' }, { id: 'b' }]);
	await catalog.getModels({ force: true });
	assert.equal(fires(), 2);

	// 顺序变化也算变化（选择器里的顺序会跟着变）
	setModels([{ id: 'b' }, { id: 'a' }]);
	await catalog.getModels({ force: true });
	assert.equal(fires(), 3);
});

test('从未成功过时，只在错误说明变化后触发', async () => {
	const failing = new ModelCatalog({
		logger: createLogger(),
		client: { hasApiKey: true, async listModels() { throw new Error('boom'); } },
		getSettings: () => ({ cacheTtlMs: 0, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 }),
	});
	let fires = 0;
	failing.onDidChange(() => { fires++; });

	await failing.getModels({ force: true });
	assert.equal(fires, 1, '首次失败要触发');
	await failing.getModels({ force: true });
	assert.equal(fires, 1, '错误说明没变就不再触发');
});

test('成功之后错误消失也算变化', async () => {
	let failing = true;
	const catalog = new ModelCatalog({
		logger: createLogger(),
		client: {
			hasApiKey: true,
			async listModels() {
				if (failing) {
					throw new Error('boom');
				}
				return [{ id: 'a' }];
			},
		},
		getSettings: () => ({ cacheTtlMs: 0, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 }),
	});
	let fires = 0;
	catalog.onDidChange(() => { fires++; });

	await catalog.getModels({ force: true });
	assert.equal(fires, 1);
	await catalog.getModels({ force: true });
	assert.equal(fires, 1);

	failing = false;
	await catalog.getModels({ force: true });
	assert.equal(fires, 2, '错误消失 + 模型列表从空变有：必须触发');
});
