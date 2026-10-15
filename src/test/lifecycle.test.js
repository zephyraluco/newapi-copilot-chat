const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { modules } = load({
	catalog: './src/application/catalog', status: './src/application/statusService',
	session: './src/application/session', event: './src/shared/event',
});
const logger = { ...createLogger(), child() { return this; } };
const models = { cacheTtlMs: 300000, defaultContextWindow: 128000, defaultMaxOutputTokens: 8192 };
const request = { timeoutMs: 5000, streamIdleTimeoutMs: 5000, includeUsage: true, maxRetries: 0 };
const settings = { models, request, status: { showStatusBar: true, refreshIntervalMs: 60000 } };
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

function statusFixture(getModels) {
	const event = new modules.event.EventEmitter();
	let probeCalls = 0;
	let signal;
	const session = { target: { key: 'target', label: 'site', issues: [] },
		catalog: { getModels, current: { models: [] } },
		client: { getStatus: async input => { probeCalls++; signal = input; return { available: true }; } } };
	const status = new modules.status.StatusService({ logger, getSettings: () => settings,
		sessions: { list: () => [session], onDidChange: event.event } });
	return { status, probes: () => probeCalls, signal: () => signal };
}

test('刷新调度：并发普通调用共享一个任务，强制刷新只升级一次', async () => {
	const first = deferred();
	const forces = [];
	const fixture = statusFixture(async options => {
		forces.push(options.force);
		if (forces.length === 1) { await first.promise; }
		return { models: [] };
	});
	try {
		const a = fixture.status.refresh();
		const b = fixture.status.refresh();
		assert.equal(a, b);
		await Promise.resolve();
		const forced = fixture.status.refresh({ forceModels: true });
		fixture.status.refresh({ forceModels: true });
		first.resolve();
		await forced;
		assert.deepEqual(forces, [false, true]);
		assert.equal(fixture.probes(), 2);
	} finally { fixture.status.dispose(); }
});

test('状态释放：中止实际探测信号，不在释放后继续发事件', async () => {
	const pending = deferred();
	const fixture = statusFixture(async () => { await pending.promise; return { models: [] }; });
	let events = 0;
	fixture.status.onDidChange(() => events++);
	const task = fixture.status.refresh();
	await Promise.resolve();
	assert.equal(fixture.signal().aborted, false);
	fixture.status.dispose();
	const count = events;
	assert.equal(fixture.signal().aborted, true);
	pending.resolve();
	await task;
	assert.equal(events, count);
	await fixture.status.refresh();
	assert.equal(fixture.probes(), 1);
});

test('刷新调度：运行期间配置变化不会吞掉新配置的强制刷新', async () => {
	const gate = deferred();
	let calls = 0;
	const { status } = statusFixture(async () => {
		if (++calls === 1) { await gate.promise; }
		return { models: [] };
	});
	try {
		const task = status.refresh({ forceModels: true });
		await Promise.resolve();
		status.settingsChanged(false);
		status.refresh({ forceModels: true });
		gate.resolve();
		await task;
		assert.equal(calls, 2);
	} finally { status.dispose(); }
});

test('状态用量：累计与重置保留，刷新失败不清空用量', async () => {
	const { status } = statusFixture(async () => { throw new Error('offline'); });
	try {
		status.recordUsage('model', { prompt_tokens: 10, completion_tokens: 3 }, { toolCallCount: 2 });
		await status.refresh();
		assert.equal(status.state.usage.totalTokens, 13);
		assert.equal(status.state.usage.toolCalls, 2);
		status.resetUsage();
		assert.equal(status.state.usage.requests, 0);
	} finally { status.dispose(); }
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
