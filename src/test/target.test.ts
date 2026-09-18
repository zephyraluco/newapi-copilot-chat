import * as assert from 'assert';
import type { ModelDatasetEntry } from '../models/dataset';
import { resolveModelConfig } from '../models/modelConfig';
import { toModelInformation } from '../provider/chatProvider';
import { SessionRegistry } from '../runtime/session';
import {
	createTarget,
	isTargetUsable,
	readOptionsConfiguration,
	readOptionsGroup,
} from '../runtime/target';
import { createModel, createSettings, datasetEntry, installTestDataset, testLogger } from './helpers';

/**
 * 这些测试覆盖「配置从哪来、如何归一、会不会串台」。
 *
 * 背景：VS Code 为每个配置组分别调用 provider，组之间可以指向不同的站点。
 * 解析一旦出错，表现是「A 站的模型用 B 站的地址请求」这类极难从界面看出来的问题，
 * 因此值得用测试固定住。
 */

/** 一份完整的组配置。 */
function configuration(patch: Record<string, unknown> = {}): Record<string, unknown> {
	return { baseUrl: 'https://api.example.com', apiKey: 'sk-abc123456789', ...patch };
}

suite('provider / 连接目标', () => {
	test('配置齐全时可用', () => {
		const target = createTarget('我的站点', configuration(), testLogger());
		assert.strictEqual(isTargetUsable(target), true);
		assert.strictEqual(target.group, '我的站点');
		assert.strictEqual(target.baseUrl, 'https://api.example.com');
		assert.strictEqual(target.apiKey, 'sk-abc123456789');
		assert.ok(target.label.includes('我的站点'));
	});

	test('配置组未命名时仍可用', () => {
		const target = createTarget(undefined, configuration(), testLogger());
		assert.strictEqual(isTargetUsable(target), true);
		assert.strictEqual(target.group, undefined);
		assert.ok(target.label.includes('New API'));
	});

	test('字段缺失时不可用，并说明原因', () => {
		const missing = createTarget('g', {}, testLogger());
		assert.strictEqual(isTargetUsable(missing), false);
		assert.strictEqual(missing.issues.length, 2);
		assert.ok(missing.issues.some(issue => issue.includes('站点地址')));
		assert.ok(missing.issues.some(issue => issue.includes('API Key')));
	});

	test('只有空白的值等同于没填', () => {
		const target = createTarget('g', { baseUrl: '   ', apiKey: '  ' }, testLogger());
		assert.strictEqual(isTargetUsable(target), false);
		assert.strictEqual(target.baseUrl, '');
		assert.strictEqual(target.apiKey, undefined);
	});

	test('地址不合法时给出可读原因', () => {
		const target = createTarget('g', configuration({ baseUrl: 'api.example.com' }), testLogger());
		assert.strictEqual(isTargetUsable(target), false);
		assert.ok(target.issues.some(issue => issue.includes('不合法')));
	});

	test('站点地址被规范化：去掉尾斜杠与已知端点后缀', () => {
		const cases: readonly [string, string][] = [
			['https://api.example.com/', 'https://api.example.com'],
			['https://api.example.com/v1', 'https://api.example.com'],
			['https://api.example.com/v1/chat/completions', 'https://api.example.com'],
			['https://api.example.com/chat/completions', 'https://api.example.com'],
			['  https://api.example.com  ', 'https://api.example.com'],
		];
		for (const [input, expected] of cases) {
			const target = createTarget('g', configuration({ baseUrl: input }), testLogger());
			assert.strictEqual(target.baseUrl, expected, `输入 ${input} 应归一为 ${expected}`);
		}
	});

	test('指纹不含明文密钥', () => {
		const secret = 'sk-very-secret-value-abcdef';
		const target = createTarget('g', configuration({ apiKey: secret }), testLogger());
		assert.ok(!target.key.includes(secret), '指纹不得包含明文密钥');
		assert.ok(!target.key.includes('sk-'), '指纹不得包含密钥片段');
	});

	test('同一配置得到同一指纹，配置变化则指纹变化', () => {
		const a = createTarget('g', configuration(), testLogger());
		const b = createTarget('g', configuration(), testLogger());
		assert.strictEqual(a.key, b.key);

		assert.notStrictEqual(
			a.key,
			createTarget('g', configuration({ apiKey: 'sk-bbbb222222' }), testLogger()).key,
		);
		assert.notStrictEqual(
			a.key,
			createTarget('g', configuration({ baseUrl: 'https://b.example.com' }), testLogger()).key,
		);
	});

	test('不同组之间指纹互不相同', () => {
		const groupA = createTarget('A', configuration(), testLogger());
		const groupB = createTarget('B', configuration(), testLogger());
		assert.notStrictEqual(groupA.key, groupB.key);
		// 组名会进指纹，因此即使地址密钥相同也不会互相覆盖
		assert.notStrictEqual(groupA.key, groupB.key);
	});
});

suite('provider / options 运行时探测', () => {
	test('stable API 只给 silent 时读不到组信息', () => {
		// VS Code 1.137 的 PrepareLanguageModelChatModelOptions 只有 silent，
		// 此时必须安静地返回「无配置」，不能抛异常。
		const options = { silent: true };
		assert.strictEqual(readOptionsGroup(options), undefined);
		assert.strictEqual(readOptionsConfiguration(options), undefined);
	});

	test('能读到 VS Code 下发的组名与配置', () => {
		const options = {
			silent: false,
			group: '我的站点',
			configuration: configuration(),
		};
		assert.strictEqual(readOptionsGroup(options), '我的站点');
		assert.deepStrictEqual(readOptionsConfiguration(options), options.configuration);
	});

	test('非对象与非法类型不会抛异常', () => {
		assert.strictEqual(readOptionsGroup(undefined), undefined);
		assert.strictEqual(readOptionsGroup(null), undefined);
		assert.strictEqual(readOptionsConfiguration('not an object'), undefined);
		// configuration 不是对象时视为没给
		assert.strictEqual(readOptionsConfiguration({ configuration: [] }), undefined);
		// 空白的组名视为未命名
		assert.strictEqual(readOptionsGroup({ group: '   ' }), undefined);
	});
});

suite('provider / 会话注册表', () => {
	/** 建一个注册表，便于各用例复用。 */
	function createRegistry(): SessionRegistry {
		return new SessionRegistry({
			logger: testLogger(),
			getModelSettings: () => createSettings(),
			getRequestSettings: () => ({
				timeoutMs: 60_000,
				streamIdleTimeoutMs: 60_000,
				includeUsage: true,
				maxRetries: 2,
				temperature: undefined,
				topP: undefined,
				includeReasoning: false,
				stabilizeToolList: false,
				extraBody: {},
			}),
		});
	}

	test('相同目标复用同一个会话', () => {
		const registry = createRegistry();
		try {
			const target = createTarget('g', configuration(), testLogger());
			assert.strictEqual(registry.resolve(target), registry.resolve(target));
		} finally {
			registry.dispose();
		}
	});

	test('同组配置变化时重建会话，旧指纹不再可查', () => {
		const registry = createRegistry();
		try {
			const before = createTarget('g', configuration({ apiKey: 'sk-before111111' }), testLogger());
			const after = createTarget('g', configuration({ apiKey: 'sk-after2222222' }), testLogger());

			const sessionBefore = registry.resolve(before);
			const sessionAfter = registry.resolve(after);

			assert.notStrictEqual(sessionBefore, sessionAfter, '配置变化应产生新会话');
			assert.strictEqual(registry.find(before.key), undefined, '旧会话应已被替换');
			assert.strictEqual(registry.find(after.key), sessionAfter);
		} finally {
			registry.dispose();
		}
	});

	test('不同组各自持有会话，互不覆盖', () => {
		const registry = createRegistry();
		try {
			const groupA = createTarget('A', configuration(), testLogger());
			const groupB = createTarget('B', configuration({ baseUrl: 'https://b.example.com' }), testLogger());

			const sessionA = registry.resolve(groupA);
			const sessionB = registry.resolve(groupB);

			assert.notStrictEqual(sessionA, sessionB);
			assert.strictEqual(registry.find(groupA.key), sessionA);
			assert.strictEqual(registry.find(groupB.key), sessionB);
			// 关键：每个会话用自己的地址，不会串台
			assert.strictEqual(sessionA.client.baseUrl, 'https://api.example.com');
			assert.strictEqual(sessionB.client.baseUrl, 'https://b.example.com');
		} finally {
			registry.dispose();
		}
	});

	test('invalidate 后会话被丢弃，且列表按组名排序', () => {
		const registry = createRegistry();
		try {
			const target = createTarget('Z', configuration(), testLogger());
			registry.resolve(target);
			assert.strictEqual(registry.list().length, 1);

			registry.invalidate();
			assert.strictEqual(registry.find(target.key), undefined);
			assert.strictEqual(registry.list().length, 0);
		} finally {
			registry.dispose();
		}
	});

	test('释放后 resolve 会抛错而不是静默失败', () => {
		const registry = createRegistry();
		registry.dispose();
		assert.throws(() => registry.resolve(createTarget('g', configuration(), testLogger())));
	});
});

suite('provider / 模型信息不外泄密钥', () => {
	test('模型信息只带目标指纹与标签', () => {
		const secret = 'sk-super-secret-abcdef123456';
		const target = createTarget('g', configuration({ apiKey: secret }), testLogger());
		const config = resolveModelConfig(createModel('gpt-4o'), {
			settings: createSettings(),
			logger: testLogger(),
		});
		const info = toModelInformation(config, target);

		assert.strictEqual(info.targetKey, target.key);
		assert.strictEqual(info.targetLabel, target.label);
		// 这个对象会被 VS Code 长期缓存在模型元数据里，绝不能带明文密钥
		assert.ok(!JSON.stringify(info).includes(secret), '模型信息不得包含明文密钥');
	});
});

suite('provider / 模型信息里的思考强度控件', () => {
	/** 造一份交给 VS Code 的模型信息。 */
	function infoFor(id: string, entry: Partial<ModelDatasetEntry> = {}) {
		installTestDataset([datasetEntry(id, entry)]);
		const config = resolveModelConfig(createModel(id), {
			settings: createSettings(),
			logger: testLogger(),
		});
		return toModelInformation(config, createTarget('g', configuration(), testLogger()));
	}

	teardown(() => installTestDataset([]));

	test('有可选档位时才带上 configurationSchema', () => {
		const info = infoFor('wide', {
			reasoning: true,
			supportsReasoningEffort: ['high', 'low'],
			defaultReasoningEffort: 'high',
		});
		const property = info.configurationSchema?.properties.reasoningEffort;
		assert.deepStrictEqual(property?.enum, ['high', 'low']);
		// 预选项来自数据表，控件因此不是空选中状态
		assert.strictEqual(property?.default, 'high');
	});

	test('数据表没给默认档位时控件不带预选项', () => {
		const info = infoFor('wide', { reasoning: true, supportsReasoningEffort: ['high', 'low'] });
		assert.ok(!('default' in (info.configurationSchema?.properties.reasoningEffort ?? {})));
	});

	test('档位为空时不带 configurationSchema（模型选择器里不会出现控件）', () => {
		// 这是「会思考但不可调」的模型：给它一个没有选项的控件比不给控件更糟
		const info = infoFor('narrow', { reasoning: true });
		assert.strictEqual(info.configurationSchema, undefined);
	});

	test('不支持思考的模型同样不带 configurationSchema', () => {
		const info = infoFor('plain', { reasoning: false });
		assert.strictEqual(info.configurationSchema, undefined);
	});
});
