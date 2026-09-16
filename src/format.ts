/**
 * 展示层格式化工具。
 *
 * 只做「值 → 人类可读字符串」的转换，不含任何 VS Code 依赖，
 * 因此 logger、状态栏、面板、tooltip 可以共用同一套口径。
 */

/**
 * 把 token 数量格式化成紧凑形式。
 *
 * 例：`128000` → `128K`、`1048576` → `1M`、`999` → `999`。
 * 刻意保留非整数（如 `1.5M`），因为上下文窗口确实存在这种取值。
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

/** 把毫秒格式化成简短时长：`860` → `860ms`、`2400` → `2.4s`、`65000` → `1m5s`。 */
export function formatDurationMs(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
		return '未知';
	}
	if (ms < 1000) {
		return `${Math.round(ms)}ms`;
	}
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) {
		return `${trimTrailingZero(totalSeconds)}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}

/**
 * 把时间戳格式化成相对时间：`刚刚` / `3 分钟前` / `2 小时前` / `昨天`。
 *
 * @param timestamp 毫秒时间戳；`undefined` 表示从未发生。
 */
export function formatRelativeTime(timestamp: number | undefined, now = Date.now()): string {
	if (timestamp === undefined || !Number.isFinite(timestamp)) {
		return '从未';
	}
	const diff = Math.max(0, now - timestamp);
	const seconds = Math.floor(diff / 1000);
	if (seconds < 10) {
		return '刚刚';
	}
	if (seconds < 60) {
		return `${seconds} 秒前`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes} 分钟前`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours} 小时前`;
	}
	const days = Math.floor(hours / 24);
	return days === 1 ? '昨天' : `${days} 天前`;
}

/**
 * 转义 Markdown 中会被解释为语法的字符（用于 tooltip 里的动态文本）。
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/([\\`*_{}[\]()#+\-.!|>])/g, '\\$1');
}
