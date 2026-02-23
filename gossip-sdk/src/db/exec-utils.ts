/**
 * Shared SQLite execution utilities.
 *
 * Used by both sqlite.ts (in-process path) and sqlite-worker.ts (Worker path)
 * to avoid duplicating the wa-sqlite prepare/bind/step/finalize logic.
 */

import * as SQLite from 'wa-sqlite';

export type SqliteAPI = ReturnType<typeof SQLite.Factory>;

/**
 * Copy blob values out of WASM linear memory.
 * wa-sqlite's column_blob() returns a Uint8Array VIEW into Module.HEAPU8.
 * These views become stale after finalize() or memory growth.
 */
export function copyRow(row: unknown[]): unknown[] {
  return row.map(v => (v instanceof Uint8Array ? new Uint8Array(v) : v));
}

/**
 * Execute a SQL statement against a wa-sqlite database handle.
 * Handles both parameterless (exec) and parameterized (prepare_v2) paths.
 */
export async function execStatements(
  sqlite3: SqliteAPI,
  dbHandle: number,
  sql: string,
  params: unknown[] = []
): Promise<unknown[][]> {
  if (params.length === 0) {
    const rows: unknown[][] = [];
    await sqlite3.exec(dbHandle, sql, (row: unknown[]) => {
      rows.push(copyRow(row));
    });
    return rows;
  }

  const str = sqlite3.str_new(dbHandle, sql);
  try {
    const prepared = await sqlite3.prepare_v2(dbHandle, sqlite3.str_value(str));
    if (!prepared) return [];

    try {
      sqlite3.bind_collection(
        prepared.stmt,
        params as (number | string | Uint8Array | null)[]
      );
      const rows: unknown[][] = [];
      while ((await sqlite3.step(prepared.stmt)) === SQLite.SQLITE_ROW) {
        rows.push(copyRow(sqlite3.row(prepared.stmt)));
      }
      return rows;
    } finally {
      await sqlite3.finalize(prepared.stmt);
    }
  } finally {
    sqlite3.str_finish(str);
  }
}
