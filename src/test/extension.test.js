const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { load, ROOT } = require('./helpers');
const { createVscodeStub } = require('./fakes');
const manifest = require('../../package.json');

test('模型按需发现、独立探活和状态栏用量在扩展中正确接线', async () => {
	const vscode = createVscodeStub();
	const commands = new Map();
	const notices = [];
	const values = new Map([['request.maxRetries', 0]]);
	let changed;
	let provider;
	const item = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
	const outputFactory = vscode.window.createOutputChannel;
	const outputs = [];
	vscode.window.createOutputChannel = (...args) => {
		const output = Object.assign(outputFactory(...args), {
			logLevel: vscode.LogLevel.Info, onDidChangeLogLevel: () => ({ dispose() {} }),
		});
		outputs.push(output);
		return output;
	};
	const logs = () => outputs.flatMap(output => output.lines.map(line => line.message));
	vscode.window.createStatusBarItem = () => item;
	vscode.window.showInformationMessage = async message => { notices.push(message); };
	vscode.window.showErrorMessage = async message => { notices.push(message); };
	vscode.StatusBarAlignment = { Right: 2 };
	vscode.MarkdownString = class {
		constructor() { this.value = ''; }
		appendMarkdown(text) { this.value += text; return this; }
	};
	vscode.ThemeColor = class { constructor(id) { this.id = id; } };
	vscode.Uri.joinPath = (base, ...segments) => ({ fsPath: path.join(base.fsPath, ...segments) });
	vscode.workspace = {
		getConfiguration: () => ({ get: key => values.get(key) }),
		onDidChangeConfiguration: listener => { changed = listener; return { dispose() {} }; },
	};
	vscode.commands = {
		registerCommand: (id, callback) => { commands.set(id, callback); return { dispose() {} }; },
	};
	vscode.lm = { registerLanguageModelChatProvider: (_vendor, value) => { provider = value; return { dispose() {} }; } };
	const { modules } = load({ extension: './src/extension' }, { vscode });
	const context = { extension: { id: 'publisher.newapi', packageJSON: { version: '0.2.0' } },
		extensionUri: { fsPath: ROOT }, subscriptions: [] };
	const previousFetch = globalThis.fetch;
	const previousInterval = globalThis.setInterval;
	const previousClearInterval = globalThis.clearInterval;
	const requests = [];
	let fail = false;
	let probeFail = false;
	let includeUsage = true;
	let tick;
	let timerCount = 0;
	let clearedTimers = 0;
	const count = endpoint => requests.filter(url => url.endsWith(endpoint)).length;
	const settle = () => new Promise(resolve => setImmediate(resolve));
	globalThis.fetch = async url => {
		requests.push(url);
		if (url.endsWith('/api/status')) {
			return probeFail ? new Response('Unavailable', { status: 503 }) : new Response('{"data":{}}');
		}
		if (url.endsWith('/chat/completions')) {
			const usage = includeUsage ? { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13,
				prompt_tokens_details: { cached_tokens: 6 }, completion_tokens_details: { reasoning_tokens: 2 } } : undefined;
			return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`,
				{ headers: { 'content-type': 'text/event-stream' } });
		}
		return fail ? new Response('{"error":{"message":"Key rejected"}}', { status: 401 })
			: new Response('{"data":[{"id":"custom-model"}]}', { headers: { 'content-type': 'application/json' } });
	};
	globalThis.setInterval = callback => { timerCount++; tick = callback; return timerCount; };
	globalThis.clearInterval = () => { clearedTimers++; };
	try {
		modules.extension.activate(context);
		assert.equal(requests.length, 0);
		assert.equal(timerCount, 1);
		assert.deepEqual([...commands.keys()].sort(), [
			'newapi-copilot-chat.openSettings', 'newapi-copilot-chat.refreshModels',
		]);
		const options = { silent: true, group: 'site', configuration: { baseUrl: 'https://example.com', apiKey: 'secret' } };
		const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
		const discovered = await provider.provideLanguageModelChatInformation(options, token);
		assert.equal(discovered.length, 1);
		await settle();
		assert.match(item.text, /1 模型/);
		assert.match(item.tooltip.value, /\d+ms · /);
		assert.doesNotMatch(item.tooltip.value, /探活成功|\$\(check\)/);
		await provider.provideLanguageModelChatInformation(options, token);
		assert.equal(count('/v1/models'), 1, '未过期的模型快照复用缓存');
		assert.equal(count('/api/status'), 1, '目录变化不重复探活同一站点');
		values.set('models.defaultContextWindow', 64000);
		changed({ affectsConfiguration: () => true });
		assert.equal(count('/v1/models'), 1, '配置变化只失效并通知，不主动拉模型');
		await provider.provideLanguageModelChatInformation(options, token);
		assert.equal(count('/v1/models'), 2);
		await commands.get('newapi-copilot-chat.refreshModels')();
		assert.equal(count('/v1/models'), 3);
		assert.match(notices.at(-1), /1 个可用模型/);
		fail = true;
		await commands.get('newapi-copilot-chat.refreshModels')();
		assert.match(notices.at(-1), /刷新模型列表失败/);
		assert.equal(item.tooltip, undefined, '发现失败时不显示浮窗');
		assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground');
		assert.match(item.text, /^\$\(warning\)/);
		assert.ok(logs().some(line => /刷新模型列表失败/.test(line) && /401/.test(line)));
		assert.match(item.text, /1 模型/, '错误时仍显示缓存模型数');
		fail = false;
		await commands.get('newapi-copilot-chat.refreshModels')();
		assert.doesNotMatch(item.tooltip.value, /401/);
		assert.equal(item.backgroundColor, undefined);
		const parts = [];
		await provider.provideLanguageModelChatResponse(discovered[0], [
			{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello')] },
		], {}, { report: part => parts.push(part) }, token);
		assert.match(item.tooltip.value, /1 次请求/);
		assert.match(item.tooltip.value, /合计：13 token/);
		assert.match(item.tooltip.value, /缓存命中：6（60%）/);
		assert.ok(parts.some(part => part.mimeType === 'usage'), 'Copilot 单次 usage 仍然回传');
		includeUsage = false;
		await provider.provideLanguageModelChatResponse(discovered[0], [
			{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart('hello again')] },
		], {}, { report() {} }, token);
		assert.match(item.tooltip.value, /2 次请求/);
		assert.match(item.tooltip.value, /合计：13 token/);
		values.set('status.showStatusBar', false);
		changed({ affectsConfiguration: () => true });
		assert.equal(item.visible, false);
		values.set('status.showStatusBar', true);
		changed({ affectsConfiguration: () => true });
		assert.equal(item.visible, true);
		assert.equal(timerCount, 1, '切换状态栏不重启探活定时器');
		values.set('status.refreshInterval', 30000);
		changed({ affectsConfiguration: () => true });
		assert.equal(timerCount, 2);
		assert.equal(clearedTimers, 1);
		probeFail = true;
		tick();
		await settle();
		assert.equal(item.tooltip, undefined, '探活失败时隐藏整个浮窗，包括用量');
		assert.equal(item.backgroundColor.id, 'statusBarItem.warningBackground');
		assert.match(item.text, /^\$\(warning\)/);
		assert.ok(logs().some(line => /站点探活失败/.test(line) && /503/.test(line)));
		tick();
		await settle();
		assert.equal(logs().filter(line => /站点探活失败/.test(line)).length, 1, '相同探活错误不重复刷日志');
		assert.equal(count('/v1/models'), 5, '探活不会刷新模型列表');
		probeFail = false;
		tick();
		await settle();
		assert.match(item.tooltip.value, /\d+ms · /);
		assert.doesNotMatch(item.tooltip.value, /探活成功|\$\(check\)/);
		assert.equal(item.backgroundColor, undefined);
		assert.equal(count('/api/status'), 4);
		assert.ok(requests.every(url => ['/v1/models', '/api/status', '/v1/chat/completions'].some(endpoint => url.endsWith(endpoint))));
	} finally {
		for (const disposable of context.subscriptions.reverse()) { disposable.dispose(); }
		globalThis.fetch = previousFetch;
		globalThis.setInterval = previousInterval;
		globalThis.clearInterval = previousClearInterval;
	}
});

test('贡献点只暴露保留的命令与设置', () => {
	assert.deepEqual(manifest.contributes.commands.map(command => command.command).sort(), [
		'newapi-copilot-chat.openSettings', 'newapi-copilot-chat.refreshModels',
	]);
	const properties = manifest.contributes.configuration.properties;
	assert.equal(properties['newapi-copilot-chat.request.stabilizeToolList'], undefined);
	assert.equal(properties['newapi-copilot-chat.status.refreshInterval'].default, 60000);
	assert.ok(properties['newapi-copilot-chat.request.includeUsage']);
	for (const key of ['logLevel', 'request.temperature', 'request.topP']) {
		assert.equal(properties[`newapi-copilot-chat.${key}`], undefined);
	}
	for (const key of ['models.cacheTtl', 'models.defaultContextWindow', 'models.defaultMaxOutputTokens',
		'request.maxRetries', 'request.includeReasoning', 'status.showStatusBar']) {
		assert.ok(properties[`newapi-copilot-chat.${key}`]);
	}
});
