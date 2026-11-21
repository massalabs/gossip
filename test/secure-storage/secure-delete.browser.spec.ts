/**
 * Deleted content leaves nothing in the database (SQLite `secure_delete`), in
 * the browser, with the real storage of each mode:
 * - secure storage: the real secure-storage worker; the database is read back
 *   page by page (`sqlite_dbpage`, free pages included) from the encrypted
 *   blocks, decrypted by the VFS with the account's password after a lock
 *   and an unlock, as someone made to unlock the account would read it;
 * - the earlier IndexedDB mode (`IDBBatchAtomicVFS`): every record of its
 *   IndexedDB store, read as stored.
 *
 * Alice (the storage under test) and Bob (in memory) share a group over an in-
 * memory transport, with one clock advanced by the test, no backend. Alice
 * writes a message with a random marker in its text and one in its metadata,
 * and Bob reacts to it; the markers are found in Alice's database. The group
 * message timer then erases it through the engine, and the markers are looked
 * for in every encoding a record may keep them in. With `secure_delete` off,
 * the same scenario leaves the marker: the check sees what a deletion leaves.
 *
 * Not covered here: the encrypted blocks a rewrite replaces. The VFS writes a
 * new ciphertext under the same key and the old one is left to IndexedDB (or
 * redb on Android and iOS) to reclaim.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { GossipSdk } from '@massalabs/gossip-sdk';
import type { DatabaseConnection } from '@massalabs/gossip-sdk/db/sqlite';
import { SECURE_STORAGE_IDB_NAME } from '@massalabs/gossip-sdk/db/secure-storage-namespaces';
import secureStorageWasmUrlRaw from '@massalabs/gossip-sdk/assets/generated/wasm-secureStorage/secureStorage_bg.wasm?url';
import waSqliteWasmUrl from 'wa-sqlite/dist/wa-sqlite.wasm?url';
import waSqliteAsyncWasmUrl from 'wa-sqlite/dist/wa-sqlite-async.wasm?url';
import { ensureWasmInitialized } from '../../gossip-sdk/src/wasm/loader';
import { generateMnemonic } from '../../gossip-sdk/src/crypto/bip39';
import { generateEncryptionKey } from '../../gossip-sdk/src/wasm/encryption';
import type { GroupService } from '../../gossip-sdk/src/services/groups';
import { MockMessageProtocol } from '../../gossip-sdk/test/mocks';
import { setupSession } from '../../gossip-sdk/test/utils';
import {
  findMarkers,
  newMarker,
} from '../../gossip-sdk/test/helpers/rawMarkers';

const secureStorageWasmUrl = new URL(
  secureStorageWasmUrlRaw,
  window.location.href
).href;

const PASSWORD = 'secure-delete-password';
const IDB_NAME = 'secure-delete-gossip-db';
const FIVE_MINUTES = 300_000;

type Mode = 'secureStorage' | 'idb';
type Chunk = { name: string; bytes: Uint8Array };

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

function connection(sdk: GossipSdk): DatabaseConnection {
  return (sdk as unknown as { _conn: DatabaseConnection })._conn;
}

function deleteIdb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => undefined;
  });
}

async function secureDelete(conn: DatabaseConnection): Promise<number> {
  const rows = (await conn.db.all(
    sql.raw('PRAGMA secure_delete')
  )) as unknown[][];
  return Number(rows[0][0]);
}

/** Every page of the open database, as the VFS returns it. */
async function dbPages(conn: DatabaseConnection): Promise<Chunk[]> {
  const rows = (await conn.db.all(
    sql.raw('SELECT pgno, data FROM sqlite_dbpage')
  )) as [number, Uint8Array][];
  return rows.map(([pgno, data]) => ({ name: `page ${pgno}`, bytes: data }));
}

/** Every record of the earlier mode's IndexedDB store, every version. */
function idbRecords(name: string): Promise<Chunk[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const out: Chunk[] = [];
      const stores = Array.from(db.objectStoreNames);
      if (stores.length === 0) {
        db.close();
        resolve(out);
        return;
      }
      const tx = db.transaction(stores, 'readonly');
      tx.oncomplete = () => {
        db.close();
        resolve(out);
      };
      tx.onerror = () => reject(tx.error);
      for (const store of stores) {
        const req = tx.objectStore(store).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return;
          const v = cursor.value as { data?: unknown };
          if (v.data instanceof Uint8Array) {
            out.push({
              name: `${store} ${JSON.stringify(cursor.key)}`,
              bytes: v.data,
            });
          }
          cursor.continue();
        };
      }
    };
  });
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

describe('Secure delete in the browser', () => {
  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  let opened: GossipSdk[] = [];

  beforeEach(async () => {
    await deleteIdb(SECURE_STORAGE_IDB_NAME);
    await deleteIdb(IDB_NAME);
  }, 60_000);

  afterEach(async () => {
    for (const p of opened) await p.destroy().catch(() => {});
    opened = [];
  });

  async function openPeer(
    net: MockMessageProtocol,
    mode: Mode | 'memory',
    secureDeleteOff = false
  ): Promise<GossipSdk> {
    const sdk = new GossipSdk();
    opened.push(sdk);
    await sdk.init({
      protocolBaseUrl: 'http://127.0.0.1:1',
      messageProtocol: net,
      storage:
        mode === 'secureStorage'
          ? {
              type: 'secureStorage',
              domain: 'vitest-secure-delete',
              secureStorageWasmUrl,
            }
          : mode === 'idb'
            ? { type: 'idb', name: IDB_NAME, wasmUrl: waSqliteAsyncWasmUrl }
            : {
                type: 'memory',
                wasmBinary: await (await fetch(waSqliteWasmUrl)).arrayBuffer(),
              },
    });
    if (mode === 'secureStorage') {
      await sdk.secureStorageBeginOnboardingCandidate();
      await sdk.secureStorageCreate(0, PASSWORD);
    }
    if (secureDeleteOff) {
      await connection(sdk).db.run(sql.raw('PRAGMA secure_delete = OFF'));
    } else {
      // The connection setup turned it on, in every mode.
      expect(await secureDelete(connection(sdk))).toBe(1);
    }
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      ...(mode === 'secureStorage'
        ? {}
        : {
            encryptionKey: await generateEncryptionKey(),
            onPersist: async () => {},
          }),
      autoStartPolling: false,
      publishPublicKey: false,
    });
    (sdk.groups as unknown as { now: () => number }).now = () => clock;
    await sdk.conversations.settle();
    return sdk;
  }

  /**
   * The scenario, for Alice in `mode`: the markers of the erased message
   * found in her database after the erasure (empty if none).
   */
  async function erasedByTimer(
    mode: Mode,
    secureDeleteOff: boolean
  ): Promise<string[]> {
    const net = new MockMessageProtocol();
    const alice = await openPeer(net, mode, secureDeleteOff);
    const bob = await openPeer(net, 'memory');
    return scenario(mode, alice, bob, [alice, bob]);
  }

  async function scenario(
    mode: Mode,
    alice: GossipSdk,
    bob: GossipSdk,
    peers: GossipSdk[]
  ): Promise<string[]> {
    const deliver = async (rounds = 6) => {
      for (let r = 0; r < rounds; r++) {
        clock += 1_000;
        for (const p of peers) {
          await (
            p as unknown as {
              _refresh: { refreshSessionsStatusEvent: () => Promise<void> };
            }
          )._refresh.refreshSessionsStatusEvent();
          await p.announcements.fetch();
          await p.conversations.catchUp();
          await p.groups.tick();
          await p.groups.settle();
          await p.messages.fetch();
          await p.groups.settle();
          await p.conversations.settle();
        }
      }
    };
    const raw = async (): Promise<Chunk[]> =>
      mode === 'secureStorage'
        ? dbPages(connection(alice))
        : idbRecords(IDB_NAME);

    await setupSession(alice, bob, 'Bob', 'Alice');
    const groupId = await alice.groups.createGroup('Trip', [bob.userId], {
      messageTimer: FIVE_MINUTES,
    });
    await deliver();
    const [inv] = await bob.groups.invitations();
    await bob.groups.acceptInvitation(inv.epochId);
    await deliver();

    const text = newMarker('SDTEXT');
    const meta = newMarker('SDMETA');
    const published = await alice.groups.sendMessage(groupId, text, {
      metadata: { note: new TextEncoder().encode(meta) },
    });
    await deliver(3);
    await bob.groups.react(groupId, published.syncObjId, '👍');
    await deliver(3);
    expect(await texts(alice.groups, groupId)).toEqual([text]);
    // Before the erasure the text is in the database: the search sees it.
    expect(findMarkers(await raw(), [text]).length).toBeGreaterThan(0);

    clock += FIVE_MINUTES + 1;
    for (const p of peers) {
      await p.groups.tick();
      await p.groups.settle();
      expect(await texts(p.groups, groupId)).toEqual([]);
    }
    await deliver(2);
    await alice.closeSession();
    if (mode === 'secureStorage') {
      // Read back from the stored blocks, through a fresh connection.
      await alice.secureStorageLock();
      await alice.secureStorageCommitOnboardingCandidate();
      expect(await alice.secureStorageUnlock(PASSWORD)).toBe(true);
    }
    return findMarkers(await raw(), [text, meta]);
  }

  it('leaves nothing of a message the timer erased, in secure storage', async () => {
    expect(await erasedByTimer('secureStorage', false)).toEqual([]);
  }, 300_000);

  it('leaves the marker in secure storage with secure_delete off', async () => {
    expect((await erasedByTimer('secureStorage', true)).length).toBeGreaterThan(
      0
    );
  }, 300_000);

  it('leaves nothing of a message the timer erased, in the earlier IndexedDB mode', async () => {
    expect(await erasedByTimer('idb', false)).toEqual([]);
  }, 300_000);

  it('leaves the marker in the earlier IndexedDB mode with secure_delete off', async () => {
    expect((await erasedByTimer('idb', true)).length).toBeGreaterThan(0);
  }, 300_000);
});
