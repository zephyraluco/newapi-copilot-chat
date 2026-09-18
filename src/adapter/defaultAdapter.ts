/**
 * 默认适配器：恒等变换。
 *
 * 它是「兜底」也是「模板」——所有模型在没有更专门的适配器时都会走到这里，
 * 而新增适配器可以直接对照本文件的结构来写（供应商适配器放在 `adapter/<supplier>/` 下）。
 * 它不是供应商适配器，因此留在本层而不进子目录。
 *
 * `transformRequest` **刻意不实现**：没定义时 provider 会直接透传，效果就是恒等变换。
 * 保留空实现反而会多出一次无意义的函数调用。
 */

import type { ModelAdapter } from './adapter';

/** 不做任何改写的适配器。 */
export class DefaultModelAdapter implements ModelAdapter {
	readonly id = 'default';
	readonly description = '默认适配器：不加改写，原样透传请求';
	readonly priority = -100;

	/** 承接所有模型，因此它必须排在最后。 */
	supports(): boolean {
		return true;
	}
}
