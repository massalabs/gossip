/**
 * Group messages by radio (MeshCore datagrams) between three in-process SDKs:
 * the datagram is handed over by the test, the rest travels over the in-memory
 * transport as usual.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import type { GroupService } from '../../src/services/groups';
import { RADIO_MAX_TEXT_BYTES } from '../../src/services/groups';

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

describe('Group messages by radio', { timeout: 120_000 }, () => {
  let net: MockMessageProtocol;
  let alice: GossipSdk;
  let bob: GossipSdk;
  let carol: GossipSdk;
  let peers: GossipSdk[];

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

  async function trip(): Promise<string> {
    const groupId = await alice.groups.createGroup('Trip', [
      bob.userId,
      carol.userId,
    ]);
    await deliver();
    for (const p of [bob, carol]) {
      const [inv] = await p.groups.invitations();
      await p.groups.acceptInvitation(inv.epochId);
    }
    await deliver();
    return groupId;
  }

  it('delivers a radio message as the same group message everywhere', async () => {
    const groupId = await trip();

    const sent = await alice.groups.sendRadioText(groupId, 'by radio');
    expect(sent.datagram.length).toBeLessThanOrEqual(165);

    // Bob's radio hears it: the message is there before any network delivery.
    const received = await bob.groups.receiveRadio(sent.datagram);
    expect(received).toMatchObject({
      groupId,
      eventId: sent.eventId,
      syncObjId: sent.syncObjId,
      author: alice.userId,
      olderKey: false,
      accepted: true,
    });
    expect(await texts(bob.groups, groupId)).toEqual(['by radio']);

    // A replay changes nothing.
    expect((await bob.groups.receiveRadio(sent.datagram))?.accepted).toBe(
      false
    );

    await deliver();
    for (const p of peers) {
      expect(await texts(p.groups, groupId)).toEqual(['by radio']);
    }
    expect(
      (await alice.groups.radioRecords([sent.syncObjId])).get(sent.syncObjId)
    ).toMatchObject({ direction: 'sent', olderKey: false });
    expect(
      (await bob.groups.radioRecords([sent.syncObjId])).get(sent.syncObjId)
    ).toMatchObject({ direction: 'received', olderKey: false });
    expect((await carol.groups.radioRecords([sent.syncObjId])).size).toBe(0);
  });

  it('handles radio messages while the network hangs', async () => {
    const groupId = await trip();

    // The server stops answering: every post waits until released.
    let release!: () => void;
    const back = new Promise<void>(r => (release = r));
    const post = net.sendMessage.bind(net);
    net.sendMessage = async m => {
      await back;
      return post(m);
    };
    const soon = <T>(p: Promise<T>) =>
      Promise.race([
        p,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('held back by the network')), 3000)
        ),
      ]);

    // Both have sends waiting on the network.
    await soon(bob.groups.sendMessage(groupId, 'online from bob'));
    await soon(alice.groups.sendMessage(groupId, 'online from alice'));
    await new Promise(r => setTimeout(r, 50));

    const sent = await soon(alice.groups.sendRadioText(groupId, 'by radio'));
    expect((await soon(bob.groups.receiveRadio(sent.datagram)))?.accepted).toBe(
      true
    );
    expect(await texts(bob.groups, groupId)).toContain('by radio');

    // Once the server answers again, everything gets through.
    release();
    await deliver();
    for (const p of peers) {
      expect((await texts(p.groups, groupId)).sort()).toEqual(
        ['by radio', 'online from alice', 'online from bob'].sort()
      );
    }
  });

  it('refuses a radio text over its limit, and ignores datagrams of other groups', async () => {
    const groupId = await trip();
    await expect(
      alice.groups.sendRadioText(groupId, 'x'.repeat(RADIO_MAX_TEXT_BYTES + 1))
    ).rejects.toThrow('groups:radio-text-too-long');
    const ok = await alice.groups.sendRadioText(
      groupId,
      'x'.repeat(RADIO_MAX_TEXT_BYTES)
    );
    expect(ok.datagram.length).toBe(165);

    const outsider = await openPeer(net);
    peers.push(outsider);
    expect(await outsider.groups.receiveRadio(ok.datagram)).toBeNull();
    expect(await bob.groups.receiveRadio(new Uint8Array(40))).toBeNull();
  });
});
