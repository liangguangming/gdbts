/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken } from 'vscode';
import * as path from 'path';
import logger from './log'

logger.transports.file.file = path.resolve(__dirname, '../extension.log');

export function activate(context: vscode.ExtensionContext) {
	logger.info('激活插件');
	const provider = new CConfigurationProvider()
	context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('c', provider));
	context.subscriptions.push(provider);
}

export function deactivate() {

}

class CConfigurationProvider implements vscode.DebugConfigurationProvider {

	resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {

		logger.info('解析launch.json');
		logger.info(JSON.stringify(config));

		return config;
	}

	dispose() {

	}
}
