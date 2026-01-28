/**
 * OpfsFileSystem - OPFS (Origin Private File System) storage backend
 *
 * Uses FileSystemSyncAccessHandle for synchronous read/write operations.
 * This is required for WASM interop where async operations are not possible.
 *
 * IMPORTANT: This must run in a Web Worker to use sync access handles.
 */

import type { FileSystem, FileId } from '../filesystem.js';
import { FILE_ADDRESSING, FILE_DATA } from '../filesystem.js';

const FILE_NAMES: Record<FileId, string> = {
  [FILE_ADDRESSING]: 'addressing.bin',
  [FILE_DATA]: 'data.bin',
};

/**
 * OPFS-backed FileSystem implementation.
 *
 * Uses FileSystemSyncAccessHandle for synchronous read/write operations.
 * Must be initialized with `initialize()` before use.
 */
export class OpfsFileSystem implements FileSystem {
  private handles = new Map<FileId, FileSystemSyncAccessHandle>();
  private initialized = false;
  private directoryName: string;

  constructor(directoryName = 'gossip-storage') {
    this.directoryName = directoryName;
  }

  /**
   * Initialize OPFS and open file handles.
   * Must be called before any other operations.
   *
   * Note: If handles are already open from a previous worker/tab,
   * createSyncAccessHandle() will fail. The user should close other tabs
   * or clear storage to recover.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const root = await navigator.storage.getDirectory();
    const gossipDir = await root.getDirectoryHandle(this.directoryName, {
      create: true,
    });

    for (const [fileId, fileName] of Object.entries(FILE_NAMES)) {
      const fileHandle = await gossipDir.getFileHandle(fileName, {
        create: true,
      });

      try {
        const syncHandle = await fileHandle.createSyncAccessHandle();
        this.handles.set(Number(fileId) as FileId, syncHandle);
      } catch (err) {
        // Clean up any handles we already opened
        this.close();
        throw new Error(
          `Failed to open ${fileName}: ${err}. ` +
            'This usually means another tab/worker has the file open. ' +
            'Close other tabs or clear storage to recover.'
        );
      }
    }

    this.initialized = true;
  }

  private getHandle(fileId: FileId): FileSystemSyncAccessHandle {
    const handle = this.handles.get(fileId);
    if (!handle) {
      throw new Error(
        `File handle not initialized for fileId ${fileId}. Call initialize() first.`
      );
    }
    return handle;
  }

  read(fileId: FileId, offset: number, len: number): Uint8Array {
    const handle = this.getHandle(fileId);
    const buffer = new Uint8Array(len);
    const bytesRead = handle.read(buffer, { at: offset });

    if (bytesRead < len) {
      // Buffer is already zero-filled for unread bytes
    }

    return buffer;
  }

  write(fileId: FileId, offset: number, data: Uint8Array): void {
    const handle = this.getHandle(fileId);
    handle.write(data, { at: offset });
  }

  getSize(fileId: FileId): number {
    const handle = this.getHandle(fileId);
    return handle.getSize();
  }

  flush(fileId: FileId): void {
    const handle = this.getHandle(fileId);
    handle.flush();
  }

  close(): void {
    for (const handle of this.handles.values()) {
      handle.close();
    }
    this.handles.clear();
    this.initialized = false;
  }
}

/**
 * Check if OPFS with sync access is available
 */
export function isOpfsSyncSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    'storage' in navigator &&
    'getDirectory' in navigator.storage &&
    typeof FileSystemSyncAccessHandle !== 'undefined'
  );
}
