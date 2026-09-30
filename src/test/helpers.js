'use strict';

/**
 * 测试基架：把一个或多个 TypeScript 模块打包进内存后加载。
 *
 * 用 esbuild 现打包而不是等 `tsc` 产物，有两个原因：
 * 1. 不依赖构建顺序，`npm test` 单独跑也能过；
 * 2. 入口由测试自己拼（下面用 `stdin`），因此**一次加载里的模块共享实例**——
 *    这点很关键：`models/dataset.ts` 的数据表是模块级状态，如果测试与它导入的
 *    `modelConfig.ts` 各自拿到一份副本，`installModelDataset` 装进去的表就永远看不见。
 */

const path = require('node:path');
const { buildSync } = require('esbuild');
const { createVscodeStub } = require('./fakes');

/** 仓库根目录（本文件在 src/test/ 下，模块路径都相对它书写）。 */
const ROOT = path.join(__dirname, '..', '..');

/**
 * 打包并加载若干模块。
 *
 * @param {Record<string, string>} entries 别名 → **相对仓库根**的模块路径，例如
 *   `{ dataset: './src/models/dataset' }`。返回值里就按这个别名取导出。
 * @param {{ vscode?: object }} [options] 自定义 `vscode` 替身；缺省用标准替身。
 * @returns {{ modules: Record<string, any>, vscode: object }}
 */
function load(entries, options = {}) {
	const vscode = options.vscode ?? createVscodeStub();

	const requires = Object.entries(entries)
		.map(([alias, file]) => `\t${JSON.stringify(alias)}: require(${JSON.stringify(file)}),`)
		.join('\n');

	const result = buildSync({
		// 入口是虚拟文件：用 stdin 而不是在 src/ 里放一个只服务测试的聚合模块
		stdin: {
			contents: `'use strict';\nmodule.exports = {\n${requires}\n};\n`,
			resolveDir: ROOT,
			sourcefile: 'test-entry.js',
			loader: 'js',
		},
		bundle: true,
		platform: 'node',
		format: 'cjs',
		write: false,
		external: ['vscode'],
		logLevel: 'silent',
	});

	const code = result.outputFiles[0].text;
	const loaded = { exports: {} };
	const localRequire = id => (id === 'vscode' ? vscode : require(id));

	new Function('module', 'exports', 'require', code)(loaded, loaded.exports, localRequire);

	return { modules: loaded.exports, vscode };
}

/**
 * 收集日志的假 logger。
 *
 * 用 `messages(level)` 断言「某级别下没有日志」比断言文案更稳：文案会改，行为不会。
 */
function createLogger() {
	const lines = [];
	const record = level => (...args) => {
		lines.push({ level, text: args.map(arg => (typeof arg === 'string' ? arg : String(arg))).join(' ') });
	};
	return {
		lines,
		trace: record('trace'),
		debug: record('debug'),
		info: record('info'),
		warn: record('warn'),
		error: record('error'),
		show() { },
		/** 某个级别下的全部日志文本。 */
		messages(level) {
			return lines.filter(line => line.level === level).map(line => line.text);
		},
	};
}

/**
 * 假的 `ReadableStream`。
 *
 * 只要 `getReader()` 返回的对象形状对（`read` / `cancel` / `releaseLock`）即可，
 * 不需要真的 `ReadableStream`——用的是全局类，Node 版本变了行为也可能变。
 *
 * @param {Array<string | Uint8Array>} chunks 依次吐出的分片；字符串按 UTF-8 编码。
 * @param {{ hang?: boolean }} [options] `hang` 为真时读完分片后不再返回 `done`，
 *   用于触发静默超时。
 */
function streamOf(chunks, options = {}) {
	const encoder = new TextEncoder();
	return {
		getReader() {
			let index = 0;
			let cancelled = false;
			return {
				async read() {
					if (cancelled) {
						return { done: true, value: undefined };
					}
					if (index < chunks.length) {
						const chunk = chunks[index++];
						return { done: false, value: typeof chunk === 'string' ? encoder.encode(chunk) : chunk };
					}
					if (options.hang === true) {
						// 永不 settle：模拟连接还在但不再吐数据
						return new Promise(() => { });
					}
					return { done: true, value: undefined };
				},
				async cancel() {
					cancelled = true;
				},
				releaseLock() { },
			};
		},
	};
}

/** 把异步生成器收成数组，省掉每个用例里的 `for await` 样板。 */
async function collect(iterable) {
	const items = [];
	for await (const item of iterable) {
		items.push(item);
	}
	return items;
}

module.exports = { ROOT, load, createLogger, streamOf, collect };
