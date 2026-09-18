/**
 * 状态服务（`status/statusService.ts`）。
 *
 * 这一层是「状态栏看到的一切」的唯一来源，但它此前完全没法测：依赖直接写成
 * `SessionRegistry` / `ConfigService`，要构造它就得先拼出真实客户端与模型目录。
 * 依赖收窄成结构接口（`StatusSessionSource` / `StatusConfigSource`）之后，
 * 用几个假对象就能把「哪些目标算可用、探测怎么记账、用量怎么累加」钉住。
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import type { NewApiSettings } from '../config';
import type { ModelCatalogSnapshot } from '../models/catalog';
import type { ProviderTarget } from '../runtime/target';
import type { StatusConfigSource, StatusSessionSource, StatusSessionView } from '../status/statusService';
import { StatusService } from '../status/statusService';
import { createSettings, testLogger } from './helpers';

/* -------------------------------------------------------------------------- */
/* 假对象                                                                      */
/* -------------------------------------------------------------------------- */

function target(patch: Partial<ProviderTarget> = {}): ProviderTarget {
	return {
		group: 'demo',
		baseUrl: 'https://api.example.com',
		apiKey: 'sk-secret',
		label: 'New API · demo',
		key: 'demo:abc123',
		issues: [],
		...patch,
	};
}

function snapshot(patch: Partial<ModelCatalogSnapshot> = {}): ModelCatalogSnapshot {
	return {
		models: [],
		fetchedAt: Date.now(),
		source: 'network',
		rawCount: 0,
		filtered: [],
		invalidCount: 0,
		...patch,
	};
}
/** 一个可控的会话：记录它被要求探测了几次，并把结果写回 `catalog.current`（与真实目录一致）。 */
function session(options: {
	target?: Partial<ProviderTarget>;
	snapshot?: ModelCatalogSnapshot;
	getModels?: () => Promise<ModelCatalogSnapshot>;
	status?: { system_name?: string; version?: string };
	getStatus?: () => Promise<{ status?: { system_name?: string; version?: string } }>;
} = {}): StatusSessionView & { probes: number } {
	let current = options.snapshot;
	const view = {
		probes: 0,
		target: target(options.target),
		catalog: {
			get current(): ModelCatalogSnapshot | undefined {
				return current;
			},
			async getModels(): Promise<ModelCatalogSnapshot> {
				view.probes += 1;
				current = options.getModels === undefined ? snapshot() : await options.getModels();
				return current;
			},
		},
		client: {
			async getStatus() {
				return options.getStatus === undefined
					? { status: options.status ?? { system_name: '演示站点', version: '1.0.0' } }
					: await options.getStatus();
			},
		},
	};
	return view;
}

interface FakeSessions extends StatusSessionSource {
	readonly invalidations: number[];
	views: StatusSessionView[];
	/** 模拟「会话集合变了」 */
	notify(): void;
}

function fakeSessions(initial: StatusSessionView[] = []): FakeSessions {
	const emitter = new vscode.EventEmitter<void>();
	const invalidations: number[] = [];
	const source: FakeSessions = {
		views: initial,
		invalidations,
		list: () => source.views,
		onDidChange: emitter.event,
		invalidate: () => {
			invalidations.push(1);
		},
		notify: () => emitter.fire(),
	};
	return source;
}

interface FakeConfig extends StatusConfigSource {
	set(patch: Partial<NewApiSettings>): void;
}

function fakeConfig(initial: Partial<NewApiSettings> = {}): FakeConfig {
	const emitter = new vscode.EventEmitter<NewApiSettings>();
	let settings: NewApiSettings = {
		logLevel: 'info',
		models: createSettings(),
		request: {
			timeoutMs: 60_000,
			streamIdleTimeoutMs: 60_000,
			includeUsage: true,
			maxRetries: 2,
			temperature: undefined,
			topP: undefined,
			includeReasoning: false,
			stabilizeToolList: false,
			extraBody: {},
		},
		status: { showStatusBar: true, refreshIntervalMs: 60_000 },
		...initial,
	};
	return {
		get settings() {
			return settings;
		},
		onDidChange: emitter.event,
		set: patch => {
			settings = { ...settings, ...patch };
			emitter.fire(settings);
		},
	};
}

/** 造一个服务；调用方负责 `dispose()`。 */
function createService(options: {
	sessions: FakeSessions;
	config?: FakeConfig;
}): StatusService {
	return new StatusService({
		logger: testLogger(),
		config: options.config ?? fakeConfig(),
		sessions: options.sessions,
	});
}

/* -------------------------------------------------------------------------- */
/* 用例                                                                        */
/* -------------------------------------------------------------------------- */

suite('status / 状态服务', () => {
	test('没有配置组时状态为空，且探测直接跳过', async () => {
		const sessions = fakeSessions();
		const service = createService({ sessions });
		try {
			await service.refresh();

			assert.deepStrictEqual(service.state.targets, []);
			assert.strictEqual(service.state.anyUsable, false);
			assert.strictEqual(service.state.totalModels, 0);
		} finally {
			service.dispose();
		}
	});

	test('把会话快照投影成可渲染的目标状态', () => {
		const sessions = fakeSessions([session({
			snapshot: snapshot({ models: [], rawCount: 5, filtered: [{ id: 'x', reason: 'r' }], invalidCount: 2 }),
		})]);
		const service = createService({ sessions });
		try {
			const [status] = service.state.targets;
			assert.strictEqual(status.label, 'New API · demo');
			assert.strictEqual(status.usable, true);
			assert.deepStrictEqual(
				{ count: status.models.count, filteredCount: status.models.filteredCount },
				{ count: 0, filteredCount: 1 },
			);
		} finally {
			service.dispose();
		}
	});

	test('探测记下延迟并刷新模型快照', async () => {
		const fresh = snapshot({ models: [], rawCount: 3 });
		const view = session({ getModels: async () => fresh });
		const sessions = fakeSessions([view]);
		const service = createService({ sessions });
		try {
			await service.refresh({ forceModels: true });

			assert.strictEqual(view.probes, 1);
			const [status] = service.state.targets;
			assert.ok(typeof status.latencyMs === 'number' && status.latencyMs >= 0, '应记录探测耗时');
			assert.strictEqual(status.refreshing, false);
		} finally {
			service.dispose();
		}
	});

	test('配置不完整的组不探测', async () => {
		const view = session({ target: { issues: ['尚未填写 API Key'] } });
		const sessions = fakeSessions([view]);
		const service = createService({ sessions });
		try {
			await service.refresh();

			assert.strictEqual(view.probes, 0, '配置不完整时不该发请求');
			assert.strictEqual(service.state.targets[0].usable, false);
			assert.strictEqual(service.state.anyUsable, false);
		} finally {
			service.dispose();
		}
	});

	test('探测抛错不会让刷新失败，状态仍然可渲染', async () => {
		const broken = session({
			target: { label: 'New API · 坏站点' },
			getStatus: async () => {
				throw new Error('连接超时');
			},
		});
		const healthy = session({ target: { label: 'New API · 好站点' } });
		const sessions = fakeSessions([broken, healthy]);
		const service = createService({ sessions });
		try {
			await service.refresh();

			const labels = service.state.targets.map(item => item.label);
			assert.deepStrictEqual(labels, ['New API · 好站点', 'New API · 坏站点'].sort((a, b) => (a < b ? -1 : 1)));
			// 坏站点仍然出现在状态里，只是没有探测信息
			const failed = service.state.targets.find(item => item.label === 'New API · 坏站点');
			assert.strictEqual(failed?.latencyMs, undefined);
			assert.strictEqual(service.state.anyUsable, true, '另一个站点可用，整体就算可用');
		} finally {
			service.dispose();
		}
	});

	test('模型列表带着错误时，错误与建议都进状态', async () => {
		const view = session({
			getModels: async () => snapshot({ error: '连接超时', hint: '检查站点地址' }),
		});
		const service = createService({ sessions: fakeSessions([view]) });
		try {
			await service.refresh();

			const [status] = service.state.targets;
			assert.strictEqual(status.models.error, '连接超时');
			assert.strictEqual(status.models.hint, '检查站点地址');
		} finally {
			service.dispose();
		}
	});

	test('同一组的并发刷新不会重复探测', async () => {
		const view = session();
		const sessions = fakeSessions([view]);
		const service = createService({ sessions });
		try {
			await Promise.all([service.refresh(), service.refresh()]);
			// 第二次进入 refreshSession 时该组已在 refreshing 集合里，直接返回
			assert.strictEqual(view.probes, 1);
		} finally {
			service.dispose();
		}
	});

	test('用量累加：token 分项、工具调用、最后一次请求的身份', () => {
		const service = createService({ sessions: fakeSessions() });
		try {
			service.recordUsage('New API · demo', 'gpt-4o', {
				prompt_tokens: 1_000,
				completion_tokens: 200,
				total_tokens: 1_200,
				prompt_tokens_details: { cached_tokens: 512 },
				completion_tokens_details: { reasoning_tokens: 64 },
			}, { toolCallCount: 2 });
			service.recordUsage('New API · demo', 'gpt-4o', { total_tokens: 100 }, { toolCallCount: 1 });

			const usage = service.state.usage;
			assert.strictEqual(usage.requests, 2);
			assert.strictEqual(usage.promptTokens, 1_000);
			assert.strictEqual(usage.completionTokens, 200);
			assert.strictEqual(usage.totalTokens, 1_300);
			assert.strictEqual(usage.cachedTokens, 512);
			assert.strictEqual(usage.reasoningTokens, 64);
			assert.strictEqual(usage.toolCalls, 3);
			assert.strictEqual(usage.lastModelId, 'gpt-4o');
			assert.strictEqual(usage.lastTargetLabel, 'New API · demo');
			assert.ok(usage.lastRequestAt !== undefined);
		} finally {
			service.dispose();
		}
	});

	test('cacheReported 一旦为真就不再回到假', () => {
		const service = createService({ sessions: fakeSessions() });
		try {
			service.recordUsage('t', 'm', { total_tokens: 1, prompt_tokens_details: { cached_tokens: 0 } }, { toolCallCount: 0 });
			assert.strictEqual(service.state.usage.cacheReported, true);

			// 后续响应不带缓存字段，也不该把「上游报过缓存」这个事实抹掉
			service.recordUsage('t', 'm', { total_tokens: 1 }, { toolCallCount: 0 });
			assert.strictEqual(service.state.usage.cacheReported, true);
		} finally {
			service.dispose();
		}
	});

	test('重置用量只清空计数，不动目标状态', () => {
		const sessions = fakeSessions([session({ snapshot: snapshot({ rawCount: 3 }) })]);
		const service = createService({ sessions });
		try {
			service.recordUsage('t', 'm', { total_tokens: 10 }, { toolCallCount: 1 });
			service.resetUsage();

			assert.strictEqual(service.state.usage.requests, 0);
			assert.strictEqual(service.state.usage.totalTokens, 0);
			assert.strictEqual(service.state.usage.toolCalls, 0);
			assert.strictEqual(service.state.usage.lastRequestAt, undefined);
			assert.strictEqual(service.state.targets.length, 1);
		} finally {
			service.dispose();
		}
	});

	test('状态栏开关来自配置', () => {
		const config = fakeConfig({ status: { showStatusBar: false, refreshIntervalMs: 60_000 } });
		const service = createService({ sessions: fakeSessions(), config });
		try {
			assert.strictEqual(service.state.statusBarEnabled, false);
		} finally {
			service.dispose();
		}
	});
	test('配置变化时丢弃会话缓存并重新发状态', () => {
		const sessions = fakeSessions();
		const config = fakeConfig();
		const service = createService({ sessions, config });
		const states: unknown[] = [];
		const listener = service.onDidChange(state => states.push(state));
		try {
			config.set({ logLevel: 'warn' });

			assert.strictEqual(sessions.invalidations.length, 1, '模型过滤设置可能变了，缓存必须失效');
			assert.strictEqual(states.length, 1);
		} finally {
			listener.dispose();
			service.dispose();
		}
	});

	test('会话变化（模型集合变了）会重新发状态', () => {
		const sessions = fakeSessions();
		const service = createService({ sessions });
		const states: unknown[] = [];
		const listener = service.onDidChange(state => states.push(state));
		try {
			sessions.views = [session({ snapshot: snapshot({ rawCount: 1 }) })];
			sessions.notify();

			assert.strictEqual(states.length, 1);
			assert.strictEqual(service.state.targets.length, 1);
		} finally {
			listener.dispose();
			service.dispose();
		}
	});
});
