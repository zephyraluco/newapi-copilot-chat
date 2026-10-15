/** Synchronous application event source, independent of VS Code. */
export class EventEmitter<T> {
	private readonly listeners = new Set<(value: T) => void>();
	readonly event = (listener: (value: T) => void): { dispose(): void } => {
		this.listeners.add(listener);
		return { dispose: () => { this.listeners.delete(listener); } };
	};
	fire(value: T): void {
		for (const listener of [...this.listeners]) { listener(value); }
	}
	dispose(): void { this.listeners.clear(); }
}
