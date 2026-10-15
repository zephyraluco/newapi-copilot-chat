const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');
const { modules } = load({ health: './src/application/siteHealth', usage: './src/application/usage',
	event: './src/shared/event', client: './src/transport/newApiClient' });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return { promise, resolve };
}
function fakeClock() {
	const previousSet = globalThis.setInterval;
	const previousClear = globalThis.clearInterval;
	const timers = new Map();
	let nextId = 0;
	globalThis.setInterval = (callback, interval) => { timers.set(++nextId, { callback, interval }); return nextId; };
	globalThis.clearInterval = id => timers.delete(id);
	return { timers, tick() { for (const timer of timers.values()) { timer.callback(); } },
		restore() { globalThis.setInterval = previousSet; globalThis.clearInterval = previousClear; } };
}
function session(key, getStatus) {
	return { target: { key, label: key, issues: [] }, client: { getStatus },
		catalog: { getModels() { throw new Error('探活不能拉取模型'); } } };
}

test('站点探活：并发合并、按站点隔离、周期检查与间隔更新独立于模型缓存', async () => {
	const clock = fakeClock();
	const changed = new modules.event.EventEmitter();
	const gate = deferred();
	let callsA = 0;
	let callsB = 0;
	const sessions = [session('a', async () => { callsA++; return gate.promise; }),
		session('b', async () => { callsB++; return { available: false, reason: 'status missing' }; })];
	const service = new modules.health.SiteHealthService({ list: () => sessions, onDidChange: changed.event }, createLogger());
	try {
		service.start(60000);
		await settle();
		const joined = service.refresh();
		clock.tick();
		await settle();
		assert.equal(callsA, 1, '慢站点不会被并发探测多次');
		assert.equal(service.snapshot.get('b').available, false);
		gate.resolve({ available: true });
		await joined;
		assert.equal(service.snapshot.get('a').available, true);
		const beforeA = callsA;
		const beforeB = callsB;
		changed.fire();
		await settle();
		assert.equal(callsA, beforeA, '目录事件不重复探活已有客户端');
		assert.equal(callsB, beforeB);
		service.configure(30000);
		assert.equal(clock.timers.size, 1);
		assert.equal([...clock.timers.values()][0].interval, 30000);
		clock.tick();
		await settle();
		assert.equal(callsA, beforeA + 1);
		assert.equal(callsB, beforeB + 1);
	} finally { service.dispose(); assert.equal(clock.timers.size, 0); clock.restore(); }
});

test('站点探活：客户端替换、删除和释放会取消任务并拒绝迟到结果', async () => {
	const clock = fakeClock();
	const changed = new modules.event.EventEmitter();
	const old = deferred();
	const fresh = deferred();
	let oldSignal;
	let newSignal;
	let sessions = [session('same', signal => { oldSignal = signal; return old.promise; })];
	const service = new modules.health.SiteHealthService({ list: () => sessions, onDidChange: changed.event }, createLogger());
	let events = 0;
	service.onDidChange(() => events++);
	try {
		service.start(60000);
		await settle();
		sessions = [session('same', signal => { newSignal = signal; return fresh.promise; })];
		changed.fire();
		await settle();
		assert.equal(oldSignal.aborted, true);
		fresh.resolve({ available: true });
		await service.refresh();
		old.resolve({ available: false, reason: 'stale' });
		await settle();
		assert.equal(service.snapshot.get('same').available, true);
		const pending = deferred();
		sessions = [session('same', signal => { newSignal = signal; return pending.promise; })];
		changed.fire();
		await settle();
		assert.equal(service.snapshot.has('same'), false);
		sessions = [];
		changed.fire();
		assert.equal(newSignal.aborted, true);
		service.dispose();
		const count = events;
		pending.resolve({ available: true });
		await settle();
		await service.refresh();
		assert.equal(events, count);
		assert.equal(service.snapshot.size, 0);
	} finally { service.dispose(); clock.restore(); }
});

test('站点探活：释放服务也会中止仍在读取的请求', async () => {
	const clock = fakeClock();
	const changed = new modules.event.EventEmitter();
	let signal;
	const gate = deferred();
	const service = new modules.health.SiteHealthService({
		list: () => [session('active', value => { signal = value; return gate.promise; })], onDidChange: changed.event,
	}, createLogger());
	try {
		service.start(60000);
		await settle();
		service.dispose();
		assert.equal(signal.aborted, true);
		gate.resolve({ available: true });
		await settle();
		assert.equal(service.snapshot.size, 0);
	} finally { service.dispose(); clock.restore(); }
});

test('累计用量：跨站点汇总缓存与思考计数，未报告 usage 时只累计请求和工具次数', () => {
	const tracker = new modules.usage.UsageTracker();
	let changes = 0;
	tracker.onDidChange(() => changes++);
	tracker.record('site-a', 'model-a', { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
		prompt_cache_hit_tokens: 80, reasoning_tokens: 10 }, 2);
	tracker.record('site-b', 'model-b', undefined, 1);
	assert.equal(tracker.snapshot.requests, 2);
	assert.equal(tracker.snapshot.reportedRequests, 1);
	assert.equal(tracker.snapshot.totalTokens, 120);
	assert.equal(tracker.snapshot.cachedTokens, 80);
	assert.equal(tracker.snapshot.reasoningTokens, 10);
	assert.equal(tracker.snapshot.toolCalls, 3);
	assert.equal(tracker.snapshot.lastTargetLabel, 'site-b');
	tracker.record('site-b', 'model-b', { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10,
		prompt_tokens_details: { cached_tokens: 0 } }, 0);
	assert.equal(tracker.snapshot.totalTokens, 130);
	assert.equal(tracker.snapshot.reportedRequests, 2);
	assert.equal(tracker.snapshot.cacheReported, true);
	assert.equal(changes, 3);
	assert.equal(new modules.usage.UsageTracker().snapshot.requests, 0, '重载扩展会话清零');
	tracker.dispose();
});

test('状态端点：成功格式、业务失败、错误页面和 HTTP 拒绝均得到明确探活结果', async () => {
	const originalFetch = globalThis.fetch;
	const logger = { ...createLogger(), child() { return this; } };
	const client = new modules.client.NewApiClient({ baseUrl: 'https://example.com/prefix', apiKey: 'key',
		timeoutMs: 5000, maxRetries: 0, logger });
	try {
		for (const [body, status, available] of [
			['{"success":true,"data":{}}', 200, true],
			['{"success":false,"data":{}}', 200, false],
			['<html>not an API</html>', 200, false],
			['{"error":{"message":"missing"}}', 404, false],
		]) {
			globalThis.fetch = async (url, init) => {
				assert.equal(url, 'https://example.com/prefix/api/status');
				assert.equal(init.method, 'GET');
				return new Response(body, { status });
			};
			const result = await client.getStatus();
			assert.equal(result.available, available);
			if (!available) { assert.ok(result.reason); }
		}
	} finally { client.dispose(); globalThis.fetch = originalFetch; }
});
