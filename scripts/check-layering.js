/** Check real module edges (including type imports) and cycles using the TypeScript AST. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const allowed = {
	provider: ['provider', 'application', 'protocol', 'models', 'transport', 'utils'],
	application: ['application', 'models', 'transport', 'protocol', 'utils'],
	transport: ['transport', 'protocol', 'utils'],
	protocol: ['protocol', 'models', 'utils'],
	models: ['models', 'utils'],
	utils: ['utils'],
};

function dependencies(source, file) {
	const imports = [];
	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
	function visit(node) {
		if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
			if (ts.isStringLiteral(node.moduleSpecifier)) { imports.push(node.moduleSpecifier.text); }
		} else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
			const expression = node.moduleReference.expression;
			if (expression && ts.isStringLiteral(expression)) { imports.push(expression.text); }
		} else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
			|| (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
			if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) { imports.push(node.arguments[0].text); }
		} else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
			imports.push(node.argument.literal.text);
		}
		ts.forEachChild(node, visit);
	}
	visit(tree);
	return imports;
}

/** Paths are POSIX-relative to src; taking source strings also makes the rules testable. */
function checkArchitecture(files) {
	const errors = [];
	const graph = new Map();
	for (const [file, source] of files) {
		const layer = file.split('/')[0];
		const entry = file === 'extension.ts';
		if (!entry && !allowed[layer]) { errors.push(`${file}: 未声明的架构层`); }
		const edges = [];
		for (const dependency of dependencies(source, file)) {
			if (dependency === 'vscode' && layer !== 'provider' && !entry) {
				errors.push(`${file}: 只有 provider 可以依赖 vscode`);
			}
			if (!dependency.startsWith('.')) { continue; }
			const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), dependency));
			const target = [base, `${base}.ts`, `${base}/index.ts`].find(candidate => files.has(candidate));
			if (!target) { errors.push(`${file}: 无法解析 ${dependency}`); continue; }
			const targetLayer = target.split('/')[0];
			if (!entry && !allowed[layer]?.includes(targetLayer)) {
				errors.push(`${file} → ${target}: 禁止反向/跨层依赖`);
			}
			edges.push(target);
		}
		graph.set(file, edges);
	}
	const visited = new Set();
	const stack = [];
	function visit(file) {
		const index = stack.indexOf(file);
		if (index >= 0) { errors.push(`循环依赖: ${[...stack.slice(index), file].join(' → ')}`); return; }
		if (visited.has(file)) { return; }
		stack.push(file);
		for (const dependency of graph.get(file) ?? []) { visit(dependency); }
		stack.pop();
		visited.add(file);
	}
	for (const file of graph.keys()) { visit(file); }
	return errors;
}

function main() {
	const root = path.resolve(__dirname, '../src');
	const files = new Map();
	function scan(directory) {
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) { if (entry.name !== 'test') { scan(full); } }
			else if (entry.name.endsWith('.ts')) { files.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')); }
		}
	}
	scan(root);
	const errors = checkArchitecture(files);
	if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
	else { console.log(`架构检查通过：${files.size} 个模块，六层依赖方向与无环约束成立。`); }
}

module.exports = { checkArchitecture };
if (require.main === module) { main(); }
