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
| DeepSeek | `thinking.type` 一律显式写入；`none` / `off` 与辅助请求关闭；关闭或非思考模型时删除强度字段 | 通用回放，开启时补齐缺失历史字段 |
| OpenAI 推理模型（o 系列与 GPT-5 之后） | `max_tokens` → `max_completion_tokens`；移除不支持的采样字段；非思考形态清掉强度字段 | 不要求额外回填 |
| Qwen | 无强度档位的型号把选择转为 `enable_thinking`；有档位的型号保留 `reasoning_effort`；`auto` 不新增开关；非思考模型清掉强度字段 | 通用回放 |
| GLM | `thinking.type` 一律显式写入；`none` / `off` 与辅助请求转为 `disabled`；强制思考的型号（`glm-5.3`、`glm-4.7`）关不了则写 `enabled`；非思考模型清掉强度字段 | 通用回放（Preserved Thinking 要求回传未修改的原文） |
| Kimi | K2.x 用 `thinking.type` 显式开关并支持辅助请求关闭；K3 / K2.7-code 思考常开，保留顶层 `reasoning_effort`；非思考模型清掉强度字段 | 通用回放（Preserved Thinking） |
| 其他模型 | 通用 Chat Completions 与数据驱动能力位 | 不要求额外回填 |

Qwen/Kimi 的转换只表达**开关**，不换算 token 预算。Qwen 的 `thinking_budget` 可由 `request.extraBody` 透传。
K3 的顶层 `reasoning_effort` 正是强度字段本身，适配器因此原样保留、不落地成语义不同的嵌套开关。

**两个契约在厂商间是一致的**：

- `echoReasoningContent`：DeepSeek / Kimi / GLM / Qwen 都要求把历史助手消息的思考原文原样带回，
  因此四家都打开它；OpenAI 不要求。
- **辅助请求关闭思考**：判据放在框架层 `requestKind.ts`（与厂商无关），由 DeepSeek / Kimi(K2.x) / GLM 使用。
  **只对能真正关掉思考的厂商开启**——Kimi K3、Qwen 没有可靠的关闭手段，写一个不生效的「关闭」
  反而误导，因此它们只做强度清理，不假装关闭。

选项来自模型元数据，适配器不新增档位。能表达「关不掉」的模型应由元数据排除 `none` / `off`；
只有在元数据表达不了、而上游又会直接拒绝关闭时，才允许按**官方点名的代际**做例外（`glm-5.3`、
`glm-4.7`、Kimi K3/K2.7-code），不从版本号臆测其它型号。Kimi 分流优先看数据表给出的档位
（`kimi-latest` 这类别名靠它归位），命名判据只是数据缺失时的兜底。

`samplingParams=when-thinking-off` 识别 `reasoning_effort=none/off`、`enable_thinking=false`、`thinking.type=disabled`。

## 4. 传输与新增厂商

当前通道是 New API 的 `/v1/chat/completions`。Responses、Anthropic Messages、Google 原生流需要各自的请求构造与响应归一化。未来新增通道沿 `ChatStreamSource` 边界实现，共享取消、错误与流式上报。

新增厂商步骤：

1. 在 `src/adapter/<supplier>/` 实现 `ModelAdapter`，只处理有证据的协议差异。
2. 在 `createDefaultAdapterRegistry` 注册；provider 无需加厂商分支。
3. 能力、窗口和可选档位由模型数据层提供；要求回填思考的厂商启用回放契约。
4. 验证消息与工具结构、默认选择、关闭思考、未知模型、适配链顺序及请求副本隔离。

验证命令：`npm run check`、`npm run lint`、`npm test`、`npm run compile`。真实网关联调还需在扩展宿主中使用对应站点配置组执行文本与工具对话。
