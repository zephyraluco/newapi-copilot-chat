'use strict';

/**
 * adapter 层：适配器选择、请求改写的判据、请求种类识别。
 *
 * 这一层不 import `vscode`，因此不需要替身——直接加载即可。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	defaultAdapter: './src/adapter/defaultAdapter',
	registry: './src/adapter/registry',
	deepseek: './src/adapter/deepseek/deepseekAdapter',
	requestKind: './src/adapter/deepseek/requestKind',
	gpt6: './src/adapter/openai/gpt6ChatAdapter',
});

const { DefaultModelAdapter } = modules.defaultAdapter;
const { AdapterRegistry, createDefaultAdapterRegistry } = modules.registry;
const { DeepSeekAdapter, isDeepSeekModel, THINKING_FIELD } = modules.deepseek;
const { classifyRequest, shouldDisableThinking } = modules.requestKind;
const { Gpt6ChatAdapter } = modules.gpt6;

/** 造一个够用的模型配置：只有 `id` 与 `meta.vendor` 会被适配器读。 */
function model(id, vendor) {
	return { id, meta: vendor === undefined ? {} : { vendor }, reasoning: false };
}

/* -------------------------------------------------------------------------- */
/* 请求种类识别                                                                */
/* -------------------------------------------------------------------------- */

const MAIN_AGENT_PROMPT = 'You are an expert AI programming assistant, working with a user in the VS Code editor.';

/** 造一个上游请求体：首条消息是系统提示词。 */
function requestOf(firstText, extra = {}) {
	return {
		messages: [{ role: 'user', content: firstText }],
		...extra,
	};
}

test('classifyRequest：主对话靠系统提示词前缀或 <skills> 标记识别', () => {
	assert.equal(classifyRequest(requestOf(MAIN_AGENT_PROMPT)), 'main-agent');
	assert.equal(classifyRequest(requestOf('<skills>…</skills>\n用户消息')), 'main-agent');
	assert.equal(classifyRequest(requestOf('<agents>…</agents>')), 'main-agent');
});

test('classifyRequest：各类辅助请求按前缀归位', () => {
	const cases = [
		['You are a background task tracker for managing todo lists', 'todo-tracker'],
		['You are an expert classifier for AI coding assistant prompts', 'prompt-categorizer'],
		['You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings', 'settings-resolver'],
		['You are an expert in crafting ultra-compact titles', 'chat-title'],
		['You are an expert in crafting pithy titles for chat sessions', 'chat-title'],
		['You are an expert in writing short, catchy, and encouraging progress messages', 'inline-progress-message'],
		['You are an expert in crafting pithy branch names for git branches', 'git-branch-name'],
		['You are an AI programming assistant, helping a software developer to come with the best git commit message', 'git-commit-message'],
		['You are a distinguished software engineer', 'rename-suggestions'],
	];

	for (const [prompt, expected] of cases) {
		assert.equal(classifyRequest(requestOf(prompt)), expected, prompt.slice(0, 40));
	}
});

test('classifyRequest：只带一个内部工具时按工具名判定，与提示词无关', () => {
	const tools = name => [{ type: 'function', function: { name } }];

	assert.equal(classifyRequest({ messages: [], tools: tools('manage_todo_list') }), 'todo-tracker');
	assert.equal(classifyRequest({ messages: [], tools: tools('categorize_prompt') }), 'prompt-categorizer');

	// 「只有这一个」是必要条件：多了别的工具就可能是真的对话
	const withExtra = tools('manage_todo_list').concat(tools('read_file'));
	assert.notEqual(classifyRequest({ messages: [], tools: withExtra }), 'todo-tracker');
});

test('classifyRequest：终端补充说明看的是最后一条用户消息，不是提示词', () => {
	const request = {
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{ role: 'assistant', content: '正在运行测试' },
			{ role: 'user', content: '[Terminal 12345 notification: command completed with exit code 0]' },
		],
	};
	assert.equal(classifyRequest(request), 'terminal-steering');
});

test('classifyRequest：认不出来时退化，而不是失败', () => {
	// 有内容但认不出：普通后台请求，适配器不做任何改写
	assert.equal(classifyRequest(requestOf('帮我写一个函数')), 'background');
	// 有工具但认不出：同上
	assert.equal(classifyRequest({ messages: [], tools: [{ type: 'function', function: { name: 'read_file' } }] }), 'background');
	// 完全空：unknown
	assert.equal(classifyRequest({ messages: [] }), 'unknown');
});

test('classifyRequest：内容为数组时取其中的文本片段', () => {
	const request = {
		messages: [
			{
				role: 'user',
				content: [
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
					{ type: 'text', text: MAIN_AGENT_PROMPT },
				],
			},
		],
	};
	assert.equal(classifyRequest(request), 'main-agent');
});

test('shouldDisableThinking：只对「产出是一行短文本」的辅助请求为真', () => {
	const disabled = [
		'todo-tracker',
		'prompt-categorizer',
		'settings-resolver',
		'chat-title',
		'inline-progress-message',
		'git-branch-name',
		'git-commit-message',
		'rename-suggestions',
	];
	for (const kind of disabled) {
		assert.equal(shouldDisableThinking(kind), true, kind);
	}
	// 主对话、终端补充说明、认不出的请求都保留思考
	for (const kind of ['main-agent', 'terminal-steering', 'background', 'unknown']) {
		assert.equal(shouldDisableThinking(kind), false, kind);
	}
});

/* -------------------------------------------------------------------------- */
/* 适配器注册表                                                                */
/* -------------------------------------------------------------------------- */

const silentLogger = createLogger();

test('AdapterRegistry：重复 id 被忽略并留下警告', () => {
	const registry = new AdapterRegistry();
	const logger = createLogger();
	registry.register(new DeepSeekAdapter(), logger);
	registry.register(new DeepSeekAdapter(), logger);

	assert.equal(registry.list().length, 1);
	assert.equal(logger.messages('warn').length, 1);
	assert.match(logger.messages('warn')[0], /deepseek/);
});

test('AdapterRegistry：resolve 取第一个匹配项，高优先级排在前面', () => {
	const registry = new AdapterRegistry();
	const low = { id: 'low', priority: 1, supports: () => true, transformRequest: request => request };
	const high = { id: 'high', priority: 10, supports: () => true, transformRequest: request => request };
	const never = { id: 'never', priority: 100, supports: () => false, transformRequest: request => request };

	// 注册顺序与优先级顺序相反，用来确认排序真的生效
	registry.register(low, silentLogger);
	registry.register(never, silentLogger);
	registry.register(high, silentLogger);

	assert.equal(registry.resolve(model('anything')).id, 'high');
	assert.deepEqual(registry.list().map(adapter => adapter.id), ['never', 'high', 'low']);
});

test('AdapterRegistry：没有匹配项时兜底到默认适配器', () => {
	const registry = new AdapterRegistry();
	registry.register({ id: 'picky', priority: 1, supports: () => false, transformRequest: request => request }, silentLogger);

	assert.equal(registry.resolve(model('anything')).id, 'default');
});

test('内置注册表：顺序为 [专门适配器…, 兜底] 且能按模型 ID 选中', () => {
	const registry = createDefaultAdapterRegistry(silentLogger);

	assert.deepEqual(registry.list().map(adapter => adapter.id), ['deepseek', 'gpt6-chat', 'gpt61-chat', 'default']);

	assert.equal(registry.resolve(model('deepseek-chat')).id, 'deepseek');
	assert.equal(registry.resolve(model('gpt-6-sol')).id, 'gpt6-chat');
	assert.equal(registry.resolve(model('gpt-6.1-sol')).id, 'gpt61-chat');
	// 谁都不认的模型落到兜底
	assert.equal(registry.resolve(model('gpt-4o')).id, 'default');
});

test('DefaultModelAdapter：承接所有模型，且刻意不实现 transformRequest', () => {
	const adapter = new DefaultModelAdapter();

	assert.equal(adapter.supports(model('任意模型')), true);
	assert.equal(adapter.priority, -100);
	// provider 靠「有没有这个方法」决定是否改写，空实现反而会多一次调用
	assert.equal('transformRequest' in adapter, false);
});

/* -------------------------------------------------------------------------- */
/* DeepSeek 适配器                                                             */
/* -------------------------------------------------------------------------- */

test('isDeepSeekModel：认 vendor，也认模型 ID 里的片段', () => {
	assert.equal(isDeepSeekModel(model('deepseek-chat')), true);
	assert.equal(isDeepSeekModel(model('deepseek-ai/DeepSeek-V4')), true);
	assert.equal(isDeepSeekModel(model('随便什么名字', 'DeepSeek')), true);
	assert.equal(isDeepSeekModel(model('随便什么名字', 'deepseek')), true);
	assert.equal(isDeepSeekModel(model('gpt-4o')), false);
	assert.equal(isDeepSeekModel(model('gpt-4o', 'openai')), false);
});

/** 用 DeepSeek 适配器改写一个请求，返回改写后的请求体。 */
function deepseekTransform(requestBody, options = {}) {
	const adapter = new DeepSeekAdapter();
	const context = {
		model: { id: options.id ?? 'deepseek-chat', reasoning: options.reasoning ?? true },
		logger: createLogger(),
	};
	return adapter.transformRequest(requestBody, context);
}

test('DeepSeek：思考态主对话显式开启思考，保留思考强度', () => {
	const request = deepseekTransform({
		messages: [{ role: 'user', content: MAIN_AGENT_PROMPT }],
		reasoning_effort: 'high',
	});

	assert.deepEqual(request[THINKING_FIELD], { type: 'enabled' });
	assert.equal(request.reasoning_effort, 'high');
});

test('DeepSeek：辅助请求强制关闭思考，并去掉思考强度', () => {
	const request = deepseekTransform({
		messages: [{ role: 'user', content: 'You are an expert in crafting pithy titles for chat sessions' }],
		reasoning_effort: 'high',
	});

	assert.deepEqual(request[THINKING_FIELD], { type: 'disabled' });
	// 强度只与「开启思考」共存，留着它只会撞上不认该字段的实现
	assert.equal('reasoning_effort' in request, false);
});

test('DeepSeek：模型不具备思考能力时不写 thinking，只清掉强度字段', () => {
	const request = deepseekTransform(
		{ messages: [{ role: 'user', content: MAIN_AGENT_PROMPT }], reasoning_effort: 'high' },
		{ reasoning: false },
	);

	assert.equal(THINKING_FIELD in request, false);
	assert.equal('reasoning_effort' in request, false);
});

test('DeepSeek：请求体里本来没有强度字段时也不会凭空添加', () => {
	const request = deepseekTransform(
		{ messages: [{ role: 'user', content: MAIN_AGENT_PROMPT }] },
		{ reasoning: false },
	);

	assert.equal('reasoning_effort' in request, false);
	assert.equal(THINKING_FIELD in request, false);
});

test('DeepSeek：只改自己的字段，不动消息与工具', () => {
	const tools = [{ type: 'function', function: { name: 'read_file' } }];
	const request = deepseekTransform({
		model: 'deepseek-chat',
		messages: [{ role: 'user', content: MAIN_AGENT_PROMPT }],
		tools,
		tool_choice: 'auto',
		stream: true,
		reasoning_effort: 'low',
	});

	assert.equal(request.model, 'deepseek-chat');
	assert.equal(request.stream, true);
	assert.equal(request.tool_choice, 'auto');
	assert.equal(request.tools, tools);
	assert.equal(request.messages.length, 1);
});

/* -------------------------------------------------------------------------- */
/* GPT-6 适配器                                                                */
/* -------------------------------------------------------------------------- */

test('Gpt6ChatAdapter：只认 gpt-6 的 sol / luna 两个型号', () => {
	const adapter = new Gpt6ChatAdapter();
	const supported = ['gpt-6-sol', 'gpt-6-luna', 'openai/gpt-6-sol', 'gpt-6-luna@official'];

	for (const id of supported) {
		assert.equal(adapter.supports(model(id)), true, id);
	}
	// astra 走别的路径；sol-pro 这种带后缀的新型号没有被这个补丁覆盖
	for (const id of ['gpt-6-astra', 'gpt-6-sol-pro', 'gpt-5-sol', 'gpt-4o']) {
		assert.equal(adapter.supports(model(id)), false, id);
	}
});

test('Gpt6ChatAdapter：用到工具时把强度压成 none', () => {
	const adapter = new Gpt6ChatAdapter();
	const context = { model: { id: 'gpt-6-sol', reasoning: true }, logger: createLogger() };

	const request = adapter.transformRequest({
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ type: 'function', function: { name: 'read_file' } }],
		tool_choice: 'auto',
		reasoning_effort: 'high',
	}, context);

	assert.equal(request.reasoning_effort, 'none');
	// 工具本身必须原样保留，否则调用不了
	assert.equal(request.tools.length, 1);
	assert.equal(request.tool_choice, 'auto');
});

test('Gpt6ChatAdapter：历史里出现过工具调用也算用到工具', () => {
	const adapter = new Gpt6ChatAdapter();
	const context = { model: { id: 'gpt-6-sol', reasoning: true }, logger: createLogger() };

	const toolRole = adapter.transformRequest({
		messages: [{ role: 'user', content: 'hi' }, { role: 'tool', content: 'ok', tool_call_id: 'call_1' }],
	}, context);
	assert.equal(toolRole.reasoning_effort, 'none');

	const withToolCalls = adapter.transformRequest({
		messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }],
	}, context);
	assert.equal(withToolCalls.reasoning_effort, 'none');
});

test('Gpt6ChatAdapter：没用到工具且没指定强度时删掉采样参数', () => {
	const adapter = new Gpt6ChatAdapter();
	const context = { model: { id: 'gpt-6-luna', reasoning: true }, logger: createLogger() };

	const request = adapter.transformRequest({
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
		top_p: 0.9,
		top_logprobs: 5,
		logprobs: true,
	}, context);

	assert.equal('temperature' in request, false);
	assert.equal('top_p' in request, false);
	assert.equal('top_logprobs' in request, false);
	assert.equal('logprobs' in request, false);
});

test('Gpt6ChatAdapter：压成 none 之后采样参数反而保留', () => {
	// 采样参数只在「不是 none」时才被删：工具调用路径上它们是被允许的
	const adapter = new Gpt6ChatAdapter();
	const context = { model: { id: 'gpt-6-sol', reasoning: true }, logger: createLogger() };

	const request = adapter.transformRequest({
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ type: 'function', function: { name: 'read_file' } }],
		temperature: 0.2,
	}, context);

	assert.equal(request.reasoning_effort, 'none');
	assert.equal(request.temperature, 0.2);
});

test('Gpt6ChatAdapter：明确指定了非 none 强度时也删采样参数', () => {
	const adapter = new Gpt6ChatAdapter();
	const context = { model: { id: 'gpt-6-sol', reasoning: true }, logger: createLogger() };

	const request = adapter.transformRequest({
		messages: [{ role: 'user', content: 'hi' }],
		reasoning_effort: 'medium',
		temperature: 0.2,
	}, context);

	assert.equal(request.reasoning_effort, 'medium');
	assert.equal('temperature' in request, false);
});
