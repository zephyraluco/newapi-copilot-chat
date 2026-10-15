/** 展示层格式化工具：值 → 人类可读字符串，不含 VS Code 依赖。 */

/**
 * 把 token 数量格式化成紧凑形式：`128000` → `128K`、`1048576` → `1M`、`999` → `999`。
 * 保留非整数（如 `1.5M`）。
 */
export function formatTokens(count: number | undefined): string {
	if (count === undefined || !Number.isFinite(count) || count <= 0) {
		return '未知';
	}
	if (count >= 1_000_000) {
		return `${trimTrailingZero(count / 1_000_000)}M`;
	}
	if (count >= 1_000) {
		return `${trimTrailingZero(count / 1_000)}K`;
	}
	return String(Math.round(count));
}

/** 去掉小数末尾多余的 0：`1.50` → `1.5`、`2.00` → `2`。 */
function trimTrailingZero(value: number): string {
	return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * 转义 Markdown 中会被解释为语法的字符。
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}
