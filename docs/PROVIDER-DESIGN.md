# Copilot 消息与供应商协议

整体边界见 [ARCHITECTURE](ARCHITECTURE.md)。请求方式参考
[deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)：一次准备、一次发送、
原生思考和工具分片、推理回放与请求头模板；多站点及动态模型发现由本项目应用层负责。

## 宿主适配与中立消息

`host/messageContent.ts` 是宿主部件解码的唯一入口。文本、图片、工具调用/结果、原生思考和回放
统一为 `shared/messages.ts` 的判别式联合。未知控制部件被忽略。

`protocol/messages.ts` 构造线协议消息，`protocol/tokenizer.ts` 估算同一中立消息。
它们不导入 VS Code，也不读取用户设置。图片只在发送请求时编码，估算使用固定图片开销。
工具结果带原始 callId 独立发送；用户图文保持顺序。

`host/request.ts` 解析宿主模型配置，`protocol/request.ts` 合并输出上限、采样、额外请求体和
有效思考强度。用户选择优先，未改变时使用模型数据表默认值。

## 固定供应商策略

`protocol/registry.ts` 保存固定顺序：DeepSeek、Qwen、GLM、Kimi、OpenAI，最后执行能力约束。
全部命中的策略在请求副本上同步执行。没有动态注册、优先级排序或异步策略接口。

`ModelAdapter` 只声明 ID、supports、可选请求改写和推理回填要求。
`AdapterContext` 只提供模型事实、日志和有效强度，不读取宿主设置或发送网络请求。

| 厂商 | 请求适配 | 思考历史 |
| --- | --- | --- |
| DeepSeek | 显式 thinking.type；none/off 关闭并去掉强度；自定义端点辅助请求保留所选强度 | 原文回填，缺失为空串 |
| OpenAI 推理模型 | max_tokens → max_completion_tokens；清理不支持的采样字段 | 不额外回填 |
| Qwen | 无强度枚举型号使用 enable_thinking；有枚举时保留 reasoning_effort；auto 不新增开关 | 原文回填 |
| GLM | 显式 thinking；可关闭型号的辅助请求关思考；glm-5.3/4.7 不发送无效 disabled | 原文回填 |
| Kimi | K2.x 使用 thinking 并支持辅助请求关闭；K3/K2.7-code 保留顶层强度 | 原文回填 |
| 其他 | 标准 Chat Completions 与数据驱动能力约束 | 无额外回填 |

思考档位来自数据表，不按版本号猜测未知档位。厂商模型匹配应采用有依据的窄规则。
通用采样能力使用 ModelConfig.samplingParams，不为单模型增加散落的正则。

## 思考、用量与错误

- 回填优先读有效 stateful_marker，再读原生思考；缺失为空字符串，不制造推理占位。
- 思考展示可关闭，关闭不影响回填。
- 正文即时输出；工具参数按 index 累积，完成后才构造工具调用部件。
- usage 保留最后一个有效快照，正常结束统一回传。
- 取消和失败不冲刷待完成工具、不保存成功回放标记。
- HTTP 错误和截断直接交给宿主，不自动删除参数或重放聊天。

## 新增协议规则

1. 在 `protocol/<supplier>/` 实现有证据的请求差异。
2. 在固定策略表中明确执行位置，保持能力约束最后执行。
3. 模型能力、窗口、默认强度归 models 和数据表。
4. 验证最终请求、工具续轮、默认/关闭强度、未知模型以及历史隔离。

Responses、Anthropic Messages 等新通道需要独立的请求/响应协议实现，不应塞入现有 Chat Completions 参数改写。
