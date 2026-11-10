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

const ALICE = 'alice-password';
const BOB = 'bob-password';
const NEW = 'brand-new-password';

async function insertProfile(conn: DatabaseConnection, name: string) {
  const now = new Date();
  await conn.db.insert(userProfile).values({
    userId: `gossip1${name}`,
    username: name,
    status: 'online',
    lastSeen: now,
    createdAt: now,
    updatedAt: now,
    security: 'classic',
    session: new Uint8Array([0]),
  });
}

async function usernames(conn: DatabaseConnection): Promise<string[]> {
  const rows = await conn.db.select().from(userProfile);
  return rows.map(row => row.username);
}

/** Two committed accounts: Alice (with a session blob) and Bob. */
async function createTwoAccounts(domain: string): Promise<void> {
  const conn = await DatabaseConnection.create(config(domain));
  await conn.secureStorageBeginOnboardingCandidate();
  await conn.secureStorageCreate(0, ALICE);
  await insertProfile(conn, 'alice');
  await conn.secureStorageWriteNamespaceData(
    SESSION_BLOB_NAMESPACE,
    0,
    new Uint8Array([1, 2, 3, 4, 5])
  );
  await conn.secureStorageFlush();
  await conn.secureStorageLock();
  await conn.secureStorageCreate(2, BOB);
  await insertProfile(conn, 'bob');
  await conn.secureStorageFlush();
  await conn.secureStorageLock();
  await conn.secureStorageCommitOnboardingCandidate();
  await conn.close();
}

describe('in-place rekey', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  it('changes one password, keeps another, and survives a restart', async () => {
    const domain = 'vitest-rekey-change';
    await createTwoAccounts(domain);

    const conn = await DatabaseConnection.create(config(domain));
    const epochBefore = conn.accountGenerationEpoch;
    await conn.secureStorageBeginRekey();
    expect(await conn.secureStorageAdmitRekey('wrong-password')).toBe(false);
    expect(await conn.secureStorageAdmitRekey(BOB)).toBe(true);
    // Same account twice, and a new password another account already has.
    expect(await conn.secureStorageAdmitRekey(BOB)).toBe(false);
    expect(await conn.secureStorageAdmitRekey(ALICE, BOB)).toBe(false);
    expect(await conn.secureStorageAdmitRekey(ALICE, NEW)).toBe(true);
    await conn.secureStorageBuildRekeyCandidate();

    // The candidate is writable before anything durable changes.
    expect(await conn.secureStorageUnlock(ALICE)).toBe(false);
    expect(await conn.secureStorageUnlock(NEW)).toBe(true);
    expect(await usernames(conn)).toEqual(['alice']);
    await conn.db
      .update(userProfile)
      .set({ username: 'alice-rewritten' })
      .where(eq(userProfile.userId, 'gossip1alice'));
    await conn.secureStorageFlush();
    await conn.secureStorageLock();

    await conn.secureStorageCommitRekeyCandidate();
    expect(conn.accountGenerationEpoch).not.toBe(epochBefore);
    expect(conn.accountGenerationEpoch).toMatch(/^[0-9a-f]{32}$/);
    await conn.close();

    const reopened = await DatabaseConnection.create(config(domain));
    expect(reopened.storageState).toBe('locked');
    expect(await reopened.secureStorageUnlock(ALICE)).toBe(false);
    expect(await reopened.secureStorageUnlock(NEW)).toBe(true);
    expect(await usernames(reopened)).toEqual(['alice-rewritten']);
    const blobLength = await reopened.secureStorageNamespaceDataLength(
      SESSION_BLOB_NAMESPACE
    );
    expect(
      Array.from(
        await reopened.secureStorageReadNamespaceData(
          SESSION_BLOB_NAMESPACE,
          0,
          blobLength
        )
      )
    ).toEqual([1, 2, 3, 4, 5]);
    await reopened.secureStorageLock();
    expect(await reopened.secureStorageUnlock(BOB)).toBe(true);
    expect(await usernames(reopened)).toEqual(['bob']);
    await reopened.close();
  }, 240_000);

  it('erases an account that was not admitted', async () => {
    const domain = 'vitest-rekey-omit';
    await createTwoAccounts(domain);

    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageBeginRekey();
    expect(await conn.secureStorageAdmitRekey(ALICE)).toBe(true);
    await conn.secureStorageBuildRekeyCandidate();
    await conn.secureStorageCommitRekeyCandidate();
    await conn.close();

    const reopened = await DatabaseConnection.create(config(domain));
    expect(await reopened.secureStorageUnlock(BOB)).toBe(false);
    expect(await reopened.secureStorageUnlock(ALICE)).toBe(true);
    expect(await usernames(reopened)).toEqual(['alice']);
    await reopened.close();
  }, 240_000);

  it('leaves the store untouched when aborted, before or after the candidate', async () => {
    const domain = 'vitest-rekey-abort';
    await createTwoAccounts(domain);

    const conn = await DatabaseConnection.create(config(domain));
    const epochBefore = conn.accountGenerationEpoch;

    await conn.secureStorageBeginRekey();
    expect(await conn.secureStorageAdmitRekey(ALICE, NEW)).toBe(true);
    await conn.secureStorageAbortRekey();

    await conn.secureStorageBeginRekey();
    expect(await conn.secureStorageAdmitRekey(ALICE, NEW)).toBe(true);
    await conn.secureStorageBuildRekeyCandidate();
    expect(await conn.secureStorageUnlock(NEW)).toBe(true);
    await conn.db
      .update(userProfile)
      .set({ username: 'never-committed' })
      .where(eq(userProfile.userId, 'gossip1alice'));
    await conn.secureStorageFlush();
    await conn.secureStorageLock();
    await conn.secureStorageAbortRekey();

    expect(conn.accountGenerationEpoch).toBe(epochBefore);
    expect(await conn.secureStorageUnlock(NEW)).toBe(false);
    expect(await conn.secureStorageUnlock(ALICE)).toBe(true);
    expect(await usernames(conn)).toEqual(['alice']);
    await conn.secureStorageLock();
    expect(await conn.secureStorageUnlock(BOB)).toBe(true);
    await conn.close();

    const reopened = await DatabaseConnection.create(config(domain));
    expect(reopened.accountGenerationEpoch).toBe(epochBefore);
    expect(await reopened.secureStorageUnlock(ALICE)).toBe(true);
    await reopened.close();
  }, 240_000);

  it('refuses to start on an unlocked or empty store', async () => {
    const domain = 'vitest-rekey-guards';
    const empty = await DatabaseConnection.create(config(domain));
    await expect(empty.secureStorageBeginRekey()).rejects.toThrow();
    await empty.close();

    await createTwoAccounts(domain);
    const conn = await DatabaseConnection.create(config(domain));
    expect(await conn.secureStorageUnlock(ALICE)).toBe(true);
    await expect(conn.secureStorageBeginRekey()).rejects.toThrow();
    await conn.close();
  }, 240_000);
});
