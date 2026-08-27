/* tslint:disable */
/* eslint-disable */
export function initSecureStorage(domain: string, backend: string): Promise<void>;
export function writeNamespaceData(namespace: number, offset: number, data: Uint8Array): void;
export function readNamespaceData(namespace: number, offset: number, len: number): Uint8Array;
export function namespaceDataLength(namespace: number): number;
export function clearNamespace(namespace: number): void;
/**
 * Verify that this worker still owns the active IndexedDB generation.
 */
export function verifyStorageGeneration(): Promise<void>;
/**
 * Called by the worker when an allocation or destruction transaction rejects.
 * This prevents a later cover-traffic flush from durably carrying the failed
 * lifecycle operation. The recovered state is always locked.
 */
export function reloadDurableStorage(): Promise<void>;
/**
 * Abandon a poisoned SQLite transaction and restore its last durable image
 * while retaining the current unlocked session keys. No pending VFS bytes are
 * flushed: closing SQLite rolls back its in-memory journal, then the IndexedDB
 * cache is reloaded before a fresh database handle is opened.
 */
export function resetSqlDatabaseToDurable(): Promise<void>;
export function flushEncrypted(): Promise<void>;
export function openDatabase(): void;
export function closeDatabase(): void;
/**
 * Run a SQL statement with bound parameters.
 *
 * `params` is a JS array of values; supported types are number, string,
 * Uint8Array, null, and bigint. Returns rows as a JS array of arrays
 * (positional column values), matching the Drizzle sqlite-proxy contract.
 */
export function execSql(sql: string, params: Array<any>): ExecResult;
/**
 * Replace this terminal worker's active backend with an isolated in-memory
 * portable candidate and authenticate its keypairs without exposing the
 * matched slot to JavaScript.
 */
export function beginCandidatePreview(domain: string, password: Uint8Array, keypairs: Array<any>): boolean;
/**
 * Admit one canonical candidate block. Only namespace 0 blocks belonging to
 * the internally authenticated slot are retained; callers never learn which
 * slot matched.
 */
export function appendCandidatePreviewBlock(slot: number, namespace: number, block_index: number, data: Uint8Array): void;
/**
 * Load the candidate namespace length and open SQLite without write authority.
 */
export function finishCandidatePreview(): void;
export function idbHasData(): Promise<boolean>;
export function provisionStorage(): void;
export function allocateSession(slot: number, password: Uint8Array): void;
export function unlockSession(password: Uint8Array): boolean;
export function lockSession(): void;
/**
 * Permanently destroy the data of the currently unlocked slot.
 *
 * The actual writes (new dummy keypair + cover blocks) land in
 * IdbBlockStorage's in-memory pending state. Durability comes from
 * the caller's subsequent `flushEncrypted()` await — same pattern
 * the worker uses for `lockSession`. A process crash before that
 * flush rolls everything back: the IDB on-disk state is unchanged,
 * the slot is left exactly as it was.
 *
 * **The caller must `closeDatabase()` first** so SQLite's xWrite
 * flush on close lands in the buffer before destroy_session truncates
 * the namespace. Mirrors `lockSession`'s contract.
 */
export function destroySession(namespaces: Uint8Array): void;
export function coverTrafficTick(namespace: number): void;
/**
 * Strictly validate one version-1 logical keypair record without unlocking it.
 * Browser streaming export/import uses this bounded bridge so TypeScript never
 * reimplements pq-rerand's canonical parser.
 */
export function validatePortableKeypair(value: Uint8Array): void;
/**
 * Strictly validate one version-1 encrypted block record.
 */
export function validatePortableBlock(value: Uint8Array): void;
/**
 * Project only bounded public profile fields inside WASM. The security JSON
 * is validated and zeroized in Rust and never crosses the worker bridge.
 */
export function queryCandidatePreview(): any;
export function endCandidatePreview(): Promise<void>;
/**
 * Begin password admission for one validated candidate. Only opaque plan
 * state is retained; no transformed/mixed-version generation is emitted.
 */
export function beginOuterMigration(domain: string, keypairs: Array<any>): void;
/**
 * Admit one password with all-slot constant work. The owned WASM copy is
 * zeroized before return and a generic false discloses no matched slot.
 */
export function admitOuterMigrationPassword(password: Uint8Array): boolean;
/**
 * Generate fresh current-suite keypairs for all slots at once. Every public
 * key changes, so comparing source and destination cannot reveal selection.
 */
export function finalizeOuterMigration(): Array<any>;
/**
 * Transform one complete fixed-slot block coordinate.
 */
export function migrateOuterBlockBatch(namespace: number, block_index: number, values: Array<any>): Array<any>;
export function finishOuterMigrationNamespace(namespace: number, source_block_count: number): void;
export function endOuterMigration(): void;
export function initThreadPool(num_threads: number): Promise<any>;
export function wbg_rayon_start_worker(receiver: number): void;
/**
 * Result of an `execSql` call.
 *
 * `last_insert_rowid` is `f64` (not `i64`) because it crosses the JS bridge
 * and JS has no native i64 — its `Number` type is f64. SQLite rowids are
 * sequential and stay within JS's safe integer range (2^53) in practice,
 * so the conversion is lossless.
 */
export class ExecResult {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  readonly lastInsertRowId: number;
  readonly rows: Array<any>;
}
export class wbg_rayon_PoolBuilder {
  private constructor();
  free(): void;
  [Symbol.dispose](): void;
  numThreads(): number;
  build(): void;
  receiver(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly __wbg_execresult_free: (a: number, b: number) => void;
  readonly admitOuterMigrationPassword: (a: number, b: number) => [number, number, number];
  readonly allocateSession: (a: number, b: number, c: number) => [number, number];
  readonly appendCandidatePreviewBlock: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly beginCandidatePreview: (a: number, b: number, c: number, d: number, e: any) => [number, number, number];
  readonly beginOuterMigration: (a: number, b: number, c: any) => [number, number];
  readonly clearNamespace: (a: number) => [number, number];
  readonly closeDatabase: () => [number, number];
  readonly coverTrafficTick: (a: number) => [number, number];
  readonly destroySession: (a: number, b: number) => [number, number];
  readonly endCandidatePreview: () => any;
  readonly endOuterMigration: () => void;
  readonly execSql: (a: number, b: number, c: any) => [number, number, number];
  readonly execresult_lastInsertRowId: (a: number) => number;
  readonly execresult_rows: (a: number) => any;
  readonly finalizeOuterMigration: () => [number, number, number];
  readonly finishCandidatePreview: () => [number, number];
  readonly finishOuterMigrationNamespace: (a: number, b: number) => [number, number];
  readonly flushEncrypted: () => any;
  readonly idbHasData: () => any;
  readonly initSecureStorage: (a: number, b: number, c: number, d: number) => any;
  readonly lockSession: () => [number, number];
  readonly migrateOuterBlockBatch: (a: number, b: number, c: any) => [number, number, number];
  readonly namespaceDataLength: (a: number) => [number, number, number];
  readonly openDatabase: () => [number, number];
  readonly provisionStorage: () => [number, number];
  readonly queryCandidatePreview: () => [number, number, number];
  readonly readNamespaceData: (a: number, b: number, c: number) => [number, number, number, number];
  readonly reloadDurableStorage: () => any;
  readonly resetSqlDatabaseToDurable: () => any;
  readonly unlockSession: (a: number, b: number) => [number, number, number];
  readonly validatePortableBlock: (a: number, b: number) => [number, number];
  readonly validatePortableKeypair: (a: number, b: number) => [number, number];
  readonly verifyStorageGeneration: () => any;
  readonly writeNamespaceData: (a: number, b: number, c: number, d: number) => [number, number];
  readonly __wbg_wbg_rayon_poolbuilder_free: (a: number, b: number) => void;
  readonly initThreadPool: (a: number) => any;
  readonly wbg_rayon_poolbuilder_build: (a: number) => void;
  readonly wbg_rayon_poolbuilder_numThreads: (a: number) => number;
  readonly wbg_rayon_poolbuilder_receiver: (a: number) => number;
  readonly wbg_rayon_start_worker: (a: number) => void;
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
  readonly memory: WebAssembly.Memory;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_export_7: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly closure69_externref_shim_multivalue_shim: (a: number, b: number, c: any) => [number, number];
  readonly wasm_bindgen_c8f7f980e6f4097b___convert__closures_____invoke______: (a: number, b: number) => void;
  readonly closure698_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure123_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure754_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_thread_destroy: (a?: number, b?: number, c?: number) => void;
  readonly __wbindgen_start: (a: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number }} module - Passing `SyncInitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput, memory?: WebAssembly.Memory, thread_stack_size?: number } | SyncInitInput, memory?: WebAssembly.Memory): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number }} module_or_path - Passing `InitInput` directly is deprecated.
* @param {WebAssembly.Memory} memory - Deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput>, memory?: WebAssembly.Memory, thread_stack_size?: number } | InitInput | Promise<InitInput>, memory?: WebAssembly.Memory): Promise<InitOutput>;
