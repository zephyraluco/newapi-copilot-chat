/**
 * 校验分层约束：**只有明确列出的文件可以依赖 VS Code 运行时**。
 *
 * 文档里写着「`client` 不 import vscode」「翻译层不碰 vscode」，但这类约定靠人守不住：
 * 一次顺手 `import * as vscode` 就会把纯逻辑模块变成必须在扩展宿主里才能加载。
 * 因此把「谁可以与宿主有关」写成一张显式的名单，其余文件一旦出现运行时依赖（非 `import type`）
 * 就报错并退出码 1。
 *
 * 用法：`npm run check-layering`。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

/**
 * 允许依赖 VS Code 运行时的文件（相对 `src/`）。
 *
 * 划进来的理由只有两类：**它就是与宿主对话的那一层**（provider 的上报/编排、status 的界面、
 * extension 的装配、logger 的输出通道），或者**它读设置与取消信号**（config、cancellation）。
 * 其余模块应当是纯逻辑——不需要扩展宿主就能加载，也就不必为了碰它们而启动一个 VS Code。
 */
const HOST_DEPENDENT = [
	'extension.ts',
	'commands.ts',
	'config.ts',
	'cancellation.ts',
	'logger.ts',
	'models/catalog.ts',
	'provider/chatProvider.ts',
	'provider/errorMapping.ts',
	'provider/messages.ts',
	'provider/preflight.ts',
	'provider/replay.ts',
	'provider/responseParts.ts',
	'provider/streamFlow.ts',
	'provider/thinking.ts',
	'provider/tokenizer.ts',
	'provider/toolFlow.ts',
	'runtime/session.ts',
	'status/statusBar.ts',
	'status/statusService.ts',
];

/** 运行时依赖 vscode 的 import（`import type` 不算）。 */
const RUNTIME_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+'vscode'/m;

function listSourceFiles(dir) {
	const out = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listSourceFiles(full));
		} else if (entry.name.endsWith('.ts')) {
			out.push(full);
		}
	}
	return out.sort();
}

function main() {
	const allowed = new Set(HOST_DEPENDENT);
	const violations = [];

	for (const file of listSourceFiles(SRC)) {
		const relative = path.relative(SRC, file).split(path.sep).join('/');
		const text = fs.readFileSync(file, 'utf8');
		const importsVscode = RUNTIME_IMPORT.test(text);
		const isAllowed = allowed.has(relative);

		if (importsVscode && !isAllowed) {
			violations.push(`${relative}：依赖了 VS Code 运行时，但不在名单里`);
		}
		if (!importsVscode && isAllowed) {
			violations.push(`${relative}：名单里说它依赖宿主，实际已经不依赖了，请移出名单`);
		}
	}

	if (violations.length === 0) {
		console.log(`分层约束成立（${HOST_DEPENDENT.length} 个文件依赖宿主，其余保持纯粹）。`);
		return;
	}

	console.error('分层约束被破坏：');
	for (const violation of violations) {
		console.error(`  - ${violation}`);
	}
	console.error('（名单在 scripts/check-layering.js 顶部；新增依赖宿主的文件时在那里登记。）');
	process.exitCode = 1;
}

main();
