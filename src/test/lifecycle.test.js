const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { modules } = load({
	catalog: './src/application/catalog', status: './src/application/modelStatus',
	session: './src/application/session',
});
const logger = { ...createLogger(), child() { return this; } };
const models = { cacheTtlMs: 300000, defaultContextWindow: 128000, defaultMaxOutputTokens: 8192 };
const request = { timeoutMs: 5000, streamIdleTimeoutMs: 5000, includeUsage: true, maxRetries: 0 };
const deferred = () => {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
};

test('目录失效：旧请求后完成也不能覆盖新缓存或清除新任务', async () => {
	const old = deferred();
	const fresh = deferred();
	let calls = 0;
	const catalog = new modules.catalog.ModelCatalog({ logger, getSettings: () => models,
		client: { hasApiKey: true, listModels: () => (++calls === 1 ? old.promise : fresh.promise) } });
	const staleTask = catalog.getModels();
	catalog.invalidate();
	const freshTask = catalog.getModels();
	old.resolve([{ id: 'old' }]);
	await staleTask;
	assert.equal(catalog.current, undefined);
	const joined = catalog.getModels();
	assert.equal(calls, 2);
	fresh.resolve([{ id: 'fresh' }]);
	await Promise.all([freshTask, joined]);
	assert.equal(catalog.current.models[0].id, 'fresh');
	catalog.dispose();
});

test('目录变更：相同 ID 的显示名称和窗口变化均通知宿主', async () => {
	let remote = { id: 'custom-unique', display_name: 'first', context_length: 128000 };
	const catalog = new modules.catalog.ModelCatalog({ logger, getSettings: () => models,
		client: { hasApiKey: true, listModels: async () => [remote] } });
	let changes = 0;
	catalog.onDidChange(() => changes++);
	await catalog.getModels();
	remote = { ...remote, display_name: 'second' };
	await catalog.getModels({ force: true });
	remote = { ...remote, context_length: 256000 };
	await catalog.getModels({ force: true });
	assert.equal(changes, 3);
	catalog.dispose();
});

test('轻量状态：首次失败、恢复和缓存降级都在发现事件中立即可见', async () => {
	let fail = true;
	let calls = 0;
	const catalog = new modules.catalog.ModelCatalog({ logger, getSettings: () => models,
		client: { hasApiKey: true, listModels: async () => {
			calls++;
			if (fail) { throw new Error('offline'); }
			return [{ id: 'custom-model' }];
		} } });
	const session = { target: { key: 'site', label: 'site', issues: [] }, catalog };
	const events = [];
	catalog.onDidChange(() => events.push(modules.status.readModelStatus([session])));
	try {
		assert.equal(modules.status.readModelStatus([session]).totalModels, 0);
		assert.equal(calls, 0, '读取状态不会发起网络请求');
		await catalog.getModels();
		assert.match(events.at(-1).targets[0].error, /offline/);
		fail = false;
		await catalog.getModels({ force: true });
		assert.equal(events.at(-1).totalModels, 1);
		assert.equal(events.at(-1).targets[0].error, undefined);
		fail = true;
		await catalog.getModels({ force: true });
		assert.equal(events.at(-1).totalModels, 1, '刷新失败保留已有模型');
		assert.match(events.at(-1).targets[0].error, /offline/);
		for (let i = 0; i < 5; i++) { modules.status.readModelStatus([session]); }
		assert.equal(calls, 3);
	} finally { catalog.dispose(); }
});

test('会话生命周期：配置变更立即替换客户端，停用也能中断退役中的旧流', async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (_url, init) => new Response(new ReadableStream({ start(controller) {
		controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"start"}}]}\n\n'));
		init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
	} }), { headers: { 'content-type': 'text/event-stream' } });
	let currentRequest = request;
	const registry = new modules.session.SessionRegistry({ logger, getModelSettings: () => models, getRequestSettings: () => currentRequest });
	try {
		const target = { key: 'same-key', group: 'group', label: 'site', baseUrl: 'https://example.com', apiKey: 'key', issues: [] };
		const old = registry.resolve(target);
		const stream = old.client.streamChatCompletion({ model: 'test', messages: [] });
		await stream.next();
		currentRequest = { ...request, timeoutMs: 10000 };
		registry.configure(true, false);
		assert.notEqual(registry.find(target.key).client, old.client);
		const next = stream.next();
		registry.dispose();
		await assert.rejects(next, error => error.kind === 'disposed');
		await old.client.whenIdle();
	} finally { registry.dispose(); globalThis.fetch = originalFetch; }
});
