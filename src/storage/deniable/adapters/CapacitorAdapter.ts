/**
 * Capacitor adapter using native filesystem
 *
 * This adapter stores the addressing and data blobs as files
 * in the native filesystem using Capacitor.
 */

import { Filesystem, Directory } from '@capacitor/filesystem';
import type { StorageAdapter } from '../types';

const ADDRESSING_BLOB_FILE = 'addressing.blob';
const DATA_BLOB_FILE = 'data.blob';

/**
 * Capacitor storage adapter using native filesystem
 */
export class CapacitorAdapter implements StorageAdapter {
  private directory: Directory;
  private basePath: string;

  constructor(
    basePath: string = 'deniable-storage',
    directory: Directory = Directory.Data
  ) {
    this.basePath = basePath;
    this.directory = directory;
  }

  async initialize(): Promise<void> {
    // Create directory if it doesn't exist
    try {
      await Filesystem.mkdir({
        path: this.basePath,
        directory: this.directory,
        recursive: true,
      });
    } catch (_) {
      // Directory might already exist, ignore error
    }
  }

  async readAddressingBlob(): Promise<Uint8Array> {
    return this.readFile(ADDRESSING_BLOB_FILE);
  }

  async writeAddressingBlob(data: Uint8Array): Promise<void> {
    return this.writeFile(ADDRESSING_BLOB_FILE, data);
  }

  async readDataBlob(): Promise<Uint8Array> {
    return this.readFile(DATA_BLOB_FILE);
  }

  async writeDataBlob(data: Uint8Array): Promise<void> {
    return this.writeFile(DATA_BLOB_FILE, data);
  }

  async getDataBlobSize(): Promise<number> {
    try {
      const stat = await Filesystem.stat({
        path: `${this.basePath}/${DATA_BLOB_FILE}`,
        directory: this.directory,
      });
      return stat.size;
    } catch {
      return 0;
    }
  }

  async appendToDataBlob(data: Uint8Array): Promise<void> {
    const path = `${this.basePath}/${DATA_BLOB_FILE}`;

    // Capacitor doesn't have native append, so we read + write
    // TODO: Optimize this with native append in future
    const existing = await this.readFile(DATA_BLOB_FILE);
    const combined = new Uint8Array(existing.length + data.length);
    combined.set(existing);
    combined.set(data, existing.length);

    await Filesystem.writeFile({
      path,
      directory: this.directory,
      data: this.uint8ArrayToBase64(combined),
    });
  }

  async secureWipe(): Promise<void> {
    // Overwrite with random data before deleting
    const addressingSize = 2 * 1024 * 1024; // 2MB
    const random = new Uint8Array(addressingSize);
    crypto.getRandomValues(random);
    await this.writeAddressingBlob(random);

    // Delete files
    try {
      await Filesystem.deleteFile({
        path: `${this.basePath}/${ADDRESSING_BLOB_FILE}`,
        directory: this.directory,
      });
    } catch {
      // Ignore if doesn't exist
    }

    try {
      await Filesystem.deleteFile({
        path: `${this.basePath}/${DATA_BLOB_FILE}`,
        directory: this.directory,
      });
    } catch {
      // Ignore if doesn't exist
    }
  }

  private async readFile(filename: string): Promise<Uint8Array> {
    try {
      const result = await Filesystem.readFile({
        path: `${this.basePath}/${filename}`,
        directory: this.directory,
      });

      // Convert base64 to Uint8Array
      return this.base64ToUint8Array(result.data as string);
    } catch {
      // File doesn't exist, return empty array
      return new Uint8Array(0);
    }
  }

  private async writeFile(filename: string, data: Uint8Array): Promise<void> {
    await Filesystem.writeFile({
      path: `${this.basePath}/${filename}`,
      directory: this.directory,
      data: this.uint8ArrayToBase64(data),
    });
  }

  private uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
