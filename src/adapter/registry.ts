/**
 * 适配器注册表：保存已注册的适配器，并按模型解析出应该用哪一个。
 * provider 只与这里交互，新增适配器不会波及 provider。
 */

import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ModelAdapter } from './adapter';
import { DefaultModelAdapter } from './defaultAdapter';
import { DeepSeekAdapter } from './deepseek/deepseekAdapter';

/** 适配器注册表。 */
export class AdapterRegistry {
	private readonly adapters: ModelAdapter[] = [];

	/**
	 * 注册适配器。
	 *
	 * 重复注册同一个 id 会被忽略并留下警告——通常是复制粘贴代码时忘了改 id，
	 * 静默覆盖会让「为什么适配器没生效」变得难查。
	 */
	register(adapter: ModelAdapter, logger?: Logger): void {
		if (this.adapters.some(item => item.id === adapter.id)) {
			logger?.warn(`适配器 ${adapter.id} 已存在，跳过重复注册`);
			return;
		}
		this.adapters.push(adapter);
		// 高优先级在前，保证 resolve 取到第一个匹配项
		this.adapters.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/**
	 * 解析模型应使用的适配器。
	 *
	 * 永远返回一个适配器：`DefaultModelAdapter` 承接所有模型。
	 */
	resolve(model: ModelConfig): ModelAdapter {
		const matched = this.adapters.find(adapter => adapter.supports(model));
		if (matched !== undefined) {
			return matched;
		}
		// 理论上不可达（默认适配器 supports 恒为 true），保底再实例化一个
		return new DefaultModelAdapter();
	}

	/** 所有已注册的适配器（按优先级排序），面板会展示它。 */
	list(): readonly ModelAdapter[] {
		return this.adapters;
	}
}

/**
 * 创建内置默认配置的注册表。
 *
 * 供应商适配器各自放在以供应商命名的子目录里（例如 `deepseek/`），目录内的文件只服务该供应商；
 * `defaultAdapter` 不是供应商，作为兑底与模板留在本层。高优先级在前，因此专门适配器写在兜底之前。
 */
export function createDefaultAdapterRegistry(logger?: Logger): AdapterRegistry {
	const registry = new AdapterRegistry();

	registry.register(new DeepSeekAdapter(), logger);
	registry.register(new DefaultModelAdapter(), logger);

	return registry;
}
