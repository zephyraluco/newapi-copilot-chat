/**
 * 校验 `docs/ARCHITECTURE.md` 里的统计数字。
 *
 * 文档的 §3「代码地图」逐行给出每个文件的行数，§13 给出用例总数；这些数字会随代码漂移，
 * 而**错的数字比没有数字更糟**（读者会照着行号去翻文件）。因此这里把它们当作断言来跑：
 * 逐行核对文档写的行数与磁盘上的实际行数，不一致就列出全部差异并退出码 1。
 *
 * 用法：`npm run check-docs`（`--fix` 只打印建议，不改文件——文档仍需人工确认措辞）。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'ARCHITECTURE.md');

/** 与 `Get-Content`、`read_file` 一致的行数（末尾换行不算额外一行）。 */
function countLines(file) {
	const text = fs.readFileSync(file, 'utf8');
	const lines = text.split('\n');
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines.length;
}

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

/** 文档里的 `1,234` / `142` 都算数字。 */
function parseCount(raw) {
	if (!/^[\d,]+$/.test(raw.trim())) {
		return undefined;
	}
	return Number(raw.trim().replace(/,/g, ''));
}

const problems = [];
const checks = [];

function verify(label, actual, expected) {
	checks.push(label);
	if (actual !== expected) {
		problems.push(`${label}：文档写 ${expected}，实际 ${actual}`);
	}
}

/**
 * §3 的代码地图是一张固定形状的表：`| \`文件名\` | 行数 | 职责 |`，
 * 文件列可以写多个（用 ` / ` 分隔）或一个目录。分组标题行（`| **\`adapter/\`** … |`）
 * 决定后面那些相对路径落在哪个目录下。
 */
function resolveTargets(spec, dir) {
	// `test/*.ts` 这类整体行：`src/test/` 下的全部文件（含 fakes / helpers）
	if (spec === 'test/*.ts') {
		return listSourceFiles(path.join(ROOT, 'src', 'test'));
	}
	// `deepseek/` 这类目录行：该目录下所有源文件
	if (spec.endsWith('/')) {
		return listSourceFiles(path.join(ROOT, 'src', dir, spec));
	}
	return [path.join(ROOT, 'src', dir, spec)];
}

function checkCodeMap(lines) {
	let inCodeMap = false;
	// 当前分组对应的目录（基础层的文件直接放在 src/ 下，因此默认是空）
	let dir = '';
	let testFileCount;
	let testCaseCount;

	for (const line of lines) {
		if (line.startsWith('## 3.')) {
			inCodeMap = true;
			continue;
		}
		if (inCodeMap && line.startsWith('## 4.')) {
			break;
		}
		if (!inCodeMap) {
			continue;
		}

		const cells = line.split('|').map(c => c.trim());
		if (cells.length < 4) {
			continue;
		}

		// 分组标题行：`| **`adapter/`** 差异出口 | | |`
		const group = cells[1].match(/^\*\*`([^`]*)`\*\*/);
		if (group !== null) {
			dir = group[1].replace(/\/$/, '');
			continue;
		}
		// `| **基础层** | | |` 与 `| **测试** | | |` 没有路径，按各自的目录处理
		if (cells[1].startsWith('**')) {
			dir = cells[1].includes('测试') ? 'test' : '';
			continue;
		}

		if (!cells[1].startsWith('`')) {
			continue;
		}

		// 文件列可能是一串用 ` / ` 分隔的反引号路径，逐个取出
		const specs = [...cells[1].matchAll(/`([^`]+)`/g)].map(m => m[1]);
		if (specs.length === 0) {
			continue;
		}
		const expected = parseCount(cells[2]);
		if (expected === undefined) {
			continue;
		}

		const files = specs.flatMap(spec => resolveTargets(spec, dir));
		if (files.some(f => !fs.existsSync(f))) {
			problems.push(`文档提到的文件不存在：${specs.join(' / ')}（在 src/${dir}）`);
			continue;
		}
		const actual = files.reduce((sum, f) => sum + countLines(f), 0);
		verify(specs.join(' / '), actual, expected);

		if (specs[0] === 'test/*.ts') {
			testFileCount = files.length;
			// 同一行右侧写着用例数：`330 个用例 + 注入用的假对象…`
			const cases = line.match(/([\d,]+)\s*个用例/);
			if (cases !== null) {
				testCaseCount = parseCount(cases[1]);
			}
		}
	}

	return { testFileCount, testCaseCount };
}

/** §13 的开头一句：`330 个用例，只覆盖…` */
function checkTestCases(lines, testCaseCount) {
	const section = lines.join('\n').split('## 13.')[1];
	if (section === undefined) {
		problems.push('找不到 §13「测试」一节');
		return;
	}
	const stated = section.match(/([\d,]+)\s*个用例/);
	if (stated === null) {
		problems.push('§13 没有写用例总数');
		return;
	}
	const expected = parseCount(stated[1]);
	if (testCaseCount !== undefined && testCaseCount !== expected) {
		problems.push(`§3 与 §13 的用例数互相矛盾：${testCaseCount} vs ${expected}`);
	}
	return expected;
}

function countTestCases() {
	let total = 0;
	for (const file of listSourceFiles(path.join(ROOT, 'src', 'test'))) {
		if (!file.endsWith('.test.ts')) {
			continue;
		}
		const text = fs.readFileSync(file, 'utf8');
		total += (text.match(/^\s*test\(/gm) ?? []).length;
	}
	return total;
}

function main() {
	const text = fs.readFileSync(DOC, 'utf8');
	const lines = text.split('\n');

	const { testFileCount, testCaseCount } = checkCodeMap(lines);
	const statedCases = checkTestCases(lines, testCaseCount);

	// 测试文件数与用例数用实际代码核对（文档里的「19 个文件」「330 个用例」）
	const actualFiles = listSourceFiles(path.join(ROOT, 'src', 'test')).length;
	if (testFileCount !== undefined) {
		verify('§3 测试文件数', actualFiles, testFileCount);
	}
	if (statedCases !== undefined) {
		verify('§13 用例总数', countTestCases(), statedCases);
	}

	if (problems.length === 0) {
		console.log(`文档统计与代码一致（核对 ${checks.length} 项）。`);
		return;
	}
	console.error(`文档统计与代码不一致（核对 ${checks.length} 项，${problems.length} 项有误）：`);
	for (const problem of problems) {
		console.error(`  - ${problem}`);
	}
	process.exitCode = 1;
}

main();
