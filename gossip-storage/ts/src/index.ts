/**
 * Gossip Storage - Plausible Deniability Storage Layer
 *
 * Cross-environment storage library for the Gossip E2E encrypted chat application.
 *
 * @example Basic usage with Node.js
 * ```typescript
 * import { Storage, NodeFileSystem } from '@gossip/storage';
 *
 * const storage = new Storage(new NodeFileSystem('./data'));
 * await storage.init(wasmLoader);
 *
 * storage.createSession('password');
 * storage.unlockSession('password');
 * ```
 *
 * @example Browser with OPFS
 * ```typescript
 * import { Storage, OpfsFileSystem } from '@gossip/storage';
 *
 * const fs = new OpfsFileSystem();
 * await fs.initialize();
 *
 * const storage = new Storage(fs);
 * await storage.init(wasmLoader);
 * ```
 *
 * @example Testing with MemoryFileSystem
 * ```typescript
 * import { Storage, MemoryFileSystem } from '@gossip/storage';
 *
 * const storage = new Storage(new MemoryFileSystem());
 * await storage.init(wasmLoader);
 * ```
 */

// Main Storage class
export { Storage } from './storage.js';
export type { StorageInitOptions, SqlResult } from './storage.js';

// FileSystem interface and constants
export type { FileSystem, FileId } from './filesystem.js';
export { FILE_ADDRESSING, FILE_DATA } from './filesystem.js';

// FileSystem implementations
export { MemoryFileSystem } from './filesystems/memory.js';
export { NodeFileSystem } from './filesystems/node.js';
export { OpfsFileSystem, isOpfsSyncSupported } from './filesystems/opfs.js';

// VFS for wa-sqlite (optional)
export { PlausibleDeniableVFS } from './vfs.js';
export type { StorageApi } from './vfs.js';
