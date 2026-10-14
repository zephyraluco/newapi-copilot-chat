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
	consts: './src/consts',
	registry: './src/adapter/registry',
	deepseek: './src/adapter/deepseek/deepseekAdapter',
	requestKind: './src/adapter/deepseek/requestKind',
	capability: './src/adapter/capabilityAdapter',
	openaiReasoning: './src/adapter/openai/openaiReasoningAdapter',
	reasoning: './src/reasoning',
});

const { AdapterRegistry, createDefaultAdapterRegistry } = modules.registry;
const { DeepSeekAdapter, isDeepSeekModel } = modules.deepseek;
const { DEFAULT_THINKING_FIELD: THINKING_FIELD } = modules.consts;
const { classifyRequest, shouldDisableThinking } = modules.requestKind;
const { ModelCapabilityAdapter } = modules.capability;
const { OpenAIReasoningAdapter } = modules.openaiReasoning;
const { REASONING_ECHO_FIELD, REASONING_PLACEHOLDER } = modules.reasoning;

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

/* --- 思考内容的回填与补齐 --------------------------------------------------- */

test('DeepSeek：思考态下给缺思考内容的历史助手消息补占位', () => {
	// 宿主自己插入的助手消息（读取后台终端输出的工具调用就是这样出现的）本来就没有思考可
	// 回填，而思考态下缺这个字段上游会整次拒掉——包括没有工具调用的普通助手消息
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

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], REASONING_PLACEHOLDER);
	assert.equal(request.messages[3][REASONING_ECHO_FIELD], REASONING_PLACEHOLDER);
	// 占位只补字段，正文与工具调用照旧
	assert.equal(request.messages[1].content, null);
	assert.equal(request.messages[1].tool_calls.length, 1);
	assert.equal(request.messages[3].content, '答案');
	assert.match(logger.messages('debug').join(' '), /2 条/);
});

test('DeepSeek：已经带回的思考内容不动，只补缺的', () => {
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{ role: 'assistant', content: '答案', reasoning_content: '回放里的思考' },
		],
	});

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], '回放里的思考');
});

test('DeepSeek：空字符串的思考内容同样是缺，补占位', () => {
	// 空串过不了上游的「非空」校验，与字段缺席同义
	const request = deepseekTransform({
		messages: [
			{ role: 'user', content: MAIN_AGENT_PROMPT },
			{ role: 'assistant', content: '答案', reasoning_content: '' },
		],
	});

	assert.equal(request.messages[1][REASONING_ECHO_FIELD], REASONING_PLACEHOLDER);
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

	// 思考已关（reasoning_effort=none）→ 不再是推理请求 → 采样参数合法
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
	// `when-thinking-off` 只看 `reasoning_effort` 的值，不看请求是否带工具：
	// 没写强度就不等于 none，因此采样参数被删掉
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

test('OpenAIReasoningAdapter：只认新一代推理模型', () => {
	const adapter = new OpenAIReasoningAdapter();

	for (const id of ['gpt-5.4', 'gpt-5-code', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol']) {
		assert.equal(adapter.supports(model(id)), true, id);
	}
	for (const id of ['gpt-4.1', 'gpt-4o']) {
		assert.equal(adapter.supports(model(id)), false, id);
	}
});

test('OpenAIReasoningAdapter：把 max_tokens 改名为 max_completion_tokens', () => {
	const adapter = new OpenAIReasoningAdapter();
	const context = { model: { id: 'gpt-5.4' }, logger: createLogger() };

	const request = adapter.transformRequest({
		model: 'gpt-5.4',
		messages: [{ role: 'user', content: 'hi' }],
		max_tokens: 4_096,
	}, context);

	assert.equal(request.max_completion_tokens, 4_096);
	assert.equal('max_tokens' in request, false);
});

test('OpenAIReasoningAdapter：数据表已表态的模型让位给能力位适配器', () => {
	// 数据表知道得更细（例如「关掉思考时才接受采样参数」），因此不在这里一刀切
	const adapter = new OpenAIReasoningAdapter();
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

test('适配链：Qwen 自动模式保留预算，Kimi 保留真实思考历史，GLM 保留具体强度', async () => {
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
	assert.equal(glm.reasoning_effort, 'max');
	assert.equal('thinking' in glm, false);
});

test('适配链：未知与非思考模型不猜测原生开关，厂商匹配有名称边界', async () => {
	const registry = createDefaultAdapterRegistry();
	for (const id of ['custom-model', 'notqwen3', 'my-glm-5', 'notkimi-k2', 'qwen3.5-plus']) {
		const input = { model: id, messages: [], reasoning_effort: 'off' };
		const result = await registry.transformRequest(input, { model: model(id), logger: createLogger() });
		assert.deepEqual(result, input, id);
	}
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
