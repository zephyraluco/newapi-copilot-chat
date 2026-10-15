import { TOKEN_ESTIMATION } from '../shared/consts';
import type { Message, MessagePart } from '../shared/messages';
import { safeJsonStringify } from '../shared/json';

const CJK_PATTERN = /[\u2e80-\u303f\u3040-\u30ff\u31c0-\u31ef\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/g;
export interface RequestTextMeasure { readonly cjkChars: number; readonly otherChars: number }
export function splitCjkChars(text: string): RequestTextMeasure {
	const cjkChars = text.match(CJK_PATTERN)?.length ?? 0;
	return { cjkChars, otherChars: text.length - cjkChars };
}
export function estimateTextTokens(text: string, charsPerToken: number = TOKEN_ESTIMATION.charsPerToken): number {
	const { cjkChars, otherChars } = splitCjkChars(text);
	return cjkChars + Math.ceil(otherChars / charsPerToken);
}
export function calibrateCharsPerToken(measure: RequestTextMeasure, promptTokens: number | undefined,
	current: number = TOKEN_ESTIMATION.charsPerToken): number {
	if (promptTokens === undefined || promptTokens <= measure.cjkChars || measure.otherChars <= 0) { return current; }
	const clamp = (value: number) => Math.min(16, Math.max(1, value));
	return clamp(current * 0.7 + clamp(measure.otherChars / (promptTokens - measure.cjkChars)) * 0.3);
}
export function estimateMessageTokens(message: Message, ratio: number = TOKEN_ESTIMATION.charsPerToken): number {
	let thinking = '';
	let replay: string | undefined;
	const count = (parts: readonly MessagePart[]): number => parts.reduce((total, part) => {
		switch (part.kind) {
			case 'text': return total + estimateTextTokens(part.text, ratio);
			case 'thinking': thinking += part.text; return total;
			case 'replay': replay ??= part.text; return total;
			case 'image': return total + TOKEN_ESTIMATION.imageOverhead;
			case 'call': return total + estimateTextTokens(part.name, ratio) + estimateTextTokens(safeJsonStringify(part.input) ?? '', ratio);
			case 'result': return total + count(part.parts);
			default: return total;
		}
	}, 0);
	const content = count(message.parts);
	return TOKEN_ESTIMATION.messageOverhead + content + estimateTextTokens(replay ?? thinking, ratio);
}
