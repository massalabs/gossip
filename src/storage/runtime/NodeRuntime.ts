/**
 * NodeRuntime - Node.js runtime using better-sqlite3 + filesystem
 *
 * This runtime runs synchronously in Node.js, using:
 * - better-sqlite3 for SQLite operations
 * - Node.js fs for blob persistence
 * - The same Rust WASM module for encryption
 *
 * Note: This is a stub implementation. The actual implementation requires:
 * 1. Installing better-sqlite3: npm install better-sqlite3
 * 2. Loading the WASM module in Node.js context
 * 3. Implementing filesystem-based blob storage
 */

import type {
  IRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
} from '../interfaces';

export interface NodeRuntimeOptions {
  /**
   * Directory for storing database files
   */
  dbPath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

export class NodeRuntime implements IRuntimeAdapter {
  readonly type = 'node' as const;
  readonly capabilities: RuntimeCapabilities = {
    hasWorker: false,
    hasOPFS: false,
    isNode: true,
    isBrowser: false,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };

  private initialized = false;
  private sessionUnlocked = false;
  private eventHandlers = new Set<(event: RuntimeEvent) => void>();
  private dbPath: string;
  private debug: boolean;

  // These will be initialized when better-sqlite3 and WASM are loaded
  private db: unknown = null;
  private wasmModule: unknown = null;

  constructor(options: NodeRuntimeOptions = {}) {
    this.dbPath = options.dbPath || './gossip-storage';
    this.debug = options.debug || false;
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (this.debug) {
      console.log('[NodeRuntime] Initializing...');
      console.log('[NodeRuntime] Database path:', this.dbPath);
    }

    // Dynamically import Node.js modules
    try {
      // Import fs and path
      const fs = await import('fs');
      const path = await import('path');

      // Ensure storage directory exists
      const storageDir = path.resolve(this.dbPath);
      if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
      }

      // Try to import better-sqlite3
      // This will fail if not installed, which is expected in browser bundles
      try {
        // @ts-expect-error - better-sqlite3 is optional Node.js dependency
        const Database = (await import('better-sqlite3')).default;
        const dbFile = path.join(storageDir, 'gossip.db');
        this.db = new Database(dbFile);
        if (this.debug) {
          console.log('[NodeRuntime] better-sqlite3 loaded, database:', dbFile);
        }
      } catch (_) {
        // Fallback: try sql.js (pure JS SQLite)
        if (this.debug) {
          console.log(
            '[NodeRuntime] better-sqlite3 not available, trying sql.js...'
          );
        }
        try {
          // @ts-expect-error - sql.js is optional Node.js dependency
          const initSqlJs = (await import('sql.js')).default;
          const SQL = await initSqlJs();
          this.db = new SQL.Database();
          if (this.debug) {
            console.log('[NodeRuntime] sql.js loaded (in-memory mode)');
          }
        } catch (_) {
          throw new Error(
            'Neither better-sqlite3 nor sql.js available. Install one: npm install better-sqlite3'
          );
        }
      }

      // Load WASM module
      // In Node.js, we need to load the WASM differently
      try {
        // The WASM module path - adjust based on your build setup
        const wasmPath = path.join(
          process.cwd(),
          'gossip-storage/ts/generated/gossip_storage_bg.wasm'
        );

        if (fs.existsSync(wasmPath)) {
          const wasmBuffer = fs.readFileSync(wasmPath);
          // Initialize WASM (implementation depends on how wasm-bindgen output is structured)
          // This is a placeholder - actual implementation needs wasm-bindgen Node.js bindings
          if (this.debug) {
            console.log('[NodeRuntime] WASM found at:', wasmPath);
          }
          this.wasmModule = wasmBuffer; // Placeholder
        } else {
          if (this.debug) {
            console.warn('[NodeRuntime] WASM not found, encryption disabled');
          }
        }
      } catch (e) {
        if (this.debug) {
          console.warn('[NodeRuntime] Failed to load WASM:', e);
        }
      }

      this.initialized = true;

      if (this.debug) {
        console.log('[NodeRuntime] Ready');
      }
    } catch (error) {
      throw new Error(`NodeRuntime initialization failed: ${error}`);
    }
  }

  async dispose(): Promise<void> {
    if (
      this.db &&
      typeof (this.db as { close?: () => void }).close === 'function'
    ) {
      (this.db as { close: () => void }).close();
    }
    this.db = null;
    this.wasmModule = null;
    this.initialized = false;
    this.sessionUnlocked = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ============ Session Management ============

  async createSession(_password: string): Promise<void> {
    if (!this.wasmModule) {
      // Without WASM, we can't do encryption
      // For now, just mark session as unlocked (unencrypted mode)
      if (this.debug) {
        console.warn(
          '[NodeRuntime] No WASM module - running in unencrypted mode'
        );
      }
      this.sessionUnlocked = true;
      return;
    }

    // TODO: Call WASM createSession
    // This requires proper wasm-bindgen Node.js integration
    throw new Error('WASM session creation not yet implemented for Node.js');
  }

  async unlockSession(_password: string): Promise<boolean> {
    if (!this.wasmModule) {
      // Without WASM, auto-unlock
      this.sessionUnlocked = true;
      return true;
    }

    // TODO: Call WASM unlockSession
    throw new Error('WASM session unlock not yet implemented for Node.js');
  }

  async lockSession(): Promise<void> {
    this.sessionUnlocked = false;
    // TODO: Call WASM lockSession if available
  }

  isSessionUnlocked(): boolean {
    return this.sessionUnlocked;
  }

  async changePassword(
    _oldPassword: string,
    _newPassword: string
  ): Promise<boolean> {
    throw new Error('Password change not yet implemented for Node.js');
  }

  // ============ Blob Persistence ============

  async readBlob(name: string): Promise<Uint8Array | null> {
    const fs = await import('fs');
    const path = await import('path');

    const filePath = path.join(this.dbPath, name);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const buffer = fs.readFileSync(filePath);
    return new Uint8Array(buffer);
  }

  async writeBlob(name: string, data: Uint8Array): Promise<void> {
    const fs = await import('fs');
    const path = await import('path');

    const filePath = path.join(this.dbPath, name);
    fs.writeFileSync(filePath, data);
  }

  async deleteBlob(name: string): Promise<boolean> {
    const fs = await import('fs');
    const path = await import('path');

    const filePath = path.join(this.dbPath, name);
    if (!fs.existsSync(filePath)) {
      return false;
    }

    fs.unlinkSync(filePath);
    return true;
  }

  async listBlobs(): Promise<string[]> {
    const fs = await import('fs');
    const path = await import('path');

    const storageDir = path.resolve(this.dbPath);
    if (!fs.existsSync(storageDir)) {
      return [];
    }

    return fs.readdirSync(storageDir).filter(f => f.endsWith('.bin'));
  }

  // ============ SQL Execution ============

  async executeSql<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]> {
    this.ensureReady();

    // Handle both better-sqlite3 and sql.js APIs
    const db = this.db as {
      prepare?: (sql: string) => { all: (params?: unknown[]) => T[] };
      exec?: (sql: string) => { values: unknown[][] }[];
    };

    if (db.prepare) {
      // better-sqlite3 API
      const stmt = db.prepare(sql);
      return stmt.all(params);
    } else if (db.exec) {
      // sql.js API
      const results = db.exec(sql);
      if (results.length === 0) return [];
      // Convert to objects (sql.js returns array of values)
      return results[0].values as unknown as T[];
    }

    throw new Error('Unknown database API');
  }

  async runSql(
    sql: string,
    params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    this.ensureReady();

    const db = this.db as {
      prepare?: (sql: string) => {
        run: (params?: unknown[]) => {
          changes: number;
          lastInsertRowid: number | bigint;
        };
      };
      run?: (sql: string) => void;
    };

    if (db.prepare) {
      // better-sqlite3 API
      const stmt = db.prepare(sql);
      const result = stmt.run(params);
      return {
        changes: result.changes,
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    } else if (db.run) {
      // sql.js API (limited info)
      db.run(sql);
      return { changes: 0, lastInsertRowid: 0 };
    }

    throw new Error('Unknown database API');
  }

  async execBatch(
    statements: { sql: string; params?: unknown[] }[]
  ): Promise<void> {
    for (const { sql, params } of statements) {
      await this.runSql(sql, params);
    }
  }

  // ============ Events ============

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  // ============ Helpers ============

  private ensureReady(): void {
    if (!this.initialized) {
      throw new Error('NodeRuntime not initialized');
    }
    if (!this.db) {
      throw new Error('Database not loaded');
    }
  }
}
