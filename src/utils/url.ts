/** Site-root normalization shared by configuration validation and transport. */
export function normalizeBaseUrl(raw: string | undefined): string {
	return (raw ?? '').trim().replace(/\/+$/, '').replace(/\/(v1\/)?chat\/completions$/i, '')
		.replace(/\/v1$/i, '').replace(/\/+$/, '');
}
export function isValidBaseUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:';
	} catch { return false; }
}
