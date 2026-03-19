/* tslint:disable */

export const memory: WebAssembly.Memory;
export const allocateSession: (
  a: number,
  b: number,
  c: number
) => [number, number];
export const coverTrafficTick: () => [number, number];
export const getDataSize: () => [number, number, number];
export const initBordercrypt: (a: number, b: number) => void;
export const isUnlocked: () => number;
export const lockSession: () => void;
export const provisionStorage: () => [number, number];
export const readData: (
  a: number,
  b: number
) => [number, number, number, number];
export const start: () => void;
export const unlockSession: (a: number, b: number) => [number, number, number];
export const writeData: (a: number, b: number, c: number) => [number, number];
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_export_3: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_realloc: (
  a: number,
  b: number,
  c: number,
  d: number
) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
