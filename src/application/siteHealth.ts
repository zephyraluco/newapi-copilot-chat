import { EventEmitter } from '../shared/event';
import type { Logger } from '../shared/log';
import { describeError, type SiteProbeResult } from '../transport/newApiClient';
import type { SessionRegistry } from './session';
import { isTargetUsable } from './target';

export interface SiteHealth extends SiteProbeResult {
	readonly checkedAt: number;
	readonly latencyMs: number;
}
type SiteSession = ReturnType<SessionRegistry['list']>[number];
interface ProbeTask {
	readonly client: SiteSession['client'];
	readonly controller: AbortController;
	readonly promise: Promise<void>;
}

/** Periodic site probes only. Model discovery and its cache are never touched here. */
export class SiteHealthService {
	private readonly emitter = new EventEmitter<void>();
	private readonly listener: { dispose(): void };
	private readonly results = new Map<string, SiteHealth>();
	private readonly clients = new Map<string, SiteSession['client']>();
	private readonly tasks = new Map<string, ProbeTask>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private intervalMs: number | undefined;
	private started = false;
	private disposed = false;
	readonly onDidChange = this.emitter.event;

	constructor(private readonly sessions: Pick<SessionRegistry, 'list' | 'onDidChange'>, private readonly logger: Logger) {
		this.listener = sessions.onDidChange(() => {
			if (!this.started || this.disposed) { return; }
			for (const session of this.reconcile().added) { void this.probe(session); }
		});
	}

	get snapshot(): ReadonlyMap<string, SiteHealth> { return new Map(this.results); }

	start(intervalMs: number): void {
		if (this.started || this.disposed) { return; }
		this.started = true;
		this.configure(intervalMs);
		void this.refresh();
	}

	configure(intervalMs: number): void {
		if (!this.started || this.disposed || this.intervalMs === intervalMs) { return; }
		if (this.timer !== undefined) { clearInterval(this.timer); }
		this.intervalMs = intervalMs;
		this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
	}

	async refresh(): Promise<void> {
		if (!this.started || this.disposed) { return; }
		await Promise.all(this.reconcile().active.map(session => this.probe(session)));
	}

	private reconcile(): { active: readonly SiteSession[]; added: readonly SiteSession[] } {
		const active = this.sessions.list().filter(session => isTargetUsable(session.target));
		const current = new Map(active.map(session => [session.target.key, session.client]));
		let changed = false;
		for (const [key, client] of this.clients) {
			if (current.get(key) !== client) {
				this.tasks.get(key)?.controller.abort();
				this.tasks.delete(key);
				this.results.delete(key);
				this.clients.delete(key);
				changed = true;
			}
		}
		const added = active.filter(session => this.clients.get(session.target.key) !== session.client);
		for (const session of added) { this.clients.set(session.target.key, session.client); }
		if (changed || added.length) { this.emitter.fire(); }
		return { active, added };
	}

	private probe(session: SiteSession): Promise<void> {
		const key = session.target.key;
		const existing = this.tasks.get(key);
		if (existing?.client === session.client) { return existing.promise; }
		const controller = new AbortController();
		const startedAt = Date.now();
		const report = (result: SiteProbeResult): void => {
			if (this.disposed || controller.signal.aborted || this.clients.get(key) !== session.client) { return; }
			const previous = this.results.get(key);
			if (!result.available && (previous?.available !== false || previous.reason !== result.reason)) {
				this.logger.warn(`站点探活失败：${session.target.label}：${result.reason ?? '未知原因'}`);
			}
			this.results.set(key, { ...result, checkedAt: Date.now(), latencyMs: Date.now() - startedAt });
			this.emitter.fire();
		};
		const promise = Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return session.client.getStatus(controller.signal);
		}).then(report, error => report({ available: false, reason: describeError(error) }))
			.finally(() => {
				if (this.tasks.get(key)?.controller === controller) { this.tasks.delete(key); }
			});
		this.tasks.set(key, { client: session.client, controller, promise });
		return promise;
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== undefined) { clearInterval(this.timer); }
		for (const task of this.tasks.values()) { task.controller.abort(); }
		this.tasks.clear();
		this.clients.clear();
		this.results.clear();
		this.listener.dispose();
		this.emitter.dispose();
	}
}
