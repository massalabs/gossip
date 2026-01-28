/**
 * Runtime adapter interface for environment-specific operations.
 *
 * Handles the differences between:
 * - Browser with Worker + OPFS (async, non-blocking)
 * - Browser without Worker (sync, main thread)
 * - Node.js (sync, filesystem)
 *
 * The encrypted SQLite backend uses this to abstract away runtime differences.
 */

export interface RuntimeCapabilities {
  /**
   * Whether Web Workers are available
   */
  hasWorker: boolean;

  /**
   * Whether OPFS (Origin Private File System) is available
   */
  hasOPFS: boolean;

  /**
   * Whether running in Node.js
   */
  isNode: boolean;

  /**
   * Whether running in a browser
   */
  isBrowser: boolean;

  /**
   * Whether SharedArrayBuffer is available (for Atomics)
   */
  hasSharedArrayBuffer: boolean;
}

export interface IRuntimeAdapter {
  /**
   * Runtime capabilities
   */
  readonly capabilities: RuntimeCapabilities;

  /**
   * Runtime identifier
   */
  readonly type: 'browser-worker' | 'browser-sync' | 'node';

  // ============ Lifecycle ============

  /**
   * Initialize the runtime (load WASM, start worker, etc.)
   */
  initialize(): Promise<void>;

  /**
   * Cleanup resources
   */
  dispose(): Promise<void>;

  /**
   * Check if initialized
   */
  isInitialized(): boolean;

  // ============ WASM Crypto (Plausible Deniability) ============

  /**
   * Create a new encrypted session
   */
  createSession(password: string): Promise<void>;

  /**
   * Unlock an existing session
   */
  unlockSession(password: string): Promise<boolean>;

  /**
   * Lock the session (clear keys)
   */
  lockSession(): Promise<void>;

  /**
   * Check if session is unlocked
   */
  isSessionUnlocked(): boolean;

  /**
   * Change session password
   */
  changePassword(oldPassword: string, newPassword: string): Promise<boolean>;

  // ============ Blob Persistence ============

  /**
   * Read a blob from persistent storage
   */
  readBlob(name: string): Promise<Uint8Array | null>;

  /**
   * Write a blob to persistent storage
   */
  writeBlob(name: string, data: Uint8Array): Promise<void>;

  /**
   * Delete a blob
   */
  deleteBlob(name: string): Promise<boolean>;

  /**
   * List all blob names
   */
  listBlobs(): Promise<string[]>;

  // ============ SQLite Execution ============

  /**
   * Execute a SQL query and return results
   */
  executeSql<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;

  /**
   * Execute a SQL statement that modifies data
   */
  runSql(
    sql: string,
    params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }>;

  /**
   * Execute multiple statements in a batch
   */
  execBatch(statements: { sql: string; params?: unknown[] }[]): Promise<void>;

  // ============ Events ============

  /**
   * Subscribe to runtime events (for debugging/visualization)
   */
  onEvent?(handler: (event: RuntimeEvent) => void): () => void;
}

/**
 * Runtime events for debugging and visualization
 */
export interface RuntimeEvent {
  type:
    | 'blob-read'
    | 'blob-write'
    | 'sql-exec'
    | 'crypto-op'
    | 'session-change';
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * Factory function type for creating runtime adapters
 */
export type RuntimeAdapterFactory = (options?: {
  dbPath?: string;
  debug?: boolean;
}) => Promise<IRuntimeAdapter>;
