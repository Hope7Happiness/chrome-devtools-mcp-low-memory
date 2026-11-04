/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {executablePath} from 'puppeteer';

import {sendCommand, stopDaemon} from '../../src/daemon/client.js';
import {startSharedDaemon} from '../../src/daemon/sharedStartup.js';
import {getDaemonPid} from '../../src/daemon/utils.js';
import {VERSION} from '../../src/version.js';
import {createTempDir} from '../utils.js';

describe('shared backend integration', () => {
  it('prints launcher help and version without starting a backend', async () => {
    const sessionId = randomUUID();
    for (const entry of ['http', 'shared']) {
      for (const flag of ['--version', '--help']) {
        const {stdout} = await promisify(execFile)(
          process.execPath,
          [`build/src/bin/chrome-devtools-mcp-${entry}.js`, flag],
          {env: {...process.env, CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId}},
        );
        assert.ok(stdout.includes(flag === '--version' ? VERSION : 'Usage:'));
        assert.strictEqual(getDaemonPid(sessionId), null);
      }
    }
  });

  it('launches direct HTTP once and prints no bearer token', async () => {
    using stateDirectory = createTempDir();
    const sessionId = randomUUID();
    try {
      const {stdout} = await promisify(execFile)(
        process.execPath,
        ['build/src/bin/chrome-devtools-mcp-http.js', '--shared-http-port=0'],
        {
          env: {
            ...process.env,
            CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId,
            XDG_STATE_HOME: stateDirectory.path,
          },
          timeout: 90_000,
        },
      );
      const status = await sendCommand({method: 'status'}, sessionId);
      assert.ok(status.success);
      const printed: unknown = JSON.parse(stdout);
      assert.ok(
        printed &&
          typeof printed === 'object' &&
          'bearerTokenFile' in printed &&
          typeof printed.bearerTokenFile === 'string' &&
          'url' in printed &&
          typeof printed.url === 'string',
      );
      assert.match(printed.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.ok(printed.bearerTokenFile.startsWith(stateDirectory.path));
      assert.ok(
        !stdout.includes(await fs.readFile(printed.bearerTokenFile, 'utf8')),
      );
    } finally {
      await stopDaemon(sessionId);
    }
  });

  it('starts one backend for concurrent frontends and rejects conflicting configuration', async () => {
    const sessionId = randomUUID();
    const clients = [1, 2].map(
      i => new Client({name: `test-${i}`, version: '1'}),
    );
    const args = [
      '--headless',
      '--isolated',
      '--executable-path',
      await executablePath(),
    ];
    try {
      await Promise.all(
        clients.map(client =>
          client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: ['build/src/bin/chrome-devtools-mcp-shared.js', ...args],
              env: {...process.env, CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId},
            }),
          ),
        ),
      );
      const lists = await Promise.all(
        clients.map(client => client.listTools({}, {timeout: 120_000})),
      );
      const pid = getDaemonPid(sessionId);
      assert.ok(pid);
      assert.deepStrictEqual(lists[0], lists[1]);
      assert.ok(lists[0].tools.some(tool => tool.name === 'list_pages'));
      const result = await clients[0].callTool({name: 'list_pages'});
      assert.ok(!result.isError, JSON.stringify(result));
      await clients[0].close();
      const remainingResult = await clients[1].callTool({name: 'list_pages'});
      assert.ok(!remainingResult.isError, JSON.stringify(remainingResult));
      assert.strictEqual(getDaemonPid(sessionId), pid);
      const status = await sendCommand({method: 'status'}, sessionId);
      assert.ok(status.success);
      await assert.rejects(
        startSharedDaemon(['--headless'], sessionId),
        /configuration differs/,
      );
      assert.strictEqual(getDaemonPid(sessionId), pid);
    } finally {
      await Promise.allSettled(clients.map(client => client.close()));
      await stopDaemon(sessionId);
    }
  });
});
