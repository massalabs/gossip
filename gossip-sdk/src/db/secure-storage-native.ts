/**
 * Stub for the native secure-storage Capacitor plugin.
 *
 * The real implementation arrives in the native-foundation branch.
 * This stub satisfies the type-only import and the dynamic import()
 * in sqlite.ts (which is wrapped in a try/catch).
 *
 * We avoid a `Proxy`-on-`get` trap here: `typeof x === 'object'` and
 * other feature-detection patterns read hidden properties that would
 * otherwise throw. Exposing a plain object with methods that throw
 * keeps feature-detection safe while still surfacing a clear error if
 * any method is actually invoked.
 */

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

function unavailable(): never {
  throw new Error(
    'SecureStorageNative plugin is not available on web/JSDOM. ' +
      'Route through the WASM worker (secure-storage-worker.ts) or ' +
      'check `Capacitor.isNativePlatform()` before calling into native.'
  );
}

export const SecureStorageNative: SecureStorageNativePlugin = {
  initSecureStorage: unavailable,
  provisionStorage: unavailable,
  allocateSession: unavailable,
  unlockSession: unavailable,
  lockSession: unavailable,
  isUnlocked: unavailable,
  coverTrafficTick: unavailable,
  execSql: unavailable,
  flush: unavailable,
  close: unavailable,
};
