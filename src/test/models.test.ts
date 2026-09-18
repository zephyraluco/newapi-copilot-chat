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
import type { ModelDatasetEntry } from '../models/dataset';
import { findFilteringPattern, globToRegExp, matchAnyGlob } from '../models/matcher';
import { buildModelConfigs, deriveFamily, extractRemoteHints, resolveModelConfig } from '../models/modelConfig';
import type { NewApiModel } from '../types';
import {
	capturingLogger,
	clearTestDataset,
	createModel,
	createSettings,
	datasetEntry,
	installTestDataset,
	testLogger,
} from './helpers';

/**
 * 这些测试只覆盖**纯函数**：模型信息整合、glob 匹配与字段提取。
 * 网络交互、状态栏渲染等需要真实环境的逻辑不在这里测（属于手工验收范围）。
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

/** 全角空格：tooltip 用它把标签补到等宽（见 `models/tooltip.ts` 的 `padLabel`）。 */
const PAD = '\u3000';

/**
 * 匹配 tooltip 里的一行事实。
 *
 * 标签是被补齐过的，标签与取值之间的间隙是全角空格、数量随标签长度变化，
 * 因此不能写死字面量——这里只要求「同一行的标签 + 若干全角空格 + 取值」。
 */
function factRow(label: string, value: string): RegExp {
	return new RegExp(`^${label}${PAD}+${value}$`, 'm');
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

	test('随包数据表里的思考强度字段自洽', () => {
		const file = findDatasetFile();
		assert.ok(file !== undefined, `未找到 data/${MODEL_DATASET_FILE}`);
		const dataset = installModelDataset(safeJsonParse(readFileSync(file, 'utf8')));

		type EntryWithEfforts = ModelDatasetEntry & { readonly supportsReasoningEffort: readonly string[] };
		const withEfforts = dataset.entries.filter(
			(entry): entry is EntryWithEfforts => entry.supportsReasoningEffort !== undefined,
		);
		assert.ok(withEfforts.length > 10, `带强度列表的条目过少：${withEfforts.length}`);
		for (const entry of withEfforts) {
			// 生成脚本从上游原样抄下 `supported_efforts` 与 `default_effort`，
			// 因此这两条应当成立；一旦不成立就说明生成侧或载入侧漂了
			assert.ok(entry.supportsReasoningEffort.length > 0, `${entry.id} 的列表不应为空`);
			assert.strictEqual(entry.reasoning, true, `${entry.id} 能调强度就应当支持思考`);
			const fallback = entry.defaultReasoningEffort;
			assert.ok(fallback !== undefined, `${entry.id} 有强度列表却没有默认强度`);
			assert.ok(
				entry.supportsReasoningEffort.includes(fallback),
				`${entry.id} 的默认强度应当落在自己的列表里`,
			);
		}
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

	test('思考强度列表被收拢：去空白、去重、全空视为没有', () => {
		const dataset = parseModelDataset({
			models: [
				{
					id: 'a',
					contextWindow: 1_000,
					maxOutputTokens: 100,
					supportsReasoningEffort: [' high ', 'low', 'high', 7, '  '],
					defaultReasoningEffort: ' high ',
				},
				{
					id: 'b',
					contextWindow: 1_000,
					maxOutputTokens: 100,
					supportsReasoningEffort: ['   '],
					defaultReasoningEffort: '   ',
				},
			],
		});
		assert.deepStrictEqual(dataset.entries[0].supportsReasoningEffort, ['high', 'low']);
		assert.strictEqual(dataset.entries[0].defaultReasoningEffort, 'high');
		// 全空列表等于「没有这个信息」，而不是「一个选项都没有」
		assert.strictEqual(dataset.entries[1].supportsReasoningEffort, undefined);
		assert.strictEqual(dataset.entries[1].defaultReasoningEffort, undefined);
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
		// 没有展示名可用时，选择器里只能显示 ID
		assert.strictEqual(config.name, 'totally-unknown-model');
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
		// 选择器里显示展示名（ID 那种机器名没人愿意读），ID 仍留在 id 字段里回传
		assert.strictEqual(config.name, 'GPT-4o');
		assert.strictEqual(config.id, 'gpt-4o');
	});

	test('tooltip 逐项一行，来源与校正提醒不在里面', () => {
		// 「数值可不可信、冲突时采用了谁」看日志；tooltip 只回答
		// 「这是什么模型、能干什么」——把提醒塞进来会让每次悬停都变成读一张表。
		const captured = capturingLogger();
		const config = resolveModelConfig(createModel('gpt-4o', { context_length: 64_000 }), {
			settings: createSettings(),
			logger: captured.logger,
		});
		// 冲突不能静默：不写进模型信息，就必须落在日志里
		assert.ok(
			captured.messages('debug').some(line => line.includes('上下文窗口') && line.includes('不一致')),
			`冲突应写进日志，实际：${captured.messages('debug').join(' | ')}`,
		);
		// 不写标题（悬浮卡片自己渲染模型名），第一段直接是身份：`id` · 厂商
		assert.ok(
			config.tooltip.startsWith('`gpt-4o` · OpenAI\n'),
			`第一行应是身份，实际：${config.tooltip}`,
		);
		assert.ok(!config.tooltip.includes('### '), '不应再有标题');
		assert.ok(!config.tooltip.includes('GPT-4o'), '展示名不进入 tooltip');
		assert.ok(factRow('上下文窗口', '64K').test(config.tooltip), `应采用网关的窗口，实际：${config.tooltip}`);
		// 能力位仍要在 tooltip 里可见
		assert.ok(factRow('图片输入', '✅').test(config.tooltip), `实际：${config.tooltip}`);
		assert.ok(factRow('工具调用', '✅').test(config.tooltip), `实际：${config.tooltip}`);
		assert.ok(!config.tooltip.includes('⚠️'), '校正提醒不进 tooltip');
		assert.ok(!config.tooltip.includes('数据表命中'), '命中的数据表键不进 tooltip');
	});

	test('网关给出展示名时优先用它', () => {
		// 数据表里没有这个模型，只能靠网关的名字
		const config = resolveModelConfig(createModel('some-relay-model', { display_name: 'Friendly Name' }), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.name, 'Friendly Name');
		assert.strictEqual(config.id, 'some-relay-model');
	});

	test('键与值分列：标签补到等宽，取值列对齐', () => {
		const config = resolveModelConfig(createModel('gpt-4o'), {
			settings: createSettings(),
			logger: testLogger(),
		});
		// 每个项目各自成段：段落数 = 身份 + 6 行事实。若把事实挤成一行，段落数会变少
		assert.strictEqual(
			config.tooltip.split('\n\n').length,
			7,
			`每个项目应当各自成段，实际：${JSON.stringify(config.tooltip)}`,
		);
		// 一行事实 = 无全角空格的标签 + 若干全角空格 + 取值（取值里不含全角空格）
		const rows = config.tooltip
			.split('\n')
			.map(line => /^(\S+?)(\u3000+)(\S+)$/.exec(line))
			.filter((match): match is RegExpExecArray => match !== null);
		assert.strictEqual(rows.length, 6, `应恰有 6 行事实，实际：${config.tooltip}`);
		// 标签宽度 + 间隙宽度逐行相等，取值才会落在同一列上
		const valueColumns = rows.map(match => [...match[1]].length + [...match[2]].length);
		assert.strictEqual(
			new Set(valueColumns).size,
			1,
			`取值列应当对齐，实际列位：${valueColumns.join(' / ')}\n${config.tooltip}`,
		);
		// 键与值之间必须有间隙（不能因为补齐而黏在一起）
		for (const match of rows) {
			assert.ok(match[2].length >= 1, `标签与取值之间应有间隙，实际：${match[0]}`);
		}
	});

	test('网关返回值覆盖数据表，差异记进日志', () => {
		const captured = capturingLogger();
		const config = resolveModelConfig(createModel('gpt-4o', { context_length: 64_000 }), {
			settings: createSettings(),
			logger: captured.logger,
		});
		assert.strictEqual(config.contextWindow, 64_000);
		assert.strictEqual(config.meta.provenance.contextWindow, 'remote');
		// 差异显著时要在日志里留痕（用户排查「站点明明支持更大窗口」时的唯一线索）
		assert.ok(
			captured.messages('debug').some(line => line.includes('不一致') && line.includes('已采用网关值')),
			`应记录差异，实际：${captured.messages('debug').join(' | ')}`,
		);
	});

	test('数值没有差异时不会多写一条日志', () => {
		const captured = capturingLogger();
		resolveModelConfig(createModel('gpt-4o'), {
			settings: createSettings(),
			logger: captured.logger,
		});
		// trace 行证明这个模型确实走完了流程，避免「一条日志都没写也算通过」
		assert.strictEqual(captured.messages('trace').length, 1);
		assert.deepStrictEqual(
			captured.messages('debug'),
			[],
			`本例不应有任何提示，实际：${captured.messages('debug').join(' | ')}`,
		);
	});

	test('数据表连条目都没有时退回网关与默认值', () => {
		installTestDataset([]);
		const config = resolveModelConfig(createModel('nowhere-to-be-found', { context_length: 32_000 }), {
			settings: createSettings(),
			logger: testLogger(),
		});
		assert.strictEqual(config.contextWindow, 32_000);
		assert.strictEqual(config.meta.provenance.contextWindow, 'remote');
		assert.strictEqual(config.maxOutputTokens, 8_192);
		assert.strictEqual(config.meta.provenance.maxOutputTokens, 'default');
	});

	test('输出过大时会被压回，保证输入空间', () => {
		// 数据表里 gpt-4 的窗口是 8192，这里让这条记录声称能输出 8000
		installTestDataset([datasetEntry('gpt-4', { contextWindow: 8_192, maxOutputTokens: 8_000 })]);
		const captured = capturingLogger();
		const config = resolveModelConfig(createModel('gpt-4'), {
			settings: createSettings(),
			logger: captured.logger,
		});
		assert.strictEqual(config.contextWindow, 8_192);
		assert.ok(config.maxOutputTokens < 8_000, '输出上限应被下调');
		assert.ok(config.maxInputTokens > 0);
		assert.ok(
			config.maxInputTokens + config.maxOutputTokens <= config.contextWindow,
			'输入 + 输出不应超过上下文窗口',
		);
		// 修正不能静默：被下调的数字要能在日志里查到原因
		assert.ok(
			captured.messages('debug').some(line => line.includes('挤占')),
			`应记录下调原因，实际：${captured.messages('debug').join(' | ')}`,
		);
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

suite('models / 思考能力', () => {
	const DATASET = [
		datasetEntry('deepseek-reasoner', {
			reasoning: true,
			supportsReasoningEffort: ['low', 'medium', 'high'],
		}),
		datasetEntry('gpt-4o'),
	];

	setup(() => installTestDataset(DATASET));
	teardown(clearTestDataset);

	function resolve(id: string, extra: Record<string, unknown> = {}) {
		return resolveModelConfig(createModel(id, extra), {
			settings: createSettings(),
			logger: testLogger(),
		});
	}

	test('数据表命中时采用数据表的思考能力', () => {
		const config = resolve('deepseek-reasoner');
		assert.strictEqual(config.reasoning, true);
		assert.strictEqual(config.meta.provenance.reasoning, 'dataset');
		assert.ok(factRow('思考', '✅').test(config.tooltip), `思考能力要能一眼看到，实际：${config.tooltip}`);
	});

	test('数据表未命中且网关没表态时为不支持', () => {
		const config = resolve('totally-unknown-reasoner');
		assert.strictEqual(config.reasoning, false);
		assert.strictEqual(config.meta.provenance.reasoning, 'default');
		assert.ok(factRow('思考', '❌').test(config.tooltip));
	});

	test('网关列出推理参数时视为支持思考', () => {
		const config = resolve('some-model', { supported_parameters: ['tools', 'reasoning'] });
		assert.strictEqual(config.reasoning, true);
		assert.strictEqual(config.meta.provenance.reasoning, 'remote');
	});

	test('网关没列推理参数不会抹掉数据表的能力', () => {
		// New API 的 /v1/models 根本不返回 supported_parameters，
		// 因此「列不出来」只能理解为「没暴露参数」，不能推断模型不会思考。
		const config = resolve('deepseek-reasoner', { supported_parameters: ['tools'] });
		assert.strictEqual(config.reasoning, true);
		assert.strictEqual(config.meta.provenance.reasoning, 'dataset');
	});

	test('数据表没写时靠网关未表态而判定为不支持', () => {
		// 数据表只有明确写了 false 才算否定（见下个用例）；没写则只能靠网关
		installTestDataset([datasetEntry('mystery', { reasoning: false })]);
		const config = resolve('mystery');
		assert.strictEqual(config.reasoning, false);
		assert.strictEqual(config.meta.provenance.reasoning, 'dataset');
	});

	test('网关声明支持思考时优先于数据表', () => {
		// 数据表里没有这个模型，而网关自己说支持——以网关为准
		installTestDataset([datasetEntry('talkative', { reasoning: false })]);
		const config = resolve('talkative', { supported_parameters: ['reasoning'] });
		assert.strictEqual(config.reasoning, true);
		assert.strictEqual(config.meta.provenance.reasoning, 'remote');
	});

	test('数据表给出强度列表时采用它', () => {
		// 上游词汇比任何固定的三档都宽（实测有 max / xhigh / minimal / none）
		installTestDataset([datasetEntry('wide', {
			reasoning: true,
			supportsReasoningEffort: ['max', 'xhigh', 'high', 'low'],
			defaultReasoningEffort: 'high',
		})]);
		const config = resolve('wide');
		assert.deepStrictEqual(config.reasoningEfforts, ['max', 'xhigh', 'high', 'low']);
		assert.strictEqual(config.defaultReasoningEffort, 'high');
	});

	test('数据表没有强度列表时就是空列表，不回退到任何内置档位', () => {
		// 「会思考但不能调强度」的模型（上游只给 mandatory / default_enabled）就属于这种。
		// 凭空造一组合适的值只会发出站点不认的请求
		installTestDataset([datasetEntry('narrow', { reasoning: true })]);
		const config = resolve('narrow');
		assert.strictEqual(config.reasoning, true, '它确实支持思考');
		assert.deepStrictEqual(config.reasoningEfforts, []);
		assert.strictEqual(config.defaultReasoningEffort, undefined);
	});

	test('tooltip 不复述档位（档位在模型选择器里就能选）', () => {
		installTestDataset([datasetEntry('wide', {
			reasoning: true,
			supportsReasoningEffort: ['max', 'high'],
			defaultReasoningEffort: 'high',
		})]);
		const config = resolve('wide');
		// 档位解析出来是给选择器用的，tooltip 里只写能力
		assert.deepStrictEqual(config.reasoningEfforts, ['max', 'high']);
		assert.strictEqual(config.defaultReasoningEffort, 'high');
		assert.ok(factRow('思考', '✅').test(config.tooltip));
		assert.ok(!config.tooltip.includes('max'), `不该列出档位，实际：${config.tooltip}`);
		assert.ok(!config.tooltip.includes('high'), `不该列出默认档位，实际：${config.tooltip}`);
	});
});
