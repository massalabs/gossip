/**
 * Capacitor plugin interface for native secure storage.
 *
 * On iOS/Android, the Rust secure-storage library is compiled natively
 * (not as WASM). This plugin bridges TypeScript to the native code via
 * Capacitor's plugin system, replacing the WASM web worker path.
 */

import { registerPlugin } from '@capacitor/core';

export interface SecureStorageNativePlugin {
  initSecureStorage(options: { path: string; domain: string }): Promise<void>;
  provisionStorage(): Promise<void>;
  allocateSession(options: { slot: number; password: number[] }): Promise<void>;
  unlockSession(options: {
    password: number[];
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
  flush(): Promise<void>;
  close(): Promise<void>;
  // @todo native-foundation: namespace data RPCs not yet wired through
  // the Capacitor plugin. The web worker exposes them via Comlink (see
  // `secure-storage-worker.ts`); native must mirror the surface or the
  // session-blob namespace path is unusable on iOS/Android. sqlite.ts
  // throws "not implemented on native plugin" inline until they exist.
  writeNamespaceData?(options: {
    namespace: number;
    offset: number;
    data: number[];
  }): Promise<void>;
  readNamespaceData?(options: {
    namespace: number;
    offset: number;
    length: number;
  }): Promise<{ data: number[] }>;
  namespaceDataLength?(options: {
    namespace: number;
  }): Promise<{ length: number }>;
  clearNamespace?(options: { namespace: number }): Promise<void>;
}

export const SecureStorageNative = registerPlugin<SecureStorageNativePlugin>(
  'SecureStorageNative'
);
