/* tslint:disable */
/* eslint-disable */
export function initSecureStorage(domain: string, backend: string): Promise<void>;
export function idbHasData(): Promise<boolean>;
export function provisionStorage(): void;
export function allocateSession(slot: number, password: Uint8Array): void;
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
export function unlockSession(password: Uint8Array): boolean;
export function lockSession(): void;
export function coverTrafficTick(namespace: number): void;
export function writeNamespaceData(namespace: number, offset: number, data: Uint8Array): void;
export function readNamespaceData(namespace: number, offset: number, len: number): Uint8Array;
export function namespaceDataLength(namespace: number): number;
export function clearNamespace(namespace: number): void;
export function flushEncrypted(): Promise<void>;
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
  readonly allocateSession: (a: number, b: number, c: number) => [number, number];
  readonly clearNamespace: (a: number) => [number, number];
  readonly closeDatabase: () => [number, number];
  readonly coverTrafficTick: (a: number) => [number, number];
  readonly execSql: (a: number, b: number, c: any) => [number, number, number];
  readonly execresult_lastInsertRowId: (a: number) => number;
  readonly execresult_rows: (a: number) => any;
  readonly flushEncrypted: () => any;
  readonly idbHasData: () => any;
  readonly initSecureStorage: (a: number, b: number, c: number, d: number) => any;
  readonly lockSession: () => [number, number];
  readonly namespaceDataLength: (a: number) => [number, number, number];
  readonly openDatabase: () => [number, number];
  readonly provisionStorage: () => [number, number];
  readonly readNamespaceData: (a: number, b: number, c: number) => [number, number, number, number];
  readonly unlockSession: (a: number, b: number) => [number, number, number];
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
  readonly closure112_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure678_externref_shim: (a: number, b: number, c: any) => void;
  readonly wasm_bindgen_3f82e0ab9dbbc377___convert__closures_____invoke______: (a: number, b: number) => void;
  readonly closure72_externref_shim_multivalue_shim: (a: number, b: number, c: any) => [number, number];
  readonly closure723_externref_shim: (a: number, b: number, c: any, d: any) => void;
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
