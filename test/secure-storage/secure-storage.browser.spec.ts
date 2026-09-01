import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { userProfile } from '@massalabs/gossip-sdk/db/schema';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
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
 * Delete the secure-storage IndexedDB database to isolate each test.
 */
async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
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

  it('keeps all three slots distinct and discoverable by password', async () => {
    const domain = 'vitest-all-slots';
    const accounts = [
      { slot: 0, password: 'alice-password', userId: 'gossip1alice' },
      { slot: 1, password: 'decoy-password', userId: 'gossip1decoy' },
      { slot: 2, password: 'backup-password', userId: 'gossip1backup' },
    ];
    const now = new Date();

    const writer = await DatabaseConnection.create(config(domain));
    for (const account of accounts) {
      await writer.secureStorageCreate(account.slot, account.password);
      await writer.db.insert(userProfile).values({
        userId: account.userId,
        username: account.userId,
        status: 'online',
        lastSeen: now,
        createdAt: now,
        updatedAt: now,
        security: 'classic',
        session: new Uint8Array([account.slot]),
      });
      await writer.secureStorageFlush();
      await writer.secureStorageLock();
    }
    await writer.close();

    const reader = await DatabaseConnection.create(config(domain));
    for (const account of accounts) {
      expect(await reader.secureStorageUnlock(account.password)).toBe(true);
      const rows = await reader.db
        .select({ userId: userProfile.userId })
        .from(userProfile);
      expect(rows).toEqual([{ userId: account.userId }]);
      await reader.secureStorageLock();
    }
    await reader.close();
  }, 120_000);

  it('previews an authenticated portable candidate without installing it', async () => {
    const password = 'preview-password';
    const domain = 'vitest-portable-preview';
    const userId =
      'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s';
    const now = new Date(1234);
    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageCreate(0, password);
    await conn.db.insert(userProfile).values({
      userId,
      username: 'Alice',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: JSON.stringify({
        formatVersion: 1,
        passwordKdfVersion: 1,
        mnemonicEncryptionVersion: 1,
        identityDerivationVersion: 1,
        authMethod: 'password',
        encKeySalt: Array.from({ length: 16 }, (_, index) => index),
        mnemonicBackup: {
          encryptedMnemonic: Array.from({ length: 17 }, (_, index) => index),
          createdAt: '2026-01-01T00:00:00.000Z',
          backedUp: false,
        },
      }),
      session: new Uint8Array([0]),
    });
    await conn.secureStorageFlush();
    await conn.secureStorageLock();
    const archive: Uint8Array[] = [];
    await conn.secureStorageExportPortableV1(chunk => {
      archive.push(chunk.slice());
    });

    await conn.secureStorageBeginPortableImport();
    for (const chunk of archive) {
      await conn.secureStoragePushPortableImportChunk(chunk);
    }
    await conn.secureStorageValidatePortableImport();
    await expect(
      conn.secureStorageAuthenticatePortableImportCandidate(
        new TextEncoder().encode('wrong-password')
      )
    ).rejects.toThrow('password was not accepted');
    await expect(
      conn.secureStorageAuthenticatePortableImportCandidate(
        new TextEncoder().encode(password)
      )
    ).resolves.toEqual({
      userId,
      username: 'Alice',
      avatar: null,
      createdAtMs: 1234,
    });
    await conn.secureStorageBeginPortableOuterMigration();
    await conn.secureStorageAdmitPortableOuterMigrationPassword(
      new TextEncoder().encode(password)
    );
    await conn.secureStorageFinishPortableOuterMigration();
    await conn.secureStorageInstallPortableImport();
    expect(conn.storageState).toBe('locked');
    await conn.close();

    const restored = await DatabaseConnection.create(config(domain));
    expect(await restored.secureStorageUnlock(password)).toBe(true);
    const profiles = await restored.db
      .select({ userId: userProfile.userId, username: userProfile.username })
      .from(userProfile);
    expect(profiles).toEqual([{ userId, username: 'Alice' }]);
    await restored.close();
  }, 120_000);

  it('rejects a portable preview with corruption outside the profile query', async () => {
    const password = 'corrupt-preview-password';
    const domain = 'vitest-corrupt-portable-preview';
    const userId =
      'gossip1ywzkutgadznd0509tsl4gs4xjvsudhzgjuxc46ytngvq0lacx5es2xyz5s';
    const now = new Date(1234);
    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageCreate(0, password);
    await conn.db.insert(userProfile).values({
      userId,
      username: 'Alice',
      status: 'online',
      lastSeen: now,
      createdAt: now,
      updatedAt: now,
      security: JSON.stringify({
        formatVersion: 1,
        passwordKdfVersion: 1,
        mnemonicEncryptionVersion: 1,
        identityDerivationVersion: 1,
        authMethod: 'password',
        encKeySalt: Array.from({ length: 16 }, (_, index) => index),
        mnemonicBackup: {
          encryptedMnemonic: Array.from({ length: 17 }, (_, index) => index),
          createdAt: '2026-01-01T00:00:00.000Z',
          backedUp: false,
        },
      }),
      session: new Uint8Array([0]),
    });
    const raw = conn as unknown as {
      execRawDirect(sql: string, params?: unknown[]): Promise<unknown[][]>;
    };
    await raw.execRawDirect(
      'CREATE TABLE unrelated_preview_data (payload BLOB NOT NULL)'
    );
    await raw.execRawDirect(
      'INSERT INTO unrelated_preview_data VALUES (zeroblob(8192))'
    );
    await raw.execRawDirect('PRAGMA writable_schema = ON');
    await raw.execRawDirect(
      'UPDATE sqlite_schema SET rootpage = (' +
        "SELECT rootpage FROM sqlite_schema WHERE name = 'userProfile'" +
        ") WHERE name = 'unrelated_preview_data'"
    );
    await raw.execRawDirect('PRAGMA writable_schema = OFF');
    await conn.secureStorageFlush();
    await conn.secureStorageLock();

    const archive: Uint8Array[] = [];
    await conn.secureStorageExportPortableV1(chunk => {
      archive.push(chunk.slice());
    });
    await conn.secureStorageBeginPortableImport();
    try {
      for (const chunk of archive) {
        await conn.secureStoragePushPortableImportChunk(chunk);
      }
      await conn.secureStorageValidatePortableImport();
      await expect(
        conn.secureStorageAuthenticatePortableImportCandidate(
          new TextEncoder().encode(password)
        )
      ).rejects.toThrow();
    } finally {
      await conn.secureStorageAbortPortableImport();
      await conn.close();
    }
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
