#!/usr/bin/env node
/**
 * 抓取 OpenRouter 的公开模型目录，生成扩展随包发布的模型数据表
 * （`data/openrouter-models.json`，由 `src/models/dataset.ts` 载入并按模型 ID 查表）。
 *
 * New API 的 `/v1/models` 只有 `id` / `object` / `created` / `owned_by`，不含窗口与能力位，
 * 而 OpenRouter 的公开目录提供了这些事实：
 * - `top_provider.context_length` / `top_provider.max_completion_tokens` —— 窗口与输出上限
 * - `architecture.input_modalities` / `output_modalities` —— 输入输出模态
 * - `supported_parameters` —— `tools` = 工具调用，`reasoning` = 思考
 * - `reasoning.supported_efforts` / `reasoning.default_effort` —— 思考档位
 *
 * ## 用法
 *
 *   npm run models:openrouter
 *   node scripts/fetch-openrouter-models.js --out data/models.json
 *   node scripts/fetch-openrouter-models.js --min-context 32000 --compact
 *
 * 参数：
 *   --out <path>        输出路径（默认 `data/openrouter-models.json`）
 *   --url <url>         数据源（默认 OpenRouter 的公开模型目录）
 *   --timeout <ms>      请求超时（默认 30000）
 *   --min-context <n>   丢弃上下文窗口小于该值的模型（默认 0，即不过滤）
 *   --compact           输出压缩 JSON（默认带缩进，便于 diff 与人工核对）
 *   --help              显示帮助
 *
 * ## 输出结构
 *
 *     {
 *       "source": "https://openrouter.ai/api/v1/models",
 *       "generatedAt": "2026-09-15T10:20:30.000Z",
 *       "totalFetched": 445,      // 上游原始条目数
 *       "count": 343,             // 本文件中的模型数
 *       "dropped": { ... },       // 各条过滤规则丢弃的数量，便于审计
 *       "models": [
 *         {
 *           "id": "claude-fable-5.1",
 *           "vendor": "Anthropic",
 *           "displayName": "Claude Fable 5.1",
 *           "contextWindow": 1000000,
 *           "maxOutputTokens": 128000,
 *           "imageInput": true,
 *           "toolCalling": true,
 *           "reasoning": true,
 *           "supportsReasoningEffort": ["max", "high", "medium", "low"],
 *           "defaultReasoningEffort": "high"
 *         }
 *       ]
 *     }
 *
 * 字段名与 `src/models/dataset.ts` 的 `ModelDatasetEntry` 一一对应：窗口或输出上限缺失/非正数的
 * 条目会在载入时被丢弃，能力位缺失则收敛为 `false`。`supportsReasoningEffort` /
 * `defaultReasoningEffort` 只在**上游确实给出强度列表**时才写——只有 `mandatory` /
 * `default_enabled` 的模型「会思考但不能调强度」，不写这两个字段（因此消费侧也不会有控件）。
 * 档位取值是**上游自己的词汇**（`max` / `xhigh` / `high` / `medium` / `low` / `minimal` / `none`），
 * 只是「能选哪些档」的提示，是否被站点接受取决于站点与它的上游。
 *
 * ## 过滤规则
 *
 * 1. **丢弃变体**：`id` 含 `:` 的（`:free` / `:batch` / `:nitro`）整条丢掉——那是 OpenRouter
 *    特有的计费/调度概念，New API 与 Copilot 都没有对应物。
 * 2. **丢弃路由型伪模型**（`openrouter/auto` / `fusion` / `free` / `pareto-code` / `bodybuilder`）：
 *    判据是「缺少正数 `max_completion_tokens`」，比按厂商名硬编码更稳。
 * 3. **必须有文本输入与文本输出**：不能对话的模型进这份清单没有意义。
 * 4. **必须有上下文窗口**：它是 Copilot 选模型的硬指标（`maxInputTokens`）。
 * 5. **丢弃已过下线日期的模型**。**不**把 `expiration_date` 当作「即将退役」的信号：
 *    该字段不可靠（存在 `2098-12-31` 这类哨兵值），按它过滤会误删正常模型。
 * 6. **归一化后去重**：剥掉厂商前缀与变体后缀后会撞号（`gpt-6-astra` 与
 *    `gpt-6-astra:batch`），必须去重；`~` 是 latest 别名标记，也一并剥掉，撞号时优先保留
 *    **不带 `~` 的规范条目**。
 * 7. **不按厂商过滤**：缩范围交给消费侧按 `id` 或 `vendor` 做。
 *
 * 无外部依赖：只用 Node 内置的 `fetch`（Node 18+）。退出码非 0 表示失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** 默认数据源。公开模型目录无需鉴权。 */
const DEFAULT_URL = 'https://openrouter.ai/api/v1/models';

/** 默认输出路径：仓库根的 `data/` 下，与 `scripts/` 平级。 */
const DEFAULT_OUT = path.join(__dirname, '..', 'data', 'openrouter-models.json');

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT = 30_000;

/** 打印帮助。 */
function printHelp() {
	console.log(
		[
			'用法：node scripts/fetch-openrouter-models.js [选项]',
			'',
			'  --out <path>        输出路径（默认 data/openrouter-models.json）',
			'  --url <url>         数据源（默认 OpenRouter 的公开模型目录）',
			'  --timeout <ms>      请求超时，默认 30000',
			'  --min-context <n>   丢弃上下文窗口小于该值的模型，默认 0（不过滤）',
			'  --compact           输出压缩 JSON（默认带缩进）',
			'  --help              显示本帮助',
			'',
			'输出字段：id / vendor / displayName / contextWindow / maxOutputTokens /',
			'          imageInput / toolCalling / reasoning / supportsReasoningEffort /',
			'          defaultReasoningEffort',
			'（id 已剥掉厂商前缀与变体后缀；丢弃变体与路由型伪模型、非对话模型、',
			'  缺少上下文窗口与输出上限的模型；后两个字段仅在上游给出时才会出现）',
		].join('\n'),
	);
}

/**
 * 解析命令行参数。
 *
 * 手写而不是引入依赖：这个脚本要保持零依赖。遇到未知参数直接抛错，
 * 避免「打错了却静默按默认值跑」。
 */
function parseArgs(argv) {
	const options = {
		out: DEFAULT_OUT,
		url: DEFAULT_URL,
		timeout: DEFAULT_TIMEOUT,
		minContext: 0,
		compact: false,
		help: false,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) {
				throw new Error(`参数 ${arg} 缺少取值`);
			}
			return value;
		};

		switch (arg) {
			case '--out':
				options.out = path.resolve(process.cwd(), next());
				break;
			case '--url':
				options.url = next();
				break;
			case '--timeout': {
				const value = Number(next());
				if (!Number.isFinite(value) || value <= 0) {
					throw new Error('--timeout 需要一个正数（毫秒）');
				}
				options.timeout = value;
				break;
			}
			case '--min-context': {
				const value = Number(next());
				if (!Number.isFinite(value) || value < 0) {
					throw new Error('--min-context 需要一个非负数');
				}
				options.minContext = value;
				break;
			}
			case '--compact':
				options.compact = true;
				break;
			case '--help':
			case '-h':
				options.help = true;
				break;
			default:
				throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
		}
	}

	return options;
}

/* -------------------------------------------------------------------------- */
/* 取值辅助                                                                    */
/* -------------------------------------------------------------------------- */

/** 判断是否为普通对象（排除 null 与数组）。 */
function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取非空字符串（纯空白视为缺失）。 */
function asNonEmptyString(value) {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** 取正数。 */
function asPositiveNumber(value) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 取字符串数组。 */
function asStringArray(value) {
	return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

/**
 * 收拢思考强度列表：去空白、去重、保序（上游是按由强到弱排的，有语义）。
 *
 * 全空时返回 `undefined`：这样调用方可以直接用它在输出里决定“写不写这个字段”。
 */
function normalizeEfforts(value) {
	const list = asStringArray(value);
	const result = [];
	for (const item of list) {
		const trimmed = item.trim();
		if (trimmed.length > 0 && !result.includes(trimmed)) {
			result.push(trimmed);
		}
	}
	return result.length > 0 ? result : undefined;
}

/* -------------------------------------------------------------------------- */
/* 归一化                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 把 OpenRouter 的 id 归一成 Copilot 能接受的模型 id。
 *
 * 上游形如 `~anthropic/claude-sonnet-latest:free`，需要三步：
 * 1. 丢掉变体后缀（`:` 之后）—— 那是 OpenRouter 特有的计费/调度变体；
 * 2. 丢掉厂商前缀（第一个 `/` 之前），`~` 是 latest 别名标记，一并丢掉
 *    —— Copilot 的模型 id 不允许带 `/`；
 * 3. 剩下的部分即模型 id。
 *
 * 返回 `undefined` 表示归一后为空（异常数据）。
 */
function normalizeId(raw) {
	const withoutVariant = String(raw).replace(/:[^:]*$/, '');
	const withoutVendor = withoutVariant.replace(/^~?[^/]*\//, '');
	const id = withoutVendor.trim();
	return id.length > 0 ? id : undefined;
}

/** 厂商 slug → 可读名称（`z-ai` → `Z-AI`，`meta-llama` → `Meta-Llama`）。 */
function prettifyVendor(slug) {
	return slug
		.split(/[-_]/)
		.filter(Boolean)
		.map(part => part.toUpperCase() === part ? part : part.charAt(0).toUpperCase() + part.slice(1))
		.join('-');
}

/**
 * 从上游条目里取厂商显示名。
 *
 * 上游 `name` 形如 `Anthropic: Claude Fable 5.1`，冒号前就是厂商自己的写法
 * （能把 `z-ai` 显示成 `Z-AI`），比我们拼 slug 更准；取不到才回退到 slug 美化。
 */
function resolveVendor(model) {
	const name = asNonEmptyString(model.name);
	if (name !== undefined) {
		const separator = name.indexOf(':');
		if (separator > 0) {
			const prefix = name.slice(0, separator).trim();
			if (prefix.length > 0) {
				return prefix;
			}
		}
	}
	const id = asNonEmptyString(model.id) ?? '';
	const slug = id.replace(/^~/, '').split('/')[0];
	return slug.length > 0 ? prettifyVendor(slug) : undefined;
}

/** 去掉 `name` 里的厂商前缀，得到模型自己的名字。 */
function resolveDisplayName(model, vendor) {
	const name = asNonEmptyString(model.name);
	if (name === undefined) {
		return undefined;
	}
	const separator = name.indexOf(':');
	if (separator > 0 && vendor !== undefined) {
		const prefix = name.slice(0, separator).trim();
		if (prefix.toLowerCase() === vendor.toLowerCase()) {
			const rest = name.slice(separator + 1).trim();
			if (rest.length > 0) {
				return rest;
			}
		}
	}
	return name;
}

/**
 * 判断模型是否已过下线日期。日期无法解析时视为未过期（宁可保留）。
 *
 * **不把「有 expiration_date」当作「即将退役」**：上游这个字段不可靠，
 * 实测 5 条里有 3 条是 `2098-12-31` 这种哨兵值。按存在性过滤会误删正常模型。
 */
function isExpired(model, now) {
	const raw = asNonEmptyString(model.expiration_date);
	if (raw === undefined) {
		return false;
	}
	const timestamp = Date.parse(raw);
	return Number.isFinite(timestamp) && timestamp <= now;
}

/* -------------------------------------------------------------------------- */
/* 过滤                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 把上游条目转成清单记录。
 *
 * 返回 `{ ok: true, model }` 或 `{ ok: false, reason }`；调用方负责按 `reason`
 * 累加计数，这样最终的 `dropped` 统计与实现天然同步，不会出现「规则改了但统计没改」。
 */
function convert(model, options, now) {
	if (!isRecord(model)) {
		return { ok: false, reason: 'invalidEntry' };
	}

	const rawId = asNonEmptyString(model.id);
	if (rawId === undefined) {
		return { ok: false, reason: 'invalidEntry' };
	}
	// 规则 1：变体（:free / :batch / :nitro）是 OpenRouter 特有概念
	if (rawId.includes(':')) {
		return { ok: false, reason: 'variant' };
	}

	const id = normalizeId(rawId);
	if (id === undefined) {
		return { ok: false, reason: 'invalidEntry' };
	}

	const architecture = isRecord(model.architecture) ? model.architecture : {};
	const inputModalities = asStringArray(architecture.input_modalities);
	const outputModalities = asStringArray(architecture.output_modalities);

	// 规则 3：必须能文本进、文本出
	if (!inputModalities.includes('text')) {
		return { ok: false, reason: 'noTextInput' };
	}
	if (!outputModalities.includes('text')) {
		return { ok: false, reason: 'noTextOutput' };
	}

	// 规则 4：必须有上下文窗口 —— Copilot 用它决定能塞多少上下文
	const topProvider = isRecord(model.top_provider) ? model.top_provider : {};
	const contextWindow = asPositiveNumber(topProvider.context_length)
		?? asPositiveNumber(model.context_length);
	if (contextWindow === undefined) {
		return { ok: false, reason: 'noContextWindow' };
	}
	if (contextWindow < options.minContext) {
		return { ok: false, reason: 'belowMinContext' };
	}

	// 规则 2：没有输出上限的多是路由型伪模型（openrouter/auto 等），不是真实模型
	const maxOutputTokens = asPositiveNumber(topProvider.max_completion_tokens);
	if (maxOutputTokens === undefined) {
		return { ok: false, reason: 'noMaxOutput' };
	}

	// 规则 5：已过下线日期的模型不再收录（罕见，实测为 0）
	if (isExpired(model, now)) {
		return { ok: false, reason: 'expired' };
	}

	const supportedParameters = asStringArray(model.supported_parameters).map(item => item.toLowerCase());
	const vendor = resolveVendor(model);
	const displayName = resolveDisplayName(model, vendor);

	// 思考强度：`reasoning.supported_efforts` 是「能选哪几档」，`default_effort` 是不指定时的取值。
	// 上游实测 311/443 条有 `reasoning` 对象，其中 141 条只有 `mandatory` / `default_enabled`
	// —— 这类模型会思考但不能调强度，因此不写那两个字段。
	const reasoningInfo = isRecord(model.reasoning) ? model.reasoning : undefined;
	const supportsReasoningEffort = reasoningInfo === undefined
		? undefined
		: normalizeEfforts(reasoningInfo.supported_efforts);
	const defaultReasoningEffort = reasoningInfo === undefined
		? undefined
		: asNonEmptyString(reasoningInfo.default_effort);

	const record = {
		id,
		vendor: vendor ?? '未知',
		displayName: displayName ?? id,
		contextWindow,
		maxOutputTokens,
		imageInput: inputModalities.includes('image'),
		toolCalling: supportedParameters.includes('tools'),
		// `reasoning` 对象本身就是「支持思考」的强证据，参数列表只是另一条线索
		reasoning: reasoningInfo !== undefined
			|| supportedParameters.includes('reasoning')
			|| supportedParameters.includes('include_reasoning'),
		...(supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort }),
		...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
	};

	return { ok: true, model: record, canonical: !rawId.startsWith('~') };
}

/**
 * 执行完整过滤。
 *
 * 去重放在过滤之后：同名的变体条目已经在前面被丢掉，这里只需要处理
 * `~` 别名与规范条目撞号的情况（优先保留规范条目）。
 */
function buildCatalog(rawList, options, now) {
	const dropped = {
		invalidEntry: 0,
		variant: 0,
		noTextInput: 0,
		noTextOutput: 0,
		noContextWindow: 0,
		noMaxOutput: 0,
		expired: 0,
		belowMinContext: 0,
		duplicate: 0,
	};
	const byId = new Map();

	for (const raw of rawList) {
		const result = convert(raw, options, now);
		if (!result.ok) {
			dropped[result.reason]++;
			continue;
		}
		const existing = byId.get(result.model.id);
		if (existing === undefined) {
			byId.set(result.model.id, { model: result.model, canonical: result.canonical });
			continue;
		}
		dropped.duplicate++;
		// 撞号时优先保留不带 `~` 的规范条目
		if (result.canonical && !existing.canonical) {
			byId.set(result.model.id, { model: result.model, canonical: result.canonical });
		}
	}

	const models = [...byId.values()]
		.map(entry => entry.model)
		.sort((a, b) => a.id.localeCompare(b.id));

	return { models, dropped };
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

/** 带超时地抓取 JSON。 */
async function fetchJson(url, timeout) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeout);
	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/json', 'User-Agent': 'newapi-copilot-chat/scripts' },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} ${response.statusText}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/** 从响应里取模型数组，兼容 `{data:[...]}` 与裸数组两种形态。 */
function extractList(payload) {
	if (Array.isArray(payload)) {
		return payload;
	}
	if (isRecord(payload) && Array.isArray(payload.data)) {
		return payload.data;
	}
	// 部分镜像会把列表再包一层
	if (isRecord(payload) && isRecord(payload.data) && Array.isArray(payload.data.data)) {
		return payload.data.data;
	}
	throw new Error('响应里找不到模型数组（期望 data[] 或裸数组）');
}

/** 格式化丢弃统计，只列出非零项。 */
function formatDropped(dropped) {
	const labels = {
		invalidEntry: '数据缺 id/结构异常',
		variant: '变体（:free / :batch）',
		noTextInput: '不支持文本输入',
		noTextOutput: '不支持文本输出',
		noContextWindow: '缺少上下文窗口',
		noMaxOutput: '缺少输出上限（路由型伪模型）',
		expired: '已过下线日期',
		belowMinContext: '低于 --min-context',
		duplicate: '归一后撞号（保留规范条目）',
	};
	return Object.entries(dropped)
		.filter(([, count]) => count > 0)
		.map(([key, count]) => `  ${labels[key] ?? key}: ${count}`)
		.join('\n');
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return 0;
	}

	console.log(`→ 抓取 ${options.url}`);
	const payload = await fetchJson(options.url, options.timeout);
	const rawList = extractList(payload);
	console.log(`  上游条目：${rawList.length}`);

	const { models, dropped } = buildCatalog(rawList, options, Date.now());
	console.log(`  过滤后：${models.length}`);
	const detail = formatDropped(dropped);
	if (detail.length > 0) {
		console.log('  丢弃明细：');
		console.log(detail);
	}

	const output = {
		source: options.url,
		generatedAt: new Date().toISOString(),
		totalFetched: rawList.length,
		count: models.length,
		dropped,
		models,
	};

	fs.mkdirSync(path.dirname(options.out), { recursive: true });
	fs.writeFileSync(
		options.out,
		JSON.stringify(output, null, options.compact ? undefined : 2) + '\n',
		'utf8',
	);

	const bytes = fs.statSync(options.out).size;
	console.log(`✓ 已写入 ${options.out}（${models.length} 个模型，${(bytes / 1024).toFixed(1)} KB）`);
	return 0;
}

main()
	.then(code => process.exit(code))
	.catch(error => {
		console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	});
