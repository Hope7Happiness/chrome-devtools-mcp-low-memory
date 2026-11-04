/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {Client, InMemoryTransport} from '@modelcontextprotocol/client';
import sinon from 'sinon';

import {createSharedServer} from '../../src/daemon/SharedServer.js';
import type {DaemonMessage, DaemonResponse} from '../../src/daemon/types.js';

describe('shared MCP frontend', () => {
  it('forwards tools and roots with automatic protocol negotiation', async () => {
    const send = sinon.stub<[DaemonMessage], Promise<DaemonResponse>>();
    const tool = {name: 'list_pages', inputSchema: {type: 'object'}};
    send.onFirstCall().resolves({
      success: true,
      result: JSON.stringify({tools: [tool]}),
      error: undefined,
    });
    const result = {content: [{type: 'text', text: 'pages'}]};
    send.resolves({
      success: true,
      result: JSON.stringify(result),
      error: undefined,
    });
    const roots = [{uri: 'file:///tmp/client'}];
    const server = createSharedServer(send);
    const client = new Client(
      {name: 'unit-test', version: '1'},
      {
        capabilities: {roots: {listChanged: true}},
        versionNegotiation: {mode: 'auto'},
      },
    );
    client.setRequestHandler('roots/list', () => ({roots}));
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    try {
      await client.connect(a);
      assert.strictEqual(client.getNegotiatedProtocolVersion(), '2025-11-25');
      assert.deepStrictEqual((await client.listTools()).tools, [tool]);
      assert.deepStrictEqual(
        await client.callTool({name: 'list_pages'}),
        result,
      );
      const command = send.secondCall.args[0];
      assert.strictEqual(command.method, 'invoke_tool');
      if (command.method !== 'invoke_tool') {
        assert.fail('expected invoke_tool');
      }
      assert.ok(command.clientId);
      sinon.assert.calledWithExactly(send.secondCall, {
        method: 'invoke_tool',
        clientId: command.clientId,
        roots,
        tool: 'list_pages',
        args: undefined,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects backend errors and malformed tool results', async () => {
    const send = sinon.stub<[DaemonMessage], Promise<DaemonResponse>>();
    send
      .onFirstCall()
      .resolves({success: false, result: '', error: 'backend unavailable'});
    send.resolves({success: true, result: 'null', error: undefined});
    const server = createSharedServer(send);
    const client = new Client({name: 'unit-test', version: '1'});
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    try {
      await client.connect(a);
      await assert.rejects(client.listTools(), /backend unavailable/);
      await assert.rejects(client.listTools(), /Invalid tools\/list/);
      await assert.rejects(
        client.callTool({name: 'list_pages'}),
        /Invalid tools\/call/,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
