/**
 * Reactions and media in group chats (§7.6) between three in-process SDKs over
 * an in-memory transport. No backend is used.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { SdkEventType } from '../../src/core/SdkEventEmitter';
import type {
  GroupChange,
  GroupMessage,
  GroupReaction,
} from '../../src/services/groups';
import { GroupInvalidReactionError } from '../../src/services/groups';
import type { Queries } from '../../src/db/queries';

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

/** The engine's records and its open/close, which the restore test reaches. */
interface Internals {
  queries: Queries;
  owner: string;
  close(): Promise<void>;
  open(): Promise<void>;
  node: { publish_reaction: (...args: unknown[]) => string } | null;
  messageProtocol: { sendMessage: (m: unknown) => Promise<void> };
}
const internals = (sdk: GossipSdk) => sdk.groups as unknown as Internals;

describe('Group reactions and media', { timeout: 180_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let carol: GossipSdk;
  let peers: GossipSdk[];
  let groupId: string;
  let target: GroupMessage;

  /** Fetches on every SDK in `online` until nothing new arrives. */
  async function deliver(online: GossipSdk[] = peers, rounds = 6) {
    for (let r = 0; r < rounds; r++) {
      clock += 1_000;
      for (const p of online) {
        await p.groups.tick();
        await p.groups.settle();
        await p.messages.fetch();
        await p.groups.settle();
      }
    }
  }

  async function messages(p: GossipSdk): Promise<GroupMessage[]> {
    return (await p.groups.timeline(groupId)).filter(
      (i): i is GroupMessage => i.kind === 'message'
    );
  }

  /** The reactions shown on the message `syncObjId`, or null if it is not shown. */
  async function reactionsOn(
    p: GossipSdk,
    syncObjId = target.syncObjId
  ): Promise<GroupReaction[] | null> {
    const m = (await messages(p)).find(i => i.syncObjId === syncObjId);
    return m ? m.reactions : null;
  }

  /** Emoji and authors only (`mine` depends on who reads). */
  const shape = (r: GroupReaction[] | null) =>
    r?.map(x => [x.emoji, [...x.authors].sort()]) ?? null;

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
    groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.groups.acceptInvitation(inv.epochId);
    }
    await deliver();
    await bob.groups.sendMessage(groupId, 'who brings the tent?');
    await deliver();
    target = (await messages(alice))[0];
    expect(target.body).toEqual({
      type: 'text',
      text: 'who brings the tent?',
    });
    expect(target.reactions).toEqual([]);
  }, 180_000);

  afterEach(async () => {
    for (const p of peers) await p.closeSession();
  });

  it('adds, removes and adds again, never as a message of its own', async () => {
    const changes: GroupChange[] = [];
    bob.on(SdkEventType.GROUPS_CHANGED, e => changes.push(...e.changes));

    await alice.groups.react(groupId, target.syncObjId, '👍');
    expect(await reactionsOn(alice)).toEqual([
      { emoji: '👍', authors: [alice.userId], mine: true },
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      expect(await reactionsOn(p)).toEqual([
        { emoji: '👍', authors: [alice.userId], mine: false },
      ]);
      // A reaction is listed on its target, never as a message.
      expect(await messages(p)).toHaveLength(1);
    }
    // On Bob, the reaction changed the group without counting as a message.
    expect(changes.filter(c => c.groupId === groupId).map(c => c.kind)).toEqual(
      expect.arrayContaining(['Reactions'])
    );
    expect(changes.some(c => c.kind === 'Messages')).toBe(false);

    await alice.groups.unreact(groupId, target.syncObjId, '👍');
    expect(await reactionsOn(alice)).toEqual([]);
    await deliver();
    for (const p of peers) expect(await reactionsOn(p)).toEqual([]);

    await alice.groups.react(groupId, target.syncObjId, '👍');
    await deliver();
    for (const p of peers) {
      expect(shape(await reactionsOn(p))).toEqual([['👍', [alice.userId]]]);
    }
    expect(changes.some(c => c.kind === 'Messages')).toBe(false);

    // A message still counts as one.
    await alice.groups.sendMessage(groupId, 'me');
    await deliver();
    expect(changes.some(c => c.kind === 'Messages')).toBe(true);
  });

  it('groups two people with the same emoji, and one person with two emojis', async () => {
    await alice.groups.react(groupId, target.syncObjId, '🎉');
    await carol.groups.react(groupId, target.syncObjId, '🎉');
    await carol.groups.react(groupId, target.syncObjId, '❤️');
    await deliver();
    for (const p of peers) {
      const r = (await reactionsOn(p))!;
      expect(shape(r)).toEqual(
        expect.arrayContaining([
          ['🎉', [alice.userId, carol.userId].sort()],
          ['❤️', [carol.userId]],
        ])
      );
      expect(r).toHaveLength(2);
      const party = r.find(x => x.emoji === '🎉')!;
      expect(party.mine).toBe(p !== bob);
      expect(r.find(x => x.emoji === '❤️')!.mine).toBe(p === carol);
    }
    // Reacting twice with the same emoji is one reaction.
    await alice.groups.react(groupId, target.syncObjId, '🎉');
    await deliver();
    const party = (await reactionsOn(bob))!.find(x => x.emoji === '🎉')!;
    expect(party.authors).toHaveLength(2);
  });

  it('no longer lists the reactions of a message deleted later', async () => {
    await alice.groups.react(groupId, target.syncObjId, '👍');
    await deliver();
    expect(shape(await reactionsOn(carol))).toEqual([['👍', [alice.userId]]]);
    await bob.groups.deleteMessage(target.epochId, target.syncObjId);
    await deliver();
    for (const p of peers) {
      expect(await reactionsOn(p)).toBeNull();
      expect(await messages(p)).toEqual([]);
    }
    // Reacting to it now is refused: it is not shown.
    await expect(
      carol.groups.react(groupId, target.syncObjId, '👍')
    ).rejects.toThrow(/groups:unknown-message/);
  });

  it('keeps reactions across a reopen', async () => {
    await alice.groups.react(groupId, target.syncObjId, '👍');
    await bob.groups.react(groupId, target.syncObjId, '😂');
    await deliver();
    const before = await reactionsOn(carol);
    for (const p of peers) {
      await internals(p).close();
      await internals(p).open();
    }
    expect(await reactionsOn(carol)).toEqual(before);
    expect((await reactionsOn(bob))!.find(x => x.emoji === '😂')!.mine).toBe(
      true
    );
    // And can still be removed after it.
    await bob.groups.unreact(groupId, target.syncObjId, '😂');
    await deliver();
    for (const p of peers) {
      expect(shape(await reactionsOn(p))).toEqual([['👍', [alice.userId]]]);
    }
  });

  it('delivers a reaction made offline once the device is back, and converges', async () => {
    // Carol is offline: she reacts, nothing leaves her device or reaches it.
    // (The transport is shared by the three SDKs: only Carol's is replaced.)
    const transport = internals(carol).messageProtocol;
    internals(carol).messageProtocol = {
      sendMessage: async () => {
        throw new Error('network unreachable');
      },
    };
    await carol.groups.react(groupId, target.syncObjId, '🙏');
    await alice.groups.react(groupId, target.syncObjId, '🙏');
    await deliver([alice, bob]);
    expect(shape(await reactionsOn(bob))).toEqual([['🙏', [alice.userId]]]);
    expect(shape(await reactionsOn(carol))).toEqual([['🙏', [carol.userId]]]);
    // Back online: her outbox is sent again on its retry.
    internals(carol).messageProtocol = transport;
    clock += 60 * 60 * 1000;
    await deliver();
    for (const p of peers) {
      expect(shape(await reactionsOn(p))).toEqual([
        ['🙏', [alice.userId, carol.userId].sort()],
      ]);
    }
  });

  it('resolves a remove and an add of equal dates to removed, on every device', async () => {
    const i = internals(alice);
    // A backup of Alice's group records from before her reaction.
    const backup = await i.queries.groups.loadSnapshot(i.owner);
    const at = clock;
    await alice.groups.react(groupId, target.syncObjId, '👍');
    await deliver([alice, bob, carol], 2);
    expect(shape(await reactionsOn(bob))).toEqual([['👍', [alice.userId]]]);
    // Alice's device is restored from that backup, so it never made the add;
    // at the same date it removes the reaction: the two versions tie.
    await i.close();
    await i.queries.groups.resetEngine(i.owner);
    await i.queries.groups.applyBatches(i.owner, [
      { ...backup, removedRows: [], erase: [] },
    ]);
    await i.open();
    expect(await reactionsOn(alice)).toEqual([]);
    const saved = clock;
    clock = at;
    await alice.groups.unreact(groupId, target.syncObjId, '👍');
    clock = saved;
    await deliver();
    for (const p of peers) expect(await reactionsOn(p)).toEqual([]);
  });

  it('refuses an empty emoji or one over 64 bytes before the engine', async () => {
    const node = internals(alice).node!;
    const publish = vi.spyOn(node, 'publish_reaction');
    const refused = async (emoji: string, reason: string, size: number) => {
      const e = await alice.groups.react(groupId, target.syncObjId, emoji).then(
        () => null,
        (err: unknown) => err
      );
      expect(e).toBeInstanceOf(GroupInvalidReactionError);
      expect(e).toMatchObject({ reason, size, max: 64 });
    };
    await refused('', 'empty', 0);
    await refused('👍'.repeat(16) + 'x', 'too-long', 65);
    await refused('\ud83d', 'malformed', 3);
    expect(publish).not.toHaveBeenCalled();
    // 64 bytes is the limit.
    await alice.groups.react(groupId, target.syncObjId, '👍'.repeat(16));
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('refuses a reaction in a group this device can no longer write to', async () => {
    await alice.groups.changeMembers(groupId, { remove: [carol.userId] });
    await deliver();
    expect((await carol.groups.get(groupId))!.status).toBe('removed');
    await expect(
      carol.groups.react(groupId, target.syncObjId, '👍')
    ).rejects.toThrow(/groups:read-only/);
  });

  it('shows a media message by its mimetype and length, without its data', async () => {
    const node = internals(bob).node as unknown as {
      publish_media: (
        epoch: Uint8Array,
        mimetype: string,
        data: Uint8Array,
        metadata: string,
        now: number
      ) => string;
    };
    const epoch = Uint8Array.from(
      target.epochId.match(/../g)!.map(h => parseInt(h, 16))
    );
    // There is no API to send files: the engine is called directly.
    await (
      bob.groups as unknown as {
        run: (op: (n: unknown) => unknown) => Promise<unknown>;
      }
    ).run(() =>
      node.publish_media(epoch, 'image/png', new Uint8Array(1234), '[]', clock)
    );
    await deliver();
    for (const p of peers) {
      const media = (await messages(p)).find(m => m.body.type === 'media')!;
      expect(media.body).toEqual({
        type: 'media',
        mimetype: 'image/png',
        dataLength: 1234,
      });
      expect(media.author).toBe(bob.userId);
    }
    // It can be reacted to like any message.
    const media = (await messages(alice)).find(m => m.body.type === 'media')!;
    await alice.groups.react(groupId, media.syncObjId, '👀');
    await deliver();
    expect(shape(await reactionsOn(carol, media.syncObjId))).toEqual([
      ['👀', [alice.userId]],
    ]);
  });
});
