import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { userProfile } from '@massalabs/gossip-sdk/db/schema';
import {
  SECURE_STORAGE_IDB_NAME,
  SESSION_BLOB_NAMESPACE,
} from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

function config(domain: string) {
  return {
    storage: {
      type: 'secureStorage' as const,
      domain,
      secureStorageWasmUrl,
    },
  };
}

async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('IDB deletion blocked - lingering handle?'));
  });
}

function randomBlob(size: number): Uint8Array {
  const blob = new Uint8Array(size);
  // crypto.getRandomValues caps at 65536 bytes per call.
  for (let off = 0; off < size; off += 65536) {
    crypto.getRandomValues(blob.subarray(off, Math.min(off + 65536, size)));
  }
  return blob;
}

const BLOB_SIZE = 55 * 1024; // ~55 KB — matches the typical session snapshot size

describe('session blob namespace persist', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  // ── E2E correctness ──────────────────────────────────────────────

  it('roundtrip: write blob to namespace, close, reopen, read back', async () => {
    const password = 'roundtrip-pw';
    const domain = 'vitest-ns-roundtrip';
    const blob = randomBlob(BLOB_SIZE);
    // Snapshot expectations before the write: writeNamespaceData
    // transfers the buffer, so `blob` is detached after the call.
    const expectedLength = blob.length;
    const expectedBytes = Array.from(blob);

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageCreate(0, password);
      await conn.secureStorageWriteNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        blob
      );
      await conn.secureStorageFlush();
      await conn.close();
    }

    {
      const conn = await DatabaseConnection.create(config(domain));
      const ok = await conn.secureStorageUnlock(password);
      expect(ok).toBe(true);

      const len = await conn.secureStorageNamespaceDataLength(
        SESSION_BLOB_NAMESPACE
      );
      expect(len).toBe(expectedLength);

      const read = await conn.secureStorageReadNamespaceData(
        SESSION_BLOB_NAMESPACE,
        0,
        len
      );
      expect(read.length).toBe(expectedLength);
      expect(Array.from(read)).toEqual(expectedBytes);

      await conn.close();
    }
  }, 180_000);

  it('namespace and SQL VFS data are isolated', async () => {
    const password = 'isolation-pw';
    const domain = 'vitest-ns-isolation';
    const now = new Date();
    const blob = randomBlob(BLOB_SIZE);
    // Snapshot expectations before the write: writeNamespaceData
    // transfers the buffer, so `blob` is detached after the call.
    const expectedLength = blob.length;
    const expectedBytes = Array.from(blob);

    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageCreate(0, password);

    // Write via SQL VFS (namespace 0).
    await conn.db.insert(userProfile).values({
      userId: 'gossip1bob',
      username: 'bob',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: 'classic',
      session: new Uint8Array([0]),
    });

    // Write via namespace 1 (session blob fast path).
    await conn.secureStorageWriteNamespaceData(SESSION_BLOB_NAMESPACE, 0, blob);

    await conn.secureStorageFlush();

    // Both must be readable independently.
    const rows = await conn.db
      .select({ username: userProfile.username })
      .from(userProfile)
      .where(eq(userProfile.userId, 'gossip1bob'));
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('bob');

    const nsLen = await conn.secureStorageNamespaceDataLength(
      SESSION_BLOB_NAMESPACE
    );
    expect(nsLen).toBe(expectedLength);
    const read = await conn.secureStorageReadNamespaceData(
      SESSION_BLOB_NAMESPACE,
      0,
      nsLen
    );
    expect(Array.from(read)).toEqual(expectedBytes);

    await conn.close();
  }, 180_000);
});
