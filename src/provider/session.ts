/**
 * 会话注册表：把「连接目标」映射到一整套运行时对象（client + 模型目录）。
 *
 * ## 为什么要按目标分配
 *
 * VS Code 会为每个配置组分别调用 provider，而组之间可以指向不同的 New API 站点、
 * 使用不同的密钥。因此：
 * - **不能**全局共用一份 client / 模型缓存，否则 A 站的模型列表会串到 B 站；
 * - 也**不该**每次调用都新建 client，否则 VS Code 的反复轮询会不断发起新连接。
 *
 * 这里按目标维护一份会话：同一目标的配置没变就复用，配置变了（指纹不同）
 * 就重建旧的并释放它——旧 client 的 `dispose()` 会中断它还挂着的在途请求，
 * 避免拿到按过期配置发出的响应。
 */

import * as vscode from 'vscode';
import { NewApiClient } from '../client/newApiClient';
import type { ModelSettings, RequestSettings } from '../config';
import type { Logger } from '../logger';
import { ModelCatalog } from '../models/catalog';
import type { ProviderTarget } from './target';

/** 一个连接目标对应的一整套运行时对象。 */
export interface ProviderSession {
	readonly target: ProviderTarget;
	/** 面向该目标的 HTTP 客户端 */
	readonly client: NewApiClient;
	/** 该目标的模型目录（带独立缓存） */
	readonly catalog: ModelCatalog;
	/** 释放该会话（中断在途请求、停止事件） */
	dispose(): void;
}

/** 会话注册表的依赖。 */
export interface SessionRegistryDeps {
	readonly logger: Logger;
	/** 取模型过滤 / 覆盖设置。这部分对所有目标共享 */
	getModelSettings(): ModelSettings;
	/** 取请求设置（超时、重试） */
	getRequestSettings(): RequestSettings;
}

/**
 * 按目标缓存会话。
 *
 * 同一个「槽位」只保留一个会话：槽位就是组名。这样配置变更时旧会话一定会被替换掉，
 * 不会在 Map 里堆积。
 */
export class SessionRegistry implements vscode.Disposable {
	private readonly sessions = new Map<string, ProviderSession>();
	private readonly emitter = new vscode.EventEmitter<void>();
	private disposed = false;

	/** 任一会话的模型列表发生变化时触发（provider 据此通知 VS Code 重新发现模型）。 */
	readonly onDidChange = this.emitter.event;

	constructor(private readonly deps: SessionRegistryDeps) { }

	/**
	 * 解析目标对应的会话，必要时创建。
	 *
	 * 配置指纹不同即视为「换了目标」，会重建会话。
	 */
	resolve(target: ProviderTarget): ProviderSession {
		if (this.disposed) {
			throw new Error('SessionRegistry 已释放');
		}
		const slot = target.group ?? '';
		const existing = this.sessions.get(slot);
		if (existing !== undefined) {
			if (existing.target.key === target.key) {
				return existing;
			}
			this.deps.logger.info(`配置已变化，重建会话：${target.label}`);
			this.release(existing);
		}

		const session = this.create(target);
		this.sessions.set(slot, session);
		this.deps.logger.debug(`创建会话：${target.label}（${target.baseUrl || '地址未配置'}）`);
		// 新增会话意味着可用模型集合可能变化
		this.emitter.fire();
		return session;
	}

	/**
	 * 按指纹找回会话。
	 *
	 * 用于响应阶段：模型上带的指纹能唯一定位它当初属于哪个目标。
	 * 找不到说明配置在对话期间被改过（旧会话已被重建）。
	 */
	find(key: string): ProviderSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.target.key === key) {
				return session;
			}
		}
		return undefined;
	}

	/** 当前所有会话，按组名排序。 */
	list(): readonly ProviderSession[] {
		return [...this.sessions.values()].sort((a, b) =>
			(a.target.group ?? '').localeCompare(b.target.group ?? ''));
	}

	/**
	 * 丢弃会话。
	 *
	 * 用于「模型过滤设置变更」这类需要让缓存失效的场景：会话被释放后，
	 * 下一次模型发现会按新设置重新创建。
	 */
	invalidate(): void {
		if (this.sessions.size === 0) {
			return;
		}
		for (const session of this.sessions.values()) {
			this.release(session);
		}
		this.sessions.clear();
		this.emitter.fire();
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) {
			this.release(session);
		}
		this.sessions.clear();
		this.emitter.dispose();
	}

	/* ---------------------------------------------------------------------- */

	/** 组装一个会话。 */
	private create(target: ProviderTarget): ProviderSession {
		const requests = this.deps.getRequestSettings();
		const logger = this.deps.logger;
		const client = new NewApiClient({
			baseUrl: target.baseUrl,
			apiKey: target.apiKey,
			timeoutMs: requests.timeoutMs,
			maxRetries: requests.maxRetries,
			logger: logger.child(`client:${target.group ?? 'default'}`),
		});
		const catalog = new ModelCatalog({
			logger: logger.child(`catalog:${target.group ?? 'default'}`),
			// 用闭包固定这个会话自己的 client：配置变化时整个会话会被重建，
			// 因此这里不需要（也不应该）再去读全局的最新实例。
			getClient: () => client,
			getSettings: () => this.deps.getModelSettings(),
		});
		const catalogListener = catalog.onDidChange(() => this.emitter.fire());

		return {
			target,
			client,
			catalog,
			dispose: () => {
				catalogListener.dispose();
				catalog.dispose();
				client.dispose();
			},
		};
	}

	/** 释放会话，单个失败不影响其它。 */
	private release(session: ProviderSession): void {
		try {
			session.dispose();
		} catch (error) {
			this.deps.logger.error(`释放会话失败：${session.target.label}`, error);
		}
	}
}
