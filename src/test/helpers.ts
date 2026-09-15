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

/** 构造一条模型数据表记录，只覆盖用例关心的字段。 */
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

/** 构造模型设置，只覆盖用例关心的字段。 */
export function createSettings(patch: Partial<ModelSettings> = {}): ModelSettings {
	return {
		include: [],
		exclude: [],
		overrides: {},
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
