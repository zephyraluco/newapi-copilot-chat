/**
 * 扩展入口：装配模块并注册命令。这里刻意只做接线，不放业务逻辑。
 *
 * ```
 *   VS Code 的配置组 ──▶ ProviderTarget（target.ts）
 *                             │
 *                             ▼
 *   SessionRegistry ──▶ ModelCatalog ──拉取并整合──▶ ModelConfig[]
 *         │                        │
 *         │                        └──▶ NewApiChatProvider ──▶ Copilot Chat
 *         └──▶ StatusService ──▶ 状态栏 / 状态面板 ──命令──┘
 * ```
 */

import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { createDefaultAdapterRegistry } from './adapter/registry';
import { ConfigService } from './config';
import {
	COMMANDS,
	CONFIG_SECTION,
	MANAGE_MODELS_COMMAND,
	VENDOR_ID,
	initRuntimeInfo,
	runtimeInfo,
} from './consts';
import { safeJsonParse } from './json';
import { Logger, LoggerService, parseLogLevelName } from './logger';
import { MODEL_DATASET_DIR, MODEL_DATASET_FILE, installModelDataset } from './models/dataset';
import { MODEL_SOURCE_LABEL } from './models/tooltip';
import { NewApiChatProvider } from './provider/chatProvider';
import { SessionRegistry } from './provider/session';
import { StatusPanel, type PanelModelRow, type PanelModelsPayload } from './status/panel';
import { NewApiStatusBar } from './status/statusBar';
import { StatusService } from './status/statusService';

/** 模型数据表文件的绝对路径。 */
function datasetFile(context: vscode.ExtensionContext): string {
	return vscode.Uri.joinPath(context.extensionUri, MODEL_DATASET_DIR, MODEL_DATASET_FILE).fsPath;
}

/**
 * 读取随包附带的模型数据表。
 *
 * 同步读取：文件在几十 KB 量级，而模型发现随时可能发生；同步读能保证「激活完成」
 * 就等于「数据表可用」，不必让 provider 等待一个异步初始化。
 * 文件缺失或损坏时只会让数据表为空（模型配置退回「网关返回值 + 默认值」），
 * 不影响扩展其余部分。
 */
function loadModelDataset(context: vscode.ExtensionContext, logger: Logger): void {
	const file = datasetFile(context);
	let raw: unknown;
	try {
		raw = safeJsonParse(readFileSync(file, 'utf8'));
	} catch (error) {
		logger.warn(`未能读取模型数据表 ${file}：${error instanceof Error ? error.message : String(error)}`);
		installModelDataset(undefined);
		return;
	}
	if (raw === undefined) {
		logger.warn(`模型数据表不是合法 JSON，已忽略：${file}`);
		installModelDataset(undefined);
		return;
	}

	const dataset = installModelDataset(raw);
	const skipped = dataset.skipped > 0 ? `，忽略 ${dataset.skipped} 条不完整记录` : '';
	logger.info(`已加载模型数据表：${dataset.entries.length} 条记录${skipped}`);
	if (dataset.generatedAt !== undefined) {
		logger.debug(`模型数据表生成时间：${dataset.generatedAt}`);
	}
}

/** 激活扩展。 */
export function activate(context: vscode.ExtensionContext): void {
	initRuntimeInfo(String(context.extension.packageJSON.version ?? '0.0.0'));

	// 日志服务必须先于配置服务：读取配置的过程本身就会写日志。
	// 因此先用原始设置取一个初始级别，拿到完整配置后再校正一次。
	const bootstrapLevel = parseLogLevelName(
		vscode.workspace.getConfiguration(CONFIG_SECTION).get('logLevel'),
	);
	const loggerService = new LoggerService(bootstrapLevel);
	const logger = new Logger(loggerService, 'ext');
	logger.info(`激活 New API for Copilot Chat v${runtimeInfo.extensionVersion}`);

	const config = new ConfigService(logger.child('config'));
	loggerService.setLevel(config.settings.logLevel);
	loggerService.warnIfChannelLevelBlocks();
	logger.debug('初始配置', config.summary());

	const dataset = datasetFile(context);
	loadModelDataset(context, logger);

	const adapters = createDefaultAdapterRegistry(logger.child('adapter'));
	const sessions = new SessionRegistry({
		logger: logger.child('session'),
		getModelSettings: () => config.settings.models,
		getRequestSettings: () => config.settings.request,
	});

	const statusService = new StatusService({
		logger: logger.child('status'),
		config,
		sessions,
		getAdapters: () => adapters.list().map(adapter => ({
			id: adapter.id,
			description: adapter.description,
		})),
	});

	const provider = new NewApiChatProvider({
		logger: logger.child('provider'),
		sessions,
		adapters,
		getSettings: () => config.settings,
		reportUsage: (targetLabel, modelId, usage, summary) =>
			statusService.recordUsage(targetLabel, modelId, usage, summary),
	});

	const statusBar = new NewApiStatusBar(logger.child('statusbar'));

	const panel = new StatusPanel({
		logger: logger.child('panel'),
		service: statusService,
		actions: {
			refresh: async forceModels => {
				await statusService.refresh({ forceModels });
				provider.notifyModelsChanged();
			},
			openModelManagement,
			openSettings,
			showLogs: () => logger.outputChannel.show(),
			resetUsage: () => statusService.resetUsage(),
		},
		getModels: getModelRows,
	});

	// ---------------------------------------------------------------------
	// 注册 provider（vendor 必须与 package.json 的贡献点一致）
	// ---------------------------------------------------------------------
	const providerRegistration = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);
	logger.info(`已注册语言模型供应商：${VENDOR_ID}`);

	// ---------------------------------------------------------------------
	// 渲染与联动
	// ---------------------------------------------------------------------
	const statusListener = statusService.onDidChange(state => statusBar.render(state));

	const configListener = config.onDidChange(settings => {
		loggerService.setLevel(settings.logLevel);
		void statusService.refresh({ forceModels: true }).then(() => provider.notifyModelsChanged());
	});

	// 数据表是随包发布的生成产物，因此在激活时读一次即可（要更新就重跑生成脚本）

	// ---------------------------------------------------------------------
	// 命令
	// ---------------------------------------------------------------------
	const commands: vscode.Disposable[] = [
		vscode.commands.registerCommand(COMMANDS.testConnection, () => testConnection()),
		vscode.commands.registerCommand(COMMANDS.refreshModels, () => refreshModels()),
		vscode.commands.registerCommand(COMMANDS.showPanel, () => panel.show()),
		vscode.commands.registerCommand(COMMANDS.openSettings, () => openSettings()),
	];

	context.subscriptions.push(
		loggerService,
		config,
		sessions,
		statusService,
		provider,
		statusBar,
		panel,
		providerRegistration,
		statusListener,
		configListener,
		...commands,
	);

	statusService.start();

	// ---------------------------------------------------------------------
	// 内部函数（放在 activate 内以共享上方的闭包状态）
	// ---------------------------------------------------------------------

	/** 面板需要的模型清单：把所有配置组的模型汇总到一起。 */
	function getModelRows(): PanelModelsPayload {
		const rows: PanelModelRow[] = [];
		const filtered: { id: string; reason: string }[] = [];
		const errors: string[] = [];

		for (const session of sessions.list()) {
			const snapshot = session.catalog.current;
			if (snapshot === undefined) {
				continue;
			}
			for (const model of snapshot.models) {
				rows.push({
					id: model.id,
					name: model.name,
					detail: model.detail,
					group: session.target.label,
					contextWindow: model.contextWindow,
					maxOutputTokens: model.maxOutputTokens,
					imageInput: model.imageInput,
					toolCalling: model.toolCalling,
					reasoning: model.reasoning,
					vendor: model.meta.vendor,
					ownedBy: model.meta.ownedBy,
					datasetKey: model.meta.datasetKey,
					contextSource: MODEL_SOURCE_LABEL[model.meta.provenance.contextWindow ?? 'default'],
				});
			}
			for (const item of snapshot.filtered) {
				filtered.push({ id: `${item.id}（${session.target.label}）`, reason: item.reason });
			}
			if (snapshot.error !== undefined) {
				errors.push(`${session.target.label}：${snapshot.error}`);
			}
		}

		return {
			rows,
			filtered,
			error: errors.length > 0 ? errors.join('；') : undefined,
		};
	}

	/** 打开 VS Code 的「管理语言模型」界面，用户在那里配置站点与密钥。 */
	async function openModelManagement(): Promise<void> {
		await vscode.commands.executeCommand(MANAGE_MODELS_COMMAND);
	}

	/** 打开本扩展的设置页（模型过滤、请求参数等）。 */
	async function openSettings(): Promise<void> {
		await vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`);
	}

	/**
	 * 尚未配置时统一的提示入口。
	 *
	 * @returns 用户是否选择去配置（用于决定后续动作是否继续）
	 */
	async function requireConfiguredTargets(): Promise<boolean> {
		if (sessions.list().length > 0) {
			return true;
		}
		const action = await vscode.window.showWarningMessage(
			'尚未配置 New API 站点。',
			'打开配置界面',
		);
		if (action === '打开配置界面') {
			await openModelManagement();
		}
		return false;
	}

	/** 测试连接：刷新所有配置组，并把结果报告给用户。 */
	async function testConnection(): Promise<void> {
		if (!(await requireConfiguredTargets())) {
			return;
		}

		await statusService.refresh({ forceModels: true });
		provider.notifyModelsChanged();

		const targets = statusService.state.targets;
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
			logger.outputChannel.show();
		}
	}

	/** 强制刷新所有配置组的模型列表。 */
	async function refreshModels(): Promise<void> {
		if (!(await requireConfiguredTargets())) {
			return;
		}

		await statusService.refresh({ forceModels: true });
		provider.notifyModelsChanged();

		const targets = statusService.state.targets;
		const failed = targets.filter(target => target.usable && target.models.error !== undefined);
		if (failed.length > 0) {
			const detail = failed.map(target => `${target.label}：${target.models.error}`).join('；');
			const action = await vscode.window.showErrorMessage(`刷新模型列表失败：${detail}`, '显示日志');
			if (action === '显示日志') {
				logger.outputChannel.show();
			}
			return;
		}

		const total = targets.reduce((sum, target) => sum + target.models.count, 0);
		const filteredCount = targets.reduce((sum, target) => sum + target.models.filteredCount, 0);
		vscode.window.showInformationMessage(
			`已刷新：${targets.length} 个配置组共 ${total} 个可用模型` +
			(filteredCount > 0 ? `，已按过滤设置排除 ${filteredCount} 个。` : '。'),
		);
	}
}

/**
 * 停用扩展。
 *
 * 所有资源都已经挂在 `context.subscriptions` 上，由 VS Code 统一释放，
 * 因此这里没有额外工作。
 */
export function deactivate(): void {
	// 保留该导出以便 VS Code 明确识别扩展支持停用。
}
