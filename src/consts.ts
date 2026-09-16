/**
 * 全局常量。
 *
 * 约定：这里只放「不随用户配置变化」的字面量。
 * 任何用户可修改的值都必须先定义在 package.json 的 `contributes.configuration` 中，
 * 再由 `config.ts` 读取——不要把可配置项的默认值写死在这里。
 *
 * 注意：站点地址与 API Key 由 VS Code 的 provider 配置组提供
 * （见 `package.json` 的 `contributes.languageModelChatProviders[].configuration`
 * 与 `provider/target.ts`），因此它们**不在** `contributes.configuration` 里。
 */

/** 扩展标识，与 package.json 的 `name` 保持一致。 */
export const EXTENSION_ID = 'newapi-copilot-chat';

/**
 * 注册到 VS Code 的聊天模型供应商 ID（vendor）。
 * 三处必须一致：`contributes.languageModelChatProviders[].vendor`、激活事件
 * `onLanguageModelChatProvider:<VENDOR_ID>`、`registerLanguageModelChatProvider(VENDOR_ID, ...)`。
 */
export const VENDOR_ID = 'newapi';

/** 输出通道名称，同时用于日志与状态展示。 */
export const OUTPUT_CHANNEL_NAME = 'New API for Copilot Chat';

/** 配置节前缀，所有设置项都位于 `${CONFIG_SECTION}.xxx` 之下。 */
export const CONFIG_SECTION = EXTENSION_ID;

/** 全部命令 ID。集中定义，避免手写字符串拼错。 */
export const COMMANDS = {
	/** 重新探测所有配置组并刷新模型列表 */
	testConnection: `${EXTENSION_ID}.testConnection`,
	/** 忽略缓存，重新拉取所有配置组的模型列表 */
	refreshModels: `${EXTENSION_ID}.refreshModels`,
	/** 打开状态面板 */
	showPanel: `${EXTENSION_ID}.showPanel`,
	/** 打开本扩展的设置页（模型过滤、请求参数等） */
	openSettings: `${EXTENSION_ID}.openSettings`,
} as const;

/** VS Code 内置的「管理语言模型」界面：用户在这里配置站点与密钥（本扩展的 `configuration` 贡献点会被渲染成表单），配置不完整时的引导都指向它。 */
export const MANAGE_MODELS_COMMAND = 'workbench.action.chat.manage';

/** OpenAI 兼容端点（相对于 baseUrl）。New API 同时提供公开状态端点与兼容端点。 */
export const ENDPOINTS = {
	/** 公开状态端点：无需鉴权，用于探活与读取站点信息 */
	status: '/api/status',
	/** 模型列表 */
	models: '/v1/models',
	/** 对话补全（流式 / 非流式共用） */
	chatCompletions: '/v1/chat/completions',
} as const;

/** SSE 流结束标记。 */
export const SSE_DONE = '[DONE]';

/** SSE 响应必须包含的 content-type 片段。 */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/** 状态栏优先级（数值越大越靠左）。 */
export const STATUS_BAR_PRIORITY = 100;

/** Webview 面板 viewType。 */
export const PANEL_VIEW_TYPE = `${EXTENSION_ID}.panel`;

/**
 * 运行时信息。版本号在 `activate()` 时由 extension.ts 从 `package.json` 写入，
 * 因此不要在这里硬编码。
 */
export const runtimeInfo: { extensionVersion: string; userAgent: string } = {
	extensionVersion: '0.0.0',
	userAgent: EXTENSION_ID,
};

/** 激活时调用一次，填充运行时版本信息。 */
export function initRuntimeInfo(extensionVersion: string): void {
	runtimeInfo.extensionVersion = extensionVersion;
	runtimeInfo.userAgent = `${EXTENSION_ID}/${extensionVersion}`;
}

/** 思考强度在 VS Code 模型配置里的属性名：既是选择器里那个控件的键，也是请求回传时的键。 */
export const REASONING_EFFORT_KEY = 'reasoningEffort';

/** 思考强度在请求体中的默认字段名。 */
export const DEFAULT_REASONING_EFFORT_FIELD = 'reasoning_effort';

/**
 * 不允许被外部配置覆盖的请求体字段：`messages` / `model` / `tools` 是协议骨架，
 * 被 JSON 设置项或模型配置盖住只会制造无从排查的故障。
 */
export const PROTECTED_REQUEST_KEYS: ReadonlySet<string> = new Set([
	'model',
	'messages',
	'stream',
	'stream_options',
	'tools',
	'tool_choice',
]);

/**
 * 兜底默认值：只在「数据表未命中」且「网关没返回可用元数据」同时成立时才用到，
 * 因此取值保守——宁可估小，也不要让 VS Code 以为上下文很大而塞进超长请求。
 */
export const DEFAULTS = {
	/** 未知模型的上下文窗口 */
	contextWindow: 128_000,
	/** 未知模型的最大输出 */
	maxOutputTokens: 8_192,
	/** 上下文窗口下限：任何模型至少要有这么多 token，否则直接判定为配置异常 */
	minContextWindow: 2_048,
	/** 同步给 VS Code 的 maxInputTokens 下限 */
	minInputTokens: 1_024,
	/** 模型缓存有效期 */
	modelCacheTtlMs: 5 * 60_000,
	/** 状态栏轮询间隔 */
	statusRefreshIntervalMs: 60_000,
	/** 单次请求超时（含流式请求的「静默超时」） */
	requestTimeoutMs: 60_000,
	/** 失败重试次数（不含首次尝试） */
	maxRetries: 2,
	/** 重试退避基数 */
	retryBaseDelayMs: 500,
	/** 重试退避上限 */
	retryMaxDelayMs: 8_000,
} as const;

/** 状态刷新间隔下限，避免用户把它配成 1 秒把网关打爆。 */
export const MIN_STATUS_REFRESH_MS = 10_000;

/** Token 估算参数。见 provider/tokenizer.ts。 */
export const TOKEN_ESTIMATION = {
	/** 非 CJK 文本：平均多少字符约等于 1 个 token */
	charsPerToken: 4,
	/** 每条消息的固定结构开销（role、分隔符等） */
	messageOverhead: 4,
	/** 每个工具定义的固定开销 */
	toolOverhead: 8,
	/** 每张图片的固定开销（粗略值，偏保守） */
	imageOverhead: 1_024,
} as const;

/** 支持作为图片输入透传给模型的 MIME 类型。 */
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
