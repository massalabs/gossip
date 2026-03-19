/* tslint:disable */

/**
 * Get the total stored data size in bytes.
 */
export function getDataSize(): number;
/**
 * Run one round of cover traffic (rerandomize a random block).
 */
export function coverTrafficTick(): void;
/**
 * Lock the current session, zeroizing all secret key material.
 */
export function lockSession(): void;
/**
 * Try to unlock a session with the given password.
 *
 * Returns `true` if a session was unlocked, `false` if no matching session.
 */
export function unlockSession(password: Uint8Array): boolean;
/**
 * Initialize bordercrypt with a domain string for KDF separation.
 *
 * Must be called before any other bordercrypt function.
 */
export function initBordercrypt(domain: string): void;
/**
 * Allocate a session in the given slot with a password.
 *
 * The session is automatically unlocked after allocation.
 */
export function allocateSession(slot: number, password: Uint8Array): void;
/**
 * Provision all 5 session slots with valid but non-unlockable keypairs.
 */
export function provisionStorage(): void;
/**
 * Check if a session is currently unlocked.
 */
export function isUnlocked(): boolean;
/**
 * Read decrypted data at the given byte offset.
 */
export function readData(offset: number, len: number): Uint8Array;
/**
 * Write data at the given byte offset (encrypts all sessions).
 */
export function writeData(offset: number, data: Uint8Array): void;
export function start(): void;

export type InitInput =
  | RequestInfo
  | URL
  | Response
  | BufferSource
  | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly allocateSession: (
    a: number,
    b: number,
    c: number
  ) => [number, number];
  readonly coverTrafficTick: () => [number, number];
  readonly getDataSize: () => [number, number, number];
  readonly initBordercrypt: (a: number, b: number) => void;
  readonly isUnlocked: () => number;
  readonly lockSession: () => void;
  readonly provisionStorage: () => [number, number];
  readonly readData: (a: number, b: number) => [number, number, number, number];
  readonly start: () => void;
  readonly unlockSession: (a: number, b: number) => [number, number, number];
  readonly writeData: (a: number, b: number, c: number) => [number, number];
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_3: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_realloc: (
    a: number,
    b: number,
    c: number,
    d: number
  ) => number;
  readonly __externref_table_dealloc: (a: number) => void;
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
