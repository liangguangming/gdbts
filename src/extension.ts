/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import * as path from 'path';
import logger from './log'

logger.transports.file.file = path.resolve(__dirname, '../extension.log');
/*
 * Set the following compile time flag to true if the
 * debug adapter should run inside the extension host.
 * Please note: the test suite does no longer work in this mode.
 */

export function activate(context: vscode.ExtensionContext) {
	logger.info('激活插件');
	// register a configuration provider for 'mock' debug type
	const provider = new CConfigurationProvider()
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('c', provider));
	context.subscriptions.push(provider);
}

export function deactivate() {
	// nothing to do
}

class CConfigurationProvider implements vscode.DebugConfigurationProvider {

	/**
	 * Massage a debug configuration just before a debug session is being launched,
	 * e.g. add all missing attributes to the debug configuration.
	 */
	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		logger.info('解析launch.json');
		// if launch.json is missing or empty
		// if (!config.type && !config.request && !config.name) {
		// 	const editor = vscode.window.activeTextEditor;
		// 	if (editor && editor.document.languageId === 'c' ) {
		// 		config.type = 'c';
		// 		config.name = 'Launch';
		// 		config.request = 'launch';
		// 		config.target = '${file}';
		// 		config.stopOnEntry = true;
		// 	}
		// }

		// if (!config.target) {
		// 	looger.error('没有配置target');
		// 	return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
		// 		return undefined;	// abort launch
		// 	});
		// }
		logger.info(JSON.stringify(config));

		return config;
	}

	dispose() {

	}
}
