/**
 * 思维链字段的读写。
 *
 * 「思维链」不是 OpenAI 协议的一部分，各家网关给它起的名字不一样：DeepSeek 系用
 * `reasoning_content`，OpenRouter 系用 `reasoning`，还会有新的名字出现。
 *
 * 这是**通用层唯一**需要知道这些名字的地方：其余代码只调这里的函数，
 * 于是「上游换了个字段名」只需要改这一张表，而不用在流式解析、非流式兜底、
 * 历史回填三个地方各改一遍。
 *
 * 需要更彻底的改写（例如把思维链塞进别的结构）时，那是适配器的活：
 * 它拿到的是完整请求体 / 完整 chunk，可以任意改写。
 */

/**
 * 读思维链时依次尝试的字段名。
 *
 * 顺序有意义：`reasoning_content` 更常见，且当两者都存在时它是更可信的那个。
 */
export const REASONING_TEXT_FIELDS: readonly string[] = ['reasoning_content', 'reasoning'];

/**
 * 回填历史时写回的字段名。
 *
 * 取 OpenAI 兼容网关里的通用叫法（也是 `ChatRequestMessage` 里唯一声明的那个）。
 * 别家要换名字，由适配器在 `transformRequest` 里改写。
 */
export const REASONING_ECHO_FIELD = 'reasoning_content';

/**
 * 上游要求回填思考内容、而我们手上没有原文时写进 `reasoning_content` 的占位。
 *
 * 要求回填的上游（DeepSeek 思考态）把字段**缺席**当成协议错误，整次请求都会被拒；
 * 拿不到原文的情形是真实存在的——宿主自己插入的工具调用（例如读取后台终端输出）、
 * 重启后不再带回思考内容的历史，都不是模型想出来的，谁也没法回填。
 *
 * 取值是一个空格：既满足「字段在且非空」的校验（空字符串不满足，DeepSeek V4 之后收紧了这一条），
 * 又不会把一段编造的思维链喂给模型。这里刻意不用可读的哨兵文案——模型看到什么就可能跟着说什么，
 * 让它出现在思考块或正文里比空格糟得多。
 */
export const REASONING_PLACEHOLDER = ' ';

/**
 * 从任意对象（流式 chunk 的 `delta`、非流式响应的 `message`）里读出思维链文本。
 *
 * 空字符串按「没有思维链」处理：上游有时会为每个 chunk 都带一个空字段，
 * 当成内容会让下游累积出一堆空片段。
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
