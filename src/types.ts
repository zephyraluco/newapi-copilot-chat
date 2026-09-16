/**
 * New API（OpenAI 兼容 / DeepSeek 风格）接口的数据结构。
 *
 * 以 OpenAI Chat Completions 为基准，并标注 DeepSeek、OpenRouter 等上游常见但**非** OpenAI 标准的扩展字段。
 * 服务端字段一律可选：网关版本、上游模型、代理层都可能裁掉字段，代码要把「字段缺失」当常态；
 * 无法穷举的字段交给索引签名兜底。
 */

/* -------------------------------------------------------------------------- */
/* 通用包装                                                                    */
/* -------------------------------------------------------------------------- */

/** OpenAI 风格的错误响应体。 */
export interface ApiErrorBody {
	error?: {
		message?: string;
		type?: string;
		code?: string | number;
		param?: string;
	};
	/** 部分网关直接把 message 放在顶层 */
	message?: string;
}

/* -------------------------------------------------------------------------- */
/* GET /v1/models                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 模型列表中的单个模型。
 *
 * 标准 OpenAI 只保证 `id` / `object` / `created` / `owned_by`；
 * 其余字段来自 New API 或上游网关的扩展，读取时必须走 `json.ts` 里的安全取值函数。
 */
export interface NewApiModel {
	/** 模型 ID，也是调用 `/v1/chat/completions` 时 `model` 字段的取值 */
	id: string;
	object?: string;
	/** Unix 秒级时间戳 */
	created?: number;
	/** 归属方，New API 通常填渠道名或上游厂商 */
	owned_by?: string;
	/** 未知扩展字段 */
	[key: string]: unknown;
}

/** `GET /v1/models` 响应。 */
export interface NewApiModelListResponse {
	object?: string;
	data?: NewApiModel[];
	/** 部分网关在出错时仍然返回 200 */
	success?: boolean;
	message?: string;
}

/* -------------------------------------------------------------------------- */
/* GET /api/status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * 站点状态。
 *
 * 这是 New API 的自有端点（非 OpenAI 标准），字段随版本变化较大，
 * 因此只声明相对稳定的几个，其余交给索引签名。
 */
export interface NewApiStatus {
	/** 站点名称，用于 UI 展示 */
	system_name?: string;
	/** New API 版本号 */
	version?: string;
	/** 服务启动时间（Unix 秒） */
	start_time?: number;
	/** 新用户默认模型 */
	default_model?: string;
	/** 站点默认分组 */
	default_group?: string;
	/** 聊天页链接 */
	chat_link?: string;
	/** 公告 */
	announcements?: unknown;
	/** 未知扩展字段 */
	[key: string]: unknown;
}

/** `GET /api/status` 响应。 */
export interface NewApiStatusResponse {
	success?: boolean;
	message?: string;
	data?: NewApiStatus;
}

/* -------------------------------------------------------------------------- */
/* POST /v1/chat/completions —— 请求                                            */
/* -------------------------------------------------------------------------- */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/** 多模态内容片段。 */
export interface ChatContentPart {
	type: 'text' | 'image_url';
	text?: string;
	image_url?: {
		/** 可以是 http(s) 链接，也可以是 `data:image/png;base64,...` */
		url: string;
		detail?: 'auto' | 'low' | 'high';
	};
}

/** 请求中的工具调用（历史消息回放时使用）。 */
export interface ChatRequestToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		/** JSON 字符串，不是对象 */
		arguments: string;
	};
}

/** 请求消息。 */
export interface ChatRequestMessage {
	role: ChatRole;
	/**
	 * 字符串，或内容片段数组，或 `null`。
	 * 注意：当存在 `tool_calls` 时，OpenAI 要求 content 为 `null`。
	 */
	content: string | ChatContentPart[] | null;
	name?: string;
	/** assistant 消息中携带的工具调用 */
	tool_calls?: ChatRequestToolCall[];
	/** tool 消息必须回填它响应的那个 tool_call 的 id */
	tool_call_id?: string;
	/**
	 * DeepSeek 风格：把历史推理内容回传给服务端。
	 * 官方文档说明该字段在后续请求中会被忽略，因此默认不回传。
	 */
	reasoning_content?: string;
}

/** 工具定义（`tools` 数组元素）。 */
export interface ChatToolDefinition {
	type: 'function';
	function: {
		name: string;
		description?: string;
		/** JSON Schema */
		parameters?: object;
	};
}

/** `tool_choice`：字符串枚举，或指定某个函数。 */
export type ChatToolChoice =
	| 'none'
	| 'auto'
	| 'required'
	| { type: 'function'; function: { name: string } };

/** `POST /v1/chat/completions` 请求体。 */
export interface ChatCompletionRequest {
	model: string;
	messages: ChatRequestMessage[];
	stream?: boolean;
	/** 流式模式下让服务端在最后一个 chunk 返回 usage */
	stream_options?: { include_usage?: boolean };
	temperature?: number;
	top_p?: number;
	/** 部分新模型（如 o 系列）只接受 max_completion_tokens */
	max_tokens?: number;
	max_completion_tokens?: number;
	stop?: string | string[];
	/** 允许透传网关特有参数（例如各家不同的「思考开关」） */
	[key: string]: unknown;
}

/* -------------------------------------------------------------------------- */
/* POST /v1/chat/completions —— 流式响应                                        */
/* -------------------------------------------------------------------------- */

/** 增量工具调用。流式返回时分片到达，需要按 `index` 归并。 */
export interface ChatToolCallDelta {
	index?: number;
	/** 首个分片才带 id */
	id?: string;
	type?: string;
	function?: {
		/** 首个分片才带 name */
		name?: string;
		/** JSON 字符串分片，必须按到达顺序拼接后再 parse */
		arguments?: string;
	};
}

/** 流式增量内容。 */
export interface ChatDelta {
	role?: string;
	content?: string | null;
	/** DeepSeek 系：思维链内容 */
	reasoning_content?: string | null;
	/** OpenRouter / 部分网关：思维链内容 */
	reasoning?: string | null;
	tool_calls?: ChatToolCallDelta[];
}

/** 流式响应中的一个 choice。 */
export interface ChatCompletionChunkChoice {
	index: number;
	delta?: ChatDelta;
	finish_reason?: string | null;
}

/** 计费信息。 */
export interface ChatUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	/** DeepSeek / OpenAI o 系列：思考 token 数 */
	completion_tokens_details?: {
		reasoning_tokens?: number;
		[key: string]: unknown;
	};
	prompt_tokens_details?: {
		cached_tokens?: number;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

/** 流式响应 chunk。部分网关在最后一个 chunk 只带 `usage` 而不带 `choices`。 */
export interface ChatCompletionChunk {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	choices?: ChatCompletionChunkChoice[];
	usage?: ChatUsage;
	/** 网关错误有时通过 200 + error 字段下发 */
	error?: ApiErrorBody['error'];
}

/* -------------------------------------------------------------------------- */
/* POST /v1/chat/completions —— 非流式响应                                      */
/* -------------------------------------------------------------------------- */

/** 完整消息。 */
export interface ChatCompletionMessage {
	role: ChatRole;
	content: string | null;
	reasoning_content?: string | null;
	tool_calls?: ChatRequestToolCall[];
}

/** 非流式响应中的一个 choice。 */
export interface ChatCompletionChoice {
	index: number;
	message: ChatCompletionMessage;
	finish_reason?: string | null;
}

/** 非流式响应。 */
export interface ChatCompletionResponse {
	id?: string;
	object?: string;
	created?: number;
	model?: string;
	choices?: ChatCompletionChoice[];
	usage?: ChatUsage;
	error?: ApiErrorBody['error'];
}
