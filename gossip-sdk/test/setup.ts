/**
 * SDK Test Setup File
 *
 * Minimal environment setup for SDK tests:
 * - WASM initialization
 * - In-memory SQLite database via DatabaseConnection
 * - Shared database cleanup
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { createRequire } from 'module';
import { afterAll, beforeAll } from 'vitest';
import { initializeWasm } from '../src/wasm/loader';
import { DatabaseConnection } from '../src/db/sqlite';
import {
  setTestConnection,
  setTestWasmBinary,
  clearAllTables,
  closeTestDb,
} from './testDb';

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
  setTestWasmBinary(wasmBinary);
  const conn = await DatabaseConnection.create({
    storage: { type: 'memory', wasmBinary },
  });
  setTestConnection(conn);
  await clearAllTables();
});

afterAll(async () => {
  try {
    await closeTestDb();
  } catch {
    // SQLite might already be closed
  }
});
