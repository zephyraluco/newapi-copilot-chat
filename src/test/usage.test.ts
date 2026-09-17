import * as assert from 'assert';
import type { ChatUsage } from '../types';
import { buildReportedUsage, cacheHitRate, describeCacheHit, readUsageDelta } from '../usage';

/**
 * 这些测试覆盖用量的读出规则。
 *
 * 背景：缓存命中的字段名在各家网关之间不统一，而它又直接决定「这一下贵不贵」的观感；
 * 读错会得到一个静默偏低的命中率，界面上看不出来。累计逻辑本身在 `StatusService` 里，
 * 依赖 vscode 运行时因此不在这里测——这里的输入就是它每收到一次响应时看到的东西。
 */

suite('status / 用量读出', () => {
	test('没有 usage 时全为零，且不算作「报告了缓存」', () => {
		const delta = readUsageDelta(undefined);
		assert.strictEqual(delta.promptTokens, 0);
		assert.strictEqual(delta.completionTokens, 0);
		assert.strictEqual(delta.totalTokens, 0);
		assert.strictEqual(delta.cachedTokens, 0);
		assert.strictEqual(delta.reasoningTokens, 0);
		assert.strictEqual(delta.reportsCache, false);
	});

	test('读 OpenAI 风格的三项基本计数', () => {
		const delta = readUsageDelta({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 });
		assert.strictEqual(delta.promptTokens, 100);
		assert.strictEqual(delta.completionTokens, 20);
		assert.strictEqual(delta.totalTokens, 120);
	});

	test('缺 total_tokens 时按分项之和补齐', () => {
		// 部分网关（以及某些代理层）只透传分项
		const delta = readUsageDelta({ prompt_tokens: 30, completion_tokens: 12 });
		assert.strictEqual(delta.totalTokens, 42);
	});

	test('认 OpenAI 风格的缓存明细（prompt_tokens_details.cached_tokens）', () => {
		const delta = readUsageDelta({
			prompt_tokens: 1000,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 800 },
		});
		assert.strictEqual(delta.cachedTokens, 800);
		assert.strictEqual(delta.reportsCache, true);
	});

	test('认 DeepSeek 风格的前缀缓存字段（prompt_cache_hit_tokens）', () => {
		const delta = readUsageDelta({
			prompt_tokens: 500,
			completion_tokens: 10,
			prompt_cache_hit_tokens: 400,
			prompt_cache_miss_tokens: 100,
		});
		assert.strictEqual(delta.cachedTokens, 400);
		assert.strictEqual(delta.reportsCache, true);
	});

	test('没有任何缓存字段时不算报告了缓存', () => {
		const delta = readUsageDelta({ prompt_tokens: 500, completion_tokens: 10 });
		assert.strictEqual(delta.cachedTokens, 0);
		assert.strictEqual(delta.reportsCache, false, '没字段 ≠ 命中 0');
	});

	test('缓存字段存在但为 0 时，算作「报告了缓存但没命中」', () => {
		const delta = readUsageDelta({
			prompt_tokens: 500,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 0 },
		});
		assert.strictEqual(delta.reportsCache, true);
		assert.strictEqual(delta.cachedTokens, 0);
	});

	test('命中数超过输入时被钳到输入量，避免命中率超过 100%', () => {
		// 上游偶尔给出这种自相矛盾的组合；不钳的话会显示「命中 2000（200%）」
		const delta = readUsageDelta({
			prompt_tokens: 1000,
			completion_tokens: 1,
			prompt_tokens_details: { cached_tokens: 2000 },
		});
		assert.strictEqual(delta.cachedTokens, 1000);
	});

	test('读出思维链 token（明细优先，其次顶层）', () => {
		const detailed: ChatUsage = {
			prompt_tokens: 10,
			completion_tokens: 100,
			completion_tokens_details: { reasoning_tokens: 80 },
		};
		assert.strictEqual(readUsageDelta(detailed).reasoningTokens, 80);
		assert.strictEqual(readUsageDelta({ reasoning_tokens: 30 }).reasoningTokens, 30);
		assert.strictEqual(readUsageDelta({ prompt_tokens: 1 }).reasoningTokens, 0);
	});

	test('数字被序列化成字符串时仍能读出', () => {
		// 有的网关把数字写成字符串，`asNumber` 会兜住
		const delta = readUsageDelta({
			prompt_tokens: '100' as unknown as number,
			completion_tokens: '5' as unknown as number,
		});
		assert.strictEqual(delta.promptTokens, 100);
		assert.strictEqual(delta.completionTokens, 5);
		assert.strictEqual(delta.totalTokens, 105);
	});

	test('缓存命中率的分母是输入而不是总量', () => {
		// 1000 输入里命中 800：命中率 80%，而不是 800/1400
		assert.strictEqual(cacheHitRate(800, 1000), 0.8);
	});

	test('算不出命中率时返回 undefined（没有输入或没有命中）', () => {
		assert.strictEqual(cacheHitRate(0, 1000), undefined);
		assert.strictEqual(cacheHitRate(800, 0), undefined);
	});

	test('命中数异常偏高时命中率仍不超过 1', () => {
		assert.strictEqual(cacheHitRate(5000, 1000), 1);
	});

	test('命中描述带比例，没有比例时只给数量', () => {
		assert.strictEqual(describeCacheHit(800, 1000), '800（80%）');
		assert.strictEqual(describeCacheHit(8200, 12000), '8.2K（68%）');
		// 没有输入量就只剩数量：宁可少给一个数，也不要编一个比例
		assert.strictEqual(describeCacheHit(500, 0), '500');
	});
});

suite('status / 回传给 Copilot 的用量载荷', () => {
	/**
	 * Copilot 侧的采纳条件（`isApiUsage`）：三个字段都必须是 number。
	 * 缺任何一个或者类型不对，整块载荷会被丢掉，会话信息里的上下文窗口就退回 `0/上限`。
	 */
	function isAcceptedByCopilot(payload: unknown): boolean {
		const value = payload as Record<string, unknown>;
		return typeof value.prompt_tokens === 'number'
			&& typeof value.completion_tokens === 'number'
			&& typeof value.total_tokens === 'number';
	}

	test('上游没给用量时不发（与 Copilot 自己的兑底值同义）', () => {
		assert.strictEqual(buildReportedUsage(undefined), undefined);
	});

	test('三个数字字段总是齐的，包括上游只给部分字段时', () => {
		const cases: readonly ChatUsage[] = [
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
			{ prompt_tokens: 100, completion_tokens: 20 },
			{ completion_tokens: 7 },
			{},
		];
		for (const usage of cases) {
			const payload = buildReportedUsage(usage);
			assert.ok(payload !== undefined);
			assert.strictEqual(
				isAcceptedByCopilot(payload),
				true,
				`载荷必须能被 Copilot 采纳：${JSON.stringify(payload)}`,
			);
		}
	});

	test('缺 total_tokens 时按分项之和补齐', () => {
		const payload = buildReportedUsage({ prompt_tokens: 30, completion_tokens: 12 });
		assert.strictEqual(payload?.total_tokens, 42);
	});

	test('缓存命中放在 prompt_tokens_details 下（Copilot 读的就是这里）', () => {
		const payload = buildReportedUsage({
			prompt_tokens: 1000,
			completion_tokens: 10,
			prompt_cache_hit_tokens: 800,
		});
		assert.strictEqual(payload?.prompt_tokens_details.cached_tokens, 800);
	});

	test('没有缓存字段时给 0，而不是省略（省略也得补一个默认值）', () => {
		const payload = buildReportedUsage({ prompt_tokens: 10, completion_tokens: 1 });
		assert.strictEqual(payload?.prompt_tokens_details.cached_tokens, 0);
	});

	test('思维链 token 只在有时才写上', () => {
		const withReasoning = buildReportedUsage({
			prompt_tokens: 10,
			completion_tokens: 100,
			completion_tokens_details: { reasoning_tokens: 80 },
		});
		assert.strictEqual(withReasoning?.completion_tokens_details?.reasoning_tokens, 80);

		const without = buildReportedUsage({ prompt_tokens: 10, completion_tokens: 100 });
		assert.strictEqual(without?.completion_tokens_details, undefined);
	});

	test('载荷可以被 JSON 序列化（它要进 DataPart 的字节）', () => {
		const payload = buildReportedUsage({ prompt_tokens: 1, completion_tokens: 2 });
		assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
	});
});
