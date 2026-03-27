/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const allocateSession: (
  a: number,
  b: number,
  c: number
) => [number, number];
export const closeDatabase: () => [number, number];
export const coverTrafficTick: () => [number, number];
export const execute: (
  a: number,
  b: number,
  c: any
) => [number, number, number];
export const flushEncrypted: () => any;
export const flushIdb: () => any;
export const initBordercrypt: (
  a: number,
  b: number,
  c: number,
  d: number
) => any;
export const initDatabase: (a: number, b: number) => any;
export const lockSession: () => any;
export const provisionStorage: () => [number, number];
export const unlockSession: (a: number, b: number) => [number, number, number];
export const rust_sqlite_wasm_abort: () => void;
export const rust_sqlite_wasm_assert_fail: (
  a: number,
  b: number,
  c: number,
  d: number
) => void;
export const rust_sqlite_wasm_calloc: (a: number, b: number) => number;
export const rust_sqlite_wasm_free: (a: number) => void;
export const rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
export const rust_sqlite_wasm_localtime: (a: number) => number;
export const rust_sqlite_wasm_malloc: (a: number) => number;
export const rust_sqlite_wasm_realloc: (a: number, b: number) => number;
export const sqlite3_os_end: () => number;
export const sqlite3_os_init: () => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_export_2: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (
  a: number,
  b: number,
  c: number,
  d: number
) => number;
export const __wbindgen_export_6: WebAssembly.Table;
export const __externref_table_dealloc: (a: number) => void;
export const closure685_externref_shim: (a: number, b: number, c: any) => void;
export const closure709_externref_shim: (
  a: number,
  b: number,
  c: any,
  d: any
) => void;
export const __wbindgen_start: () => void;
