/**
 * Sending as another member, a message on this device only, and an edit that
 * changes the author (§7.2, §9.7, §10.2), between three in-process SDKs over
 * an in-memory transport. No backend is used.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import type { GroupMessage } from '../../src/services/groups';

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

interface Internals {
  messageProtocol: { sendMessage: (m: unknown) => Promise<void> };
}
const internals = (sdk: GossipSdk) => sdk.groups as unknown as Internals;

describe('Sending as another member', { timeout: 240_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let carol: GossipSdk;
  let peers: GossipSdk[];
  let groupId: string;

  /** Fetches on every SDK until nothing new arrives; past every random wait. */
  async function deliver(online: GossipSdk[] = peers, rounds = 8) {
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

  async function find(p: GossipSdk, syncObjId: string) {
    return (await messages(p)).find(m => m.syncObjId === syncObjId) ?? null;
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
  }, 240_000);

  afterEach(async () => {
    for (const p of peers) await p.closeSession();
  });

  it('a message as another member reaches everyone under that author, the claimed author included', async () => {
    const p = await alice.groups.sendMessage(groupId, 'signed: bob', {
      author: bob.userId,
    });
    // Shown on the sender's device at once, under Bob's name.
    const here = await find(alice, p.syncObjId);
    expect(here?.author).toBe(bob.userId);
    expect(here?.body).toEqual({ type: 'text', text: 'signed: bob' });
    await deliver();
    for (const peer of [bob, carol]) {
      const m = await find(peer, p.syncObjId);
      expect(m?.author).toBe(bob.userId);
      expect(m?.body).toEqual({ type: 'text', text: 'signed: bob' });
    }
  });

  it('an author who is not a member is refused', async () => {
    const stranger = await openPeer(net);
    await expect(
      alice.groups.sendMessage(groupId, 'x', { author: stranger.userId })
    ).rejects.toThrow();
    await stranger.closeSession();
  });

  it('a message only for me is in the sender timeline only, and nothing is sent for it', async () => {
    await deliver();
    const transport = internals(alice).messageProtocol;
    let sends = 0;
    internals(alice).messageProtocol = {
      sendMessage: async (m: unknown) => {
        sends++;
        return transport.sendMessage(m);
      },
    };
    const { syncObjId } = await alice.groups.sendMessageLocally(
      groupId,
      'only here, as carol',
      { author: carol.userId }
    );
    await alice.groups.settle();
    expect(sends).toBe(0);
    // The counter does see what a message for everyone sends.
    await alice.groups.sendMessage(groupId, 'for everyone');
    await alice.groups.settle();
    expect(sends).toBeGreaterThan(0);
    internals(alice).messageProtocol = transport;
    const here = await find(alice, syncObjId);
    expect(here?.author).toBe(carol.userId);
    expect(here?.body).toEqual({ type: 'text', text: 'only here, as carol' });
    // Nothing marks it: it looks like any message.
    expect(here?.edited).toBe(false);
    await deliver();
    expect(await find(bob, syncObjId)).toBeNull();
    expect(await find(carol, syncObjId)).toBeNull();
    expect(await find(alice, syncObjId)).not.toBeNull();
  });

  it('a message only for me is accepted in a chat this device can only read, and nothing is sent', async () => {
    // Alice dissolves the chat; Bob keeps it, read only.
    await alice.groups.dissolve(groupId, false);
    await deliver();
    await expect(
      bob.groups.sendMessage(groupId, 'to everyone')
    ).rejects.toThrow();
    const transport = internals(bob).messageProtocol;
    let sends = 0;
    internals(bob).messageProtocol = {
      sendMessage: async (m: unknown) => {
        sends++;
        return transport.sendMessage(m);
      },
    };
    // Under any member of the chat's last epoch, Bob's own name included.
    const asCarol = await bob.groups.sendMessageLocally(
      groupId,
      'only here, as carol',
      { author: carol.userId }
    );
    const asBob = await bob.groups.sendMessageLocally(groupId, 'only here');
    await bob.groups.settle();
    await deliver([bob]);
    expect(sends).toBe(0);
    internals(bob).messageProtocol = transport;
    expect((await find(bob, asCarol.syncObjId))?.author).toBe(carol.userId);
    expect((await find(bob, asBob.syncObjId))?.author).toBe(bob.userId);
    await deliver();
    for (const peer of [alice, carol]) {
      expect(await find(peer, asCarol.syncObjId)).toBeNull();
      expect(await find(peer, asBob.syncObjId)).toBeNull();
    }
  });

  it('an edit that changes the author converges on every device', async () => {
    const p = await alice.groups.sendMessage(groupId, 'mine');
    await deliver();
    const m = await find(alice, p.syncObjId);
    await alice.groups.editMessage(m!.epochId, p.syncObjId, 'now carol', {
      author: carol.userId,
    });
    expect((await find(alice, p.syncObjId))?.author).toBe(carol.userId);
    await deliver();
    for (const peer of peers) {
      const e = await find(peer, p.syncObjId);
      expect(e?.author).toBe(carol.userId);
      expect(e?.body).toEqual({ type: 'text', text: 'now carol' });
      expect(e?.edited).toBe(true);
    }
    // Re-appropriation by Bob: converges too.
    await bob.groups.editMessage(m!.epochId, p.syncObjId, 'bob takes it', {
      author: bob.userId,
    });
    await deliver();
    for (const peer of peers) {
      expect((await find(peer, p.syncObjId))?.author).toBe(bob.userId);
    }
  });
});
