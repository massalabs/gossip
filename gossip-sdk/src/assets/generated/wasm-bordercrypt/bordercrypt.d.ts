/* tslint:disable */
/* eslint-disable */
/**
 * Close the database and release resources.
 */
export function closeDatabase(): void;
/**
 * Flush encrypted data to backing store (IDB or OPFS).
 */
export function flushEncrypted(): Promise<void>;
/**
 * Flush pending writes to IndexedDB (non-encrypted IDB VFS).
 */
export function flushIdb(): Promise<void>;
/**
 * Initialise bordercrypt encrypted storage.
 *
 * `backend`: `"memory"` (no persistence), `"idb"`, or `"opfs"`.
 */
export function initBordercrypt(domain: string, backend: string): Promise<void>;
/**
 * Run one round of cover traffic.
 */
export function coverTrafficTick(): void;
/**
 * Initialise a non-encrypted database on the given backend.
 *
 * `backend`: `"memory"` or `"idb"`.
 */
export function initDatabase(backend: string): Promise<void>;
/**
 * Lock the session: close SQLite, flush to backing store, zeroize keys.
 */
export function lockSession(): Promise<void>;
/**
 * Allocate a session in `slot` with `password`, open SQLite.
 */
export function allocateSession(slot: number, password: Uint8Array): void;
/**
 * Execute a SQL statement with bind parameters.
 *
 * `params` is a JS `Array` of values (null, number, string, Uint8Array).
 * Returns `{ columns, rows, lastInsertRowId, changes }`.
 */
export function execute(sql: string, params: any): any;
/**
 * Provision all 5 session slots.
 */
export function provisionStorage(): void;
/**
 * Unlock a session by password, open SQLite. Returns false if wrong password.
 */
export function unlockSession(password: Uint8Array): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly allocateSession: (a: number, b: number, c: number) => [number, number];
  readonly closeDatabase: () => [number, number];
  readonly coverTrafficTick: () => [number, number];
  readonly execute: (a: number, b: number, c: any) => [number, number, number];
  readonly flushEncrypted: () => any;
  readonly flushIdb: () => any;
  readonly initBordercrypt: (a: number, b: number, c: number, d: number) => any;
  readonly initDatabase: (a: number, b: number) => any;
  readonly lockSession: () => any;
  readonly provisionStorage: () => [number, number];
  readonly unlockSession: (a: number, b: number) => [number, number, number];
  readonly rust_sqlite_wasm_abort: () => void;
  readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
  readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
  readonly rust_sqlite_wasm_free: (a: number) => void;
  readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
  readonly rust_sqlite_wasm_localtime: (a: number) => number;
  readonly rust_sqlite_wasm_malloc: (a: number) => number;
  readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
  readonly sqlite3_os_end: () => number;
  readonly sqlite3_os_init: () => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_6: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure685_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure709_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
