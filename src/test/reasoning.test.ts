import * as assert from 'assert';
import { REASONING_ECHO_FIELD, REASONING_TEXT_FIELDS, readReasoningText } from '../reasoning';

/**
 * 思维链字段读取的测试。
 *
 * 这是通用层唯一知道「各家把思维链放在哪个字段」的地方，因此这里要钉住两件事：
 * **容忍多种字段名**（上游换名字不该让思维链消失），以及**安静地退化成空**
 * （上游没给、给了空串、给了别的类型都不能让调用方拿到假内容）。
 */

suite('推理 / 思维链字段读取', () => {
	test('两种已知字段名都能读到', () => {
		assert.strictEqual(readReasoningText({ reasoning_content: 'a' }), 'a');
		assert.strictEqual(readReasoningText({ reasoning: 'b' }), 'b');
	});

	test('两者同时存在时取更常见的 reasoning_content', () => {
		assert.strictEqual(
			readReasoningText({ reasoning_content: '首选', reasoning: '次选' }),
			'首选',
		);
	});

	test('容忍字段名列表是可导出的，便于新增名字时只改一处', () => {
		assert.ok(REASONING_TEXT_FIELDS.includes(REASONING_ECHO_FIELD));
	});

	test('空串与非法类型按「没有思维链」处理', () => {
		assert.strictEqual(readReasoningText({ reasoning_content: '' }), undefined, '每个 chunk 都带空字段很常见');
		assert.strictEqual(readReasoningText({ reasoning_content: 42 }), undefined);
		assert.strictEqual(readReasoningText({ reasoning_content: null }), undefined);
		assert.strictEqual(readReasoningText({ reasoning_content: ['a'] }), undefined);
		assert.strictEqual(readReasoningText({}), undefined);
	});

	test('非对象输入直接返回 undefined', () => {
		for (const value of [undefined, null, 'string', 42, true]) {
			assert.strictEqual(readReasoningText(value), undefined, String(value));
		}
	});
});
