/**
 * 纯逻辑套件的运行前准备（配合 `npm run test:unit`，即 `node --test`）。
 *
 * 两件事：
 *
 * 1. **把 `vscode` 换成替身**（`vscode-stub.cjs`）。这些测试文件里的 `import * as vscode`
 *    只用到类型（编译后不留 `require`），但它们依赖的 `logger.ts` 会在构造时创建输出通道。
 * 2. **提供 mocha 风格的全局函数**。测试文件用的是 `suite` / `test` / `setup` / `teardown`，
 *    这里映射到 `node:test` 的同义 API，于是**同一份文件既能被 `vscode-test`（mocha）收集，
 *    也能被 `node --test` 跑**——不必为两个运行器各维护一份用例。
 */

const Module = require('node:module');
const { after, before, describe, it } = require('node:test');

const vscodeStub = require('./vscode-stub.cjs');

const loadModule = Module._load;
Module._load = function load(request, ...rest) {
	if (request === 'vscode') {
		return vscodeStub;
	}
	return loadModule.call(this, request, ...rest);
};

Object.assign(globalThis, {
	suite: describe,
	test: it,
	setup: before,
	teardown: after,
});
