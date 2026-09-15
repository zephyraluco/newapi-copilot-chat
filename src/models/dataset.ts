/**
 * 本地模型数据表。
 *
 * ## 为什么需要它
 *
 * New API 的 `/v1/models` 只返回 `id` / `created` / `owned_by`——既没有上下文窗口，也没有能力位。
 * 而 VS Code 的模型选择器需要 `maxInputTokens` / `maxOutputTokens` / `capabilities`：
 * 估得过小会白白浪费上下文，估得过大则会被上游直接拒绝请求。
 *
 * 因此扩展随包附带一份模型数据表（`data/openrouter-models.json`），由
 * `npm run models:openrouter` 从公开的模型目录生成。它只是优先级中的一环
 * （见 `modelConfig.ts`）：网关返回值与用户覆盖都比它更可信，因为同一模型在不同渠道
 * 的窗口确实可能不同，而网关最清楚自己那条链路。
 *
 * ## 为什么不是源码里的常量表
 *
 * 表的规模在几百条量级，且随厂商发布持续变动。做成独立数据文件的好处：
 * - 更新数据不必改代码，重新生成文件即可；
 * - 数据不进 TypeScript 编译，构建时间与产物体积不受影响；
 * - 校验逻辑只有这一处，坏数据不会变成难以定位的类型错误。
 *
 * ## 数据是「不可信输入」
 *
 * 文件由外部脚本生成，可能缺失、被手工编辑或被截断。因此每条记录都要过一遍类型收窄：
 * 缺 `id`、或缺正数 `contextWindow` / `maxOutputTokens` 的条目直接丢弃并计数，
 * 绝不会因为一条坏记录让整张表失效。表为空时的效果等于「没有这张表」。
 *
 * ## 匹配策略
 *
 * 表里的 `id` 是**规范化**过的（生成脚本剥掉了厂商前缀与 `:free` / `:batch` 变体），
 * 而网关返回的 ID 常带渠道与日期后缀（`gpt-4o@official`、`gpt-4o-2024-08-06`）。
 * 因此查找从精确到宽松逐级尝试：精确命中优先，命中不了才逐层剥掉厂商前缀、
 * 变体后缀、渠道后缀与日期后缀再试。这样 `gpt-4o-2024-08-06` 不会被剥成 `gpt-4o`
 * 而挑错记录，同时手工加的渠道后缀也能认得出来。
 */

import { asBoolean, asNonEmptyString, asPositiveNumber, isRecord } from '../json';

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
	/** 是否具备思维链能力；当前不参与模型配置，仅备查 */
	readonly reasoning?: boolean;
	/** 厂商显示名 */
	readonly vendor?: string;
	/** 规范展示名 */
	readonly displayName?: string;
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
		vendor: asNonEmptyString(raw.vendor),
		displayName: asNonEmptyString(raw.displayName),
	};
}

/**
 * 校验原始数据。
 *
 * 接受生成脚本的完整输出（`{ models: [...] }`）与裸数组两种形态：
 * 前者是数据文件，后者便于测试与手工准备的小表。
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

/** 当前生效的数据表；未加载或没有可用记录时为 `undefined`。 */
let current: ModelDataset | undefined;

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
	current = dataset.entries.length > 0 ? dataset : undefined;
	index = new Map();
	for (const entry of dataset.entries) {
		const key = entry.id.trim().toLowerCase();
		// 同 id 只保留第一条：生成脚本已去重，这里只防御手工编辑
		if (!index.has(key)) {
			index.set(key, entry);
		}
	}
	return dataset;
}

/** 当前数据表（含来源与生成时间，供日志使用）。 */
export function currentModelDataset(): ModelDataset | undefined {
	return current;
}

/** 当前数据表的条目数；未加载时为 0。 */
export function modelDatasetSize(): number {
	return current?.entries.length ?? 0;
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
