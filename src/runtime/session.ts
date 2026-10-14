/**
 * 会话注册表：把「连接目标」映射到一整套运行时对象（client + 模型目录）。
 *
 * 每个配置组可以指向不同的站点、用不同的密钥，因此 client 与模型缓存不全局共用，
 * 也不每次新建；这里按目标维护一份会话：会话签名没变就复用，变了就重建。
 *
 * 签名包含目标指纹与 client 的构造参数（超时、重试、是否要用量）。
 *
 * 重建与「模型设置变化」走两条不同的路：
 *
 * - 只是模型设置变了 → {@link SessionRegistry.invalidateCatalogs}：丢缓存，client 不动；
 * - 连接身份变了 → 旧会话优雅退役：不再接新请求，等在途请求跑完再释放。
 *
 * 两条路都不中断在途请求。
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
	/** 本会话的签名；不一致说明 client 的构造参数变了 */
	readonly signature: string;
	/** 丢弃模型缓存，保留 client（模型设置变化时用） */
	invalidateCatalog(): void;
	/** 优雅退役：不再接新请求，等在途请求结束后释放 */
	retire(): void;
	/** 立即释放（扩展停用时用） */
	dispose(): void;
}

/** 会话注册表的依赖。 */
export interface SessionRegistryDeps {
	readonly logger: Logger;
	/** 取模型共享设置（缓存有效期与未知模型的兜底值） */
	getModelSettings(): ModelSettings;
	/** 取请求设置（超时、重试） */
	getRequestSettings(): RequestSettings;
}

/** 按目标缓存会话；槽位即组名，同一槽位只保留一个会话。 */
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
	 * 签名（目标指纹 + client 构造参数）不同才视为「换了目标」，会重建会话。
	 */
	resolve(target: ProviderTarget): ProviderSession {
		if (this.disposed) {
			throw new Error('SessionRegistry 已释放');
		}
		const slot = target.group ?? '';
		const signature = sessionSignature(target, this.deps.getRequestSettings());
		const existing = this.sessions.get(slot);
		if (existing !== undefined) {
			if (existing.signature === signature) {
				return existing;
			}
			this.deps.logger.info(`连接设置已变化，重建会话：${target.label}`);
			this.retire(existing);
		}

		const session = this.create(target, signature);
		this.sessions.set(slot, session);
		this.deps.logger.debug(`创建会话：${target.label}（${target.baseUrl || '地址未配置'}）`);
		// 新增会话意味着可用模型集合可能变化
		this.emitter.fire();
		return session;
	}

	/**
	 * 按指纹找回会话；用于响应阶段，模型上带的指纹定位它当初属于哪个目标。
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
	 * 让所有会话的模型缓存失效，保留 client（重建会话会释放 client 并中断在途请求）。
	 */
	invalidateCatalogs(): void {
		if (this.sessions.size === 0) {
			return;
		}
		for (const session of this.sessions.values()) {
			session.invalidateCatalog();
		}
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
	private create(target: ProviderTarget, signature: string): ProviderSession {
		const requests = this.deps.getRequestSettings();
		const logger = this.deps.logger;
		const client = new NewApiClient({
			baseUrl: target.baseUrl,
			apiKey: target.apiKey,
			timeoutMs: requests.timeoutMs,
			streamIdleTimeoutMs: requests.streamIdleTimeoutMs,
			includeUsage: requests.includeUsage,
			maxRetries: requests.maxRetries,
			logger: logger.child(`client:${target.group ?? 'default'}`),
		});
		const catalog = new ModelCatalog({
			logger: logger.child(`catalog:${target.group ?? 'default'}`),
			// 用闭包固定本会话的 client：配置变化时整个会话会被重建
			getClient: () => client,
			getSettings: () => this.deps.getModelSettings(),
		});
		const catalogListener = catalog.onDidChange(() => this.emitter.fire());

		return {
			target,
			client,
			catalog,
			signature,
			invalidateCatalog: () => catalog.invalidate(),
			// 优雅退役：client 停止接新请求，等在途请求结束再中断
			retire: () => {
				catalogListener.dispose();
				catalog.dispose();
				client.retire();
			},
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

	/** 优雅退役会话，单个失败不影响其它。 */
	private retire(session: ProviderSession): void {
		try {
			session.retire();
		} catch (error) {
			this.deps.logger.error(`退役会话失败：${session.target.label}`, error);
		}
	}
}

/**
 * 会话签名：只包含 client 构造用到的参数——`target.key`（站点地址 + 密钥的指纹）与
 * 请求侧的超时/重试/用量开关；签名相同即可复用 client。
 */
function sessionSignature(target: ProviderTarget, requests: RequestSettings): string {
	return [
		target.key,
		requests.timeoutMs,
		requests.streamIdleTimeoutMs,
		requests.includeUsage ? 'usage' : 'no-usage',
		requests.maxRetries,
	].join('\u0000');
}
