<h1 align="center">New API for Copilot Chat</h1>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License: MIT" />
  <img src="https://img.shields.io/badge/VS%20Code-1.137%2B-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="VS Code 1.137+" />
  <img src="https://img.shields.io/badge/BYOK-New%20API-4B5563?style=for-the-badge" alt="bring your own key" />
  <img src="https://vsmarketplacebadges.dev/version-short/zephyraluco.newapi-copilot-chat.svg?style=for-the-badge&label=Version" alt="Version" />
  <img src="https://vsmarketplacebadges.dev/installs-short/zephyraluco.newapi-copilot-chat.svg?style=for-the-badge" alt="Installs" />
</p>

<p align="center">
  <a href="README.zh-CN.md">简体中文</a> · <b>English</b>
</p>

**Drive Copilot Chat with the models on your own New API site — same interface, Agent mode included**

Wire an OpenAI-compatible gateway such as [New API](https://github.com/QuantumNous/new-api) into Copilot Chat as a bring-your-own-key (BYOK) language model provider.

## Features

- **Your site's models show up automatically**: reads `/v1/models` and registers each model; multiple provider groups (say an official site plus a self-hosted one) each get their own client and model cache
- **Readable model information**: the picker shows display names instead of the model IDs sent back to the site; the hover tooltip lists size and capabilities
- **Native streaming and reasoning**: the answer streams chunk by chunk and the reasoning can be echoed; reasoning effort is adjustable per model
- **Inherits the full Copilot feature set**: agent mode, tool calling, instructions and MCP, context window usage — this is the native provider API, so none of it is reimplemented here
- **Status bar**: connection state and model count, with this session's usage on hover

## Getting started

### Requirements

- **VS Code 1.137 or newer**
- A working **New API site** (or any OpenAI-compatible gateway) and its **API key**
- No GitHub-hosted models needed — this extension is BYOK

### Install

Distributed as a `.vsix` for now:

1. Package it: run `npm install`, then `npm run package`; the repository root gets `newapi-copilot-chat-<version>.vsix`
2. Install it: run **Extensions: Install from VSIX...** from the Command Palette and pick that file
3. **Reload the window** — the provider runs in the extension host, so it only takes effect after a reload

### Usage

1. Open the Copilot Chat model picker → **Manage Models** → **New API**
2. Fill in the **site URL** (for example `https://api.example.com`) and the **API key**
   - Enter the root URL only; `/v1` and the concrete endpoints are appended by the extension
   - The key is stored in the OS keychain by VS Code, so the configuration file keeps only a placeholder reference
3. Confirm, go back to the model picker, and the models under New API are there

## Models and metadata

The model list comes entirely from your site, so **there is no fixed list**; the extension fills in the details for each model, in this priority order:

| Information | Gateway response | Bundled dataset | Default |
| --- | --- | --- | --- |
| Context window, max output | first | second | `128000` / `8192` |
| Image input, tool calling | first (positives only) | second | `false` |
| Reasoning support and efforts | positives only | **first** | none (no control when the list is empty) |
| Display name | second | first | models without a display name are not registered |

## Settings

Settings live under `newapi-copilot-chat.*`; search for `New API` in the Settings UI.
**The site URL and the API key are not settings** — they are configured in VS Code's *Manage Models* UI.

### General

| Setting | Default | Description |
| --- | --- | --- |
| `logLevel` | `info` | Log level (`off`/`error`/`warn`/`info`/`debug`/`trace`) |

### Models

| Setting | Default | Description |
| --- | --- | --- |
| `models.cacheTtl` | `300000` | Model list cache lifetime (ms) |
| `models.defaultContextWindow` | `128000` | Fallback context window for unknown models |
| `models.defaultMaxOutputTokens` | `8192` | Fallback max output for unknown models |

### Requests

| Setting | Default | Description |
| --- | --- | --- |
| `request.timeoutMs` | `60000` | A whole-request timeout when not streaming; when streaming, the limit on **waiting for the response headers** |
| `request.streamIdleTimeoutMs` | `60000` | Idle timeout **between two chunks** of a streaming response; raise it for models that think for a long time |
| `request.includeUsage` | `true` | Whether to send `stream_options`; a few sites reject the field with a 400, so turn it off there (the upstream then reports no usage and the session info shows no token counts) |
| `request.maxRetries` | `2` | Retry attempts excluding the first one; applies to network errors, timeouts, 429 and 5xx only, and a rate limit asking for more than 30 seconds fails right away |
| `request.temperature` | `null` | Left empty, the field is not sent |
| `request.topP` | `null` | Left empty, the field is not sent |
| `request.includeReasoning` | `false` | Whether to echo the reasoning to the user (quote block or thinking block); does not affect the `reasoning_content` echoed back to DeepSeek |
| `request.stabilizeToolList` | `false` | Activate the `activate_*` tool groups before sending, keeping the tool list identical every round (good for the upstream prefix cache) at the cost of carrying the tool definitions every round |
| `request.extraBody` | `{}` | Extra request body fields passed through for every model |

### Status

| Setting | Default | Description |
| --- | --- | --- |
| `status.showStatusBar` | `true` | Whether to show the status bar item |
| `status.refreshInterval` | `60000` | Status refresh interval (ms), minimum `10000` |

**Reasoning effort is not a setting** — it is configured per model in the Copilot Chat model picker. The other settings can be written into `settings.json` directly (the whole key is one dotted string, **do not** nest it):

```json
{
  "newapi-copilot-chat.models.cacheTtl": 600000,
  "newapi-copilot-chat.request.temperature": 0.7,
  "newapi-copilot-chat.request.streamIdleTimeoutMs": 180000
}
```

## Reasoning effort

Models that support reasoning get a **reasoning effort** control in the model picker; the choice is written into the request body as `reasoning_effort`:

- **Not sent by default**: the control pre-selects the dataset's `defaultReasoningEffort`, but that value is never sent (the site is already using it); only a different choice adds `reasoning_effort`
- The field name is fixed to `reasoning_effort`; a site using another name (for example `reasoning.effort`) or a nested shape is handled by the adapter layer — see `src/adapter/`

## Where the configuration comes from

Configuration is provided entirely by VS Code's provider groups: the extension declares a JSON Schema in `package.json` under `contributes.languageModelChatProviders[].configuration`, and VS Code renders the form for this extension in the *Manage Models* UI:

| Field | Description |
| --- | --- |
| Site URL | Required, the root URL of the New API site; `/v1` and the concrete endpoints are appended by the extension |
| API Key | Required, declared `secret`, stored in the OS keychain by VS Code |

**Models are isolated per group** (each group has its own HTTP client and model cache, so site A's models are never requested from site B), **configuration changes take effect automatically** (after the URL or key changes, the next model discovery rebuilds that session and the old connections are aborted), and **status is aggregated per group** (the status bar shows the combined model count; the tooltip lists, group by group, why one is incomplete or unreachable).

## Commands

Command titles currently ship in Chinese; the palette shows them as listed below.

| Command | Description |
| --- | --- |
| `New API: 测试连接` | Probe every group again and report latency and model count |
| `New API: 刷新模型列表` | Ignore the cache and re-fetch every group |
| `New API: 打开设置` | Open this extension's settings page (request parameters, status bar, and so on) |
| `New API: 重置用量统计` | Reset the session usage shown in the status bar tooltip |

To configure a site and its key, use **Manage Models** in the model picker, or **Manage Language Models** from the Command Palette.

## Development

```bash
npm install
npm run watch          # or npm run compile
F5                     # launch the extension development host
npm run check          # types + layering rules
npm run lint
npm test               # unit tests (no extension host needed)
npm run package        # produce the .vsix
```

## Credits

The design and implementation borrow from two similar extensions:

- [ltmoerdani/opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat)
- [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot)

## Documentation

- `docs/ARCHITECTURE.md` — architecture notes for people modifying this codebase (in Chinese)
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## License

Released under the MIT License; the full text is in `LICENSE` at the repository root.
