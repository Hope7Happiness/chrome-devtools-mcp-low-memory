/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';

import {sendCommand, startDaemon} from './client.js';
import {getRuntimeHome, isDaemonRunning} from './utils.js';

export async function startSharedDaemon(
  args: string[],
  sessionId: string,
): Promise<void> {
  const directory = getRuntimeHome(sessionId);
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const stats = await fs.lstat(directory);
  if (
    !stats.isDirectory() ||
    (process.platform !== 'win32' &&
      (stats.uid !== os.userInfo().uid || (stats.mode & 0o022) !== 0))
  ) {
    throw new Error('Shared daemon runtime directory is unsafe');
  }
  const lockPath = path.join(directory, 'startup.lock');
  const deadline = Date.now() + 120_000;
  while (true) {
    let lock;
    try {
      lock = await fs.open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      ) {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Shared daemon startup lock timed out after 120000ms: ${lockPath}. ` +
            'If its owning process has exited, remove this stale lock and retry.',
        );
      }
      await setTimeout(100);
      continue;
    }
    try {
      await lock.writeFile(String(process.pid));
      if (isDaemonRunning(sessionId)) {
        const response = await sendCommand({method: 'status'}, sessionId);
        const status: unknown = JSON.parse(response.result);
        if (
          !response.success ||
          !status ||
          typeof status !== 'object' ||
          !('args' in status) ||
          JSON.stringify(status.args) !== JSON.stringify(args)
        ) {
          throw new Error(
            'Shared backend configuration differs; use a separate ' +
              'CHROME_DEVTOOLS_MCP_SESSION_ID for another browser or configuration.',
          );
        }
      }
      await startDaemon(args, sessionId);
      return;
    } finally {
      await lock.close();
      await fs.rm(lockPath, {force: true});
    }
  }
}
