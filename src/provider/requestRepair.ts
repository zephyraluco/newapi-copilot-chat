/**
 * HTTP 400 的自愈阶梯：站点不认某个字段时，去掉那个字段再试一次。
 *
 * 400 的常见成因不是「请求写错了」，而是**我们加了一个站点不认的可选字段**：拿用量的
 * `stream_options`、采样参数 `temperature`、思考强度 `reasoning_effort`、`tool_choice`，
 * 或是用户在 `extraBody` 里填的网关专属参数。这些字段都是可选的——去掉之后请求仍然成立，
 * 用户只是少一项增强，而不是拿到一句「请求失败」。
 *
 * 三条边界：
 *
 * - **只对 400 生效**。其它 4xx（401/403/404/429）去掉字段也救不回来，重试只会多花一次请求。
 * - **不猜**。要么上游在响应体里点了名（引号里、冒号后面），要么消息里出现了我们确知自己加过的
 *   字段名；两者都没有就不修，把上游原话报出来——没有线索还乱改字段，只会把「服务端拒绝」
 *   变成「服务端返回了别的东西」。
 * - **每轮的改动必须真的发生**（去重、且必须删掉一个存在的字段），否则返回 `undefined`，
 *   由调用方正常失败。轮数上限由调用方控制（`DEFAULTS.requestRepairRounds`）。
 *
 * 本模块是纯函数：不依赖 `vscode`，也不发请求，因此可以被直接单测。
 */

import { DEFAULT_REASONING_EFFORT_FIELD } from '../consts';
import type { ChatCompletionRequest } from '../types';

/**
 * 绝不能去掉的字段：请求体没有它们就不成立。
 *
 * 注意与 `PROTECTED_REQUEST_KEYS` 区分——那个说的是「`extraBody` 不许覆盖的协议骨架」，
 * 而 `tool_choice` / `tools` 虽然受保护，却是**可以**被自愈阶梯去掉的可选项。
 */
const REQUIRED_REQUEST_KEYS: ReadonlySet<string> = new Set(['model', 'messages', 'stream']);

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
 * 上游在响应体里点名了某个字段——把它找出来。
 *
 * 覆盖实际见到的几种写法：`Unknown parameter: 'temperature'`、`unknown field "stream_options"`、
 * `Unsupported parameter: top_p`、`Unrecognized request argument supplied: foo`。字段名要么被引号
 * 括着（**可能带着反斜杠转义**——错误描述本身常常是 JSON 字符串里的一个值），要么跟在冒号后面；
 * 只认**请求体里真实存在**的非必填字段，因此 `model` / `messages` 这类骨架字段不会被它删掉。
 */
function findNamedField(text: string, request: ChatCompletionRequest): string | undefined {
	const matches = [
		...text.matchAll(/\\?['"`]([A-Za-z_][A-Za-z0-9_.]*)\\?['"`]/g),
		...text.matchAll(/:\s*\\?([A-Za-z_][A-Za-z0-9_.]*)/g),
	];
	for (const match of matches) {
		const name = match[1];
		if (REQUIRED_REQUEST_KEYS.has(name)) {
			continue;
		}
		if (Object.prototype.hasOwnProperty.call(request, name)) {
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
 */
export function planRequestRepair(input: {
	status: number;
	responseBody: string | undefined;
	apiMessage: string | undefined;
	request: ChatCompletionRequest;
	sendsStreamOptions: boolean;
	tried: readonly string[];
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

	const named = findNamedField(text, input.request);
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
