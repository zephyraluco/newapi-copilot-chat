/**
 * 扩展入口：装配模块并注册命令，只做接线。
 *
 * ```
 *   VS Code 的配置组 ──▶ ProviderTarget（application/target.ts）
 *                             │
 *                             ▼
 *   SessionRegistry ──▶ ModelCatalog ──拉取并整合──▶ ModelConfig[]
 *         │                        │
 *         │                        └──▶ NewApiChatProvider ──▶ Copilot Chat
 *         └──▶ 模型快照 ──▶ 轻量状态栏与刷新命令
 * ```
 */

import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { createDefaultAdapterRegistry } from './protocol/registry';
import { registerCommands, type CommandDeps } from './provider/commands';
import { ConfigService } from './provider/config';
import { classifySettingsChange } from './utils/settings';
import { VENDOR_ID, initRuntimeInfo, runtimeInfo } from './utils/consts';
import { safeJsonParse } from './utils/json';
import { Logger, LoggerService } from './provider/logger';
import { MODEL_DATASET_DIR, MODEL_DATASET_FILE, installModelDataset } from './models/dataset';
import { NewApiChatProvider } from './provider/chatProvider';
import { SessionRegistry } from './application/session';
import { NewApiStatusBar } from './provider/statusBar';
import { readModelStatus } from './application/modelStatus';
import { SiteHealthService } from './application/siteHealth';
import { UsageTracker } from './application/usage';

/** 模型数据表文件的绝对路径。 */
function datasetFile(context: vscode.ExtensionContext): string {
	return vscode.Uri.joinPath(context.extensionUri, MODEL_DATASET_DIR, MODEL_DATASET_FILE).fsPath;
}

/**
 * 读取随包附带的模型数据表；文件不存在与内容不是合法 JSON 分开报错。
 */
function readModelDataset(logger: Logger, path: string): unknown {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		logger.warn(`未能读取模型数据表文件 ${path}：${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	const parsed = safeJsonParse(text);
	if (parsed === undefined) {
		logger.warn(`模型数据表文件不是合法 JSON，已忽略：${path}`);
	}
	return parsed;
}

/**
 * 载入随包附带的模型数据表。
 *
 * 同步读取：文件在几十 KB 量级，激活完成即数据表可用。文件缺失或损坏时数据表为空，
 * 不影响扩展其余部分。
 */
function loadModelDataset(context: vscode.ExtensionContext, logger: Logger): void {
	const raw = readModelDataset(logger, datasetFile(context));
	if (raw === undefined) {
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

	const loggerService = new LoggerService();
	const logger = new Logger(loggerService, 'ext');
	logger.info(`激活 New API for Copilot Chat v${runtimeInfo.extensionVersion}`);

	const config = new ConfigService(logger.child('config'));
	logger.debug('初始配置', config.summary());

	loadModelDataset(context, logger);

	const adapters = createDefaultAdapterRegistry();
	const sessions = new SessionRegistry({
		logger: logger.child('session'),
		getModelSettings: () => config.settings.models,
		getRequestSettings: () => config.settings.request,
	});
	const siteHealth = new SiteHealthService(sessions, logger.child('site-health'));
	const usage = new UsageTracker();

	const provider = new NewApiChatProvider({
		storageUri: context.storageUri,
		logger: logger.child('provider'),
		sessions,
		adapters,
		getSettings: () => config.settings,
		reportUsage: (targetLabel, modelId, responseUsage, toolCalls) => usage.record(targetLabel, modelId, responseUsage, toolCalls),
	});

	const statusBar = new NewApiStatusBar(logger.child('statusbar'));

	const commands: CommandDeps = {
		logger: logger.child('commands'),
		extensionId: context.extension.id,
		getState: () => readModelStatus(sessions.list()),
		refreshModels: () => sessions.refreshModels(),
		notifyModelsChanged: () => provider.notifyModelsChanged(),
	};

	// ---------------------------------------------------------------------
	// 注册 provider（vendor 必须与 package.json 的贡献点一致）
	// ---------------------------------------------------------------------
	const providerRegistration = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);
	logger.info(`已注册语言模型供应商：${VENDOR_ID}`);

	// ---------------------------------------------------------------------
	// 渲染与联动
	// ---------------------------------------------------------------------
	const renderStatus = () => statusBar.render(readModelStatus(sessions.list()), config.settings.status.showStatusBar,
		usage.snapshot, siteHealth.snapshot);
	const statusListener = sessions.onDidChange(renderStatus);
	const probeListener = siteHealth.onDidChange(renderStatus);
	const usageListener = usage.onDidChange(renderStatus);

	let previousSettings = config.settings;
	const configListener = config.onDidChange(settings => {
		const scope = classifySettingsChange(previousSettings, settings);
		previousSettings = settings;
		sessions.configure(scope.client, scope.models);
		if (scope.status) {
			siteHealth.configure(settings.status.refreshIntervalMs);
			renderStatus();
		}
		// 只有会影响模型列表（或连接身份）的变化才让宿主重新发现模型。
		if (scope.models || scope.client) {
			provider.notifyModelsChanged();
		}
	});

	context.subscriptions.push(
		loggerService,
		config,
		sessions,
		siteHealth,
		usage,
		provider,
		statusBar,
		providerRegistration,
		statusListener,
		probeListener,
		usageListener,
		configListener,
		...registerCommands(commands),
	);

	renderStatus();
	siteHealth.start(config.settings.status.refreshIntervalMs);
}

/**
 * 停用扩展。所有资源都挂在 `context.subscriptions` 上，由 VS Code 统一释放。
 */
export function deactivate(): void {
	// 保留该导出，以便 VS Code 识别扩展支持停用。
}
