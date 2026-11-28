/**
 * Deleted content leaves nothing in the database file (SQLite `secure_delete`),
 * between in-process SDKs whose databases are files (`node-fs`), over an
 * in-memory transport, with one clock advanced by the test. No backend is
 * used. The secure-storage mode has the same check in the browser
 * (`test/secure-storage/secure-delete.browser.spec.ts` at the app's root).
 *
 * A message is written with a random marker in its text and in its metadata,
 * and a reaction is added to it; the markers are found in the raw files.
 * Then the message is erased, and every file of the database directory is read
 * as stored, the markers looked for in every encoding a record may keep them
 * in:
 * - erased by the group message timer, through the engine;
 * - deleted by hand, for everyone;
 * - a contact's one-to-one messages, the contact deleted.
 * With `secure_delete` off, the same scenario leaves the marker in the file:
 * the check sees what a deletion leaves. With `FAST`, a long message stays in
 * the overflow pages its deletion frees: the SDK sets `ON`.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { findMarkers, newMarker } from '../helpers/rawMarkers';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import type { DatabaseConnection } from '../../src/db/sqlite';
import { MessageDirection, MessageStatus, MessageType } from '../../src/db';
import type { GroupService } from '../../src/services/groups';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

const FIVE_MINUTES = 300_000;

interface Peer {
  sdk: GossipSdk;
  dir: string;
}

function connection(sdk: GossipSdk): DatabaseConnection {
  return (sdk as unknown as { _conn: DatabaseConnection })._conn;
}

async function secureDelete(sdk: GossipSdk): Promise<number> {
  const rows = (await connection(sdk).db.all(
    sql.raw('PRAGMA secure_delete')
  )) as unknown[][];
  return Number(rows[0][0]);
}

/** Every file of a peer's database directory, as stored. */
function rawFiles(peer: Peer): { name: string; bytes: Uint8Array }[] {
  return readdirSync(peer.dir).map(name => ({
    name,
    bytes: readFileSync(join(peer.dir, name)),
  }));
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

describe('Secure delete (file database)', { timeout: 300_000 }, () => {
  let net: MockMessageProtocol;
  let peers: Peer[] = [];

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  afterEach(async () => {
    for (const p of peers) {
      await p.sdk.closeSession().catch(() => {});
      rmSync(p.dir, { recursive: true, force: true });
    }
    peers = [];
  });

  /** `secure_delete` as the SDK sets it, or another setting to compare. */
  type Setting = 'default' | 'OFF' | 'FAST';

  async function openPeer(setting: Setting): Promise<GossipSdk> {
    const dir = mkdtempSync(join(tmpdir(), 'gossip-secure-delete-'));
    const sdk = new GossipSdk();
    await sdk.init({
      storage: { type: 'node-fs', path: dir },
      messageProtocol: net,
    });
    if (setting !== 'default') {
      await connection(sdk).db.run(
        sql.raw(`PRAGMA secure_delete = ${setting}`)
      );
    }
    await sdk.openSession({
      mnemonic: generateMnemonic(),
      encryptionKey: await generateEncryptionKey(),
      onPersist: async () => {},
      autoStartPolling: false,
      publishPublicKey: false,
    });
    (sdk.groups as unknown as { now: () => number }).now = () => clock;
    await sdk.conversations.settle();
    peers.push({ sdk, dir });
    return sdk;
  }

  async function open(setting: Setting = 'default'): Promise<GossipSdk[]> {
    net = new MockMessageProtocol();
    const alice = await openPeer(setting);
    const bob = await openPeer(setting);
    await setupSession(alice, bob, 'Bob', 'Alice');
    return [alice, bob];
  }

  /** Delivers everything: announcements, session messages, group traffic. */
  async function deliver(rounds = 6) {
    for (let r = 0; r < rounds; r++) {
      clock += 1_000;
      for (const { sdk: p } of peers) {
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
  }

  /**
   * Alice founds a group with Bob (`timer`), writes a message with a marker in
   * its text and one in its metadata, and Bob reacts to it. Returns the
   * markers, found in both raw databases. A `long` text (11 KB) is stored
   * across overflow pages, which its deletion frees whole.
   */
  async function markedGroupMessage(
    alice: GossipSdk,
    bob: GossipSdk,
    timer: number,
    long = false
  ): Promise<{
    groupId: string;
    epochId: string;
    syncObjId: string;
    markers: string[];
  }> {
    const groupId = await alice.groups.createGroup('Trip', [bob.userId], {
      messageTimer: timer,
    });
    await deliver();
    const [inv] = await bob.groups.invitations();
    await bob.groups.acceptInvitation(inv.epochId);
    await deliver();

    const text = newMarker('SDTEXT');
    const meta = newMarker('SDMETA');
    const body = long ? 'x'.repeat(6000) + text + 'y'.repeat(5000) : text;
    const published = await alice.groups.sendMessage(groupId, body, {
      metadata: { note: new TextEncoder().encode(meta) },
    });
    await deliver(3);
    await bob.groups.react(groupId, published.syncObjId, '👍');
    await deliver(3);
    for (const p of [alice, bob]) {
      expect(await texts(p.groups, groupId)).toEqual([body]);
    }
    const epochId = (await alice.groups.get(groupId))!.timers[0].epochId;
    // Before the erasure the text is in both files: the search sees it.
    for (const p of peers) {
      expect(findMarkers(rawFiles(p), [text]).length).toBeGreaterThan(0);
    }
    return {
      groupId,
      epochId,
      syncObjId: published.syncObjId,
      markers: [text, meta],
    };
  }

  async function erasedByTimer(
    setting: Setting,
    long = false
  ): Promise<string[]> {
    const [alice, bob] = await open(setting);
    const { groupId, markers } = await markedGroupMessage(
      alice,
      bob,
      FIVE_MINUTES,
      long
    );
    clock += FIVE_MINUTES + 1;
    for (const p of [alice, bob]) {
      await p.groups.tick();
      await p.groups.settle();
      expect(await texts(p.groups, groupId)).toEqual([]);
    }
    await deliver(2);
    for (const p of [alice, bob]) await p.closeSession();
    return peers.flatMap(p => findMarkers(rawFiles(p), markers));
  }

  it('turns secure_delete on for a file database', async () => {
    const [alice] = await open();
    expect(await secureDelete(alice)).toBe(1);
  });

  it('leaves nothing of a message the timer erased, its metadata and reaction included', async () => {
    expect(await erasedByTimer('default')).toEqual([]);
  });

  it('leaves the marker with secure_delete off: the check sees what a deletion leaves', async () => {
    const found = await erasedByTimer('OFF');
    expect(found.length).toBeGreaterThan(0);
  });

  it('leaves nothing of a long message the timer erased, its overflow pages included', async () => {
    expect(await erasedByTimer('default', true)).toEqual([]);
  });

  it('leaves a long message in the pages it freed with secure_delete FAST: hence ON', async () => {
    const found = await erasedByTimer('FAST', true);
    expect(found.length).toBeGreaterThan(0);
  });

  it('leaves nothing of a message deleted by hand for everyone', async () => {
    const [alice, bob] = await open();
    const { groupId, epochId, syncObjId, markers } = await markedGroupMessage(
      alice,
      bob,
      0
    );
    await alice.groups.deleteMessage(epochId, syncObjId);
    await deliver(3);
    for (const p of [alice, bob]) {
      expect(await texts(p.groups, groupId)).toEqual([]);
    }
    for (const p of [alice, bob]) await p.closeSession();
    expect(peers.flatMap(p => findMarkers(rawFiles(p), markers))).toEqual([]);
  });

  it("leaves nothing of a deleted contact's one-to-one messages", async () => {
    const [alice, bob] = await open();
    const marker = newMarker('SDDIRECT');
    await alice.queries.messages.insert({
      ownerUserId: alice.userId,
      contactUserId: bob.userId,
      content: marker,
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });
    expect(findMarkers(rawFiles(peers[0]), [marker]).length).toBeGreaterThan(0);
    expect((await alice.contacts.delete(bob.userId)).success).toBe(true);
    await alice.closeSession();
    expect(findMarkers(rawFiles(peers[0]), [marker])).toEqual([]);
  });
});
