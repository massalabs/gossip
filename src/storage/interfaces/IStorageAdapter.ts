/**
 * Low-level storage adapter interface for custom database implementations.
 *
 * Users can inject a custom adapter, and the SDK will build repositories on top.
 * Supports both SQL and document/KV style databases.
 */

import type { Observable } from '../base/Observable';

/**
 * Query filter for document-style databases
 */
export interface QueryFilter {
  [field: string]:
    | unknown
    | { $eq?: unknown }
    | { $ne?: unknown }
    | { $gt?: unknown }
    | { $gte?: unknown }
    | { $lt?: unknown }
    | { $lte?: unknown }
    | { $in?: unknown[] }
    | { $like?: string };
}

/**
 * Query options
 */
export interface QueryOptions {
  orderBy?: { field: string; direction: 'asc' | 'desc' }[];
  limit?: number;
  offset?: number;
}

/**
 * Low-level storage adapter interface.
 * Implement either SQL methods OR document methods (or both).
 */
export interface IStorageAdapter {
  /**
   * Adapter type identifier
   */
  readonly type: string;

  // ============ Lifecycle ============

  /**
   * Initialize the adapter
   */
  initialize(): Promise<void>;

  /**
   * Close and cleanup
   */
  close(): Promise<void>;

  // ============ SQL-style operations (for SQL databases) ============

  /**
   * Execute a SQL query
   */
  execute?<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;

  /**
   * Execute a SQL statement that doesn't return rows
   */
  run?(
    sql: string,
    params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }>;

  /**
   * Execute multiple statements in a transaction
   */
  execBatch?(statements: { sql: string; params?: unknown[] }[]): Promise<void>;

  // ============ Document-style operations (for KV/Document databases) ============

  /**
   * Get a document by key
   */
  get?<T>(collection: string, key: string): Promise<T | undefined>;

  /**
   * Put a document
   */
  put?<T>(collection: string, key: string, value: T): Promise<void>;

  /**
   * Delete a document
   */
  delete?(collection: string, key: string): Promise<boolean>;

  /**
   * Query documents
   */
  query?<T>(
    collection: string,
    filter?: QueryFilter,
    options?: QueryOptions
  ): Promise<T[]>;

  /**
   * Count documents
   */
  count?(collection: string, filter?: QueryFilter): Promise<number>;

  // ============ Transactions ============

  /**
   * Execute operations in a transaction
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  // ============ Reactivity ============

  /**
   * Observe a query for changes
   */
  observe?<T>(
    queryFn: () => Promise<T>,
    dependencies?: string[]
  ): Observable<T>;

  /**
   * Notify that a collection has changed (for custom reactivity)
   */
  notifyChange?(collection: string): void;
}

/**
 * Type guard for SQL-capable adapters
 */
export function isSqlAdapter(
  adapter: IStorageAdapter
): adapter is IStorageAdapter &
  Required<Pick<IStorageAdapter, 'execute' | 'run'>> {
  return (
    typeof adapter.execute === 'function' && typeof adapter.run === 'function'
  );
}

/**
 * Type guard for document-capable adapters
 */
export function isDocumentAdapter(
  adapter: IStorageAdapter
): adapter is IStorageAdapter &
  Required<Pick<IStorageAdapter, 'get' | 'put' | 'delete' | 'query'>> {
  return (
    typeof adapter.get === 'function' &&
    typeof adapter.put === 'function' &&
    typeof adapter.delete === 'function' &&
    typeof adapter.query === 'function'
  );
}
