'use strict';

/**
 * models 层：数据表解析与匹配、数值校正、网关字段提取、三路信息合并、tooltip 排版。
 *
 * 注意 `dataset` 与 `modelConfig` 必须在**同一次加载**里取，否则 `modelConfig` 用的是
 * 另一份 `dataset` 实例，这里装进去的数据表它看不见。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	dataset: './src/models/dataset',
	limits: './src/models/limits',
	remoteHints: './src/models/remoteHints',
	modelConfig: './src/models/modelConfig',
	tooltip: './src/models/tooltip',
});

const { parseModelDataset, installModelDataset, datasetKeysFor, matchModelDataset } = modules.dataset;
const { reconcileLimits, isSignificantlyDifferent, MIN_OUTPUT_TOKENS } = modules.limits;
const { extractRemoteHints } = modules.remoteHints;
const { resolveModelConfig, buildModelConfigs, deriveFamily } = modules.modelConfig;
const { buildModelTooltip, buildModelDetail } = modules.tooltip;

const logger = createLogger();

/** 合并三路信息时用到的设置项：只有这两个字段会被读到。 */
const settings = { defaultContextWindow: 32_000, defaultMaxOutputTokens: 8_192 };

/** 一条完整的数据表记录，测试里按需覆盖字段。 */
function entry(overrides = {}) {
	return {
		id: 'test-model',
		contextWindow: 64_000,
		maxOutputTokens: 4_096,
		imageInput: true,
		toolCalling: true,
		...overrides,
	};
}

/* -------------------------------------------------------------------------- */
/* 数据表解析                                                                  */
/* -------------------------------------------------------------------------- */

test('parseModelDataset：接受完整输出与裸数组两种形态', () => {
	const wrapped = parseModelDataset({ generatedAt: '2026-01-01T00:00:00Z', models: [entry()] });
	assert.equal(wrapped.entries.length, 1);
	assert.equal(wrapped.generatedAt, '2026-01-01T00:00:00Z');

	const bare = parseModelDataset([entry()]);
	assert.equal(bare.entries.length, 1);

	assert.deepEqual(parseModelDataset(undefined), { entries: [], skipped: 0, generatedAt: undefined, source: undefined });
	assert.deepEqual(parseModelDataset({ models: 'not an array' }).entries, []);
});

test('parseModelDataset：缺 id 或数值的条目被丢弃并计数', () => {
	const parsed = parseModelDataset([
		entry(),
		{ id: 'no-window', maxOutputTokens: 1_000 },
		{ id: 'no-output', contextWindow: 64_000 },
		{ contextWindow: 64_000, maxOutputTokens: 1_000 },
		'not an object',
	]);

	assert.equal(parsed.entries.length, 1);
	assert.equal(parsed.skipped, 4);
});

test('parseModelDataset：缺失的能力字段收敛成 false，思考能力保持「未知」', () => {
	const [parsed] = parseModelDataset([{ id: 'm', contextWindow: 64_000, maxOutputTokens: 1_000 }]).entries;

	assert.equal(parsed.imageInput, false);
	assert.equal(parsed.toolCalling, false);
	// 「未知」与「明确为 false」不同：只有数据表敢下否定结论
	assert.equal(parsed.reasoning, undefined);
	assert.equal(parsed.supportsReasoningEffort, undefined);
});

test('随包数据表能整份解析，且没有条目被丢弃', () => {
	// 这条断言守的是「生成脚本改了字段名而没人发现」——丢条目的数据表就是静默降级
	const raw = require(path.join(__dirname, '..', '..', 'data', 'openrouter-models.json'));
	const parsed = parseModelDataset(raw);

	assert.ok(parsed.entries.length > 0);
	assert.equal(parsed.skipped, 0);
});

/* -------------------------------------------------------------------------- */
/* 键生成与匹配                                                                */
/* -------------------------------------------------------------------------- */

test('datasetKeysFor：从精确到宽松逐层剥离，结果全小写且不重复', () => {
	const keys = datasetKeysFor('~openai/GPT-5:batch@official');

	// 原样（小写）→ 去掉厂商前缀 → 去掉变体后缀（连同其后的渠道后缀）
	assert.deepEqual(keys, ['~openai/gpt-5:batch@official', 'gpt-5:batch@official', 'gpt-5']);
});

test('datasetKeysFor：日期后缀最后剥', () => {
	assert.deepEqual(datasetKeysFor('claude-sonnet-4-20250514'), ['claude-sonnet-4-20250514', 'claude-sonnet-4']);
	assert.deepEqual(datasetKeysFor('gpt-5-2024-08-06'), ['gpt-5-2024-08-06', 'gpt-5']);
});

test('matchModelDataset：先精确后宽松，且大小写不敏感', () => {
	installModelDataset([
		entry({ id: 'claude-sonnet-4', contextWindow: 111 }),
		entry({ id: 'anthropic/claude-sonnet-4:free', contextWindow: 222 }),
	]);

	// 第一位键就命中（含厂商前缀与原样大小写）
	const exact = matchModelDataset('anthropic/claude-sonnet-4:free');
	assert.equal(exact.key, 'anthropic/claude-sonnet-4:free');
	assert.equal(exact.entry.id, 'anthropic/claude-sonnet-4:free');
	assert.equal(exact.entry.contextWindow, 222);

	// 剥掉后缀后命中更宽松的那条
	const loose = matchModelDataset('Anthropic/Claude-Sonnet-4:free@official');
	assert.equal(loose.key, 'claude-sonnet-4');
	assert.equal(loose.entry.contextWindow, 111);
});

test('matchModelDataset：没装载数据表时一律不命中', () => {
	// 空表意味着「退回网关 + 默认值」，而不是「继续沿用上一份数据」
	installModelDataset(undefined);
	assert.equal(matchModelDataset('claude-sonnet-4'), undefined);

	// 空数组、坏数据同样清空
	installModelDataset([]);
	assert.equal(matchModelDataset('claude-sonnet-4'), undefined);
});

test('installModelDataset：同 id 只保留第一条', () => {
	installModelDataset([
		entry({ id: 'dup', contextWindow: 1_000 }),
		entry({ id: 'DUP', contextWindow: 2_000 }),
	]);

	assert.equal(matchModelDataset('dup').entry.contextWindow, 1_000);
});

/* -------------------------------------------------------------------------- */
/* 数值校正                                                                    */
/* -------------------------------------------------------------------------- */

test('reconcileLimits：三路数值自洽时不做任何修正', () => {
	const result = reconcileLimits({ contextWindow: 128_000, maxOutputTokens: 8_192, maxInputTokens: undefined });

	assert.equal(result.contextWindow, 128_000);
	assert.equal(result.maxOutputTokens, 8_192);
	// 没给输入上限就取「窗口减去输出」
	assert.equal(result.maxInputTokens, 119_808);
	assert.deepEqual(result.adjustments, []);
});

test('reconcileLimits：窗口过小时抬到下限并记下原因', () => {
	const result = reconcileLimits({ contextWindow: 1_000, maxOutputTokens: 8_192, maxInputTokens: undefined });

	assert.equal(result.contextWindow, 2_048);
	assert.equal(result.maxInputTokens + result.maxOutputTokens, result.contextWindow);
	assert.ok(result.adjustments.length >= 1);
	assert.match(result.adjustments[0], /2048/);
});

test('reconcileLimits：输出上限挤占输入空间时被下调', () => {
	const result = reconcileLimits({ contextWindow: 10_000, maxOutputTokens: 9_000, maxInputTokens: undefined });

	// 至少给输入留 1/4 窗口
	assert.equal(result.maxOutputTokens, 7_500);
	assert.equal(result.maxInputTokens, 2_500);
	assert.match(result.adjustments.join(' '), /挤占/);
});

test('reconcileLimits：输出上限不低于 MIN_OUTPUT_TOKENS', () => {
	const result = reconcileLimits({ contextWindow: 2_048, maxOutputTokens: 1, maxInputTokens: undefined });
	assert.equal(result.maxOutputTokens, MIN_OUTPUT_TOKENS);
});

test('reconcileLimits：显式输入上限超窗口时收敛并说明', () => {
	const result = reconcileLimits({ contextWindow: 100_000, maxOutputTokens: 8_192, maxInputTokens: 99_000 });

	assert.equal(result.maxInputTokens, 91_808);
	assert.match(result.adjustments.join(' '), /冲突/);
});

test('reconcileLimits：不变量 maxInput + maxOutput <= contextWindow 恒成立', () => {
	const cases = [
		{ contextWindow: 2_000, maxOutputTokens: 100, maxInputTokens: undefined },
		{ contextWindow: 8_000, maxOutputTokens: 8_000, maxInputTokens: undefined },
		{ contextWindow: 200_000, maxOutputTokens: 64_000, maxInputTokens: 199_999 },
		{ contextWindow: 32_000, maxOutputTokens: 8_192, maxInputTokens: 1 },
		{ contextWindow: Number.NaN, maxOutputTokens: Number.NaN, maxInputTokens: undefined },
	];

	for (const input of cases) {
		const result = reconcileLimits(input);
		assert.ok(
			result.maxInputTokens + result.maxOutputTokens <= result.contextWindow,
			JSON.stringify(input),
		);
		assert.ok(result.maxInputTokens >= 1_024, JSON.stringify(input));
	}
});

test('isSignificantlyDifferent：10% 是分界线', () => {
	assert.equal(isSignificantlyDifferent(128_000, 131_072), false);
	assert.equal(isSignificantlyDifferent(100, 100), false);
	assert.equal(isSignificantlyDifferent(0, 0), false);
	// 恰好 10% 不算「显著」
	assert.equal(isSignificantlyDifferent(100, 90), false);
	// 略超 10% 就算
	assert.equal(isSignificantlyDifferent(100, 89), true);
	assert.equal(isSignificantlyDifferent(0, 100), true);
});

/* -------------------------------------------------------------------------- */
/* 网关字段提取                                                                */
/* -------------------------------------------------------------------------- */

test('extractRemoteHints：New API 只给 max_tokens 时不猜测上下文窗口', () => {
	const hints = extractRemoteHints({ id: 'gpt-4o', max_tokens: 16_384 });

	// 这个字段的语义含糊，宁可保守：当作输出上限，窗口留给数据表
	assert.equal(hints.maxOutputTokens, 16_384);
	assert.equal(hints.contextWindow, undefined);
});

test('extractRemoteHints：给出明确窗口时 max_tokens 被当作输出上限', () => {
	const hints = extractRemoteHints({ id: 'm', context_length: 128_000, max_tokens: 16_384 });

	assert.equal(hints.contextWindow, 128_000);
	assert.equal(hints.maxOutputTokens, 16_384);
	assert.equal(hints.maxInputTokens, undefined);
});

test('extractRemoteHints：明确输出上限优先于 max_tokens', () => {
	const hints = extractRemoteHints({ id: 'm', context_length: 128_000, max_tokens: 100, max_completion_tokens: 32_000 });

	assert.equal(hints.maxOutputTokens, 32_000);
});

test('extractRemoteHints：只有输入与输出上限时窗口取两者之和', () => {
	const hints = extractRemoteHints({ id: 'm', max_input_tokens: 120_000, max_output_tokens: 8_000 });
	assert.equal(hints.contextWindow, 128_000);
});

test('extractRemoteHints：认得 vLLM 与 OpenRouter 的字段名', () => {
	const vllm = extractRemoteHints({ id: 'm', max_model_len: 32_768 });
	assert.equal(vllm.contextWindow, 32_768);

	const openrouter = extractRemoteHints({
		id: 'm',
		context_length: 200_000,
		top_provider: { max_completion_tokens: 8_000 },
		architecture: { input_modalities: ['text', 'image'] },
		supported_parameters: ['tools', 'reasoning'],
		display_name: 'Claude Sonnet',
	});
	assert.equal(openrouter.maxOutputTokens, 8_000);
	assert.equal(openrouter.imageInput, true);
	assert.equal(openrouter.toolCalling, true);
	assert.equal(openrouter.reasoning, true);
	assert.equal(openrouter.displayName, 'Claude Sonnet');
});

test('extractRemoteHints：思考能力只认「肯定」，不因为没列出就否定', () => {
	// New API 的 /v1/models 完全不返回 supported_parameters
	assert.equal(extractRemoteHints({ id: 'm', max_tokens: 1_000 }).reasoning, undefined);
	// 列出了参数但没有推理相关的
	assert.equal(extractRemoteHints({ id: 'm', supported_parameters: ['tools'] }).reasoning, undefined);
	// 明确声明
	assert.equal(extractRemoteHints({ id: 'm', supported_parameters: ['reasoning_effort'] }).reasoning, true);
	assert.equal(extractRemoteHints({ id: 'm', capabilities: { reasoning: true } }).reasoning, true);
});

test('extractRemoteHints：工具调用支持从参数列表与能力对象两条路取', () => {
	assert.equal(extractRemoteHints({ id: 'm', supported_parameters: ['tools'] }).toolCalling, true);
	assert.equal(extractRemoteHints({ id: 'm', supported_parameters: ['foo'] }).toolCalling, false);
	assert.equal(extractRemoteHints({ id: 'm', capabilities: { tool_calling: true } }).toolCalling, true);
	assert.equal(extractRemoteHints({ id: 'm', supports_tools: false }).toolCalling, false);
	// 无法判定时留空，交给数据表
	assert.equal(extractRemoteHints({ id: 'm' }).toolCalling, undefined);
});

test('extractRemoteHints：图片输入从模态列表或若干布尔字段取', () => {
	assert.equal(extractRemoteHints({ id: 'm', input_modalities: ['text', 'image'] }).imageInput, true);
	assert.equal(extractRemoteHints({ id: 'm', modalities: ['text'] }).imageInput, false);
	assert.equal(extractRemoteHints({ id: 'm', capabilities: { vision: true } }).imageInput, true);
	assert.equal(extractRemoteHints({ id: 'm' }).imageInput, undefined);
});

test('extractRemoteHints：展示名与 id 相同时丢掉，免得 tooltip 重复', () => {
	assert.equal(extractRemoteHints({ id: 'm', display_name: 'm' }).displayName, undefined);
	assert.equal(extractRemoteHints({ id: 'm', display_name: '好看的名字' }).displayName, '好看的名字');
});

/* -------------------------------------------------------------------------- */
/* family 推断                                                                 */
/* -------------------------------------------------------------------------- */

test('deriveFamily：按「日期 → 语义后缀 → 版本号」的顺序剥离', () => {
	const cases = [
		['gpt-5', 'gpt-5'],
		['GPT-5', 'gpt-5'],
		['claude-sonnet-4-20250514', 'claude-sonnet-4'],
		['gpt-4o-2024-08-06', 'gpt-4o'],
		['claude-3-5-sonnet-latest', 'claude-3-5-sonnet'],
		['deepseek-chat@official', 'deepseek-chat'],
		['claude-3-v1.2', 'claude-3'],
		['gpt-5v1', 'gpt-5v1'],
		// 语义后缀在日期之前剥，因此剥完还剩一个日期后缀
		['gpt-5-2024-08-06-thinking', 'gpt-5-2024-08-06'],
	];

	for (const [input, expected] of cases) {
		assert.equal(deriveFamily(input), expected, input);
	}
});

/* -------------------------------------------------------------------------- */
/* 三路信息合并                                                                */
/* -------------------------------------------------------------------------- */

test('resolveModelConfig：数据表命中时字段来源标为 dataset', () => {
	installModelDataset([
		entry({
			reasoning: true,
			supportsReasoningEffort: ['high', 'low'],
			defaultReasoningEffort: 'low',
			vendor: 'Acme',
			displayName: '测试模型',
		}),
	]);

	const config = resolveModelConfig({ id: 'test-model' }, { settings, logger });

	assert.equal(config.contextWindow, 64_000);
	assert.equal(config.maxOutputTokens, 4_096);
	assert.equal(config.maxInputTokens, 59_904);
	assert.equal(config.imageInput, true);
	assert.equal(config.toolCalling, true);
	assert.equal(config.reasoning, true);
	assert.equal(config.name, '测试模型');
	assert.equal(config.family, 'test-model');
	assert.equal(config.version, '1');
	assert.deepEqual(config.reasoningEfforts, ['high', 'low']);
	assert.equal(config.defaultReasoningEffort, 'low');
	assert.equal(config.meta.datasetKey, 'test-model');
	assert.equal(config.meta.vendor, 'Acme');
	assert.equal(config.meta.provenance.contextWindow, 'dataset');
	assert.equal(config.meta.provenance.maxOutputTokens, 'dataset');
	assert.equal(config.meta.provenance.reasoning, 'dataset');
});

test('resolveModelConfig：网关值覆盖数据表并记进日志', () => {
	installModelDataset([entry({ reasoning: true })]);
	const localLogger = createLogger();

	const config = resolveModelConfig(
		{ id: 'test-model', context_length: 200_000, max_completion_tokens: 16_000, supported_parameters: ['tools'] },
		{ settings, logger: localLogger },
	);

	assert.equal(config.contextWindow, 200_000);
	assert.equal(config.maxOutputTokens, 16_000);
	assert.equal(config.meta.provenance.contextWindow, 'remote');
	assert.equal(config.meta.provenance.maxOutputTokens, 'remote');
	assert.equal(config.meta.provenance.toolCalling, 'remote');
	// 数值被网关改过必须有出口，否则用户碰到「站点明明支持更大窗口」无从排查
	assert.ok(localLogger.messages('debug').some(line => /不一致/.test(line)));
});

test('resolveModelConfig：网关说支持思考时就采用，即使数据表没写', () => {
	installModelDataset([entry({ supportsReasoningEffort: ['high'] })]);

	const config = resolveModelConfig(
		{ id: 'test-model', supported_parameters: ['reasoning'] },
		{ settings, logger },
	);

	assert.equal(config.reasoning, true);
	assert.equal(config.meta.provenance.reasoning, 'remote');
});

test('resolveModelConfig：数据表没写思考强度时不去编造档位', () => {
	installModelDataset([entry({ reasoning: true })]);

	const config = resolveModelConfig({ id: 'test-model' }, { settings, logger });

	assert.equal(config.reasoning, true);
	assert.deepEqual(config.reasoningEfforts, []);
	assert.equal(config.defaultReasoningEffort, undefined);
});

test('resolveModelConfig：默认档位不在可选档位里时丢弃', () => {
	installModelDataset([entry({ supportsReasoningEffort: ['high'], defaultReasoningEffort: 'low' })]);

	assert.equal(resolveModelConfig({ id: 'test-model' }, { settings, logger }).defaultReasoningEffort, undefined);
});

test('resolveModelConfig：完全没信息时给一份保守但可用的配置', () => {
	installModelDataset([]);

	const config = resolveModelConfig({ id: 'unknown-model' }, { settings, logger });

	assert.equal(config.contextWindow, 32_000);
	assert.equal(config.maxOutputTokens, 8_192);
	assert.equal(config.maxInputTokens, 23_808);
	assert.equal(config.reasoning, false);
	assert.equal(config.imageInput, false);
	assert.equal(config.toolCalling, false);
	assert.equal(config.name, 'unknown-model');
	assert.equal(config.meta.provenance.contextWindow, 'default');
	assert.equal(config.tooltip.length > 0, true);
});

test('resolveModelConfig：网关给的 displayName / family / version 优先', () => {
	installModelDataset([]);

	const config = resolveModelConfig(
		{ id: 'vendor/model-x', display_name: 'Model X', family: 'modelx', version: '2026-01', owned_by: 'vendor' },
		{ settings, logger },
	);

	assert.equal(config.name, 'Model X');
	assert.equal(config.family, 'modelx');
	assert.equal(config.version, '2026-01');
	assert.equal(config.meta.ownedBy, 'vendor');
});

test('buildModelConfigs：缺 id 的条目只计数，不影响其余模型', () => {
	installModelDataset([]);

	const result = buildModelConfigs(
		[{ id: 'a' }, { id: '   ' }, { id: undefined }, { id: 'b' }],
		{ settings, logger },
	);

	assert.deepEqual(result.configs.map(config => config.id), ['a', 'b']);
	assert.equal(result.invalidCount, 2);
});

test('buildModelConfigs：字段乱七八糟的模型也能构建出配置', () => {
	installModelDataset([]);

	const result = buildModelConfigs(
		[{ id: 'weird', context_length: 'not a number', capabilities: 'nope', supported_parameters: 42 }],
		{ settings, logger },
	);

	assert.equal(result.invalidCount, 0);
	assert.equal(result.configs.length, 1);
	assert.equal(result.configs[0].contextWindow, 32_000);
});

/* -------------------------------------------------------------------------- */
/* tooltip 与副标题                                                            */
/* -------------------------------------------------------------------------- */

const facts = {
	id: 'anthropic/claude-sonnet-4',
	vendor: 'Anthropic',
	contextWindow: 200_000,
	maxInputTokens: 192_000,
	maxOutputTokens: 8_000,
	imageInput: true,
	toolCalling: true,
	reasoning: false,
};

test('buildModelTooltip：首行是身份行，用等宽字体带出真实 ID', () => {
	const lines = buildModelTooltip(facts).split('\n');

	assert.match(lines[0], /`anthropic\/claude-sonnet-4`/);
	assert.match(lines[0], /Anthropic/);
});

test('buildModelTooltip：六行事实，取值列对齐', () => {
	const lines = buildModelTooltip(facts).split('\n');
	// 首行身份 + 每行事实前空行（Markdown 段落才真的换行）
	const factLines = lines.filter(line => line.length > 0).slice(1);

	assert.equal(factLines.length, 6);

	const labels = [];
	for (const line of factLines) {
		const characters = [...line];
		// 标签最长 5 个字，补齐后固定在第 6 列（全角空格）之后开始取值
		assert.equal(characters[5], '\u3000', line);
		const value = characters.slice(6).join('');
		assert.ok(value.length > 0, line);
		labels.push(characters.slice(0, 5).join('').trim());
	}

	assert.deepEqual(labels, ['输入上限', '上下文窗口', '最大输出', '图片输入', '工具调用', '思考']);
});

test('buildModelTooltip：布尔项用同一对符号', () => {
	const lines = buildModelTooltip(facts).split('\n').filter(line => line.length > 0).slice(1);
	const values = lines.map(line => [...line].slice(6).join(''));

	assert.deepEqual(values.slice(3), ['✅', '✅', '❌']);
});

test('buildModelDetail：厂商优先于 owned_by，工具能力追加一个词', () => {
	const withVendor = buildModelDetail({ vendor: 'Anthropic', ownedBy: 'acme', contextWindow: 200_000, toolCalling: true });
	assert.match(withVendor, /Anthropic/);
	assert.doesNotMatch(withVendor, /acme/);
	assert.match(withVendor, /工具/);

	const fallback = buildModelDetail({ ownedBy: 'acme', contextWindow: 8_000, toolCalling: false });
	assert.match(fallback, /acme/);
	assert.doesNotMatch(fallback, /工具/);
});
