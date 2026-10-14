# Copilot 通用层与厂商适配设计

## 设计依据

- [VS Code Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)：以模型发现、响应、token 估算三个方法为入口，通过 `lm.registerLanguageModelChatProvider` 注册。Agent 工具调用交回 VS Code 执行。
- [opencode-copilot-chat 架构](https://github.com/ltmoerdani/opencode-copilot-chat/blob/main/ARCHITECTURE-MAP.md)：借鉴薄 provider、共享流式引擎、模型元数据与协议策略分离的设计。
- [deepseek-v4-for-copilot 请求准备](https://github.com/Vizards/deepseek-v4-for-copilot/blob/main/src/provider/request.ts)：借鉴厂商原生思考开关、辅助请求分类、思考历史回放等适配思路。
- [DeepSeek 官方思考接口](https://api-docs.deepseek.com/guides/thinking_mode)：Chat Completions 的开关是 `thinking.type`；关闭时不发送 `reasoning_effort`；带工具的思考请求需要回传历史 `reasoning_content`。

厂商规则以本项目中实际实现的适配器和测试为准。

## 1. 通用部分

```text
VS Code / Copilot
  └─ NewApiChatProvider
       ├─ SessionRegistry → 配置组隔离、连接生命周期
       ├─ ModelCatalog → 网关模型列表、数据表、缓存与能力整合
       ├─ messages / modelConfiguration → 宿主消息和模型选择
       ├─ AdapterRegistry → 厂商请求改写 → 元数据能力位改写
       └─ streamResponse → ChatStreamSource → HTTP / SSE
                            └─ 中立部件 → VS Code 响应部件
```

通用层负责配置、凭据引用、模型列表、消息/工具转换、取消、重试、超时、用量、响应流和错误。模型 ID 保持网关原值；模型元数据只携带目标指纹，不携带密钥。

官方 API 是接入契约。模型级 `configurationSchema`、上下文窗口扩展元数据和思考/回放部件依赖额外宿主能力。已有思考渲染代码负责运行时探测与回退。

## 2. 厂商适配契约

`ModelAdapter` 提供 `supports`、可选的 `transformRequest`、可选的 `echoReasoningContent`。`AdapterContext` 只携带模型元数据、日志以及已校验的思考选择，不读取用户设置或直接调用 VS Code。

注册表按优先级执行**全部命中项**。厂商策略先执行，元数据能力位随后执行；无匹配项时直接透传。`transformRequest` 在深复制的请求上执行，异步适配器的返回值继续传给后续适配器。

思考配置分成两个概念：

- 请求体中的 `reasoning_effort`：与 schema 默认相同则省略。
- 上下文中的有效选择：包含默认档位，使原生开关正确解释 `none` / `off`。

请求里的显式强度字段优先于上下文兜底。在没有有效模型选择时，厂商原生字段继续透传。

## 3. 当前适配矩阵

| 厂商 | 请求适配 | 思考历史 |
| --- | --- | --- |
| DeepSeek | `thinking.type`；`none` / `off` 与辅助请求关闭；关闭时删除强度字段 | 通用回放，开启时补齐缺失历史字段 |
| OpenAI 推理模型 | `max_tokens` → `max_completion_tokens`；移除不支持的采样字段 | 不要求额外回填 |
| Qwen | 转换为 `enable_thinking`；`auto` 不新增开关；删除转换后的强度字段 | 不要求额外回填 |
| GLM | `none` / `off` 转为 `thinking.type=disabled`；具体强度继续透传 | 不要求额外回填 |
| Kimi | 转换为 `thinking.type`；删除转换后的强度字段 | 通用回放保留已知原文，不生成占位 |
| 其他模型 | 通用 Chat Completions 与数据驱动能力位 | 不要求额外回填 |

Qwen/Kimi 的转换只表达**开关**，不换算 token 预算。Qwen 的 `thinking_budget` 可由 `request.extraBody` 透传。

选项来自模型元数据，适配器不新增档位。不能关闭思考的模型应由元数据排除 `none` / `off`；未知版本不通过版本号正则臆测。

`samplingParams=when-thinking-off` 识别 `reasoning_effort=none/off`、`enable_thinking=false`、`thinking.type=disabled`。

## 4. 传输与新增厂商

当前通道是 New API 的 `/v1/chat/completions`。Responses、Anthropic Messages、Google 原生流需要各自的请求构造与响应归一化。未来新增通道沿 `ChatStreamSource` 边界实现，共享取消、错误与流式上报。

新增厂商步骤：

1. 在 `src/adapter/<supplier>/` 实现 `ModelAdapter`，只处理有证据的协议差异。
2. 在 `createDefaultAdapterRegistry` 注册；provider 无需加厂商分支。
3. 能力、窗口和可选档位由模型数据层提供；要求回填思考的厂商启用回放契约。
4. 验证消息与工具结构、默认选择、关闭思考、未知模型、适配链顺序及请求副本隔离。

验证命令：`npm run check`、`npm run lint`、`npm test`、`npm run compile`。真实网关联调还需在扩展宿主中使用对应站点配置组执行文本与工具对话。
