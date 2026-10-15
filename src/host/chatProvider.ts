/**
 * 聊天模型供应商：实现 VS Code 的 `LanguageModelChatProvider`（三个方法：发现模型、
 * 处理请求并流式回传、估算 token）。
 *
 * 本类负责宿主侧编排：会话与缓存归 application，模型事实归 models，协议准备与翻译归 protocol，
 * 网络归 transport；本目录只处理宿主消息、配置和响应部件。
 * 流的消费与收尾在 `streamFlow.ts`，工具组预激活在 `preflight.ts`；只服务本文件的
 * 请求体组装在 `request.ts`，模型信息映射与错误转换写在本文件末尾。
 *
 * VS Code 为每个配置组分别调用本 provider：发现模型时从 `options` 解析连接目标，
 * 处理请求时靠 `model` 上带的指纹找回同一会话。
 */

import * as vscode from 'vscode';
import type { AdapterRegistry } from '../protocol/registry';
import { fromCancellationToken } from './cancellation';
import { HttpError, isAbortError } from '../transport/http';
import { describeError } from '../transport/newApiClient';
import { MANAGE_MODELS_COMMAND, TOKEN_ESTIMATION } from '../shared/consts';
import type { NewApiSettings } from '../shared/settings';
import type { Logger } from '../shared/log';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest, ChatUsage } from '../shared/types';
import { measureRequestText } from '../protocol/messages';
import { prepareChatRequest } from './request';
import { resolveRequestHeaders } from './headers';
import { buildModelConfigurationSchema } from '../protocol/modelConfiguration';
import type { ModelConfigurationSchema } from '../protocol/modelConfiguration';
import { runToolGroupPreflight } from './preflight';
import type { ProviderSession, SessionRegistry } from '../application/session';
import { reportReplayMarker, streamResponse } from './streamFlow';
import type { StreamSummary } from '../protocol/stream';
import {
	createTarget,
	describeTarget,
	isTargetUsable,
	readOptionsConfiguration,
	readOptionsGroup,
} from '../application/target';
import type { ProviderTarget } from '../application/target';
import { estimateTokens } from './tokenizer';
import { calibrateCharsPerToken } from '../protocol/tokenizer';
import { filterPreflightMessages } from './toolFlow';
import { buildModelDetail, buildModelTooltip } from './tooltip';

/**
 * 提供给 VS Code 的模型信息。
 *
 * 额外字段通过泛型携带：VS Code 会把 `provideLanguageModelChatInformation` 返回的
 * 对象原样传回 `provideLanguageModelChatResponse`。
 *
 * 只挂目标指纹而不挂目标本身：这些字段会留在 VS Code 的模型缓存里，
 * 而 `ProviderTarget` 含明文 API Key。
 */
export interface NewApiModelInformation extends vscode.LanguageModelChatInformation {
	/** 整合后的完整配置 */
	readonly config: ModelConfig;
	/**
	 * 模型级配置项（当前只有「思考强度」）。
	 * 字段不在 stable typings 里，但 VS Code 会当模型元数据收下并据此渲染控件。
	 */
	readonly configurationSchema?: ModelConfigurationSchema;
	/**
	 * 模型真实的上下文窗口（输入 + 输出），与 `maxInputTokens` / `maxOutputTokens` 独立。
	 *
	 * 不在 stable typings 里（属 `chatProvider` 提案）；它是被动元数据，VS Code 直接读走，
	 * 更早的宿主会丢掉不认识的字段，因此可以无条件声明。
	 *
	 * 不声明时宿主按 `maxInputTokens + maxOutputTokens` 兜底，模型选择器里的
	 * 「最大上下文」会偏小。
	 */
	readonly maxContextWindowTokens?: number;
	/** 该模型所属连接目标的指纹，用于在响应阶段找回同一个会话 */
	readonly targetKey: string;
	/** 目标标签，仅用于错误提示 */
	readonly targetLabel: string;
}

/** provider 的依赖。 */
export interface ChatProviderDeps {
	readonly storageUri?: vscode.Uri;
	readonly logger: Logger;
	/** 按连接目标分配会话（client + 模型目录） */
	readonly sessions: SessionRegistry;
	readonly adapters: AdapterRegistry;
	/** 取当前设置 */
	getSettings(): NewApiSettings;
	/** 上报用量，供状态栏悬浮提示统计 */
	reportUsage?(targetLabel: string, modelId: string, usage: ChatUsage | undefined, summary: StreamSummary): void;
}

/** 最多为多少个模型保留校准后的估算比例（每模型一个，且不能无限增长）。 */
const MAX_CALIBRATED_MODELS = 32;

/**
 * New API 聊天模型供应商。 */
export class NewApiChatProvider implements vscode.LanguageModelChatProvider<NewApiModelInformation>, vscode.Disposable {
	private readonly infoChanged = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [];
	/**
	 * 按模型维护「非 CJK 文本多少字符约等于一个 token」，随上游返回的真实用量缓慢校准
	 * （见 `tokenizer.calibrateCharsPerToken`）；不同模型的分词器差别大，不能共用一个比例。
	 */
	private readonly charsPerToken = new Map<string, number>();

	/** 模型集合变化时通知 VS Code 重新拉取（不触发时选择器不会刷新）。 */
	readonly onDidChangeLanguageModelChatInformation = this.infoChanged.event;

	constructor(private readonly deps: ChatProviderDeps) {
		// 任一配置组的模型集合变化都要通知 VS Code 重新发现模型，因此订阅注册表而不是单个 catalog。
		this.disposables.push(this.deps.sessions.onDidChange(() => this.infoChanged.fire()));
	}

	/** 供外部（命令、配置变更、密钥变更）手动触发模型列表刷新。 */
	notifyModelsChanged(): void {
		this.infoChanged.fire();
	}

	/* ---------------------------------------------------------------------- */
	/* 模型发现                                                                */
	/* ---------------------------------------------------------------------- */

	/**
	 * 返回可用模型列表。
	 *
	 * `options.silent` 为 `true` 表示 VS Code 只想知道现在有没有可用模型，此时不弹出任何 UI。
	 */
	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<NewApiModelInformation[]> {
		const logger = this.deps.logger;
		const target = this.resolveTarget(options);
		if (target === undefined) {
			// 尚未配置站点：不算错误，只是暂无可用模型；仅非静默场景提示去哪里配置。
			logger.debug('本次调用未携带配置组，暂不提供模型');
			if (!options.silent) {
				await this.promptForConfiguration();
			}
			return [];
		}

		if (!isTargetUsable(target)) {
			logger.warn(`配置不完整，暂不提供模型：${target.issues.join('；')}`);
			if (!options.silent) {
				await this.promptForConfiguration(target);
			}
			return [];
		}

		// 会话按目标缓存：同一目标的配置未变就直接复用，变了则重建
		const session = this.deps.sessions.resolve(target);
		try {
			// 不把 CancellationToken 传给模型列表拉取：VS Code 会在 UI 更新后立即取消该 token，
			// 而模型列表是共享且带缓存的资源，一次取消会连带取消其他调用方的请求。
			// 生命周期交给 catalog 自己的超时与并发合并机制。
			const snapshot = await session.catalog.getModels();
			if (snapshot.error !== undefined) {
				logger.warn(`模型列表可能不完整：${snapshot.error}`);
			}
			logger.debug(`向 VS Code 提供 ${snapshot.models.length} 个模型（${describeTarget(target)}）`);
			return snapshot.models.map(config => toModelInformation(config, target));
		} catch (error) {
			// 不向外抛异常：加载失败表现为「没有模型」，原因由状态栏告诉用户。
			logger.error('获取模型列表失败', error);
			return [];
		}
	}

	/**
	 * 解析本次调用应使用的连接目标：VS Code 把该配置组的解析结果放在 `options.configuration` 里。
	 * 返回 `undefined` 表示本次调用没有携带配置。
	 */
	private resolveTarget(options: vscode.PrepareLanguageModelChatModelOptions): ProviderTarget | undefined {
		const configuration = readOptionsConfiguration(options);
		if (configuration === undefined) {
			return undefined;
		}
		const group = readOptionsGroup(options);
		// trace 级别：确认运行环境是否下发了组配置
		this.deps.logger.trace(`本次调用来自配置组：${group ?? '(未命名)'}`);
		return createTarget(group, configuration, this.deps.logger);
	}

	/** 用模型上带的目标指纹取回会话；多组共存时不能退回默认目标。 */
	private resolveSession(model: NewApiModelInformation): ProviderSession {
		const session = this.deps.sessions.find(model.targetKey);
		if (session === undefined) {
			throw new Error(
				`模型所属的配置（${model.targetLabel}）已变更，请在模型选择器中重新选择该模型。`,
			);
		}
		return session;
	}

	/* ---------------------------------------------------------------------- */
	/* 处理请求                                                                */
	/* ---------------------------------------------------------------------- */

	/** 处理一次对话请求，把上游流式响应翻译成响应部件。 */
	async provideLanguageModelChatResponse(
		model: NewApiModelInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const logger = this.deps.logger;
		const settings = this.deps.getSettings();
		const config = model.config;

		// 预激活控制流（伪调用与它们的结果）不能发给上游，无论设置是否开启都要过滤掉
		const flowMessages = filterPreflightMessages(messages);
		if (settings.request.stabilizeToolList
			&& runToolGroupPreflight({ messages, tools: options.tools, progress, logger })) {
			// 伪调用已上报：宿主执行后会带着展开完的工具列表重新发起
			return;
		}

		const abort = fromCancellationToken(token);
		try {
			const prepared = prepareChatRequest({
				config,
				settings,
				messages: flowMessages,
				options,
				adapters: this.deps.adapters,
				logger,
			});

			const summary = await streamResponse({
				source: this.resolveSession(model).client,
				request: prepared.request,
				modelId: config.id,
				includeReasoning: settings.request.includeReasoning,
				headers: resolveRequestHeaders(settings.request.headers ?? {}, options, this.deps.storageUri),
				progress,
				signal: abort.signal,
				cancelled: () => token.isCancellationRequested,
				logger,
			});
			this.deps.reportUsage?.(model.targetLabel, config.id, summary.usage, summary);
			reportReplayMarker(progress, summary, prepared.echoReasoningContent, config.id, logger);
			if (!prepared.hasImages) {
				this.calibrateCharsPerTokenFor(config.id, prepared.request, summary.usage?.prompt_tokens);
			}
		} catch (error) {
			// 取消是正常流程：用户点「停止」时 VS Code 会取消 token
			if (isAbortError(error) || token.isCancellationRequested) {
				logger.debug(`请求已取消：${config.id}`);
				return;
			}
			logger.error(`请求失败：${config.id}`, error);
			throw toLanguageModelError(error);
		} finally {
			abort.dispose();
		}
	}

	/* ---------------------------------------------------------------------- */
	/* Token 估算                                                              */
	/* ---------------------------------------------------------------------- */

	/** 估算 token 数：VS Code 用它决定何时裁剪历史，因此宁可高估（见 `tokenizer.ts`）。 */
	async provideTokenCount(
		model: NewApiModelInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return Math.max(1, estimateTokens(text, this.charsPerTokenFor(model.config.id)));
	}

	/* ---------------------------------------------------------------------- */

	/** 取某个模型当前的估算比例（没校准过就用默认值）。 */
	private charsPerTokenFor(modelId: string): number {
		return this.charsPerToken.get(modelId) ?? TOKEN_ESTIMATION.charsPerToken;
	}

	/**
	 * 用上游返回的真实用量校准该模型的估算比例。
	 *
	 * 口径与估算器一致（见 `measureRequestText`）；传入的是适配器改写后真正发出去的请求。
	 */
	private calibrateCharsPerTokenFor(
		modelId: string,
		request: ChatCompletionRequest,
		promptTokens: number | undefined,
	): void {
		const measure = measureRequestText(request.messages, request.tools);
		const next = calibrateCharsPerToken(measure, promptTokens, this.charsPerTokenFor(modelId));
		// 先删再插：Map 的迭代顺序即「最近使用」顺序，淘汰时从最旧的开始
		this.charsPerToken.delete(modelId);
		this.charsPerToken.set(modelId, next);
		while (this.charsPerToken.size > MAX_CALIBRATED_MODELS) {
			const oldest = this.charsPerToken.keys().next();
			if (oldest.done === true) {
				break;
			}
			this.charsPerToken.delete(oldest.value);
		}
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.infoChanged.dispose();
	}

	/* ---------------------------------------------------------------------- */

	/** 引导用户去配置站点：打开 VS Code 提供的配置界面（本扩展的 `configuration` schema）。 */
	private async promptForConfiguration(target?: ProviderTarget): Promise<void> {
		const detail = target === undefined
			? '尚未配置 New API 站点'
			: `${target.label} 还不能使用：${target.issues.join('；')}`;
		const action = await vscode.window.showWarningMessage(detail, '打开配置界面');
		if (action === '打开配置界面') {
			await vscode.commands.executeCommand(MANAGE_MODELS_COMMAND);
		}
	}
}

/* -------------------------------------------------------------------------- */
/* 模型信息与错误映射                                                          */
/* -------------------------------------------------------------------------- */

/** 把内部配置映射成 VS Code 需要的模型信息。 */
function toModelInformation(config: ModelConfig, target: ProviderTarget): NewApiModelInformation {
	return {
		id: config.id,
		name: config.name,
		family: config.family,
		version: config.version,
		detail: buildModelDetail({ ...config, vendor: config.meta.vendor, ownedBy: config.meta.ownedBy }),
		tooltip: buildModelTooltip({ ...config, vendor: config.meta.vendor }),
		maxInputTokens: config.maxInputTokens,
		maxOutputTokens: config.maxOutputTokens,
		// 真实窗口单独声明，否则宿主只能按「输入上限 + 输出上限」兜底
		maxContextWindowTokens: config.contextWindow,
		capabilities: {
			imageInput: config.imageInput,
			// 上游对单次请求的工具数量通常没有硬上限，用布尔值表达「支持」
			toolCalling: config.toolCalling,
		},
		// 空值时表示「不展示任何模型级控件」（模型不支持思考，或没有可选的思考强度档位）
		configurationSchema: buildModelConfigurationSchema(config),
		config,
		// 只带指纹与标签，不带 target 本体（后者含明文密钥）
		targetKey: target.key,
		targetLabel: target.label,
	};
}

/**
 * 把内部错误交给 VS Code。
 *
 * 消息已由 `describeError` 加工成面向用户的形式并做密钥脱敏；这里清掉 `stack`
 * （宿主会连同堆栈一起渲染），并在语义吻合时换用工厂方法：401/403 → `NoPermissions`、
 * 404 → `NotFound`。
 */
function toLanguageModelError(error: unknown): Error {
	const message = describeError(error);
	const result = error instanceof HttpError && error.isAuthError
		? vscode.LanguageModelError.NoPermissions(message)
		: error instanceof HttpError && error.isNotFound
			? vscode.LanguageModelError.NotFound(message)
			: new Error(message);
	result.stack = undefined;
	return result;
}
