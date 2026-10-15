'use strict';

/**
 * adapter 层：适配器选择、请求改写的判据、请求种类识别。
 *
 * 这一层不 import `vscode`，直接加载即可。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const { modules } = load({
	consts: './src/consts',
	registry: './src/adapter/registry',
	deepseek: './src/adapter/deepseek/deepseekAdapter',
	requestKind: './src/adapter/requestKind',
	capability: './src/adapter/capabilityAdapter',
	openaiReasoning: './src/adapter/openai/openaiAdapter',
	reasoning: './src/reasoning',
});

const { AdapterRegistry, createDefaultAdapterRegistry } = modules.registry;
const { DeepSeekAdapter, isDeepSeekModel } = modules.deepseek;
const { DEFAULT_THINKING_FIELD: THINKING_FIELD } = modules.consts;
const { classifyRequest, shouldDisableThinking } = modules.requestKind;
const { ModelCapabilityAdapter } = modules.capability;
const { OpenAIAdapter } = modules.openaiReasoning;
const { REASONING_ECHO_FIELD } = modules.reasoning;

/** 造一个够用的模型配置：只有 `id` 与 `meta.vendor` 会被适配器读。 */
function model(id, vendor) {
	return { id, meta: vendor === undefined ? {} : { vendor }, reasoning: false, reasoningEfforts: [] };
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
	// 有内容但认不出：普通后台请求
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

	assert.equal(registry.resolveAll(model('deepseek-chat')).length, 1);
	assert.equal(logger.messages('warn').length, 1);
	assert.match(logger.messages('warn')[0], /deepseek/);
});

test('AdapterRegistry：resolveAll 返回全部命中项，高优先级排在前面', () => {
	const registry = new AdapterRegistry();
	const low = { id: 'low', priority: 1, supports: () => true, transformRequest: request => request };
	const high = { id: 'high', priority: 10, supports: () => true, transformRequest: request => request };
	const never = { id: 'never', priority: 100, supports: () => false, transformRequest: request => request };

	// 注册顺序与优先级顺序相反，用来确认排序真的生效
	registry.register(low, silentLogger);
	registry.register(never, silentLogger);
	registry.register(high, silentLogger);

	// 全部命中项都要返回：差异是按「一个协议特性」拆的，一个模型常常同时命中多条
	assert.deepEqual(registry.resolveAll(model('anything')).map(adapter => adapter.id), ['high', 'low']);
});

test('AdapterRegistry：没有匹配项时返回空适配链并原样透传请求', async () => {
	const registry = new AdapterRegistry();
	registry.register({ id: 'picky', priority: 1, supports: () => false, transformRequest: request => request }, silentLogger);

	assert.deepEqual(registry.resolveAll(model('anything')), []);
	const request = { model: 'anything', messages: [{ role: 'user', content: 'hi' }] };
	assert.deepEqual(await registry.transformRequest(request, { model: model('anything'), logger: silentLogger }), request);
});

test('内置注册表：按模型 ID 选中厂商适配器，再执行能力位适配器', () => {
	const registry = createDefaultAdapterRegistry(silentLogger);
	const ids = selected => registry.resolveAll(model(selected)).map(adapter => adapter.id);

	assert.deepEqual(ids('deepseek-chat'), ['deepseek', 'model-capabilities']);
	assert.deepEqual(ids('qwen3.5-plus'), ['qwen', 'model-capabilities']);
	assert.deepEqual(ids('glm-5'), ['glm', 'model-capabilities']);
	assert.deepEqual(ids('kimi-k2.5'), ['kimi', 'model-capabilities']);
	for (const id of ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.4', 'gpt-5-code']) {
		assert.deepEqual(ids(id), ['openai-reasoning', 'model-capabilities']);
	}
	// 未知厂商只走能力位适配器，改不改由数据决定。
	assert.deepEqual(ids('gpt-4o'), ['model-capabilities']);
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
		logger: options.logger ?? createLogger(),
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

test('DeepSeek：自定义端点的辅助请求保留所选思考强度', () => {
	const request = deepseekTransform({
		messages: [{ role: 'user', content: 'You are an expert in crafting pithy titles for chat sessions' }],
		reasoning_effort: 'high',
	});

	assert.deepEqual(request[THINKING_FIELD], { type: 'enabled' });
	assert.equal(request.reasoning_effort, 'high');
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

/* --- 思考内容的回填与补齐 --------------------------------------------------- */

test('DeepSeek：参数适配器不再编造历史思考占位', () => {
	const logger = createLogger();
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{
				role: 'assistant',
				content: null,
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_shell', arguments: '{}' } }],
			},
			{ role: 'tool', tool_call_id: 'call_1', content: '输出' },
			{ role: 'assistant', content: '答案' },
		],
	}, { logger });

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], undefined);
	assert.equal(request.messages[3][REASONING_ECHO_FIELD], undefined);
	assert.equal(request.messages[1].content, null);
	assert.equal(request.messages[1].tool_calls.length, 1);
	assert.equal(request.messages[3].content, '答案');
	assert.doesNotMatch(logger.messages('debug').join(' '), /占位/);
});

test('DeepSeek：已经带回的思考内容保持不变', () => {
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{ role: 'assistant', content: '答案', reasoning_content: '回放里的思考' },
		],
	});

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], '回放里的思考');
});

test('DeepSeek：空字符串的思考内容保持为空字符串', () => {
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{ role: 'assistant', content: '答案', reasoning_content: '' },
		],
	});

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], '');
});

test('DeepSeek：关掉思考的辅助请求不补占位', () => {
	// 关掉思考的请求不欠上游这个字段，多送一个反而多一种被拒的可能
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: 'You are an expert in crafting pithy titles for chat sessions' },
			{ role: 'assistant', content: '标题' },
		],
	});

	assert.equal(REASONING_ECHO_FIELD in request.messages[1], false);
});

test('DeepSeek：模型不具备思考能力时不补占位', () => {
	const request = deepseekTransform(
		{
			messages: [
				{ role: 'user', content: MAIN_AGENT_PROMPT },
				{ role: 'assistant', content: '答案' },
			],
		},
		{ reasoning: false },
	);

	assert.equal(REASONING_ECHO_FIELD in request.messages[1], false);
});

/* -------------------------------------------------------------------------- */
/* 能力位适配器（数据驱动）                                                    */
/* -------------------------------------------------------------------------- */

/** 用能力位适配器改写一个请求；`config` 就是数据表给这个模型的能力位。 */
function capabilityTransform(requestBody, config = {}) {
	const adapter = new ModelCapabilityAdapter();
	const context = {
		model: { id: config.id ?? 'gpt-6-sol', ...config },
		logger: createLogger(),
	};
	return adapter.transformRequest(requestBody, context);
}

test('ModelCapabilityAdapter：对所有模型生效，改不改由能力位决定', () => {
	const adapter = new ModelCapabilityAdapter();

	assert.equal(adapter.supports(model('任意模型')), true);
	assert.equal(adapter.supports(model('gpt-6-sol')), true);
});

test('ModelCapabilityAdapter：samplingParams=never 时总是删掉采样参数', () => {
	const request = capabilityTransform({
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
		top_p: 0.9,
		top_logprobs: 5,
		logprobs: true,
	}, { samplingParams: 'never' });

	for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) {
		assert.equal(key in request, false, key);
	}
});

test('ModelCapabilityAdapter：when-thinking-off 只在强度为 none 时保留采样参数', () => {
	const config = { samplingParams: 'when-thinking-off' };

	// 思考已关（reasoning_effort=none）→ 采样参数合法
	const kept = capabilityTransform({
		messages: [{ role: 'user', content: 'hi' }],
		reasoning_effort: 'none',
		temperature: 0.2,
	}, config);
	assert.equal(kept.temperature, 0.2);

	// 强度是别的值 → 采样参数必须删掉
	const removed = capabilityTransform({
		messages: [{ role: 'user', content: 'hi' }],
		reasoning_effort: 'high',
		temperature: 0.2,
	}, config);
	assert.equal(removed.reasoning_effort, 'high');
	assert.equal('temperature' in removed, false);
});

test('ModelCapabilityAdapter：没表态强度时采样参数按推理请求处理', () => {
	// `when-thinking-off` 只看 `reasoning_effort` 的值：没写强度就不等于 none，采样参数被删掉
	const removed = capabilityTransform({
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
	}, { samplingParams: 'when-thinking-off' });

	assert.equal('temperature' in removed, false);
});

test('ModelCapabilityAdapter：数据表没表态时不动请求', () => {
	const request = capabilityTransform({
		messages: [{ role: 'user', content: 'hi' }],
		tools: [{ type: 'function', function: { name: 'read_file' } }],
		temperature: 0.2,
		reasoning_effort: 'high',
	});

	assert.equal(request.temperature, 0.2);
	assert.equal(request.reasoning_effort, 'high');
});

/* -------------------------------------------------------------------------- */
/* OpenAI 推理模型适配器                                                       */
/* -------------------------------------------------------------------------- */

test('OpenAIAdapter：只认新一代推理模型', () => {
	const adapter = new OpenAIAdapter();

	for (const id of ['gpt-5.4', 'gpt-5-code', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol']) {
		assert.equal(adapter.supports(model(id)), true, id);
	}
	for (const id of ['gpt-4.1', 'gpt-4o']) {
		assert.equal(adapter.supports(model(id)), false, id);
	}
});

test('OpenAIAdapter：把 max_tokens 改名为 max_completion_tokens', () => {
	const adapter = new OpenAIAdapter();
	const context = { model: { id: 'gpt-5.4' }, logger: createLogger() };

	const request = adapter.transformRequest({
		model: 'gpt-5.4',
		messages: [{ role: 'user', content: 'hi' }],
		max_tokens: 4_096,
	}, context);

	assert.equal(request.max_completion_tokens, 4_096);
	assert.equal('max_tokens' in request, false);
});

test('OpenAIAdapter：数据表已表态的模型让位给能力位适配器', () => {
	// 数据表知道得更细（例如「关掉思考时才接受采样参数」），因此不在这里一刀切
	const adapter = new OpenAIAdapter();
	const context = {
		model: { id: 'gpt-6-sol', samplingParams: 'when-thinking-off' },
		logger: createLogger(),
	};

	const request = adapter.transformRequest({
		model: 'gpt-6-sol',
		messages: [{ role: 'user', content: 'hi' }],
		temperature: 0.2,
		max_tokens: 100,
	}, context);

	assert.equal(request.temperature, 0.2);
	// 输出上限的字段名仍然由这里改写
	assert.equal(request.max_completion_tokens, 100);
	assert.equal('max_tokens' in request, false);
});

test('OpenAIAdapter：也认 o 系列推理模型', () => {
	const adapter = new OpenAIAdapter();

	for (const id of ['o1', 'o1-pro', 'o3', 'o3-mini', 'o3-mini-high', 'o3-pro', 'o4-mini', 'o4-mini-high', 'openai/o3@official']) {
		assert.equal(adapter.supports(model(id)), true, id);
	}
	// o 系列之后的普通对话模型不受影响
	for (const id of ['gpt-4.1', 'gpt-4o']) {
		assert.equal(adapter.supports(model(id)), false, id);
	}
});

test('OpenAIAdapter：o 系列同样只认 max_completion_tokens', () => {
	const adapter = new OpenAIAdapter();
	const context = { model: { id: 'o3' }, logger: createLogger() };

	const request = adapter.transformRequest({
		model: 'o3',
		messages: [{ role: 'user', content: 'hi' }],
		max_tokens: 4_096,
		temperature: 0.4,
	}, context);

	assert.equal(request.max_completion_tokens, 4_096);
	assert.equal('max_tokens' in request, false);
	// o 系列会直接拒绝采样参数，而不是忽略
	assert.equal('temperature' in request, false);
});

/* -------------------------------------------------------------------------- */
/* Kimi 适配器                                                                 */
/* -------------------------------------------------------------------------- */

test('Kimi：K3 与 K2.7-code 保留顶层 reasoning_effort，不写会被拒的 thinking', async () => {
	const registry = createDefaultAdapterRegistry();
	async function transform(id, request, effort, efforts) {
		return registry.transformRequest({ model: id, messages: [], ...request }, {
			model: { ...model(id), reasoning: true, ...(efforts ? { reasoningEfforts: efforts } : {}) },
			reasoningEffort: effort, logger: createLogger(),
		});
	}

	// K3 只认顶层 reasoning_effort，官方要求从 K2.x 迁移时移除 thinking
	for (const id of ['kimi-k3', 'k3', 'moonshotai/kimi-k3']) {
		const result = await transform(id, { reasoning_effort: 'high' });
		assert.equal(result.reasoning_effort, 'high', id);
		assert.equal('thinking' in result, false, id);
	}
	// 别名靠数据表给出的档位分流：有档位说明走的是 K3 那条路
	const latest = await transform('kimi-latest', { reasoning_effort: 'high' }, undefined, ['max', 'high', 'low']);
	assert.equal(latest.reasoning_effort, 'high');
	assert.equal('thinking' in latest, false);
	// K2.7-code 思考常开，只接受 {type:enabled,keep:all}，因此这里同样不写 thinking
	const code = await transform('kimi-k2.7-code', { reasoning_effort: 'low' });
	assert.equal(code.reasoning_effort, 'low');
	assert.equal('thinking' in code, false);
});

test('Kimi：K2.x 仍用 thinking.type 表达开关', async () => {
	const registry = createDefaultAdapterRegistry();
	async function transform(id, request, effort) {
		return registry.transformRequest({ model: id, messages: [], ...request }, {
			model: { ...model(id), reasoning: true }, reasoningEffort: effort, logger: createLogger(),
		});
	}

	for (const id of ['kimi-k2.5', 'kimi-k2.6', 'kimi-k2-thinking']) {
		const enabled = await transform(id, {}, 'high');
		assert.deepEqual(enabled.thinking, { type: 'enabled' }, id);
		assert.equal('reasoning_effort' in enabled, false, id);
		const disabled = await transform(id, { reasoning_effort: 'off' });
		assert.deepEqual(disabled.thinking, { type: 'disabled' }, id);
	}
});

/* -------------------------------------------------------------------------- */
/* GLM 适配器                                                                  */
/* -------------------------------------------------------------------------- */

test('GLM：强制思考的 5.3 不写会被拒的 thinking.type=disabled', async () => {
	const registry = createDefaultAdapterRegistry();
	async function transform(id, effort) {
		return registry.transformRequest({ model: id, messages: [], reasoning_effort: effort ?? 'none' }, {
			model: { ...model(id), reasoning: true }, logger: createLogger(),
		});
	}

	// 5.3 系列始终思考：官方的迁移做法是改成 enabled，而不是写一个会 400 的 disabled
	for (const id of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.3-prime', 'z-ai/glm-5.3']) {
		for (const effort of ['none', 'off']) {
			const result = await transform(id, effort);
			assert.deepEqual(result.thinking, { type: 'enabled' }, `${id}/${effort}`);
			assert.equal('reasoning_effort' in result, false, `${id}/${effort}`);
		}
	}
	// 5.3 之前的型号仍可关闭
	const older = await transform('glm-5', 'off');
	assert.deepEqual(older.thinking, { type: 'disabled' });
});

/* -------------------------------------------------------------------------- */
/* 与 DeepSeek 同契的厂商行为：显式开关、回填思考、辅助请求、非思考模型          */
/* -------------------------------------------------------------------------- */

test('厂商适配器：要求回填思考原文的厂商声明 echoReasoningContent', () => {
	const registry = createDefaultAdapterRegistry();
	// DeepSeek、Kimi、GLM、Qwen 都要求把历史助手消息的思考原文原样带回
	for (const id of ['deepseek-v4-pro', 'kimi-k2.6', 'glm-5', 'qwen3.5-plus']) {
		assert.equal(
			registry.resolveAll(model(id)).some(item => item.echoReasoningContent === true),
			true,
			id,
		);
	}
	// OpenAI 推理模型不要求回填，`reasoning_content` 不是它的字段
	assert.equal(
		registry.resolveAll(model('o3')).some(item => item.echoReasoningContent === true),
		false,
	);
});

test('厂商适配器：思考模型一律显式写入开关，不由上游的默认值决定', async () => {
	const registry = createDefaultAdapterRegistry();
	for (const id of ['deepseek-v4-pro', 'kimi-k2.6', 'glm-5']) {
		const result = await registry.transformRequest({ model: id, messages: [] }, {
			model: { ...model(id), reasoning: true }, reasoningEffort: 'high', logger: createLogger(),
		});
		assert.deepEqual(result.thinking, { type: 'enabled' }, id);
	}
	// Qwen 用布尔开关
	const qwen = await registry.transformRequest({ model: 'qwen3.5-plus', messages: [] }, {
		model: { ...model('qwen3.5-plus'), reasoning: true }, reasoningEffort: 'high', logger: createLogger(),
	});
	assert.equal(qwen.enable_thinking, true);
});

test('厂商适配器：Kimi 与 GLM 保留各自的辅助请求协议策略', async () => {
	const registry = createDefaultAdapterRegistry();
	const helper = [{ role: 'user', content: 'You are an expert in crafting pithy titles for chat sessions' }];
	for (const id of ['kimi-k2.6', 'glm-5']) {
		const result = await registry.transformRequest(
			{ model: id, messages: helper, reasoning_effort: 'high' },
			{ model: { ...model(id), reasoning: true }, logger: createLogger() },
		);
		assert.deepEqual(result.thinking, { type: 'disabled' }, id);
		// 强度只与「开启思考」共存
		assert.equal('reasoning_effort' in result, false, id);
	}
});

test('厂商适配器：非思考模型不写原生开关，只清掉强度字段', async () => {
	const registry = createDefaultAdapterRegistry();
	for (const id of ['deepseek-chat', 'kimi-k2', 'glm-4.5-air', 'qwen-plus', 'o3']) {
		const result = await registry.transformRequest(
			{ model: id, messages: [], reasoning_effort: 'high' },
			{ model: model(id), logger: createLogger() },
		);
		assert.equal('thinking' in result, false, id);
		assert.equal('enable_thinking' in result, false, id);
		assert.equal('reasoning_effort' in result, false, id);
	}
});

test('厂商适配器：给出强度档位的 Qwen 型号保留 reasoning_effort，不翻译开关', async () => {
	const registry = createDefaultAdapterRegistry();
	const result = await registry.transformRequest({ model: 'qwen3.8-max', messages: [], reasoning_effort: 'xhigh' }, {
		model: { ...model('qwen3.8-max'), reasoning: true, reasoningEfforts: ['xhigh', 'high', 'medium', 'low'] },
		logger: createLogger(),
	});
	assert.equal(result.reasoning_effort, 'xhigh');
	assert.equal('enable_thinking' in result, false);
});

/* -------------------------------------------------------------------------- */
/* 适配链顺序与隔离                                                            */
/* -------------------------------------------------------------------------- */

test('适配链：厂商改写后能力位仍能识别关闭思考，原始历史不被污染', async () => {
	const registry = createDefaultAdapterRegistry();
	for (const id of ['deepseek-v4-pro', 'Qwen/Qwen3.5-plus', 'z-ai/glm-5', 'moonshotai/kimi-k2.5']) {
		const input = {
			model: id,
			messages: [{ role: 'assistant', content: '先前答案' }, { role: 'user', content: '继续' }],
			tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
			reasoning_effort: 'none',
			temperature: 0.3,
		};
		const original = structuredClone(input);
		const result = await registry.transformRequest(input, {
			model: { ...model(id), reasoning: true, samplingParams: 'when-thinking-off' },
			logger: createLogger(),
		});
		assert.equal(result.temperature, 0.3, id);
		assert.equal(result.reasoning_effort, undefined, id);
		assert.deepEqual(result.tools, input.tools, id);
		assert.deepEqual(input, original, id);
		if (id.includes('Qwen')) {
			assert.equal(result.enable_thinking, false);
		} else {
			assert.deepEqual(result.thinking, { type: 'disabled' });
		}
	}
});

test('适配链：DeepSeek 默认关闭与显式关闭均不补思考占位', async () => {
	const registry = createDefaultAdapterRegistry();
	for (const effort of ['none', 'off']) {
		const result = await registry.transformRequest({
			model: 'deepseek-v4-pro',
			messages: [{ role: 'assistant', content: '答案' }],
		}, {
			model: { ...model('deepseek-v4-pro'), reasoning: true },
			reasoningEffort: effort,
			logger: createLogger(),
		});
		assert.deepEqual(result.thinking, { type: 'disabled' });
		assert.equal('reasoning_content' in result.messages[0], false);
	}
});

test('适配链：Qwen 自动模式保留预算，Kimi 保留真实思考历史，GLM 显式开启并保留具体强度', async () => {
	const registry = createDefaultAdapterRegistry();
	async function transform(id, extra, effort) {
		return registry.transformRequest({
			model: id,
			messages: [{ role: 'assistant', content: '答案', reasoning_content: '真实原文' }],
			...extra,
		}, { model: { ...model(id), reasoning: true }, reasoningEffort: effort, logger: createLogger() });
	}
	const qwen = await transform('qwen3.5-plus', { reasoning_effort: 'auto', thinking_budget: 4096 });
	assert.equal('reasoning_effort' in qwen, false);
	assert.equal('enable_thinking' in qwen, false);
	assert.equal(qwen.thinking_budget, 4096);
	const kimi = await transform('kimi-k2.5', {}, 'on');
	assert.deepEqual(kimi.thinking, { type: 'enabled' });
	assert.equal(kimi.messages[0].reasoning_content, '真实原文');
	assert.equal(registry.resolveAll(model('kimi-k2.5')).some(item => item.echoReasoningContent), true);
	const glm = await transform('glm-5', { reasoning_effort: 'max' });
	// 具体强度保留；开关一律显式写入，不依赖上游对「没给这个字段」的默认理解
	assert.equal(glm.reasoning_effort, 'max');
	assert.deepEqual(glm.thinking, { type: 'enabled' });
});

test('适配链：未知与非思考模型不猜测原生开关，厂商匹配有名称边界', async () => {
	const registry = createDefaultAdapterRegistry();
	// 名称不匹配：适配器链为空，请求原样透传
	for (const id of ['custom-model', 'notqwen3', 'my-glm-5', 'notkimi-k2']) {
		const input = { model: id, messages: [], reasoning_effort: 'off' };
		const result = await registry.transformRequest(input, { model: model(id), logger: createLogger() });
		assert.deepEqual(result, input, id);
	}
	// 名称匹配但不具备思考能力：不写任何原生开关，只清掉强度字段
	const matched = await registry.transformRequest(
		{ model: 'qwen3.5-plus', messages: [], reasoning_effort: 'off' },
		{ model: model('qwen3.5-plus'), logger: createLogger() },
	);
	assert.equal('enable_thinking' in matched, false);
	assert.equal('thinking' in matched, false);
	assert.equal('reasoning_effort' in matched, false);
});

test('适配链：异步改写结果继续传给下一个适配器', async () => {
	const registry = new AdapterRegistry();
	registry.register({ id: 'first', priority: 100, supports: () => true,
		transformRequest: async request => ({ ...request, reasoning_effort: 'none' }) });
	registry.register(new ModelCapabilityAdapter());
	const result = await registry.transformRequest({ model: 'custom', messages: [], temperature: 0.2 }, {
		model: { ...model('custom'), samplingParams: 'when-thinking-off' }, logger: createLogger(),
	});
	assert.equal(result.temperature, 0.2);
	assert.equal(result.reasoning_effort, 'none');
});
