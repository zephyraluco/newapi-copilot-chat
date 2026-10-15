# 架构说明

项目提供 New API → GitHub Copilot Chat 的 BYOK 接入。现有功能保持完整：多站点、动态模型发现、
原生图片、工具调用、思考与回放、工具预激活、状态栏、后台探测、累计用量和四个命令。
用户配置见 [README](../README.zh-CN.md)，供应商规则见 [PROVIDER-DESIGN](PROVIDER-DESIGN.md)。

## 1. 模块边界

```text
src/
  extension.ts          唯一装配入口、配置变化协调
  host/                 VS Code API、部件解码、Provider、设置、命令和展示
  application/          多站点会话、目录缓存、刷新调度、累计状态
  transport/            HTTP、SSE、端点调用、网络错误
  protocol/             纯请求准备、厂商策略、响应翻译、token 与 usage
  models/               模型数据表、远端元数据、能力与窗口整合
  shared/               中立消息、线协议类型、设置类型、日志端口和纯工具
  test/                 Node 测试与宿主替身
```

依赖方向：

```text
extension → host / application / protocol / models / shared
host → application / transport / protocol / models / shared
application → transport / protocol / models / shared
transport → protocol / shared
protocol → models / shared
models → shared
```

同层模块允许单向引用，全部模块禁止形成环。只有 `host/` 和入口可以导入 `vscode`，类型导入也遵守边界。
`transport` 使用 `protocol/reasoning` 将非流式网关响应归一化，协议层不会反向调用网络。
`shared/log.ts` 是结构化日志端口，真正的输出通道由 `host/logger.ts` 创建。

`npm run check-layering` 使用 TypeScript AST 检查导入、重导出、动态导入、require、类型边和循环依赖，
不依赖文件白名单。不存在的路径和未声明的目录也会失败。

## 2. 请求与响应

```text
Copilot 消息 / 选项
  → host/chatProvider：站点定位、可选工具预激活、取消桥接
  → host/messageContent：解码为 shared/messages 中立消息
  → host/request：解析宿主选项与工具 schema
  → protocol/request：生成完整请求、执行固定厂商策略与能力约束
  → host/headers：解析本次调用的请求头模板
  → transport/newApiClient：一次 POST /v1/chat/completions
  → transport/sse：逐事件读取
  → protocol/stream：正文、思考、工具分片归并
  → host/streamFlow：构造 VS Code 部件、回传最终 usage
  → host/chatProvider：保存推理回放标记、校准 token、记录累计用量
```

- 聊天只发送一次，HTTP 拒绝和断流直接报错，不自动删除字段或重放。
- `extraBody` 不能覆盖 model/messages/tools 等骨架字段。输出上限始终显式生成。
- 工具定义按模型能力提供，零参数工具补空对象 schema，工具选择使用 `auto`。
- 中立消息保留原始图片字节；只有请求编码才生成 base64。token 估算不编码图片。
- 请求转换与 token 估算共用 `host/messageContent.ts`，不再各自识别宿主部件。
- 推理历史优先采用有效回放标记，其次原生思考部件，缺失时回填空字符串。
- 思考展示独立于回填：默认显示，宿主支持时用原生部件，否则使用引用块。
- `stateful_marker` 是非展示元数据，不发送为正文。标记格式由 `host/replay.ts` 负责。
- 工具按 index 拼接函数名和 JSON 参数，收到 stop/tool_calls 收尾时上报，否则正常结束时冲刷。
- usage 取最后一个有效对象，null 不覆盖已有快照，正常结束只回传一次。
- 取消或失败不冲刷未完成工具、不写成功回放标记。

工具预激活属于宿主行为：`host/preflight.ts` 与 `host/toolFlow.ts` 保留原有轮数限制及伪调用过滤。
这些控制消息始终从上游请求中剔除，即使用户后来关闭预激活设置。

## 3. 多站点与生命周期

`application/target.ts` 校验站点和密钥，URL 规范化来自 `shared/url.ts`，不依赖宿主设置读取。
模型信息只携带目标指纹与标签，不携带 API Key。

`application/session.ts` 为每个配置组持有 client + catalog。会话签名包含目标身份及客户端构造参数。

- 相同签名复用会话；变化时立即创建新会话。
- 原会话停止接收新请求，但已开始的请求自然结束。
- 退役会话由注册表持续跟踪，客户端空闲后移除；扩展停用时活动与退役会话都被释放。
- 响应阶段按 targetKey 精确定位，找不到时要求重新选择模型，不退回其他站点。

`extension.ts` 是唯一配置变化协调入口：设置分类一次 → 更新日志 → 更新会话或失效目录 →
更新刷新定时器 → 必要时刷新并通知模型选择器。状态服务不再自行订阅配置、重复执行缓存失效。

## 4. 目录缓存

`application/catalog.ts` 负责 TTL、并发合并、首拉失败退避与刷新失败沿用旧数据。
模型构建仍是 `models/` 的纯计算。

- 设置变化由配置协调入口使缓存失效。
- 每次失效递增版本号；此前的请求即使晚完成，也不能覆盖新缓存或触发旧事件。
- 旧任务的 finally 不会清除后来启动的新任务。
- 目录释放后不再接受请求或写入快照。
- 变化签名覆盖完整模型事实与错误信息，不含 fetchedAt；名称、默认思考强度变化也会通知宿主。
- Provider 不把瞬时的模型发现 CancellationToken 接到共享拉取上，避免取消其他调用者。

模型事实合并顺序：网关扩展字段 → 随包数据表 → 设置默认值。窗口由 `limits.ts` 校正，
保持输入/输出与上下文自洽。思考档位来自数据表，不编造上游未声明的枚举。
数据表通过 `npm run models:openrouter` 生成，激活时载入；缺失或损坏则清空并使用兜底。
tooltip 和模型副标题在 `host/tooltip.ts` 生成，`ModelConfig` 不保存展示 Markdown。

## 5. 状态与探测

`application/statusService.ts` 管理状态快照、后台调度和累计用量，`host/statusBar.ts` 只负责展示。
测试连接和刷新模型命令共用一个实现，仍分别给出连接延迟和模型数量文案。

- 并发刷新共享同一个任务。
- 强制刷新可以将正在运行的普通刷新升级为后续一次强制拉取。
- 每次探测使用服务生命周期信号，释放时真正中止网络请求。
- 释放后不再发事件或启动新任务。
- `/api/status` 仍被周期性探测；不可用原因进入日志，不保存无人使用的站点响应字段。
- 累计用量与单次 Copilot usage 相互独立；上游未报告时不虚构用量。
- 缓存命中文案、最近请求时间等展示计算归宿主层。

## 6. 传输

`transport/http.ts` 管理鉴权以外的通用传输：错误分类、取消、超时、GET 重试与客户端生命周期。
`newApiClient.ts` 封装三个实际使用的端点，保留网关返回普通 JSON 时的响应转换。

- 流式 timeoutMs 限制等待响应头，之后使用 streamIdleTimeoutMs。
- 非流式读取的超时覆盖响应体；重试等待可以被取消。
- 清理响应头超时不会解绑调用方/客户端释放信号，等待流数据时也能停止。
- SSE 支持跨分块 UTF-8、CRLF、心跳、无结尾换行的残留事件。
- 已解析出数据却缺 DONE/finish_reason 时视为截断。
- 网络错误分类留在 transport；转换为 LanguageModelError 属于 host。

## 7. 验证与扩展

```text
npm run check       类型、依赖方向与循环检查
npm run lint        编码规则
npm test            协议、消息、元数据、生命周期与架构规则
npm run compile     类型、lint、扩展打包构建
```

新增供应商：修改 `protocol/<supplier>/` 与固定策略表，补最终请求测试。
新增元数据：修改模型数据层与生成脚本。
新增宿主展示：只修改 host。
新增用户设置：声明 package.json → host/config 读取 → shared/settings 类型/影响分类 → 对应消费者。
共享工具必须有实际消费者；不要为潜在扩展增加动态注册、空包装或第二套状态来源。
