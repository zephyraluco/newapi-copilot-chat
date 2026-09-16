/**
 * 模型信息悬浮窗（tooltip）内容生成。
 *
 * VS Code 会把 `LanguageModelChatInformation.tooltip` 当作 **Markdown** 渲染，
 * 因此这里输出 Markdown 而不是纯文本。
 *
 * 内容取舍：tooltip 是「鼠标悬停一瞥」的场景，不放长文。所以只保留
 * 用户真正会用来判断「这个模型能不能干这件事」的信息，并**明确标注每个数值的来源**——
 * 数据表是生成时的快照，会随厂商调整而过时，用户需要知道该不该相信它。
 */

import { escapeMarkdown, formatTokens, formatUnixSeconds } from '../format';
import type { ModelConfigSource } from './modelConfig';

/** 构建 tooltip 所需的全部事实。由 `modelConfig.ts` 汇总后传入。 */
export interface ModelTooltipFacts {
	/** 模型 ID（New API 中的原始标识） */
	readonly id: string;
	/** 规范展示名（来自模型数据表或网关） */
	readonly displayName?: string;
	/** 规范 family 名 */
	readonly family: string;
	/** 归属方（来自 `/v1/models` 的 `owned_by`） */
	readonly ownedBy?: string;
	/** 厂商（来自模型数据表或网关） */
	readonly vendor?: string;
	/** 模型创建时间（Unix 秒） */
	readonly created?: number;
	/** 校正后的上下文窗口 */
	readonly contextWindow: number;
	/** 校正后的输入上限 */
	readonly maxInputTokens: number;
	/** 校正后的最大输出 */
	readonly maxOutputTokens: number;
	readonly imageInput: boolean;
	readonly toolCalling: boolean;
	/** 模型是否具备思考（思维链）能力 */
	readonly reasoning: boolean;
	/** 该模型可选的思考强度；`reasoning` 为 `false` 时不展示 */
	readonly reasoningEfforts: readonly string[];
	/** 不指定思考强度时的上游默认取值 */
	readonly defaultReasoningEffort?: string;
	readonly description?: string;
	/** 命中的模型数据表键 */
	readonly datasetKey?: string;
	/** 各字段的来源 */
	readonly provenance: Readonly<Record<string, ModelConfigSource>>;
	/** 需要提醒用户的事项（数值冲突、被校正等） */
	readonly notes: readonly string[];
}

/** 来源的中文说明。导出给状态面板复用，保证两处口径一致。 */
export const MODEL_SOURCE_LABEL: Record<ModelConfigSource, string> = {
	remote: '网关返回值',
	dataset: '模型数据表',
	default: '默认值',
};

/** 生成 tooltip Markdown。 */
export function buildModelTooltip(facts: ModelTooltipFacts): string {
	const lines: string[] = [];

	lines.push(`### ${escapeMarkdown(facts.displayName ?? facts.id)}`);
	lines.push(`\`${facts.id}\``);

	const metaParts: string[] = [];
	if (facts.vendor) {
		metaParts.push(escapeMarkdown(facts.vendor));
	}
	if (facts.ownedBy && facts.ownedBy !== facts.vendor) {
		metaParts.push(`归属 ${escapeMarkdown(facts.ownedBy)}`);
	}
	if (facts.family) {
		metaParts.push(`family \`${facts.family}\``);
	}
	if (metaParts.length > 0) {
		lines.push('');
		lines.push(metaParts.join(' · '));
	}

	lines.push('');
	lines.push(`| 项目 | 值 | 来源 |`);
	lines.push(`| --- | --- | --- |`);
	lines.push(
		`| 上下文窗口 | ${formatTokens(facts.contextWindow)} | ${sourceLabel(facts.provenance.contextWindow)} |`,
	);
	lines.push(
		`| 输入上限 | ${formatTokens(facts.maxInputTokens)} | ${sourceLabel(facts.provenance.maxInputTokens)} |`,
	);
	lines.push(
		`| 最大输出 | ${formatTokens(facts.maxOutputTokens)} | ${sourceLabel(facts.provenance.maxOutputTokens)} |`,
	);
	lines.push(`| 图片输入 | ${yesNo(facts.imageInput)} | ${sourceLabel(facts.provenance.imageInput)} |`);
	lines.push(`| 工具调用 | ${yesNo(facts.toolCalling)} | ${sourceLabel(facts.provenance.toolCalling)} |`);
	lines.push(`| 思考 | ${yesNo(facts.reasoning)} | ${sourceLabel(facts.provenance.reasoning)} |`);
	if (facts.created !== undefined) {
		lines.push(`| 创建时间 | ${formatUnixSeconds(facts.created)} | 网关返回值 |`);
	}

	if (facts.description) {
		lines.push('');
		lines.push(escapeMarkdown(facts.description));
	}

	if (facts.datasetKey) {
		lines.push('');
		lines.push(`> 模型数据表命中：\`${facts.datasetKey}\``);
	}

	if (facts.reasoningEfforts.length > 0) {
		// 用原值：取值词汇是上游的，翻译过的档位名反而对不上站点文档
		const options = facts.reasoningEfforts.map(effort => escapeMarkdown(effort)).join(' / ');
		const fallback = facts.defaultReasoningEffort === undefined
			? ''
			: `未选择时 ${factName(facts)} 自身的默认值是 ${escapeMarkdown(facts.defaultReasoningEffort)}。`;
		lines.push('');
		lines.push(`> 可在模型选择器里调整「思考强度」：${options}。${fallback}`);
	}

	if (facts.notes.length > 0) {
		lines.push('');
		for (const note of facts.notes) {
			lines.push(`> ⚠️ ${escapeMarkdown(note)}`);
		}
	}

	lines.push('');
	lines.push('---');
	lines.push('数值来自随包的模型数据表（`npm run models:openrouter` 生成），可能与站点实际情况有出入。');

	return lines.join('\n');
}

/** 说明里用的模型称呼：有展示名就用它，否则用 ID（转义后用于 Markdown）。 */
function factName(facts: ModelTooltipFacts): string {
	return escapeMarkdown(facts.displayName ?? facts.id);
}

/** 生成模型选择器中显示的一行副标题。 */
export function buildModelDetail(facts: {
	readonly vendor?: string;
	readonly ownedBy?: string;
	readonly contextWindow: number;
	readonly toolCalling: boolean;
}): string {
	const parts: string[] = [];
	const owner = facts.vendor ?? facts.ownedBy;
	if (owner) {
		parts.push(owner);
	}
	parts.push(`${formatTokens(facts.contextWindow)} 上下文`);
	if (facts.toolCalling) {
		parts.push('工具');
	}
	return parts.join(' · ');
}

function sourceLabel(source: ModelConfigSource | undefined): string {
	return source === undefined ? '未知' : MODEL_SOURCE_LABEL[source];
}

function yesNo(value: boolean): string {
	return value ? '✅' : '❌';
}
