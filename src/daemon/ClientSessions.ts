/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import type {McpContext} from '../McpContext.js';
import type {TextSnapshot} from '../TextSnapshot.js';
import type {Root} from '../third_party/index.js';

interface ClientState {
  selectedPageId?: number;
  snapshots: Map<number, TextSnapshot>;
  lastUsed: number;
}

export class ClientSessions {
  #states = new Map<string, ClientState>();
  #tail: Promise<void> = Promise.resolve();
  #disposed = false;
  #expiryTimer: ReturnType<typeof setInterval>;

  constructor(private readonly context: McpContext) {
    this.#expiryTimer = setInterval(() => this.#pruneIdle(), 60_000);
    this.#expiryTimer.unref();
  }

  #pruneIdle(): void {
    const cutoff = Date.now() - 600_000;
    for (const [id, state] of this.#states) {
      if (state.lastUsed < cutoff) {
        this.#states.delete(id);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#expiryTimer);
    this.#states.clear();
  }

  async run<T>(
    clientId: string,
    roots: Root[] | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#tail;
    const gate = Promise.withResolvers<void>();
    this.#tail = gate.promise;
    await previous;
    try {
      if (this.#disposed) {
        throw new Error('Shared client sessions have been disposed');
      }
      this.#pruneIdle();
      const state: ClientState = this.#states.get(clientId) ?? {
        snapshots: new Map<number, TextSnapshot>(),
        lastUsed: Date.now(),
      };
      const pages = this.context.getPages();
      const selected = pages.find(page => page.id === state.selectedPageId);
      const fallback = pages[0];
      if (selected ?? fallback) {
        this.context.selectPage(selected ?? fallback);
      }
      for (const page of pages) {
        page.textSnapshot = state.snapshots.get(page.id) ?? null;
      }
      this.context.setRoots(roots);
      try {
        return await operation();
      } finally {
        const currentPages = this.context.getPages();
        for (const id of state.snapshots.keys()) {
          if (!currentPages.some(page => page.id === id)) {
            state.snapshots.delete(id);
          }
        }
        for (const page of currentPages) {
          if (this.context.isPageSelected(page)) {
            state.selectedPageId = page.id;
          }
          if (page.textSnapshot) {
            if (state.snapshots.get(page.id) !== page.textSnapshot) {
              state.snapshots.delete(page.id);
              state.snapshots.set(page.id, page.textSnapshot);
            }
          } else {
            state.snapshots.delete(page.id);
          }
          page.textSnapshot = null;
        }
        while (state.snapshots.size > 2) {
          const oldest = state.snapshots.keys().next().value;
          if (oldest !== undefined) {
            state.snapshots.delete(oldest);
          }
        }
        state.lastUsed = Date.now();
        this.#states.delete(clientId);
        if (!this.#disposed) {
          this.#states.set(clientId, state);
        }
        while (this.#states.size > 16) {
          const oldest = this.#states.keys().next().value;
          if (oldest !== undefined) {
            this.#states.delete(oldest);
          }
        }
        this.context.setRoots(undefined);
      }
    } finally {
      gate.resolve();
    }
  }
}
