#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {sendCommand} from '../daemon/client.js';
import {startSharedDaemon} from '../daemon/sharedStartup.js';
import type {DaemonStatusResult} from '../daemon/types.js';
import {VERSION} from '../version.js';

const sessionId = process.env.CHROME_DEVTOOLS_MCP_SESSION_ID || '200-ba5e';
const extraArgs = process.argv.slice(2);
if (extraArgs.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
if (extraArgs.includes('--help')) {
  console.log(
    'Usage: chrome-devtools-mcp-http [browser flags] [--shared-http-port=9335]',
  );
  console.log(
    'Start one loopback HTTP MCP service and print its URL and private token file path.',
  );
  process.exit(0);
}
const hasPort = extraArgs.some(arg =>
  /^--(?:sharedHttpPort|shared-http-port)(?:=|$)/.test(arg),
);
await startSharedDaemon(
  [
    '--lowMemory',
    '--no-usage-statistics',
    ...(hasPort ? [] : ['--shared-http-port=9335']),
    ...extraArgs,
  ],
  sessionId,
);
const response = await sendCommand({method: 'status'}, sessionId);
if (!response.success) {
  throw new Error(String(response.error));
}
const status: DaemonStatusResult = JSON.parse(response.result);
console.log(
  JSON.stringify({url: status.httpUrl, bearerTokenFile: status.httpTokenFile}),
);
