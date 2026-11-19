/**
 * Group chats between three in-process SDKs over an in-memory transport: the
 * group plaintexts travel inside the one-to-one sessions. No backend is used.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { SdkEventType } from '../../src/core/SdkEventEmitter';
import type { GroupService, GroupChange } from '../../src/services/groups';
import { deserializeMessage } from '../../src/utils/messageSerialization';
import { serializeGroupPlaintext } from '../../src/utils/messageSerialization';
import { MessageType } from '../../src/db';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

async function openPeer(net: MockMessageProtocol): Promise<GossipSdk> {
  const sdk = new GossipSdk();
  await sdk.init({ storage: getTestStorageConfig(), messageProtocol: net });
  await sdk.openSession({
    mnemonic: generateMnemonic(),
    encryptionKey: await generateEncryptionKey(),
    onPersist: async () => {},
    autoStartPolling: false,
    publishPublicKey: false,
  });
  (sdk.groups as unknown as { now: () => number }).now = () => clock;
  return sdk;
}

function texts(groups: GroupService, groupId: string): string[] {
  return groups
    .timeline(groupId)
    .flatMap(i =>
      i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
    );
}

describe('Group chats', { timeout: 120_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let carol: GossipSdk;
  let peers: GossipSdk[];

  /** Fetches on every SDK until nothing new arrives. */
  async function deliver(rounds = 6) {
    for (let r = 0; r < rounds; r++) {
      clock += 1_000;
      for (const p of peers) {
        await p.groups.tick();
        await p.messages.fetch();
      }
    }
  }

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  beforeEach(async () => {
    net = new MockMessageProtocol();
    alice = await openPeer(net);
    bob = await openPeer(net);
    carol = await openPeer(net);
    peers = [alice, bob, carol];
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');
    await setupSession(bob, carol, 'Carol', 'Bob');
  }, 120_000);

  afterEach(async () => {
    for (const p of peers) await p.closeSession();
  });

  it('a group plaintext is a keep-alive to a client without groups', () => {
    const bytes = serializeGroupPlaintext(new Uint8Array([1, 2, 3]));
    const d = deserializeMessage(bytes);
    expect(d.type).toBe(MessageType.KEEP_ALIVE);
    expect(d.content).toBe('');
    expect(d.groupPlaintext).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('creates, invites, accepts, messages, edits, deletes, removes and leaves', async () => {
    const changes: GroupChange[] = [];
    bob.on(SdkEventType.GROUPS_CHANGED, e => changes.push(...e.changes));

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    expect(alice.groups.list().map(g => g.groupId)).toEqual([groupId]);
    await deliver();

    // Bob and Carol are invited and accept.
    for (const p of [bob, carol]) {
      const [inv] = p.groups.invitations();
      expect(inv.epochId).toBe(groupId);
      expect(inv.name).toBe('Trip');
      expect(inv.owner).toBe(alice.userId);
      expect(await p.groups.acceptInvitation(inv.epochId)).toBe(groupId);
    }
    expect(changes.some(c => c.kind === 'Invitation')).toBe(true);
    await deliver();
    for (const p of peers) {
      const g = p.groups.get(groupId)!;
      expect(g.status).toBe('member');
      expect([...g.members].sort()).toEqual(
        [alice.userId, bob.userId, carol.userId].sort()
      );
    }

    // Messages.
    const hello = await alice.groups.sendMessage(groupId, 'hello');
    clock += 10;
    await bob.groups.sendMessage(groupId, 'hi alice');
    await deliver();
    for (const p of peers) {
      expect(texts(p.groups, groupId)).toEqual(['hello', 'hi alice']);
    }

    // Alice edits her message; Bob deletes his.
    await alice.groups.editMessage(groupId, hello.syncObjId, 'hello all');
    const bobs = bob.groups
      .timeline(groupId)
      .find(i => i.kind === 'message' && i.author === bob.userId);
    if (bobs?.kind !== 'message') throw new Error('no message from Bob');
    await bob.groups.deleteMessage(bobs.epochId, bobs.syncObjId);
    await deliver();
    for (const p of peers) {
      expect(texts(p.groups, groupId)).toEqual(['hello all']);
    }
    const edited = carol.groups
      .timeline(groupId)
      .find(i => i.kind === 'message');
    expect(edited?.kind === 'message' && edited.edited).toBe(true);

    // Alice removes Carol.
    await alice.groups.changeMembers(groupId, { remove: [carol.userId] });
    await deliver();
    expect([...alice.groups.get(groupId)!.members].sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
    expect([...bob.groups.get(groupId)!.members].sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
    expect(carol.groups.get(groupId)!.status).toBe('removed');
    expect(
      carol.groups
        .timeline(groupId)
        .some(i => i.kind === 'line' && i.line.type === 'youWereRemoved')
    ).toBe(true);

    // Bob leaves: the group is closed and erased on his device.
    await bob.groups.leave(groupId, 'Signed');
    await deliver();
    expect(bob.groups.get(groupId)).toBeNull();
    expect(bob.groups.list()).toEqual([]);
    // The owner's device removes the leaver once the leaves are quiet (§5.5).
    clock += 31_000;
    await deliver();
    expect(alice.groups.get(groupId)!.members).toEqual([alice.userId]);
    const queries = (
      bob as unknown as {
        _queries: {
          groups: {
            loadSnapshot(o: string): Promise<{
              rows: unknown[];
              edges: unknown[];
              objects: unknown[];
              node: { kind: string; fields?: string | null }[];
            }>;
          };
        };
      }
    )._queries;
    const snap = await queries.groups.loadSnapshot(bob.userId);
    expect(snap.rows).toEqual([]);
    expect(snap.edges).toEqual([]);
    expect(snap.objects).toEqual([]);
    expect(snap.node.some(n => (n.fields ?? '').includes('hello'))).toBe(false);
  });

  it('reopens the groups from the database after logging in again', async () => {
    const groupId = await alice.groups.createGroup('Book club', [bob.userId]);
    await deliver();
    await bob.groups.acceptInvitation(bob.groups.invitations()[0].epochId);
    await alice.groups.sendMessage(groupId, 'first');
    await deliver();

    const before = {
      list: bob.groups.list(),
      texts: texts(bob.groups, groupId),
    };
    const groups = bob.groups as unknown as {
      close(): Promise<void>;
      open(): Promise<void>;
    };
    await groups.close();
    await groups.open();
    expect(bob.groups.list()).toEqual(before.list);
    expect(texts(bob.groups, groupId)).toEqual(before.texts);

    await bob.groups.sendMessage(groupId, 'second');
    await deliver();
    expect(texts(alice.groups, groupId)).toEqual(['first', 'second']);
  });
});
