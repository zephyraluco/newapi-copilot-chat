/**
 * HTTP 400 的自愈阶梯：站点不认某个字段时，去掉那个字段再试一次。
 *
 * 400 的常见成因不是「请求写错了」，而是**我们加了一个站点不认的可选字段**：拿用量的
 * `stream_options`、采样参数 `temperature`、思考强度 `reasoning_effort`、`tool_choice`，
 * 或是用户在 `extraBody` 里填的网关专属参数。这些字段都是可选的——去掉之后请求仍然成立，
 * 用户只是少一项增强，而不是拿到一句「请求失败」。
 *
 * 四条边界：
 *
 * - **只对 400 生效**。其它 4xx（401/403/404/429）去掉字段也救不回来，重试只会多花一次请求。
 * - **只在白名单里挑，不从响应里"猜"**。响应文本只用来**决定先去白名单里的哪一个**；
 *   能被去掉的字段永远是「我们自己加进去的可选项」（见 `REPAIRABLE_FIELDS` 与调用方传进来的
 *   `extraBody` 键）。这条边界是硬的：早先的实现把响应体里任何带引号、且请求里存在的字段名
 *   都当作「上游不认的字段」，于是 `{"param":"tools"}` 这种「工具 schema 不合法」的错误会把
 *   **整个 `tools` 删掉**——模型突然变笨，而用户看不到任何错误。`tools` 与协议骨架现在受
 *   `PROTECTED_REQUEST_FIELDS` 保护，任何路径都删不到它们。
 * - **每轮的改动必须真的发生**（去重、且必须删掉一个存在的字段），否则返回 `undefined`，
 *   由调用方正常失败。轮数上限由调用方控制（`DEFAULTS.requestRepairRounds`）。
 * - **结果按会话与模型记住**（`RepairMemory`）：某个站点不认 `temperature` 是**稳定事实**，
 *   不该让 Agent 的每一步都先挨一次 400 再重发。
 *
 * 本模块是纯函数：不依赖 `vscode`，也不发请求，因此可以被直接单测。
 */

import { DEFAULT_REASONING_EFFORT_FIELD, DEFAULT_THINKING_FIELD } from '../consts';
import type { ChatCompletionRequest } from '../types';

/**
 * 允许被自愈去掉的字段：**只包含我们自己往请求体里加的可选项**。
 *
 * 判断标准是「去掉之后请求仍然成立，用户只是少一项增强」。不满足这条的字段一律不进白名单——
 * 尤其是 `tools`：去掉它不会让请求失败，但会让模型没法干活。
 */
const REPAIRABLE_FIELDS: readonly string[] = [
	'temperature',
	'top_p',
	DEFAULT_REASONING_EFFORT_FIELD,
	'tool_choice',
	'max_tokens',
	'max_completion_tokens',
	DEFAULT_THINKING_FIELD,
];

/**
 * 绝不能去掉的字段：请求体没有它们就不成立，或者去掉之后语义完全变了。
 *
 * `tools` 在这里而不是在白名单里：上游抱怨工具 schema 不合法时，正确的结果是**报错**，
 * 而不是把工具悄悄删掉。
 */
const PROTECTED_REQUEST_FIELDS: ReadonlySet<string> = new Set(['model', 'messages', 'stream', 'tools']);

/** 一次修复计划。 */
export interface RepairPlan {
	/** 步骤标识，用于去重与日志 */
	readonly id: string;
	/** 改写后的请求体 */
	readonly request: ChatCompletionRequest;
	/** 为 `false` 时本次请求不要再带 `stream_options`（它由客户端加上，不在请求体里） */
	readonly includeUsage?: boolean;
	/** 写进日志的一句话 */
	readonly note: string;
}

/** 一条修复规则。 */
interface RepairRule {
	readonly id: string;
	/** 响应体里出现这个就认为站点在抱怨这个字段 */
	readonly signal: RegExp;
	/** 请求里确实有它才值得试 */
	readonly applies: (request: ChatCompletionRequest) => boolean;
	/** 改写请求体；改不动时返回 `undefined` */
	readonly plan: (request: ChatCompletionRequest) => RepairPlan | undefined;
}

/** 删掉若干字段；一个都没删掉时返回 `undefined`（表示这次修复什么也没改）。 */
function dropFields(request: ChatCompletionRequest, keys: readonly string[]): ChatCompletionRequest | undefined {
	const next: ChatCompletionRequest = { ...request };
	const fields = next as Record<string, unknown>;
	let changed = false;
	for (const key of keys) {
		if (PROTECTED_REQUEST_FIELDS.has(key)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(fields, key)) {
			delete fields[key];
			changed = true;
		}
	}
	return changed ? next : undefined;
}

/**
 * 内置的阶梯：字段名出现在响应体里，且请求里确实带着它，就去掉它重试。
 *
 * 这些字段都是**我们自己加的可选项**（拿用量、采样参数、思考强度），去掉之后请求仍然成立。
 */
const RULES: readonly RepairRule[] = [
	{
		id: 'sampling',
		signal: /\b(temperature|top_p)\b/i,
		applies: request => request.temperature !== undefined || request.top_p !== undefined,
		plan: request => {
			const next = dropFields(request, ['temperature', 'top_p']);
			if (next === undefined) {
				return undefined;
			}
			return {
				id: 'sampling',
				request: next,
				note: '站点不认采样参数（temperature / top_p），已去掉后重试',
			};
		},
	},
	{
		id: 'reasoning_effort',
		signal: new RegExp(DEFAULT_REASONING_EFFORT_FIELD, 'i'),
		applies: request => (request as Record<string, unknown>)[DEFAULT_REASONING_EFFORT_FIELD] !== undefined,
		plan: request => {
			const next = dropFields(request, [DEFAULT_REASONING_EFFORT_FIELD]);
			if (next === undefined) {
				return undefined;
			}
			return {
				id: 'reasoning_effort',
				request: next,
				note: `站点不认 ${DEFAULT_REASONING_EFFORT_FIELD}，已去掉后重试（思考强度交给上游默认值）`,
			};
		},
	},
	{
		id: 'tool_choice',
		signal: /tool_choice/i,
		applies: request => request.tool_choice !== undefined,
		plan: request => {
			const next = dropFields(request, ['tool_choice']);
			if (next === undefined) {
				return undefined;
			}
			return {
				id: 'tool_choice',
				request: next,
				note: '站点不认 tool_choice，已去掉后重试（由模型自行决定是否调用工具）',
			};
		},
	},
];

/**
 * 当前请求里「可以被自愈去掉」的字段，按 `REPAIRABLE_FIELDS` 的顺序。
 *
 * `optionalFields` 是用户在 `extraBody` 里填的键——它们是用户自己为某个网关加的字段，
 * 同样满足「去掉之后请求仍然成立」，因此也在白名单里。协议骨架与 `tools` 永远不在其中。
 */
function repairableFieldsIn(
	request: ChatCompletionRequest,
	optionalFields: readonly string[],
): readonly string[] {
	const fields = request as Record<string, unknown>;
	const candidates: string[] = [];
	for (const key of [...REPAIRABLE_FIELDS, ...optionalFields]) {
		if (PROTECTED_REQUEST_FIELDS.has(key) || candidates.includes(key)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(fields, key)) {
			candidates.push(key);
		}
	}
	return candidates;
}

/**
 * 上游在响应体里点名了哪个**白名单字段**。
 *
 * 覆盖实际见到的几种写法：`Unknown parameter: 'temperature'`、`unknown field "stream_options"`、
 * `Unsupported parameter: top_p`、`Unrecognized request argument supplied: foo`。字段名要么被引号
 * 括着（**可能带着反斜杠转义**——错误描述本身常常是 JSON 字符串里的一个值），要么跟在冒号后面。
 *
 * 与早先实现的关键差别：**命中的名字必须落在白名单里**，因此响应体里出现的 `tools`、
 * `read_file`、`model` 之类都不会被当成「可以去掉的字段」。
 */
function findMentionedField(text: string, candidates: readonly string[]): string | undefined {
	if (candidates.length === 0) {
		return undefined;
	}
	const matches = [
		...text.matchAll(/\\?['"`]([A-Za-z_][A-Za-z0-9_.]*)\\?['"`]/g),
		...text.matchAll(/:\s*\\?([A-Za-z_][A-Za-z0-9_.]*)/g),
	];
	for (const match of matches) {
		const name = match[1];
		if (candidates.includes(name)) {
			return name;
		}
	}
	return undefined;
}

/**
 * 判断这次 400 能不能靠去掉一个字段救回来。
 *
 * `tried` 是本次请求已经用过的步骤标识：同一个步骤不会用第二次，否则就会出现
 * 「去掉 → 还是 400 → 再去掉 → 还是 400」这种一眼看不出问题的死循环。
 * `sendsStreamOptions` 说明这次请求是否真的带了 `stream_options`（它由客户端按设置加上去，
 * 不在请求体里，因此需要调用方告知）。
 * `optionalFields` 是 `extraBody` 的键，用于把用户自填的网关参数也纳入白名单。
 */
export function planRequestRepair(input: {
	status: number;
	responseBody: string | undefined;
	apiMessage: string | undefined;
	request: ChatCompletionRequest;
	sendsStreamOptions: boolean;
	tried: readonly string[];
	optionalFields?: readonly string[];
}): RepairPlan | undefined {
	if (input.status !== 400) {
		return undefined;
	}
	const text = `${input.apiMessage ?? ''} ${input.responseBody ?? ''}`;
	if (text.trim().length === 0) {
		// 服务器什么也没说：没有线索就不猜
		return undefined;
	}

	const tried = new Set(input.tried);

	// `stream_options` 单独处理：它是客户端加上去的，去掉的动作为「不再要求返回用量」
	if (!tried.has('stream_options') && input.sendsStreamOptions && /stream_options/i.test(text)) {
		return {
			id: 'stream_options',
			request: input.request,
			includeUsage: false,
			note: '站点不认 stream_options，已改为不要求上游返回用量（上下文窗口将不显示 token 数）',
		};
	}

	const named = findMentionedField(text, repairableFieldsIn(input.request, input.optionalFields ?? []));
	if (named !== undefined && !tried.has(`field:${named}`)) {
		const request = dropFields(input.request, [named]);
		if (request !== undefined) {
			return {
				id: `field:${named}`,
				request,
				note: `站点不认字段 ${named}，已去掉后重试`,
			};
		}
	}

	for (const rule of RULES) {
		if (tried.has(rule.id) || !rule.signal.test(text) || !rule.applies(input.request)) {
			continue;
		}
		const plan = rule.plan(input.request);
		if (plan !== undefined) {
			return plan;
		}
	}
	return undefined;
}

/* -------------------------------------------------------------------------- */
/* 自愈记忆                                                                    */
/* -------------------------------------------------------------------------- */

/** 一次请求之后记住的自愈结果。 */
export interface RememberedRepair {
	/** 这个站点/模型明确不认的字段 */
	readonly fields: readonly string[];
	/** 为 `false` 时后续请求都不再要求上游返回用量 */
	readonly includeUsage: false | undefined;
}

/** 记忆里最多保留多少个「会话 + 模型」组合。 */
const MEMORY_LIMIT = 64;

/**
 * 自愈记忆：按「会话 + 模型」记住已经确认过的不兼容字段。
 *
 * 为什么需要它：某个站点不认 `temperature` 是**稳定事实**，而 Agent 的每一步都是一次请求。
 * 不记住的话，每一步都要先挨一个 400、再重发一次，用户看到的是「每一步都慢一拍」。
 *
 * 键里带 `targetKey`（配置指纹），因此站点地址、密钥或请求设置一变就自然失效，
 * 不需要额外的清理钩子。本类是纯逻辑，不依赖 `vscode`，也不发请求。
 */
export class RepairMemory {
	private readonly entries = new Map<string, RememberedRepair>();

	constructor(private readonly limit: number = MEMORY_LIMIT) { }

	/** 取出已记住的结果。 */
	get(targetKey: string, modelId: string): RememberedRepair | undefined {
		const key = memoryKey(targetKey, modelId);
		const entry = this.entries.get(key);
		if (entry === undefined) {
			return undefined;
		}
		// 先删再插：Map 的迭代顺序即「最近使用」顺序，淘汰时从最旧的开始
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry;
	}

	/** 记住一次成功的自愈。 */
	remember(targetKey: string, modelId: string, plan: RepairPlan): void {
		const key = memoryKey(targetKey, modelId);
		const previous = this.entries.get(key);
		let fields = previous?.fields ?? [];
		let includeUsage = previous?.includeUsage;

		if (plan.id === 'stream_options') {
			includeUsage = false;
		} else if (plan.id.startsWith('field:')) {
			const field = plan.id.slice('field:'.length);
			if (!fields.includes(field)) {
				fields = [...fields, field];
			}
		}

		// 先删再插：刷新「最近使用」顺序
		this.entries.delete(key);
		this.entries.set(key, { fields, includeUsage });
		this.trim();
	}

	/** 清空记忆（会话被重建时用）。 */
	clear(): void {
		this.entries.clear();
	}

	/** 当前记住了多少条。 */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * 淘汰最久未使用的条目。
	 *
	 * `Map` 的迭代顺序就是插入顺序，而 `get` / `remember` 都会「先删再插」，
	 * 因此这里只需要从头开始删。
	 */
	private trim(): void {
		while (this.entries.size > this.limit) {
			const oldest = this.entries.keys().next();
			if (oldest.done === true) {
				return;
			}
			this.entries.delete(oldest.value);
		}
	}
}

function memoryKey(targetKey: string, modelId: string): string {
	return `${targetKey}\u0000${modelId}`;
}

/**
 * 把记忆里的字段从请求体里预先去掉（首次尝试之前调用）。
 *
 * 返回原请求表示「没什么可去的」。
 */
export function applyRememberedRepair(
	request: ChatCompletionRequest,
	remembered: RememberedRepair | undefined,
): ChatCompletionRequest {
	if (remembered === undefined || remembered.fields.length === 0) {
		return request;
	}
	return dropFields(request, remembered.fields) ?? request;
}
