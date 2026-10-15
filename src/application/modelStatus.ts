import type { ModelCatalogSnapshot } from './catalog';
import type { ProviderTarget } from './target';

export interface TargetModelStatus {
	readonly key: string;
	readonly label: string;
	readonly count: number;
	readonly error?: string;
	readonly hint?: string;
}
export interface ModelStatus {
	readonly targets: readonly TargetModelStatus[];
	readonly totalModels: number;
}

/** Read existing discovery results only. Rendering status never starts network requests. */
export function readModelStatus(sessions: readonly {
	readonly target: Pick<ProviderTarget, 'key' | 'label' | 'issues'>;
	readonly catalog: { readonly current?: ModelCatalogSnapshot };
}[]): ModelStatus {
	const targets = sessions.map(({ target, catalog }) => ({
		key: target.key,
		label: target.label,
		count: catalog.current?.models.length ?? 0,
		error: target.issues.length ? target.issues.join('；') : catalog.current?.error,
		hint: target.issues.length ? undefined : catalog.current?.hint,
	}));
	return { targets, totalModels: targets.reduce((sum, target) => sum + target.count, 0) };
}
