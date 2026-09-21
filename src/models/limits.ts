/**
 * 数值一致性校正：窗口、输出上限、输入上限三者之间的关系。
 *
 * 三路来源（网关 / 数据表 / 默认值）合起来很容易得到自相矛盾的数值
 * （例如数据表说窗口 8K，网关却说输出上限 16K），直接透传给 VS Code 会导致请求被上游拒绝，
 * 或者出现「输入上限 > 上下文窗口」的怪状态。
 *
 * 这里统一收敛，并把**每一次修正**记录成一行说明——由调用方写进日志。
 * 校正不能静默：用户看到被下调的数字时，得有个地方能查出原因。
 * 因此 `reconcileLimits` 保持纯函数、不碰 logger，只把说明作为返回值交出去。
 */

import { DEFAULTS } from '../consts';
import { formatTokens } from '../format';

/** 单个模型注解：保证模型至少能输出这么多 token，否则它的价值低于成本。 */
export const MIN_OUTPUT_TOKENS = 256;

/** 收敛后的数值与说明。 */
export interface ReconciledLimits {
	readonly contextWindow: number;
	readonly maxOutputTokens: number;
	readonly maxInputTokens: number;
	/** 每一次修正的说明，供调用方写日志 */
	readonly adjustments: readonly string[];
}

/**
 * 校正窗口/输出/输入三者之间的关系。
 *
 * 不变量：
 * - `maxInputTokens + maxOutputTokens <= contextWindow`；
 * - 输出上限不挤占整个输入空间（至少给输入留 1/4 窗口，且不低于 `minInputTokens`）；
 * - 各值不低于合理下限（窗口 `minContextWindow`、输出 `MIN_OUTPUT_TOKENS`）。
 */
export function reconcileLimits(input: {
	contextWindow: number;
	maxOutputTokens: number;
	maxInputTokens: number | undefined;
}): ReconciledLimits {
	const adjustments: string[] = [];

	let contextWindow = Math.round(input.contextWindow);
	if (!Number.isFinite(contextWindow) || contextWindow < DEFAULTS.minContextWindow) {
		adjustments.push(`上下文窗口 ${input.contextWindow} 过小，已按最小值 ${DEFAULTS.minContextWindow} 处理。`);
		contextWindow = DEFAULTS.minContextWindow;
	}

	let maxOutputTokens = Math.round(input.maxOutputTokens);
	if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < MIN_OUTPUT_TOKENS) {
		maxOutputTokens = MIN_OUTPUT_TOKENS;
	}

	// 至少给输入留 1/4 窗口（且不低于 minInputTokens），否则把输出压回来
	const minInput = Math.max(DEFAULTS.minInputTokens, Math.floor(contextWindow / 4));
	if (contextWindow - maxOutputTokens < minInput) {
		const clamped = Math.max(MIN_OUTPUT_TOKENS, contextWindow - minInput);
		if (clamped !== maxOutputTokens) {
			adjustments.push(
				`最大输出 ${formatTokens(maxOutputTokens)} 会挤占输入空间，已下调为 ${formatTokens(clamped)}。`,
			);
			maxOutputTokens = clamped;
		}
	}

	const ceiling = Math.max(DEFAULTS.minInputTokens, contextWindow - maxOutputTokens);
	let maxInputTokens = input.maxInputTokens === undefined
		? ceiling
		: Math.max(DEFAULTS.minInputTokens, Math.min(Math.round(input.maxInputTokens), contextWindow));
	if (input.maxInputTokens !== undefined && maxInputTokens > ceiling) {
		adjustments.push(
			`输入上限 ${formatTokens(input.maxInputTokens)} 与上下文窗口冲突，已收敛为 ${formatTokens(ceiling)}。`,
		);
		maxInputTokens = ceiling;
	}

	return { contextWindow, maxOutputTokens, maxInputTokens, adjustments };
}

/**
 * 判断两个窗口是否「显著不同」：差值超过 10% 才算。
 *
 * 网关常用 `128000`、数据表可能写 `131072`——这类量级相同、写法不同的值不该被报成冲突，
 * 否则日志里每天都会出现一堆没有信息量的「不一致」。
 */
export function isSignificantlyDifferent(a: number, b: number): boolean {
	const larger = Math.max(a, b);
	const smaller = Math.min(a, b);
	if (larger <= 0) {
		return false;
	}
	return (larger - smaller) / larger > 0.1;
}
