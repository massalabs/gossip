/**
 * Shared test database helper.
 *
 * Provides access to the DatabaseConnection and Queries created in setup.ts.
 * Individual tests import from here instead of using removed global functions.
 */

import type { GossipDatabase, StorageConfig } from '../src/db/sqlite';
import { DatabaseConnection } from '../src/db/sqlite';
import { Queries } from '../src/db/queries';

let _conn: DatabaseConnection | null = null;
let _queries: Queries | null = null;
let _wasmBinary: ArrayBuffer | null = null;

export function setTestWasmBinary(binary: ArrayBuffer): void {
  _wasmBinary = binary;
}

export function getTestStorageConfig(): StorageConfig {
  if (!_wasmBinary)
    throw new Error('Test wasmBinary not set. Did setup.ts run?');
  return { type: 'memory', wasmBinary: _wasmBinary };
}

export function setTestConnection(conn: DatabaseConnection): void {
  _conn = conn;
  _queries = new Queries(conn);
}

export function getTestConnection(): DatabaseConnection {
  if (!_conn) throw new Error('Test DB not initialized. Did setup.ts run?');
  return _conn;
}

export function getTestDb(): GossipDatabase {
  return getTestConnection().db;
}

export function getTestQueries(): Queries {
  if (!_queries) throw new Error('Test queries not initialized.');
  return _queries;
}

export async function clearAllTables(): Promise<void> {
  await getTestConnection().clearAllTables();
}

export async function getLastInsertRowId(): Promise<number> {
  return getTestConnection().getLastInsertRowId();
}

export async function closeTestDb(): Promise<void> {
  await _conn?.close();
  _conn = null;
  _queries = null;
}
