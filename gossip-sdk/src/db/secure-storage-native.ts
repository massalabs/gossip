/**
 * Capacitor plugin wrapper for native secure storage.
 *
 * The underlying plugin exposes a single `call({method, args}) → {result}`
 * method (JSON-in / JSON-out dispatcher implemented in Rust). This file
 * wraps it in a typed facade that preserves the public API callers in
 * `sqlite.ts` and `secure-storage-worker.ts` already use.
 *
 * Binary payloads (password bytes, SQL BLOB values, namespace data)
 * cross the bridge as base64 strings rather than `number[]`, saving
 * the ~×8 per-byte overhead of the JSON-number encoding.
 */

import { registerPlugin } from '@capacitor/core';

// ── Raw plugin (single method) ────────────────────────────────────

interface RawPlugin {
  call(options: { method: string; args: string }): Promise<{ result: string }>;
}

const raw = registerPlugin<RawPlugin>('SecureStorageNative');

// ── base64 helpers ────────────────────────────────────────────────

function u8ToBase64(bytes: Uint8Array | number[]): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) {
    binary += String.fromCharCode(arr[i]);
  }
  return btoa(binary);
}

function base64ToU8(s: string): Uint8Array {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── Dispatcher helper ─────────────────────────────────────────────

async function callNative<T = unknown>(
  method: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const { result } = await raw.call({
    method,
    args: JSON.stringify(args),
  });
  return JSON.parse(result) as T;
}

// ── SQL value encoding ────────────────────────────────────────────
// Rust accepts raw JSON primitives (null/bool/number/string) directly
// for SQL params. BLOBs travel as the sentinel `{blob: "<base64>"}` —
// that's the only transform we need.

function encodeSqlParam(v: unknown): unknown {
  if (v instanceof Uint8Array) return { blob: u8ToBase64(v) };
  // Legacy: some callers still pass number[] for blobs.
  if (Array.isArray(v)) return { blob: u8ToBase64(v as number[]) };
  return v;
}

function decodeSqlValue(v: unknown): unknown {
  if (v && typeof v === 'object' && 'blob' in v) {
    return base64ToU8((v as { blob: string }).blob);
  }
  return v;
}

// ── Public interface (unchanged from the previous hand-rolled plugin) ──

export interface SecureStorageNativePlugin {
  initSecureStorage(options: { path: string; domain: string }): Promise<void>;
  provisionStorage(): Promise<void>;
  hasData(): Promise<{ hasData: boolean }>;
  // Binary payloads (passwords, namespace blobs) are typed as Uint8Array
  // end-to-end. Going through `number[]` was an O(n) memcopy in each
  // direction with no benefit: the plugin internally base64-encodes
  // for the JSON bridge regardless.
  allocateSession(options: {
    slot: number;
    password: Uint8Array;
  }): Promise<void>;
  unlockSession(options: {
    password: Uint8Array;
  }): Promise<{ unlocked: boolean }>;
  lockSession(): Promise<void>;
  isUnlocked(): Promise<{ unlocked: boolean }>;
  coverTrafficTick(): Promise<void>;
  execSql(options: { sql: string; params: unknown[] }): Promise<{
    columns: string[];
    rows: unknown[][];
    lastInsertRowId: number;
    changes: number;
  }>;
  /**
   * Run a list of statements under one mutex acquisition + one bridge
   * round-trip. Each statement is independently prepared (cached) and
   * executed; result order matches input order. Caller is responsible
   * for wrapping the chain in BEGIN/COMMIT (or BEGIN/ROLLBACK) when
   * atomicity is required - the batch itself is not transactional.
   *
   * Use this for known-shape sequences like sendMessage's
   * `BEGIN; INSERT message; UPDATE discussion; COMMIT`. A typical
   * 4-statement chain drops from 4 bridge hops to 1.
   */
  execSqlBatch(options: {
    statements: { sql: string; params: unknown[] }[];
  }): Promise<
    {
      columns: string[];
      rows: unknown[][];
      lastInsertRowId: number;
      changes: number;
    }[]
  >;
  flush(): Promise<void>;
  close(): Promise<void>;

  // Namespace data API - parity with the WASM worker. Enables the SDK
  // to persist the session blob on the native path without going
  // through the SQL VFS.
  writeNamespaceData(options: {
    namespace: number;
    offset: number;
    data: Uint8Array;
  }): Promise<void>;

  /**
   * Atomic clear+write. Equivalent to `clearNamespace` followed by
   * `writeNamespaceData(ns, 0, data)`, but a single redb txn (one fsync)
   * inside a single mutex hold — used by the session-blob persist hot
   * path where the two-step variant produced back-to-back fsyncs that
   * blocked SQL ops on the shared state mutex.
   */
  replaceNamespaceData(options: {
    namespace: number;
    data: number[];
  }): Promise<void>;
  readNamespaceData(options: {
    namespace: number;
    offset: number;
    len: number;
  }): Promise<{ data: Uint8Array }>;
  namespaceDataLength(options: {
    namespace: number;
  }): Promise<{ length: number }>;
  clearNamespace(options: { namespace: number }): Promise<void>;

  /**
   * Permanently destroy the data of the currently unlocked slot.
   * Native side drops the rusqlite connection BEFORE entering the wipe
   * (mirrors `allocate`'s switch-with-clean-shutdown pattern), then
   * rotates the slot's keypair to a dummy and overwrites every block
   * of `namespaces` with cover blocks under the new PK. Single redb
   * commit at the end — atomic against process kill.
   */
  destroySession(options: { namespaces: number[] }): Promise<void>;
}

export const SecureStorageNative: SecureStorageNativePlugin = {
  async initSecureStorage(options) {
    await callNative('initSecureStorage', options);
  },
  async provisionStorage() {
    await callNative('provisionStorage');
  },
  async hasData() {
    const hasData = await callNative<boolean>('hasData');
    return { hasData };
  },
  async allocateSession({ slot, password }) {
    await callNative('allocateSession', {
      slot,
      password: u8ToBase64(password),
    });
  },
  async unlockSession({ password }) {
    const unlocked = await callNative<boolean>('unlockSession', {
      password: u8ToBase64(password),
    });
    return { unlocked };
  },
  async lockSession() {
    await callNative('lockSession');
  },
  async isUnlocked() {
    const unlocked = await callNative<boolean>('isUnlocked');
    return { unlocked };
  },
  async coverTrafficTick() {
    await callNative('coverTrafficTick');
  },
  async execSql({ sql, params }) {
    const result = await callNative<{
      columns: string[];
      rows: unknown[][];
      lastInsertRowId: number;
      changes: number;
    }>('execSql', { sql, params: params.map(encodeSqlParam) });
    return {
      ...result,
      rows: result.rows.map(row => row.map(decodeSqlValue)),
    };
  },
  async execSqlBatch({ statements }) {
    const encoded = statements.map(s => ({
      sql: s.sql,
      params: s.params.map(encodeSqlParam),
    }));
    const results = await callNative<
      {
        columns: string[];
        rows: unknown[][];
        lastInsertRowId: number;
        changes: number;
      }[]
    >('execSqlBatch', { statements: encoded });
    return results.map(r => ({
      ...r,
      rows: r.rows.map(row => row.map(decodeSqlValue)),
    }));
  },
  async flush() {
    await callNative('flush');
  },
  async close() {
    await callNative('close');
  },
  async writeNamespaceData({ namespace, offset, data }) {
    await callNative('writeNamespaceData', {
      namespace,
      offset,
      data: u8ToBase64(data),
    });
  },
  async readNamespaceData({ namespace, offset, len }) {
    const b64 = await callNative<string>('readNamespaceData', {
      namespace,
      offset,
      len,
    });
    return { data: base64ToU8(b64) };
  },
  async namespaceDataLength({ namespace }) {
    const length = await callNative<number>('namespaceDataLength', {
      namespace,
    });
    return { length };
  },
  async clearNamespace({ namespace }) {
    await callNative('clearNamespace', { namespace });
  },
  async destroySession({ namespaces }) {
    await callNative('destroySession', { namespaces });
  },
  async replaceNamespaceData({ namespace, data }) {
    await callNative('replaceNamespaceData', {
      namespace,
      data: u8ToBase64(data),
    });
  },
};
