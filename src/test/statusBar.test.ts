import * as assert from 'assert';
import { buildTooltip } from '../status/statusBar';
import type { StatusState, TargetStatus, UsageStats } from '../status/statusService';

/**
 * 状态栏悬浮提示的内容约定。
 *
 * 这些用例跑在真实 VS Code 测试宿主里（`vscode` 模块可用），因此能直接验证 Markdown 的拼装，
 * 不需要假模块。渲染结果本身（悬浮框长什么样）仍属人工验收范围。
 */

/** 一份健康的站点状态。 */
function target(patch: Partial<TargetStatus> = {}): TargetStatus {
	return {
		key: 'k',
		group: undefined,
		label: '主站',
		baseUrl: 'https://api.example.com',
		usable: true,
		issues: [],
		models: { count: 12, rawCount: 20, filteredCount: 8, invalidCount: 0, fetchedAt: 1_700_000_000_000 },
		refreshing: false,
		...patch,
	};
}

/** 用量统计，默认「本次会话还没有请求」。 */
function usage(patch: Partial<UsageStats> = {}): UsageStats {
	return {
		requests: 0,
		promptTokens: 0,
		completionTokens: 0,
		totalTokens: 0,
		cachedTokens: 0,
		cacheReported: false,
		reasoningTokens: 0,
		toolCalls: 0,
		...patch,
	};
}

/** 一份完整状态，默认「已配置一个健康站点、尚无请求」。 */
function state(patch: Partial<StatusState> = {}): StatusState {
	return {
		targets: [target()],
		anyUsable: true,
		totalModels: 12,
		logLevel: 'info',
		statusBarEnabled: true,
		usage: usage(),
		adapters: [],
		...patch,
	};
}

suite('status / 状态栏悬浮提示', () => {
	test('没有会话数据、也没有问题时不给提示', () => {
		// 空闲时弹一句「还没有请求」是纯噪声，还容易被当成出错
		assert.strictEqual(buildTooltip(state()), undefined);
	});

	test('有请求后给出输入、输出与缓存命中', () => {
		const tooltip = buildTooltip(state({
			usage: usage({
				requests: 3,
				promptTokens: 12_345,
				completionTokens: 2_048,
				totalTokens: 14_393,
				cachedTokens: 9_800,
				cacheReported: true,
				toolCalls: 2,
				lastRequestAt: Date.now(),
				lastModelId: 'claude-sonnet-4.5',
			}),
		}));
		const text = tooltip?.value ?? '';
		assert.ok(text.includes('3 次请求'), text);
		assert.ok(text.includes('2 次工具调用'), text);
		assert.ok(text.includes('输入：12.3K'), text);
		assert.ok(text.includes('输出：2K'), text);
		// 命中率的分母是输入：9800 / 12345 ≈ 79%
		assert.ok(text.includes('缓存命中：9.8K（79%）'), text);
		assert.ok(text.includes('claude-sonnet-4.5'), text);
	});

	test('上游不报缓存时不写这一行', () => {
		const text = buildTooltip(state({
			usage: usage({ requests: 1, promptTokens: 100, completionTokens: 10, totalTokens: 110 }),
		}))?.value ?? '';
		assert.ok(!text.includes('缓存命中'), `不该编一行缓存，实际：${text}`);
	});

	test('报告了缓存但没命中时写明「无」', () => {
		const text = buildTooltip(state({
			usage: usage({
				requests: 1,
				promptTokens: 100,
				completionTokens: 10,
				totalTokens: 110,
				cacheReported: true,
			}),
		}))?.value ?? '';
		assert.ok(text.includes('缓存命中：无'), text);
	});

	test('上游没返回用量时说明这一点，而不是显示一排 0', () => {
		const text = buildTooltip(state({ usage: usage({ requests: 1, toolCalls: 0 }) }))?.value ?? '';
		assert.ok(text.includes('上游未返回 token 用量'), text);
		assert.ok(!text.includes('输入：'), `不该显示 0 值，实际：${text}`);
	});

	test('只思考 token 大于 0 时才列出思考', () => {
		const withReasoning = buildTooltip(state({
			usage: usage({ requests: 1, promptTokens: 10, completionTokens: 99, totalTokens: 109, reasoningTokens: 80 }),
		}))?.value ?? '';
		assert.ok(withReasoning.includes('其中思考：80'), withReasoning);

		const without = buildTooltip(state({
			usage: usage({ requests: 1, promptTokens: 10, completionTokens: 9, totalTokens: 19 }),
		}))?.value ?? '';
		assert.ok(!without.includes('其中思考'), without);
	});

	test('站点连不上时即使没有会话也要给提示（状态栏已被着色，用户需要一个理由）', () => {
		const tooltip = buildTooltip(state({
			targets: [target({
				models: {
					count: 0,
					rawCount: 0,
					filteredCount: 0,
					invalidCount: 0,
					error: '密钥被拒绝',
					hint: '检查配置组里的 API Key',
				},
			})],
		}));
		const text = tooltip?.value ?? '';
		assert.ok(text.includes('密钥被拒绝'), text);
		assert.ok(text.includes('检查配置组里的 API Key'), text);
	});

	test('配置不完整时列出原因', () => {
		const text = buildTooltip(state({
			targets: [target({ usable: false, issues: ['缺少站点地址'] })],
			anyUsable: false,
		}))?.value ?? '';
		assert.ok(text.includes('缺少站点地址'), text);
	});

	test('尚未配置站点时给出配置指引（此时状态栏只有「New API」两个字）', () => {
		const text = buildTooltip(state({ targets: [], anyUsable: false, totalModels: 0 }))?.value ?? '';
		assert.ok(text.includes('尚未配置任何站点'), text);
		assert.ok(text.includes('管理模型'), text);
	});

	test('会话数据与站点问题同时存在时两段都给', () => {
		const text = buildTooltip(state({
			usage: usage({ requests: 1, promptTokens: 10, completionTokens: 1, totalTokens: 11 }),
			targets: [target({
				models: {
					count: 0,
					rawCount: 0,
					filteredCount: 0,
					invalidCount: 0,
					error: '连不上',
				},
			})],
		}))?.value ?? '';
		assert.ok(text.includes('1 次请求'), text);
		assert.ok(text.includes('连不上'), text);
	});

	test('分段靠空行：单个换行在 Markdown 里只是软换行，会并成一行', () => {
		const text = buildTooltip(state({
			usage: usage({ requests: 1, promptTokens: 10, completionTokens: 1, totalTokens: 11 }),
		}))?.value ?? '';
		// 标题块结束、会话块结束、收尾提示各需要一个空行
		assert.ok(text.includes('Copilot Chat**\n\n'), text);
		assert.ok(text.includes('\n\n点击打开状态面板'), text);
		assert.ok(!text.includes('\n\n\n'), `不该出现连续空行，实际：${JSON.stringify(text)}`);
	});

	test('主题图标开关打开：$(warning) 之类的图标才会渲染成图标', () => {
		assert.strictEqual(buildTooltip(state({ targets: [] }))?.supportThemeIcons, true);
	});
});
