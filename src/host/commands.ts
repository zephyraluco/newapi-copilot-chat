import * as vscode from 'vscode';
import { COMMANDS, MANAGE_MODELS_COMMAND } from '../shared/consts';
import type { ModelStatus } from '../application/modelStatus';
import type { Logger } from './logger';

export interface CommandDeps {
	readonly logger: Logger;
	readonly extensionId: string;
	getState(): ModelStatus;
	refreshModels(): Promise<void>;
	notifyModelsChanged(): void;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand(COMMANDS.refreshModels, () => refreshModels(deps)),
		vscode.commands.registerCommand(COMMANDS.openSettings, () =>
			vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${deps.extensionId}`)),
	];
}

async function refreshModels(deps: CommandDeps): Promise<void> {
	if (!deps.getState().targets.length) {
		const action = await vscode.window.showWarningMessage('尚未配置 New API 站点。', '打开配置界面');
		if (action === '打开配置界面') { await vscode.commands.executeCommand(MANAGE_MODELS_COMMAND); }
		return;
	}
	try {
		await deps.refreshModels();
		deps.notifyModelsChanged();
		const state = deps.getState();
		const failed = state.targets.filter(target => target.error !== undefined);
		if (failed.length) {
			const action = await vscode.window.showErrorMessage(
				`刷新模型列表失败：${failed.map(target => `${target.label}：${target.error}`).join('；')}`, '显示日志');
			if (action === '显示日志') { deps.logger.outputChannel.show(); }
		} else {
			await vscode.window.showInformationMessage(`已刷新：${state.targets.length} 个配置组共 ${state.totalModels} 个可用模型。`);
		}
	} catch (error) {
		deps.logger.error('刷新模型列表失败', error);
		await vscode.window.showErrorMessage(`刷新模型列表失败：${error instanceof Error ? error.message : String(error)}`);
	}
}
