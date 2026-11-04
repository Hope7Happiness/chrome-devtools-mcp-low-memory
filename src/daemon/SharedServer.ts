/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import {
  Server,
  isSpecType,
  isCallToolResult,
  inputRequired,
  type Root,
} from '../third_party/shared.js';

import {VERSION} from '../version.js';

import type {DaemonMessage, DaemonResponse} from './types.js';

export function createSharedServer(
  send: (message: DaemonMessage) => Promise<DaemonResponse>,
): Server {
  const server = new Server(
    {name: 'chrome_devtools_shared', version: VERSION},
    {capabilities: {tools: {}}},
  );
  const clientId = randomUUID();
  server.setNotificationHandler('notifications/roots/list_changed', () => {});
  async function forward(message: DaemonMessage): Promise<unknown> {
    const response = await send(message);
    if (!response.success) {
      throw new Error(String(response.error));
    }
    return JSON.parse(response.result);
  }
  server.setRequestHandler('tools/list', async () => {
    const result = await forward({method: 'list_tools'});
    if (!isSpecType.ListToolsResult(result)) {
      throw new Error('Invalid tools/list result from shared backend');
    }
    return result;
  });
  server.setRequestHandler('tools/call', async (request, ctx) => {
    let roots: Root[] = [];
    if (server.getClientCapabilities()?.roots) {
      const response = ctx.mcpReq.inputResponses?.roots;
      if (response === undefined) {
        return inputRequired({
          inputRequests: {roots: inputRequired.listRoots()},
        });
      }
      if (!isSpecType.ListRootsResult(response)) {
        throw new Error('Invalid roots response from shared MCP client');
      }
      roots = response.roots;
    }
    const result = await forward({
      method: 'invoke_tool',
      clientId,
      roots,
      tool: request.params.name,
      args: request.params.arguments,
    });
    if (!isCallToolResult(result)) {
      throw new Error('Invalid tools/call result from shared backend');
    }
    return result;
  });
  return server;
}
