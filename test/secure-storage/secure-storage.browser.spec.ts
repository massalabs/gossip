import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { userProfile } from '@massalabs/gossip-sdk/db/schema';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

// Absolute URL so the worker can resolve it regardless of its base path.
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

/**
 * Delete the secureStorage IndexedDB database to isolate each test.
 */
async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('secureStorage');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error('IDB deletion blocked — lingering handle?'));
  });
}

describe('secure storage pipeline', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  it('first run: provision + allocate opens the database', async () => {
    const conn = await DatabaseConnection.create(config('vitest-first-run'));

    expect(conn.isSecureStorage).toBe(true);
    expect(conn.storageState).toBe(`empty`);
    expect(conn.isOpen).toBe(false);

    await conn.secureStorageCreate(0, 'test-password-1234');

    expect(conn.isOpen).toBe(true);

    await conn.close();
  }, 120_000);

  it('second run with correct password: unlock opens the database', async () => {
    const password = 'test-password-correct';
    const domain = 'vitest-second-run';

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageCreate(0, password);
      await conn.close();
    }

    const conn = await DatabaseConnection.create(config(domain));

    expect(conn.storageState).toBe(`locked`);
    expect(conn.isOpen).toBe(false);

    const ok = await conn.secureStorageUnlock(password);

    expect(ok).toBe(true);
    expect(conn.isOpen).toBe(true);

    await conn.close();
  }, 120_000);

  it('second run with wrong password: unlock returns false', async () => {
    const domain = 'vitest-wrong-password';

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageCreate(0, 'correct-password');
      await conn.close();
    }

    const conn = await DatabaseConnection.create(config(domain));

    expect(conn.storageState).toBe(`locked`);

    const ok = await conn.secureStorageUnlock('wrong-password');

    expect(ok).toBe(false);
    expect(conn.isOpen).toBe(false);

    await conn.close();
  }, 120_000);

  it('data persists across close/reopen', async () => {
    const password = 'test-persist';
    const domain = 'vitest-persist';
    const now = new Date();

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageCreate(0, password);

      await conn.db.insert(userProfile).values({
        userId: 'gossip1alice',
        username: 'alice',
        status: 'online',
        lastSeen: now,
        createdAt: now,
        updatedAt: now,
        security: 'classic',
        session: new Uint8Array([0]),
      });

      await conn.secureStorageFlush();
      await conn.close();
    }

    {
      const conn = await DatabaseConnection.create(config(domain));
      await conn.secureStorageUnlock(password);

      const rows = await conn.db
        .select({ username: userProfile.username })
        .from(userProfile)
        .where(eq(userProfile.userId, 'gossip1alice'));

      expect(rows).toHaveLength(1);
      expect(rows[0].username).toBe('alice');

      await conn.close();
    }
  }, 120_000);
});
