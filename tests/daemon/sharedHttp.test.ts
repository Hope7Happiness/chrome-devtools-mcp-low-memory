/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {describe, it} from 'node:test';

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import sinon from 'sinon';

import {getHttpToken, startSharedHttp} from '../../src/daemon/sharedHttp.js';
import type {DaemonMessage, DaemonResponse} from '../../src/daemon/types.js';
import {createTempDir} from '../utils.js';

describe('shared HTTP service', () => {
  it('persists a private token and refuses permissive or symlinked token files', async () => {
    using directory = createTempDir();
    const file = path.join(directory.path, 'token');
    const token = await getHttpToken(file);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.strictEqual(await getHttpToken(file), token);
    if (process.platform !== 'win32') {
      await fs.chmod(file, 0o644);
      await assert.rejects(getHttpToken(file), /private file/);
      await fs.chmod(file, 0o600);
      const link = path.join(directory.path, 'link');
      await fs.symlink(file, link);
      await assert.rejects(getHttpToken(link), /private file/);
    }
    await fs.writeFile(file, 'malformed-token');
    await assert.rejects(getHttpToken(file), /invalid format/);
  });

  it('creates private state directories and refuses writable or symlinked directories', async () => {
    using directory = createTempDir();
    const state = path.join(directory.path, 'state');
    const token = await getHttpToken(path.join(state, 'token'));
    assert.strictEqual(await getHttpToken(path.join(state, 'token')), token);
    if (process.platform !== 'win32') {
      await fs.chmod(state, 0o777);
      await assert.rejects(
        getHttpToken(path.join(state, 'token')),
        /directory/,
      );
      await fs.chmod(state, 0o700);
      const link = path.join(directory.path, 'linked-state');
      await fs.symlink(state, link);
      await assert.rejects(getHttpToken(path.join(link, 'token')), /directory/);
    }
  });

  it('rejects missing credentials, browser origins, wrong hosts and oversized requests', async () => {
    const send = sinon.stub<[DaemonMessage], Promise<DaemonResponse>>();
    const service = await startSharedHttp({port: 0, token: 'test-token', send});
    try {
      assert.strictEqual(
        (await fetch(service.url, {method: 'POST'})).status,
        401,
      );
      const headers = {Authorization: 'Bearer test-token'};
      assert.strictEqual(
        (
          await fetch(service.url, {
            method: 'POST',
            headers: {...headers, Origin: 'https://example.test'},
          })
        ).status,
        403,
      );
      const wrongHostStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          const request = http.request(
            service.url,
            {
              method: 'POST',
              headers: {...headers, Host: 'evil.example'},
            },
            response => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.on('error', reject);
          request.end();
        },
      );
      assert.strictEqual(wrongHostStatus, 403);
      assert.strictEqual(
        (
          await fetch(service.url, {
            method: 'POST',
            headers,
            body: 'x'.repeat(1024 * 1024 + 1),
          })
        ).status,
        413,
      );
      assert.strictEqual(
        (
          await fetch(service.url, {
            method: 'POST',
            headers: {...headers, 'mcp-session-id': 'unknown'},
          })
        ).status,
        404,
      );
      sinon.assert.notCalled(send);
    } finally {
      await service.close();
    }
  });

  it('serves multiple SDK clients without frontend processes and isolates their roots', async () => {
    const send = sinon.stub<[DaemonMessage], Promise<DaemonResponse>>();
    send.callsFake(async message => ({
      success: true,
      result: JSON.stringify(
        message.method === 'list_tools' ? {tools: []} : {content: []},
      ),
      error: undefined,
    }));
    const service = await startSharedHttp({port: 0, token: 'test-token', send});
    const clients = [1, 2].map(
      i =>
        new Client(
          {name: `client-${i}`, version: '1'},
          {
            capabilities: {roots: {}},
            versionNegotiation: {mode: i === 1 ? 'auto' : 'legacy'},
          },
        ),
    );
    try {
      for (let i = 0; i < clients.length; i++) {
        const client = clients[i];
        client.setRequestHandler('roots/list', () => ({
          roots: [{uri: `file:///tmp/client-${i}`}],
        }));
        await client.connect(
          new StreamableHTTPClientTransport(new URL(service.url), {
            requestInit: {headers: {Authorization: 'Bearer test-token'}},
          }),
        );
        await client.listTools();
        await client.callTool({name: 'list_pages'});
        await client.callTool({name: 'list_pages'});
      }
      const first = send.secondCall.args[0];
      const repeated = send.getCall(2).args[0];
      const second = send.getCall(4).args[0];
      assert.strictEqual(first.method, 'invoke_tool');
      assert.strictEqual(repeated.method, 'invoke_tool');
      assert.strictEqual(second.method, 'invoke_tool');
      if (
        first.method !== 'invoke_tool' ||
        repeated.method !== 'invoke_tool' ||
        second.method !== 'invoke_tool'
      ) {
        assert.fail('Expected tool calls');
      }
      assert.strictEqual(first.clientId, repeated.clientId);
      assert.notStrictEqual(first.clientId, second.clientId);
      assert.deepStrictEqual(first.roots, [{uri: 'file:///tmp/client-0'}]);
      assert.deepStrictEqual(second.roots, [{uri: 'file:///tmp/client-1'}]);
    } finally {
      await Promise.allSettled(clients.map(client => client.close()));
      await service.close();
    }
  });

  it('bounds abandoned sessions and evicts inactive and expired sessions', async () => {
    const clock = sinon.useFakeTimers({
      toFake: ['Date', 'setInterval', 'clearInterval'],
    });
    const send = sinon.stub<[DaemonMessage], Promise<DaemonResponse>>();
    const service = await startSharedHttp({port: 0, token: 'test-token', send});
    const headers = {
      Authorization: 'Bearer test-token',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    async function initialize(id: number) {
      const response = await fetch(service.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: {name: 'capacity-test', version: '1'},
          },
        }),
      });
      await response.text();
      return response;
    }
    try {
      let firstId: string | null = null;
      for (let i = 0; i < 16; i++) {
        const response = await initialize(i);
        assert.strictEqual(response.status, 200);
        firstId ??= response.headers.get('mcp-session-id');
      }
      assert.ok(firstId);
      assert.strictEqual((await initialize(17)).status, 503);
      clock.tick(60_001);
      const replacement = await initialize(18);
      assert.strictEqual(replacement.status, 200);
      const replacementId = replacement.headers.get('mcp-session-id');
      assert.ok(replacementId);
      assert.strictEqual(
        (
          await fetch(service.url, {
            headers: {...headers, 'mcp-session-id': firstId},
          })
        ).status,
        404,
      );
      clock.tick(660_000);
      assert.strictEqual(
        (
          await fetch(service.url, {
            headers: {...headers, 'mcp-session-id': replacementId},
          })
        ).status,
        404,
      );
      sinon.assert.notCalled(send);
    } finally {
      await service.close();
    }
  });
});
