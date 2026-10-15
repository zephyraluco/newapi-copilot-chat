const test = require('node:test');
const assert = require('node:assert/strict');
const { checkArchitecture } = require('../../scripts/check-layering');

test('架构：纯模块的 type import、动态导入与 require 也不能绕过宿主边界', () => {
	for (const source of ["import type { Uri } from 'vscode';", "const host = import('vscode');", "const host = require('vscode');"]) {
		assert.match(checkArchitecture(new Map([['protocol/a.ts', source]])).join(' '), /只有 host/);
	}
});
test('架构：重导出和类型边也检查依赖方向及循环', () => {
	assert.match(checkArchitecture(new Map([
		['shared/a.ts', "export * from '../host/b';"], ['host/b.ts', "import type { A } from '../shared/a';"],
	])).join(' '), /禁止反向/);
	assert.match(checkArchitecture(new Map([
		['protocol/a.ts', "import type { B } from './b';"], ['protocol/b.ts', "export * from './a';"],
	])).join(' '), /循环依赖/);
});
test('架构：合法的单向依赖通过，注释中的 import 不产生假阳性', () => {
	assert.deepEqual(checkArchitecture(new Map([
		['host/a.ts', "import { X } from '../shared/b'; import 'vscode';"],
		['shared/b.ts', "// import 'vscode';\nexport const X = 1;"],
	])), []);
});
