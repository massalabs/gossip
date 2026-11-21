/**
 * The group engine's tables in secure-storage mode: migration 0010 applies in
 * the encrypted database, a batch is applied in one transaction (a failure
 * leaves nothing), and the records survive a lock and unlock.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { GroupQueries } from '@massalabs/gossip-sdk/db/queries/groups';
import type { GroupBatch } from '@massalabs/gossip-sdk/db/queries/groups';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

const config = (domain: string) => ({
  storage: { type: 'secureStorage' as const, domain, secureStorageWasmUrl },
});

async function clearSecureStorageIdb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(SECURE_STORAGE_IDB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IDB deletion blocked'));
  });
}

const batch = (chat: string): GroupBatch => ({
  rows: [
    {
      chatId: chat,
      eventId: 'e1',
      state: 'held',
      fields: '{"role":"Current"}',
    },
  ],
  removedRows: [],
  edges: [{ chatId: chat, eventId: 'e1', parents: '[]' }],
  removedEdges: [],
  objects: [{ chatId: chat, syncObjId: 's1', fields: '{}', shareable: true }],
  removedObjects: [],
  node: [{ kind: 'meta', key: 'null', fields: '{"next_seq":1}' }],
  erase: [],
});

describe('group tables in secure storage', () => {
  beforeEach(async () => {
    await clearSecureStorageIdb();
  }, 60_000);

  it('applies batches atomically and keeps them across lock and unlock', async () => {
    const domain = 'vitest-groups';
    const password = 'groups-test-password';
    const conn = await DatabaseConnection.create(config(domain));
    await conn.secureStorageBeginOnboardingCandidate();
    await conn.secureStorageCreate(0, password);
    const groups = new GroupQueries(conn);

    await groups.applyBatches('owner', [batch('c1')]);
    // A failure in the same transaction leaves nothing of the batch.
    await expect(
      groups.applyBatches('owner', [batch('c2')], async () => {
        throw new Error('injected');
      })
    ).rejects.toThrow('injected');
    // Erasing an epoch removes its rows, edges and objects.
    await groups.applyBatches('owner', [
      { ...batch('c3'), node: [] },
      {
        rows: [],
        removedRows: [],
        edges: [],
        removedEdges: [],
        objects: [],
        removedObjects: [],
        node: [],
        erase: ['c3'],
      },
    ]);

    const before = await groups.loadSnapshot('owner');
    expect(before.rows.map(r => r.chatId)).toEqual(['c1']);
    expect(before.edges.map(r => r.chatId)).toEqual(['c1']);
    expect(before.objects.map(r => r.chatId)).toEqual(['c1']);
    expect(before.node).toEqual([
      { kind: 'meta', key: 'null', fields: '{"next_seq":1}' },
    ]);

    await conn.secureStorageFlush();
    await conn.secureStorageLock();
    await conn.secureStorageCommitOnboardingCandidate();
    await conn.close();

    const reopened = await DatabaseConnection.create(config(domain));
    await reopened.secureStorageUnlock(password);
    const after = await new GroupQueries(reopened).loadSnapshot('owner');
    expect(after).toEqual(before);
    await reopened.close();
  }, 180_000);
});
