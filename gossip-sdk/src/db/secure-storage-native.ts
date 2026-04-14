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

  // Namespace data API - parity with the WASM worker. Enables the SDK
  // to persist the session blob on the native path without going
  // through the SQL VFS.
  writeNamespaceData(options: {
    namespace: number;
    offset: number;
    data: number[];
  }): Promise<void>;
  readNamespaceData(options: {
    namespace: number;
    offset: number;
    len: number;
  }): Promise<{ data: number[] }>;
  namespaceDataLength(options: {
    namespace: number;
  }): Promise<{ length: number }>;
  clearNamespace(options: { namespace: number }): Promise<void>;
}

export const SecureStorageNative = registerPlugin<SecureStorageNativePlugin>(
  'SecureStorageNative'
);
