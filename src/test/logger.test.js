const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');
const { createVscodeStub } = require('./fakes');

test('日志级别由原生输出通道控制，动态切换无需配置事件或第二层闸门', () => {
	const vscode = createVscodeStub();
	const nativeCalls = [];
	const output = [];
	let disposed = false;
	const channel = { logLevel: vscode.LogLevel.Info, dispose() { disposed = true; } };
	for (const [method, rank] of Object.entries({ trace: 1, debug: 2, info: 3, warn: 4, error: 5 })) {
		channel[method] = text => {
			nativeCalls.push(method);
			if (channel.logLevel !== vscode.LogLevel.Off && rank >= channel.logLevel) { output.push(text); }
		};
	}
	vscode.window.createOutputChannel = (_name, options) => { assert.equal(options.log, true); return channel; };
	const { modules } = load({ logger: './src/provider/logger' }, { vscode });
	const service = new modules.logger.LoggerService();
	const logger = new modules.logger.Logger(service, 'test').child('request');
	logger.debug('hidden');
	assert.deepEqual(nativeCalls, ['debug'], 'debug 仍交给原生通道决定是否输出');
	assert.equal(output.length, 0);
	channel.logLevel = vscode.LogLevel.Debug;
	logger.debug('visible');
	assert.match(output[0], /^\[test:request\] visible$/);
	channel.logLevel = vscode.LogLevel.Off;
	logger.warn('hidden again');
	assert.equal(output.length, 1);
	service.dispose();
	assert.equal(disposed, true);
});

test('日志格式保留错误原因链，并对消息、附加对象和堆栈统一脱敏', () => {
	const vscode = createVscodeStub();
	const output = [];
	vscode.window.createOutputChannel = () => ({ error: value => output.push(value), dispose() {} });
	const { modules } = load({ logger: './src/provider/logger' }, { vscode });
	const service = new modules.logger.LoggerService();
	const logger = new modules.logger.Logger(service, 'test');
	const key = 'sk-123456789abcdefghijklmnop';
	logger.error(`failed ${key}`, { token: key }, new Error(`request ${key}`, { cause: new Error('root cause') }));
	assert.doesNotMatch(output[0], new RegExp(key));
	assert.match(output[0], /root cause/);
	assert.match(output[0], /Error:/);
	service.dispose();
});
