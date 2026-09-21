import * as assert from 'assert';
import { DEFAULT_REASONING_EFFORT_FIELD } from '../consts';
import { planRequestRepair } from '../provider/requestRepair';
import type { ChatCompletionRequest, ChatToolDefinition } from '../types';

/**
 * 400 自愈阶梯的测试。
 *
 * 这一层的风险不在「改不动」，而在**改错**：多删一个字段会让请求变成另一种意思，
 * 或者在服务器没给线索时凭空猜测。因此用例集中在两件事上——该改的改对了、
 * 不该改的一律返回「不修」。
 */

/** 一条最简请求：只有协议骨架。 */
function request(patch: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
	return {
		model: 'test-model',
		messages: [{ role: 'user', content: 'hi' }],
		...patch,
	};
}

const TOOLS: ChatToolDefinition[] = [{ type: 'function', function: { name: 'read_file' } }];

/** 一次「站点拒绝并说明原因」的输入。 */
function reject(
	body: string,
	input: { request?: ChatCompletionRequest; tried?: string[]; sendsStreamOptions?: boolean } = {},
) {
	return planRequestRepair({
		status: 400,
		responseBody: body,
		apiMessage: body,
		request: input.request ?? request(),
		sendsStreamOptions: input.sendsStreamOptions ?? true,
		tried: input.tried ?? [],
	});
}

suite('provider / 400 自愈阶梯', () => {
	test('非 400 一律不修：去掉字段救不回鉴权与限流', () => {
		for (const status of [401, 403, 404, 429, 500]) {
			const plan = planRequestRepair({
				status,
				responseBody: 'unknown field: stream_options',
				apiMessage: undefined,
				request: request(),
				sendsStreamOptions: true,
				tried: [],
			});
			assert.strictEqual(plan, undefined, `status=${status} 不该触发自愈`);
		}
	});

	test('服务器什么都没说时不猜', () => {
		assert.strictEqual(planRequestRepair({
			status: 400,
			responseBody: undefined,
			apiMessage: undefined,
			request: request({ temperature: 0.2 }),
			sendsStreamOptions: true,
			tried: [],
		}), undefined);
		assert.strictEqual(reject('   '), undefined);
	});

	test('站点抱怨 stream_options 时，改为不要求上游返回用量', () => {
		const plan = reject('{"error":{"message":"unknown field: stream_options","type":"invalid_request_error"}}');

		assert.strictEqual(plan?.id, 'stream_options');
		assert.strictEqual(plan?.includeUsage, false, '要去掉的是客户端加的那个字段');
		assert.deepStrictEqual(plan?.request, request(), '请求体本身不需要改');
	});

	test('请求本来就没带 stream_options 时不给这条计划', () => {
		const plan = reject('unknown field: stream_options', { sendsStreamOptions: false });
		assert.strictEqual(plan, undefined, '没带过就没什么可去掉的，重试只会白花一次请求');
	});

	test('点名了具体参数时只去掉它自己（不做连带修改）', () => {
		const plan = reject("Unknown parameter: 'temperature'.", {
			request: request({ temperature: 0.2, top_p: 0.9 }),
		});

		assert.strictEqual(plan?.id, 'field:temperature');
		assert.strictEqual('temperature' in (plan?.request ?? {}), false);
		assert.strictEqual(plan?.request.top_p, 0.9, '没被点名的参数不动：站点可能只是不认这一个');
		assert.deepStrictEqual(plan?.request.messages, request().messages);
	});

	test('响应体没说具体是哪个采样参数时，整类一起去掉', () => {
		const plan = reject('invalid_request_error: unsupported sampling temperature', {
			request: request({ temperature: 0.2, top_p: 0.9 }),
		});

		assert.strictEqual(plan?.id, 'sampling');
		assert.strictEqual('temperature' in (plan?.request ?? {}), false);
		assert.strictEqual('top_p' in (plan?.request ?? {}), false);
	});

	test('点名 reasoning_effort 时去掉它（思考强度交给上游默认值）', () => {
		const plan = reject(`Unsupported parameter: ${DEFAULT_REASONING_EFFORT_FIELD}`, {
			request: request({ [DEFAULT_REASONING_EFFORT_FIELD]: 'high' }),
		});

		assert.strictEqual(plan?.id, `field:${DEFAULT_REASONING_EFFORT_FIELD}`);
		assert.strictEqual(DEFAULT_REASONING_EFFORT_FIELD in (plan?.request ?? {}), false);
	});

	test('点名 tool_choice 时只去掉它，工具定义留着', () => {
		const plan = reject("Invalid value for 'tool_choice'", {
			request: request({ tools: TOOLS, tool_choice: 'required' }),
		});

		assert.strictEqual(plan?.id, 'field:tool_choice');
		assert.strictEqual('tool_choice' in (plan?.request ?? {}), false);
		assert.deepStrictEqual(plan?.request.tools, TOOLS, '去掉 tool_choice 不等于放弃工具');
	});

	test('上游点名的自定义字段（extraBody 里那些）会被精确去掉', () => {
		const plan = reject('{"error":"unknown field \\"enable_search\\""}', {
			request: request({ enable_search: true, other_flag: 1 }),
		});

		assert.strictEqual(plan?.id, 'field:enable_search');
		assert.strictEqual('enable_search' in (plan?.request ?? {}), false);
		assert.strictEqual(plan?.request.other_flag, 1, '只去掉被点名的那一个');
	});

	test('协议骨架字段不会被删掉', () => {
		for (const field of ['model', 'messages', 'stream']) {
			const plan = reject(`unknown field: "${field}"`, {
				request: request({ temperature: 1 }),
				sendsStreamOptions: false,
			});
			assert.strictEqual(plan, undefined, `点名 ${field} 时既不能删它，也不该乱改别的字段`);
		}
	});

	test('骨架字段被点名、同时又有可去掉的字段时，动的是后者', () => {
		const plan = reject('invalid request: model unknown field, and temperature is not supported', {
			request: request({ temperature: 0.5 }),
			sendsStreamOptions: false,
		});

		assert.strictEqual(plan?.id, 'sampling');
		assert.strictEqual('temperature' in (plan?.request ?? {}), false);
		assert.strictEqual(plan?.request.model, 'test-model');
		assert.deepStrictEqual(plan?.request.messages, request().messages);
	});

	test('请求里没有那个字段时不返回计划（不能空转）', () => {
		assert.strictEqual(reject('Unknown parameter: `temperature`'), undefined);
		assert.strictEqual(reject('unknown field: enable_search'), undefined);
	});

	test('用过的步骤不会再用第二次', () => {
		// 上一轮去掉 temperature 之后，请求里已经没有它了，因此这一步不再产出计划
		assert.strictEqual(
			reject("Unknown parameter: 'temperature'", { request: request(), tried: ['field:temperature'] }),
			undefined,
		);
		// 不带引号的整类规则同样只走一次
		assert.strictEqual(
			reject('sampling parameters are not supported', {
				request: request({ top_p: 0.9 }),
				tried: ['sampling'],
			}),
			undefined,
		);
		// stream_options 已经去掉过一次就不再重复
		assert.strictEqual(
			reject('unknown field: stream_options', { tried: ['stream_options'] }),
			undefined,
		);
	});

	test('点名了一个我们没加过的字段时，退回内置阶梯', () => {
		// 站点抱怨的是它自己的字段名，与我们无关；但响应体里同时提到了 temperature，
		// 那才是我们加过的东西
		const plan = reject('{"error":"bad request: nope, but temperature is not supported"}', {
			request: request({ temperature: 0.5 }),
		});
		assert.strictEqual(plan?.id, 'sampling');
	});
});
