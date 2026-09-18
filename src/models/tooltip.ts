/**
 * 模型信息悬浮窗（tooltip）内容生成。
 *
 * VS Code 会把 `LanguageModelChatInformation.tooltip` 当作 **Markdown** 渲染，因此这里输出 Markdown。
 * tooltip 是「鼠标悬停一瞥」的场景，因此只回答两件事：**这是哪个模型**、**它有多大、能干什么**。
 * 数值从哪来、与数据表冲突时已采用谁、有哪些思考强度可选——这些各有归属（日志里能看到取值与校正，
 * 模型选择器里能选档位），在这里复述只会把每次悬停都变成读一张表。
 *
 * 刻意**不写标题**：悬浮卡片自己会渲染模型名，再写一遍就是两行同一个东西；第一行直接是身份。
 *
 * 布局上每项独占一行，且「键」与「值」各自成列：挤成一行时折行位置由悬浮窗宽度决定，会出现「读到
 * 一半被折断」的错觉；标签长度再不一时，取值又是参差的锯齿。对齐办法见 `padLabel`。
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

	// 第一行是身份：ID 用等宽字体（它是回传给站点的那个名字），厂商作为补充信息跟在后边
	const identity = [`\`${facts.id}\``];
	if (facts.vendor) {
		identity.push(escapeMarkdown(facts.vendor));
	}
	lines.push(identity.join(' · '));

	// 每个项目独占一行（空行分隔 = Markdown 的段落，保证渲染后真的换行）
	const rows: TooltipFact[] = [
		{ label: '输入上限', value: formatTokens(facts.maxInputTokens) },
		{ label: '上下文窗口', value: formatTokens(facts.contextWindow) },
		{ label: '最大输出', value: formatTokens(facts.maxOutputTokens) },
		{ label: '图片输入', value: yesNo(facts.imageInput) },
		{ label: '工具调用', value: yesNo(facts.toolCalling) },
		{ label: '思考', value: yesNo(facts.reasoning) },
	];
	// 标签补齐后再加一个全角间隙：取值列对齐，最长的标签也有明确间隔
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
 * 全角空格：补位用。
 *
 * 半角空格在 Markdown 里会被折叠成一个（且宽度远小于汉字），撑不出列宽；
 * 全角空格与汉字等宽，才能让补齐真的对齐。
 */
const PAD = '\u3000';

/**
 * 把标签补到等宽，使取值列对齐。
 *
 * tooltip 用比例字体、宽度只有 300px，但中文与全角空格在字体里等宽，因此补齐后每一行的取值都落在
 * 同一列上，键与值之间也有统一可读的间隙。
 */
function padLabel(label: string, width: number): string {
	const length = [...label].length;
	return length >= width ? label : label + PAD.repeat(width - length);
}
