#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {StdioServerTransport} from '../third_party/shared.js';

import {sendCommand} from '../daemon/client.js';
import {createSharedServer} from '../daemon/SharedServer.js';
import {startSharedDaemon} from '../daemon/sharedStartup.js';
import {VERSION} from '../version.js';

if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('Usage: chrome-devtools-mcp-shared [browser flags]');
  console.log('Connect this stdio MCP client to a shared low-memory backend.');
  process.exit(0);
}

const sessionId = process.env.CHROME_DEVTOOLS_MCP_SESSION_ID || '200-ba5e';
const args = ['--lowMemory', '--no-usage-statistics', ...process.argv.slice(2)];

process.title = 'chrome-devtools-mcp-shared';
const started = startSharedDaemon(args, sessionId);
void started.catch(() => {});
const server = createSharedServer(async message => {
  await started;
  return await sendCommand(message, sessionId, 180_000);
});
await server.connect(new StdioServerTransport());
