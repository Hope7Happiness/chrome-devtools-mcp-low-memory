/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {ClientSessions} from '../../src/daemon/ClientSessions.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import {createMockMcpContext, createMockMcpPage} from '../mocks.js';

describe('ClientSessions', () => {
  it('isolates selected pages, roots and snapshots between clients', async () => {
    const context = createMockMcpContext();
    const first = createMockMcpPage({id: 1});
    const second = createMockMcpPage({id: 2});
    context.getPages.returns([first, second]);
    const sessions = new ClientSessions(context);
    const snapshot = sinon.createStubInstance(TextSnapshot);
    const roots = [{uri: 'file:///tmp/client-a'}];
    context.isPageSelected.withArgs(second).returns(true);
    await sessions.run('a', roots, async () => {
      first.textSnapshot = snapshot;
    });
    assert.strictEqual(first.textSnapshot, null);
    sinon.assert.calledWithExactly(context.setRoots.firstCall, roots);
    sinon.assert.calledWithExactly(context.setRoots.secondCall, undefined);

    context.isPageSelected.withArgs(second).returns(false);
    context.isPageSelected.withArgs(first).returns(true);
    await sessions.run('b', [], async () => {
      assert.strictEqual(first.textSnapshot, null);
      assert.strictEqual(second.textSnapshot, null);
      sinon.assert.calledWithExactly(context.selectPage.lastCall, first);
    });
    await sessions.run('a', roots, async () => {
      assert.strictEqual(first.textSnapshot, snapshot);
      sinon.assert.calledWithExactly(context.selectPage.lastCall, second);
    });
    sessions.dispose();
  });

  it('retains a newly captured snapshot ahead of unchanged snapshots on newer pages', async () => {
    const context = createMockMcpContext();
    const pages = [1, 2, 3].map(id => createMockMcpPage({id}));
    context.getPages.returns(pages);
    const sessions = new ClientSessions(context);
    const snapshots = pages.map(() => sinon.createStubInstance(TextSnapshot));
    try {
      for (let index = 0; index < pages.length; index++) {
        await sessions.run('a', [], async () => {
          pages[index].textSnapshot = snapshots[index];
        });
      }
      const replacement = sinon.createStubInstance(TextSnapshot);
      await sessions.run('a', [], async () => {
        assert.strictEqual(pages[0].textSnapshot, null);
        pages[0].textSnapshot = replacement;
      });
      await sessions.run('a', [], async () => {
        assert.strictEqual(pages[0].textSnapshot, replacement);
        assert.strictEqual(pages[1].textSnapshot, null);
        assert.strictEqual(pages[2].textSnapshot, snapshots[2]);
      });
    } finally {
      sessions.dispose();
    }
  });

  it('serializes concurrent clients and releases the queue after failure', async () => {
    const context = createMockMcpContext();
    context.getPages.returns([]);
    const sessions = new ClientSessions(context);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const events: string[] = [];
    const first = sessions.run('a', [], async () => {
      events.push('a');
      entered.resolve();
      await release.promise;
      throw new Error('failed operation');
    });
    const rejection = assert.rejects(first, /failed operation/);
    await entered.promise;
    const second = sessions.run('b', [], async () => {
      events.push('b');
    });
    assert.deepStrictEqual(events, ['a']);
    release.resolve();
    await Promise.all([rejection, second]);
    assert.deepStrictEqual(events, ['a', 'b']);
    sinon.assert.calledWithExactly(context.setRoots.lastCall, undefined);
    sessions.dispose();
  });

  it('evicts idle clients and caps retained clients and page snapshots', async () => {
    const clock = sinon.useFakeTimers();
    const context = createMockMcpContext();
    const pages = [1, 2, 3].map(id => createMockMcpPage({id}));
    context.getPages.returns(pages);
    const sessions = new ClientSessions(context);
    const snapshot = sinon.createStubInstance(TextSnapshot);
    await sessions.run('a', [], async () => {
      for (const page of pages) {
        page.textSnapshot = snapshot;
      }
    });
    await sessions.run('a', [], async () => {
      assert.strictEqual(pages[0].textSnapshot, null);
      assert.strictEqual(pages[1].textSnapshot, snapshot);
      assert.strictEqual(pages[2].textSnapshot, snapshot);
    });
    clock.tick(600_001);
    await sessions.run('a', [], async () => {
      assert.ok(pages.every(page => page.textSnapshot === null));
      pages[0].textSnapshot = snapshot;
    });
    for (let i = 0; i < 16; i++) {
      await sessions.run(`client-${i}`, [], async () => {});
    }
    await sessions.run('a', [], async () => {
      assert.strictEqual(pages[0].textSnapshot, null);
    });
    sessions.dispose();
    assert.strictEqual(clock.countTimers(), 0);
    await assert.rejects(
      sessions.run('a', [], async () => {}),
      /disposed/,
    );
  });
});
