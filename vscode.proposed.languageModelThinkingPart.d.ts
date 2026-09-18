/*
 * 摘自 VS Code 仓库（src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts），
 * 声明尚未进入 @types/vscode 的 `languageModelThinkingPart` 提案。
 * 该 API 转正后本文件即可删除（同时去掉 package.json 里的 enabledApiProposals）。
 * 更新方式：npx @vscode/dts dev
 */

/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// version: 1

declare module 'vscode' {
	/**
	 * 承载思考（推理）内容的响应部件。思考 token 是模型在给出最终回答之前的内部推理过程，
	 * 通常先于正文流式到达。
	 */
	export class LanguageModelThinkingPart {
		/** 思考文本内容 */
		value: string | string[];

		/** 本次思考序列的可选唯一标识 */
		id?: string;

		/** 与本次思考序列关联的可选元数据 */
		metadata?: { readonly [key: string]: any };

		/**
		 * @param value 思考文本内容
		 * @param id 本次思考序列的可选唯一标识
		 * @param metadata 与本次思考序列关联的可选元数据
		 */
		constructor(value: string | string[], id?: string, metadata?: { readonly [key: string]: any });
	}
}
