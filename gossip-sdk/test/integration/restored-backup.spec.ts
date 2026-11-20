/**
 * A device restored from a copy of its storage taken earlier (a backup), over
 * an in-memory transport that keeps the first value posted at a seeker and
 * refuses another with 409, as the server does. No backend is used.
 *
 * The copy holds the messaging sessions as they were: their next seekers are
 * ones the device already used after the copy was taken. Once the copy is
 * imported into a new generation, every session is given up at the first
 * unlock, except the requests still waiting for this user's answer, and
 * rebuilt with a new announcement to each contact (as the app does at its
 * first unlock after an import).
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKeyFromSeed } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import type { GroupService } from '../../src/services/groups';
import { SessionStatus } from '../../src/wasm/bindings';
import type { EncryptedMessage } from '../../src/api/messageProtocol/types';
import { SdkEventType } from '../../src/core/SdkEventEmitter';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

/** The server: the first value posted at a seeker stays, another is refused. */
class FirstWriteProtocol extends MockMessageProtocol {
  conflicts = 0;
  async sendMessage(message: EncryptedMessage): Promise<void> {
    const held = this.getStoredMessages().get(
      Array.from(message.seeker).join(',')
    );
    if (held && !sameBytes(held, message.ciphertext)) {
      this.conflicts++;
      throw new Error('HTTP 409: Conflict');
    }
    await super.sendMessage(message);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface Device {
  sdk: GossipSdk;
  mnemonic: string;
}

/** Everything the account's storage holds, as a backup copies it. */
interface Backup {
  mnemonic: string;
  tables: Map<string, { columns: string[]; rows: unknown[][] }>;
  blob: Uint8Array;
}

type Raw = {
  execRaw: (sql: string, params?: unknown[]) => Promise<unknown[][]>;
};
const rawOf = (sdk: GossipSdk) => (sdk as unknown as { _conn: Raw })._conn;

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

describe('A device restored from a backup', { timeout: 300_000 }, () => {
  let net: FirstWriteProtocol;
  let peers: GossipSdk[] = [];

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  afterEach(async () => {
    for (const p of peers) {
      if (p.isSessionOpen) await p.closeSession();
    }
    peers = [];
  });

  async function init(): Promise<GossipSdk> {
    const sdk = new GossipSdk();
    await sdk.init({ storage: getTestStorageConfig(), messageProtocol: net });
    return sdk;
  }

  async function openOn(
    sdk: GossipSdk,
    mnemonic: string,
    options: { encryptedSession?: Uint8Array; sessionReset?: boolean } = {}
  ): Promise<void> {
    await sdk.openSession({
      mnemonic,
      encryptionKey: await generateEncryptionKeyFromSeed(
        mnemonic,
        new Uint8Array(32)
      ),
      onPersist: async () => {},
      autoStartPolling: false,
      publishPublicKey: false,
      ...options,
    });
    (sdk.groups as unknown as { now: () => number }).now = () => clock;
    await sdk.conversations.settle();
  }

  async function device(): Promise<Device> {
    const mnemonic = generateMnemonic();
    const sdk = await init();
    await openOn(sdk, mnemonic);
    peers.push(sdk);
    return { sdk, mnemonic };
  }

  /** Delivers everything: announcements, session messages, group traffic. */
  async function deliver(rounds = 6, step = 1_000) {
    for (let r = 0; r < rounds; r++) {
      clock += step;
      for (const p of peers) {
        // What polling does: announcements and queued messages are sent,
        // session statuses reach the group engine.
        const refresh = (
          p as unknown as {
            _refresh: {
              stateUpdate: () => Promise<void>;
              refreshSessionsStatusEvent: () => Promise<void>;
            };
          }
        )._refresh;
        await refresh.stateUpdate();
        await refresh.refreshSessionsStatusEvent();
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

  async function backup(d: Device): Promise<Backup> {
    const raw = rawOf(d.sdk);
    const tables = new Map<string, { columns: string[]; rows: unknown[][] }>();
    const names = await raw.execRaw(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'"
    );
    for (const [name] of names as [string][]) {
      const columns = (await raw.execRaw(`PRAGMA table_info(\`${name}\`)`)).map(
        c => c[1] as string
      );
      tables.set(name, {
        columns,
        rows: await raw.execRaw(`SELECT * FROM \`${name}\``),
      });
    }
    return { mnemonic: d.mnemonic, tables, blob: d.sdk.getEncryptedSession() };
  }

  /** The storage of `b` on an SDK that has none of its own yet. */
  async function load(sdk: GossipSdk, b: Backup): Promise<void> {
    const raw = rawOf(sdk);
    for (const [name, { columns, rows }] of b.tables) {
      await raw.execRaw(`DELETE FROM \`${name}\``);
      const list = columns.map(c => `\`${c}\``).join(', ');
      const marks = columns.map(() => '?').join(', ');
      for (const row of rows) {
        await raw.execRaw(
          `INSERT INTO \`${name}\` (${list}) VALUES (${marks})`,
          row
        );
      }
    }
  }

  /**
   * The device of `old` is lost; its account comes back from `b`. With
   * `reset`, as at the first unlock after an import into a new generation:
   * the state is prepared, every session but the pending requests given
   * up, and the sessions with the contacts rebuilt. `crashAfter` stops
   * after that many of these steps (the device crashed).
   */
  async function restore(
    old: Device,
    b: Backup,
    options: { reset: boolean; crashAfter?: number } = { reset: true }
  ): Promise<Device> {
    if (old.sdk.isSessionOpen) await old.sdk.closeSession();
    peers = peers.filter(p => p !== old.sdk);
    const sdk = await init();
    await load(sdk, b);
    const d = { sdk, mnemonic: b.mnemonic };
    await unlock(d, b.blob, options);
    // A device that crashed does nothing more.
    if (options.crashAfter === undefined) peers.push(sdk);
    return d;
  }

  async function unlock(
    d: Device,
    blob: Uint8Array,
    options: { reset: boolean; crashAfter?: number }
  ): Promise<boolean> {
    const stop = options.crashAfter ?? Infinity;
    if (!options.reset) {
      await openOn(d.sdk, d.mnemonic, { encryptedSession: blob });
      return true;
    }
    await d.sdk.queries.messagingSessionRecovery.prepareReset();
    if (stop <= 1) return false;
    await openOn(d.sdk, d.mnemonic, {
      encryptedSession: blob,
      sessionReset: true,
    });
    if (stop <= 2) return false;
    await d.sdk.rebuildMessagingSessions();
    // Then the state is persisted (not before: a crash here starts again
    // from the copy's).
    return stop > 3;
  }

  async function sessionsActive(a: GossipSdk, b: GossipSdk) {
    expect(a.discussions.getStatus(b.userId)).toBe(SessionStatus.Active);
    expect(b.discussions.getStatus(a.userId)).toBe(SessionStatus.Active);
  }

  /** A message passes each way, in a group founded now. */
  async function messagesFlow(a: GossipSdk, b: GossipSdk) {
    const groupId = await a.groups.createGroup('After', [b.userId]);
    await deliver();
    await b.conversations.acceptInvitation(groupId);
    await deliver();
    await b.groups.sendMessage(groupId, 'to a');
    await a.groups.sendMessage(groupId, 'to b');
    await deliver();
    for (const p of [a, b]) {
      expect((await texts(p.groups, groupId)).sort()).toEqual(['to a', 'to b']);
    }
  }

  /** Alice and Bob, contacts with a direct chat where both wrote. */
  async function contacts(): Promise<{
    alice: Device;
    bob: Device;
    chat: string;
  }> {
    net = new FirstWriteProtocol();
    const alice = await device();
    const bob = await device();
    await setupSession(alice.sdk, bob.sdk, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    await deliver();
    const chat = (await alice.sdk.conversations.directChatWith(
      bob.sdk.userId
    ))!;
    expect(chat).toBeDefined();
    await alice.sdk.groups.sendMessage(chat, 'before');
    await deliver();
    return { alice, bob, chat };
  }

  it('gives up its sessions when imported: no seeker is used twice, and both sides catch up', async () => {
    const { alice, bob, chat } = await contacts();
    const copy = await backup(bob);
    // After the copy, both write: Bob's sessions move on on his device.
    await bob.sdk.groups.sendMessage(chat, 'gap from bob');
    await alice.sdk.groups.sendMessage(chat, 'gap from alice');
    await deliver();

    const renewals: string[] = [];
    alice.sdk.on(SdkEventType.SESSION_RENEWED, d =>
      renewals.push(d.contactUserId)
    );
    const restored = await restore(bob, copy);
    await deliver(10);

    expect(net.conflicts).toBe(0);
    await sessionsActive(alice.sdk, restored.sdk);
    // Alice's session was replaced by Bob's new announcement: her group
    // engine is told, and scans him.
    expect(renewals).toContain(restored.sdk.userId);
    // What was written while the copy was away reaches the restored device.
    await deliver(10, 10_000);
    expect(await texts(restored.sdk.groups, chat)).toEqual(
      expect.arrayContaining(['before', 'gap from bob', 'gap from alice'])
    );
    // What it writes now reaches Alice.
    await restored.sdk.groups.sendMessage(chat, 'after the restore');
    await deliver();
    expect(await texts(alice.sdk.groups, chat)).toContain('after the restore');
    await messagesFlow(alice.sdk, restored.sdk);
    expect(net.conflicts).toBe(0);
  });

  it('keeps a contact request waiting for its answer, which it then accepts', async () => {
    net = new FirstWriteProtocol();
    const carol = await device();
    const bob = await device();
    await carol.sdk.contacts.add(bob.sdk.userId, 'Bob', bob.sdk.publicKeys);
    const contact = (await carol.sdk.contacts.get(bob.sdk.userId))!;
    expect((await carol.sdk.discussions.start(contact)).success).toBe(true);
    await deliver();
    expect(bob.sdk.discussions.getStatus(carol.sdk.userId)).toBe(
      SessionStatus.PeerRequested
    );

    const restored = await restore(bob, await backup(bob));
    expect(restored.sdk.discussions.getStatus(carol.sdk.userId)).toBe(
      SessionStatus.PeerRequested
    );
    const request = (await restored.sdk.discussions.get(carol.sdk.userId))!;
    expect((await restored.sdk.discussions.accept(request)).success).toBe(true);
    await deliver(10);

    await sessionsActive(carol.sdk, restored.sdk);
    await messagesFlow(carol.sdk, restored.sdk);
    expect(net.conflicts).toBe(0);
  });

  it('keeps a contact request whose sender announced again after the copy', async () => {
    net = new FirstWriteProtocol();
    const carol = await device();
    const bob = await device();
    await carol.sdk.contacts.add(bob.sdk.userId, 'Bob', bob.sdk.publicKeys);
    const contact = (await carol.sdk.contacts.get(bob.sdk.userId))!;
    expect((await carol.sdk.discussions.start(contact)).success).toBe(true);
    await deliver();
    const copy = await backup(bob);
    // Carol announces again; the restored device reads it from the board.
    const again = await carol.sdk.discussions.createSessionForContact(
      bob.sdk.userId,
      new Uint8Array(0)
    );
    expect(again.success).toBe(true);
    await deliver();

    const restored = await restore(bob, copy);
    await deliver();
    expect(restored.sdk.discussions.getStatus(carol.sdk.userId)).toBe(
      SessionStatus.PeerRequested
    );
    const request = (await restored.sdk.discussions.get(carol.sdk.userId))!;
    expect((await restored.sdk.discussions.accept(request)).success).toBe(true);
    await deliver(10);

    await sessionsActive(carol.sdk, restored.sdk);
    await messagesFlow(carol.sdk, restored.sdk);
    expect(net.conflicts).toBe(0);
  });

  for (const crashAfter of [1, 2, 3]) {
    it(`reaches the same state after a crash at step ${crashAfter} of the reset`, async () => {
      const { alice, bob, chat } = await contacts();
      const copy = await backup(bob);
      await bob.sdk.groups.sendMessage(chat, 'gap from bob');
      await deliver();

      const crashed = await restore(bob, copy, { reset: true, crashAfter });
      await deliver();
      if (crashed.sdk.isSessionOpen) await crashed.sdk.closeSession();
      // The next unlock: the session state persisted is still the copy's.
      const sdk = crashed.sdk;
      const again = { sdk, mnemonic: copy.mnemonic };
      await unlock(again, copy.blob, { reset: true });
      peers.push(sdk);
      await deliver(10);

      await sessionsActive(alice.sdk, sdk);
      await messagesFlow(alice.sdk, sdk);
      expect(net.conflicts).toBe(0);
    });
  }

  it('reaches the same state after a crash once the new state was persisted', async () => {
    const { alice, bob } = await contacts();
    const copy = await backup(bob);
    const restored = await restore(bob, copy, { reset: true, crashAfter: 4 });
    // The new state was persisted, then the device crashed before the
    // journal moved on (nothing is sent before it does): the next unlock
    // resets again from what was persisted.
    const persisted = restored.sdk.getEncryptedSession();
    await restored.sdk.closeSession();
    await unlock(restored, persisted, { reset: true });
    peers.push(restored.sdk);
    await deliver(10);

    await sessionsActive(alice.sdk, restored.sdk);
    await messagesFlow(alice.sdk, restored.sdk);
    expect(net.conflicts).toBe(0);
  });

  it('converges with a bounded number of announcements when it reads the board again since the copy', async () => {
    const { alice, bob } = await contacts();
    const copy = await backup(bob);
    // After the copy, Alice renews her session with Bob's old device.
    const renewed = await alice.sdk.discussions.createSessionForContact(
      bob.sdk.userId,
      new Uint8Array(0)
    );
    expect(renewed.success).toBe(true);
    await deliver();

    const before = net.getStoredAnnouncements().length;
    const restored = await restore(bob, copy);
    await deliver(10);
    const settled = net.getStoredAnnouncements().length;
    expect(settled - before).toBeLessThanOrEqual(4);
    await deliver(10);
    expect(net.getStoredAnnouncements().length).toBe(settled);

    await sessionsActive(alice.sdk, restored.sdk);
    await messagesFlow(alice.sdk, restored.sdk);
    expect(net.conflicts).toBe(0);
  });
});
