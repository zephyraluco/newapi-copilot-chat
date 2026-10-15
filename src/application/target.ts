/**
 * 连接目标：一次模型发现 / 对话请求所使用的「站点地址 + API Key」。
 *
 * 配置由 VS Code 提供：`package.json` 的
 * `contributes.languageModelChatProviders[].configuration` 声明 JSON Schema，
 * VS Code 据此生成「管理模型」表单，并随调用传入解析好的值
 * （标了 `secret: true` 的 `apiKey` 已从系统钥匙串解析回明文）。
 *
 * 两条约束：`key` 必须是指纹（不含明文，它会被用作 Map 键并出现在日志里）；
 * 日志一律经 `redactSecret`。
 */

import { isValidBaseUrl, normalizeBaseUrl } from '../shared/url';
import { asNonEmptyString, isRecord } from '../shared/json';
import type { Logger } from '../shared/log';

/** 一个连接目标（对应 VS Code 里的一项配置组）。 */
export interface ProviderTarget {
	/**
	 * VS Code 的配置组名；未命名时为 `undefined`。同一 vendor 的多个组由 VS Code 分别调用，
	 * 因此它也是区分会话的依据。
	 */
	readonly group: string | undefined;
	/** 规范化后的站点根地址 */
	readonly baseUrl: string;
	/** 明文 API Key；未配置时为 `undefined` */
	readonly apiKey: string | undefined;
	/** 人类可读的标签，用于日志与状态栏（不含敏感信息） */
	readonly label: string;
	/** 配置指纹（不含明文），用于判断「同一目标的配置是否变化」 */
	readonly key: string;
	/** 阻塞使用的配置问题；为空表示可用 */
	readonly issues: readonly string[];
}

/** 该目标是否可以发起请求。 */
export function isTargetUsable(target: ProviderTarget): boolean {
	return target.issues.length === 0;
}

/** 日志与状态栏里用的可读描述。 */
export function describeTarget(target: ProviderTarget): string {
	return `${target.label} ${target.baseUrl || '(未配置地址)'}`;
}

/**
 * 计算配置指纹（变更检测用，不是安全哈希）。
 *
 * 用 FNV-1a 而非拼接明文：该值会作为 Map 键并可能出现在日志里，而输入包含 API Key。
 */
function fingerprint(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		// Math.imul 保证按 32 位整数溢出
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * 由 VS Code 下发的配置组构造目标。
 *
 * `configuration` 在 stable API 里类型为 `unknown`，字段名由我们在 `package.json`
 * 的 schema 里声明，因此这里按约定取 `baseUrl` 与 `apiKey`。
 */
export function createTarget(
	group: string | undefined,
	configuration: Record<string, unknown>,
	logger: Logger,
): ProviderTarget {
	const baseUrl = normalizeBaseUrl(asNonEmptyString(configuration.baseUrl));
	const apiKey = asNonEmptyString(configuration.apiKey);
	const issues: string[] = [];

	if (baseUrl.length === 0) {
		issues.push('尚未填写站点地址');
	} else if (!isValidBaseUrl(baseUrl)) {
		issues.push(`站点地址不合法：${baseUrl}（需要以 http:// 或 https:// 开头）`);
	}
	if (apiKey === undefined) {
		issues.push('尚未填写 API Key');
	}

	const trimmedGroup = group === undefined ? undefined : asNonEmptyString(group);
	const label = trimmedGroup === undefined ? 'New API' : `New API · ${trimmedGroup}`;
	if (issues.length > 0) {
		// 配置不完整时明确记录，否则用户只能看到「没有模型」
		logger.warn(`${label} 配置不完整：${issues.join('；')}`);
	}

	return {
		group: trimmedGroup,
		baseUrl,
		apiKey,
		label,
		key: `${trimmedGroup ?? ''}:${fingerprint(`${baseUrl}\n${apiKey ?? ''}`)}`,
		issues,
	};
}

/**
 * 从 provider 的 `options` 里读取组名。
 *
 * stable 的 `PrepareLanguageModelChatModelOptions` 只声明了 `silent`，
 * `group` / `configuration` 由 VS Code 在提供组配置时传入，因此这里做运行时探测。
 */
export function readOptionsGroup(options: unknown): string | undefined {
	if (!isRecord(options)) {
		return undefined;
	}
	return asNonEmptyString(options.group);
}

/** 从 provider 的 `options` 里读取配置组内容。 */
export function readOptionsConfiguration(options: unknown): Record<string, unknown> | undefined {
	if (!isRecord(options)) {
		return undefined;
	}
	const value = options.configuration;
	return isRecord(value) ? value : undefined;
}
