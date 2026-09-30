<h1 align="center">New API for Copilot Chat</h1>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="许可证：MIT" />
  <img src="https://img.shields.io/badge/VS%20Code-1.137%2B-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="VS Code 1.137+" />
  <img src="https://img.shields.io/badge/BYOK-New%20API-4B5563?style=for-the-badge" alt="自带密钥" />
</p>

**用你自己 New API 站点上的模型驱动 Copilot Chat —— 不换界面，不放弃 Agent 模式**

把 [New API](https://github.com/QuantumNous/new-api) 这类 OpenAI 兼容网关接成 Copilot Chat 的自带密钥（BYOK）语言模型供应商

## 功能特性

- **站点模型自动出现**：读取 `/v1/models` 逐个注册；支持多个配置组（例如官方站 + 自建站），各自独立的客户端与缓存
- **可读的模型信息**：选择器显示展示名而非回传给站点的模型 ID；悬浮提示列出规模与能力
- **原生流式与思考**：正文逐块输出，思维链可选回显；思考强度按模型可调
- **继承 Copilot 的整套能力**：Agent 模式、工具调用、Instructions 与 MCP、上下文窗口用量——接入的是原生 provider API
- **状态栏**：显示连接状态与模型总数，悬停给出本次会话的用量

## 快速开始

### 前置条件

- **VS Code 1.137 或更高版本**（见 `engines.vscode`）
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

## 设置项

本扩展的设置位于 `newapi-copilot-chat.*` 之下，可在设置界面搜索 `New API` 找到
**站点地址与 API Key 不是设置项** —— 它们在 VS Code 的「管理模型」界面里配置

### 常规

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `logLevel` | `info` | 日志级别（`off`/`error`/`warn`/`info`/`debug`/`trace`） |

### 模型

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `models.cacheTtl` | `300000` | 模型列表缓存有效期（毫秒） |
| `models.defaultContextWindow` | `128000` | 未知模型的兜底上下文窗口 |
| `models.defaultMaxOutputTokens` | `8192` | 未知模型的兜底最大输出 |

### 请求

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `request.timeoutMs` | `60000` | 非流式是整体超时；流式是**等响应头**的上限 |
| `request.streamIdleTimeoutMs` | `60000` | 流式响应**两个数据块之间**的静默超时；长思考的模型可以放宽 |
| `request.includeUsage` | `true` | 是否下发 `stream_options`；少数站点不认这个字段并返回 400，关掉它即可（关掉后上游不返回用量，「会话信息」里也就没有 token 数） |
| `request.maxRetries` | `2` | 失败重试次数（不含首次）；只对网络错误、超时、429、5xx 生效，服务端要求等超过 30 秒的限流直接报错 |
| `request.temperature` | `null` | 留空则不发送该字段 |
| `request.topP` | `null` | 留空则不发送该字段 |
| `request.includeReasoning` | `false` | 是否把思维链回显给用户（引用块或思考块）；不影响向 DeepSeek 回填 `reasoning_content` |
| `request.stabilizeToolList` | `false` | 发请求前先把 `activate_*` 工具组激活完，让每轮工具列表一致（利于上游前缀缓存），代价是每轮多带工具定义 |
| `request.extraBody` | `{}` | 透传给所有模型的额外请求体字段 |

### 状态

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `status.showStatusBar` | `true` | 是否在状态栏显示状态项 |
| `status.refreshInterval` | `60000` | 状态自动刷新间隔（毫秒），最小 `10000` |

**思考强度不是设置项**——它在 Copilot Chat 的模型选择器里按模型配置；其余设置可以直接写进
`settings.json`（键名整体是一个带点号的字符串，**不要**写成嵌套对象）：

```json
{
  "newapi-copilot-chat.models.cacheTtl": 600000,
  "newapi-copilot-chat.request.temperature": 0.7,
  "newapi-copilot-chat.request.streamIdleTimeoutMs": 180000
}
```

## 思考强度

支持思考的模型会在模型选择器里出现**思考强度**控件，选择后扩展把 `reasoning_effort` 写进请求体：

- **默认不发送**：控件预选数据表里的 `defaultReasoningEffort`，但这个值不会被发出去（站点本来就在用它），只有改成别的档位才加 `reasoning_effort`
- 字段名固定为 `reasoning_effort`；站点若用别的叫法（例如 `reasoning.effort`）或需要嵌套形态，由适配器层改写——见 `src/adapter/`

## 配置来源

配置完全由 VS Code 的 provider 配置组提供：扩展在 `package.json` 里用
`contributes.languageModelChatProviders[].configuration` 声明一份 JSON Schema，
VS Code 据此在「管理模型」界面生成本扩展的配置表单：

| 字段 | 说明 |
| --- | --- |
| 站点地址 | 必填，New API 站点根地址，`/v1` 与具体端点由扩展拼接 |
| API Key | 必填，声明为 `secret`，由 VS Code 存入系统钥匙串 |

**模型按配置组隔离**（每组有独立的 HTTP 客户端与模型缓存，A 站的模型不会跑到 B 站去请求）、
**配置变更自动生效**（改完地址或密钥后，下一次模型发现就会重建对应会话，旧连接会被中断）、
**状态按组汇总**（状态栏显示合计的模型数，悬浮提示里逐组列出配置不完整或连不上的原因）

## 命令

| 命令 | 说明 |
| --- | --- |
| New API: 测试连接 | 重新探测所有配置组，并报告延迟与模型数量 |
| New API: 刷新模型列表 | 忽略缓存强制重新拉取所有配置组 |
| New API: 打开设置 | 定位到本扩展的设置页（请求参数、状态栏等） |
| New API: 重置用量统计 | 把状态栏悬浮提示里的会话用量归零 |

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

- `docs/ARCHITECTURE.md` —— 架构说明，面向要修改本代码库的人
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## 许可证

本项目以 MIT 许可证发布，全文见仓库根目录的 `LICENSE`




