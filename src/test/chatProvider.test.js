'use strict';

/**
 * provider 侧的模型信息映射（`toModelInformation`）。
 *
 * 它只被 `provideLanguageModelChatInformation` 调用，因此这里用 `fakes.js` 的 `vscode` 替身
 * 加一个「永远命中」的假会话注册表，把 provider 真的建起来跑一遍，而不是复制一份映射逻辑。
 *
 * 关注点有两个，都来自宿主实现：
 * - **真实上下文窗口要单独上报**（`maxContextWindowTokens`）。宿主没有这个字段时按
 *   `maxInputTokens + maxOutputTokens` 兜底，两者的差只在「网关给出比『窗口 − 输出上限』
 *   更小的输入上限」时才暴露；
 * - **`capabilities.apiType` / `adaptiveThinking` 必须保持不下发**：宿主读到这两个字段时会
 *   `checkProposedApiEnabled(..., 'languageModelCapabilities')`，扩展不能声明提案，那是直接抛异常。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load, createLogger } = require('./helpers');

const logger = createLogger();
const { modules } = load({
	chatProvider: './src/provider/chatProvider',
	modelConfig: './src/models/modelConfig',
});
const { NewApiChatProvider } = modules.chatProvider;
const { resolveModelConfig } = modules.modelConfig;

const settings = { defaultContextWindow: 32_000, defaultMaxOutputTokens: 8_192 };

/** 造一个只服务模型发现阶段的 provider。 */
function discover(configs) {
	const provider = new NewApiChatProvider({
		logger,
		sessions: {
			onDidChange: () => ({ dispose() { } }),
			resolve: () => ({ catalog: { getModels: async () => ({ models: configs }) } }),
		},
		adapters: {},
		getSettings: () => settings,
	});
	const options = {
		silent: true,
		group: 'test',
		configuration: { baseUrl: 'https://api.example.com', apiKey: 'test-key' },
	};
	return provider.provideLanguageModelChatInformation(options, {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose() { } }),
	});
}

test('模型信息：真实上下文窗口单独上报', async () => {
	const config = resolveModelConfig({ id: 'plain-model' }, { settings, logger });
	const [info] = await discover([config]);

	assert.equal(info.maxContextWindowTokens, config.contextWindow);
	// 没有显式输入上限时，宿主兜底算出的「输入 + 输出」恰好也是窗口
	assert.equal(info.maxInputTokens + info.maxOutputTokens, info.maxContextWindowTokens);
});

test('模型信息：网关给出更小的输入上限时窗口不被那个和拖小', async () => {
	const config = resolveModelConfig(
		{ id: 'demo', context_length: 128_000, max_input_tokens: 100_000, max_tokens: 8_000 },
		{ settings, logger },
	);
	const [info] = await discover([config]);

	assert.equal(info.maxContextWindowTokens, 128_000);
	// 这正是不能只依赖宿主兜底的原因：那个和会比真实窗口小
	assert.ok(info.maxInputTokens + info.maxOutputTokens < info.maxContextWindowTokens);
});

test('模型能力：不下发 apiType / adaptiveThinking', async () => {
	const [info] = await discover([resolveModelConfig({ id: 'plain-model' }, { settings, logger })]);

	assert.equal(info.capabilities.apiType, undefined);
	assert.equal(info.capabilities.adaptiveThinking, undefined);
});
