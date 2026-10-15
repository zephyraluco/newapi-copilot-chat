'use strict';

/**
 * config.ts：设置变更的影响面分类。
 *
 * 只有影响 client 构造参数的变化才该重建连接，其余变化什么都不动。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { modules } = load({ config: './src/shared/settings' });
const { classifySettingsChange } = modules.config;

/** 一份完整的设置。 */
function settings(overrides = {}) {
	return {
		models: { cacheTtlMs: 300_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 },
		request: {
			timeoutMs: 60_000,
			streamIdleTimeoutMs: 60_000,
			includeUsage: true,
			maxRetries: 2,
			includeReasoning: false,
			extraBody: {},
		},
		status: { showStatusBar: true, refreshIntervalMs: 60000 },
		...overrides,
	};
}

/** 只改 `request` 里的一项。 */
function changeRequest(patch) {
	const base = settings();
	return classifySettingsChange(base, { ...base, request: { ...base.request, ...patch } });
}

/* -------------------------------------------------------------------------- */

test('什么都没变时三项都是 false', () => {
	assert.deepEqual(classifySettingsChange(settings(), settings()), {
		client: false, models: false, status: false,
	});
});

test('状态栏设置只影响 status', () => {
	const base = settings();
	assert.deepEqual(classifySettingsChange(base, { ...base, status: { ...base.status, showStatusBar: false } }), {
		client: false, models: false, status: true,
	});
	assert.deepEqual(classifySettingsChange(base, { ...base, status: { ...base.status, refreshIntervalMs: 30000 } }), {
		client: false, models: false, status: true,
	});
});

test('模型设置只影响 models', () => {
	for (const models of [
		{ cacheTtlMs: 60_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 },
		{ cacheTtlMs: 300_000, defaultContextWindow: 32_000, defaultMaxOutputTokens: 8_192 },
		{ cacheTtlMs: 300_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 4_096 },
	]) {
		const base = settings();
		assert.deepEqual(classifySettingsChange(base, { ...base, models }), {
			client: false, models: true, status: false,
		});
	}
});

test('client 的构造参数变化才算连接变化', () => {
	for (const patch of [
		{ timeoutMs: 30_000 },
		{ streamIdleTimeoutMs: 10_000 },
		{ includeUsage: false },
		{ maxRetries: 0 },
	]) {
		assert.deepEqual(changeRequest(patch), {
			client: true, models: false, status: false,
		}, JSON.stringify(patch));
	}
});

test('每次请求现读的设置不需要重建任何东西', () => {
	// 请求准备阶段读取的设置无需重建连接。
	for (const patch of [
		{ includeReasoning: true },
		{ extraBody: { foo: 1 } },
		{ headers: { 'X-Conversation-Id': '${conversationId}' } },
	]) {
		assert.deepEqual(changeRequest(patch), {
			client: false, models: false, status: false,
		}, JSON.stringify(patch));
	}
});

test('配置读取不再访问旧日志及采样设置，extraBody 保留采样参数', () => {
	const { createVscodeStub } = require('./fakes');
	const vscode = createVscodeStub();
	const reads = [];
	vscode.workspace = { getConfiguration: () => ({ get(key) {
		reads.push(key);
		return key === 'request.extraBody' ? { temperature: 0.7, top_p: 0.9 } : undefined;
	} }) };
	const loaded = load({ hostConfig: './src/host/config' }, { vscode });
	const value = loaded.modules.hostConfig.readSettings();
	assert.equal('logLevel' in value, false);
	assert.equal('temperature' in value.request, false);
	assert.equal('topP' in value.request, false);
	assert.deepEqual(value.request.extraBody, { temperature: 0.7, top_p: 0.9 });
	for (const key of ['logLevel', 'request.temperature', 'request.topP']) { assert.equal(reads.includes(key), false); }
	assert.equal(value.models.cacheTtlMs, 300000);
	assert.equal(value.status.refreshIntervalMs, 60000);
});
