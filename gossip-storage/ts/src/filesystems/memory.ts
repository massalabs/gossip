/**
 * MemoryFileSystem - In-memory storage backend
 *
 * Useful for testing and ephemeral use cases.
 * Data is not persisted to disk.
 */

import type { FileSystem, FileId } from '../filesystem.js';

/**
 * In-memory FileSystem implementation.
 *
 * Stores data in memory using Uint8Array buffers.
 * Fast, isolated per instance, no disk I/O.
 */
export class MemoryFileSystem implements FileSystem {
  private files = new Map<FileId, Uint8Array>();

  read(fileId: FileId, offset: number, len: number): Uint8Array {
    const file = this.files.get(fileId);
    if (!file) {
      return new Uint8Array(len);
    }

    const result = new Uint8Array(len);
    const end = Math.min(offset + len, file.length);
    const bytesToCopy = Math.max(0, end - offset);

    if (bytesToCopy > 0 && offset < file.length) {
      result.set(file.subarray(offset, offset + bytesToCopy));
    }

    return result;
  }

  write(fileId: FileId, offset: number, data: Uint8Array): void {
    let file = this.files.get(fileId);
    const requiredSize = offset + data.length;

    if (!file) {
      file = new Uint8Array(requiredSize);
      this.files.set(fileId, file);
    } else if (file.length < requiredSize) {
      const newFile = new Uint8Array(requiredSize);
      newFile.set(file);
      file = newFile;
      this.files.set(fileId, file);
    }

    file.set(data, offset);
  }

  getSize(fileId: FileId): number {
    const file = this.files.get(fileId);
    return file ? file.length : 0;
  }

  flush(_fileId: FileId): void {
    // No-op for memory filesystem
  }

  close(): void {
    this.files.clear();
  }

  /**
   * Reset the filesystem (useful for testing)
   */
  reset(): void {
    this.files.clear();
  }
}
