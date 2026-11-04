/**
 * @license
 * Copyright 2026 chrome-devtools-mcp-low-memory contributors
 * SPDX-License-Identifier: Apache-2.0
 */

export const LOW_MEMORY_POLICY: Readonly<{
  targetBytes: number;
  maxNavigationSaved: number;
  maxNetworkRequests: number;
  maxConsoleMessages: number;
  maxResourceAgeMs: number;
}> = Object.freeze({
  targetBytes: 200 * 1024 * 1024,
  maxNavigationSaved: 1,
  maxNetworkRequests: 100,
  maxConsoleMessages: 200,
  maxResourceAgeMs: 60_000,
});
