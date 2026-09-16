/**
 * 默认适配器：恒等变换。
 *
 * 它是「兜底」也是「模板」——所有模型在没有更专门的适配器时都会走到这里，
 * 而新增适配器可以直接对照本文件的结构来写。
 *
 * 三个钩子**刻意不实现**：钩子未定义时 provider 会直接透传，效果就是恒等变换。
 * 保留空实现反而会多出几次无意义的函数调用与拷贝。
 */

import type { ModelAdapter } from './adapter';

/** 不做任何改写的适配器。 */
export class DefaultModelAdapter implements ModelAdapter {
	readonly id = 'default';
	readonly description = '默认适配器：不加改写，原样透传请求与响应';
	readonly priority = -100;

	/** 承接所有模型，因此它必须排在最后。 */
	supports(): boolean {
		return true;
	}

	/*
	 * 各钩子的典型用途（新增适配器时可对照）：
	 *
	 * transformRequest
	 *   - 推理模型不接受 temperature，需要删除该字段；
	 *   - 把 max_tokens 改写成 max_completion_tokens（o 系列只认后者）；
	 *   - 补上网关专属的思考开关（enable_thinking / reasoning_effort 等）。
	 *
	 * transformChunk
	 *   - 统一 reasoning_content 与 reasoning 两种思维链字段名；
	 *   - 合并分片到达、且顺序不保证的工具调用参数。
	 *
	 * finalize
	 *   - 冲刷适配器内部缓冲的内容（例如把多段 <thinking> 标签合并后再输出）。
	 */
}
