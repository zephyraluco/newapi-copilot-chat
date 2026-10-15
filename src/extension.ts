/**
 * 扩展入口：装配模块并注册命令，只做接线。
 *
 * ```
 *   VS Code 的配置组 ──▶ ProviderTarget（runtime/target.ts）
 *                             │
 *                             ▼
 *   SessionRegistry ──▶ ModelCatalog ──拉取并整合──▶ ModelConfig[]
 *         │                        │
 *         │                        └──▶ NewApiChatProvider ──▶ Copilot Chat
 *         └──▶ StatusService ──▶ 状态栏 ──┐
 *                                          └──▶ 命令（测试连接 / 刷新 / 设置）
 * ```
 */

import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { createDefaultAdapterRegistry } from './adapter/registry';
import { refreshAndNotify, registerCommands, type CommandDeps } from './commands';
import { ConfigService, classifySettingsChange } from './config';
import { CONFIG_SECTION, VENDOR_ID, initRuntimeInfo, runtimeInfo } from './consts';
import { safeJsonParse } from './json';
import { Logger, LoggerService, parseLogLevelName } from './logger';
import { MODEL_DATASET_DIR, MODEL_DATASET_FILE, installModelDataset } from './models/dataset';
import { NewApiChatProvider } from './provider/chatProvider';
import { SessionRegistry } from './runtime/session';
import { NewApiStatusBar } from './status/statusBar';
import { StatusService } from './status/statusService';

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

	// 日志服务必须先于配置服务：读取配置的过程本身就会写日志。
	// 先用原始设置取一个初始级别，拿到完整配置后再校正一次。
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
	});

	const provider = new NewApiChatProvider({
		storageUri: context.storageUri,
		logger: logger.child('provider'),
		sessions,
		adapters,
		getSettings: () => config.settings,
		reportUsage: (targetLabel, modelId, usage, summary) =>
			statusService.recordUsage(targetLabel, modelId, usage, summary),
	});

	const statusBar = new NewApiStatusBar(logger.child('statusbar'));

	const commands: CommandDeps = {
		logger: logger.child('commands'),
		extensionId: context.extension.id,
		getState: () => statusService.state,
		hasTargets: () => sessions.list().length > 0,
		refresh: options => statusService.refresh(options),
		notifyModelsChanged: () => provider.notifyModelsChanged(),
		resetUsage: () => statusService.resetUsage(),
	};

	// ---------------------------------------------------------------------
	// 注册 provider（vendor 必须与 package.json 的贡献点一致）
	// ---------------------------------------------------------------------
	const providerRegistration = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, provider);
	logger.info(`已注册语言模型供应商：${VENDOR_ID}`);

	// ---------------------------------------------------------------------
	// 渲染与联动
	// ---------------------------------------------------------------------
	const statusListener = statusService.onDidChange(state => statusBar.render(state));

	let previousSettings = config.settings;
	const configListener = config.onDidChange(settings => {
		const scope = classifySettingsChange(previousSettings, settings);
		previousSettings = settings;
		if (scope.logLevel) {
			loggerService.setLevel(settings.logLevel);
		}
		// 只有会影响模型列表（或连接身份）的变化才让宿主重新发现模型。
		if (scope.models || scope.client) {
			void refreshAndNotify(commands, true);
		}
	});

	context.subscriptions.push(
		loggerService,
		config,
		sessions,
		statusService,
		provider,
		statusBar,
		providerRegistration,
		statusListener,
		configListener,
		...registerCommands(commands),
	);

	statusService.start();
}

/**
 * 停用扩展。所有资源都挂在 `context.subscriptions` 上，由 VS Code 统一释放。
 */
export function deactivate(): void {
	// 保留该导出，以便 VS Code 识别扩展支持停用。
}
