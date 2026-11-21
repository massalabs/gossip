/**
 * Direct chats, contacts, connections and migration (§5.12) between
 * in-process SDKs over an in-memory transport. No backend is used.
 *
 * - an account upgraded with earlier one-to-one conversations keeps them as
 *   archives, declared to the engine;
 * - "Migrate" on one side and accepting on the other give one conversation,
 *   linked to the archive on both sides; crossing migrations settle on one;
 * - a new contact gets one direct chat without a second prompt, crossing
 *   requests included;
 * - a member of a group who is not a contact is connected automatically,
 *   without a prompt or a conversation, and revoked once no group needs it;
 * - a contact who announces itself anew, such as an account restored from
 *   its recovery phrase, is answered without a prompt, once in ten minutes;
 *   a first request still waits for the user.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import {
  encryptionKeyFromBytes,
  generateEncryptionKey,
} from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { SdkEventType } from '../../src/core/SdkEventEmitter';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../../src/db';
import type { GroupService } from '../../src/services/groups';
import { MigrationUnavailableError } from '../../src/services/conversations';
import { SessionStatus } from '../../src/wasm/bindings';
import { bytesToHex } from '@noble/hashes/utils';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

/** The recovery phrase of each peer, to restore it on an empty device. */
const mnemonics = new WeakMap<GossipSdk, string>();
/** The storage key of each peer, to open it again. */
const keysOf = new WeakMap<GossipSdk, Uint8Array>();

/** The test clock, for what an SDK times by itself. */
function setClock(sdk: GossipSdk) {
  (sdk.groups as unknown as { now: () => number }).now = () => clock;
  (
    sdk as unknown as { _announcement: { now: () => number } }
  )._announcement.now = () => clock;
}

async function openPeer(
  net: MockMessageProtocol,
  mnemonic = generateMnemonic()
): Promise<GossipSdk> {
  const sdk = new GossipSdk();
  await sdk.init({ storage: getTestStorageConfig(), messageProtocol: net });
  const encryptionKey = await generateEncryptionKey();
  await sdk.openSession({
    mnemonic,
    encryptionKey,
    onPersist: async () => {},
    autoStartPolling: false,
    publishPublicKey: false,
  });
  setClock(sdk);
  await sdk.conversations.settle();
  mnemonics.set(sdk, mnemonic);
  keysOf.set(sdk, encryptionKey.to_bytes());
  return sdk;
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

/** The engine's own answer, for what the service does not expose. */
function engine(sdk: GossipSdk): { earlier_conversations: () => string } {
  return (sdk.groups as unknown as { node: never }).node;
}

describe('Direct chats, contacts and connections', { timeout: 300_000 }, () => {
  let net: MockMessageProtocol;
  let peers: GossipSdk[] = [];

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  afterEach(async () => {
    for (const p of peers) await p.closeSession();
    peers = [];
  });

  async function open(n: number): Promise<GossipSdk[]> {
    net = new MockMessageProtocol();
    for (let i = 0; i < n; i++) peers.push(await openPeer(net));
    return peers;
  }

  /** Delivers everything: announcements, session messages, group traffic. */
  async function deliver(rounds = 6, step = 1_000) {
    for (let r = 0; r < rounds; r++) {
      clock += step;
      for (const p of peers) {
        // What polling does: session statuses reach the group engine.
        await (
          p as unknown as {
            _refresh: { refreshSessionsStatusEvent: () => Promise<void> };
          }
        )._refresh.refreshSessionsStatusEvent();
        await p.announcements.fetch();
        // Connections whose keys arrived since (a timer does it in use).
        await p.conversations.catchUp();
        await p.groups.tick();
        await p.groups.settle();
        await p.messages.fetch();
        await p.groups.settle();
        await p.conversations.settle();
      }
    }
  }

  /** The conversations each peer holds, by key: replaced chats of two aside. */
  async function keys(p: GossipSdk): Promise<string[]> {
    return (await p.groups.list())
      .filter(g => g.status !== 'superseded')
      .map(g => g.groupId);
  }

  it('keeps the conversations of an upgraded account as archives, declared to the engine', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await alice.queries.messages.insert({
      ownerUserId: alice.userId,
      contactUserId: bob.userId,
      content: 'from before the upgrade',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.READ,
      messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(1),
      timestamp: new Date(clock - 60_000),
    });

    await alice.conversations.catchUp();

    const d = await alice.discussions.get(bob.userId);
    expect(d).toMatchObject({
      isArchive: true,
      archived: false,
      linkedGroupId: null,
    });
    expect(
      (await alice.messages.getVisibleMessages(bob.userId)).map(m => m.content)
    ).toContain('from before the upgrade');
    expect(JSON.parse(engine(alice).earlier_conversations())).toEqual([
      [bytesToHex(bob.userIdBytes), '0'],
    ]);
    // Declared once: a second catch-up changes nothing.
    await alice.conversations.catchUp();
    expect(JSON.parse(engine(alice).earlier_conversations())).toHaveLength(1);

    // The archive moves to the archived list and back.
    await alice.conversations.setArchived(bob.userId, true);
    expect((await alice.discussions.get(bob.userId))?.archived).toBe(true);
    await alice.conversations.setArchived(bob.userId, false);
    expect((await alice.discussions.get(bob.userId))?.archived).toBe(false);
  });

  it('migrates on one side and accepts on the other: one conversation linked on both', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    for (const p of [alice, bob]) await p.conversations.catchUp();

    const groupId = await alice.conversations.migrate(bob.userId);
    expect((await alice.discussions.get(bob.userId))?.linkedGroupId).toBe(
      groupId
    );
    await deliver();

    // Bob sees it inside the archive with Alice, and cannot migrate himself.
    const inv = await bob.conversations.migrationInvitation(alice.userId);
    expect(inv).toMatchObject({
      epochId: groupId,
      owner: alice.userId,
      migrationOf: alice.userId,
      migrateFrom: 0,
    });
    await expect(bob.conversations.migrate(alice.userId)).rejects.toEqual(
      new MigrationUnavailableError('invitation-pending')
    );
    expect(await bob.conversations.acceptInvitation(inv!.epochId)).toBe(
      groupId
    );
    expect((await bob.discussions.get(alice.userId))?.linkedGroupId).toBe(
      groupId
    );

    await alice.groups.sendMessage(groupId, 'continued');
    await deliver();
    for (const p of [alice, bob]) {
      expect(await keys(p)).toEqual([groupId]);
      expect(await texts(p.groups, groupId)).toEqual(['continued']);
      expect(
        await p.conversations.directChatWith(
          p === alice ? bob.userId : alice.userId
        )
      ).toBe(groupId);
    }
    // Starting a chat with the contact opens the same one.
    expect(await bob.conversations.startDirectChat(alice.userId)).toBe(groupId);
    expect(await keys(bob)).toEqual([groupId]);
  });

  it('settles crossing migrations on one group, the other kept as its history', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    for (const p of [alice, bob]) await p.conversations.catchUp();
    const superseded: { by: string; hasMessages: boolean }[] = [];
    for (const p of [alice, bob]) {
      p.on(SdkEventType.DIRECT_CHAT_SUPERSEDED, e => superseded.push(e));
    }

    const a = await alice.conversations.migrate(bob.userId);
    const b = await bob.conversations.migrate(alice.userId);
    expect(a).not.toBe(b);
    // A message written in what will be the losing group.
    const aliceFirst =
      bytesToHex(alice.userIdBytes) < bytesToHex(bob.userIdBytes);
    const [kept, lost] = aliceFirst ? [a, b] : [b, a];
    const loser = aliceFirst ? bob : alice;
    await loser.groups.sendMessage(lost, 'lost');
    await deliver();

    for (const p of [alice, bob]) {
      expect(await keys(p)).toEqual([kept]);
      const other = p === alice ? bob : alice;
      expect((await p.discussions.get(other.userId))?.linkedGroupId).toBe(kept);
      expect(await p.groups.invitations()).toEqual([]);
      // Nothing is erased: the replaced chat is read-only history of the
      // kept one, with what was written in it.
      const old = await p.groups.get(lost);
      expect(old).toMatchObject({ status: 'superseded', supersededBy: kept });
      expect((await p.groups.get(kept))?.earlier).toEqual([lost]);
      expect(await texts(p.groups, lost)).toEqual(['lost']);
    }
    expect(superseded.length).toBeGreaterThan(0);
    for (const e of superseded) expect(e.by).toBe(kept);
    expect(superseded.some(e => e.hasMessages)).toBe(true);
  });

  it('asks to continue in the chat of a person who declined with a signed leave and migrated', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    for (const p of [alice, bob]) await p.conversations.catchUp();

    const a = await alice.conversations.migrate(bob.userId);
    await alice.groups.sendMessage(a, 'before the decline');
    await deliver();
    const inv = await bob.conversations.migrationInvitation(alice.userId);
    await bob.conversations.declineInvitation(inv!.epochId, 'Signed');
    // The owner's device founds the successor without him a while later.
    await deliver(12, 5 * 60_000);
    expect((await alice.groups.get(a))?.members).toEqual([alice.userId]);

    const b = await bob.conversations.migrate(alice.userId);
    expect(b).not.toBe(a);
    await deliver();
    const asked = (await alice.groups.invitations()).find(i => i.epochId === b);
    expect(asked).toMatchObject({ owner: bob.userId, continues: a });
    expect(await keys(alice)).toEqual([a]);

    expect(await alice.conversations.acceptInvitation(b)).toBe(b);
    await deliver();
    expect(await keys(alice)).toEqual([b]);
    expect((await alice.groups.get(b))?.earlier).toEqual([a]);
    expect(await texts(alice.groups, a)).toEqual(['before the decline']);
    for (const p of [alice, bob]) {
      const other = p === alice ? bob : alice;
      expect((await p.discussions.get(other.userId))?.linkedGroupId).toBe(b);
      expect(await p.conversations.directChatWith(other.userId)).toBe(b);
    }
    await alice.groups.sendMessage(b, 'continued');
    await deliver();
    expect(await texts(bob.groups, b)).toEqual(['continued']);
  });

  it('starts the group engine empty when its stored records no longer decode, archives untouched', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await alice.queries.messages.insert({
      ownerUserId: alice.userId,
      contactUserId: bob.userId,
      content: 'from before the upgrade',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.READ,
      messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(2),
      timestamp: new Date(clock - 60_000),
    });
    await alice.conversations.catchUp();
    const a = await alice.conversations.migrate(bob.userId);
    await alice.groups.settle();
    const snapshot = await alice.queries.groups.loadSnapshot(alice.userId);
    const record = snapshot.node.find(n => n.kind === 'group_recs');
    expect(record).toBeDefined();
    // A record as an earlier build wrote it.
    await alice.queries.groups.applyBatches(alice.userId, [
      {
        rows: [],
        removedRows: [],
        edges: [],
        removedEdges: [],
        objects: [],
        removedObjects: [],
        node: [{ ...record!, fields: '{"status":"Active"}' }],
        erase: [],
      },
    ]);

    await (alice.groups as unknown as { reopen: () => Promise<void> }).reopen();

    expect(await alice.groups.list()).toEqual([]);
    expect(await alice.groups.get(a)).toBeNull();
    const d = await alice.discussions.get(bob.userId);
    expect(d?.isArchive).toBe(true);
    const archived = await alice.queries.messages.getByOwnerAndContact(
      alice.userId,
      bob.userId
    );
    expect(archived.map(m => m.content)).toContain('from before the upgrade');
    // The archive can be migrated again.
    await alice.conversations.catchUp();
    const again = await alice.conversations.migrate(bob.userId);
    expect(await keys(alice)).toEqual([again]);
  });

  it('declares the accepted contacts to the engine, never an automatic connection', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    for (const p of [alice, bob]) await p.conversations.catchUp();
    const declared = (p: GossipSdk) =>
      JSON.parse(
        (
          engine(p) as unknown as { accepted_contacts: () => string }
        ).accepted_contacts()
      ) as string[];
    expect(declared(alice)).toEqual([bytesToHex(bob.userIdBytes)]);
    expect(declared(bob)).toEqual([bytesToHex(alice.userIdBytes)]);

    await alice.contacts.delete(bob.userId);
    await alice.conversations.settle();
    expect(declared(alice)).toEqual([]);
  });

  it('gives a new contact one direct chat without a second prompt', async () => {
    const [alice, bob] = await open(2);
    const requested: unknown[] = [];
    bob.on(SdkEventType.SESSION_REQUESTED, e => requested.push(e));
    await setupSession(alice, bob, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    expect(requested).toHaveLength(1);
    await deliver();

    const [groupId] = await keys(alice);
    expect(groupId).toBeDefined();
    for (const p of [alice, bob]) {
      expect(await keys(p)).toEqual([groupId]);
      expect(await p.groups.invitations()).toEqual([]);
      const other = p === alice ? bob : alice;
      const d = await p.discussions.get(other.userId);
      expect(d).toMatchObject({
        isArchive: false,
        linkedGroupId: groupId,
        directChatOwed: false,
      });
    }
    expect((await alice.groups.epoch(groupId))?.migrateFrom).toBe(0);
    expect((await bob.groups.get(groupId))?.status).toBe('member');
    expect(requested).toHaveLength(1);

    await bob.groups.sendMessage(groupId, 'hi');
    await deliver();
    expect(await texts(alice.groups, groupId)).toEqual(['hi']);
  });

  const FIVE_MINUTES = 5 * 60_000;
  const ONE_HOUR = 60 * 60_000;

  /**
   * Alice sends Bob a contact request announcing `announced` (none when
   * undefined) and founds the chat with `founded` (a modified client, when
   * they differ); Bob sees the announced timer and accepts.
   */
  async function requestWithTimer(
    alice: GossipSdk,
    bob: GossipSdk,
    announced: number | undefined,
    founded: number | undefined = announced
  ): Promise<void> {
    await alice.contacts.add(bob.userId, 'Bob', bob.publicKeys);
    const contact = (await alice.contacts.get(bob.userId))!;
    const started = await alice.discussions.start(
      contact,
      { username: 'Alice', message: 'hello' },
      announced === undefined ? {} : { messageTimer: announced }
    );
    expect(started.success).toBe(true);
    if (founded !== announced) {
      const row = await alice.queries.discussions.getByOwnerAndContact(
        alice.userId,
        bob.userId
      );
      await alice.queries.discussions.updateById(row!.id!, {
        directChatTimer: founded ?? null,
      });
    }
    await bob.announcements.fetch();
    const d = (await bob.discussions.get(alice.userId))!;
    expect(d.directChatTimer).toBe(announced ?? null);
    expect((await bob.discussions.accept(d)).success).toBe(true);
  }

  it('adopts without a prompt a chat with the timer the request announced, forever included', async () => {
    for (const timer of [ONE_HOUR, 0]) {
      const [alice, bob] = await open(2);
      await requestWithTimer(alice, bob, timer);
      await deliver();
      const groupId = await alice.conversations.directChatWith(bob.userId);
      expect(groupId).not.toBeNull();
      expect(await keys(bob)).toEqual([groupId]);
      expect(await bob.groups.invitations()).toEqual([]);
      expect((await bob.groups.get(groupId!))!.messageTimer).toBe(timer);
      expect((await bob.discussions.get(alice.userId))?.linkedGroupId).toBe(
        groupId
      );
      for (const p of peers) await p.closeSession();
      peers = [];
    }
  });

  it('adopts as before the chat of a request that announced no timer', async () => {
    const [alice, bob] = await open(2);
    await requestWithTimer(alice, bob, undefined);
    await deliver();
    const groupId = await alice.conversations.directChatWith(bob.userId);
    expect(await keys(bob)).toEqual([groupId]);
    expect(await bob.groups.invitations()).toEqual([]);
  });

  it('asks for a chat founded with another timer than the request announced, saying both, and accepting links it', async () => {
    const [alice, bob] = await open(2);
    await requestWithTimer(alice, bob, ONE_HOUR, FIVE_MINUTES);
    await deliver();
    const groupId = await alice.conversations.directChatWith(bob.userId);
    expect(groupId).not.toBeNull();
    expect(await keys(bob)).toEqual([]);
    const [inv] = await bob.groups.invitations();
    expect(inv).toMatchObject({
      epochId: groupId,
      owner: alice.userId,
      messageTimer: FIVE_MINUTES,
      announcedTimer: ONE_HOUR,
      migrationOf: null,
      continues: null,
    });
    // Alice's chat has not seen Bob take part.
    expect((await alice.groups.get(groupId!))!.tookPart).toBe(false);

    expect(await bob.conversations.acceptInvitation(inv.epochId)).toBe(groupId);
    await deliver();
    expect(await keys(bob)).toEqual([groupId]);
    expect(await bob.groups.invitations()).toEqual([]);
    expect((await bob.groups.get(groupId!))!.messageTimer).toBe(FIVE_MINUTES);
    expect((await bob.discussions.get(alice.userId))?.linkedGroupId).toBe(
      groupId
    );
    await alice.groups.sendMessage(groupId!, 'hi');
    await deliver();
    expect(await texts(bob.groups, groupId!)).toEqual(['hi']);
  });

  it('asks for a chat founded without a timer when the request announced one, and declining it silently leaves Alice unaware', async () => {
    const [alice, bob] = await open(2);
    await requestWithTimer(alice, bob, ONE_HOUR, 0);
    await deliver();
    const groupId = await alice.conversations.directChatWith(bob.userId);
    const [inv] = await bob.groups.invitations();
    expect(inv).toMatchObject({ messageTimer: 0, announcedTimer: ONE_HOUR });

    await bob.conversations.declineInvitation(inv.epochId, 'Silent');
    await deliver();
    expect(await bob.groups.invitations()).toEqual([]);
    expect(await keys(bob)).toEqual([]);
    expect(
      (await bob.discussions.get(alice.userId))?.linkedGroupId ?? null
    ).toBeNull();
    // Nothing reached Alice: Bob is still listed and never took part.
    const g = (await alice.groups.get(groupId!))!;
    expect(g.members).toContain(bob.userId);
    expect(g.tookPart).toBe(false);
  });

  it('keeps the announced timer across a reload between accepting the request and the chat', async () => {
    const [alice, bob] = await open(2);
    await requestWithTimer(alice, bob, ONE_HOUR, FIVE_MINUTES);
    await reload(bob);
    await deliver();
    const [inv] = await bob.groups.invitations();
    expect(inv).toMatchObject({
      messageTimer: FIVE_MINUTES,
      announcedTimer: ONE_HOUR,
    });
    await reload(bob);
    expect((await bob.groups.invitations())[0]?.announcedTimer).toBe(ONE_HOUR);
  });

  it('gives crossing contact requests one direct chat', async () => {
    const [alice, bob] = await open(2);
    await alice.contacts.add(bob.userId, 'Bob', bob.publicKeys);
    await bob.contacts.add(alice.userId, 'Alice', alice.publicKeys);
    const aliceContact = (await alice.contacts.get(bob.userId))!;
    const bobContact = (await bob.contacts.get(alice.userId))!;
    expect((await alice.discussions.start(aliceContact)).success).toBe(true);
    expect((await bob.discussions.start(bobContact)).success).toBe(true);
    await deliver(10);

    for (const p of [alice, bob]) {
      const other = p === alice ? bob : alice;
      expect(p.discussions.getStatus(other.userId)).toBe(SessionStatus.Active);
    }
    const [groupId] = await keys(alice);
    expect(groupId).toBeDefined();
    for (const p of [alice, bob]) {
      expect(await keys(p)).toEqual([groupId]);
      const other = p === alice ? bob : alice;
      expect((await p.discussions.get(other.userId))?.linkedGroupId).toBe(
        groupId
      );
    }
  });

  it('connects a member who is no contact automatically, and revokes the connection once no group needs it', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');
    const prompts: unknown[] = [];
    for (const p of [bob, carol]) {
      p.on(SdkEventType.SESSION_REQUESTED, e => prompts.push(e));
    }

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.conversations.acceptInvitation(inv.epochId);
    }
    // The members' keys come by key queries (§12.9), with their timers.
    await deliver(20, 10_000);

    // Bob and Carol, who are no contacts of each other, are connected.
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    for (const [p, other] of [
      [bob, carol],
      [carol, bob],
    ] as const) {
      const c = await p.queries.contacts.getByOwnerAndUser(
        p.userId,
        other.userId
      );
      expect(c?.connection).toBe('automatic');
      const d = await p.discussions.get(other.userId);
      expect(d).toMatchObject({ isArchive: false, directChatOwed: false });
      expect(await p.messages.getVisibleMessages(other.userId)).toEqual([]);
    }
    expect(prompts).toEqual([]);
    // No conversation was created for them.
    expect(await keys(bob)).toEqual([groupId]);
    expect(await keys(carol)).toEqual([groupId]);

    // Messages flow between them.
    await bob.groups.sendMessage(groupId, 'from bob');
    await deliver();
    expect(await texts(carol.groups, groupId)).toEqual(['from bob']);

    // Carol is removed: Bob still holds epochs listing her, so her
    // connection stays (§5.12)...
    await alice.groups.changeMembers(groupId, { remove: [carol.userId] });
    await deliver();
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, carol.userId)
    ).toBeDefined();
    // ...until Bob holds nothing that lists her: he leaves and deletes it.
    await bob.groups.leave(groupId, 'Signed');
    await deliver();
    if ((await bob.groups.get(groupId)) !== null) {
      await bob.groups.deleteGroup(groupId);
    }
    await bob.groups.tick();
    await bob.groups.settle();
    await bob.conversations.settle();
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, carol.userId)
    ).toBeUndefined();
    expect(await bob.discussions.get(carol.userId)).toBeUndefined();
    // A contact the user accepted is never revoked.
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, alice.userId)
    ).toBeDefined();
  });

  it('keeps automatic a connection a member asked for before this device accepted the group', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    const [bobInv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(bobInv.epochId);
    // Bob connects to Carol while she has only been invited: his request
    // reaches her as a request from someone who is no contact.
    await deliver(20, 10_000);
    const [carolInv] = await carol.groups.invitations();
    await carol.conversations.acceptInvitation(carolInv.epochId);
    await deliver(20, 10_000);

    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    const c = await carol.queries.contacts.getByOwnerAndUser(
      carol.userId,
      bob.userId
    );
    // Accepting the group connected Bob as a member, not as a contact.
    expect(c).toMatchObject({ connection: 'automatic', name: '' });
    expect(await carol.messages.getVisibleMessages(bob.userId)).toEqual([]);
    expect(await keys(carol)).toEqual([groupId]);
  });

  it('connects again a member who left, deleted the group and was added back', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.conversations.acceptInvitation(inv.epochId);
    }
    await deliver(20, 10_000);
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);

    // Bob leaves and deletes the group: he revokes his connection to Carol,
    // who still holds epochs listing him and keeps hers.
    await bob.groups.leave(groupId, 'Signed');
    await deliver(10, 10_000);
    if ((await bob.groups.get(groupId)) !== null) {
      await bob.groups.deleteGroup(groupId);
    }
    await deliver();
    expect((await alice.groups.get(groupId))?.members).not.toContain(
      bob.userId
    );
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, carol.userId)
    ).toBeUndefined();

    // Alice adds him back: Bob and Carol must be connected again.
    await alice.groups.changeMembers(groupId, { add: [bob.userId] });
    await deliver(10, 10_000);
    const [inv] = await bob.groups.invitations();
    expect(inv).toBeDefined();
    const rejoined = await bob.conversations.acceptInvitation(inv.epochId);
    await deliver(20, 10_000);

    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);

    // The session is the same on both sides: with Alice away, a message of
    // Bob's reaches Carol directly.
    await alice.closeSession();
    peers = [bob, carol];
    await bob.groups.sendMessage(rejoined, 'from bob, added back');
    await deliver(10, 10_000);
    expect(await texts(carol.groups, groupId)).toContain(
      'from bob, added back'
    );
  });

  it('drops the connections of a chat the device was kicked from, its history kept, and connects again once added back', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.conversations.acceptInvitation(inv.epochId);
    }
    await deliver(20, 10_000);
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);

    // Carol is kicked and keeps the history read-only: the chat no longer
    // keeps her connection to Bob, as if she had deleted it (§5.12, D.86).
    await alice.groups.changeMembers(groupId, { remove: [carol.userId] });
    await deliver(10, 10_000);
    expect((await carol.groups.get(groupId))?.status).toBe('removed');
    expect(
      await carol.queries.contacts.getByOwnerAndUser(carol.userId, bob.userId)
    ).toBeUndefined();
    // A contact the user accepted stays.
    expect(
      await carol.queries.contacts.getByOwnerAndUser(carol.userId, alice.userId)
    ).toBeDefined();

    // Alice adds her back: the root comes over Alice's session; once Carol
    // accepts, she connects to Bob again, who takes her new announcement.
    await alice.groups.changeMembers(groupId, { add: [carol.userId] });
    await deliver(10, 10_000);
    const [inv] = await carol.groups.invitations();
    expect(inv).toBeDefined();
    const rejoined = await carol.conversations.acceptInvitation(inv.epochId);
    await deliver(20, 10_000);
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);

    await alice.closeSession();
    peers = [bob, carol];
    await carol.groups.sendMessage(rejoined, 'from carol, added back');
    await deliver(10, 10_000);
    expect(await texts(bob.groups, groupId)).toContain(
      'from carol, added back'
    );
  });

  it('keeps a connection while the signed leave for that peer waits in the outbox', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');

    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.conversations.acceptInvitation(inv.epochId);
    }
    await deliver(20, 10_000);
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);

    // Bob leaves visibly while his sends fail: the leave is encrypted for
    // Carol and waits in his outbox.
    const send = net.sendMessage.bind(net);
    net.sendMessage = async () => {
      throw new Error('offline');
    };
    await bob.groups.leave(groupId, 'Signed');
    await bob.groups.tick();
    await bob.groups.settle();
    await bob.conversations.settle();
    expect(await bob.groups.get(groupId)).toBeNull();
    expect(
      await bob.queries.groups.hasOutboxFor(bob.userId, carol.userId)
    ).toBe(true);
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, carol.userId)
    ).toBeDefined();

    // Sent: the connection goes, and Carol got the leave.
    net.sendMessage = send;
    await deliver(10, 600_000);
    await bob.conversations.catchUp();
    await bob.conversations.settle();
    expect(
      await bob.queries.groups.hasOutboxFor(bob.userId, carol.userId)
    ).toBe(false);
    expect(
      await bob.queries.contacts.getByOwnerAndUser(bob.userId, carol.userId)
    ).toBeUndefined();
    expect((await carol.groups.get(groupId))?.members).not.toContain(
      bob.userId
    );
  });

  /**
   * The account of `p` restored from its recovery phrase on an empty
   * device, `p` closed for good; the board read from now on, as the app
   * does for a restored account.
   */
  async function restore(p: GossipSdk): Promise<GossipSdk> {
    const userId = p.userId;
    await p.closeSession();
    const restored = await openPeer(net, mnemonics.get(p));
    await restored.announcements.skipHistorical();
    peers = peers.map(q => (q === p ? restored : q));
    expect(restored.userId).toBe(userId);
    return restored;
  }

  /** What the app does when the user adds a contact by user ID. */
  async function addContact(p: GossipSdk, other: GossipSdk, name: string) {
    await p.contacts.add(other.userId, name, other.publicKeys);
    const contact = (await p.contacts.get(other.userId))!;
    expect((await p.discussions.start(contact)).success).toBe(true);
  }

  /**
   * A message passes each way over the session: in a group Alice founds,
   * which needs no direct chat (which one the two keep after a restore is
   * not what these tests are about).
   */
  async function messagesFlow(alice: GossipSdk, bob: GossipSdk) {
    const groupId = await alice.groups.createGroup('After', [bob.userId]);
    await deliver();
    const inv = (await bob.groups.invitations()).find(
      i => i.epochId === groupId
    );
    expect(inv).toBeDefined();
    await bob.conversations.acceptInvitation(groupId);
    await deliver();
    await bob.groups.sendMessage(groupId, 'from bob');
    await alice.groups.sendMessage(groupId, 'from alice');
    await deliver();
    for (const p of [alice, bob]) {
      expect((await texts(p.groups, groupId)).sort()).toEqual([
        'from alice',
        'from bob',
      ]);
    }
  }

  /** The announcements posted to the board so far. */
  const posted = () => net.getStoredAnnouncements().length;

  /** Alice and Bob, contacts with a direct chat; Bob then restored empty. */
  async function restoredContact(): Promise<{
    alice: GossipSdk;
    bob: GossipSdk;
  }> {
    const [alice, bob0] = await open(2);
    await setupSession(alice, bob0, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    await deliver();
    expect(await keys(alice)).toHaveLength(1);
    return { alice, bob: await restore(bob0) };
  }

  it('answers a contact restored from its recovery phrase who adds this device again', async () => {
    const { alice, bob } = await restoredContact();
    const prompts: unknown[] = [];
    alice.on(SdkEventType.SESSION_REQUESTED, e => prompts.push(e));

    await addContact(bob, alice, 'Alice');
    await deliver(10);

    // Alice's device answered without her doing anything.
    expect(alice.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    expect(prompts).toEqual([]);
    await messagesFlow(alice, bob);
  });

  it('answers a contact who announces itself anew once, and never an answer to its own', async () => {
    const { alice, bob } = await restoredContact();
    const before = posted();
    await addContact(bob, alice, 'Alice');
    await deliver(10);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    // Bob's request and Alice's answer: Bob does not answer an answer.
    const settled = posted();
    expect(settled).toBe(before + 2);
    await deliver(10);
    expect(posted()).toBe(settled);

    // Bob's request and Alice's answer, replayed on the board: within ten
    // minutes of her answer, neither device answers again.
    const replayed = net.getStoredAnnouncements().slice(-2);
    for (const a of replayed) await net.sendAnnouncement(a.data);
    await deliver(10);
    expect(posted()).toBe(settled + replayed.length);
    for (const p of [alice, bob]) {
      const other = p === alice ? bob : alice;
      expect(p.discussions.getStatus(other.userId)).toBe(SessionStatus.Active);
    }
  });

  const TEN_MINUTES = 10 * 60_000;

  /** `p` closed and opened again on its own database, as after a reload. */
  async function reload(p: GossipSdk) {
    const encryptedSession = p.getEncryptedSession();
    await p.closeSession();
    await p.openSession({
      mnemonic: mnemonics.get(p)!,
      encryptedSession,
      encryptionKey: await encryptionKeyFromBytes(keysOf.get(p)!),
      onPersist: async () => {},
      autoStartPolling: false,
      publishPublicKey: false,
    });
    setClock(p);
    await p.conversations.settle();
  }

  /** Bob restored, adds Alice; she answers at once. */
  async function answeredOnce(): Promise<{ alice: GossipSdk; bob: GossipSdk }> {
    const { alice, bob } = await restoredContact();
    await addContact(bob, alice, 'Alice');
    await deliver(10);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    return { alice, bob };
  }

  /** Bob restored again a minute later, adds Alice: she owes him an answer. */
  async function renewedWithinTheWindow(
    alice: GossipSdk,
    bob0: GossipSdk
  ): Promise<{ bob: GossipSdk; waiting: number }> {
    clock += 60_000;
    const bob = await restore(bob0);
    await addContact(bob, alice, 'Alice');
    await deliver(10);
    // Within ten minutes of her answer: not answered yet.
    expect(bob.discussions.getStatus(alice.userId)).toBe(
      SessionStatus.SelfRequested
    );
    return { bob, waiting: posted() };
  }

  it('answers a renewal that comes within ten minutes of an earlier answer once they end, once', async () => {
    const { alice, bob: bob0 } = await answeredOnce();
    const { bob, waiting } = await renewedWithinTheWindow(alice, bob0);

    clock += TEN_MINUTES;
    await deliver(10);
    expect(posted()).toBe(waiting + 1);
    expect(alice.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    await messagesFlow(alice, bob);

    // Nothing more: Bob does not answer the answer, Alice owes nothing.
    const settled = posted();
    for (let i = 0; i < 3; i++) {
      clock += TEN_MINUTES;
      await deliver(4);
    }
    expect(posted()).toBe(settled);
  });

  it('keeps a renewal owed an answer across a reload, and answers it once the ten minutes end', async () => {
    const { alice, bob: bob0 } = await answeredOnce();
    const { bob, waiting } = await renewedWithinTheWindow(alice, bob0);

    await reload(alice);
    await deliver(4);
    // The reload does not end the ten minutes.
    expect(posted()).toBe(waiting);
    clock += TEN_MINUTES;
    await deliver(10);
    expect(posted()).toBe(waiting + 1);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    await messagesFlow(alice, bob);
  });

  it('owes no answer for a replayed announcement', async () => {
    const { alice, bob } = await answeredOnce();
    const settled = posted();
    for (const a of net.getStoredAnnouncements().slice(-2)) {
      await net.sendAnnouncement(a.data);
    }
    await deliver(4);
    clock += TEN_MINUTES;
    await deliver(6);
    expect(posted()).toBe(settled + 2);
    for (const p of [alice, bob]) {
      const other = p === alice ? bob : alice;
      expect(p.discussions.getStatus(other.userId)).toBe(SessionStatus.Active);
    }
  });

  it('answers a renewal of an active session once, and never the answer, even once the ten minutes end', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    await deliver();
    const before = posted();
    expect((await alice.discussions.renew(bob.userId)).success).toBe(true);
    await deliver(10);
    // Alice's renewal and Bob's answer.
    expect(posted()).toBe(before + 2);
    for (let i = 0; i < 3; i++) {
      clock += TEN_MINUTES;
      await deliver(4);
    }
    expect(posted()).toBe(before + 2);
    expect(alice.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    await messagesFlow(alice, bob);
  });

  it('settles two devices that renew at once without answering either, even once the ten minutes end', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    await deliver();
    const before = posted();
    expect((await alice.discussions.renew(bob.userId)).success).toBe(true);
    expect((await bob.discussions.renew(alice.userId)).success).toBe(true);
    await deliver(10);
    expect(posted()).toBe(before + 2);
    for (let i = 0; i < 3; i++) {
      clock += TEN_MINUTES;
      await deliver(4);
    }
    expect(posted()).toBe(before + 2);
    expect(alice.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    await messagesFlow(alice, bob);
  });

  it('still waits for the user before accepting a first contact request', async () => {
    const [alice, bob] = await open(2);
    const prompts: unknown[] = [];
    bob.on(SdkEventType.SESSION_REQUESTED, e => prompts.push(e));

    await addContact(alice, bob, 'Bob');
    const sent = posted();
    await deliver(10);

    expect(prompts).toHaveLength(1);
    expect(posted()).toBe(sent);
    expect(bob.discussions.getStatus(alice.userId)).toBe(
      SessionStatus.PeerRequested
    );
    expect(alice.discussions.getStatus(bob.userId)).toBe(
      SessionStatus.SelfRequested
    );
  });

  it('connects again a restored contact removed and added back by user ID', async () => {
    const { alice, bob } = await restoredContact();
    await addContact(bob, alice, 'Alice');
    await deliver(10);

    // Alice removes Bob and adds him again: Bob, who holds the session,
    // answers her new announcement.
    await alice.contacts.delete(bob.userId);
    await addContact(alice, bob, 'Bob');
    await deliver(10);

    expect(alice.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(alice.userId)).toBe(SessionStatus.Active);
    await messagesFlow(alice, bob);
  });
});
