/* tslint:disable */

export const memory: WebAssembly.Memory;
export const createSession: (a: number, b: number) => number;
export const flushData: () => number;
export const getRootLength: () => number;
export const getWasmVersion: () => [number, number];
export const init: () => void;
export const initStorage: () => void;
export const isSessionUnlocked: () => number;
export const lockSession: () => void;
export const readData: (a: bigint, b: number) => [number, number];
export const spikeTestSyncCalls: () => number;
export const unlockSession: (a: number, b: number) => number;
export const writeData: (a: bigint, b: number, c: number) => number;
export const getDataSize: () => bigint;
export const getRootAddress: () => bigint;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (
  a: number,
  b: number,
  c: number,
  d: number
) => number;
export const __wbindgen_start: () => void;
