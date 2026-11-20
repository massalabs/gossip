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
import { GroupMessageTooLargeError } from '../../src/services/groups';
import { MessageType } from '../../src/db';
import type { Queries } from '../../src/db/queries';
import { vi } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';

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

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

/** The group service's private parts that the failure tests reach into. */
interface Internals {
  queries: Queries;
  persistSession: () => Promise<void>;
  messageProtocol: { sendMessage: (m: unknown) => Promise<void> };
  session: { peerSessionStatus: (p: Uint8Array) => number };
  node: { poll_outbox: (now: number) => unknown[] } | null;
}
const internals = (sdk: GossipSdk) => sdk.groups as unknown as Internals;
const queriesOf = (sdk: GossipSdk) =>
  (sdk as unknown as { _queries: Queries })._queries;

/** The engine methods a test spies on. */
interface GroupsNodeLike {
  publish_message: (...args: unknown[]) => string;
  publish_edit: (...args: unknown[]) => string;
  local_edit: (...args: unknown[]) => void;
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
        await p.groups.settle();
        await p.messages.fetch();
        await p.groups.settle();
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

  it('creates, invites, accepts, messages, edits, deletes, removes and leaves', async () => {
    const changes: GroupChange[] = [];
    bob.on(SdkEventType.GROUPS_CHANGED, e => changes.push(...e.changes));

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    expect((await alice.groups.list()).map(g => g.groupId)).toEqual([groupId]);
    await deliver();

    // Bob and Carol are invited and accept.
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      expect(inv.epochId).toBe(groupId);
      expect(inv.name).toBe('Trip');
      expect(inv.owner).toBe(alice.userId);
      expect(await p.groups.acceptInvitation(inv.epochId)).toBe(groupId);
    }
    expect(changes.some(c => c.kind === 'Invitation')).toBe(true);
    await deliver();
    for (const p of peers) {
      const g = (await p.groups.get(groupId))!;
      expect(g.status).toBe('member');
      expect([...g.members].sort()).toEqual(
        [alice.userId, bob.userId, carol.userId].sort()
      );
    }
    // Alice created the group; Bob and Carol read that she added them.
    const first = async (p: GossipSdk) =>
      (await p.groups.timeline(groupId)).find(i => i.kind === 'line');
    expect(await first(alice)).toMatchObject({
      line: { type: 'founded', owner: alice.userId },
    });
    for (const p of [bob, carol]) {
      expect(await first(p)).toMatchObject({
        line: { type: 'joined', epoch: groupId, by: alice.userId },
      });
    }

    // Messages.
    const hello = await alice.groups.sendMessage(groupId, 'hello');
    clock += 10;
    await bob.groups.sendMessage(groupId, 'hi alice');
    await deliver();
    for (const p of peers) {
      expect(await texts(p.groups, groupId)).toEqual(['hello', 'hi alice']);
    }

    // Alice edits her message; Bob deletes his.
    await alice.groups.editMessage(groupId, hello.syncObjId, 'hello all');
    const bobs = (await bob.groups.timeline(groupId)).find(
      i => i.kind === 'message' && i.author === bob.userId
    );
    if (bobs?.kind !== 'message') throw new Error('no message from Bob');
    await bob.groups.deleteMessage(bobs.epochId, bobs.syncObjId);
    await deliver();
    for (const p of peers) {
      expect(await texts(p.groups, groupId)).toEqual(['hello all']);
    }
    const edited = (await carol.groups.timeline(groupId)).find(
      i => i.kind === 'message'
    );
    expect(edited?.kind === 'message' && edited.edited).toBe(true);

    // Alice removes Carol.
    await alice.groups.changeMembers(groupId, { remove: [carol.userId] });
    await deliver();
    expect([...(await alice.groups.get(groupId))!.members].sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
    expect([...(await bob.groups.get(groupId))!.members].sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
    expect(
      (await bob.groups.timeline(groupId)).some(
        i =>
          i.kind === 'line' &&
          i.line.type === 'epochChange' &&
          i.line.by === alice.userId &&
          i.line.removed.includes(carol.userId)
      )
    ).toBe(true);
    expect((await carol.groups.get(groupId))!.status).toBe('removed');
    expect(
      (await carol.groups.timeline(groupId)).some(
        i => i.kind === 'line' && i.line.type === 'youWereRemoved'
      )
    ).toBe(true);

    // Bob leaves: the group is closed and erased on his device.
    await bob.groups.leave(groupId, 'Signed');
    await deliver();
    expect(await bob.groups.get(groupId)).toBeNull();
    expect(await bob.groups.list()).toEqual([]);
    // The owner's device removes the leaver once the leaves are quiet (§5.5).
    clock += 31_000;
    await deliver();
    expect((await alice.groups.get(groupId))!.members).toEqual([alice.userId]);
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
    // Bob shared no other group: his tables hold nothing but the closed-chat
    // marker(s), the engine's counter, his own keys (recorded again by the
    // signer at every tick) and the contacts he accepted (§13.8), at once.
    const own = JSON.stringify(bytesToHex(bob.userIdBytes));
    const kinds = new Set(
      snap.node
        .filter(n => !(n.kind === 'keys' && n.key === own))
        .map(n => n.kind)
    );
    expect([...kinds].sort()).toEqual(['contacts', 'markers', 'meta']);

    // Alice re-learns Carol's keys from her contact when she adds her to a new
    // group, after the engine dropped them with the last group they shared.
    const again = await alice.groups.createGroup('Again', [carol.userId]);
    await deliver();
    await carol.groups.acceptInvitation(
      (await carol.groups.invitations()).find(i => i.epochId === again)!.epochId
    );
    await alice.groups.sendMessage(again, 'welcome back');
    await deliver();
    expect(await texts(carol.groups, again)).toEqual(['welcome back']);
  });

  it('reopens the groups from the database after logging in again', async () => {
    const groupId = await alice.groups.createGroup('Book club', [bob.userId]);
    await deliver();
    await bob.groups.acceptInvitation(
      (await bob.groups.invitations())[0].epochId
    );
    await alice.groups.sendMessage(groupId, 'first');
    await deliver();

    const before = {
      list: await bob.groups.list(),
      texts: await texts(bob.groups, groupId),
    };
    const groups = bob.groups as unknown as {
      close(): Promise<void>;
      open(): Promise<void>;
    };
    await groups.close();
    await groups.open();
    expect(await bob.groups.list()).toEqual(before.list);
    expect(await texts(bob.groups, groupId)).toEqual(before.texts);

    await bob.groups.sendMessage(groupId, 'second');
    await deliver();
    expect(await texts(alice.groups, groupId)).toEqual(['first', 'second']);
  });

  it('refuses text and metadata over their limits before the engine', async () => {
    const groupId = await alice.groups.createGroup('Sizes', [bob.userId]);
    const limits = alice.groups.messageLimits;
    expect(limits).toEqual({ textBytes: 16_384, metadataBytes: 16_384 });
    const node = (alice.groups as unknown as { node: GroupsNodeLike }).node;
    const publish = vi.spyOn(node, 'publish_message');
    const edit = vi.spyOn(node, 'publish_edit');
    const localEdit = vi.spyOn(node, 'local_edit');
    const tooLarge = async (
      p: Promise<unknown>,
      part: 'text' | 'metadata',
      size: number
    ) => {
      const e = await p.then(
        () => null,
        (err: unknown) => err
      );
      expect(e).toBeInstanceOf(GroupMessageTooLargeError);
      expect(e).toMatchObject({ part, size, max: 16_384 });
    };

    // Text is counted in UTF-8 bytes, not characters.
    const sent = await alice.groups.sendMessage(groupId, 'x'.repeat(16_384));
    await alice.groups.sendMessage(groupId, '\u00e9'.repeat(8_192));
    expect(publish).toHaveBeenCalledTimes(2);
    await tooLarge(
      alice.groups.sendMessage(groupId, 'x'.repeat(16_385)),
      'text',
      16_385
    );
    await tooLarge(
      alice.groups.sendMessage(groupId, '\u00e9'.repeat(8_193)),
      'text',
      16_386
    );
    // Metadata as encoded: a 1-byte key and an n-byte value are 9 + n bytes.
    await alice.groups.sendMessage(groupId, 'meta', {
      metadata: { m: new Uint8Array(16_375) },
    });
    expect(publish).toHaveBeenCalledTimes(3);
    await tooLarge(
      alice.groups.sendMessage(groupId, 'meta', {
        metadata: { m: new Uint8Array(16_376) },
      }),
      'metadata',
      16_385
    );
    expect(publish).toHaveBeenCalledTimes(3);

    // Edits and local-only edits follow the same limits.
    await tooLarge(
      alice.groups.editMessage(groupId, sent.syncObjId, 'x'.repeat(16_385)),
      'text',
      16_385
    );
    await tooLarge(
      alice.groups.editMessage(groupId, sent.syncObjId, 'x', {
        metadata: { m: new Uint8Array(16_376) },
      }),
      'metadata',
      16_385
    );
    await tooLarge(
      alice.groups.editMessageLocally(groupId, sent.syncObjId, {
        body: { type: 'text', text: 'x'.repeat(16_385) },
      }),
      'text',
      16_385
    );
    expect(edit).not.toHaveBeenCalled();
    expect(localEdit).not.toHaveBeenCalled();
    await alice.groups.editMessage(groupId, sent.syncObjId, 'y'.repeat(16_384));
    expect(edit).toHaveBeenCalledTimes(1);
  });

  it('replies, edits locally and retries', async () => {
    const groupId = await alice.groups.createGroup('Notes', [bob.userId]);
    await deliver();
    await bob.groups.acceptInvitation(
      (await bob.groups.invitations())[0].epochId
    );
    const first = await alice.groups.sendMessage(groupId, 'question');
    await deliver();

    await bob.groups.sendMessage(groupId, 'answer', {
      replyTo: [{ epochId: groupId, syncObjId: first.syncObjId }],
    });
    await deliver();
    const reply = (await alice.groups.timeline(groupId)).find(
      i => i.kind === 'message' && i.author === bob.userId
    );
    expect(reply?.kind === 'message' && reply.replyTo).toMatchObject([
      {
        epochId: groupId,
        syncObjId: first.syncObjId,
        message: { body: { type: 'text', text: 'question' } },
      },
    ]);

    // A local-only edit changes Alice's copy and nothing else.
    await alice.groups.editMessageLocally(groupId, first.syncObjId, {
      body: { type: 'text', text: 'my own copy' },
    });
    await deliver();
    expect(await texts(alice.groups, groupId)).toEqual([
      'my own copy',
      'answer',
    ]);
    expect(await texts(bob.groups, groupId)).toEqual(['question', 'answer']);
    await expect(
      alice.groups.editMessageLocally(groupId, first.syncObjId, {
        createdAt: clock + 15 * 24 * 3600 * 1000,
      })
    ).rejects.toThrow();

    // Retry synchronisation republishes the altered result.
    await alice.groups.retryMessage(groupId, first.syncObjId);
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['my own copy', 'answer']);

    // A local deletion hides it here only.
    await bob.groups.deleteMessageLocally(groupId, first.syncObjId);
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['answer']);
    expect(await texts(alice.groups, groupId)).toEqual([
      'my own copy',
      'answer',
    ]);
    expect((await alice.groups.epoch(groupId))?.members.sort()).toEqual(
      [alice.userId, bob.userId].sort()
    );
  });

  it('shows the quote of a reply to a message of another group', async () => {
    const first = await alice.groups.createGroup('First', [bob.userId]);
    const second = await alice.groups.createGroup('Second', [bob.userId]);
    await deliver();
    for (const inv of await bob.groups.invitations()) {
      await bob.groups.acceptInvitation(inv.epochId);
    }
    await deliver();
    const target = await bob.groups.sendMessage(first, 'over there');
    await deliver();

    await alice.groups.sendMessage(second, 'about that', {
      replyTo: [{ epochId: first, syncObjId: target.syncObjId }],
    });
    await deliver();
    for (const p of [alice, bob]) {
      const reply = (await p.groups.timeline(second)).find(
        i => i.kind === 'message'
      );
      // Read from the other group's own timeline: nothing is asked for.
      expect(reply?.kind === 'message' && reply.replyTo).toMatchObject([
        {
          epochId: first,
          syncObjId: target.syncObjId,
          message: {
            epochId: first,
            body: { type: 'text', text: 'over there' },
          },
        },
      ]);
    }

    // Deleted for everyone, the target is no longer quoted.
    await bob.groups.deleteMessage(first, target.syncObjId);
    await deliver();
    const reply = (await alice.groups.timeline(second)).find(
      i => i.kind === 'message'
    );
    expect(reply?.kind === 'message' && reply.replyTo[0].message).toBeNull();
  });

  it('keeps the metadata an edit does not name, a reply target included', async () => {
    const groupId = await alice.groups.createGroup('Edits', [bob.userId]);
    await deliver();
    await bob.groups.acceptInvitation(
      (await bob.groups.invitations())[0].epochId
    );
    const first = await alice.groups.sendMessage(groupId, 'question');
    await deliver();
    const answer = await bob.groups.sendMessage(groupId, 'answer', {
      replyTo: [{ epochId: groupId, syncObjId: first.syncObjId }],
      metadata: { 'x.note': new Uint8Array([1, 2]) },
    });
    await deliver();
    const bobs = async (p: GossipSdk) =>
      (await p.groups.timeline(groupId)).find(
        i => i.kind === 'message' && i.syncObjId === answer.syncObjId
      );

    // No metadata given: everything stays.
    await bob.groups.editMessage(groupId, answer.syncObjId, 'answer, edited');
    await deliver();
    for (const p of [alice, bob]) {
      const m = await bobs(p);
      expect(m?.kind === 'message' && m.body).toEqual({
        type: 'text',
        text: 'answer, edited',
      });
      expect(m?.kind === 'message' && m.replyTo).toMatchObject([
        { epochId: groupId, syncObjId: first.syncObjId },
      ]);
      expect(m?.kind === 'message' && m.metadata['x.note']).toEqual(
        new Uint8Array([1, 2])
      );
    }

    // One entry set and one removed; the others stay.
    clock += 1_000;
    await bob.groups.editMessage(groupId, answer.syncObjId, 'answer, again', {
      metadata: { 'x.other': new Uint8Array([3]) },
      removeMetadata: ['x.note'],
    });
    await deliver();
    const m = await bobs(alice);
    expect(m?.kind === 'message' && Object.keys(m.metadata).sort()).toEqual([
      'replyTo',
      'x.other',
    ]);
  });

  /** A group of Alice and Bob, accepted, with one message delivered. */
  async function twoMemberGroup(): Promise<string> {
    const groupId = await alice.groups.createGroup('Pair', [bob.userId]);
    await deliver();
    await bob.groups.acceptInvitation(
      (await bob.groups.invitations())[0].epochId
    );
    await alice.groups.sendMessage(groupId, 'first');
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['first']);
    return groupId;
  }

  it('ignores arbitrary bytes as a group plaintext', async () => {
    const groupId = await twoMemberGroup();
    const before = await bob.groups.list();
    let seed = 7;
    for (let i = 0; i < 50; i++) {
      const bytes = new Uint8Array(1 + ((i * 37) % 300)).map(() => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed & 0xff;
      });
      await bob.groups.handlePlaintext(alice.userIdBytes, bytes);
    }
    // Also through the message path, as a keep-alive from Alice.
    await alice.messages.send({
      ownerUserId: alice.userId,
      contactUserId: bob.userId,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: 1 as never,
      status: 0 as never,
      timestamp: new Date(),
    } as never);
    await deliver();
    expect(await bob.groups.list()).toEqual(before);
    expect(await texts(bob.groups, groupId)).toEqual(['first']);
  });

  it('reopens from the database after a failed write, without the lost operation', async () => {
    const groupId = await twoMemberGroup();
    const groups = queriesOf(alice).groups;
    const apply = groups.applyBatches.bind(groups);
    const spy = vi
      .spyOn(groups, 'applyBatches')
      .mockImplementationOnce(async () => {
        throw new Error('disk full');
      });
    await expect(alice.groups.sendMessage(groupId, 'lost')).rejects.toThrow(
      'disk full'
    );
    spy.mockImplementation(apply);
    await alice.groups.settle();
    // The engine was reopened from what is durable: the message is not there.
    expect(await texts(alice.groups, groupId)).toEqual(['first']);
    await alice.groups.sendMessage(groupId, 'kept');
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['first', 'kept']);
  });

  it('retries a failed send from the outbox, as stored', async () => {
    const groupId = await twoMemberGroup();
    const proto = internals(alice).messageProtocol;
    const send = proto.sendMessage.bind(proto);
    const spy = vi.spyOn(proto, 'sendMessage').mockImplementation(async () => {
      throw new Error('offline');
    });
    await alice.groups.sendMessage(groupId, 'later');
    await alice.groups.settle();
    const stored = await queriesOf(alice).groups.dueOutbox(
      alice.userId,
      new Date(8.64e15)
    );
    expect(stored.length).toBeGreaterThan(0);
    const ciphertexts = stored.map(r => Array.from(r.ciphertext).join(','));
    const sent: string[] = [];
    spy.mockImplementation(async (m: unknown) => {
      const c = (m as { ciphertext: Uint8Array }).ciphertext;
      sent.push(Array.from(c).join(','));
      return send(m as never);
    });
    clock += 60_000;
    await deliver();
    for (const c of ciphertexts) expect(sent).toContain(c);
    expect(await texts(bob.groups, groupId)).toEqual(['first', 'later']);
    expect(
      await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
    ).toEqual([]);
  });

  it('keeps a ciphertext until its session state is durable, then sends it', async () => {
    const groupId = await twoMemberGroup();
    const i = internals(alice);
    const persist = i.persistSession;
    i.persistSession = async () => {
      throw new Error('the session state cannot be written');
    };
    await alice.groups.sendMessage(groupId, 'after crash');
    await alice.groups.settle();
    // Nothing is stored or sent while the session state is not durable.
    expect(
      await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
    ).toEqual([]);
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['first']);
    i.persistSession = persist;
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['first', 'after crash']);
    // The one-to-one session still works both ways afterwards.
    await alice.groups.sendMessage(groupId, 'and more');
    await bob.groups.sendMessage(groupId, 'reply');
    await deliver();
    expect((await texts(alice.groups, groupId)).sort()).toEqual(
      ['after crash', 'and more', 'first', 'reply'].sort()
    );
  });

  it('survives a failed outbox write after encryption', async () => {
    const groupId = await twoMemberGroup();
    const groups = queriesOf(alice).groups;
    const insert = groups.insertOutbox.bind(groups);
    const spy = vi
      .spyOn(groups, 'insertOutbox')
      .mockImplementationOnce(async () => {
        throw new Error('crash while storing the ciphertext');
      });
    await alice.groups.sendMessage(groupId, 'stored or not');
    await alice.groups.settle();
    spy.mockImplementation(insert);
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual([
      'first',
      'stored or not',
    ]);
    await bob.groups.sendMessage(groupId, 'still talking');
    await deliver();
    expect(await texts(alice.groups, groupId)).toEqual([
      'first',
      'stored or not',
      'still talking',
    ]);
  });

  it('assembles nothing again and again for a member without an active session', async () => {
    const groupId = await twoMemberGroup();
    const i = internals(alice);
    const status = i.session.peerSessionStatus.bind(i.session);
    const bobBytes = bob.userIdBytes;
    vi.spyOn(i.session, 'peerSessionStatus').mockImplementation(p =>
      p.every((b, k) => b === bobBytes[k]) ? 2 : status(p)
    );
    const node = i.node!;
    const poll = vi.spyOn(
      Object.getPrototypeOf(node) as { poll_outbox: (n: number) => unknown[] },
      'poll_outbox'
    );
    await alice.groups.sendMessage(groupId, 'nobody hears');
    await alice.groups.settle();
    expect(poll.mock.calls.length).toBeLessThanOrEqual(2);
    poll.mockClear();
    clock += 1_000;
    await alice.groups.tick();
    await alice.groups.settle();
    // Told that Bob has no session, the engine holds back his work.
    const lengths = poll.mock.results.map(r => (r.value as unknown[]).length);
    expect(lengths.every(n => n === 0)).toBe(true);
    poll.mockRestore();
  });

  it('logs out within a few seconds while a send hangs', async () => {
    const groupId = await twoMemberGroup();
    vi.spyOn(
      internals(alice).messageProtocol,
      'sendMessage'
    ).mockImplementation(() => new Promise(() => {}));
    await alice.groups.sendMessage(groupId, 'stuck');
    const started = Date.now();
    await alice.closeSession();
    expect(Date.now() - started).toBeLessThan(8_000);
    peers = [bob, carol];
  });

  it('keeps the groups of two accounts in one database apart', async () => {
    const groupId = await alice.groups.createGroup('Mine', [bob.userId]);
    await alice.groups.settle();
    await alice.closeSession();
    // Another account opened by the same SDK, on the same database.
    await alice.openSession({
      mnemonic: generateMnemonic(),
      encryptionKey: await generateEncryptionKey(),
      onPersist: async () => {},
      autoStartPolling: false,
      publishPublicKey: false,
    });
    expect(await alice.groups.list()).toEqual([]);
    const own = await alice.groups.createGroup('Theirs', [bob.userId]);
    expect(own).not.toBe(groupId);
    expect((await alice.groups.list()).map(g => g.groupId)).toEqual([own]);
  });

  it('retries the outbox on its timer', async () => {
    const groupId = await twoMemberGroup();
    const proto = internals(alice).messageProtocol;
    const send = proto.sendMessage.bind(proto);
    const spy = vi.spyOn(proto, 'sendMessage').mockImplementation(async () => {
      throw new Error('offline');
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await alice.groups.sendMessage(groupId, 'on time');
      await alice.groups.settle();
      expect(
        await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
      ).not.toEqual([]);
      spy.mockImplementation(send);
      clock += 10_000;
      // No tick and no call: the timer armed for the outbox retry sends it.
      await vi.advanceTimersByTimeAsync(10_000);
      await (alice.groups as unknown as { chain: Promise<unknown> }).chain;
      expect(
        await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    await bob.messages.fetch();
    await bob.groups.settle();
    expect(await texts(bob.groups, groupId)).toEqual(['first', 'on time']);
  });
  it('drops a ciphertext the server refuses for good, and sends no more of it', async () => {
    const groupId = await twoMemberGroup();
    const proto = internals(alice).messageProtocol;
    const send = proto.sendMessage.bind(proto);
    const refused = new Set<string>();
    const spy = vi
      .spyOn(proto, 'sendMessage')
      .mockImplementation(async (m: unknown) => {
        const key = bytesToHex((m as { seeker: Uint8Array }).seeker);
        refused.add(key);
        throw new Error('HTTP 409: Conflict');
      });
    await alice.groups.sendMessage(groupId, 'refused');
    await alice.groups.settle();
    expect(refused.size).toBeGreaterThan(0);
    expect(
      await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
    ).toEqual([]);
    const again: string[] = [];
    spy.mockImplementation(async (m: unknown) => {
      again.push(bytesToHex((m as { seeker: Uint8Array }).seeker));
      return send(m as never);
    });
    clock += 600_000;
    await deliver();
    expect(again.filter(k => refused.has(k))).toEqual([]);
  });

  it('backs off the outbox retries of a ciphertext, within a bound', async () => {
    const groupId = await twoMemberGroup();
    const proto = internals(alice).messageProtocol;
    vi.spyOn(proto, 'sendMessage').mockImplementation(async () => {
      throw new Error('offline');
    });
    await alice.groups.sendMessage(groupId, 'later');
    await alice.groups.settle();
    const due = async () =>
      (
        await queriesOf(alice).groups.dueOutbox(alice.userId, new Date(8.64e15))
      )[0].whenToSend.getTime();
    const gaps: number[] = [];
    for (let i = 0; i < 12; i++) {
      clock = (await due()) + 1;
      const before = clock;
      await alice.groups.tick();
      await alice.groups.settle();
      gaps.push((await due()) - before);
    }
    // Each wait at least as long as the one before, longer than the first,
    // and never above an hour.
    for (let i = 1; i < gaps.length; i++) {
      expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1]);
    }
    expect(gaps[gaps.length - 1]).toBeGreaterThan(gaps[0]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(60 * 60 * 1000);
  });
  it('posts one ciphertext per seeker while group and one-to-one sends interleave', async () => {
    const groupId = await twoMemberGroup();
    const proto = internals(alice).messageProtocol;
    const send = proto.sendMessage.bind(proto);
    const posted = new Map<string, Set<string>>();
    vi.spyOn(proto, 'sendMessage').mockImplementation(async (m: unknown) => {
      const { seeker, ciphertext } = m as {
        seeker: Uint8Array;
        ciphertext: Uint8Array;
      };
      const key = bytesToHex(seeker);
      const values = posted.get(key) ?? new Set<string>();
      values.add(bytesToHex(ciphertext));
      posted.set(key, values);
      return send(m as never);
    });
    const oneToOne = (i: number) =>
      alice.messages.send({
        ownerUserId: alice.userId,
        contactUserId: bob.userId,
        content: `direct ${i}`,
        type: MessageType.TEXT,
        direction: 1 as never,
        status: 0 as never,
        timestamp: new Date(),
      } as never);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => [
        alice.groups.sendMessage(groupId, `group ${i}`),
        oneToOne(i),
      ]).flat()
    );
    await alice.groups.settle();
    await deliver();
    expect(posted.size).toBeGreaterThan(0);
    for (const values of posted.values()) expect(values.size).toBe(1);
    // One clock for all: the sends share a time and are ordered by hash.
    expect((await texts(bob.groups, groupId)).sort()).toEqual(
      ['first', ...Array.from({ length: 8 }, (_, i) => `group ${i}`)].sort()
    );
  });
});
