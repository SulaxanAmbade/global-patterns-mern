import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test(
  'legacy cleanup, repeated replacement, keyword retention and crash recovery',
  { skip: !process.env.TEST_MONGODB_URI, timeout: 120000 },
  async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), 'gp-storage-test-'));
    try {
      let output = '';
      const code = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL('./fixtures/storage-scenario.js', import.meta.url),
            ),
          ],
          {
            env: { ...process.env, STORAGE_DIR: folder },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        child.stdout.on('data', (b) => {
          output += b;
        });
        child.stderr.on('data', (b) => {
          output += b;
        });
        child.on('exit', resolve);
      });
      assert.equal(code, 0, output);
      assert.match(output, /STORAGE PASS/);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);
