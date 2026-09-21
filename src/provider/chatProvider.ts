/**
 * 聊天模型供应商：实现 VS Code 的 `LanguageModelChatProvider`（三个方法：发现模型、
 * 处理请求并流式回传、估算 token）。
 *
 * 这个类是「编排者」：网络交互在 `client`，模型信息整合在 `models`，格式转换在
 * `messages.ts` / `stream.ts`，差异处理在 `adapter`，会话与连接目标在 `target.ts` / `session.ts`。
 *
 * 它自己只做「按顺序把上面那些模块串起来」，另外三件**只服务本文件**的事就地写在本文件末尾：
 * 模型信息的映射（`toModelInformation`）、请求体的组装（`buildRequest`）、交给 VS Code 的错误
 * （`toLanguageModelError`）——它们都只有这一个消费者，单独成文件只是多一层跳转。独立成
 * 模块的是那些**被两个以上地方用**或**变化原因不同**的：流的消费与收尾 → `streamFlow.ts`，
 * 工具组预激活的宿主侧 → `preflight.ts`。
 *
 * VS Code 为每个配置组分别调用本 provider，因此发现模型时必须先从 `options` 解析出连接目标，
 * 而处理请求时靠 `model` 里带的指纹找回同一个会话——否则多组共存时会把 A 站的模型用 B 站的地址去请求。
 */

import * as vscode from 'vscode';
import type { AdapterContext } from '../adapter/adapter';
import type { AdapterRegistry } from '../adapter/registry';
import { fromCancellationToken } from '../cancellation';
import { HttpError, isAbortError } from '../client/http';
import { describeError } from '../client/newApiClient';
import { MANAGE_MODELS_COMMAND, PROTECTED_REQUEST_KEYS, TOKEN_ESTIMATION } from '../consts';
import type { NewApiSettings } from '../config';
import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ChatCompletionRequest, ChatToolDefinition, ChatUsage } from '../types';
import { convertMessages, convertToolChoice, convertTools, countRequestChars } from './messages';
import {
	applyReasoningEffort,
	buildModelConfigurationSchema,
	selectReasoningEffort,
} from './modelConfiguration';
import type { ModelConfigurationSchema } from './modelConfiguration';
import { runToolGroupPreflight } from './preflight';
import type { ProviderSession, SessionRegistry } from '../runtime/session';
import { reportReplayMarker, streamResponse } from './streamFlow';
import type { StreamSummary } from './stream';
import {
	createTarget,
	describeTarget,
	isTargetUsable,
	readOptionsConfiguration,
	readOptionsGroup,
} from '../runtime/target';
import type { ProviderTarget } from '../runtime/target';
import { calibrateCharsPerToken, estimateTokens } from './tokenizer';
import { filterPreflightMessages } from './toolFlow';

/**
 * 提供给 VS Code 的模型信息。
 *
 * 通过泛型参数携带额外字段：VS Code 会把 `provideLanguageModelChatInformation`
 * 返回的对象原样传回 `provideLanguageModelChatResponse`，因此这里挂上的内容
 * 在响应阶段可以放心使用（也是官方泛型设计的目的）。
 *
 * 注意只挂**目标指纹**而不是目标本身：这些字段会随模型元数据留在 VS Code 的
 * 模型缓存里，而 `ProviderTarget` 含有明文 API Key。
 */
export interface NewApiModelInformation extends vscode.LanguageModelChatInformation {
	/** 整合后的完整配置 */
	readonly config: ModelConfig;
	/**
	 * 模型级配置项（当前只有「思考强度」）。
	 *
	 * 这个字段不在 stable typings 里，但 VS Code 会把它当模型元数据收下，
	 * 并据此在模型选择器里渲染控件。
	 */
	readonly configurationSchema?: ModelConfigurationSchema;
	/** 该模型所属连接目标的指纹，用于在响应阶段找回同一个会话 */
	readonly targetKey: string;
	/** 目标标签，仅用于错误提示 */
	readonly targetLabel: string;
}

/** provider 的依赖。 */
export interface ChatProviderDeps {
	readonly logger: Logger;
	/** 按连接目标分配会话（client + 模型目录） */
	readonly sessions: SessionRegistry;
	readonly adapters: AdapterRegistry;
	/** 取当前设置 */
	getSettings(): NewApiSettings;
	/** 上报用量，供状态栏悬浮提示统计 */
	reportUsage?(targetLabel: string, modelId: string, usage: ChatUsage | undefined, summary: StreamSummary): void;
}

/**
 * New API 聊天模型供应商。 */
export class NewApiChatProvider implements vscode.LanguageModelChatProvider<NewApiModelInformation>, vscode.Disposable {
	private readonly infoChanged = new vscode.EventEmitter<void>();
	private readonly disposables: vscode.Disposable[] = [];
	/**
	 * 非 CJK 文本「多少字符约等于一个 token」，随上游返回的真实用量缓慢校准
	 * （见 `tokenizer.calibrateCharsPerToken`）。
	 */
	private charsPerToken: number = TOKEN_ESTIMATION.charsPerToken;

	/**
	 * 模型集合发生变化时通知 VS Code 重新拉取。
	 * 官方指南要求 provider 在可用模型变化时触发该事件（否则选择器不会刷新）。
	 */
	readonly onDidChangeLanguageModelChatInformation = this.infoChanged.event;

	constructor(private readonly deps: ChatProviderDeps) {
		// 任一会话（即任一组）的模型集合变化都要通知 VS Code 重新发现模型，
		// 因此订阅注册表而不是单个 catalog。
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
	 * `options.silent` 为 `true` 表示 VS Code 只是想知道「现在有没有可用模型」，
	 * 此时绝不能弹出任何 UI——否则每次打开模型选择器都会弹一次。
	 */
	async provideLanguageModelChatInformation(
		options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<NewApiModelInformation[]> {
		const logger = this.deps.logger;
		const target = this.resolveTarget(options);
		if (target === undefined) {
			// 用户还没为本供应商配置站点。这不是错误，只是「暂无可用模型」；
			// 非静默场景（用户主动进配置界面）才提示去哪里配置。
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
			// 刻意不把 CancellationToken 传给模型列表拉取。
			//
			// VS Code 会在 UI 更新后立即取消该 token（例如模型选择器收起），
			// 而模型列表是**共享且带缓存**的资源。把单个调用方的信号接到共享请求上，
			// 一次取消就会连带取消其他调用方的请求，甚至把「没有模型」写进缓存。
			// 因此这里交给 catalog 自己的超时与并发合并机制管理生命周期。
			const snapshot = await session.catalog.getModels();
			if (snapshot.error !== undefined) {
				logger.warn(`模型列表可能不完整：${snapshot.error}`);
			}
			logger.debug(`向 VS Code 提供 ${snapshot.models.length} 个模型（${describeTarget(target)}）`);
			return snapshot.models.map(config => toModelInformation(config, target));
		} catch (error) {
			// 这里绝不向外抛异常：模型列表加载失败时应该表现为「没有模型」，
			// 由状态栏负责告诉用户原因。
			logger.error('获取模型列表失败', error);
			return [];
		}
	}

	/**
	 * 解析本次调用应使用的连接目标。
	 *
	 * VS Code 在调用时把该配置组的解析结果放在 `options.configuration` 里。
	 * 返回 `undefined` 表示本次调用没有携带配置——即用户还没为本供应商配置站点。
	 */
	private resolveTarget(options: vscode.PrepareLanguageModelChatModelOptions): ProviderTarget | undefined {
		const configuration = readOptionsConfiguration(options);
		if (configuration === undefined) {
			return undefined;
		}
		const group = readOptionsGroup(options);
		// trace 级别：这条日志用于确认运行环境是否真的下发了组配置
		this.deps.logger.trace(`本次调用来自配置组：${group ?? '(未命名)'}`);
		return createTarget(group, configuration, this.deps.logger);
	}

	/**
	 * 取模型所属目标的会话。
	 *
	 * 靠模型上带的目标指纹找回——多组共存时不能退回到「默认目标」，
	 * 否则会把 A 站的模型拿去 B 站请求。
	 */
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

		const abort = fromCancellationToken(token, `chat:${config.id}`);
		const adapter = this.deps.adapters.resolve(config);
		// 模型选择器里的「思考强度」（未选择时为空，此时不往请求体里写任何额外字段）
		const effort = selectReasoningEffort(options, config);
		if (effort.ignored !== undefined) {
			logger.warn(`${config.id}：${effort.ignored}`);
		}
		const adapterContext: AdapterContext = {
			model: config,
			logger,
		};

		try {
			const converted = convertMessages(flowMessages, logger, {
				echoReasoningContent: adapter.echoReasoningContent === true,
			});
			for (const warning of converted.warnings) {
				logger.warn(warning);
			}
			if (converted.messages.length === 0) {
				throw new Error('本次请求没有任何可发送的内容');
			}

			const tools = convertTools(options.tools, logger);
			const request = buildRequest({
				config,
				settings,
				messages: converted.messages,
				tools,
				toolMode: options.toolMode,
				reasoningEffort: effort.effort,
			});

			// 日志里不写密钥，但要能看出「用没用上模型配置」
			const effortNote = effort.effort === undefined ? '思考强度未指定' : `思考强度 ${effort.effort}`;
			logger.info(
				`→ ${config.id}：${converted.messages.length} 条消息，` +
				`${tools?.length ?? 0} 个工具，适配器 ${adapter.id}，${effortNote}，` +
				`思考内容${settings.request.includeReasoning ? '会' : '不会'}回显`,
			);

			const transformed = adapter.transformRequest
				? await adapter.transformRequest(request, adapterContext)
				: request;

			const summary = await streamResponse({
				source: this.resolveSession(model).client,
				request: transformed,
				modelId: config.id,
				includeReasoning: settings.request.includeReasoning,
				sendsStreamOptions: settings.request.includeUsage,
				progress,
				signal: abort.signal,
				cancelled: () => token.isCancellationRequested,
				logger,
			});
			this.deps.reportUsage?.(model.targetLabel, config.id, summary.usage, summary);
			reportReplayMarker(progress, summary, adapter, config.id, logger);
			this.charsPerToken = calibrateCharsPerToken(
				countRequestChars(transformed.messages),
				summary.usage?.prompt_tokens,
				this.charsPerToken,
			);
		} catch (error) {
			// 取消是正常流程，不是失败：VS Code 会在用户点「停止」时取消 token
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

	/**
	 * 估算 token 数。
	 *
	 * VS Code 用它决定何时裁剪历史，因此宁可高估（见 tokenizer.ts 的说明）。
	 */
	async provideTokenCount(
		_model: NewApiModelInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return Math.max(1, estimateTokens(text, this.charsPerToken));
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.infoChanged.dispose();
	}

	/* ---------------------------------------------------------------------- */

	/**
	 * 引导用户去配置站点。
	 *
	 * 只在非静默模式下调用，因此不会在后台刷新时弹窗。配置界面由 VS Code 提供
	 * （本扩展的 `configuration` schema 会被渲染成表单），因此这里只负责把用户送过去。
	 */
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
/* 下面的三件事只服务本文件                                                    */
/* -------------------------------------------------------------------------- */

/** 把内部配置映射成 VS Code 需要的模型信息。 */
function toModelInformation(config: ModelConfig, target: ProviderTarget): NewApiModelInformation {
	return {
		id: config.id,
		name: config.name,
		family: config.family,
		version: config.version,
		detail: config.detail,
		tooltip: config.tooltip,
		maxInputTokens: config.maxInputTokens,
		maxOutputTokens: config.maxOutputTokens,
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
 * 组装请求体。
 *
 * 写入顺序是语义的一部分（后面的可以盖过前面的）：
 *
 * ```
 *   model + messages
 *   → temperature / top_p / tools（来自设置）
 *   → extraBody 里的额外字段
 *   → 思考强度（来自模型选择器里的选择，最具体，因此最后写）
 * ```
 *
 * 适配器看到的是本函数产出的完整请求体，因此**这里不处理供应商差异**（见 `adapter/`）。
 */
function buildRequest(input: {
	config: ModelConfig;
	settings: NewApiSettings;
	messages: ChatCompletionRequest['messages'];
	tools: ChatToolDefinition[] | undefined;
	toolMode: vscode.LanguageModelChatToolMode;
	reasoningEffort: string | undefined;
}): ChatCompletionRequest {
	const { config, settings, messages, tools, toolMode, reasoningEffort } = input;
	const request: ChatCompletionRequest = { model: config.id, messages };

	const { temperature, topP } = settings.request;
	if (temperature !== undefined) {
		request.temperature = temperature;
	}
	if (topP !== undefined) {
		request.top_p = topP;
	}
	if (tools !== undefined) {
		request.tools = tools;
		const choice = convertToolChoice(toolMode, true);
		if (choice !== undefined) {
			request.tool_choice = choice;
		}
	}

	// 额外字段：结构化字段被排除在外——让一个 JSON 设置项覆盖 `messages` 只会制造无从排查的故障。
	for (const [key, value] of Object.entries(settings.request.extraBody)) {
		if (!PROTECTED_REQUEST_KEYS.has(key) && value !== undefined) {
			request[key] = value;
		}
	}

	// 模型选择器里的选择比静态设置更具体，因此在额外字段之后写入，可以盖过它们。
	if (reasoningEffort !== undefined) {
		applyReasoningEffort(request, reasoningEffort);
	}

	return request;
}

/**
 * 把内部错误交给 VS Code。
 *
 * 消息已经是面向用户的：网络故障是「分类 + 错误码 + 站点 + 该改什么」（`src/errors.ts`），
 * HTTP 错误是上游原话。两件事要做：
 *
 * - **清掉 `stack`**：Copilot 会把 `name: message` 与堆栈一起渲染（`extChatEndpoint` 的
 *   `toErrorMessage(e, true)`），而用户要的是原因；原始异常已经写进日志。
 * - **只在语义真正吻合时换用工厂方法**：401/403 → `NoPermissions`、404 → `NotFound`；
 *   `Blocked` 表示「被策略阻止」，与限流/超时不是一回事，硬套会误导用户。
 *
 * 唯一的加工是密钥脱敏（`describeError` 里的 `redactText`）。
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
