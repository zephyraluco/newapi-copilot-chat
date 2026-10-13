/**
 * 适配器注册表：保存已注册的适配器，并按模型解析出应该用哪一个。
 * provider 只与这里交互，新增适配器不会波及 provider。
 */

import type { Logger } from '../logger';
import type { ModelConfig } from '../models/modelConfig';
import type { ModelAdapter } from './adapter';
import { ModelCapabilityAdapter } from './capabilityAdapter';
import { DefaultModelAdapter } from './defaultAdapter';
import { DeepSeekAdapter } from './deepseek/deepseekAdapter';
import { OpenAIReasoningAdapter } from './openai/openaiReasoningAdapter';

/** 适配器注册表。 */
export class AdapterRegistry {
	private readonly adapters: ModelAdapter[] = [];
	/** 谁都没命中时的兜底（正常路径上 `DefaultModelAdapter` 已在表内） */
	private readonly fallback = new DefaultModelAdapter();

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
		// 高优先级在前，保证 resolveAll 的顺序稳定
		this.adapters.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
	}

	/**
	 * 解析模型应使用的**全部**适配器，按 `priority` 从高到低。
	 *
	 * 返回全部命中项而不是第一个：差异是按「一个协议特性」拆的（推理模型不收采样参数、
	 * 某类模型带工具时只能用某个思考强度…），一个模型常常同时命中多条。只取第一条会逼着
	 * 每个适配器把别的适配器已经写过的逻辑再抄一遍——那正是「逐模型名特判」的温床。
	 *
	 * 永远返回非空数组：`DefaultModelAdapter` 承接所有模型。
	 */
	resolveAll(model: ModelConfig): readonly ModelAdapter[] {
		const matched = this.adapters.filter(adapter => adapter.supports(model));
		return matched.length > 0 ? matched : [this.fallback];
	}

	/** 所有已注册的适配器（按优先级排序） */
	list(): readonly ModelAdapter[] {
		return this.adapters;
	}
}

/**
 * 创建内置默认配置的注册表。
 *
 * 供应商适配器各自放在以供应商命名的子目录里（例如 `deepseek/`），目录内的文件只服务该供应商；
 * `capabilityAdapter` / `defaultAdapter` 不是供应商，作为框架层留在本目录。高优先级在前，
 * 因此专门适配器写在兜底之前。
 */
export function createDefaultAdapterRegistry(logger?: Logger): AdapterRegistry {
	const registry = new AdapterRegistry();

	registry.register(new DeepSeekAdapter(), logger);
	registry.register(new OpenAIReasoningAdapter(), logger);
	// 数据驱动的能力位：优先级低于供应商适配器，因此它看到的是那些适配器改写之后的请求
	registry.register(new ModelCapabilityAdapter(), logger);
	registry.register(new DefaultModelAdapter(), logger);

	return registry;
}
