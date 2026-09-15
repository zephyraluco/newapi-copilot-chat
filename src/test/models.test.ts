import * as assert from 'assert';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { safeJsonParse } from '../json';
import {
	MODEL_DATASET_FILE,
	installModelDataset,
	matchModelDataset,
	parseModelDataset,
} from '../models/dataset';
import { findFilteringPattern, globToRegExp, matchAnyGlob } from '../models/matcher';
import { buildModelConfigs, deriveFamily, extractRemoteHints, resolveModelConfig } from '../models/modelConfig';
import type { NewApiModel } from '../types';
import {
	clearTestDataset,
	createModel,
	createSettings,
	datasetEntry,
	installTestDataset,
	testLogger,
} from './helpers';

/**
 * 这些测试只覆盖**纯函数**：模型信息整合、glob 匹配与字段提取。
 * 网络交互、Webview 渲染等需要真实环境的逻辑不在这里测（属于手工验收范围）。
 */

suite('models / matcher', () => {
	test('通配符匹配整个字符串而不是子串', () => {
		assert.strictEqual(matchAnyGlob('gpt-4o', ['gpt-*']), true);
		// 必须是完整匹配：'gpt-*' 不应命中带前缀的 ID
		assert.strictEqual(matchAnyGlob('my-gpt-4o', ['gpt-*']), false);
	});

	test('大小写不敏感', () => {
		assert.strictEqual(matchAnyGlob('GPT-4O', ['gpt-4o']), true);
	});

	test('正则特殊字符被转义', () => {
		// 若没有转义，'gpt-4.1' 里的 '.' 会匹配任意字符
		const regex = globToRegExp('gpt-4.1');
		assert.strictEqual(regex.test('gpt-4.1'), true);
		assert.strictEqual(regex.test('gpt-4x1'), false);
	});

	test('? 只匹配单个字符', () => {
		assert.strictEqual(matchAnyGlob('ab', ['a?']), true);
		assert.strictEqual(matchAnyGlob('abc', ['a?']), false);
	});

	test('exclude 优先于 include', () => {
		const result = findFilteringPattern('gpt-4o', ['gpt-*'], ['gpt-4o']);
		assert.strictEqual(result?.kind, 'exclude');
	});

	test('include 为空表示全部保留', () => {
		assert.strictEqual(findFilteringPattern('anything', [], []), undefined);
	});

	test('include 非空时形成白名单', () => {
		const result = findFilteringPattern('llama-3', ['gpt-*'], []);
		assert.strictEqual(result?.kind, 'include');
	});
});

suite('models / family 推导', () => {
	test('去掉日期版本后缀', () => {
		assert.strictEqual(deriveFamily('gpt-4o-2024-08-06'), 'gpt-4o');
		assert.strictEqual(deriveFamily('gpt-4o-20240806'), 'gpt-4o');
	});

	test('去掉语义化后缀', () => {
		assert.strictEqual(deriveFamily('claude-3-5-sonnet-latest'), 'claude-3-5-sonnet');
		assert.strictEqual(deriveFamily('some-model-preview'), 'some-model');
	});

	test('去掉渠道后缀', () => {
		assert.strictEqual(deriveFamily('deepseek-chat@official'), 'deepseek-chat');
	});

	test('无后缀时原样返回（小写）', () => {
		assert.strictEqual(deriveFamily('DeepSeek-Chat'), 'deepseek-chat');
	});
});

/**
 * 找到随包的数据表文件。
 *
 * 编译产物在 `out/test/`，打包产物在 `dist/`，两种布局到仓库根的距离不同，
 * 因此向上逐层找而不是写死相对路径。
 */
function findDatasetFile(): string | undefined {
	let dir = __dirname;
	for (let depth = 0; depth < 4; depth++) {
		const candidate = path.join(dir, 'data', MODEL_DATASET_FILE);
		if (existsSync(candidate)) {
			return candidate;
		}
		dir = path.dirname(dir);
	}
	return undefined;
}

suite('models / 本地模型数据表', () => {
	teardown(clearTestDataset);

	test('随包的数据表文件存在、可解析，且能被自己的 id 命中', () => {
		// 扩展运行时由 `extension.ts` 读这个文件。测试与扩展是两个模块实例，
		// 读不到扩展的内部状态，所以只断言外部可观察事实：文件在预期位置、
		// 是合法 JSON、能被载入器接受。这能挡住「数据文件漏提交」与
		// 「打包配置把 data/ 排除掉」两类回归，也能发现生成脚本与载入器的约定漂移。
		const file = findDatasetFile();
		assert.ok(file !== undefined, `未找到 data/${MODEL_DATASET_FILE}`);

		const dataset = installModelDataset(safeJsonParse(readFileSync(file, 'utf8')));
		assert.ok(dataset.entries.length > 100, `数据表记录过少：${dataset.entries.length}`);
		assert.strictEqual(dataset.skipped, 0, '随包数据表不应含被丢弃的条目');

		const first = dataset.entries[0];
		assert.strictEqual(typeof first.imageInput, 'boolean');
		assert.strictEqual(typeof first.toolCalling, 'boolean');
		assert.strictEqual(matchModelDataset(first.id)?.key, first.id);
		// 网关常给模型 ID 加渠道后缀，这条路径必须也能命中
		assert.strictEqual(matchModelDataset(`${first.id}@official`)?.key, first.id);
	});

	test('精确命中优先，不会被剥掉后缀后的候选抢走', () => {
		installTestDataset([
			datasetEntry('gpt-4o'),
			datasetEntry('gpt-4o-2024-08-06', { contextWindow: 64_000 }),
		]);
		assert.strictEqual(matchModelDataset('gpt-4o-2024-08-06')?.key, 'gpt-4o-2024-08-06');
		assert.strictEqual(matchModelDataset('gpt-4o')?.key, 'gpt-4o');
	});

	test('剥掉渠道与日期后缀后仍能命中', () => {
		installTestDataset([datasetEntry('gpt-4o')]);
		assert.strictEqual(matchModelDataset('gpt-4o@official')?.key, 'gpt-4o');
		assert.strictEqual(matchModelDataset('gpt-4o-2024-08-06')?.key, 'gpt-4o');
	});

	test('剥掉厂商前缀与变体后缀后仍能命中', () => {
		installTestDataset([datasetEntry('claude-sonnet-4')]);
		assert.strictEqual(matchModelDataset('~anthropic/claude-sonnet-4:free')?.key, 'claude-sonnet-4');
	});

	test('匹配大小写不敏感', () => {
		installTestDataset([datasetEntry('gpt-4o')]);
		assert.strictEqual(matchModelDataset('GPT-4O')?.key, 'gpt-4o');
	});

	test('不完整或类型不对的条目被丢弃并计数', () => {
		const dataset = parseModelDataset({
			models: [
				{ id: 'ok', contextWindow: 1_000, maxOutputTokens: 100 },
				{ id: 'no-window', maxOutputTokens: 100 },
				{ contextWindow: 1_000, maxOutputTokens: 100 },
				'not-an-object',
			],
		});
		assert.strictEqual(dataset.entries.length, 1);
		assert.strictEqual(dataset.skipped, 3);
	});

	test('缺失的能力位收敛成 false', () => {
		const dataset = parseModelDataset([{ id: 'x', contextWindow: 1_000, maxOutputTokens: 100 }]);
		assert.strictEqual(dataset.entries[0].imageInput, false);
		assert.strictEqual(dataset.entries[0].toolCalling, false);
	});

	test('清空数据表后查不到任何记录', () => {
		installTestDataset([datasetEntry('gpt-4o')]);
		clearTestDataset();
		assert.strictEqual(matchModelDataset('gpt-4o'), undefined);
	});
});

suite('models / 远端字段提取', () => {
	test('OpenRouter 风格字段', () => {
		const hints = extractRemoteHints(createModel('x', {
			context_length: 200_000,
			top_provider: { max_completion_tokens: 8_192 },
			architecture: { input_modalities: ['text', 'image'] },
			supported_parameters: ['tools', 'temperature'],
		}));
		assert.strictEqual(hints.contextWindow, 200_000);
		assert.strictEqual(hints.maxOutputTokens, 8_192);
		assert.strictEqual(hints.imageInput, true);
		assert.strictEqual(hints.toolCalling, true);
	});

	test('只有文本模态时判定为不支持图片', () => {
		const hints = extractRemoteHints(createModel('x', {
			architecture: { input_modalities: ['text'] },
		}));
		assert.strictEqual(hints.imageInput, false);
	});

	test('没有 tools 参数时判定为不支持工具调用', () => {
		const hints = extractRemoteHints(createModel('x', {
			supported_parameters: ['temperature', 'top_p'],
		}));
		assert.strictEqual(hints.toolCalling, false);
	});

	test('New API 只返回 max_tokens 时不臆测上下文窗口', () => {
		const hints = extractRemoteHints(createModel('x', { max_tokens: 4_096 }));
		// max_tokens 语义含糊，只当作输出上限，上下文窗口留给本地模型数据表
		assert.strictEqual(hints.contextWindow, undefined);
		assert.strictEqual(hints.maxOutputTokens, 4_096);
	});

	test('displayName 与 id 相同时会被清掉', () => {
		const hints = extractRemoteHints(createModel('gpt-4o', { name: 'gpt-4o' }));
		assert.strictEqual(hints.displayName, undefined);
	});
});

suite('models / 配置整合', () => {
	// 用例共享的数据表。输出上限刻意与 `createSettings()` 的默认值不同，
	// 这样「命中数据表」与「落到默认值」在断言里就能区分开。
	const DATASET = [
		datasetEntry('gpt-4o', {
			contextWindow: 128_000,
			maxOutputTokens: 16_384,
			imageInput: true,
			toolCalling: true,
			vendor: 'OpenAI',
			displayName: 'GPT-4o',
		}),
		datasetEntry('gpt-4', { contextWindow: 8_192, maxOutputTokens: 4_096, toolCalling: true }),
	];

	setup(() => installTestDataset(DATASET));
	teardown(clearTestDataset);

	test('数据表未命中时使用配置的默认值', () => {
		const config = resolveModelConfig(createModel('totally-unknown-model'), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.contextWindow, 128_000);
		assert.strictEqual(config.meta.provenance.contextWindow, 'default');
		assert.strictEqual(config.meta.datasetKey, undefined);
		assert.strictEqual(config.imageInput, false);
	});

	test('数据表命中时采用数据表数值', () => {
		const config = resolveModelConfig(createModel('gpt-4o'), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.contextWindow, 128_000);
		assert.strictEqual(config.maxOutputTokens, 16_384);
		assert.strictEqual(config.imageInput, true);
		assert.strictEqual(config.toolCalling, true);
		assert.strictEqual(config.meta.provenance.contextWindow, 'dataset');
		assert.strictEqual(config.meta.datasetKey, 'gpt-4o');
		// 输入上限由「窗口 - 输出」推导
		assert.strictEqual(config.maxInputTokens, 128_000 - 16_384);
		assert.ok(config.tooltip.includes('本地模型数据表命中'), 'tooltip 应说明命中的数据表键');
	});

	test('网关返回值覆盖数据表', () => {
		const config = resolveModelConfig(createModel('gpt-4o', { context_length: 64_000 }), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.contextWindow, 64_000);
		assert.strictEqual(config.meta.provenance.contextWindow, 'remote');
		// 差异显著时应在 tooltip 里提醒用户
		assert.ok(config.meta.notes.some(note => note.includes('不一致')));
	});

	test('用户覆盖的优先级最高', () => {
		const config = resolveModelConfig(
			createModel('gpt-4o', { context_length: 64_000 }),
			{
				settings: createSettings({
					overrides: { 'gpt-4o': { contextWindow: 32_000, toolCalling: false } },
				}),
				logger: testLogger(),
			},
		);
		assert.strictEqual(config.contextWindow, 32_000);
		assert.strictEqual(config.toolCalling, false);
		assert.strictEqual(config.meta.provenance.contextWindow, 'override');
	});

	test('输出过大时会被压回，保证输入空间', () => {
		// 数据表里 gpt-4 的窗口是 8192，这里让网关声称能输出 8000
		const config = resolveModelConfig(createModel('gpt-4', { max_output_tokens: 8_000 }), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.contextWindow, 8_192);
		assert.ok(config.maxOutputTokens < 8_000, '输出上限应被下调');
		assert.ok(config.maxInputTokens > 0);
		assert.ok(
			config.maxInputTokens + config.maxOutputTokens <= config.contextWindow,
			'输入 + 输出不应超过上下文窗口',
		);
		assert.ok(config.meta.notes.some(note => note.includes('挤占')));
	});

	test('输入上限超过窗口时会被收敛', () => {
		const config = resolveModelConfig(createModel('gpt-4', { max_input_tokens: 100_000 }), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.ok(config.maxInputTokens <= config.contextWindow);
	});

	test('所有模型的 maxInputTokens 与 maxOutputTokens 都为正', () => {
		const ids = ['gpt-4o', 'claude-3-5-sonnet-latest', 'deepseek-reasoner', 'o1-mini', 'unknown-xyz'];
		for (const id of ids) {
			const config = resolveModelConfig(createModel(id), {
				settings: createSettings(),
				logger: testLogger(),
			});
			assert.ok(config.maxInputTokens > 0, `${id} 的 maxInputTokens 应为正`);
			assert.ok(config.maxOutputTokens > 0, `${id} 的 maxOutputTokens 应为正`);
		}
	});
});

suite('models / 批量构建与过滤', () => {
	test('按 include / exclude 过滤，并记录原因', () => {
		const result = buildModelConfigs(
			[createModel('gpt-4o'), createModel('llama-3'), createModel('gpt-4o-mini')],
			{
				settings: createSettings({ include: ['gpt-*'], exclude: ['*-mini'] }),
				logger: testLogger(),
			},
		);
		assert.deepStrictEqual(result.configs.map(config => config.id), ['gpt-4o']);
		assert.strictEqual(result.filtered.length, 2);
		assert.ok(result.filtered.some(item => item.reason.includes('排除')));
		assert.ok(result.filtered.some(item => item.reason.includes('包含')));
	});

	test('缺少 id 的条目被计入 invalidCount 而不是让整批失败', () => {
		const result = buildModelConfigs(
			[createModel('gpt-4o'), { object: 'model' } as NewApiModel],
			{ settings: createSettings(), logger: testLogger() },
		);
		assert.strictEqual(result.configs.length, 1);
		assert.strictEqual(result.invalidCount, 1);
	});
});
