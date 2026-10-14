/**
 * 模型信息悬浮窗（tooltip）内容生成。
 *
 * VS Code 会把 `LanguageModelChatInformation.tooltip` 当作 Markdown 渲染，因此这里输出 Markdown。
 * 内容只包含模型身份与窗口/能力数值；数值来源、校正过程、可选思考强度由日志与模型选择器负责，
 * 不在 tooltip 里复述。
 *
 * 不写标题：悬浮卡片自己会渲染模型名。
 *
 * 每项独占一行，且「键」与「值」各自成列对齐（见 `padLabel`）。
 */

import { escapeMarkdown, formatTokens } from '../format';

/** 构建 tooltip 所需的全部事实。由 `modelConfig.ts` 汇总后传入。 */
export interface ModelTooltipFacts {
/** 模型 ID（New API 中的原始标识，也是回传给站点的那个名字） */
	readonly id: string;
	/** 厂商（来自模型数据表或网关） */
	readonly vendor?: string;
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
}

/** 生成 tooltip Markdown。 */
export function buildModelTooltip(facts: ModelTooltipFacts): string {
	const lines: string[] = [];

	// 第一行是身份：ID 用等宽字体，厂商作为补充信息跟在后边
	const identity = [`\`${facts.id}\``];
	if (facts.vendor) {
		identity.push(escapeMarkdown(facts.vendor));
	}
	lines.push(identity.join(' · '));

	// 每个项目独占一行（空行分隔 = Markdown 段落，保证渲染后真的换行）
	const rows: TooltipFact[] = [
		{ label: '输入上限', value: formatTokens(facts.maxInputTokens) },
		{ label: '上下文窗口', value: formatTokens(facts.contextWindow) },
		{ label: '最大输出', value: formatTokens(facts.maxOutputTokens) },
		{ label: '图片输入', value: yesNo(facts.imageInput) },
		{ label: '工具调用', value: yesNo(facts.toolCalling) },
		{ label: '思考', value: yesNo(facts.reasoning) },
	];
	// 标签补齐后再加一个全角间隙，使取值列对齐
	const labelWidth = Math.max(...rows.map(row => [...row.label].length));
	for (const row of rows) {
		lines.push('');
		lines.push(`${padLabel(row.label, labelWidth)}${PAD}${row.value}`);
	}

	return lines.join('\n');
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

function yesNo(value: boolean): string {
	return value ? '✅' : '❌';
}

/** 一行事实：标签与取值。 */
interface TooltipFact {
	readonly label: string;
	readonly value: string;
}

/**
 * 全角空格：补齐标签宽度用。
 *
 * 半角空格在 Markdown 里会被折叠，且宽度小于汉字，撑不出列宽；全角空格与汉字等宽。
 */
const PAD = '\u3000';

/**
 * 把标签补齐到等宽取值的列上。
 *
 * 中文与全角空格在比例字体里等宽，补齐后每行的取值落在同一列。
 */
function padLabel(label: string, width: number): string {
	const length = [...label].length;
	return length >= width ? label : label + PAD.repeat(width - length);
}
