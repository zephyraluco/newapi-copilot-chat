/**
 * 数值一致性校正：窗口、输出上限、输入上限三者之间的关系。
 *
 * 三路来源（网关 / 数据表 / 默认值）可能自相矛盾，这里统一收敛，
 * 并把每一次修正记录成说明交给调用方写日志；
 * `reconcileLimits` 是纯函数、不碰 logger，只把说明作为返回值交出去。
 */

import { DEFAULTS } from '../shared/consts';
import { formatTokens } from '../shared/format';

/** 输出上限的最小值。 */
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
 * 判断两个窗口是否显著不同：相对差值超过 10% 才算。
 *
 * 量级相同的写法差异（网关 `128000` 与数据表 `131072`）不算冲突。
 */
export function isSignificantlyDifferent(a: number, b: number): boolean {
	const larger = Math.max(a, b);
	const smaller = Math.min(a, b);
	if (larger <= 0) {
		return false;
	}
	return (larger - smaller) / larger > 0.1;
}
