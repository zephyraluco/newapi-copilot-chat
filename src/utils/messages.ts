/** Host-independent message parts. Image bytes are encoded only when constructing a request. */
export type MessagePart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'thinking'; readonly text: string }
	| { readonly kind: 'replay'; readonly text?: string }
	| { readonly kind: 'image'; readonly mimeType: string; readonly data: Uint8Array }
	| { readonly kind: 'emptyImage' }
	| { readonly kind: 'call'; readonly callId: string; readonly name: string; readonly input: unknown }
	| { readonly kind: 'result'; readonly callId: string; readonly parts: readonly MessagePart[] };
export interface Message {
	readonly role: 'user' | 'assistant';
	readonly name?: string;
	readonly parts: readonly MessagePart[];
}
