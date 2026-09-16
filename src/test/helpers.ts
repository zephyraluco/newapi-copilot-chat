/**
 * 测试辅助。
 *
 * 文件名不含 `.test.`，因此不会被 `.vscode-test.mjs` 的 glob 当成测试用例收集，
 * 只作为被 import 的模块使用。
 */

import type { ModelDatasetEntry } from '../models/dataset';
import { installModelDataset } from '../models/dataset';
import type { ModelSettings } from '../config';
import { Logger, LoggerService } from '../logger';
import type { LogLevelName } from '../logger';
import type { NewApiModel } from '../types';

/**
 * 安装一份测试用模型数据表。
 *
 * `dataset.ts` 用的是模块级状态（真实运行时由 `extension.ts` 读文件后安装），
 * 而测试宿主里扩展可能已经装过真实数据（激活事件包含 `onStartupFinished`）。
 * 因此每个依赖数据表的用例都必须显式安装自己想要的那份，不能依赖默认状态。
 */
export function installTestDataset(entries: readonly Partial<ModelDatasetEntry>[]): void {
	installModelDataset({ models: entries });
}

/** 清空数据表，用于验证「没有数据表时的兜底行为」。 */
export function clearTestDataset(): void {
	installModelDataset(undefined);
}

/**
 * 构造一条模型数据表记录，只覆盖用例关心的字段。
 *
 * 默认把窗口与能力位都写上：这两种「提供值」的写法最接近随包数据表的形态，
 * 想看「数据表没有某个字段」的效果就显式传 `undefined`。
 */
export function datasetEntry(id: string, patch: Partial<ModelDatasetEntry> = {}): ModelDatasetEntry {
	return {
		id,
		contextWindow: 128_000,
		maxOutputTokens: 16_384,
		imageInput: false,
		toolCalling: false,
		...patch,
	};
}

/** 复用同一个关闭了输出的日志服务，避免每个用例都创建一个输出通道。 */
let loggerCache: Logger | undefined;

/** 取得一个「什么都不输出」的 Logger。 */
export function testLogger(): Logger {
	if (loggerCache === undefined) {
		loggerCache = new Logger(new LoggerService('off'), 'test');
	}
	return loggerCache;
}

/** 捕获到的一行日志。 */
export interface CapturedLog {
	readonly level: Exclude<LogLevelName, 'off'>;
	readonly scope: string;
	readonly message: string;
}

/**
 * 把日志行收集起来的测试用日志服务。
 *
 * `LoggerService.write` 是所有 Logger 的唯一出口，覆盖它就能拿到「写了什么」，
 * 而不必碰真实的输出通道。同时也绕过了级别闸门——用例关心的是「有没有留下痕迹」，
 * 不是这条日志最终会不会被渲染。
 */
class CapturingLoggerService extends LoggerService {
	readonly lines: CapturedLog[] = [];

	override write(level: Exclude<LogLevelName, 'off'>, scope: string, message: string): void {
		this.lines.push({ level, scope, message });
	}
}

/** 日志捕获器：既能当 Logger 用，也能查「哪些行被写出来了」。 */
export interface CapturingLogger {
	readonly logger: Logger;
	/** 全部写出的日志行，顺序与实际写入一致 */
	readonly lines: readonly CapturedLog[];
	/** 只取某个级别的消息文本，避免用例被其他级别的噪声干扰 */
	messages(level: Exclude<LogLevelName, 'off'>): string[];
}

/**
 * 取得一个会把日志行收集下来的 Logger。
 *
 * 用于断言「不该静默发生的事确实有了出口」——例如数值被网关覆盖、被一致性校正。
 */
export function capturingLogger(): CapturingLogger {
	const service = new CapturingLoggerService('off');
	return {
		logger: new Logger(service, 'test'),
		lines: service.lines,
		messages: (level) => service.lines.filter(line => line.level === level).map(line => line.message),
	};
}

/** 构造模型设置，只覆盖用例关心的字段。 */
export function createSettings(patch: Partial<ModelSettings> = {}): ModelSettings {
	return {
		include: [],
		exclude: [],
		cacheTtlMs: 300_000,
		defaultContextWindow: 128_000,
		defaultMaxOutputTokens: 8_192,
		...patch,
	};
}

/** 构造一个网关返回的模型对象。 */
export function createModel(id: string, extra: Record<string, unknown> = {}): NewApiModel {
	return { id, object: 'model', created: 1_700_000_000, owned_by: 'test-provider', ...extra };
}
