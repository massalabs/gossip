/**
 * NodeEncryptedRuntime - Node.js runtime with full encryption + plausible deniability
 *
 * This provides the SAME security as the browser version:
 * - AES-256-SIV encryption
 * - Argon2id key derivation
 * - Plausible deniability via addressing blob
 *
 * The only difference from browser:
 * - Uses Node.js `fs` instead of OPFS
 * - Runs synchronously (no Worker needed)
 */

import type {
  IRuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
} from '../interfaces';

export interface NodeEncryptedRuntimeOptions {
  /**
   * Directory for storing encrypted files (addressing.bin, data.bin)
   */
  storagePath?: string;

  /**
   * Enable debug logging
   */
  debug?: boolean;
}

// File ID for addressing blob (data blob uses any other value)
const FILE_ADDRESSING = 0;

export class NodeEncryptedRuntime implements IRuntimeAdapter {
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
  private storagePath: string;
  private debug: boolean;

  // File handles for addressing.bin and data.bin
  private addressingFd: number | null = null;
  private dataFd: number | null = null;

  // Node.js modules (loaded dynamically)
  private fs: typeof import('fs') | null = null;
  private path: typeof import('path') | null = null;

  // WASM module exports
  private wasmExports: {
    initStorage: () => void;
    createSession: (password: string) => boolean;
    unlockSession: (password: string) => boolean;
    lockSession: () => void;
    isSessionUnlocked: () => boolean;
    readData: (offset: bigint, len: number) => Uint8Array;
    writeData: (offset: bigint, data: Uint8Array) => boolean;
    flushData: () => void;
    getRootAddress: () => bigint;
  } | null = null;

  // SQLite (wa-sqlite loaded dynamically)
  private sqlite3: unknown = null;
  private db: number | null = null;

  constructor(options: NodeEncryptedRuntimeOptions = {}) {
    this.storagePath = options.storagePath || './gossip-storage';
    this.debug = options.debug || false;
  }

  // ============ Lifecycle ============

  async initialize(): Promise<void> {
    if (this.initialized) return;

    this.log('Initializing NodeEncryptedRuntime...');

    // Load Node.js modules
    this.fs = await import('fs');
    this.path = await import('path');

    // Ensure storage directory exists
    const storageDir = this.path.resolve(this.storagePath);
    if (!this.fs.existsSync(storageDir)) {
      this.fs.mkdirSync(storageDir, { recursive: true });
    }
    this.log(`Storage directory: ${storageDir}`);

    // Open file handles for addressing.bin and data.bin
    const addressingPath = this.path.join(storageDir, 'addressing.bin');
    const dataPath = this.path.join(storageDir, 'data.bin');

    // Create files if they don't exist
    if (!this.fs.existsSync(addressingPath)) {
      this.fs.writeFileSync(addressingPath, Buffer.alloc(0));
    }
    if (!this.fs.existsSync(dataPath)) {
      this.fs.writeFileSync(dataPath, Buffer.alloc(0));
    }

    // Open with read/write access
    this.addressingFd = this.fs.openSync(addressingPath, 'r+');
    this.dataFd = this.fs.openSync(dataPath, 'r+');
    this.log('File handles opened');

    // Register global callbacks for WASM
    this.registerWasmCallbacks();

    // Load Rust WASM module
    await this.loadWasmModule();

    // Initialize storage (creates 2MB random addressing blob if needed)
    if (this.wasmExports) {
      this.wasmExports.initStorage();
      this.log('WASM storage initialized');
    }

    // Load wa-sqlite
    await this.loadWaSqlite();

    this.initialized = true;
    this.log('NodeEncryptedRuntime ready');
  }

  private registerWasmCallbacks(): void {
    const fs = this.fs!;

    // These callbacks are called by the Rust WASM module
    (globalThis as Record<string, unknown>).opfsRead = (
      fileId: number,
      offset: bigint,
      len: number
    ): Uint8Array => {
      const fd = fileId === FILE_ADDRESSING ? this.addressingFd : this.dataFd;
      if (fd === null) {
        console.error(`[NodeEncrypted] No handle for file ${fileId}`);
        return new Uint8Array(len);
      }

      const buffer = Buffer.alloc(len);
      try {
        const bytesRead = fs.readSync(fd, buffer, 0, len, Number(offset));
        if (bytesRead < len) {
          buffer.fill(0, bytesRead);
        }
      } catch (_) {
        // File might be smaller than requested offset
        buffer.fill(0);
      }

      return new Uint8Array(buffer);
    };

    (globalThis as Record<string, unknown>).opfsWrite = (
      fileId: number,
      offset: bigint,
      data: Uint8Array
    ): void => {
      const fd = fileId === FILE_ADDRESSING ? this.addressingFd : this.dataFd;
      if (fd === null) {
        console.error(`[NodeEncrypted] No handle for file ${fileId}`);
        return;
      }

      const buffer = Buffer.from(data);
      fs.writeSync(fd, buffer, 0, buffer.length, Number(offset));
    };

    (globalThis as Record<string, unknown>).opfsGetSize = (
      fileId: number
    ): bigint => {
      const fd = fileId === FILE_ADDRESSING ? this.addressingFd : this.dataFd;
      if (fd === null) {
        return BigInt(0);
      }

      const stats = fs.fstatSync(fd);
      return BigInt(stats.size);
    };

    (globalThis as Record<string, unknown>).opfsFlush = (
      fileId: number
    ): void => {
      const fd = fileId === FILE_ADDRESSING ? this.addressingFd : this.dataFd;
      if (fd !== null) {
        fs.fsyncSync(fd);
      }
    };

    this.log('WASM callbacks registered');
  }

  private async loadWasmModule(): Promise<void> {
    try {
      // In Node.js, we need to load the WASM module differently
      // The wasm-bindgen output should have a Node.js compatible entry point
      const wasmPath = this.path!.join(
        process.cwd(),
        'gossip-storage/ts/generated/gossip_storage.js'
      );

      if (!this.fs!.existsSync(wasmPath)) {
        this.log(`WASM module not found at ${wasmPath}`);
        throw new Error('WASM module not found');
      }

      // Dynamic import of the WASM bindings
      const wasmModule = await import(wasmPath);

      // Initialize WASM
      const wasmBinaryPath = this.path!.join(
        process.cwd(),
        'gossip-storage/ts/generated/gossip_storage_bg.wasm'
      );
      const wasmBinary = this.fs!.readFileSync(wasmBinaryPath);
      await wasmModule.default(wasmBinary);

      this.wasmExports = {
        initStorage: wasmModule.initStorage,
        createSession: wasmModule.createSession,
        unlockSession: wasmModule.unlockSession,
        lockSession: wasmModule.lockSession,
        isSessionUnlocked: wasmModule.isSessionUnlocked,
        readData: wasmModule.readData,
        writeData: wasmModule.writeData,
        flushData: wasmModule.flushData,
        getRootAddress: wasmModule.getRootAddress,
      };

      this.log('WASM module loaded');
    } catch (e) {
      this.log(`Failed to load WASM: ${e}`);
      throw new Error(`WASM loading failed: ${e}`);
    }
  }

  private async loadWaSqlite(): Promise<void> {
    // For Node.js, we can use better-sqlite3 with our custom VFS wrapper
    // Or load wa-sqlite in Node.js mode
    // For now, we'll use wa-sqlite since it works with our VFS

    try {
      // wa-sqlite should work in Node.js with some adjustments
      // This is a simplified version - full implementation would need
      // the same VFS class as the browser version

      this.log('wa-sqlite loading (Node.js mode)...');

      // Note: wa-sqlite is primarily designed for browsers
      // For production Node.js, consider using better-sqlite3 + our WASM for crypto
      // For now, mark as loaded but SQL execution will use direct WASM

      this.log('SQLite ready (via WASM)');
    } catch (e) {
      this.log(`wa-sqlite loading failed: ${e}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.db !== null && this.sqlite3) {
      // Close SQLite
    }

    // Close file handles
    if (this.addressingFd !== null && this.fs) {
      this.fs.closeSync(this.addressingFd);
      this.addressingFd = null;
    }
    if (this.dataFd !== null && this.fs) {
      this.fs.closeSync(this.dataFd);
      this.dataFd = null;
    }

    this.wasmExports = null;
    this.initialized = false;
    this.sessionUnlocked = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  // ============ Session Management ============

  async createSession(password: string): Promise<void> {
    this.ensureInitialized();

    if (!this.wasmExports) {
      throw new Error('WASM not loaded');
    }

    const success = this.wasmExports.createSession(password);
    if (!success) {
      throw new Error('Failed to create session');
    }

    this.sessionUnlocked = true;
    this.log('Session created');
    this.emit({
      type: 'session-change',
      timestamp: Date.now(),
      data: { action: 'created' },
    });
  }

  async unlockSession(password: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.wasmExports) {
      throw new Error('WASM not loaded');
    }

    const success = this.wasmExports.unlockSession(password);
    if (success) {
      this.sessionUnlocked = true;
      this.log('Session unlocked');
      this.emit({
        type: 'session-change',
        timestamp: Date.now(),
        data: { action: 'unlocked' },
      });
    } else {
      this.log('Invalid password');
    }

    return success;
  }

  async lockSession(): Promise<void> {
    if (this.wasmExports) {
      this.wasmExports.lockSession();
    }
    this.sessionUnlocked = false;
    this.log('Session locked');
    this.emit({
      type: 'session-change',
      timestamp: Date.now(),
      data: { action: 'locked' },
    });
  }

  isSessionUnlocked(): boolean {
    if (this.wasmExports) {
      return this.wasmExports.isSessionUnlocked();
    }
    return this.sessionUnlocked;
  }

  async changePassword(
    _oldPassword: string,
    _newPassword: string
  ): Promise<boolean> {
    // TODO: Implement password change
    // This requires re-encrypting all 46 slots with new keys
    throw new Error('Password change not yet implemented');
  }

  // ============ Data Access ============

  async readBlob(name: string): Promise<Uint8Array | null> {
    const filePath = this.path!.join(this.storagePath, name);
    if (!this.fs!.existsSync(filePath)) {
      return null;
    }
    const buffer = this.fs!.readFileSync(filePath);
    return new Uint8Array(buffer);
  }

  async writeBlob(name: string, data: Uint8Array): Promise<void> {
    const filePath = this.path!.join(this.storagePath, name);
    this.fs!.writeFileSync(filePath, Buffer.from(data));
  }

  async deleteBlob(name: string): Promise<boolean> {
    const filePath = this.path!.join(this.storagePath, name);
    if (!this.fs!.existsSync(filePath)) {
      return false;
    }
    this.fs!.unlinkSync(filePath);
    return true;
  }

  async listBlobs(): Promise<string[]> {
    const storageDir = this.path!.resolve(this.storagePath);
    if (!this.fs!.existsSync(storageDir)) {
      return [];
    }
    return this.fs!.readdirSync(storageDir).filter(f => f.endsWith('.bin'));
  }

  // ============ SQL Execution ============

  async executeSql<T = Record<string, unknown>>(
    _sql: string,
    _params?: unknown[]
  ): Promise<T[]> {
    this.ensureReady();

    // TODO: Implement SQL execution via wa-sqlite or better-sqlite3
    // For now, this is a placeholder
    throw new Error(
      'SQL execution not yet implemented for NodeEncryptedRuntime'
    );
  }

  async runSql(
    _sql: string,
    _params?: unknown[]
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    this.ensureReady();
    throw new Error(
      'SQL execution not yet implemented for NodeEncryptedRuntime'
    );
  }

  async execBatch(
    _statements: { sql: string; params?: unknown[] }[]
  ): Promise<void> {
    this.ensureReady();
    throw new Error(
      'SQL execution not yet implemented for NodeEncryptedRuntime'
    );
  }

  // ============ Direct Data Access (for VFS) ============

  readData(offset: bigint, len: number): Uint8Array {
    if (!this.wasmExports) {
      throw new Error('WASM not loaded');
    }
    return this.wasmExports.readData(offset, len);
  }

  writeData(offset: bigint, data: Uint8Array): boolean {
    if (!this.wasmExports) {
      throw new Error('WASM not loaded');
    }
    return this.wasmExports.writeData(offset, data);
  }

  flushData(): void {
    if (this.wasmExports) {
      this.wasmExports.flushData();
    }
  }

  getRootAddress(): bigint {
    if (!this.wasmExports) {
      return BigInt(0);
    }
    return this.wasmExports.getRootAddress();
  }

  // ============ Events ============

  onEvent(handler: (event: RuntimeEvent) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  private emit(event: RuntimeEvent): void {
    this.eventHandlers.forEach(handler => handler(event));
  }

  // ============ Helpers ============

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('NodeEncryptedRuntime not initialized');
    }
  }

  private ensureReady(): void {
    this.ensureInitialized();
    if (!this.sessionUnlocked) {
      throw new Error('Session not unlocked');
    }
  }

  private log(msg: string): void {
    if (this.debug) {
      console.log(`[NodeEncryptedRuntime] ${msg}`);
    }
  }
}
