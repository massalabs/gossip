/**
 * SDK Test Setup File
 *
 * Minimal environment setup for SDK tests:
 * - WASM initialization
 * - In-memory SQLite database
 * - Shared database cleanup
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { afterAll, beforeAll } from 'vitest';
import { initializeWasm } from '../src/wasm/loader';
import { initDb, closeSqlite, clearAllTables } from '../src/sqlite';

const require = createRequire(import.meta.url);
const waSqlitePath = dirname(require.resolve('wa-sqlite/package.json'));
const waSqliteWasm = readFileSync(resolve(waSqlitePath, 'dist/wa-sqlite.wasm'));

if (typeof process !== 'undefined') {
  process.env.GOSSIP_API_URL = 'https://api.usegossip.com';
  process.env.VITE_GOSSIP_API_URL = 'https://api.usegossip.com';
}

beforeAll(async () => {
  await initializeWasm();
  const wasmBinary = waSqliteWasm.buffer.slice(
    waSqliteWasm.byteOffset,
    waSqliteWasm.byteOffset + waSqliteWasm.byteLength
  );
  await initDb({ wasmBinary });
  await clearAllTables();
});

afterAll(async () => {
  try {
    await closeSqlite();
  } catch {
    // SQLite might already be closed
  }
});
