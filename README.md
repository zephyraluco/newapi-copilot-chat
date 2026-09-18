# New API for Copilot Chat

把 [New API](https://github.com/QuantumNous/new-api)（OpenAI 兼容网关）里的模型接入 GitHub Copilot Chat，
作为**自带密钥（BYOK）**的语言模型供应商。

配置好之后，你会用 New API 站点上的模型来驱动 Copilot Chat 的对话、Agent 模式与工具调用，
而不是使用 GitHub 提供的模型。

## 功能

- **自动发现模型**：读取站点的 `/v1/models`，把每个模型注册为 Copilot Chat 的可用模型。
- **补齐模型元数据**：结合随包的模型数据表与网关的扩展字段（`context_length`、`supported_parameters`、
  `input_modalities` 等）推导出窗口、输出上限、图片输入与工具调用能力。
- **可读的模型名**：模型选择器显示**展示名**（`Claude Sonnet 4.5`）而不是要回传的模型 ID
  （`anthropic/claude-sonnet-4.5`）；数据表没有该模型时回退到 ID，选择器的副标题给出厂商与窗口。
- **可解释的模型信息**：状态面板的模型清单里**每个数值都标注来源**（模型数据表 / 网关返回值 /
  默认值），来源冲突时会说明已采用哪个值；模型悬浮提示只列身份、规模与能力，且逐项一行、键值分列。
- **真实流式输出**：逐块输出正文；思维链（`reasoning_content` / `reasoning`）可选择是否回显——
  宿主提供「思考内容」部件时以**可折叠的思考块**呈现，否则回退到引用块。
- **思考强度可调**：支持思考的模型会在模型选择器里提供「思考强度」选项，且**档位按模型从数据表取**
  （例如某模型能选 `max`/`high`/`low`，另一个只有 `xhigh`/`high`）。
- **工具调用**：支持 Copilot Chat 的 Agent 模式与 MCP 工具，工具参数分片会正确合并。
- **会话信息里能看到真实用量**：请求结束后把上游的 `usage` 回传给 Copilot，
  「会话信息 → 上下文窗口」会显示本次请求的 token 数与各分类（系统指令、工具定义、消息）的占比。
- **状态栏与状态面板**：状态栏显示连接状态与模型数量，悬浮提示给出**本次会话的输入输出与缓存命中**
  （空闲时不弹，免得只看到一句「还没有请求」）；面板展示站点细节（地址、网关版本、延迟、最近刷新）、
  模型清单、被过滤的模型、会话用量与适配器链。
- **安全的密钥管理**：API Key 由 VS Code 存入系统钥匙串，不写入配置文件；日志中会自动脱敏。
- **支持多个站点**：可建立多个配置组（例如官方站与自建站），每组独立维护连接与模型列表。
- **DeepSeek 模型按官方形态发请求**：思考能力显式开关（`thinking`）；宿主发起的辅助请求
  （起标题、写提交信息、生成分支名…）会关掉思考——它们的产出只有一行短文本；
  思考态的工具调用历史会回填 `reasoning_content`（DeepSeek 要求这个字段）。
  其余模型走恒等变换的兜底适配器，不做任何改写。
- **可选的工具列表稳定化**：`request.stabilizeToolList` 打开后，扩展先把 `activate_*` 工具组
  激活完再发请求，让每轮的工具列表保持一致（提高上游前缀缓存命中率）。

## 快速开始

1. 打开 Copilot Chat 的模型选择器，选择 **管理模型**（Manage Models），在列表中找到 **New API**。
2. 填入 **站点地址**（例如 `https://api.example.com`）与 **API Key**。
   - 站点地址只填到根目录：`/v1` 与具体端点由扩展自动拼接。
   - 密钥由 VS Code 存进系统钥匙串，配置文件里只留占位符引用。
3. 确认后返回模型选择器，即可看到 New API 下的模型。

需要接入第二个站点时，在「管理模型」里再建一个配置组即可，两组互不影响。

状态栏会持续显示已配置的模型总数，点击即可打开状态面板（首个配置完成前，点击会直接跳到「管理模型」）。

## 配置项

本扩展的设置位于 `newapi-copilot-chat.*` 之下，可在设置界面搜索 `New API` 找到。
**站点地址与 API Key 不是设置项** —— 它们在 VS Code 的「管理模型」界面里配置。

### 常规

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `logLevel` | `info` | 日志级别（`off`/`error`/`warn`/`info`/`debug`/`trace`）。 |

### 模型

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `models.include` | `[]` | 白名单 glob（`*`、`?`），留空表示全部保留。 |
| `models.exclude` | `[]` | 黑名单 glob，**优先级高于白名单**。 |
| `models.cacheTtl` | `300000` | 模型列表缓存有效期（毫秒）。 |
| `models.defaultContextWindow` | `128000` | 未知模型的兜底上下文窗口。 |
| `models.defaultMaxOutputTokens` | `8192` | 未知模型的兜底最大输出。 |

### 请求

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `request.timeoutMs` | `60000` | 非流式是整体超时；流式是**等响应头**的上限。 |
| `request.streamIdleTimeoutMs` | `60000` | 流式响应**两个数据块之间**的静默超时；长思考的模型可以放宽。 |
| `request.includeUsage` | `true` | 是否下发 `stream_options`。少数站点不认这个字段并返回 400，关掉它即可；关掉后上游不返回用量，「会话信息」里也就没有 token 数。 |
| `request.maxRetries` | `2` | 失败重试次数（不含首次）。只对网络错误、超时、429、5xx 生效；服务端要求等超过 30 秒的限流直接报错而不重试。 |
| `request.temperature` | `null` | 留空则不发送该字段。 |
| `request.topP` | `null` | 留空则不发送该字段。 |
| `request.includeReasoning` | `false` | 是否把思维链回显给用户（宿主提供思考部件时为可折叠的思考块，否则是引用块）。不影响向 DeepSeek 回填 `reasoning_content`。 |
| `request.stabilizeToolList` | `false` | 发请求前先把 `activate_*` 工具组激活完，让每轮工具列表一致（利于上游前缀缓存），代价是每轮多带工具定义。 |
| `request.extraBody` | `{}` | 透传给所有模型的额外请求体字段。 |

### 状态

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `status.showStatusBar` | `true` | 是否在状态栏显示状态项。 |
| `status.refreshInterval` | `60000` | 状态自动刷新间隔（毫秒），最小 `10000`。 |

### 模型数据表

扩展随包附带 `data/openrouter-models.json`（约 340 条），提供网关不返回的元数据：上下文窗口、
输出上限、图片与工具能力、以及**每个模型的思考强度档位**。它是**生成产物**，由
`npm run models:openrouter` 从公开的模型目录抓取生成，扩展在激活时读取——**不要手工编辑它**
（重跑脚本会重写整个文件）。它是生成时的快照，厂商调整后可能滞后，遇到数值不符时按此顺序处理：

1. 看状态面板模型清单里的「窗口来源」列：标了「网关返回值」就说明以站点为准，不需要动数据；
2. 站点确实没返回该信息而数据表又过时了，跑 `npm run models:openrouter` 重新生成；
3. 生成结果依然不对（上游数据本身失真或渠道差异），改进生成脚本或向上游反馈。

## 思考强度

支持思考的模型会在模型选择器里出现**思考强度**控件。选择后，扩展会把对应的 `reasoning_effort`
写进请求体，由站点转给上游。三个需要注意的点：

- **预选不等于会发送**：控件预选数据表里的 `defaultReasoningEffort`，但这个值**不会被发出去**
  （它本来就是站点自己在用的），只有你改成别的档位才会往请求里加 `reasoning_effort`。
  数据表没给默认档位的模型是空选中，此时你选什么都算明确意图、照发。
- **哪些模型有控件**：①站点返回值里有 `reasoning` / `reasoning_effort` 等参数，或数据表里标了
  `reasoning`；②数据表给出了该模型的可选档位（`supportsReasoningEffort`）。只有①时说明
  「它会思考，但我们不知道它能调哪些档」，这时不显示控件——凭空造一组合适的值只会发出站点不认的请求。
- **档位逐模型、没有兜底、不经翻译**：可用范围就是数据表里的 `supportsReasoningEffort`
  （生成脚本从上游的 `reasoning.supported_efforts` 抄下），因此不同模型不一样，
  例如 `max / xhigh / high / medium / low` 或只有 `high / low`。选项文字直接用上游原值
  （`max` / `xhigh` / `minimal` / `none` …），不翻译也不缩写；具体某个取值能否被站点接受，
  取决于站点与它上游的实现。字段名固定为 `reasoning_effort`，站点若用别的叫法
  （例如 `reasoning.effort`）或需要嵌套形态，由适配器层改写——见 `src/adapter/`。

## 配置来源

配置完全由 VS Code 的 provider 配置组提供：扩展在 `package.json` 里用
`contributes.languageModelChatProviders[].configuration` 声明了一份 JSON Schema，
VS Code 据此在「管理模型」界面生成本扩展的配置表单：

| 字段 | 说明 |
| --- | --- |
| 站点地址 | 必填。New API 站点根地址，`/v1` 与具体端点由扩展拼接。 |
| API Key | 必填。声明为 `secret`，由 VS Code 存入系统钥匙串。 |

**模型按配置组隔离**（每组有独立的 HTTP 客户端与模型缓存，A 站的模型不会跑到 B 站去请求）；
**配置变更自动生效**（改完地址或密钥后，下一次模型发现就会重建对应会话，旧连接会被中断）；
**状态按组汇总**（状态栏显示合计的模型数，面板逐组列出站点、可用性、延迟与模型数）。

## 命令

| 命令 | 说明 |
| --- | --- |
| New API: 测试连接 | 重新探测所有配置组，并报告延迟与模型数量。 |
| New API: 刷新模型列表 | 忽略缓存强制重新拉取所有配置组。 |
| New API: 打开状态面板 | 打开详情面板。 |
| New API: 打开设置 | 定位到本扩展的设置页（模型过滤、请求参数等）。 |

配置站点与密钥请用模型选择器里的 **管理模型**，或命令面板的 **Manage Language Models**。

## 架构

**要改代码请先读 `docs/ARCHITECTURE.md`**——那里有分层约束、依赖方向、关键机制的取舍，
以及「改动某类需求该动哪里」。速查版：

```
src/
  extension.ts        激活与装配（只做接线）
  config.ts           VS Code 配置读取（模型过滤、请求参数、状态栏）
  consts.ts           常量（命令 ID、端点、默认值）
  types.ts            New API / OpenAI 兼容（DeepSeek 风格）数据结构
  logger.ts           日志（LogOutputChannel）+ 密钥脱敏
  json.ts             JSON 辅助（安全解析、类型收窄、按键取值）
  reasoning.ts        思维链字段名（通用层唯一知道各家差异的地方）
  format.ts           展示层格式化（token、相对时间、Markdown 转义）
  cancellation.ts     CancellationToken → AbortSignal 桥接
  client/             与 New API 交互（HTTP、SSE、端点封装）
  models/             模型信息整合（数据表、glob、配置解析、tooltip、缓存）
  provider/           与 Copilot 交互（配置组解析、会话分配、provider、消息与流转换、思考回放、工具组预激活）
  adapter/            按模型处理协议差异（框架层 + 兑底模板）
    deepseek/         DeepSeek：请求种类识别、思考开关与辅助请求改写
  status/             状态栏与状态面板
```

**模型元数据优先级：网关返回值 > 模型数据表 > 默认值**——网关最清楚自己那条链路，
数据表只是生成时的快照；两者不一致时以网关为准（状态面板的「窗口来源」列会标出来）。
数值被网关覆盖、被一致性校正（例如输出上限不能挤占输入空间）这类原因写进日志的 debug 级别，
需要排查时把扩展日志级别调到 `debug` 即可；这些细节刻意不塞进悬浮提示。

## 已知限制

- **思维链渲染**：宿主提供「思考内容」部件（`LanguageModelThinkingPart`，proposed API）时以可折叠
  的思考块呈现；宿主没有该部件时只能把思维链当正文发出去，包成引用块。
- **思考内容回填依赖宿主保留数据部件**：DeepSeek 要求思考态的助手消息带回 `reasoning_content`，
  而稳定 API 不会把思考内容交还给 provider，因此扩展额外上报一个 `stateful_marker` 数据部件再读回来。
  宿主不保留它时，这层回填就静默失效（行为与没有这个机制时一致，不会报错）。
- **Token 估算**：使用字符数启发式估算（CJK 按 1 字符 ≈ 1 token，其余按 4 字符 ≈ 1 token），
  并按上游返回的真实用量缓慢校准比例。它不是目标模型的真实分词器。
- **模型数据表会过期**：模型窗口与能力由厂商决定且会变化，请跑 `npm run models:openrouter` 重新生成。
- **思考强度只对识别为「支持思考」的模型开放**：判断不出来时宁可不显示（也不发送参数），
  避免向不认识 `reasoning_effort` 的站点发出会被拒的请求。
- **DeepSeek 的 `thinking` 字段会发给站点**：上游需要它才会思考，因此不做端点白名单；
  站点若不认它，把日志级别调到 `debug` 可以看到每次请求的 `thinking` 取值与改写理由。
- **非流式降级**：网关忽略 `stream: true` 并返回普通 JSON 时按单块响应处理，没有逐字输出效果。

## 开发

```bash
npm install
npm run watch          # 或 npm run compile
F5                     # 启动扩展开发宿主
npm test               # 在测试宿主中运行单元测试
```

## 相关文档

- `docs/ARCHITECTURE.md` —— 架构说明，面向要修改本代码库的人
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## 许可证

本项目以 MIT 许可证发布，全文见仓库根目录的 `LICENSE`。




