/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFile, readFile, mkdtemp, rm} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {executablePath} from 'puppeteer';

import {LOW_MEMORY_POLICY} from '../../build/src/collectors/memoryPolicy.js';
import {sendCommand, stopDaemon} from '../../build/src/daemon/client.js';
import {startSharedDaemon} from '../../build/src/daemon/sharedStartup.js';
import type {DaemonStatusResult} from '../../src/daemon/types.ts';

const exec = promisify(execFile);
const mib = (bytes: number): number => Math.round((bytes / 1048576) * 10) / 10;
const chromePath = await executablePath();
process.env.CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY = 'true';
process.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS = 'true';
const probeDirectory = await mkdtemp(
  path.join(os.tmpdir(), 'mcp-memory-probe-'),
);
const probePath = path.join(probeDirectory, 'footprint');
process.env.XDG_STATE_HOME = probeDirectory;
if (process.platform === 'darwin') {
  await exec('/usr/bin/cc', ['scripts/profile/footprint.c', '-o', probePath], {
    timeout: 60_000,
  });
}

async function footprint(
  pid: number,
): Promise<{current: number; peak: number} | undefined> {
  if (process.platform !== 'darwin') {
    return undefined;
  }
  const {stdout} = await exec(probePath, [String(pid)], {timeout: 30_000});
  const result: unknown = JSON.parse(stdout);
  assert.ok(
    result &&
      typeof result === 'object' &&
      'current' in result &&
      typeof result.current === 'number' &&
      'peak' in result &&
      typeof result.peak === 'number',
  );
  return {current: mib(result.current), peak: mib(result.peak)};
}

const fixture = http.createServer((req, res) => {
  if (req.url?.startsWith('/payload')) {
    res.end('x'.repeat(20_000));
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<title>Memory fixture</title>' +
        Array.from(
          {length: 200},
          (_, i) => `<button>Button ${i}</button>`,
        ).join(''),
    );
  }
});
await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
const address = fixture.address();
assert.ok(address && typeof address === 'object');
const url = `http://127.0.0.1:${address.port}/`;

async function scenario(lowMemory: boolean): Promise<unknown> {
  const sessionId = randomUUID();
  const transports: StdioClientTransport[] = [];
  const httpTransports: StreamableHTTPClientTransport[] = [];
  const clients: Client[] = [];
  const samples: unknown[] = [];
  async function call(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ) {
    console.log(JSON.stringify({lowMemory, action: name}));
    const result = await client.callTool(
      {name, arguments: args},
      {timeout: 180_000},
    );
    assert.ok(!result.isError, JSON.stringify(result));
    return result;
  }
  async function sample(stage: string) {
    const response = await sendCommand({method: 'status'}, sessionId);
    assert.ok(response.success);
    const status: DaemonStatusResult = JSON.parse(response.result);
    assert.ok(status.pid);
    const backendFootprint = await footprint(status.pid);
    const frontends = [];
    for (const transport of transports) {
      assert.ok(transport.pid);
      frontends.push((await footprint(transport.pid))?.current);
    }
    const measurement = {
      stage,
      backendRssMiB: mib(status.memory.rss),
      backendHeapUsedMiB: mib(status.memory.heapUsed),
      backendMaxRssMiB: mib(status.maxRssBytes),
      backendFootprintMiB: backendFootprint?.current,
      backendPeakFootprintMiB: backendFootprint?.peak,
      frontendFootprintMiB: frontends,
      totalFootprintMiB:
        backendFootprint === undefined
          ? undefined
          : Math.round(
              (backendFootprint.current +
                frontends.reduce<number>(
                  (sum, value) => sum + (value ?? 0),
                  0,
                )) *
                10,
            ) / 10,
    };
    console.log(JSON.stringify({lowMemory, ...measurement}));
    samples.push(measurement);
  }
  try {
    let httpUrl: string | undefined;
    let token: string | undefined;
    if (lowMemory) {
      await startSharedDaemon(
        [
          '--lowMemory',
          '--no-usage-statistics',
          '--shared-http-port=0',
          '--headless',
          '--isolated',
          '--executable-path',
          chromePath,
        ],
        sessionId,
      );
      const response = await sendCommand({method: 'status'}, sessionId);
      assert.ok(response.success);
      const status: DaemonStatusResult = JSON.parse(response.result);
      assert.ok(status.httpUrl && status.httpTokenFile);
      httpUrl = status.httpUrl;
      token = await readFile(status.httpTokenFile, 'utf8');
    }
    for (let i = 0; i < 8; i++) {
      const client = new Client(
        {name: 'memory-benchmark', version: '1'},
        {
          capabilities: {roots: {listChanged: true}},
        },
      );
      client.setRequestHandler('roots/list', () => ({
        roots: [{uri: pathToFileURL(os.tmpdir()).href}],
      }));
      clients.push(client);
      if (httpUrl) {
        const transport = new StreamableHTTPClientTransport(new URL(httpUrl), {
          requestInit: {headers: {Authorization: `Bearer ${token}`}},
        });
        httpTransports.push(transport);
        await client.connect(transport);
        continue;
      }
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          'build/src/bin/chrome-devtools-mcp-shared.js',
          '--headless',
          '--isolated',
          '--executable-path',
          chromePath,
          ...(lowMemory ? [] : ['--no-lowMemory']),
        ],
        env: {
          ...process.env,
          CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId,
          CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: 'true',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: 'true',
        },
      });
      transports.push(transport);
      await client.connect(transport);
    }
    await clients[0].listTools({}, {timeout: 180_000});
    await sample('connected');
    await call(clients[0], 'list_pages');
    await sample('listed');
    const pages: number[] = [];
    for (let i = 0; i < 2; i++) {
      const result = await call(clients[i % clients.length], 'new_page', {
        url,
        background: true,
      });
      const text = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      const selected = text.match(/^(\d+):.*\[selected\]/m);
      assert.ok(selected, text);
      const pageId = Number(selected[1]);
      pages.push(pageId);
      await call(clients[i % clients.length], 'take_snapshot', {pageId});
      await call(clients[i % clients.length], 'evaluate_script', {
        pageId,
        function: `async () => {
          for (let i = 0; i < 1000; i++) console.log(i, 'x'.repeat(2000));
          for (let batch = 0; batch < 25; batch++) {
            await Promise.all(Array.from({length: 10}, (_, i) =>
              fetch('/payload?i=' + (batch * 10 + i)).then(r => r.text())));
          }
          return 'complete';
        }`,
      });
      await sample(`worked-page-${i + 1}`);
    }
    for (const client of clients) {
      for (const pageId of pages) {
        await call(client, 'take_snapshot', {pageId});
      }
    }
    await sample('all-clients-used-both-pages');
    await setTimeout(65_000);
    await sample('idle-after-ttl');
    for (const pageId of pages) {
      await call(clients[0], 'close_page', {pageId});
    }
    await sample('closed');
    return {
      lowMemory,
      transport: lowMemory ? 'direct-http' : 'shared-stdio',
      samples,
    };
  } finally {
    await Promise.allSettled(
      httpTransports.map(transport => transport.terminateSession()),
    );
    await Promise.allSettled(clients.map(client => client.close()));
    await stopDaemon(sessionId);
  }
}

try {
  const results = [];
  for (const lowMemory of process.argv.includes('--http-only')
    ? [true]
    : [false, true]) {
    results.push(await scenario(lowMemory));
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    targetTotalMcpMiB: mib(LOW_MEMORY_POLICY.targetBytes),
    workload: {
      clients: 8,
      pages: 2,
      requestsPerPage: 250,
      logsPerPage: 1000,
      logCharacters: 2000,
      idleSeconds: 65,
    },
    notes:
      'Synthetic isolated Chrome; Chrome memory excluded. macOS proc_pid_rusage reports physical footprint including compressed memory and its lifetime peak. No forced GC or V8 heap limit.',
    results,
  };
  const destination = process.argv[2];
  if (destination) {
    await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise<void>((resolve, reject) =>
    fixture.close(error => (error ? reject(error) : resolve())),
  );
  await rm(probeDirectory, {recursive: true, force: true});
}
