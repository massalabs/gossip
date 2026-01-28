/* tslint:disable */

/**
 * Create a new session with the given password
 * Returns true on success, false on failure
 */
export function createSession(password: string): boolean;

/**
 * Flush data blob to disk
 */
export function flushData(): boolean;

/**
 * Get the current size of the data blob
 */
export function getDataSize(): bigint;

/**
 * Get the root block address (for debugging)
 */
export function getRootAddress(): bigint;

/**
 * Get the root block length (for debugging)
 */
export function getRootLength(): number;

/**
 * Get WASM module version (for verification)
 */
export function getWasmVersion(): string;

/**
 * Initialize panic hook for better error messages
 */
export function init(): void;

/**
 * Initialize storage with random data (2MB addressing blob)
 * Must be called before any session operations
 */
export function initStorage(): void;

/**
 * Check if a session is currently unlocked
 */
export function isSessionUnlocked(): boolean;

/**
 * Lock the current session (zeroizes keys)
 */
export function lockSession(): void;

/**
 * Read bytes from the data blob at the given offset
 * Used by Custom VFS for SQLite page reads
 * Returns empty array if session is locked
 */
export function readData(offset: bigint, len: number): Uint8Array;

/**
 * Test function for spike 0.3 - validates sync JS calls from WASM
 * Returns true if all tests pass
 */
export function spikeTestSyncCalls(): boolean;

/**
 * Unlock an existing session with the given password
 * Returns true on success, false on failure (wrong password)
 */
export function unlockSession(password: string): boolean;

/**
 * Write bytes to the data blob at the given offset
 * Used by Custom VFS for SQLite page writes
 * Returns true on success, false if session is locked
 */
export function writeData(offset: bigint, data: Uint8Array): boolean;

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly createSession: (a: number, b: number) => number;
  readonly flushData: () => number;
  readonly getRootLength: () => number;
  readonly getWasmVersion: () => [number, number];
  readonly init: () => void;
  readonly initStorage: () => void;
  readonly isSessionUnlocked: () => number;
  readonly lockSession: () => void;
  readonly readData: (a: bigint, b: number) => [number, number];
  readonly spikeTestSyncCalls: () => number;
  readonly unlockSession: (a: number, b: number) => number;
  readonly writeData: (a: bigint, b: number, c: number) => number;
  readonly getDataSize: () => bigint;
  readonly getRootAddress: () => bigint;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_externrefs: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (
    a: number,
    b: number,
    c: number,
    d: number
  ) => number;
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
export function initSync(
  module: { module: SyncInitInput } | SyncInitInput
): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init(
  module_or_path?:
    | { module_or_path: InitInput | Promise<InitInput> }
    | InitInput
    | Promise<InitInput>
): Promise<InitOutput>;
