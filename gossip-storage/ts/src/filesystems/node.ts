/**
 * NodeFileSystem - Node.js filesystem backend
 *
 * Uses actual files on disk for real I/O testing.
 * Requires Node.js fs module.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  ftruncateSync,
} from 'fs';
import { resolve } from 'path';
import type { FileSystem, FileId } from '../filesystem.js';
import { FILE_ADDRESSING, FILE_DATA } from '../filesystem.js';

const FILE_NAMES: Record<FileId, string> = {
  [FILE_ADDRESSING]: 'addressing.bin',
  [FILE_DATA]: 'data.bin',
};

/**
 * Node.js filesystem backend.
 *
 * Uses actual files on disk for storage.
 * Suitable for backend environments and testing.
 */
export class NodeFileSystem implements FileSystem {
  private basePath: string;
  private fileDescriptors = new Map<FileId, number>();
  private stats = {
    readCount: 0,
    writeCount: 0,
    flushCount: 0,
  };

  constructor(basePath: string) {
    this.basePath = basePath;
    this.ensureDirectory();
  }

  private ensureDirectory(): void {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true });
    }
  }

  private getFilePath(fileId: FileId): string {
    const fileName = FILE_NAMES[fileId];
    if (!fileName) {
      throw new Error(`Unknown fileId: ${fileId}`);
    }
    return resolve(this.basePath, fileName);
  }

  private getFd(fileId: FileId): number {
    let fd = this.fileDescriptors.get(fileId);
    if (fd === undefined) {
      const path = this.getFilePath(fileId);

      if (!existsSync(path)) {
        writeFileSync(path, Buffer.alloc(0));
      }

      fd = openSync(path, 'r+');
      this.fileDescriptors.set(fileId, fd);
    }
    return fd;
  }

  read(fileId: FileId, offset: number, len: number): Uint8Array {
    this.stats.readCount++;
    const fd = this.getFd(fileId);
    const buffer = Buffer.alloc(len);

    try {
      readSync(fd, buffer, 0, len, offset);
    } catch {
      // File might be smaller than offset, return zeros
    }

    return new Uint8Array(buffer);
  }

  write(fileId: FileId, offset: number, data: Uint8Array): void {
    this.stats.writeCount++;
    const fd = this.getFd(fileId);

    const currentSize = this.getSize(fileId);
    const requiredSize = offset + data.length;
    if (requiredSize > currentSize) {
      ftruncateSync(fd, requiredSize);
    }

    writeSync(fd, Buffer.from(data), 0, data.length, offset);
  }

  getSize(fileId: FileId): number {
    const path = this.getFilePath(fileId);
    if (!existsSync(path)) return 0;
    return statSync(path).size;
  }

  flush(_fileId: FileId): void {
    this.stats.flushCount++;
    // Node.js writeSync is synchronous, fsync could be added if needed
  }

  close(): void {
    for (const fd of this.fileDescriptors.values()) {
      try {
        closeSync(fd);
      } catch {
        // Ignore errors
      }
    }
    this.fileDescriptors.clear();
  }

  /**
   * Reset the filesystem (delete files but keep directory)
   */
  reset(): void {
    this.close();

    for (const fileId of [FILE_ADDRESSING, FILE_DATA] as FileId[]) {
      const path = this.getFilePath(fileId);
      try {
        if (existsSync(path)) {
          unlinkSync(path);
        }
      } catch {
        // Ignore errors
      }
    }

    this.stats = { readCount: 0, writeCount: 0, flushCount: 0 };
  }

  /**
   * Cleanup - remove all files and close handles
   */
  cleanup(): void {
    this.reset();
  }

  /**
   * Get I/O statistics
   */
  getStats(): {
    readCount: number;
    writeCount: number;
    flushCount: number;
    addressingSize: number;
    dataSize: number;
  } {
    return {
      ...this.stats,
      addressingSize: this.getSize(FILE_ADDRESSING),
      dataSize: this.getSize(FILE_DATA),
    };
  }
}
