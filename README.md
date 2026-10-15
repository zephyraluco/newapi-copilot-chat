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

**Drive Copilot Chat with the models on your own New API site**

Wire an OpenAI-compatible gateway such as [New API](https://github.com/QuantumNous/new-api) into Copilot Chat as a bring-your-own-key (BYOK) language model provider.

## Features

- **Your site's models show up automatically**: reads `/v1/models` and registers each model; multiple provider groups (say an official site plus a self-hosted one) each get their own client and model cache
- **Readable model information**: the picker shows display names instead of the model IDs sent back to the site; the hover tooltip lists size and capabilities
- **Native streaming and reasoning**: the answer streams chunk by chunk and the reasoning can be echoed; reasoning effort is adjustable per model
- **Inherits the full Copilot feature set**: agent mode, tool calling, instructions and MCP, context window usage — this is the native provider API, so none of it is reimplemented here
- **Status bar**: model counts, latency, check time and usage totals; discovery/probe errors turn the item yellow and hide its tooltip, with details in the logs

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

GPT-6.1 Sol supports text, image, and tool calling through the Chat Completions transport.


Newer OpenAI reasoning models (GPT-5.4+, GPT-5.6, GPT-6 Astra and Codex variants) are adapted automatically: unsupported sampling fields are removed before Chat Completions requests. Image-generation model IDs are exposed without tool calling.

## Settings

Settings live under `newapi-copilot-chat.*`; search for `New API` in the Settings UI.
**The site URL and the API key are not settings** — they are configured in VS Code's *Manage Models* UI.

### Logging

Logs use the **New API for Copilot Chat** output channel. Adjust its log level using VS Code's native log-level control in the Output panel; there is no separate extension log-level setting.

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
| `request.maxRetries` | `2` | Retries for model discovery and site-health probes. Chat requests are sent once, without parameter-removal retries or stream replay. |
| `request.includeReasoning` | `true` | Show reasoning using native thinking parts (quote blocks on older hosts); independent of historical reasoning replay. |
| `request.headers` | `{}` | Custom chat request headers, overriding defaults. Supports `${conversationId}` templates, resolved once per call: Copilot conversation ID → workspace ID → request correlation ID → random ID. |
| `request.extraBody` | `{}` | Extra request fields, including `temperature` and `top_p`; model capability constraints still apply |

The chat pipeline follows `deepseek-v4-for-copilot`: prepare the request once, POST to `/v1/chat/completions`, and stream text, thinking and tool calls over SSE. DeepSeek helper requests on custom gateways keep the configured thinking effort. Historical reasoning is restored from replay markers, using an empty string when unavailable. Native-image requests are excluded from adaptive text-token calibration.

### Status

| Setting | Default | Description |
| --- | --- | --- |
| `status.showStatusBar` | `true` | Show model counts and the normal-state tooltip; errors turn the item yellow and hide its tooltip, with details in the logs; hiding the item does not stop probes |
| `status.refreshInterval` | `60000` | Site `/api/status` probe interval (ms), minimum `10000`; does not refresh the model list |

Models are fetched on demand when VS Code discovers them, after relevant configuration changes trigger rediscovery, or when you run **Refresh Models**. Cache expiry is checked on access. Site probes run separately on new/changed connections and then at `status.refreshInterval`. Discovery or probe failures turn the status bar yellow and hide the entire tooltip; details go to the extension output log. The tooltip returns after recovery. Usage totals cover successful responses across groups during the current extension-host session and reset on reload. Responses without usage add to request/tool counts without inventing token counts. Per-response token usage still appears in Copilot's session info.

**Reasoning effort is not a setting** — it is configured per model in the Copilot Chat model picker. The other settings can be written into `settings.json` directly (the whole key is one dotted string, **do not** nest it):

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

Sampling parameters are omitted unless provided in `request.extraBody`. Use the API field name `top_p` in that object.

## Reasoning effort

Models that support reasoning get a **reasoning effort** control in the model picker; the choice is written into the request body as `reasoning_effort`:

- **Explicit effective effort**: the control pre-selects the dataset's `defaultReasoningEffort`; request preparation uses the user selection or that default. Vendor rules translate the thinking switch and omit the effort field when thinking is disabled.
- The field name is fixed to `reasoning_effort`; a site using another name (for example `reasoning.effort`) or a nested shape is handled by the protocol layer — see `src/protocol/`
- **Some models do not show the control**: with tool calls present the upstream forces a fixed value (GPT-6 Sol/Luna only accept `none`), and agent-mode requests always carry tools — showing an option that can never take effect is worse than not showing it

## Where the configuration comes from

Configuration is provided entirely by VS Code's provider groups: the extension declares a JSON Schema in `package.json` under `contributes.languageModelChatProviders[].configuration`, and VS Code renders the form for this extension in the *Manage Models* UI:

| Field | Description |
| --- | --- |
| Site URL | Required, the root URL of the New API site; `/v1` and the concrete endpoints are appended by the extension |
| API Key | Required, declared `secret`, stored in the OS keychain by VS Code |

**Models are isolated per group** (each group has its own HTTP client and model cache, so site A's models are never requested from site B). Configuration changes trigger rediscovery, and retired connections finish in-flight requests. The normal tooltip shows per-group latency/time and session usage totals. Errors in any group turn the item yellow, with details in the logs.

## Commands

Command titles currently ship in Chinese; the palette shows them as listed below.

| Command | Description |
| --- | --- |
| `New API: 刷新模型列表` | Ignore the cache and re-fetch every group |
| `New API: 打开设置` | Open this extension's settings page (request parameters, status bar, and so on) |

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

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — architecture notes for people modifying this codebase (in Chinese)
- [`docs/PROVIDER-DESIGN.md`](docs/PROVIDER-DESIGN.md) — design references, the adapter matrix, and the steps for adding a vendor (in Chinese)
- [Language Model Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [VS Code API Reference](https://code.visualstudio.com/api/references/vscode-api)
- [New API](https://github.com/QuantumNous/new-api)

## Provider adaptation design

Model discovery, configuration groups, message/tool conversion, streaming, cancellation, and usage share one provider pipeline. Vendor-specific request rules live in `src/protocol/`:

| Vendor | Adaptation |
| --- | --- |
| DeepSeek | Native thinking toggle and reasoning replay; custom gateways keep the configured effort for helper requests; `none` / `off` disables thinking |
| OpenAI reasoning models | o-series and GPT-5 onward: `max_completion_tokens` and unsupported sampling-field removal |
| Qwen | Models without effort levels map the choice to `enable_thinking`; models with levels keep `reasoning_effort`; `auto` adds no toggle; reasoning replay |
| GLM | Explicit `thinking.type`; concrete effort passes through; forced-thinking `glm-5.3` / `glm-4.7` become an explicit enable; reasoning replay |
| Kimi | K2.x thinking becomes `thinking.type` and supports helper-request disabling; K3 / K2.7-code always reason and keep top-level `reasoning_effort`; reasoning replay |

Available choices remain metadata-driven. Qwen/Kimi use native toggles without inventing token budgets. These adapters use the gateway's Chat Completions endpoint. See [the design document](docs/PROVIDER-DESIGN.md) for API boundaries, references, and extension steps.

## License

Released under the MIT License; the full text is in `LICENSE` at the repository root.
