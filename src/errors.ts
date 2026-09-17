/**
 * 网络错误的分类与人话化。
 *
 * `fetch`（undici）失败时外壳永远是一句 `TypeError: fetch failed`，真正的原因放在 `cause` 里，
 * 而 `cause` 上的 `code` 才是可检索、可分类的那一个（`ENOTFOUND` / `ECONNREFUSED` /
 * `DEPTH_ZERO_SELF_SIGNED_CERT` …）。裸着把码摆给用户没有意义——**用户需要的是
 * 「哪一类问题、该去改什么」**，而码用来把这句话选准。
 *
 * 因此这里分两层，出口各不相同：
 *
 * | 出口 | 内容 | 给谁看 |
 * | --- | --- | --- |
 * | `getNetworkErrorMessage` | `[CODE] <那一类问题的解释与处置建议>` | 用户（聊天界面里的报错） |
 * | `describeErrorCause` | 整条错误链的原始明细 | 日志（排查用，含主机、syscall、address…） |
 *
 * 认不出的码不会被丢掉：它照样出现在方括号里，只是解释退化成通用建议。
 *
 * 放在基础层而不是 `client/`：日志也要打印 `cause`（见 `logger.ts` 的 `formatArg`），
 * 而基础层不能反向依赖 `client/`。
 */

import { isRecord } from './json';

/* -------------------------------------------------------------------------- */
/* 错误链                                                                      */
/* -------------------------------------------------------------------------- */

/** 错误链上的所有成员（含自身），遇到重复对象即停（`cause` 成环时的终止条件）。 */
function errorChain(error: unknown): unknown[] {
	const chain: unknown[] = [];
	const seen = new Set<unknown>();
	let current: unknown = error;
	while (current !== undefined && current !== null && !seen.has(current)) {
		seen.add(current);
		chain.push(current);
		current = isRecord(current) ? current.cause : undefined;
	}
	return chain;
}

/** 读错误对象上的字符串/数字字段（`message` / `code` / `syscall` …）。 */
function readField(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) {
		return undefined;
	}
	const value = source[key];
	if (typeof value === 'string' && value.trim().length > 0) {
		return value.trim();
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return String(value);
	}
	return undefined;
}

/** 诊断字段单值的最大长度：整条链要能一行读完，不能被某个超长字段撑破。 */
const MAX_DIAGNOSTIC_FIELD_LENGTH = 300;

/** 折叠成一个单行字段并限长（多行消息进日志会破坏「一行一条」的可读性）。 */
function toDiagnosticField(value: string): string {
	const singleLine = value.replace(/\s+/gu, ' ').trim();
	return singleLine.length > MAX_DIAGNOSTIC_FIELD_LENGTH
		? `${singleLine.slice(0, MAX_DIAGNOSTIC_FIELD_LENGTH)}...`
		: singleLine;
}

/**
 * 诊断用的字段：Node 的网络错误把它们放在平级属性上，`message` 里不一定提到。
 *
 * 刻意不限于「错误码」——`syscall` / `address` / `port` 往往才是定位到具体那一步的线索。
 */
const DIAGNOSTIC_FIELDS: readonly string[] = ['code', 'errno', 'syscall', 'address', 'port', 'hostname'];

/** 单层错误的一句话明细：消息加上它自带的诊断字段（重复也照样带出，不做取舍）。 */
function layerDetail(member: unknown): string | undefined {
	const parts: string[] = [];
	const message = readField(member, 'message');
	if (message !== undefined) {
		parts.push(toDiagnosticField(message));
	}
	for (const field of DIAGNOSTIC_FIELDS) {
		const value = readField(member, field);
		if (value !== undefined) {
			parts.push(`${field}=${value}`);
		}
	}
	if (parts.length > 0) {
		return parts.join(' ');
	}
	if (typeof member === 'string' && member.trim().length > 0) {
		return toDiagnosticField(member);
	}
	if (typeof member === 'number' || typeof member === 'boolean') {
		return String(member);
	}
	return undefined;
}

/**
 * 把错误链渲染成一行诊断明细（**给日志看**，不是给用户看）。
 *
 * 逐层用 ` ← ` 串起来，读作「由…引起」。本函数**不脱敏**：落在日志里时由
 * `LoggerService.write` 统一脱敏，落在给用户的消息里时由 `newApiClient.describeError` 过一遍
 * `redactText`。
 */
export function describeErrorCause(error: unknown): string {
	const layers: string[] = [];
	for (const member of errorChain(error)) {
		const detail = layerDetail(member);
		if (detail !== undefined) {
			layers.push(detail);
		}
	}
	return layers.length > 0 ? layers.join(' ← ') : '未知错误';
}

/* -------------------------------------------------------------------------- */
/* 错误码 → 分类                                                               */
/* -------------------------------------------------------------------------- */

/**
 * 网络故障的类别。
 *
 * 分得对才谈得上给对建议：「解析不了域名」和「证书不被信任」的处置完全相反，
 * 而两者在错误消息里都只是一句 `fetch failed`。
 */
export type NetworkErrorCategory =
	| 'dns'
	| 'unreachable'
	| 'interrupted'
	| 'timeout'
	| 'tls'
	| 'aborted'
	| 'protocol'
	| 'configuration'
	| 'generic';

/**
 * 实际观察到的错误码 → 类别。
 *
 * 来源：Node errno / c-ares DNS 码、Node TLS/OpenSSL 码、undici 的 `code` / `name` 字面量。
 * **刻意不求穷尽**：认不出的码落到 `generic`，但仍然原样展示给用户——
 * 丢码等于把唯一的线索丢了。
 */
export const NETWORK_ERROR_CATEGORY_BY_CODE: Readonly<Record<string, NetworkErrorCategory>> = {
	// DNS：c-ares 与 Node 的解析类错误
	ENOTFOUND: 'dns',
	EAI_AGAIN: 'dns',
	ENODATA: 'dns',
	ESERVFAIL: 'dns',
	EFORMERR: 'dns',
	ENONAME: 'dns',
	EBADNAME: 'dns',
	EBADQUERY: 'dns',
	EBADFAMILY: 'dns',
	EBADRESP: 'dns',
	ENOTIMP: 'dns',
	EREFUSED: 'dns',
	ENOTINITIALIZED: 'dns',
	ELOADIPHLPAPI: 'dns',
	EADDRGETNETWORKPARAMS: 'dns',

	// 不可达：连接被拒、路由不通
	ECONNREFUSED: 'unreachable',
	ENETUNREACH: 'unreachable',
	EHOSTUNREACH: 'unreachable',
	EADDRNOTAVAIL: 'unreachable',
	ENETDOWN: 'unreachable',
	EHOSTDOWN: 'unreachable',

	// 中断：连上了但链路被切断
	ECONNRESET: 'interrupted',
	ECONNABORTED: 'interrupted',
	ENETRESET: 'interrupted',
	ENOTCONN: 'interrupted',
	EPIPE: 'interrupted',
	EOF: 'interrupted',
	UND_ERR_SOCKET: 'interrupted',
	SocketError: 'interrupted',

	// 超时
	ETIMEDOUT: 'timeout',
	ETIMEOUT: 'timeout',
	ESOCKETTIMEDOUT: 'timeout',
	UND_ERR_CONNECT_TIMEOUT: 'timeout',
	UND_ERR_HEADERS_TIMEOUT: 'timeout',
	UND_ERR_BODY_TIMEOUT: 'timeout',
	ERR_TLS_HANDSHAKE_TIMEOUT: 'timeout',
	TimeoutError: 'timeout',
	ConnectTimeoutError: 'timeout',
	HeadersTimeoutError: 'timeout',
	BodyTimeoutError: 'timeout',

	// TLS：证书与握手
	CERT_HAS_EXPIRED: 'tls',
	CERT_NOT_YET_VALID: 'tls',
	CERT_UNTRUSTED: 'tls',
	CERT_REJECTED: 'tls',
	CERT_SIGNATURE_FAILURE: 'tls',
	SELF_SIGNED_CERT_IN_CHAIN: 'tls',
	DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
	UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
	UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls',
	UNABLE_TO_GET_ISSUER_CERT: 'tls',
	UNABLE_TO_GET_CRL: 'tls',
	UNABLE_TO_DECRYPT_CERT_SIGNATURE: 'tls',
	UNABLE_TO_DECRYPT_CRL_SIGNATURE: 'tls',
	UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: 'tls',
	CRL_SIGNATURE_FAILURE: 'tls',
	ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
	UND_ERR_PRX_TLS: 'tls',
	SecureProxyConnectionError: 'tls',

	// 取消（属于正常流程，不该当失败上报）
	ABORT_ERR: 'aborted',
	AbortError: 'aborted',
	UND_ERR_ABORTED: 'aborted',
	ECANCELLED: 'aborted',
	ECANCELED: 'aborted',

	// 协议：响应不符合 HTTP
	UND_ERR_HEADERS_OVERFLOW: 'protocol',
	UND_ERR_RESPONSE: 'protocol',
	UND_ERR_REQ_CONTENT_LENGTH_MISMATCH: 'protocol',
	UND_ERR_RES_CONTENT_LENGTH_MISMATCH: 'protocol',
	UND_ERR_RES_EXCEEDED_MAX_SIZE: 'protocol',
	HTTPParserError: 'protocol',
	HeadersOverflowError: 'protocol',
	ResponseError: 'protocol',
	ResponseContentLengthMismatchError: 'protocol',
	ResponseExceededMaxSizeError: 'protocol',

	// 配置：地址或参数本身不合法
	ERR_INVALID_URL: 'configuration',
	ERR_INVALID_ARG_TYPE: 'configuration',
	ERR_INVALID_ARG_VALUE: 'configuration',
	UND_ERR_INVALID_ARG: 'configuration',
	InvalidArgumentError: 'configuration',
};

/**
 * 一类的用户可见解释。
 *
 * 两个占位符：`{code}` 是错误码，`{where}` 是站点主机（没有时为空白）。
 */
const CATEGORY_MESSAGES: Readonly<Record<NetworkErrorCategory, string>> = {
	dns: '[{code}]{where} 域名解析失败：请确认站点地址没写错，并检查运行本扩展的那台机器能否解析它'
		+ '（DNS、代理与防火墙都可能影响）。',
	unreachable: '[{code}]{where} 目标不可达或拒绝连接：请确认站点地址与端口正确、服务正在运行，'
		+ '并检查代理与防火墙设置。',
	interrupted: '[{code}]{where} 连接被中断：链路在传输过程中被切断，通常来自代理或网络设备，重试一次往往就能成功。',
	timeout: '[{code}]{where} 连接超时：请检查网络与代理，或调大 newapi-copilot-chat.request.timeoutMs。',
	tls: '[{code}]{where} HTTPS 证书不被信任：站点证书可能自签名或已过期；请换用受信任的证书，'
		+ '或先让这台机器信任它。',
	aborted: '[{code}]{where} 请求已取消。',
	protocol: '[{code}]{where} HTTP 协议层错误：响应不符合协议（头部过大、长度不符等），'
		+ '通常是站点或中间的代理有问题。',
	configuration: '[{code}]{where} 请求配置不合法：请检查站点地址与相关参数。',
	generic: '[{code}]{where} 网络请求失败：请检查站点地址、网络与代理设置；扩展运行在远程/容器里时，'
		+ '该地址指的是那台机器能访问到的位置。',
};

/** 错误对象里提取出的、与网络故障有关的字段。 */
export interface NetworkErrorCauseInfo {
	/** `ENOTFOUND` 这类错误码 */
	readonly code?: string;
	/** 错误的构造名（`TimeoutError` / `SocketError` …），没有码时当码用 */
	readonly name?: string;
}

/**
 * 不算错误码的构造名。
 *
 * `cause?.name` 在「没有 code」时当码用（undici 的 `TimeoutError` / `SocketError` 就是
 * 只能靠这个名字识别）。但普通错误对象一律叫 `Error`/`TypeError`，把它们当码展示只会
 * 让用户看到一个 `[Error]` 这样什么也没说的方括号。
 */
const GENERIC_ERROR_NAMES: ReadonlySet<string> = new Set([
	'Error',
	'TypeError',
	'RangeError',
	'SyntaxError',
	'ReferenceError',
	'EvalError',
	'URIError',
	'AggregateError',
	'DOMException',
]);

/** 从错误的 `cause` 链上取出最深一层的错误码与构造名；都没有时返回 `undefined`。 */
export function getNetworkErrorCauseInfo(error: unknown): NetworkErrorCauseInfo | undefined {
	// 最深处最具体：外壳（`fetch failed`）本身既没有码也没有原因
	const layers = errorChain(error).reverse();
	for (const member of layers) {
		const code = readField(member, 'code');
		const rawName = readField(member, 'name');
		const name = rawName !== undefined && GENERIC_ERROR_NAMES.has(rawName) ? undefined : rawName;
		if (code !== undefined || name !== undefined) {
			return { code, name };
		}
	}
	return undefined;
}

/** 用于分类与展示的码：优先 `code`，退回到构造名。 */
export function getNetworkErrorCode(info: NetworkErrorCauseInfo | undefined): string | undefined {
	return info?.code ?? info?.name;
}

/** 码 → 类别；认不出的码按前缀兜底，仍认不出则 `generic`。 */
export function getNetworkErrorCategory(code: string | undefined): NetworkErrorCategory {
	if (!code) {
		return 'generic';
	}
	const known = NETWORK_ERROR_CATEGORY_BY_CODE[code];
	if (known !== undefined) {
		return known;
	}
	if (code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
		return 'tls';
	}
	return code.startsWith('HPE_') ? 'protocol' : 'generic';
}

/**
 * 把错误码翻译成一句用户能读懂、能照着做的话。
 *
 * 格式固定为 `[CODE]（站点）解释与建议`：方括号里的码是可以拿去搜索、拿去比对的原始信息，
 * 后面的句子是它的意思，括号里是「哪个站点」——多站点配置下这是第一个要回答的问题。
 * **认不出的码也照原样展示**，只是解释退化成通用建议。
 */
export function getNetworkErrorMessage(code: string | undefined, host?: string): string {
	const displayCode = code ?? 'UNKNOWN';
	const where = host !== undefined && host.length > 0 ? `（${host}）` : '';
	// 替换值必须用函数形式：字符串形式里 `$&` / `$'` / `` $` `` 是替换模式，
	// 码里偶然出现这些序列时会把占位符本身或周围文本搬进消息里。
	return CATEGORY_MESSAGES[getNetworkErrorCategory(code)]
		.replace('{code}', () => displayCode)
		.replace('{where}', () => where);
}

/* -------------------------------------------------------------------------- */
/* 杂项                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * URL 里的主机名，用于错误消息。
 *
 * 连接失败时「是哪个主机连不上」是第一个要回答的问题，而路径与查询串没有诊断价值、
 * 还可能是敏感信息。地址解析不出来时返回 `undefined`。
 */
export function hostOfUrl(url: string | undefined): string | undefined {
	if (url === undefined) {
		return undefined;
	}
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}
