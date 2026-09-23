/**
 * 命令实现：测试连接、刷新模型列表、打开设置、重置用量统计。
 *
 * 从 `extension.ts` 抽出来的原因是有实际业务判断在里面（哪些站点算失败、给用户什么建议），
 * 而 `activate()` 里既测不了也不该越堆越长。这里只依赖注入进来的几个函数，
 * 状态与判定口径与状态栏完全同源（都读 `StatusService`）。
 */

import * as vscode from 'vscode';
import { COMMANDS, MANAGE_MODELS_COMMAND } from './consts';
import type { Logger } from './logger';
import type { StatusState } from './status/statusService';

/** 命令需要的运行时依赖。 */
export interface CommandDeps {
	readonly logger: Logger;
	/** 本扩展 ID，用于打开设置页 */
	readonly extensionId: string;
	/** 取当前状态快照。命令的判定与状态栏同源 */
	getState(): StatusState;
	/** 是否已配置了至少一个站点 */
	hasTargets(): boolean;
	/** 刷新所有配置组（`forceModels` 表示忽略模型缓存） */
	refresh(options: { forceModels: boolean }): Promise<void>;
	/** 通知 VS Code 重新发现模型 */
	notifyModelsChanged(): void;
	/** 清空本次会话的用量统计 */
	resetUsage(): void;
}

/** 注册全部命令。 */
export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(COMMANDS.testConnection, () => testConnection(deps)),
		vscode.commands.registerCommand(COMMANDS.refreshModels, () => refreshModels(deps)),
		vscode.commands.registerCommand(COMMANDS.openSettings, () => openSettings(deps.extensionId)),
		vscode.commands.registerCommand(COMMANDS.resetUsage, () => deps.resetUsage()),
	];
}

/**
 * 刷新状态并通知 VS Code 重新发现模型。
 *
 * 这两件事总是一起发生（模型列表变了就得让宿主重新拉取），因此收在一处，
 * 免得某个入口漏掉通知——那样表现为「刷新了但选择器里还是旧的」。
 */
export async function refreshAndNotify(deps: CommandDeps, forceModels: boolean): Promise<void> {
	await deps.refresh({ forceModels });
	deps.notifyModelsChanged();
}

/** 打开 VS Code 的「管理语言模型」界面，用户在那里配置站点与密钥。 */
export async function openModelManagement(): Promise<void> {
	await vscode.commands.executeCommand(MANAGE_MODELS_COMMAND);
}

/** 打开本扩展的设置页（请求参数、状态栏等）。 */
export async function openSettings(extensionId: string): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${extensionId}`);
}

/* -------------------------------------------------------------------------- */

/**
 * 尚未配置时统一的提示入口。
 *
 * @returns 用户是否已经配置好站点（用于决定后续动作是否继续）
 */
async function requireConfiguredTargets(deps: CommandDeps): Promise<boolean> {
	if (deps.hasTargets()) {
		return true;
	}
	const action = await vscode.window.showWarningMessage('尚未配置 New API 站点。', '打开配置界面');
	if (action === '打开配置界面') {
		await openModelManagement();
	}
	return false;
}

/** 测试连接：刷新所有配置组，并把结果报告给用户。 */
async function testConnection(deps: CommandDeps): Promise<void> {
	if (!(await requireConfiguredTargets(deps))) {
		return;
	}

	await refreshAndNotify(deps, true);

	const targets = deps.getState().targets;
	const failed = targets.filter(target => target.usable && target.models.error !== undefined);
	const succeeded = targets.filter(target => target.usable && target.models.error === undefined);

	if (failed.length === 0) {
		const summary = succeeded
			.map(target => `${target.label}（${target.models.count} 个模型，${target.latencyMs ?? 0}ms）`)
			.join('；');
		vscode.window.showInformationMessage(`连接成功：${summary}`);
		return;
	}

	const detail = failed.map(target => `${target.label}：${target.models.error}`).join('；');
	const action = await vscode.window.showErrorMessage(`连接失败：${detail}`, '显示日志');
	if (action === '显示日志') {
		deps.logger.outputChannel.show();
	}
}

/** 强制刷新所有配置组的模型列表。 */
async function refreshModels(deps: CommandDeps): Promise<void> {
	if (!(await requireConfiguredTargets(deps))) {
		return;
	}

	await refreshAndNotify(deps, true);

	const targets = deps.getState().targets;
	const failed = targets.filter(target => target.usable && target.models.error !== undefined);
	if (failed.length > 0) {
		const detail = failed.map(target => `${target.label}：${target.models.error}`).join('；');
		const action = await vscode.window.showErrorMessage(`刷新模型列表失败：${detail}`, '显示日志');
		if (action === '显示日志') {
			deps.logger.outputChannel.show();
		}
		return;
	}

	const total = targets.reduce((sum, target) => sum + target.models.count, 0);
	vscode.window.showInformationMessage(
		`已刷新：${targets.length} 个配置组共 ${total} 个可用模型。`,
	);
}
