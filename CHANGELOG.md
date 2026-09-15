# Change Log

All notable changes to the "newapi-copilot-chat" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- 接入 New API（OpenAI 兼容网关）作为 GitHub Copilot Chat 的语言模型供应商（BYOK）。
  - `client/`：HTTP 传输（超时、重试、限流退避）、SSE 解析，以及 `/api/status`、
    `/v1/models`、`/v1/chat/completions` 的封装。
  - `models/`：把网关返回值、随包附带的模型数据表（`data/openrouter-models.json`）与用户覆盖
    整合成完整模型配置，生成带**数据来源标注**的 tooltip；支持 include/exclude 通配符过滤
    与结果缓存（失败时保留旧数据并给出建议）。
  - `provider/`：实现 `LanguageModelChatProvider`，包括配置组解析与会话隔离、
    消息格式转换（工具调用与工具结果的拆分/回填、多模态图片）、流式响应翻译
    （工具参数分片合并、思维链、usage）与 token 估算。
  - `adapter/`：按模型处理上游协议差异的钩子（`transformRequest` / `transformChunk` /
    `finalize`），当前为占位实现。
  - `status/`：状态栏与状态面板（逐组的连接状态、模型清单、被过滤的模型、会话用量、适配器链）。
- 站点与密钥通过 `contributes.languageModelChatProviders[].configuration` 声明，
  在 VS Code 的「管理模型」界面配置；API Key 标记为 `secret`，由 VS Code 存入系统钥匙串。
  同一供应商可建立多个配置组（多个站点），各组连接与模型缓存相互隔离。
- 命令：测试连接、刷新模型列表、打开状态面板、打开设置。
- 设置项：日志级别、模型过滤与覆盖、请求参数、状态栏开关与刷新间隔。
- 单元测试：glob 匹配、family 推导、网关字段提取、配置整合与一致性校正、
  消息转换、工具参数解析、token 估算、配置组解析与会话隔离。

### 已知限制

- 思考内容（`reasoning_content`）只能作为正文回显，稳定的 VS Code API 尚无专门的响应部件。
- token 数使用字符数启发式估算，刻意偏保守地高估。
- 随包的模型数据表是生成时的快照，可能滞后于厂商调整，可用 `models.overrides` 修正。
