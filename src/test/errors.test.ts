/**
 * 网络错误的分类与人话化（`src/errors.ts`）的测试。
 *
 * 这张映射表的价值全在「分得对」上：把「域名解析失败」判成「证书问题」，
 * 用户就会去改错的东西。因此这里既钉住几个真实见过的码，也钉住兜底行为
 * ——认不出的码必须照原样展示，不能被抹成一句「未知错误」。
 */

import * as assert from 'assert';
import {
	MAX_DIAGNOSTIC_FIELD_LENGTH,
	NETWORK_ERROR_CATEGORY_BY_CODE,
	describeErrorCause,
	getNetworkErrorCauseInfo,
	getNetworkErrorCategory,
	getNetworkErrorCode,
	getNetworkErrorMessage,
	hostOfUrl,
} from '../errors';
import type { NetworkErrorCategory } from '../errors';

/** 造一个带错误码的错误（Node 的网络错误就是这么带的）。 */
function withCode(error: Error, code: string): Error {
	return Object.assign(error, { code });
}

/** 造一个带 `cause` 的错误（undici 的 `fetch failed` 就是这么包住真实原因的）。 */
function withCause(error: Error, cause: unknown): Error {
	return Object.assign(error, { cause });
}

/** undici 在连接失败时实际抛出的形状。 */
function fetchFailure(cause: unknown): Error {
	return withCause(new TypeError('fetch failed'), cause);
}

suite('errors / 网络错误分类', () => {
	test('把码分到正确的类别', () => {
		const cases: readonly [string, NetworkErrorCategory][] = [
			['ENOTFOUND', 'dns'],
			['EAI_AGAIN', 'dns'],
			['ECONNREFUSED', 'unreachable'],
			['EHOSTUNREACH', 'unreachable'],
			['ECONNRESET', 'interrupted'],
			['UND_ERR_SOCKET', 'interrupted'],
			['ETIMEDOUT', 'timeout'],
			['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
			['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
			['CERT_HAS_EXPIRED', 'tls'],
			['AbortError', 'aborted'],
			['UND_ERR_HEADERS_OVERFLOW', 'protocol'],
			['ERR_INVALID_URL', 'configuration'],
		];
		for (const [code, expected] of cases) {
			assert.strictEqual(getNetworkErrorCategory(code), expected, code);
		}
	});

	test('前缀规则兜住表里没列的码', () => {
		// 表是精选的，不是穷举；TLS/OpenSSL 的码家族很大，按前缀归类比漏掉好
		assert.strictEqual(getNetworkErrorCategory('ERR_TLS_SOMETHING_NEW'), 'tls');
		assert.strictEqual(getNetworkErrorCategory('ERR_SSL_WHATEVER'), 'tls');
		// Node 的 HTTP 解析错误（llhttp）
		assert.strictEqual(getNetworkErrorCategory('HPE_INVALID_HEADER_TOKEN'), 'protocol');
	});

	test('认不出的码与空码落到 generic', () => {
		assert.strictEqual(getNetworkErrorCategory('ESOMETHINGNEW'), 'generic');
		assert.strictEqual(getNetworkErrorCategory(undefined), 'generic');
		assert.strictEqual(getNetworkErrorCategory(''), 'generic');
	});

	test('从 cause 链上取最深一层的码', () => {
		// 外壳（`fetch failed`）既没有码也没有 name，链上最深的那层才具体
		const info = getNetworkErrorCauseInfo(fetchFailure(withCode(new Error('getaddrinfo ENOTFOUND'), 'ENOTFOUND')));
		assert.strictEqual(info?.code, 'ENOTFOUND');
		// 普通错误对象的构造名不算码（否则会展示成 `[Error]`，等于什么也没说）
		assert.strictEqual(info?.name, undefined);

		// 没有码时用构造名当码（undici 的 TimeoutError / SocketError 就是这样）
		const byName = getNetworkErrorCauseInfo(fetchFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
		assert.strictEqual(byName?.code, undefined);
		assert.strictEqual(getNetworkErrorCode(byName), 'TimeoutError');

		// 完全没有任何原因时返回 undefined
		assert.strictEqual(getNetworkErrorCauseInfo(new TypeError('fetch failed')), undefined);
		assert.strictEqual(getNetworkErrorCode(undefined), undefined);
		// 普通错误对象的构造名（`Error` / `TypeError`）不算码：展示成 `[Error]` 等于什么也没说
		assert.strictEqual(getNetworkErrorCauseInfo(new Error('循环')), undefined);
	});

	test('错误链渲染成一行明细（给日志看）', () => {
		const detail = describeErrorCause(fetchFailure(Object.assign(
			new Error('connect ECONNREFUSED'),
			{ code: 'ECONNREFUSED', syscall: 'connect', address: '127.0.0.1', port: 3000 },
		)));

		// 逐层串起来，诊断字段一个不落
		assert.strictEqual(
			detail,
			'fetch failed ← connect ECONNREFUSED code=ECONNREFUSED syscall=connect address=127.0.0.1 port=3000',
		);
	});

	test('明细里的多行消息被折叠、超长被截断', () => {
		const detail = describeErrorCause(new Error(`第一行\n第二行  ${'x'.repeat(400)}`));

		assert.ok(!detail.includes('\n'), '日志是一行一条，明细不能带换行');
		assert.ok(detail.includes('第一行 第二行'), detail);
		assert.ok(detail.length < 400, '超长的字段要截断，否则一行日志被一条错误撑破');
		assert.ok(detail.endsWith('...'), detail);
	});

	test('cause 成环时不会死循环', () => {
		const loop = new Error('循环');
		Object.assign(loop, { cause: loop });

		assert.strictEqual(describeErrorCause(loop), '循环');
	});

	test('非 Error 也能给出明细', () => {
		assert.strictEqual(describeErrorCause('字符串错误'), '字符串错误');
		assert.strictEqual(describeErrorCause(42), '42');
		assert.strictEqual(describeErrorCause(undefined), '未知错误');
	});

	test('诊断字段的长度上限是常量', () => {
		// 测试用到的具体数字不该散落在断言里，改上限时只需要改一处
		assert.strictEqual(MAX_DIAGNOSTIC_FIELD_LENGTH, 300);
	});
});

suite('errors / 用户可见的消息', () => {
	test('格式是 [码]（站点）解释（码要原样保留，它可以拿去搜索）', () => {
		const message = getNetworkErrorMessage('ENOTFOUND', 'api.example.com');

		assert.ok(message.startsWith('[ENOTFOUND]（api.example.com） '), message);
		assert.ok(message.includes('域名解析失败'), message);
	});

	test('没有站点时不留一个空括号', () => {
		const message = getNetworkErrorMessage('ECONNREFUSED');

		assert.ok(message.startsWith('[ECONNREFUSED] '), message);
		assert.ok(!message.includes('（）'), message);
	});

	test('每一类都给出各自该怎么做的建议', () => {
		// 建议必须能区分开：全都指向「检查地址与 DNS」等于没分类
		const dns = getNetworkErrorMessage('ENOTFOUND');
		const tls = getNetworkErrorMessage('DEPTH_ZERO_SELF_SIGNED_CERT');
		const interrupted = getNetworkErrorMessage('ECONNRESET');
		const configuration = getNetworkErrorMessage('ERR_INVALID_URL');

		assert.ok(dns.includes('解析'), dns);
		assert.ok(tls.includes('证书'), tls);
		assert.ok(interrupted.includes('中断'), interrupted);
		assert.ok(configuration.includes('配置'), configuration);
		assert.strictEqual(new Set([dns, tls, interrupted, configuration]).size, 4);
	});

	test('超时那类指向具体的设置项', () => {
		assert.ok(getNetworkErrorMessage('ETIMEDOUT').includes('newapi-copilot-chat.request.timeoutMs'));
	});

	test('认不出的码照样展示，只是解释退化成通用建议', () => {
		const message = getNetworkErrorMessage('ESOMETHINGNEW');

		assert.ok(message.startsWith('[ESOMETHINGNEW]'), message);
		assert.ok(message.includes('网络请求失败'), message);
	});

	test('没有码时用 UNKNOWN 占位，而不是留一个空括号', () => {
		assert.ok(getNetworkErrorMessage(undefined).startsWith('[UNKNOWN]'));
	});

	test('表里的每一项都有对应句子（改表时不会漏配文案）', () => {
		for (const [code, category] of Object.entries(NETWORK_ERROR_CATEGORY_BY_CODE)) {
			const message = getNetworkErrorMessage(code);
			assert.ok(message.startsWith(`[${code}]`), `${code} 的消息应带上码：${message}`);
			assert.ok(!message.includes('{'), `${code} 的文案有未替换的占位符：${message}`);
			// 除了「已取消」（它本来就不该被当失败上报），每一类都要说清怎么处置
			const minimum = category === 'aborted' ? 10 : 30;
			assert.ok(message.length > minimum, `${code}（${category}）的解释太短：${message}`);
		}
	});
});

suite('errors / 主机名', () => {
	test('只取主机（路径与查询串没有诊断价值，还可能是敏感信息）', () => {
		assert.strictEqual(hostOfUrl('https://api.example.com/v1/models?key=secret'), 'api.example.com');
		assert.strictEqual(hostOfUrl('http://127.0.0.1:3000/v1'), '127.0.0.1:3000');
	});

	test('解析不出来时返回 undefined', () => {
		assert.strictEqual(hostOfUrl('not a url'), undefined);
		assert.strictEqual(hostOfUrl(undefined), undefined);
	});
});
