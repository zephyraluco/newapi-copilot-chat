/**
 * 思维链字段的读写。
 *
 * 「思维链」不是 OpenAI 协议的一部分，各家网关给它起的名字不一样：DeepSeek 系用
 * `reasoning_content`，OpenRouter 系用 `reasoning`。这是通用层唯一需要知道这些名字的地方，
 * 换字段名只需改这一张表。
 *
 * 需要更彻底的改写（例如把思维链塞进别的结构）由适配器负责。
 */

/**
 * 读思维链时依次尝试的字段名。`reasoning_content` 更常见，且当两者都存在时更可信。
 */
export const REASONING_TEXT_FIELDS: readonly string[] = ['reasoning_content', 'reasoning'];

/**
 * 回填历史时写回的字段名。取 OpenAI 兼容网关里的通用叫法，
 * 别家要换名字由适配器在 `transformRequest` 里改写。
 */
export const REASONING_ECHO_FIELD = 'reasoning_content';

/**
 * 上游要求回填思考内容、而我们手上没有原文时写进 `reasoning_content` 的占位。
 *
 * 要求回填的上游（DeepSeek 思考态）把字段缺席当成协议错误。拿不到原文的情形真实存在：
 * 宿主自己插入的工具调用、重启后不再带回思考内容的历史。
 *
 * 取值是一个空格：满足「字段在且非空」的校验，又不会把编造的思维链喂给模型。
 */
export const REASONING_PLACEHOLDER = ' ';

/**
 * 从任意对象（流式 chunk 的 `delta`、非流式响应的 `message`）里读出思维链文本。
 * 空字符串按「没有思维链」处理。
 */
export function readReasoningText(source: unknown): string | undefined {
	if (source === null || source === undefined || typeof source !== 'object') {
		return undefined;
	}
	const record = source as Record<string, unknown>;
	for (const field of REASONING_TEXT_FIELDS) {
		const value = record[field];
		if (typeof value === 'string' && value.length > 0) {
			return value;
		}
	}
	return undefined;
}
