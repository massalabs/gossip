/**
 * BrowserWorkerRuntime - Browser runtime using Web Worker + OPFS
 *
 * This runtime offloads all crypto and storage operations to a Web Worker,
 * keeping the main thread responsive.
 */

import type {
  IRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
} from '../interfaces';
import {
  StorageWorkerClient,
  type VizEvent,
} from '../backends/encrypted/StorageWorkerClient';

export class BrowserWorkerRuntime implements IRuntimeAdapter {
  readonly type = 'browser-worker' as const;
  readonly capabilities: RuntimeCapabilities = {
    hasWorker: true,
    hasOPFS: true,
    isNode: false,
    isBrowser: true,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };

  private client: StorageWorkerClient;
  private initialized = false;
  private sessionUnlocked = false;
  private eventHandlers = new Set<(event: RuntimeEvent) => void>();

  constructor(private options: { debug?: boolean } = {}) {
    this.client = new StorageWorkerClient();
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.options.debug) {
      console.log('[BrowserWorkerRuntime] Initializing...');
    }

    await this.client.start();

    // Set up event forwarding
    this.client.onVizEvent((vizEvent: VizEvent) => {
      this.emitEvent({
        type: this.mapVizEventKind(vizEvent.kind),
        timestamp: vizEvent.timestamp,
        data: {
          offset: vizEvent.offset,
          size: vizEvent.size,
          durationMs: vizEvent.durationMs,
          slotIndex: vizEvent.slotIndex,
        },
      });
    });

    if (this.options.debug) {
      this.client.onLog((message: string) => {
        console.log('[Worker]', message);
      });
    }

    this.initialized = true;

    if (this.options.debug) {
      console.log('[BrowserWorkerRuntime] Ready');
    }
  }

  async dispose(): Promise<void> {
    this.client.stop();
    this.initialized = false;
    this.sessionUnlocked = false;
    this.eventHandlers.clear();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ============ Session Management ============

  async createSession(password: string): Promise<void> {
    const result = await this.client.createSession(password);
    if (!result.success) {
      throw new Error(result.error || 'Failed to create session');
    }
    this.sessionUnlocked = true;
    this.emitEvent({
      type: 'session-change',
      timestamp: Date.now(),
      data: { action: 'create' },
    });
  }

  async unlockSession(password: string): Promise<boolean> {
    const result = await this.client.unlockSession(password);
    if (result.success) {
      this.sessionUnlocked = true;
      this.emitEvent({
        type: 'session-change',
        timestamp: Date.now(),
        data: { action: 'unlock' },
      });
    }
    return result.success;
  }

  async lockSession(): Promise<void> {
    await this.client.lockSession();
    this.sessionUnlocked = false;
    this.emitEvent({
      type: 'session-change',
      timestamp: Date.now(),
      data: { action: 'lock' },
    });
  }

  isSessionUnlocked(): boolean {
    return this.sessionUnlocked;
  }

  async changePassword(
    oldPassword: string,
    newPassword: string
  ): Promise<boolean> {
    // First verify old password by checking status
    const status = await this.client.getStatus();
    if (!status.sessionUnlocked) {
      // Try to unlock with old password
      const unlocked = await this.unlockSession(oldPassword);
      if (!unlocked) {
        return false;
      }
    }

    // Lock current session
    await this.lockSession();

    // Create new session with new password
    // Note: This loses existing data - in production, we'd need to re-encrypt
    await this.createSession(newPassword);

    return true;
  }

  // ============ Blob Persistence ============

  async readBlob(_name: string): Promise<Uint8Array | null> {
    // Blobs are handled internally by the worker via OPFS
    // This method is for external blob access if needed
    throw new Error('Direct blob access not supported in worker mode');
  }

  async writeBlob(_name: string, _data: Uint8Array): Promise<void> {
    throw new Error('Direct blob access not supported in worker mode');
  }

  async deleteBlob(_name: string): Promise<boolean> {
    throw new Error('Direct blob access not supported in worker mode');
  }

  async listBlobs(): Promise<string[]> {
    throw new Error('Direct blob access not supported in worker mode');
  }

  // ============ SQL Execution ============

  async executeSql<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    // For now, we interpolate params into the SQL
    // In production, we'd use proper prepared statements
    const finalSql = params ? this.interpolateParams(sql, params) : sql;

    const result = await this.client.exec(finalSql);
    if (!result.success) {
      throw new Error(result.error || 'SQL execution failed');
    }

    // Convert row arrays to objects if we have column info
    // For now, return raw arrays - caller must handle
    return (result.rows || []) as unknown as T[];
  }

  async runSql(
    sql: string,
    params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    const finalSql = params ? this.interpolateParams(sql, params) : sql;

    const result = await this.client.exec(finalSql);
    if (!result.success) {
      throw new Error(result.error || 'SQL execution failed');
    }

    return {
      changes: result.changes || 0,
      lastInsertRowid: result.lastInsertRowid || 0,
    };
  }

  async execBatch(
    statements: { sql: string; params?: unknown[] }[]
  ): Promise<void> {
    for (const { sql, params } of statements) {
      const finalSql = params ? this.interpolateParams(sql, params) : sql;
      const result = await this.client.exec(finalSql);
      if (!result.success) {
        throw new Error(result.error || 'Batch execution failed');
      }
    }
  }

  // ============ Events ============

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emitEvent(event: RuntimeEvent): void {
    this.eventHandlers.forEach(handler => handler(event));
  }

  private mapVizEventKind(kind: string): RuntimeEvent['type'] {
    switch (kind) {
      case 'opfs-read':
      case 'vfs-read':
        return 'blob-read';
      case 'opfs-write':
      case 'vfs-write':
        return 'blob-write';
      case 'crypto-derive':
      case 'crypto-encrypt':
      case 'crypto-decrypt':
        return 'crypto-op';
      case 'session-create':
      case 'session-unlock':
      case 'session-lock':
        return 'session-change';
      default:
        return 'sql-exec';
    }
  }

  // ============ Helpers ============

  /**
   * Simple parameter interpolation (NOT safe for production - use prepared statements)
   */
  private interpolateParams(sql: string, params: unknown[]): string {
    let index = 0;
    return sql.replace(/\?/g, () => {
      const param = params[index++];
      if (param === null || param === undefined) {
        return 'NULL';
      }
      if (typeof param === 'number') {
        return String(param);
      }
      if (typeof param === 'boolean') {
        return param ? '1' : '0';
      }
      if (param instanceof Uint8Array) {
        // Convert to hex blob
        return `X'${Array.from(param)
          .map(b => b.toString(16).padStart(2, '0'))
          .join('')}'`;
      }
      if (param instanceof Date) {
        return `'${param.toISOString()}'`;
      }
      // String - escape single quotes
      return `'${String(param).replace(/'/g, "''")}'`;
    });
  }

  /**
   * Get the underlying worker client (for advanced usage)
   */
  getClient(): StorageWorkerClient {
    return this.client;
  }
}
