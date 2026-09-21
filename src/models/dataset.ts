/**
 * 本地模型数据表。
 *
 * New API 的 `/v1/models` 只返回 `id` / `created` / `owned_by`，而 VS Code 需要
 * `maxInputTokens` / `maxOutputTokens` / `capabilities`：估小了浪费上下文，估大了会被上游拒请求。
 * 数据表就是这些元数据的来源，由 `npm run models:openrouter` 生成，激活时读入内存。
 * 它是**只读的生成产物**，要更新数据就重跑生成脚本。
 *
 * 三个要点：
 * - **不可信输入**：文件由外部脚本生成，每条记录都过类型收窄；缺 `id` 或缺正数窗口/输出上限的
 *   条目丢弃并计数，一条坏记录不会让整张表失效。表为空等价于「没有这张表」。
 * - **匹配从精确到宽松**：表里的 `id` 已规范化（无厂商前缀与 `:free` / `:batch` 变体），
 *   而网关 ID 常带渠道与日期后缀（`gpt-4o@official`、`gpt-4o-2024-08-06`）。先精确命中，
 *   命中不了才逐层剥前缀、变体、渠道、日期后缀；「先精确」保证 `gpt-4o-2024-08-06`
 *   不会挑中 `gpt-4o`。
 * - **思考档位用上游原词**：`supportsReasoningEffort` / `defaultReasoningEffort` 可选，
 *   取值是 `max` / `xhigh` / `minimal` 这类上游词汇，只是「能选哪些档」的提示，
 *   是否被站点接受取决于站点与它的上游。
 */

import { asBoolean, asNonEmptyString, asPositiveNumber, asStringArray, isRecord } from '../json';

/** 数据表所在目录（相对于扩展根目录）。 */
export const MODEL_DATASET_DIR = 'data';

/** 数据表文件名。 */
export const MODEL_DATASET_FILE = 'openrouter-models.json';

/** 一条模型记录。字段名与生成脚本的输出对齐。 */
export interface ModelDatasetEntry {
	/** 已规范化的模型 ID（无厂商前缀、无变体后缀） */
	readonly id: string;
	/** 上下文窗口（输入 + 输出） */
	readonly contextWindow: number;
	/** 单次响应的最大输出 token */
	readonly maxOutputTokens: number;
	/** 是否支持图片输入 */
	readonly imageInput: boolean;
	/** 是否支持工具调用 */
	readonly toolCalling: boolean;
	/** 是否具备思维链能力；决定模型选择器里是否出现「思考强度」选项 */
	readonly reasoning?: boolean;
	/**
	 * 该模型可选的思考强度（上游词汇，由强到弱）。
	 *
	 * 只在上游确实给出强度列表时才存在：有些模型会思考但不能调强度。
	 */
	readonly supportsReasoningEffort?: readonly string[];
	/** 不指定思考强度时上游使用的取值 */
	readonly defaultReasoningEffort?: string;
	/** 厂商显示名 */
	readonly vendor?: string;
	/** 规范展示名 */
	readonly displayName?: string;
}

/**
 * 收拢思考强度列表：去空白、去重、保序（上游由强到弱排列，顺序有语义）。
 *
 * 全空时返回 `undefined`，调用方据此区分「没有这个信息」与「有但为空」。
 */
function normalizeEfforts(value: unknown): readonly string[] | undefined {
	const list = asStringArray(value);
	if (list === undefined) {
		return undefined;
	}
	const result: string[] = [];
	for (const item of list) {
		const trimmed = item.trim();
		if (trimmed.length > 0 && !result.includes(trimmed)) {
			result.push(trimmed);
		}
	}
	return result.length > 0 ? result : undefined;
}

/** 解析后的数据表。 */
export interface ModelDataset {
	readonly entries: readonly ModelDatasetEntry[];
	/** 被丢弃的条目数，用于在日志里说明数据表的质量 */
	readonly skipped: number;
	/** 生成时间（ISO 字符串） */
	readonly generatedAt?: string;
	/** 数据来源 URL */
	readonly source?: string;
}

/** 一次查找的结果。 */
export interface ModelDatasetMatch {
	readonly entry: ModelDatasetEntry;
	/** 命中的键（表里的 `id`），用于在 UI 里说明依据 */
	readonly key: string;
}

/** 把一条原始记录收窄成 `ModelDatasetEntry`；不合法返回 `undefined`。 */
function parseEntry(raw: unknown): ModelDatasetEntry | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const id = asNonEmptyString(raw.id);
	const contextWindow = asPositiveNumber(raw.contextWindow);
	const maxOutputTokens = asPositiveNumber(raw.maxOutputTokens);
	if (id === undefined || contextWindow === undefined || maxOutputTokens === undefined) {
		return undefined;
	}
	return {
		id,
		contextWindow: Math.round(contextWindow),
		maxOutputTokens: Math.round(maxOutputTokens),
		// 「字段缺失」与「明确为 false」在配置层的效果相同，因此统一收敛成 false
		imageInput: asBoolean(raw.imageInput) ?? false,
		toolCalling: asBoolean(raw.toolCalling) ?? false,
		reasoning: asBoolean(raw.reasoning),
		supportsReasoningEffort: normalizeEfforts(raw.supportsReasoningEffort),
		defaultReasoningEffort: asNonEmptyString(raw.defaultReasoningEffort),
		vendor: asNonEmptyString(raw.vendor),
		displayName: asNonEmptyString(raw.displayName),
	};
}

/**
 * 校验原始数据。
 *
 * 接受生成脚本的完整输出（`{ models: [...] }`）与裸数组两种形态：
 * 前者是数据文件，后者便于手工准备的小表。
 */
export function parseModelDataset(raw: unknown): ModelDataset {
	const list = Array.isArray(raw)
		? raw
		: (isRecord(raw) && Array.isArray(raw.models) ? raw.models : []);

	let skipped = 0;
	const entries: ModelDatasetEntry[] = [];
	for (const item of list) {
		const entry = parseEntry(item);
		if (entry === undefined) {
			skipped++;
			continue;
		}
		entries.push(entry);
	}

	return {
		entries,
		skipped,
		generatedAt: isRecord(raw) ? asNonEmptyString(raw.generatedAt) : undefined,
		source: isRecord(raw) ? asNonEmptyString(raw.source) : undefined,
	};
}

/** `id` → 记录 的索引。键统一小写，因此匹配大小写不敏感。 */
let index = new Map<string, ModelDatasetEntry>();

/**
 * 安装数据表。
 *
 * 传入 `undefined` 或非法数据会**清空**当前数据表——这正是想要的行为：
 * 文件缺失或损坏时宁可退回「网关返回值 + 默认值」，也不要继续沿用一份来路不明的旧数据。
 *
 * 返回解析结果（含被丢弃的条目数），便于调用方写日志。
 */
export function installModelDataset(raw: unknown): ModelDataset {
	const dataset = parseModelDataset(raw);
	index = new Map();
	for (const entry of dataset.entries) {
		const key = entry.id.trim().toLowerCase();
		// 同 id 只保留第一条：生成脚本已去重，这里只防御意外重复
		if (!index.has(key)) {
			index.set(key, entry);
		}
	}
	return dataset;
}

/**
 * 按「从精确到宽松」生成候选键。
 *
 * 顺序是语义的一部分：先精确匹配，命中不了才逐层剥后缀。每一步都基于上一步的结果，
 * 因此 `anthropic/claude-3-5-sonnet:free@official` 会被依次试成
 * `claude-3-5-sonnet:free@official` → `claude-3-5-sonnet:free` → `claude-3-5-sonnet`。
 */
export function datasetKeysFor(modelId: string): readonly string[] {
	const keys: string[] = [];
	const push = (value: string): void => {
		const key = value.trim().toLowerCase();
		if (key.length > 0 && !keys.includes(key)) {
			keys.push(key);
		}
	};

	push(modelId);
	// 厂商前缀：`~anthropic/claude-sonnet-4`（`~` 是 latest 别名标记）
	const withoutVendor = modelId.replace(/^~?[^/]*\//, '');
	push(withoutVendor);
	// 变体后缀：`:free` / `:batch`
	const withoutVariant = withoutVendor.replace(/:[^:]*$/, '');
	push(withoutVariant);
	// 渠道后缀：`@official`
	const withoutChannel = withoutVariant.replace(/@[\w.-]+$/, '');
	push(withoutChannel);
	// 日期后缀：`-2024-08-06` / `-20240806`
	push(withoutChannel.replace(/[-_.]\d{4}-\d{2}-\d{2}$/, '').replace(/[-_.]?\d{8}$/, ''));

	return keys;
}

/** 按模型 ID 查数据表。未加载或未命中时返回 `undefined`。 */
export function matchModelDataset(modelId: string): ModelDatasetMatch | undefined {
	if (index.size === 0) {
		return undefined;
	}
	for (const key of datasetKeysFor(modelId)) {
		const entry = index.get(key);
		if (entry !== undefined) {
			return { entry, key };
		}
	}
	return undefined;
}
