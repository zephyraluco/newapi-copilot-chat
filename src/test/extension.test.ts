import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * 装配检查。
 *
 * 这里只验证「激活过程没有炸」以及「命令都注册上了」，
 * 业务逻辑的测试见 `models.test.ts` / `provider.test.ts` / `target.test.ts`。
 * 真实网络交互需要可用的 New API 站点，因此不在自动化测试范围内。
 */

const EXTENSION_ID = 'newapi.newapi-copilot-chat';

/** 本扩展的 vendor 前缀（命令 ID 都挂在它下面）。 */
const COMMAND_PREFIX = 'newapi-copilot-chat.';

const EXPECTED_COMMANDS = [
	`${COMMAND_PREFIX}testConnection`,
	`${COMMAND_PREFIX}refreshModels`,
	`${COMMAND_PREFIX}openSettings`,
	`${COMMAND_PREFIX}resetUsage`,
];

suite('扩展装配', () => {
	test('扩展可以被激活', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `找不到扩展 ${EXTENSION_ID}`);
		await extension.activate();
		assert.strictEqual(extension.isActive, true, '激活后 isActive 应该为 true');
	});

	test('命令与清单完全一致（不多不少）', async () => {
		// 比对完整集合而不是逐个 contains：漏掉一个命令（例如 package.json 里贡献了
		// 但忘了 registerCommand）与多出一个没人贡献的命令，都是真实的故障。
		const registered = (await vscode.commands.getCommands(true))
			.filter(command => command.startsWith(COMMAND_PREFIX));
		assert.deepStrictEqual([...registered].sort(), [...EXPECTED_COMMANDS].sort());
	});

	test('重置用量可以在没有配置站点时安全调用', async () => {
		// 命令面板里可以随时执行它，因此「尚未配置」与「还没有请求」都必须不报错
		await vscode.commands.executeCommand(`${COMMAND_PREFIX}resetUsage`);
	});

	test('激活过程不会因缺少配置而失败', async () => {
		// 测试环境里没有配置任何站点，激活应当正常完成，
		// 只是不提供模型——这正是「未配置」路径必须可靠的原因。
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();
		assert.ok(vscode.lm, '语言模型 API 应可用');
	});
});
