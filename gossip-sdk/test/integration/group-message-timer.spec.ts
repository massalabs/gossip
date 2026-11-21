/**
 * The message timer of group chats (§7.7) between in-process SDKs over an
 * in-memory transport, with one clock advanced by the test. No backend is
 * used.
 *
 * - a group starts with the timer its creator chose, or the account's
 *   default; the invitation shows it before it is accepted;
 * - only the owner changes it, by a new root; each message keeps the timer
 *   of its own epoch, and the timeline says from which point messages
 *   disappear after which time;
 * - a message leaves the timeline at its moment, on the engine's wake-up,
 *   with a change reported;
 * - a migrated conversation keeps the timer it had; a contact request
 *   remembers its timer until the chat is founded.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { SdkEventType } from '../../src/core/SdkEventEmitter';
import {
  MessageDirection,
  MessageStatus,
  MessageType,
  MESSAGE_ID_SIZE,
} from '../../src/db';
import {
  GROUP_TIMER_28_DAYS_MS,
  retentionToMessageTimer,
  type GroupChange,
  type GroupLine,
  type GroupService,
} from '../../src/services/groups';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

const FIVE_MINUTES = 300_000;
const ONE_HOUR = 3_600_000;

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
  await sdk.conversations.settle();
  return sdk;
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

async function timerLines(
  groups: GroupService,
  groupId: string
): Promise<Extract<GroupLine, { type: 'messageTimer' }>[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'line' && i.line.type === 'messageTimer' ? [i.line] : []
  );
}

/** The engine's own answer, for what the service does not expose. */
function engine(sdk: GossipSdk): { next_wakeup: (now: number) => unknown } {
  return (sdk.groups as unknown as { node: never }).node;
}

describe('retentionToMessageTimer', () => {
  it('reads the earlier "1 month" as 28 days and nothing as Forever', () => {
    expect(retentionToMessageTimer(2_592_000)).toBe(GROUP_TIMER_28_DAYS_MS);
    expect(GROUP_TIMER_28_DAYS_MS).toBe(2_419_200_000);
    expect(retentionToMessageTimer(2_419_200)).toBe(GROUP_TIMER_28_DAYS_MS);
    expect(retentionToMessageTimer(3600)).toBe(ONE_HOUR);
    expect(retentionToMessageTimer(null)).toBe(0);
    expect(retentionToMessageTimer(undefined)).toBe(0);
    expect(retentionToMessageTimer(0)).toBe(0);
  });
});

describe('Group message timer', { timeout: 300_000 }, () => {
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
  async function deliver(rounds = 6) {
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
  }

  /** Alice founds a group with Bob, with `timer`; Bob accepts. */
  async function groupOfTwo(
    alice: GossipSdk,
    bob: GossipSdk,
    timer?: number
  ): Promise<string> {
    const groupId = await alice.groups.createGroup(
      'Trip',
      [bob.userId],
      timer === undefined ? {} : { messageTimer: timer }
    );
    await deliver();
    const [inv] = await bob.groups.invitations();
    expect(inv.messageTimer).toBe(timer ?? GROUP_TIMER_28_DAYS_MS);
    await bob.groups.acceptInvitation(inv.epochId);
    await deliver();
    return groupId;
  }

  it('starts with the timer chosen at creation, shown on the invitation', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');

    const groupId = await groupOfTwo(alice, bob, ONE_HOUR);
    for (const p of [alice, bob]) {
      const g = (await p.groups.get(groupId))!;
      expect(g.messageTimer).toBe(ONE_HOUR);
      expect(g.timers).toHaveLength(1);
      expect(g.timers[0]).toMatchObject({
        epochId: groupId,
        messageTimer: ONE_HOUR,
      });
    }
  });

  it("starts with the creator's default, the earlier 1 month read as 28 days", async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    // An account whose default was never changed holds 2,592,000 s.
    await alice.queries.accountSettings.getOrCreate(alice.userId);
    expect(
      (await alice.queries.accountSettings.get(alice.userId))
        ?.defaultRetentionDuration
    ).toBe(2_592_000);
    expect(await alice.groups.defaultMessageTimer()).toBe(
      GROUP_TIMER_28_DAYS_MS
    );

    const groupId = await groupOfTwo(alice, bob);
    expect((await alice.groups.get(groupId))!.messageTimer).toBe(
      GROUP_TIMER_28_DAYS_MS
    );

    // A default set to Forever (null) founds groups that keep messages.
    await alice.queries.accountSettings.update(alice.userId, {
      defaultRetentionDuration: null,
    });
    expect(await alice.groups.defaultMessageTimer()).toBe(0);
    await bob.queries.accountSettings.getOrCreate(bob.userId);
    await bob.queries.accountSettings.update(bob.userId, {
      defaultRetentionDuration: 3600,
    });
    expect(await bob.groups.defaultMessageTimer()).toBe(ONE_HOUR);
  });

  it('lets the owner change it by a new root, and refuses it to a member', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    const groupId = await groupOfTwo(alice, bob, FIVE_MINUTES);

    await expect(bob.groups.setMessageTimer(groupId, 0)).rejects.toThrow();
    await expect(alice.groups.setMessageTimer(groupId, -1)).rejects.toThrow();

    const epoch = await alice.groups.setMessageTimer(groupId, 0);
    expect(epoch).not.toBe(groupId);
    await deliver();
    for (const p of [alice, bob]) {
      const g = (await p.groups.get(groupId))!;
      expect(g.currentEpoch).toBe(epoch);
      expect(g.messageTimer).toBe(0);
      expect(g.timers.map(t => [t.epochId, t.messageTimer])).toEqual([
        [groupId, FIVE_MINUTES],
        [epoch, 0],
      ]);
      // The timeline says from which point messages disappear, and from
      // which point they are kept.
      expect(await timerLines(p.groups, groupId)).toEqual([
        { type: 'messageTimer', epoch: groupId, timer: FIVE_MINUTES },
        { type: 'messageTimer', epoch, timer: 0 },
      ]);
    }
  });

  it('removes a message from the timeline at its moment, each message with the timer of its epoch', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    const groupId = await groupOfTwo(alice, bob, FIVE_MINUTES);

    await alice.groups.sendMessage(groupId, 'short');
    const sentAt = clock;
    await deliver(2);
    await alice.groups.setMessageTimer(groupId, 0);
    await deliver(2);
    await alice.groups.sendMessage(groupId, 'kept');
    await deliver(2);
    for (const p of [alice, bob]) {
      expect(await texts(p.groups, groupId)).toEqual(['short', 'kept']);
    }

    // The engine wakes the device at the moment of the message, so that the
    // service ticks it then (no polling).
    const moment = sentAt + FIVE_MINUTES;
    for (const p of [alice, bob]) {
      const wake = Number(engine(p).next_wakeup(clock));
      expect(wake).toBeLessThanOrEqual(moment);
    }

    const changes: GroupChange[] = [];
    bob.on(SdkEventType.GROUPS_CHANGED, e => changes.push(...e.changes));
    clock = moment + 1;
    for (const p of [alice, bob]) {
      await p.groups.tick();
      await p.groups.settle();
      expect(await texts(p.groups, groupId)).toEqual(['kept']);
    }
    expect(
      changes.some(c => c.groupId === groupId && c.kind === 'Messages')
    ).toBe(true);

    // Nothing is sent: a later delivery brings nothing back.
    await deliver(2);
    for (const p of [alice, bob]) {
      expect(await texts(p.groups, groupId)).toEqual(['kept']);
    }
  });

  it('migrates an earlier conversation with the timer it has', async () => {
    const [alice, bob] = await open(2);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await alice.queries.messages.insert({
      ownerUserId: alice.userId,
      contactUserId: bob.userId,
      content: 'from before',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.READ,
      messageId: new Uint8Array(MESSAGE_ID_SIZE).fill(1),
      timestamp: new Date(clock - 60_000),
    });
    for (const p of [alice, bob]) await p.conversations.catchUp();
    await alice.queries.discussions.updateByOwnerAndContact(
      alice.userId,
      bob.userId,
      { messageRetentionDuration: 2_592_000, retentionPolicySetAt: clock }
    );
    expect(await alice.conversations.migrationTimer(bob.userId)).toBe(
      GROUP_TIMER_28_DAYS_MS
    );

    const groupId = await alice.conversations.migrate(bob.userId);
    expect((await alice.groups.get(groupId))!.messageTimer).toBe(
      GROUP_TIMER_28_DAYS_MS
    );
    await deliver();
    const inv = await bob.conversations.migrationInvitation(alice.userId);
    expect(inv).toMatchObject({
      epochId: groupId,
      messageTimer: GROUP_TIMER_28_DAYS_MS,
    });
    // The archive keeps its own rule.
    expect(
      (await alice.discussions.get(bob.userId))?.messageRetentionDuration
    ).toBe(2_592_000);
  });

  it('migrates a conversation without a timer to Forever, or with the timer chosen', async () => {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');
    for (const p of [alice, bob, carol]) await p.conversations.catchUp();

    expect(await alice.conversations.migrationTimer(bob.userId)).toBe(0);
    const withBob = await alice.conversations.migrate(bob.userId);
    expect((await alice.groups.get(withBob))!.messageTimer).toBe(0);

    const withCarol = await alice.conversations.migrate(carol.userId, {
      messageTimer: ONE_HOUR,
    });
    expect((await alice.groups.get(withCarol))!.messageTimer).toBe(ONE_HOUR);
  });

  it('remembers the timer of a contact request until the chat is founded', async () => {
    const [alice, bob] = await open(2);
    await alice.contacts.add(bob.userId, 'Bob', bob.publicKeys);
    await bob.contacts.add(alice.userId, 'Alice', alice.publicKeys);
    const contact = (await alice.contacts.get(bob.userId))!;
    const started = await alice.discussions.start(
      contact,
      { username: 'Alice', message: 'hello' },
      { messageTimer: ONE_HOUR }
    );
    expect(started.success).toBe(true);
    expect(await alice.discussions.get(bob.userId)).toMatchObject({
      directChatOwed: true,
      directChatTimer: ONE_HOUR,
    });

    await bob.announcements.fetch();
    const d = (await bob.discussions.get(alice.userId))!;
    // Bob sees the timer before he accepts.
    expect(d.directChatTimer).toBe(ONE_HOUR);
    expect((await bob.discussions.accept(d)).success).toBe(true);
    await deliver();

    const groupId = await alice.conversations.directChatWith(bob.userId);
    expect(groupId).not.toBeNull();
    for (const p of [alice, bob]) {
      expect((await p.groups.get(groupId!))!.messageTimer).toBe(ONE_HOUR);
    }
    expect(await alice.discussions.get(bob.userId)).toMatchObject({
      directChatOwed: false,
      directChatTimer: null,
      linkedGroupId: groupId,
    });
  });
});
