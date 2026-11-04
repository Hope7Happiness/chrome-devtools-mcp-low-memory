/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';

// Checks that the selected build files are present using `npm pack --dry-run`.
function verifyPackageContents() {
  try {
    const output = execSync(
      'npm pack --dry-run --json --silent --ignore-scripts',
      {
        encoding: 'utf8',
      },
    );
    const [data] = JSON.parse(output);
    const files = data.files.map(f => f.path);
    // Check some important files.
    const requiredPaths = [
      'build/src/index.js',
      'build/src/third_party/index.js',
      'build/src/third_party/cli.js',
      'build/src/third_party/shared.js',
      'build/src/bin/chrome-devtools-mcp-http.js',
      'build/src/bin/chrome-devtools-mcp-shared.js',
    ];
    for (const requiredPath of requiredPaths) {
      const hasBuildFolder = files.some(path => path.startsWith(requiredPath));
      if (!hasBuildFolder) {
        console.error(
          `Assertion Failed: "${requiredPath}" not found in tarball.`,
        );
        process.exit(1);
      }
    }
    console.log(
      `npm pack --dry-run contained ${JSON.stringify(requiredPaths)}`,
    );
  } catch (err) {
    console.error('failed to verify npm package contents', err);
    process.exit(1);
  }
}

verifyPackageContents();
