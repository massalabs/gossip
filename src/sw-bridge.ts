/**
 * IndexedDB Key-Value Bridge
 *
 * Minimal bridge for sharing data between the main app and the service worker.
 * Uses raw IndexedDB API (no dependencies) since both contexts can access it.
 *
 * Keys stored:
 * - "activeSeekers": number[][] (serialized Uint8Array[])
 * - "lastSyncTimestamp": number
 */

const DB_NAME = 'gossip-sw-bridge';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

function openBridgeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function bridgeGet<T = unknown>(
  key: string
): Promise<T | undefined> {
  const db = await openBridgeDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}

export async function bridgeSet(key: string, value: unknown): Promise<void> {
  const db = await openBridgeDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
  });
}
