/**
 * 响应部件的中立形状：流式翻译层的输出契约。
 *
 * 翻译层只产出这三种部件，翻成宿主认的响应部件是上报层（`streamFlow.ts`）的事。
 * 这样安排有两个理由：
 *
 * - 翻译层（chunk 归并、思维链、工具调用分片、引用块排版）是最容易出错的一层，中立之后
 *   不再需要 VS Code 宿主就能测；
 * - 响应怎么渲染、怎么发给宿主，是可以整层替换的：换渲染方式只动上报层。
 *
 * 刻意不做成「一个部件一个类」：这里的三种形状互不重叠，判别式联合让上报层的一处
 * `switch` 就能穷尽，新增一种部件时类型检查会指出所有需要处理的地方。
 */

/** 一个响应部件。 */
export type ResponsePart =
	/** 正式回答的正文 */
	| { readonly kind: 'text'; readonly text: string }
	/** 思维链；宿主有专用思考部件时用它渲染 */
	| { readonly kind: 'reasoning'; readonly text: string }
	/** 一次工具调用 */
	| {
		readonly kind: 'toolCall';
		readonly callId: string;
		readonly name: string;
		readonly input: object;
	};

/** 接收中立部件的回调。 */
export type ResponsePartSink = (part: ResponsePart) => void;
