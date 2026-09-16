/**
 * 简易 glob 匹配。include / exclude 只支持 `*`（任意长度字符）与 `?`（单个字符），
 * 匹配大小写不敏感（模型 ID 的大小写在各网关之间并不统一）。
 *
 * 刻意不引入 minimatch 之类的依赖：模型 ID 过滤用不到 `**`、字符组与扩展语法。
 */

/** 把 glob 编译成正则。特殊字符会先转义，避免 `gpt-4.1` 里的 `.` 变成通配。 */
export function globToRegExp(pattern: string): RegExp {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
	return new RegExp(`^${body}$`, 'i');
}

/** 单条匹配。 */
export function matchGlob(value: string, pattern: string): boolean {
	return globToRegExp(pattern).test(value);
}

/** 判断值是否命中任意模式。 */
export function matchAnyGlob(value: string, patterns: readonly string[]): boolean {
	return patterns.some(pattern => matchGlob(value, pattern));
}

/**
 * 解释一条过滤结果，用于日志。
 *
 * 返回 `undefined` 表示未被过滤；否则返回被哪条规则过滤。
 */
export function findFilteringPattern(
	value: string,
	include: readonly string[],
	exclude: readonly string[],
): { readonly kind: 'exclude' | 'include'; readonly pattern: string } | undefined {
	const excluded = exclude.find(pattern => matchGlob(value, pattern));
	if (excluded !== undefined) {
		return { kind: 'exclude', pattern: excluded };
	}
	if (include.length > 0) {
		const included = include.find(pattern => matchGlob(value, pattern));
		if (included === undefined) {
			return { kind: 'include', pattern: include.join(', ') };
		}
	}
	return undefined;
}
