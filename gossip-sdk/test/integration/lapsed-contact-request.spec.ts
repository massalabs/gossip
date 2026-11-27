/**
 * "Send a contact request" for a contact the user added on their own whose
 * connection has lapsed (§5.12, D.100), between in-process SDKs over an
 * in-memory transport. No backend is used.
 *
 * - the request is an ordinary one: what it carries and what goes on the
 *   wire are what a first-time request with the same inputs gives;
 * - the contact keeps its name, and becomes mutual once the other person
 *   accepts;
 * - declined or never answered, the contact stays, not connected;
 * - the other person sees a request even when they had added this user on
 *   their own too.
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
import { SessionStatus } from '../../src/wasm/bindings';
import { bytesToHex } from '@noble/hashes/utils';

/** One clock for every SDK, advanced by the test. */
let clock = 1_800_000_000_000;

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

/** The contacts declared to the engine as accepted (§13.8). */
function declared(p: GossipSdk): string[] {
  return JSON.parse(
    (
      p.groups as unknown as { node: { accepted_contacts: () => string } }
    ).node.accepted_contacts()
  ) as string[];
}

/** What a device hands to the session layer for each announcement it makes. */
function payloads(p: GossipSdk): Uint8Array[] {
  const service = (
    p as unknown as {
      _announcement: {
        establishSession: (k: unknown, b?: Uint8Array) => Promise<unknown>;
      };
    }
  )._announcement;
  const original = service.establishSession.bind(service);
  const seen: Uint8Array[] = [];
  service.establishSession = (k, b) => {
    seen.push(b ?? new Uint8Array(0));
    return original(k, b);
  };
  return seen;
}

/** Every call that puts something on the wire while `f` runs, with its size. */
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
    calls.push(`announcement:${a.length}`);
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

describe('A contact request to a lapsed contact', { timeout: 300_000 }, () => {
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

  /** `p` leaves `groupId` visibly and deletes it: its connections lapse. */
  async function leaveAndDelete(p: GossipSdk, groupId: string) {
    await p.groups.leave(groupId, 'Signed');
    await deliver();
    if ((await p.groups.get(groupId)) !== null) {
      await p.groups.deleteGroup(groupId);
    }
    await p.groups.tick();
    await p.groups.settle();
    await p.conversations.catchUp();
  }

  /**
   * Alice's chat "Trip" with Bob and Carol, contacts of Alice only. Bob adds
   * Carol on his own (and Carol adds Bob too, with `both`); then both leave
   * the chat, and the connection between them lapses.
   */
  async function lapsed(both = false) {
    const [alice, bob, carol, dave] = await open(4);
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
    expect(
      (await bob.conversations.addAsContact(carol.userId, 'Carol')).success
    ).toBe(true);
    if (both) {
      expect(
        (await carol.conversations.addAsContact(bob.userId, 'Bob')).success
      ).toBe(true);
    }
    await leaveAndDelete(bob, groupId);
    await leaveAndDelete(carol, groupId);
    await deliver();
    expect(bob.discussions.getStatus(carol.userId)).not.toBe(
      SessionStatus.Active
    );
    expect(carol.discussions.getStatus(bob.userId)).not.toBe(
      SessionStatus.Active
    );
    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      connection: 'added',
      name: 'Carol',
    });
    return { alice, bob, carol, dave };
  }

  const payload = { username: 'Bobby', message: 'hello again' };

  it('sends an ordinary request, identical to a first-time request with the same inputs', async () => {
    const { bob, carol, dave } = await lapsed();
    const made = payloads(bob);

    // The request to the lapsed contact.
    const again = await sentDuring(net, async () => {
      expect(
        await bob.conversations.sendContactRequest(carol.userId, payload)
      ).toEqual({ success: true });
    });
    // A first-time request to someone new, with the same inputs.
    const first = await sentDuring(net, async () => {
      await bob.contacts.add(dave.userId, 'Dave', dave.publicKeys);
      const contact = (await bob.contacts.get(dave.userId))!;
      expect((await bob.discussions.start(contact, payload)).success).toBe(
        true
      );
    });
    // What the announcement carries, byte for byte, and what goes out.
    expect(made).toHaveLength(2);
    expect(bytesToHex(made[0])).toBe(bytesToHex(made[1]));
    expect(again).toEqual(first);
    expect(again).toHaveLength(1);

    // The contact keeps its name; its request waits as any request does.
    expect(await bob.contacts.get(carol.userId)).toMatchObject({
      name: 'Carol',
      connection: 'accepted',
    });
    expect(bob.discussions.getStatus(carol.userId)).toBe(
      SessionStatus.SelfRequested
    );
    expect((await bob.contacts.get(dave.userId))?.connection).toBe('accepted');
    expect(bob.discussions.getStatus(dave.userId)).toBe(
      SessionStatus.SelfRequested
    );

    // Carol sees an ordinary request, with its name and message.
    const requested: string[] = [];
    carol.on(SdkEventType.SESSION_REQUESTED, e => {
      requested.push(e.contact.userId);
    });
    await deliver();
    expect(requested).toContain(bob.userId);
    expect(carol.discussions.getStatus(bob.userId)).toBe(
      SessionStatus.PeerRequested
    );
    expect(await carol.contacts.get(bob.userId)).toMatchObject({
      name: 'Bobby',
      connection: 'accepted',
    });
    expect((await carol.discussions.get(bob.userId))?.announcementMessage).toBe(
      'hello again'
    );

    // Carol accepts: the two are connected, and Carol is declared to Bob's
    // engine as any accepted contact.
    const d = (await carol.discussions.get(bob.userId))!;
    expect((await carol.discussions.accept(d)).success).toBe(true);
    await deliver();
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
    expect(carol.discussions.getStatus(bob.userId)).toBe(SessionStatus.Active);
    expect((await bob.contacts.get(carol.userId))?.connection).toBe('accepted');
    expect(declared(bob)).toContain(bytesToHex(carol.userIdBytes));
    // Either may now start the pair's chat.
    const direct = await bob.conversations.startDirectChat(carol.userId);
    await deliver();
    expect(
      (await carol.groups.invitations()).some(i => i.epochId === direct)
    ).toBe(true);
  });

  it('is shown as a request to someone who had added this user on their own too', async () => {
    const { bob, carol } = await lapsed(true);
    expect(await carol.contacts.get(bob.userId)).toMatchObject({
      connection: 'added',
      name: 'Bob',
    });
    const requested: string[] = [];
    carol.on(SdkEventType.SESSION_REQUESTED, e => {
      requested.push(e.contact.userId);
    });
    expect(
      await bob.conversations.sendContactRequest(carol.userId, payload)
    ).toEqual({ success: true });
    await deliver();
    // A request waiting for Carol's answer, not a silent connection.
    expect(requested).toContain(bob.userId);
    expect(carol.discussions.getStatus(bob.userId)).toBe(
      SessionStatus.PeerRequested
    );
    expect(bob.discussions.getStatus(carol.userId)).toBe(
      SessionStatus.SelfRequested
    );
    // Her contact keeps the name she gave.
    expect((await carol.contacts.get(bob.userId))?.name).toBe('Bob');
    const d = (await carol.discussions.get(bob.userId))!;
    expect((await carol.discussions.accept(d)).success).toBe(true);
    await deliver();
    expect(bob.discussions.getStatus(carol.userId)).toBe(SessionStatus.Active);
    expect((await carol.contacts.get(bob.userId))?.connection).toBe('accepted');
    expect((await bob.contacts.get(carol.userId))?.connection).toBe('accepted');
    expect(declared(carol)).toContain(bytesToHex(bob.userIdBytes));
  });

  it('keeps the contact, not connected, when the request is declined or never answered', async () => {
    const { bob, carol } = await lapsed();
    expect(
      await bob.conversations.sendContactRequest(carol.userId, {})
    ).toEqual({ success: true });
    await deliver();
    expect(carol.discussions.getStatus(bob.userId)).toBe(
      SessionStatus.PeerRequested
    );
    // Never answered.
    await deliver(10, 60_000);
    expect(bob.discussions.getStatus(carol.userId)).not.toBe(
      SessionStatus.Active
    );
    expect((await bob.contacts.get(carol.userId))?.name).toBe('Carol');
    // Declined: Bob is told nothing, and keeps the contact.
    await carol.conversations.declineContactRequest(bob.userId);
    await deliver();
    expect(bob.discussions.getStatus(carol.userId)).not.toBe(
      SessionStatus.Active
    );
    expect((await bob.contacts.get(carol.userId))?.name).toBe('Carol');
  });

  it('refuses a contact that is not one added on this device, and a live connection', async () => {
    const { alice, bob, carol } = await lapsed();
    // Alice is a contact Bob accepted.
    expect(
      await bob.conversations.sendContactRequest(alice.userId, payload)
    ).toEqual({ success: false, reason: 'not-added' });
    // Connected again: nothing has lapsed.
    expect(
      (await bob.conversations.sendContactRequest(carol.userId, payload))
        .success
    ).toBe(true);
    await deliver();
    const d = (await carol.discussions.get(bob.userId))!;
    await carol.discussions.accept(d);
    await deliver();
    await bob.queries.contacts.updateByOwnerAndUser(bob.userId, carol.userId, {
      connection: 'added',
    });
    expect(
      await bob.conversations.sendContactRequest(carol.userId, payload)
    ).toEqual({ success: false, reason: 'connected' });
  });
});
