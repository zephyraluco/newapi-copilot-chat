import * as assert from 'assert';
import * as vscode from 'vscode';
import {
	REPLAY_MARKER_MIME,
	REPLAY_MARKER_WRITER_ID,
	createReplayMarkerPart,
	isReplayMarkerPart,
	parseReplayMarker,
	readReplayedReasoning,
} from '../provider/replay';

/**
 * 回放标记的测试。
 *
 * 标记是「思考内容」唯一的回程工具（宿主不会把思考内容放回历史里），它坏掉的症状是
 * **静默**的：下次请求少了 `reasoning_content`，DeepSeek 直接拒掉整次请求。因此这里把
 * 「自产自销能原样读回」和「任何异常输入都退化成没有标记」都钉住。
 */

const WRITER = REPLAY_MARKER_WRITER_ID;

/** 直接按载荷文本造一个标记部件。 */
function markerPart(payload: string): vscode.LanguageModelDataPart {
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(payload), REPLAY_MARKER_MIME);
}

/** 造一条助手消息。 */
function assistantMessage(content: readonly unknown[]): vscode.LanguageModelChatRequestMessage {
	return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined };
}

suite('provider / 思考内容回放标记', () => {
	test('写出的标记能原样读回', () => {
		const part = createReplayMarkerPart('先看看调用链，再决定改哪里');

		assert.strictEqual(part.mimeType, REPLAY_MARKER_MIME);
		assert.ok(isReplayMarkerPart(part));
		assert.strictEqual(parseReplayMarker(part.data), '先看看调用链，再决定改哪里');
	});

	test('标记里的非 ASCII 文本与特殊字符不会被破坏', () => {
		// base64url 编码的目的就是让载荷永远是可打印 ASCII：换行、反引号、`\` 都不该出问题
		const text = '第一行\n第二行 `code` \\ 反斜杠 \u0000 与 emoji 🧠';
		assert.strictEqual(parseReplayMarker(createReplayMarkerPart(text).data), text);
	});

	test('从消息里取出回放的思考文本（与正文、工具调用混在一起也能找到）', () => {
		const message = assistantMessage([
			new vscode.LanguageModelTextPart('正文'),
			new vscode.LanguageModelToolCallPart('call_1', 'read_file', {}),
			createReplayMarkerPart('思考内容'),
		]);

		assert.strictEqual(readReplayedReasoning(message), '思考内容');
	});

	test('没有标记时返回 undefined', () => {
		const message = assistantMessage([new vscode.LanguageModelTextPart('正文')]);
		assert.strictEqual(readReplayedReasoning(message), undefined);
	});

	test('其它扩展写的标记（前缀不符）不认', () => {
		const payload = `other-extension\\json:${Buffer.from('{"reasoning":{"text":"x"}}').toString('base64url')}`;
		assert.strictEqual(parseReplayMarker(markerPart(payload).data), undefined);
	});

	test('前缀不符、缺分隔符、缺编码前缀、base64 非法都退回「没有标记」', () => {
		const json = Buffer.from('{"reasoning":{"text":"x"}}').toString('base64url');
		assert.strictEqual(parseReplayMarker(markerPart(`${WRITER}${json}`).data), undefined, '缺分隔符');
		assert.strictEqual(parseReplayMarker(markerPart(`${WRITER}\\${json}`).data), undefined, '缺 json: 前缀');
		assert.strictEqual(parseReplayMarker(markerPart(`${WRITER}\\json:`).data), undefined, '载荷为空');
		assert.strictEqual(parseReplayMarker(markerPart(`${WRITER}\\json:not base64!`).data), undefined, 'base64 非法');
	});

	test('载荷不是预期的 JSON 形状时返回 undefined', () => {
		const encode = (value: unknown): string =>
			`${WRITER}\\json:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`;

		assert.strictEqual(parseReplayMarker(markerPart(encode([])).data), undefined, '不是对象');
		assert.strictEqual(parseReplayMarker(markerPart(encode({})).data), undefined, '没有 reasoning');
		assert.strictEqual(parseReplayMarker(markerPart(encode({ reasoning: {} })).data), undefined, '没有 text');
		assert.strictEqual(
			parseReplayMarker(markerPart(encode({ reasoning: { text: 42 } })).data),
			undefined,
			'text 不是字符串',
		);
		assert.strictEqual(
			parseReplayMarker(markerPart(encode({ reasoning: { text: '' } })).data),
			undefined,
			'空文本按「没有思考内容」处理',
		);
	});

	test('mimeType 相同但内容不是本扩展写的，不算标记部件', () => {
		const part = new vscode.LanguageModelDataPart(new TextEncoder().encode('随便什么'), 'other_mime');
		assert.strictEqual(isReplayMarkerPart(part), false);
	});
});
