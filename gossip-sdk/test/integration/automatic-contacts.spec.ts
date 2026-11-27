/**
 * Automatic contacts (§5.12) between in-process SDKs over an in-memory
 * transport. No backend is used.
 *
 * - a member of a shared chat who is no contact is added as a contact on this
 *   device only, and adding them sends nothing;
 * - a normal contact is still refused as a duplicate;
 * - a real contact request from a member of a shared chat is shown with its
 *   message and timer, while the connection the chat needs is answered at
 *   once as before; accepting it sends nothing more, declining it keeps the
 *   connection;
 * - a request still waiting is kept when this device accepts a chat that
 *   lists the requester, and when the connection goes with the last chat.
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
import type { GroupService } from '../../src/services/groups';
import { SessionStatus } from '../../src/wasm/bindings';
import { bytesToHex } from '@noble/hashes/utils';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

const ONE_HOUR = 60 * 60_000;

function setClock(sdk: GossipSdk) {
  (sdk.groups as unknown as { now: () => number }).now = () => clock;
  (
    sdk as unknown as { _announcement: { now: () => number } }
  )._announcement.now = () => clock;
}

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
  setClock(sdk);
  await sdk.conversations.settle();
  return sdk;
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

/** The contacts declared to the engine as accepted (§13.8). */
function declared(p: GossipSdk): string[] {
  return JSON.parse(
    (
      p.groups as unknown as { node: { accepted_contacts: () => string } }
    ).node.accepted_contacts()
  ) as string[];
}

/** Every call that would put something on the wire, while `f` runs. */
async function sentDuring(
  net: MockMessageProtocol,
  f: () => Promise<unknown>
): Promise<string[]> {
  const calls: string[] = [];
  const original = {
    sendMessage: net.sendMessage,
    sendAnnouncement: net.sendAnnouncement,
  };
  net.sendMessage = async m => {
    calls.push('message');
    return original.sendMessage.call(net, m);
  };
  net.sendAnnouncement = async a => {
    calls.push('announcement');
    return original.sendAnnouncement.call(net, a);
  };
  try {
    await f();
  } finally {
    net.sendMessage = original.sendMessage;
    net.sendAnnouncement = original.sendAnnouncement;
  }
  return calls;
}

describe('Automatic contacts', { timeout: 300_000 }, () => {
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
   * Alice's chat "Trip" with Bob and Carol, who are contacts of Alice only.
   * With `accept`, both accept it and get connected to each other.
   */
  async function trip(accept: boolean) {
    const [alice, bob, carol] = await open(3);
    await setupSession(alice, bob, 'Bob', 'Alice');
    await setupSession(alice, carol, 'Carol', 'Alice');
    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    if (accept) {
      for (const p of [bob, carol]) {
        const [inv] = await p.groups.invitations();
        await p.conversations.acceptInvitation(inv.epochId);
      }
      await deliver(20, 10_000);
    }
    return { alice, bob, carol, groupId };
  }

  /** Carol asks Bob to become a contact, with a message and a timer. */
  async function carolRequests(carol: GossipSdk, bob: GossipSdk) {
    await carol.contacts.add(bob.userId, 'Bob', bob.publicKeys);
    const contact = (await carol.contacts.get(bob.userId))!;
    const started = await carol.discussions.start(
      contact,
      { username: 'Carol', message: 'hello Bob' },
      { messageTimer: ONE_HOUR }
    );
    expect(started.success).toBe(true);
  }

  it('adds a member who is no contact as a contact on this device only, sending nothing', async () => {
    const { bob, carol, groupId } = await trip(true);
    expect((await bob.contacts.get(carol.userId))?.connection).toBe(
      'automatic'
    );

    const sent = await sentDuring(net, async () => {
      const result = await bob.conversations.addAsContact(
        carol.userId,
        'Carol'
      );
      expect(result.success).toBe(true);
      await bob.conversations.settle();
      await bob.groups.settle();
    });
    expect(sent).toEqual([]);

    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'accepted',
      name: 'Carol',
    });
    expect(declared(bob)).toContain(bytesToHex(carol.userIdBytes));
    // Nothing changed on Carol's side.
    expect((await carol.contacts.get(bob.userId))?.connection).toBe(
      'automatic'
    );
    // The shared chat still flows.
    await carol.groups.sendMessage(groupId, 'still here');
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['still here']);
    // An accepted contact is never revoked: still there once the chat is gone.
    await bob.groups.leave(groupId, 'Signed');
    await deliver();
    if ((await bob.groups.get(groupId)) !== null) {
      await bob.groups.deleteGroup(groupId);
    }
    await bob.groups.tick();
    await bob.groups.settle();
    await bob.conversations.catchUp();
    expect((await bob.contacts.get(carol.userId))?.connection).toBe('accepted');
  });

  it('adds a member whose connection is not open yet with the keys the engine holds, sending nothing', async () => {
    const { bob, carol } = await trip(true);
    // As before the connection is opened: no contact row at all.
    await bob.queries.contacts.deleteByOwnerAndUser(bob.userId, carol.userId);
    expect(await bob.contacts.get(carol.userId)).toBeNull();

    const sent = await sentDuring(net, async () => {
      const result = await bob.conversations.addAsContact(
        carol.userId,
        'Carol'
      );
      expect(result.success).toBe(true);
    });
    expect(sent).toEqual([]);
    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'accepted',
      name: 'Carol',
    });
  });

  it('still refuses a contact the user accepted, and a person it knows nothing of', async () => {
    const { alice, bob } = await trip(false);
    expect(await bob.conversations.addAsContact(alice.userId, 'A')).toEqual({
      success: false,
      reason: 'already-contact',
    });
    expect((await bob.contacts.get(alice.userId))?.name).toBe('Alice');
    const stranger = await openPeer(net);
    peers.push(stranger);
    expect(await bob.conversations.addAsContact(stranger.userId, 'S')).toEqual({
      success: false,
      reason: 'unknown',
    });
    expect(await bob.contacts.get(stranger.userId)).toBeNull();
  });

  it('shows a real request from a member of a shared chat with its message, and answers the connection at once as before', async () => {
    const { bob, carol } = await trip(false);
    // Bob accepts the chat; Carol has only been invited, so she asks him
    // as a contact rather than through an automatic connection.
    const [inv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(inv.epochId);
    await carolRequests(carol, bob);

    const requested: unknown[] = [];
    bob.on(SdkEventType.SESSION_REQUESTED, e => requested.push(e));
    const sent = await sentDuring(net, () => bob.announcements.fetch());
    // The automatic answer, as for a connection.
    expect(sent).toEqual(['announcement']);
    expect(requested).toHaveLength(1);

    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'requested',
      name: 'Carol',
    });
    expect(await bob.discussions.get(carol.userId)).toMatchObject({
      announcementMessage: 'hello Bob',
      directChatTimer: ONE_HOUR,
    });
    expect(declared(bob)).not.toContain(bytesToHex(carol.userIdBytes));

    await carol.announcements.fetch();
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
  });

  it('accepting the request of a member sends nothing and adopts the chat it asked for', async () => {
    const { bob, carol } = await trip(false);
    const [inv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(inv.epochId);
    await carolRequests(carol, bob);
    await bob.announcements.fetch();
    await deliver();
    // Carol founded the chat of two once answered; Bob holds it as an
    // invitation until he answers the request.
    const direct = await carol.conversations.directChatWith(bob.userId);
    expect(direct).not.toBeNull();

    const d = (await bob.discussions.get(carol.userId))!;
    const sent = await sentDuring(net, async () => {
      expect((await bob.discussions.accept(d)).success).toBe(true);
      await bob.conversations.settle();
    });
    // No announcement: the session is already open. Adopting the chat may
    // query its members, as accepting any chat does.
    expect(sent).not.toContain('announcement');
    expect((await bob.contacts.get(carol.userId))?.connection).toBe('accepted');
    expect(declared(bob)).toContain(bytesToHex(carol.userIdBytes));
    await deliver();
    expect(await bob.groups.get(direct!)).not.toBeNull();
    expect(
      (await bob.groups.invitations()).filter(i => i.epochId === direct)
    ).toEqual([]);
    await carol.groups.sendMessage(direct!, 'hi');
    await deliver();
    expect(await texts(bob.groups, direct!)).toEqual(['hi']);
  });

  it('declining the request of a member keeps the connection the shared chat needs', async () => {
    const { bob, carol, groupId } = await trip(false);
    const [inv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(inv.epochId);
    await carolRequests(carol, bob);
    await bob.announcements.fetch();
    await carol.announcements.fetch();

    const sent = await sentDuring(net, () =>
      bob.conversations.declineContactRequest(carol.userId)
    );
    expect(sent).toEqual([]);
    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'automatic',
    });
    expect(
      (await bob.discussions.get(carol.userId))?.announcementMessage ?? null
    ).toBeNull();
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);

    const [carolInv] = await carol.groups.invitations();
    await carol.conversations.acceptInvitation(carolInv.epochId);
    await deliver(20, 10_000);
    await bob.groups.sendMessage(groupId, 'from bob');
    await deliver();
    await carol.groups.sendMessage(groupId, 'from carol');
    await deliver();
    expect(await texts(carol.groups, groupId)).toEqual([
      'from bob',
      'from carol',
    ]);
    expect(await texts(bob.groups, groupId)).toEqual([
      'from bob',
      'from carol',
    ]);
  });

  it('keeps a waiting request when this device accepts a chat that lists the requester', async () => {
    const { bob, carol, groupId } = await trip(false);
    // Neither has accepted the chat: a plain request, waiting for Bob.
    await carolRequests(carol, bob);
    await bob.announcements.fetch();
    expect(bob.discussions.getStatus(carol.userId)).toBe(
      SessionStatus.PeerRequested
    );

    const [inv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(inv.epochId);
    await deliver(20, 10_000);

    // The connection works underneath; the request is still there.
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'requested',
      name: 'Carol',
    });
    expect(await bob.discussions.get(carol.userId)).toMatchObject({
      announcementMessage: 'hello Bob',
      directChatTimer: ONE_HOUR,
    });

    const [carolInv] = await carol.groups.invitations();
    await carol.conversations.acceptInvitation(carolInv.epochId);
    await deliver(20, 10_000);
    await carol.groups.sendMessage(groupId, 'hi all');
    await deliver();
    expect(await texts(bob.groups, groupId)).toEqual(['hi all']);
  });

  it('keeps a waiting request of a member once the connection goes with the last shared chat', async () => {
    const { bob, carol, groupId } = await trip(false);
    const [inv] = await bob.groups.invitations();
    await bob.conversations.acceptInvitation(inv.epochId);
    await carolRequests(carol, bob);
    await bob.announcements.fetch();
    await deliver();
    // Bob declines Carol's chat of two silently, then leaves the trip.
    for (const i of await bob.groups.invitations()) {
      await bob.conversations.declineInvitation(i.epochId, 'Silent');
    }
    await bob.groups.leave(groupId, 'Signed');
    await deliver();
    if ((await bob.groups.get(groupId)) !== null) {
      await bob.groups.deleteGroup(groupId);
    }
    await bob.groups.tick();
    await bob.groups.settle();
    await bob.conversations.catchUp();

    // The connection went as an automatic one would; the request stays.
    expect(bob.discussions.getStatus(carol.userId)).not.toBe(
      SessionStatus.Active
    );
    expect((await bob.contacts.get(carol.userId))?.connection).toBe(
      'requested'
    );
    expect((await bob.discussions.get(carol.userId))?.announcementMessage).toBe(
      'hello Bob'
    );
  });
});
