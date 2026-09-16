/**
 * 模型配置（模型选择器里的「思考强度」）的测试。
 *
 * 这里覆盖的都是纯函数：schema 生成、取值解析、写进请求体。
 * VS Code 如何渲染控件、何时回传取值属于宿主行为，不在单测范围内。
 */

import * as assert from 'assert';
import {
	DEFAULT_REASONING_EFFORT_FIELD,
	PROTECTED_REQUEST_KEYS,
	REASONING_EFFORT_KEY,
} from '../consts';
import type { ModelDatasetEntry } from '../models/dataset';
import type { ModelConfig } from '../models/modelConfig';
import { resolveModelConfig } from '../models/modelConfig';
import {
	applyReasoningEffort,
	buildModelConfigurationSchema,
	readModelConfiguration,
	selectReasoningEffort,
} from '../provider/modelConfiguration';
import type { ChatCompletionRequest } from '../types';
import { createModel, createSettings, datasetEntry, installTestDataset, testLogger } from './helpers';

/**
 * 造一份模型配置。
 *
 * 能力位与档位都来自数据表，因此这里直接装一条测试条目——与真实运行时的载入效果一致。
 * 默认给一组合适的档位；想看「数据表没给档位」的效果就显式传 `supportsReasoningEffort: undefined`。
 */
function configFor(id: string, entry: Partial<ModelDatasetEntry> = {}): ModelConfig {
	installTestDataset([datasetEntry(id, {
		reasoning: true,
		supportsReasoningEffort: ['low', 'medium', 'high'],
		...entry,
	})]);
	return resolveModelConfig(createModel(id), {
		settings: createSettings(),
		logger: testLogger(),
	});
}

/** 一份「数据表里没有、也不支持思考」的模型配置。 */
function plainConfigFor(id: string): ModelConfig {
	installTestDataset([]);
	return resolveModelConfig(createModel(id), {
		settings: createSettings(),
		logger: testLogger(),
	});
}

/** 各用例都会安装数据表，跑完恢复原状。 */
teardown(() => installTestDataset([]));

suite('provider / 模型配置 schema', () => {
	test('不支持思考的模型不声明 schema', () => {
		assert.strictEqual(buildModelConfigurationSchema(plainConfigFor('plain-model')), undefined);
	});

	test('不会思考就不能调强度：数据表没给档位时不声明 schema', () => {
		// 上游实测有 141 条只有 mandatory / default_enabled —— 这些模型会思考，
		// 但我们并不知道站点能接受哪些档位。此时宁可不显示控件，也不凭空造一组合适的值。
		const config = configFor('no-efforts', { supportsReasoningEffort: undefined });
		assert.strictEqual(config.reasoning, true, '这个模型确实支持思考');
		assert.deepStrictEqual(config.reasoningEfforts, []);
		assert.strictEqual(buildModelConfigurationSchema(config), undefined);
	});

	test('支持思考且有档位时声明思考强度选项', () => {
		const schema = buildModelConfigurationSchema(configFor('deepseek-reasoner'));
		const property = schema?.properties[REASONING_EFFORT_KEY];
		assert.ok(property !== undefined, '应声明思考强度属性');
		// VS Code 只渲染带 enum 的属性
		assert.deepStrictEqual(property.enum, ['low', 'medium', 'high']);
		// group 决定控件出现在模型卡片的哪一区
		assert.strictEqual(property.group, 'navigation');
		assert.strictEqual(property.type, 'string');
	});

	test('用该模型的默认档位作为 default，控件因此预选它', () => {
		const config = configFor('knows-default', {
			supportsReasoningEffort: ['max', 'high', 'low'],
			defaultReasoningEffort: 'high',
		});
		const property = buildModelConfigurationSchema(config)?.properties[REASONING_EFFORT_KEY];
		assert.strictEqual(property?.default, 'high');
		// 预选项必须在候选项里，否则 VS Code 会选中一个不存在的档位
		assert.ok(property?.enum?.includes('high'));
	});

	test('没有默认档位时不声明 default（控件保持空选中）', () => {
		const property = buildModelConfigurationSchema(configFor('deepseek-reasoner'))?.properties[REASONING_EFFORT_KEY];
		assert.ok(property !== undefined);
		assert.ok(!('default' in property), '不应编造一个默认值');
	});

	test('默认档位不在可选列表里时被丢弃', () => {
		// 数据表是生成产物，理论上不会出现这种组合（生成侧与载入侧都有断言），
		// 但手工准备的数据表可能。与其让控件预选一个不存在的值，不如当作没有默认。
		const config = configFor('mismatch', {
			supportsReasoningEffort: ['low', 'high'],
			defaultReasoningEffort: 'turbo',
		});
		assert.strictEqual(config.defaultReasoningEffort, undefined);
		assert.ok(!('default' in (buildModelConfigurationSchema(config)?.properties[REASONING_EFFORT_KEY] ?? {})));
	});

	test('选项直接用原值，不做标签或逐项说明', () => {
		// 上游词汇就是站点文档里的写法，自己翻译一套只会在出现新档位时露出马脚
		const property = buildModelConfigurationSchema(configFor('deepseek-reasoner'))?.properties[REASONING_EFFORT_KEY];
		assert.deepStrictEqual(Object.keys(property ?? {}).sort(), ['description', 'enum', 'group', 'title', 'type']);
	});

	test('候选项就是该模型的强度列表', () => {
		const property = buildModelConfigurationSchema(configFor('deepseek-reasoner'))?.properties[REASONING_EFFORT_KEY];
		assert.deepStrictEqual(property?.enum, ['low', 'medium', 'high']);
	});

	test('候选项用模型自己的强度列表', () => {
		// 上游词汇比任何固定的三档都宽（实测有 max / xhigh / minimal / none），
		// 因此界面上的档位完全是逐模型的
		const config = configFor('wide', {
			supportsReasoningEffort: ['max', 'xhigh', 'high', 'low'],
			defaultReasoningEffort: 'high',
		});
		const property = buildModelConfigurationSchema(config)?.properties[REASONING_EFFORT_KEY];
		assert.deepStrictEqual(property?.enum, ['max', 'xhigh', 'high', 'low']);
	});

	test('属性说明与预选项一致', () => {
		const withDefault = configFor('knows-default', { defaultReasoningEffort: 'medium' });
		const without = configFor('no-default');
		const described = buildModelConfigurationSchema(withDefault)?.properties[REASONING_EFFORT_KEY]
			?.description ?? '';
		const plain = buildModelConfigurationSchema(without)?.properties[REASONING_EFFORT_KEY]
			?.description ?? '';

		assert.ok(described.includes('medium'), `应说明默认强度，实际：${described}`);
		// 不知道默认强度时不能编造
		assert.ok(!plain.includes('默认'), `不应编造默认强度，实际：${plain}`);
	});
});

suite('provider / 模型配置解析', () => {
	const config = configFor('deepseek-reasoner');

	test('未选择时不发送任何字段', () => {
		// 模型选择器里没有任何选中项时，VS Code 不会带上 modelConfiguration
		assert.deepStrictEqual(selectReasoningEffort({}, config), {});
		assert.deepStrictEqual(selectReasoningEffort({ modelConfiguration: {} }, config), {});
	});

	test('用户选定后取值生效', () => {
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } };
		assert.strictEqual(selectReasoningEffort(options, config).effort, 'high');
	});

	test('选中的就是该模型的默认档位时不发送', () => {
		// 控件会预选 defaultReasoningEffort（schema 的 default 会被 VS Code 带进每次请求），
		// 所以「保持默认」是最常见的状态。那个值本来就是站点在用的，没必要显式发出去。
		const withDefault = configFor('knows-default', {
			supportsReasoningEffort: ['low', 'medium', 'high'],
			defaultReasoningEffort: 'medium',
		});
		assert.deepStrictEqual(
			selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'medium' } }, withDefault),
			{},
		);
		// 改成别的档位才发
		assert.strictEqual(
			selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } }, withDefault).effort,
			'high',
		);
	});

	test('没有默认档位信息时，任何选中值都照发', () => {
		// 数据表没给默认档位时控件是空选中，用户选什么就是明确的意图
		const noDefault = configFor('no-default', {
			supportsReasoningEffort: ['low', 'medium', 'high'],
		});
		assert.strictEqual(noDefault.defaultReasoningEffort, undefined);
		assert.strictEqual(
			selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'medium' } }, noDefault).effort,
			'medium',
		);
	});

	test('不在可选列表里的取值被忽略并说明原因', () => {
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'turbo' } };
		const selection = selectReasoningEffort(options, config);
		assert.strictEqual(selection.effort, undefined);
		assert.ok(selection.ignored?.includes('turbo'), '应能解释为什么没生效');
	});

	test('模型自己的列表生效：任何档位都按列表判断', () => {
		const wide = configFor('wide', { supportsReasoningEffort: ['max', 'high'] });
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'max' } };
		assert.strictEqual(selectReasoningEffort(options, wide).effort, 'max');
	});

	test('不在该模型列表里的取值被拒绝', () => {
		// 窄模型只给自己支持的档位，选到别的档位应当被拦下并记名
		const narrow = configFor('narrow', { supportsReasoningEffort: ['high'] });
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'low' } };
		const selection = selectReasoningEffort(options, narrow);
		assert.strictEqual(selection.effort, undefined);
		assert.ok(selection.ignored?.includes('high'), '应把可选取值告诉调用方');
	});

	test('数据表没给档位时即使带着取值也不会发出去', () => {
		// 界面上不可能选，但设置里可能残留；没有列表就没有可校验的取值
		const noEfforts = configFor('no-efforts', { supportsReasoningEffort: undefined });
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } };
		assert.deepStrictEqual(selectReasoningEffort(options, noEfforts), {});
	});

	test('不支持思考的模型即使带着取值也不会发出去', () => {
		const plain = plainConfigFor('plain');
		const options = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } };
		assert.deepStrictEqual(selectReasoningEffort(options, plain), {});
	});

	test('调用方通过 modelOptions 显式传入的取值优先', () => {
		const options = {
			modelConfiguration: { [REASONING_EFFORT_KEY]: 'low' },
			modelOptions: { [REASONING_EFFORT_KEY]: 'high' },
		};
		assert.strictEqual(selectReasoningEffort(options, config).effort, 'high');
	});

	test('读取模型配置时容忍各种脏输入', () => {
		assert.strictEqual(readModelConfiguration(undefined), undefined);
		assert.strictEqual(readModelConfiguration('nope'), undefined);
		assert.deepStrictEqual(readModelConfiguration({ modelConfiguration: { a: 1 } }), { a: 1 });
		// 非对象一律视为没给，而不是抛异常
		assert.strictEqual(readModelConfiguration({ modelConfiguration: [] }), undefined);
	});
});

suite('provider / 思考强度写进请求体', () => {
	const request = (): ChatCompletionRequest => ({ model: 'm', messages: [] });

	test('字段名不是协议字段', () => {
		// 常量写错会直接盖掉请求骨架（例如把 messages 覆盖成字符串），因此固定断言一下
		assert.strictEqual(DEFAULT_REASONING_EFFORT_FIELD, 'reasoning_effort');
		assert.ok(!PROTECTED_REQUEST_KEYS.has(DEFAULT_REASONING_EFFORT_FIELD));
	});

	test('写入声明的字段名', () => {
		const body = request();
		applyReasoningEffort(body, 'high');
		assert.strictEqual(body[DEFAULT_REASONING_EFFORT_FIELD], 'high');
	});

	test('盖过额外字段里的同名字段', () => {
		// 模型选择器里的选择比 `request.extraBody` 更具体，因此以选择为准
		const body = request();
		body[DEFAULT_REASONING_EFFORT_FIELD] = 'low';
		applyReasoningEffort(body, 'high');
		assert.strictEqual(body[DEFAULT_REASONING_EFFORT_FIELD], 'high');
	});
});
