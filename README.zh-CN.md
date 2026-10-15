<h1 align="center">New API for Copilot Chat</h1>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="许可证：MIT" />
  <img src="https://img.shields.io/badge/VS%20Code-1.137%2B-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="VS Code 1.137+" />
  <img src="https://img.shields.io/badge/BYOK-New%20API-4B5563?style=for-the-badge" alt="自带密钥" />
  <img src="https://vsmarketplacebadges.dev/version-short/zephyraluco.newapi-copilot-chat.svg?style=for-the-badge&label=Version" alt="版本" />
  <img src="https://vsmarketplacebadges.dev/installs-short/zephyraluco.newapi-copilot-chat.svg?style=for-the-badge" alt="安装量" />
</p>

<p align="center">
  <b>简体中文</b> · <a href="README.md">English</a>
</p>

**用你自己 New API 站点上的模型驱动 Copilot Chat**

把 [New API](https://github.com/QuantumNous/new-api) 这类 OpenAI 兼容网关接成 Copilot Chat 的自带密钥（BYOK）语言模型供应商

## 功能特性

- **站点模型自动出现**：读取 `/v1/models` 逐个注册；支持多个配置组（例如官方站 + 自建站），各自独立的客户端与缓存
- **可读的模型信息**：选择器显示展示名而非回传给站点的模型 ID；悬浮提示列出规模与能力
- **原生流式与思考**：正文逐块输出，思维链可选回显；思考强度按模型可调
- **继承 Copilot 的整套能力**：Agent 模式、工具调用、Instructions 与 MCP、上下文窗口用量——接入的是原生 provider API
- **状态栏**：正常时悬停查看站点延迟、时间和累计用量；发现或探活失败时变黄、隐藏浮窗，详情写入日志

## 快速开始

### 前置条件

- **VS Code 1.137 或更高版本**
- 一个可用的 **New API 站点**（或任何 OpenAI 兼容网关）与它的 **API Key**
- 不需要 GitHub 提供的模型——本扩展走自带密钥（BYOK）

### 安装

当前版本以 `.vsix` 分发：

1. 打包：`npm install` 后执行 `npm run package`，仓库根目录得到 `newapi-copilot-chat-<版本>.vsix`
2. 安装：命令面板运行 **Extensions: Install from VSIX...**，选中该文件
3. **重新加载窗口**——provider 跑在扩展宿主里，装完必须重载才生效

### 使用步骤

1. 打开 Copilot Chat 的模型选择器 → **管理模型**（Manage Models）→ **New API**
2. 填入 **站点地址**（例如 `https://api.example.com`）与 **API Key**
   - 站点地址只填到根目录，`/v1` 与具体端点由扩展自动拼接
   - 密钥由 VS Code 存进系统钥匙串，配置文件里只留占位符引用
3. 确认后返回模型选择器，即可看到 New API 下的模型

## 模型与元数据

模型清单完全来自你的站点，因此**没有固定的模型列表**，扩展为每个模型补齐信息，优先级如下：

| 信息 | 网关返回值 | 随包数据表 | 默认值 |
| --- | --- | --- | --- |
| 上下文窗口、最大输出 | 优先 | 其次 | `128000` / `8192` |
| 图片输入、工具调用 | 优先（只认肯定） | 其次 | `false` |
| 思考能力与可选档位 | 只认肯定 | **优先** | 无（列表为空则不显示控件） |
| 展示名 | 其次 | 优先 | 无展示名的模型不进选择器 |

GPT-6.1 Sol 支持文字、图片和工具调用，本扩展通过 Chat Completions 传输。


Newer OpenAI reasoning models (GPT-5.4+, GPT-5.6, GPT-6 Astra and Codex variants) are adapted automatically: unsupported sampling fields are removed before Chat Completions requests. Image-generation model IDs are exposed without tool calling.

## 设置项

本扩展的设置位于 `newapi-copilot-chat.*` 之下，可在设置界面搜索 `New API` 找到
**站点地址与 API Key 不是设置项** —— 它们在 VS Code 的「管理模型」界面里配置

### 日志

日志输出到 **New API for Copilot Chat** 通道，级别通过 VS Code 输出面板的原生日志级别控件调整，不再提供独立的扩展日志级别设置。

### 模型

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `models.cacheTtl` | `300000` | 模型列表缓存有效期（毫秒） |
| `models.defaultContextWindow` | `128000` | 未知模型的兜底上下文窗口 |
| `models.defaultMaxOutputTokens` | `8192` | 未知模型的兜底最大输出 |

### 请求

聊天链路参考 `deepseek-v4-for-copilot`：请求准备完成后一次发送到 `/v1/chat/completions`，通过 SSE 回传正文、思考和工具调用。DeepSeek 的自定义端点不会因标题等辅助请求而强制关闭思考；历史推理优先从回放标记恢复，缺失时发送空字符串。

自定义请求头示例：

```json
{
  "newapi-copilot-chat.request.headers": {
    "X-Conversation-Id": "${conversationId}"
  }
}
```

`${conversationId}` 优先使用 Copilot 会话 ID，其次使用工作区 ID、请求关联 ID，最后生成随机 ID。同一次请求中所有模板共享同一个 ID。原生图片请求不会参与文本 token 估算比例的校准。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `request.timeoutMs` | `60000` | 非流式是整体超时；流式是**等响应头**的上限 |
| `request.streamIdleTimeoutMs` | `60000` | 流式响应**两个数据块之间**的静默超时；长思考的模型可以放宽 |
| `request.includeUsage` | `true` | 是否下发 `stream_options`；少数站点不认这个字段并返回 400，关掉它即可（关掉后上游不返回用量，「会话信息」里也就没有 token 数） |
| `request.maxRetries` | `2` | 用于模型列表拉取和站点探活。聊天只发送一次，不自动删参数重试，也不在断流后重发。 |
| `request.includeReasoning` | `true` | 默认通过原生思考部件展示推理，旧宿主退回引用块；与历史推理回填独立。 |
| `request.headers` | `{}` | 聊天请求的自定义 HTTP 请求头，可覆盖默认头，支持 `${conversationId}` 模板。 |
| `request.extraBody` | `{}` | 额外请求体字段，包括 `temperature`、`top_p`；发送前仍应用模型能力约束 |

### 状态

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `status.showStatusBar` | `true` | 显示模型数及正常状态浮窗；出错时变黄且无浮窗，详情见日志；隐藏状态栏不停止探活 |
| `status.refreshInterval` | `60000` | 站点 `/api/status` 探活间隔（毫秒），最小 `10000`；不会刷新模型列表 |

模型列表仍按需拉取：VS Code 请求模型发现、相关配置变化触发重新发现，或执行「刷新模型列表」命令。站点新增或连接配置变化时单独探活，此后按 `status.refreshInterval` 周期检查状态接口。模型发现或探活失败时状态栏变黄并隐藏整个浮窗，详细错误写入扩展输出日志；恢复正常后重新显示浮窗。

状态栏用量汇总本次扩展宿主会话中所有配置组的成功响应，包括请求/工具次数、输入输出 token、缓存命中和思考 token，重载窗口后清零。上游未返回 usage 的请求只累计请求和工具次数，不虚构 token 数。单次 usage 仍回传到 Copilot 的会话信息。

**思考强度不是设置项**——它在 Copilot Chat 的模型选择器里按模型配置；其余设置可以直接写进
`settings.json`（键名整体是一个带点号的字符串，**不要**写成嵌套对象）：

```json
{
  "newapi-copilot-chat.models.cacheTtl": 600000,
  "newapi-copilot-chat.request.extraBody": {
    "temperature": 0.7,
    "top_p": 0.9
  },
  "newapi-copilot-chat.request.streamIdleTimeoutMs": 180000
}
```

采样参数未在 `request.extraBody` 中指定时不发送；其中核采样使用 API 原始字段名 `top_p`。

## 思考强度

支持思考的模型会在模型选择器里出现**思考强度**控件，选择后扩展把 `reasoning_effort` 写进请求体：

- **显式使用有效档位**：控件预选数据表里的 `defaultReasoningEffort`，请求准备使用用户选择或该默认值；厂商策略负责转换思考开关，关闭思考时按协议省略强度字段。
- 字段名固定为 `reasoning_effort`；站点若用别的叫法（例如 `reasoning.effort`）或需要嵌套形态，由协议层改写——见 `src/protocol/`
- **有些模型不显示这个控件**：带工具调用时强度会被上游强制成某个固定值（例如 GPT-6 Sol/Luna 只能是 `none`），而 Agent 模式的请求总是带工具——显示一个选得了却不起作用的选项比不显示更糟

## 厂商适配

通用层统一处理模型发现、配置组、消息/工具转换、流式响应、取消与用量；厂商差异集中在 `src/protocol/`：

| 厂商 | 适配行为 |
| --- | --- |
| DeepSeek | 原生思考开关、思考历史回填；自定义端点的辅助请求保留配置强度；`none` / `off` 真正关闭思考 |
| OpenAI 推理模型 | o 系列与 GPT-5 之后：输出上限改为 `max_completion_tokens`，移除不支持的采样字段 |
| Qwen | 无档位型号的思考选择转为 `enable_thinking`；有档位型号保留 `reasoning_effort`；`auto` 不新增开关；思考历史回填 |
| GLM | 显式写入 `thinking.type`；具体强度透传；强制思考的 `glm-5.3` / `glm-4.7` 关不了则写 `enabled`；思考历史回填 |
| Kimi | K2.x 思考选择转为 `thinking.type` 并支持辅助请求关闭；K3 / K2.7-code 思考常开，保留顶层 `reasoning_effort`；思考历史回填 |

可选档位仍来自模型元数据。Qwen/Kimi 使用原生开关，不将强度换算成预算。上述模型通过 New API 的 Chat Completions 通道请求。设计依据与扩展方式见 [`docs/PROVIDER-DESIGN.md`](docs/PROVIDER-DESIGN.md)。

## 配置来源

配置完全由 VS Code 的 provider 配置组提供：扩展在 `package.json` 里用
`contributes.languageModelChatProviders[].configuration` 声明一份 JSON Schema，
VS Code 据此在「管理模型」界面生成本扩展的配置表单：

| 字段 | 说明 |
| --- | --- |
| 站点地址 | 必填，New API 站点根地址，`/v1` 与具体端点由扩展拼接 |
| API Key | 必填，声明为 `secret`，由 VS Code 存入系统钥匙串 |

**模型按配置组隔离**（每组有独立的 HTTP 客户端与模型缓存，A 站的模型不会跑到 B 站去请求）、
**配置变更自动生效**（改完地址或密钥后，下一次模型发现就会重建对应会话，旧连接完成在途请求后释放）、
**状态按组汇总**（正常时逐组展示延迟与时间，并汇总会话用量；任何组出错时状态栏变黄，错误详情见日志）

## 命令

| 命令 | 说明 |
| --- | --- |
| New API: 刷新模型列表 | 忽略缓存强制重新拉取所有配置组 |
| New API: 打开设置 | 定位到本扩展的设置页（请求参数、状态栏等） |

配置站点与密钥请用模型选择器里的 **管理模型**，或命令面板的 **Manage Language Models**

## 开发

```bash
npm install
npm run watch          # 或 npm run compile
F5                     # 启动扩展开发宿主
npm run check          # 类型 + 分层约束
npm run lint
npm test               # 单元测试（不需要扩展宿主）
npm run package        # 产出 .vsix
```

## 致谢

本项目的设计与实现借鉴于两个同类扩展：

- [ltmoerdani/opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat)
- [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)

## 相关文档

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) —— 架构说明，面向要修改本代码库的人
- [`docs/PROVIDER-DESIGN.md`](docs/PROVIDER-DESIGN.md) —— 通用层与厂商适配的设计依据、适配矩阵与新增厂商步骤
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## 许可证

本项目以 MIT 许可证发布，全文见仓库根目录的 `LICENSE`




