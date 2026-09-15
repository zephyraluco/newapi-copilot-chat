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

const EXPECTED_COMMANDS = [
	'newapi-copilot-chat.testConnection',
	'newapi-copilot-chat.refreshModels',
	'newapi-copilot-chat.showPanel',
	'newapi-copilot-chat.openSettings',
];

suite('扩展装配', () => {
	test('扩展可以被激活', async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, `找不到扩展 ${EXTENSION_ID}`);
		await extension.activate();
		assert.strictEqual(extension.isActive, true, '激活后 isActive 应该为 true');
	});

	test('所有命令都已注册', async () => {
		const registered = await vscode.commands.getCommands(true);
		for (const command of EXPECTED_COMMANDS) {
			assert.ok(registered.includes(command), `命令 ${command} 未注册`);
		}
	});

	test('激活过程不会因缺少配置而失败', async () => {
		// 测试环境里没有配置任何站点，激活应当正常完成，
		// 只是不提供模型——这正是「未配置」路径必须可靠的原因。
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		await extension?.activate();
		assert.ok(vscode.lm, '语言模型 API 应可用');
	});
});
