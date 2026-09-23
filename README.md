<h1 align="center">New API for Copilot Chat</h1>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="许可证：MIT" />
  <img src="https://img.shields.io/badge/VS%20Code-1.137%2B-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="VS Code 1.137+" />
  <img src="https://img.shields.io/badge/BYOK-New%20API-4B5563?style=for-the-badge" alt="自带密钥" />
</p>

**用你自己 New API 站点上的模型驱动 Copilot Chat —— 不换界面，不放弃 Agent 模式。**

喜欢 Copilot Chat 的 Agent 模式、工具调用与成熟的交互体验，但想用自己网关上的模型（自建、聚合，
或想把额度与策略握在自己手里）？本扩展把 [New API](https://github.com/QuantumNous/new-api) 这类
OpenAI 兼容网关接成 Copilot Chat 的**自带密钥（BYOK）语言模型供应商**：没有新的侧边栏，
没有新的聊天界面，只是模型选择器里多了一项。

## 为什么用它？

- **不替换 Copilot，而是给它换个引擎。** 没有新侧边栏、没有新聊天界面——模型选择器里多一项而已。
- **Agent 模式、工具调用、Instructions、MCP、Skills 全都照常工作。** 因为接的是 Copilot 的原生
  provider API，整套能力栈直接复用，不需要重新实现一遍。
- **元数据是补齐出来的，不是猜的。** 网关不返回窗口与能力时用随包数据表兜底，
  并把每个数值的来源写进日志的 debug 级别。
- **站点不认某个字段也不会直接失败。** 上游点名了哪个可选字段出问题，就去掉那个字段重试，
  而不是把 400 原样丢给你。
- **密钥不进配置文件。** API Key 由 VS Code 存入系统钥匙串，日志自动脱敏。

## 功能特性

### 站点上的模型，全自动出现

读取站点的 `/v1/models`，把每个模型注册成 Copilot Chat 里可选的模型。支持**多个配置组**
（例如官方站 + 自建站），每组有独立的 HTTP 客户端与模型缓存——A 站的模型不会被拿去 B 站请求。

### 可读的模型名，可解释的元数据

选择器里显示**展示名**（`Claude Sonnet 4.5`）而不是要回传给站点的模型 ID
（`anthropic/claude-sonnet-4.5`）。悬浮提示只列身份、规模与能力，逐项一行、键值分列；
每个数值的来源与一致性校正的原因写进日志的 debug 级别——数值不符时你知道去哪儿查。

### 真实流式输出与思维链回显

正文逐块输出。思维链（`reasoning_content` / `reasoning`）可以选择是否回显，回显时以 Markdown
引用块的形式出现在回答前面。宿主持有专用「思考内容」部件时扩展会自动改用它
（渲染成可折叠的思考块）——但该部件还没进稳定 API，而提案 API 不允许发布到商店，
因此引用块是常规路径。

### 思考强度按模型可调

支持思考的模型会在选择器里出现**思考强度**控件。档位**逐模型从数据表读取**——某个模型可能是
`max` / `high` / `low`，另一个只有 `xhigh` / `high`；选项文字直接用上游原值，不翻译也不缩写。
没有档位信息的模型不显示控件：凭空造一组合适的值，只会发出站点不认的请求。

### 继承 Copilot 的整套能力

因为接入的是原生 provider API，下面这些**不用本扩展自己实现**：

- **Agent 模式**——自主多步任务
- **工具调用**——文件编辑、终端、工作区搜索、Git、测试；参数分片会正确合并
- **Instructions 与 MCP**——`.instructions.md`、`AGENTS.md` 与 MCP 工具照常生效
- **上下文窗口用量**——把上游 `usage` 回传，「会话信息」里能看到 token 数与各分类
  （系统指令 / 工具定义 / 消息）的占比

### 安全优先

API Key 在 `package.json` 里声明为 `secret`，由 VS Code 存入系统钥匙串（Windows 凭据管理器 /
macOS 钥匙串 / Linux 密钥环）。它**不写入 `settings.json`，也不会进 Git 历史**；
所有日志都经过密钥脱敏。

### 零运行时依赖

纯 VS Code API + Node.js 内置模块。没有 Python、没有 Docker、不需要额外跑一个本地代理进程去运维。

### 站点不认某个可选字段时自动绕过

站点因为 `stream_options`、`temperature`、`reasoning_effort`、`tool_choice` 或 `extraBody` 里的字段
返回 400 时，扩展会**去掉被点名的那个字段再试一次**（最多两轮）。上游没说清是哪个字段时不猜，
原样报错。

### DeepSeek 模型按官方形态发请求

思考能力显式开关（`thinking`）；宿主发起的辅助请求（起标题、写提交信息、生成分支名……）会关掉思考
——它们的产出只有一行短文本；思考态的工具调用历史会回填 `reasoning_content`（DeepSeek 要求
这个字段）。其余模型走恒等变换的兜底适配器，不做任何改写。

### 状态栏

显示连接状态与模型总数。悬停给出**本次会话**的输入输出与缓存命中（空闲时不弹，
免得只看到一句「还没有请求」）；需要你处理的问题（配置不完整、站点连不上）会在悬浮提示里
逐组列出原因与建议。

## 快速开始

### 前置条件

- **VS Code 1.137 或更高版本**（见 `engines.vscode`）。
- 一个可用的 **New API 站点**（或任何 OpenAI 兼容网关）与它的 **API Key**。
- 不需要 GitHub 提供的模型——本扩展走自带密钥（BYOK）。

### 安装

当前版本以 `.vsix` 分发：

1. 打包：`npm install` 后执行 `npm run package`，仓库根目录会得到
   `newapi-copilot-chat-<版本>.vsix`。
2. 安装：命令面板运行 **Extensions: Install from VSIX...**，选中该文件。
3. **重新加载窗口**——provider 跑在扩展宿主里，装完必须重载才生效。

### 使用步骤

1. 打开 Copilot Chat 的模型选择器，选择 **管理模型**（Manage Models），在列表中找到 **New API**。
2. 填入 **站点地址**（例如 `https://api.example.com`）与 **API Key**。
   - 站点地址只填到根目录：`/v1` 与具体端点由扩展自动拼接。
   - 密钥由 VS Code 存进系统钥匙串，配置文件里只留占位符引用。
3. 确认后返回模型选择器，即可看到 New API 下的模型。

需要接入第二个站点时，在「管理模型」里再建一个配置组即可，两组互不影响。

状态栏会持续显示已配置的模型总数，鼠标悬停可以看到本次会话的用量。
需要操作时用下面这些命令（状态栏图标本身不带点击动作）。

## 模型与元数据

模型清单完全来自你的站点，因此**没有固定的模型列表**。扩展会为每个模型补齐这些信息，
来源优先级如下：

| 信息 | 网关返回值 | 随包数据表 | 默认值 |
| --- | --- | --- | --- |
| 上下文窗口、最大输出 | 优先 | 其次 | `128000` / `8192` |
| 图片输入、工具调用 | 优先（只认肯定） | 其次 | `false` |
| 思考能力与可选档位 | 只认肯定 | **优先** | 无（列表为空则不显示控件） |
| 展示名 | 其次 | 优先 | 无展示名的模型不进选择器 |

优先级不是随手定的：**网关最清楚自己那条链路**，所以窗口与能力以它为准；而思考档位反过来
以数据表为准——远端只可能说「支持」，说不清「支持哪些档位」。

随包的 `data/openrouter-models.json`（约 340 条）覆盖主流厂商，提供网关不返回的元数据。
它是**生成产物**，由 `npm run models:openrouter` 从公开的模型目录抓取生成，扩展在激活时读取。
**不要手工编辑它**——重跑脚本会重写整个文件。

它是生成时的快照，厂商调整后可能滞后。遇到数值不符时按这个顺序处理：

1. 站点没返回该信息、而数据表又过时了 → 重跑 `npm run models:openrouter` 重新生成；
2. 生成结果依然不对（上游数据本身失真或渠道差异）→ 改进生成脚本，或向上游反馈。

## 设置项

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

**思考强度不是设置项**——它在 Copilot Chat 的模型选择器里按模型配置。其余设置可以直接写进
`settings.json`（键名整体是一个带点号的字符串，**不要**写成嵌套对象）：

```json
{
  "newapi-copilot-chat.request.temperature": 0.7,
  "newapi-copilot-chat.request.streamIdleTimeoutMs": 180000,
  "newapi-copilot-chat.models.exclude": ["*-preview"]
}
```

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
**状态按组汇总**（状态栏显示合计的模型数，悬浮提示里逐组列出配置不完整或连不上的原因）。

## 命令

| 命令 | 说明 |
| --- | --- |
| New API: 测试连接 | 重新探测所有配置组，并报告延迟与模型数量。 |
| New API: 刷新模型列表 | 忽略缓存强制重新拉取所有配置组。 |
| New API: 打开设置 | 定位到本扩展的设置页（模型过滤、请求参数等）。 |
| New API: 重置用量统计 | 把状态栏悬浮提示里的会话用量归零。 |

配置站点与密钥请用模型选择器里的 **管理模型**，或命令面板的 **Manage Language Models**。

## 架构

**要改代码请先读 `docs/ARCHITECTURE.md`**——那里有分层约束、依赖方向、关键机制的取舍，
以及「改动某类需求该动哪里」。速查版：

```
src/
  extension.ts        激活与装配（只做接线）
  commands.ts         命令实现（测试连接 / 刷新模型 / 打开设置 / 重置用量）
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
  runtime/            连接目标与会话（配置组解析、按配置组分配 client 与模型目录）
  provider/           与 Copilot 交互（provider 编排、请求组装、流消费与自愈、回传部件）
  adapter/            按模型处理协议差异（框架层 + 兜底模板）
    deepseek/         DeepSeek：请求种类识别、思考开关与辅助请求改写
  status/             状态栏与状态服务（状态聚合、悬浮提示）
```

**模型元数据优先级：网关返回值 > 模型数据表 > 默认值**（逐个字段来源见前面的「模型与元数据」）。
被网关覆盖与被一致性校正的原因都写进日志的 debug 级别——需要排查时把日志级别调到 `debug` 即可；
这些细节刻意不塞进悬浮提示。

## 已知限制

- **思维链渲染**：以 Markdown 引用块回显。代码里保留了对宿主「思考内容」部件
  （`LanguageModelThinkingPart`）的运行时探测，宿主提供它时会自动改用可折叠的思考块；
  但该部件尚未进入稳定 API，而提案 API 不允许发布到 Marketplace，
  因此扩展**不声明** `enabledApiProposals`。
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
- **改动需要重载窗口**：provider 跑在扩展宿主里，改完代码或装完 `.vsix` 后必须
  **Reload Window** 才会生效。

## 与其他做法相比

| | 本扩展 | 本地代理（LiteLLM 等） | 独立的聊天客户端 |
| --- | --- | --- | --- |
| 在 Copilot Chat 内使用 | ✅ | ✅ | ❌ 是另一个界面 |
| Agent 模式、工具、MCP | ✅ 直接用 Copilot 的 | ✅ | ⚠️ 需自行实现 |
| 需要额外常驻进程 | ✅ 不需要 | ❌ 需要 | ✅ 不需要 |
| 密钥存系统钥匙串 | ✅ | ⚠️ 取决于你的配置 | ⚠️ 各异 |
| 多站点 | ✅ 配置组隔离 | ✅ | ✅ |
| 元数据补齐与 400 自愈 | ✅ | ⚠️ 需自己配 | ⚠️ 各异 |

## 开发

```bash
npm install
npm run watch          # 或 npm run compile
F5                     # 启动扩展开发宿主
npm run check          # 类型 + 分层约束
npm run lint
npm run package        # 产出 .vsix
```

`npm run check` 里的分层约束会校验「哪些文件允许依赖 VS Code 运行时」——名单在
`scripts/check-layering.js` 顶部。**往名单外的文件里加运行时 `import 'vscode'` 会让它失败**
（`import type` 不算），这样纯逻辑模块不必为了跑起来而启动一个 VS Code。

## 相关文档

- `docs/ARCHITECTURE.md` —— 架构说明，面向要修改本代码库的人
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## 许可证

本项目以 MIT 许可证发布，全文见仓库根目录的 `LICENSE`。




