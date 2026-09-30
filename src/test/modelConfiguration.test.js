'use strict';

/**
 * provider/modelConfiguration.ts：模型选择器里的「思考强度」控件。
 *
 * 这里的坑都在「什么时候不该发」上：控件会预选默认档位，因此最常见的状态是「保持默认」，
 * 那不该改变线上行为。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { modules } = load({
	modelConfiguration: './src/provider/modelConfiguration',
	consts: './src/consts',
});

const {
	buildModelConfigurationSchema,
	readModelConfiguration,
	selectReasoningEffort,
	applyReasoningEffort,
} = modules.modelConfiguration;
const { REASONING_EFFORT_KEY, DEFAULT_REASONING_EFFORT_FIELD } = modules.consts;

/** 造一个模型配置：只有思考相关的字段会被这里读到。 */
function model(overrides = {}) {
	return {
		id: 'deepseek-reasoner',
		reasoning: true,
		reasoningEfforts: ['high', 'low'],
		...overrides,
	};
}

/** 取 schema 里那唯一一个属性。 */
function propertyOf(schema) {
	return schema.properties[REASONING_EFFORT_KEY];
}

/* -------------------------------------------------------------------------- */

test('buildModelConfigurationSchema：不支持思考的模型不声明控件', () => {
	assert.equal(buildModelConfigurationSchema(model({ reasoning: false })), undefined);
	// 会思考但站点没给出档位：没有可选项可言
	assert.equal(buildModelConfigurationSchema(model({ reasoningEfforts: [] })), undefined);
});

test('buildModelConfigurationSchema：档位就是数据表里的原值，顺序不变', () => {
	const schema = buildModelConfigurationSchema(model());

	assert.deepEqual(propertyOf(schema).enum, ['high', 'low']);
	// 控件必须落在模型卡片的主控件区
	assert.equal(propertyOf(schema).group, 'navigation');
	assert.equal(propertyOf(schema).type, 'string');
});

test('buildModelConfigurationSchema：有默认档位时才声明 default', () => {
	const withDefault = buildModelConfigurationSchema(model({ defaultReasoningEffort: 'low' }));
	assert.equal(propertyOf(withDefault).default, 'low');
	assert.match(propertyOf(withDefault).description, /默认 low/);

	// 没有默认档位就不声明，控件保持空选中，而不是编造一个值
	const withoutDefault = buildModelConfigurationSchema(model());
	assert.equal('default' in propertyOf(withoutDefault), false);
	assert.doesNotMatch(propertyOf(withoutDefault).description, /默认/);
});

test('buildModelConfigurationSchema：说明文字里有真正会发出去的字段名', () => {
	const schema = buildModelConfigurationSchema(model());
	assert.match(propertyOf(schema).description, new RegExp(DEFAULT_REASONING_EFFORT_FIELD));
	assert.match(propertyOf(schema).description, /deepseek-reasoner/);
});

/* -------------------------------------------------------------------------- */

test('readModelConfiguration：界面选择与显式选项都能读到，后者优先', () => {
	assert.equal(readModelConfiguration(undefined), undefined);
	assert.equal(readModelConfiguration('not an object'), undefined);
	assert.equal(readModelConfiguration({}), undefined);

	const stored = { modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } };
	assert.deepEqual(readModelConfiguration(stored), { [REASONING_EFFORT_KEY]: 'high' });

	// 通过扩展 API 直接调用模型的调用方显式传入的选项优先级更高
	const both = {
		modelConfiguration: { [REASONING_EFFORT_KEY]: 'high', other: 1 },
		modelOptions: { [REASONING_EFFORT_KEY]: 'low' },
	};
	assert.deepEqual(readModelConfiguration(both), { [REASONING_EFFORT_KEY]: 'low', other: 1 });
});

/* -------------------------------------------------------------------------- */

test('selectReasoningEffort：不支持思考或没有档位时一律不发', () => {
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } }, model({ reasoning: false })), {});
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } }, model({ reasoningEfforts: [] })), {});
});

test('selectReasoningEffort：用户没选过时不发', () => {
	assert.deepEqual(selectReasoningEffort(undefined, model()), {});
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: {} }, model()), {});
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: '   ' } }, model()), {});
});

test('selectReasoningEffort：选中的就是默认档位时不发', () => {
	const config = model({ defaultReasoningEffort: 'low' });

	// 控件预选默认档位，「保持默认」是最常见的状态，它不该给每个请求多带一个字段
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'low' } }, config), {});
	// 用户真的改了档位才发
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'high' } }, config), { effort: 'high' });
});

test('selectReasoningEffort：非法取值被忽略并说明原因', () => {
	const selection = selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'ultra' } }, model());

	assert.equal(selection.effort, undefined);
	assert.match(selection.ignored, /ultra/);
	// 说明里要带上合法取值，否则用户不知道该改成什么
	assert.match(selection.ignored, /high \/ low/);
});

test('selectReasoningEffort：没有默认档位时，选中任一台档位都会发出去', () => {
	assert.deepEqual(selectReasoningEffort({ modelConfiguration: { [REASONING_EFFORT_KEY]: 'low' } }, model()), { effort: 'low' });
});

/* -------------------------------------------------------------------------- */

test('applyReasoningEffort：写进请求体的字段名与线上协议一致', () => {
	const request = { model: 'm', messages: [] };

	applyReasoningEffort(request, 'high');

	assert.equal(request[DEFAULT_REASONING_EFFORT_FIELD], 'high');
	// 协议骨架不受影响
	assert.equal(request.model, 'm');
});

test('applyReasoningEffort：模型选择器的选择盖过 extraBody 里的同名字段', () => {
	const request = { messages: [], [DEFAULT_REASONING_EFFORT_FIELD]: 'low' };

	applyReasoningEffort(request, 'high');

	assert.equal(request[DEFAULT_REASONING_EFFORT_FIELD], 'high');
});
