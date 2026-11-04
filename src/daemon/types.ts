/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type DaemonMessage =
  | {
      method: 'stop';
    }
  | {
      method: 'status';
    }
  | {
      method: 'invoke_tool';
      clientId?: string;
      roots?: Array<{uri: string; name?: string}>;
      tool: string;
      args?: Record<string, unknown>;
    }
  | {
      method: 'list_tools';
    };

export interface DaemonResponse {
  success: boolean;
  // Stringified CallToolResult.
  result: string;
  error: unknown;
}

export interface DaemonStatusResult {
  pid: number | null;
  socketPath: string;
  startDate: string;
  version: string;
  args: string[];
  memory: NodeJS.MemoryUsage;
  maxRssBytes: number;
  httpUrl?: string;
  httpTokenFile?: string;
}
