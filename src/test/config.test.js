'use strict';

/**
 * config.ts：设置变更的影响面分类。
 *
 * 只有影响 client 构造参数的变化才该重建连接，其余变化什么都不动。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

const { modules } = load({ config: './src/config' });
const { classifySettingsChange } = modules.config;

/** 一份完整的设置。 */
function settings(overrides = {}) {
	return {
		logLevel: 'info',
		models: { cacheTtlMs: 300_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 },
		request: {
			timeoutMs: 60_000,
			streamIdleTimeoutMs: 60_000,
			includeUsage: true,
			maxRetries: 2,
			temperature: undefined,
			topP: undefined,
			includeReasoning: false,
			stabilizeToolList: false,
			extraBody: {},
		},
		status: { showStatusBar: true, refreshIntervalMs: 60_000 },
		...overrides,
	};
}

/** 只改 `request` 里的一项。 */
function changeRequest(patch) {
	const base = settings();
	return classifySettingsChange(base, { ...base, request: { ...base.request, ...patch } });
}

/* -------------------------------------------------------------------------- */

test('什么都没变时四项都是 false', () => {
	assert.deepEqual(classifySettingsChange(settings(), settings()), {
		client: false, models: false, status: false, logLevel: false,
	});
});

test('日志级别变化不影响连接、模型与状态栏', () => {
	const base = settings();
	assert.deepEqual(classifySettingsChange(base, { ...base, logLevel: 'debug' }), {
		client: false, models: false, status: false, logLevel: true,
	});
});

test('状态栏设置只影响 status', () => {
	for (const status of [
		{ showStatusBar: false, refreshIntervalMs: 60_000 },
		{ showStatusBar: true, refreshIntervalMs: 30_000 },
	]) {
		const base = settings();
		assert.deepEqual(classifySettingsChange(base, { ...base, status }), {
			client: false, models: false, status: true, logLevel: false,
		});
	}
});

test('模型设置只影响 models', () => {
	for (const models of [
		{ cacheTtlMs: 60_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 8_192 },
		{ cacheTtlMs: 300_000, defaultContextWindow: 32_000, defaultMaxOutputTokens: 8_192 },
		{ cacheTtlMs: 300_000, defaultContextWindow: 128_000, defaultMaxOutputTokens: 4_096 },
	]) {
		const base = settings();
		assert.deepEqual(classifySettingsChange(base, { ...base, models }), {
			client: false, models: true, status: false, logLevel: false,
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
			client: true, models: false, status: false, logLevel: false,
		}, JSON.stringify(patch));
	}
});

test('每次请求现读的设置不需要重建任何东西', () => {
	// 采样参数、思考回显、工具组预激活、extraBody 都由 buildRequest 每次现读
	for (const patch of [
		{ temperature: 0.5 },
		{ topP: 0.9 },
		{ includeReasoning: true },
		{ stabilizeToolList: true },
		{ extraBody: { foo: 1 } },
	]) {
		assert.deepEqual(changeRequest(patch), {
			client: false, models: false, status: false, logLevel: false,
		}, JSON.stringify(patch));
	}
});
