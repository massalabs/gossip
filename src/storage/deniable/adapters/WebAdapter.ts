/**
 * Web adapter using IndexedDB for storage
 *
 * This adapter stores the addressing and data blobs in IndexedDB
 * for browser-based applications.
 */

import type { StorageAdapter } from '../types';

const DB_NAME = 'DeniableStorage';
const STORE_NAME = 'blobs';
const ADDRESSING_BLOB_KEY = 'addressing';
const DATA_BLOB_KEY = 'data';

/**
 * Web storage adapter using IndexedDB
 */
export class WebAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null;
  private dbName: string;

  constructor(dbName: string = DB_NAME) {
    this.dbName = dbName;
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
    });
  }

  async readAddressingBlob(): Promise<Uint8Array> {
    return this.readBlob(ADDRESSING_BLOB_KEY);
  }

  async writeAddressingBlob(data: Uint8Array): Promise<void> {
    return this.writeBlob(ADDRESSING_BLOB_KEY, data);
  }

  async readDataBlob(): Promise<Uint8Array> {
    return this.readBlob(DATA_BLOB_KEY);
  }

  async writeDataBlob(data: Uint8Array): Promise<void> {
    return this.writeBlob(DATA_BLOB_KEY, data);
  }

  async getDataBlobSize(): Promise<number> {
    const data = await this.readDataBlob();
    return data.length;
  }

  async appendToDataBlob(data: Uint8Array): Promise<void> {
    const existing = await this.readDataBlob();
    const combined = new Uint8Array(existing.length + data.length);
    combined.set(existing);
    combined.set(data, existing.length);
    await this.writeDataBlob(combined);
  }

  async secureWipe(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  private async readBlob(key: string): Promise<Uint8Array> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        if (result === undefined) {
          // Return empty array if not found
          resolve(new Uint8Array(0));
        } else {
          resolve(result);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  private async writeBlob(key: string, data: Uint8Array): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(data, key);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}
