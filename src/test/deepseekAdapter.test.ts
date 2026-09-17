/**
 * DeepSeek 适配器的测试：请求种类识别、请求体改写、注册表命中。
 *
 * 覆盖的都是纯函数与一次 `transformRequest` 调用，不碰网络，也不需要扩展宿主做任何事。
 */

import * as assert from 'assert';
import type { AdapterContext } from '../adapter/adapter';
import {
	DeepSeekAdapter,
	isDeepSeekModel,
	THINKING_FIELD,
} from '../adapter/deepseek/deepseekAdapter';
import { DefaultModelAdapter } from '../adapter/defaultAdapter';
import { createDefaultAdapterRegistry } from '../adapter/registry';
import { shouldDisableThinking } from '../adapter/deepseek/requestKind';
import type { ChatRequestKind } from '../adapter/deepseek/requestKind';
import { classifyRequest } from '../adapter/deepseek/requestKind';
import { DEFAULT_REASONING_EFFORT_FIELD } from '../consts';
import type { ModelDatasetEntry } from '../models/dataset';
import type { ModelConfig } from '../models/modelConfig';
import { resolveModelConfig } from '../models/modelConfig';
import { applyReasoningEffort } from '../provider/modelConfiguration';
import type { ChatCompletionRequest, ChatRequestMessage, ChatToolDefinition } from '../types';
import { capturingLogger, createModel, createSettings, datasetEntry, installTestDataset, testLogger } from './helpers';

/** 造一个模型配置：默认是「有思考能力、可调强度、属于 DeepSeek」的模型。 */
function deepseekConfig(id = 'deepseek-v4-pro', entry: Partial<ModelDatasetEntry> = {}): ModelConfig {
	installTestDataset([datasetEntry(id, {
		reasoning: true,
		supportsReasoningEffort: ['low', 'high', 'max'],
		defaultReasoningEffort: 'high',
		vendor: 'DeepSeek',
		...entry,
	})]);
	return resolveModelConfig(createModel(id), { settings: createSettings(), logger: testLogger() });
}

/** 造一个「数据表里没有、也没有思考能力」的模型配置。 */
function plainConfig(id = 'gpt-4o'): ModelConfig {
	installTestDataset([]);
	return resolveModelConfig(createModel(id), { settings: createSettings(), logger: testLogger() });
}

/** 适配器上下文。 */
function contextFor(model: ModelConfig): AdapterContext {
	return {
		model,
		settings: {
			timeoutMs: 60_000,
			streamIdleTimeoutMs: 60_000,
			includeUsage: true,
			maxRetries: 2,
			temperature: undefined,
			topP: undefined,
			includeReasoning: false,
			extraBody: {},
		},
		logger: testLogger(),
	};
}

/** 一条用户消息。 */
function userMessage(text: string): ChatRequestMessage {
	return { role: 'user', content: text };
}

/** 一份最小请求体。 */
function requestFor(messages: ChatRequestMessage[]): ChatCompletionRequest {
	return { model: 'deepseek-v4-pro', messages };
}

/** 系统提示词为 `text` 的一次请求。 */
function systemPromptRequest(text: string): ChatCompletionRequest {
	return requestFor([{ role: 'system', content: text }]);
}

/** 一个工具声明。 */
function tool(name: string): ChatToolDefinition {
	return { type: 'function', function: { name } };
}

/** 各用例都会装数据表，跑完恢复原状。 */
teardown(() => installTestDataset([]));

suite('adapter / 请求种类识别', () => {
	test('主对话的提示词识别为 main-agent', () => {
		const kind = classifyRequest({
			messages: [{ role: 'system', content: 'You are an expert AI programming assistant, working with a user…' }],
		});
		assert.strictEqual(kind, 'main-agent');
	});

	test('带 skills / agents 说明的主对话也认', () => {
		assert.strictEqual(
			classifyRequest({ messages: systemPromptRequest('常规提示词\n<skills>\n…').messages }),
			'main-agent',
		);
		assert.strictEqual(
			classifyRequest({ messages: systemPromptRequest('常规提示词\n<agents>\n…').messages }),
			'main-agent',
		);
	});

	test('按系统提示词前缀认出的辅助请求', () => {
		const cases: readonly [string, ChatRequestKind][] = [
			['You are an expert in crafting ultra-compact titles for conversations.', 'chat-title'],
			['You are an expert in crafting pithy titles for conversations.', 'chat-title'],
			['You are a background task tracker. You are NOT the main agent.', 'todo-tracker'],
			['You are an expert classifier for AI coding assistant prompts', 'prompt-categorizer'],
			['You are a Visual Studio Code assistant. Your job is to assist users in using Visual Studio Code by returning settings', 'settings-resolver'],
			['You are an expert in writing short, catchy, and encouraging progress messages', 'inline-progress-message'],
			['You are an expert in crafting pithy branch names', 'git-branch-name'],
			['You are an AI programming assistant, helping a software developer to come with the best git commit message', 'git-commit-message'],
			['You are a distinguished software engineer. Your task is to suggest new names', 'rename-suggestions'],
		];
		for (const [prompt, expected] of cases) {
			assert.strictEqual(
				classifyRequest({ messages: systemPromptRequest(prompt).messages }),
				expected,
				prompt,
			);
		}
	});

	test('只带一个内部工具的请求也认得出', () => {
		assert.strictEqual(
			classifyRequest({ messages: systemPromptRequest('随便一句').messages, tools: [tool('manage_todo_list')] }),
			'todo-tracker',
		);
		assert.strictEqual(
			classifyRequest({ messages: systemPromptRequest('随便一句').messages, tools: [tool('categorize_prompt')] }),
			'prompt-categorizer',
		);
		// 同名工具之外还有别的工具就不是内部请求
		assert.strictEqual(
			classifyRequest({
				messages: systemPromptRequest('随便一句').messages,
				tools: [tool('manage_todo_list'), tool('read_file')],
			}),
			'background',
		);
	});

	test('终端转向消息优先于主对话提示词', () => {
		const kind = classifyRequest({
			messages: [
				{ role: 'system', content: 'You are an expert AI programming assistant' },
				userMessage('[Terminal 1 notification: 命令已经跑完了'),
			],
		});
		assert.strictEqual(kind, 'terminal-steering');
	});

	test('认不出来时按有没有内容区分 background / unknown', () => {
		assert.strictEqual(
			classifyRequest({ messages: systemPromptRequest('某个第三方提示词').messages }),
			'background',
		);
		assert.strictEqual(classifyRequest({ messages: [userMessage('继续')] }), 'background');
		assert.strictEqual(classifyRequest({ messages: [] }), 'unknown');
		// 内容片段数组也要能读出来
		assert.strictEqual(
			classifyRequest({
				messages: [{ role: 'user', content: [{ type: 'text', text: 'You are an expert in crafting pithy branch names' }] }],
			}),
			'git-branch-name',
		);
	});

	test('辅助请求才关闭思考', () => {
		const disabled: readonly ChatRequestKind[] = [
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
			assert.strictEqual(shouldDisableThinking(kind), true, kind);
		}
		const untouched: readonly ChatRequestKind[] = ['main-agent', 'terminal-steering', 'background', 'unknown'];
		for (const kind of untouched) {
			assert.strictEqual(shouldDisableThinking(kind), false, kind);
		}
	});
});

suite('adapter / DeepSeek 请求改写', () => {
	test('思考模型显式开启思考并保留强度', () => {
		const config = deepseekConfig();
		const request = systemPromptRequest('You are an expert AI programming assistant');
		applyReasoningEffort(request, 'max');

		const adapter = new DeepSeekAdapter();
		assert.strictEqual(adapter.supports(config), true);
		adapter.transformRequest(request, contextFor(config));

		assert.deepStrictEqual(request[THINKING_FIELD], { type: 'enabled' });
		assert.strictEqual(request[DEFAULT_REASONING_EFFORT_FIELD], 'max', '用户选过的强度要保留');
	});

	test('辅助请求关闭思考并去掉强度', () => {
		const config = deepseekConfig();
		const request = systemPromptRequest('You are an expert in crafting pithy titles for the conversation');
		applyReasoningEffort(request, 'max');
		const captured = capturingLogger();

		new DeepSeekAdapter().transformRequest(request, {
			...contextFor(config),
			logger: captured.logger,
		});

		assert.deepStrictEqual(request[THINKING_FIELD], { type: 'disabled' });
		assert.ok(!(DEFAULT_REASONING_EFFORT_FIELD in request), '关掉思考时强度没有意义');
		assert.ok(
			captured.messages('debug').some(line => line.includes('[chat-title]')),
			'日志里要能看出这次请求被按辅助请求处理',
		);
	});

	test('行为不随站点变化：换个网关地址结果一样', () => {
		const config = deepseekConfig();
		const helper = systemPromptRequest('You are a background task tracker. You are NOT the main agent.');
		const main = systemPromptRequest('You are an expert AI programming assistant');

		new DeepSeekAdapter().transformRequest(helper, contextFor(config));
		new DeepSeekAdapter().transformRequest(main, contextFor(config));

		// 适配器不看站点地址：同一个模型在任何网关上都是同一套改写
		assert.deepStrictEqual(helper[THINKING_FIELD], { type: 'disabled' });
		assert.deepStrictEqual(main[THINKING_FIELD], { type: 'enabled' });
	});

	test('模型不具备思考能力时不写 thinking，并去掉强度', () => {
		const config = deepseekConfig('deepseek-chat', {
			reasoning: false,
			supportsReasoningEffort: undefined,
			defaultReasoningEffort: undefined,
		});
		const request = systemPromptRequest('You are an expert AI programming assistant');
		applyReasoningEffort(request, 'high');

		new DeepSeekAdapter().transformRequest(request, contextFor(config));

		assert.ok(!(THINKING_FIELD in request), '没有思考可开关');
		assert.ok(!(DEFAULT_REASONING_EFFORT_FIELD in request));
	});

	test('本来就没有强度字段时不必动它', () => {
		const config = deepseekConfig();
		const request = systemPromptRequest('You are an expert AI programming assistant');

		new DeepSeekAdapter().transformRequest(request, contextFor(config));

		assert.deepStrictEqual(request[THINKING_FIELD], { type: 'enabled' });
		assert.ok(!(DEFAULT_REASONING_EFFORT_FIELD in request));
	});

	test('模型身份的判定', () => {
		assert.strictEqual(isDeepSeekModel(deepseekConfig('deepseek-v4-pro')), true);
		// 数据表里的厂商是 DeepSeek，ID 里却没这个词
		assert.strictEqual(isDeepSeekModel(deepseekConfig('v4-pro')), true);
		assert.strictEqual(isDeepSeekModel(plainConfig('gpt-4o')), false);
	});

	test('注册表把 DeepSeek 模型交给本适配器，其余仍走兜底', () => {
		const registry = createDefaultAdapterRegistry();
		assert.ok(registry.resolve(deepseekConfig()) instanceof DeepSeekAdapter);
		assert.ok(registry.resolve(plainConfig()) instanceof DefaultModelAdapter);
	});
});
