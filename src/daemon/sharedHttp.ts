/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {WebStandardStreamableHTTPServerTransport} from '../third_party/shared.js';

import {createSharedServer} from './SharedServer.js';
import type {DaemonMessage, DaemonResponse} from './types.js';

export interface SharedHttpService {
  url: string;
  close(): Promise<void>;
}

export async function getHttpToken(filePath: string): Promise<string> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const parent = await fs.lstat(directory);
  if (
    !parent.isDirectory() ||
    (process.platform !== 'win32' &&
      (parent.uid !== os.userInfo().uid || (parent.mode & 0o022) !== 0))
  ) {
    throw new Error(
      'Shared HTTP token directory must be owned by this user and not writable by others',
    );
  }
  try {
    const file = await fs.open(filePath, 'wx', 0o600);
    try {
      await file.writeFile(randomBytes(32).toString('hex'));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  }
  const stats = await fs.lstat(filePath);
  if (
    !stats.isFile() ||
    (process.platform !== 'win32' &&
      (stats.uid !== os.userInfo().uid || (stats.mode & 0o077) !== 0))
  ) {
    throw new Error(
      'Shared HTTP token must be a private file owned by this user',
    );
  }
  const token = await fs.readFile(filePath, 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new Error('Shared HTTP token file has an invalid format');
  }
  return token;
}

export async function startSharedHttp(options: {
  port: number;
  token: string;
  send(message: DaemonMessage): Promise<DaemonResponse>;
}): Promise<SharedHttpService> {
  const sessions = new Map<
    string,
    {
      transport: WebStandardStreamableHTTPServerTransport;
      server: ReturnType<typeof createSharedServer>;
      lastUsed: number;
      active: number;
    }
  >();
  const expectedAuth = Buffer.from(`Bearer ${options.token}`);
  let host = '';
  const listener = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
      } else {
        res.writeHead(500).end('MCP request failed');
      }
    });
  });
  listener.requestTimeout = 15_000;
  listener.headersTimeout = 10_000;

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    if (req.url !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.host !== host || req.headers.origin !== undefined) {
      res.writeHead(403).end();
      return;
    }
    const auth = Buffer.from(req.headers.authorization ?? '');
    if (
      auth.length !== expectedAuth.length ||
      !timingSafeEqual(auth, expectedAuth)
    ) {
      res.writeHead(401).end();
      return;
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
      res.writeHead(405).end();
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (Array.isArray(sessionId)) {
      res.writeHead(400).end();
      return;
    }
    let entry = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !entry) {
      res.writeHead(404).end();
      return;
    }
    if (!entry && req.method !== 'POST') {
      res.writeHead(400).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      if (!Buffer.isBuffer(chunk)) {
        throw new Error('Expected an HTTP request byte buffer');
      }
      size += chunk.length;
      if (size > 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    if (!entry) {
      if (sessions.size >= 16) {
        const oldest = [...sessions.values()]
          .filter(item => item.active === 0)
          .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (oldest && oldest.lastUsed < Date.now() - 60_000) {
          await oldest.server.close();
        }
        if (sessions.size >= 16) {
          res.writeHead(503).end('Shared MCP session limit reached');
          return;
        }
      }
      const id = randomUUID();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => id,
        enableJsonResponse: false,
        maxRequestBodySize: 1024 * 1024,
      });
      const server = createSharedServer(options.send);
      entry = {transport, server, lastUsed: Date.now(), active: 0};
      sessions.set(id, entry);
      server.onclose = () => {
        sessions.delete(id);
      };
      try {
        await server.connect(transport);
      } catch (error) {
        sessions.delete(id);
        await server.close();
        throw error;
      }
    }
    entry.lastUsed = Date.now();
    if (req.method === 'POST') {
      entry.active++;
    }
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            headers.append(name, item);
          }
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }
      const request = new Request(`http://${host}/mcp`, {
        method: req.method,
        headers,
        ...(req.method === 'POST'
          ? {body: Buffer.concat(chunks).toString('utf8')}
          : {}),
      });
      const response = await entry.transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        const cancel = (): void => {
          void reader.cancel().catch(() => {});
        };
        res.on('close', cancel);
        try {
          while (true) {
            const {done, value} = await reader.read();
            if (done) {
              break;
            }
            if (!res.write(value)) {
              await once(res, 'drain', {signal: AbortSignal.timeout(5_000)});
            }
          }
        } finally {
          res.off('close', cancel);
          reader.releaseLock();
        }
      }
      res.end();
    } finally {
      if (req.method === 'POST') {
        entry.active--;
      }
      if (!entry.transport.sessionId) {
        await entry.server.close();
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(options.port, '127.0.0.1', resolve);
  });
  const address = listener.address();
  if (!address || typeof address === 'string') {
    throw new Error('Shared HTTP listener did not bind to a TCP port');
  }
  host = `127.0.0.1:${address.port}`;
  const timer = setInterval(() => {
    for (const entry of sessions.values()) {
      if (entry.active === 0 && entry.lastUsed < Date.now() - 600_000) {
        void entry.server.close();
      }
    }
  }, 60_000);
  timer.unref();
  return {
    url: `http://${host}/mcp`,
    async close(): Promise<void> {
      clearInterval(timer);
      await Promise.allSettled(
        [...sessions.values()].map(entry => entry.server.close()),
      );
      sessions.clear();
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        listener.close(error => (error ? reject(error) : resolve()));
      });
    },
  };
}
