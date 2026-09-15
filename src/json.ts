/**
 * JSON 辅助函数。
 *
 * 只放「无副作用、无外部依赖」的纯函数。目标是把「解析不可信数据」的防御性代码
 * 收敛到一处，让 client / models 层可以直白地写业务逻辑，而不是满屏
 * `typeof x === 'object' && x !== null && ...`。
 */

/** 判断是否为普通对象（排除 `null` 与数组）。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断是否为非空字符串（纯空白也算空）。 */
export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0;
}

/** 安全解析 JSON 字符串。失败返回 `undefined`，不抛异常。 */
export function safeJsonParse<T = unknown>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

/**
 * 安全序列化。
 *
 * 遇到循环引用、BigInt 等不可序列化的值返回 `undefined` 而不是抛异常——
 * 调用点通常只是想把日志/参数转成字符串，不该因此让请求失败。
 */
export function safeJsonStringify(value: unknown, space?: number): string | undefined {
	try {
		return JSON.stringify(value, undefined, space);
	} catch {
		return undefined;
	}
}

/* -------------------------------------------------------------------------- */
/* 类型收窄                                                                    */
/* -------------------------------------------------------------------------- */

/** 取非空字符串（纯空白视为缺失）。 */
export function asNonEmptyString(value: unknown): string | undefined {
	return isNonEmptyString(value) ? value.trim() : undefined;
}

/** 取有限数字；数字字符串也会被解析（网关偶尔把数字序列化成字符串）。 */
export function asNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

/** 取正数；`<= 0` 一律视为缺失（用于 token 上限、超时这类不允许为 0 的字段）。 */
export function asPositiveNumber(value: unknown): number | undefined {
	const num = asNumber(value);
	return num !== undefined && num > 0 ? num : undefined;
}

/** 取布尔；同时接受 `'true'` / `'false'` 字符串。 */
export function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		const lowered = value.trim().toLowerCase();
		if (lowered === 'true') {
			return true;
		}
		if (lowered === 'false') {
			return false;
		}
	}
	return undefined;
}

/** 取字符串数组；数组内的非字符串元素会被丢弃。 */
export function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const result = value.filter((item): item is string => typeof item === 'string');
	return result.length > 0 ? result : undefined;
}

/* -------------------------------------------------------------------------- */
/* 按键取值                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 从对象中按候选键依次取字符串，返回第一个非空值。
 *
 * 用于兼容同一语义在不同网关上的多种字段名（例如上下文窗口的
 * `context_length` / `context_window` / `max_context_tokens`）。
 */
export function pickString(source: unknown, keys: readonly string[]): string | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	for (const key of keys) {
		const value = asNonEmptyString(source[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/** 从对象中按候选键依次取正数，返回第一个合法值。 */
export function pickNumber(source: unknown, keys: readonly string[]): number | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	for (const key of keys) {
		const value = asPositiveNumber(source[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/** 从对象中按候选键依次取布尔值，返回第一个合法值。 */
export function pickBoolean(source: unknown, keys: readonly string[]): boolean | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	for (const key of keys) {
		const value = asBoolean(source[key]);
		if (value !== undefined) {
			return value;
		}
	}
	return undefined;
}

/** 按键取嵌套对象。 */
export function pickRecord(source: unknown, key: string): Record<string, unknown> | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	const value = source[key];
	return isRecord(value) ? value : undefined;
}

/* -------------------------------------------------------------------------- */
/* 文本                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 截断文本，超长时追加省略号。
 *
 * 用 `Array.from` 按「码点」而非「UTF-16 单元」切分，避免把 emoji 或
 * 罕见汉字从中间劈开产生乱码。
 */
export function truncate(text: string, maxLength: number, ellipsis = '…'): string {
	if (maxLength <= 0) {
		return '';
	}
	const codePoints = Array.from(text);
	if (codePoints.length <= maxLength) {
		return text;
	}
	return codePoints.slice(0, maxLength).join('') + ellipsis;
}
