/**
 * Messaging over two transports at once (an internet node and a mesh), with
 * the delays, reordering, duplicates and partitions a store-and-forward mesh
 * produces. Real WASM sessions; in-memory transports.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { CompositeMessageProtocol } from '../../src/api/messageProtocol/composite';
import type {
  BulletinItem,
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
} from '../../src/api/messageProtocol/types';
import type { SessionModule } from '../../src/wasm/session';
import { getTestStorageConfig } from '../testDb';

/** Wraps a shared store with what a lossy, slow, partitionable path does. */
class ChaosProtocol implements IMessageProtocol {
  down = false;
  duplicate = false;
  shuffle = false;
  maxDelayMs = 0;

  constructor(private readonly store: IMessageProtocol) {}

  private async step(): Promise<void> {
    if (this.maxDelayMs > 0) {
      await new Promise(r => setTimeout(r, Math.random() * this.maxDelayMs));
    }
    if (this.down) throw new Error('partitioned');
  }

  /** Every seeker this path was asked for or given, base64. */
  seenSeekers = new Set<string>();

  private see(seekers: Uint8Array[]): void {
    for (const seeker of seekers) {
      this.seenSeekers.add(Buffer.from(seeker).toString('base64'));
    }
  }

  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    this.see(seekers);
    await this.step();
    let messages = await this.store.fetchMessages(seekers);
    if (this.duplicate) messages = messages.concat(messages);
    if (this.shuffle) messages = [...messages].sort(() => Math.random() - 0.5);
    return messages;
  }

  async sendMessage(message: EncryptedMessage): Promise<void> {
    this.see([message.seeker]);
    await this.step();
    await this.store.sendMessage(message);
  }

  /** The announcement board is out of reach, as for a mesh-only node. */
  noBoard = false;

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    await this.step();
    if (this.noBoard) throw new Error('no board');
    return this.store.sendAnnouncement(announcement);
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    await this.step();
    if (this.noBoard) throw new Error('no board');
    let items = await this.store.fetchAnnouncements(limit, cursor);
    if (this.duplicate) items = items.concat(items);
    return items;
  }

  async fetchBulletinCounter(): Promise<string> {
    await this.step();
    return this.store.fetchBulletinCounter();
  }

  changeNode(): Promise<MessageProtocolResponse> {
    return Promise.resolve({ success: true });
  }

  wanted: Uint8Array[] = [];
  localWanted: Uint8Array[] = [];

  async setWantedSeekers(
    seekers: Uint8Array[],
    localSeekers: Uint8Array[] = []
  ): Promise<void> {
    this.wanted = seekers;
    this.localWanted = localSeekers;
  }
}

interface Peer {
  sdk: GossipSdk;
  internet: ChaosProtocol;
  mesh: ChaosProtocol;
}

async function openPeer(
  internetStore: MockMessageProtocol,
  meshStore: MockMessageProtocol
): Promise<Peer> {
  const internet = new ChaosProtocol(internetStore);
  const mesh = new ChaosProtocol(meshStore);
  const sdk = new GossipSdk();
  await sdk.init({
    storage: getTestStorageConfig(),
    messageProtocol: new CompositeMessageProtocol(
      { protocol: internet, kind: 'internet' },
      [{ protocol: mesh, kind: 'mesh' }]
    ),
  });
  await sdk.openSession({
    mnemonic: generateMnemonic(),
    encryptionKey: await generateEncryptionKey(),
    onPersist: async () => {},
    autoStartPolling: false,
    publishPublicKey: false,
  });
  return { sdk, internet, mesh };
}

function sessionOf(sdk: GossipSdk): SessionModule {
  return (sdk as unknown as { state: { session: SessionModule } }).state
    .session;
}

describe('Messaging over internet and mesh transports', () => {
  let internetStore: MockMessageProtocol;
  let meshStore: MockMessageProtocol;
  let alice: Peer;
  let bob: Peer;

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  beforeEach(async () => {
    internetStore = new MockMessageProtocol();
    meshStore = new MockMessageProtocol();
    alice = await openPeer(internetStore, meshStore);
    bob = await openPeer(internetStore, meshStore);
    await setupSession(alice.sdk, bob.sdk, 'Bob', 'Alice');
  });

  afterEach(async () => {
    await alice.sdk.destroy();
    await bob.sdk.destroy();
  });

  async function deliverGroups(rounds = 4) {
    for (let r = 0; r < rounds; r++) {
      for (const p of [alice, bob]) {
        await p.sdk.groups.tick();
        await p.sdk.groups.settle();
        await p.sdk.messages.fetch();
        await p.sdk.groups.settle();
      }
    }
  }

  async function texts(p: Peer, groupId: string): Promise<string[]> {
    return (await p.sdk.groups.timeline(groupId)).flatMap(i =>
      i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
    );
  }

  it('posts to the internet a group message only the mesh took, once the internet is back', async () => {
    const groupId = await alice.sdk.groups.createGroup('Two', [bob.sdk.userId]);
    await deliverGroups();
    const [invitation] = await bob.sdk.groups.invitations();
    await bob.sdk.groups.acceptInvitation(invitation.epochId);
    await deliverGroups();

    // Alice reaches the mesh only; Bob reads the internet only.
    alice.internet.down = true;
    bob.mesh.down = true;
    await alice.sdk.groups.sendMessage(groupId, 'over the mesh');
    await alice.sdk.groups.settle();
    await deliverGroups(2);
    expect(await texts(bob, groupId)).toEqual([]);

    // Back on the internet: what only the mesh took goes to the server.
    alice.internet.down = false;
    await alice.sdk.groups.internetBack();
    await alice.sdk.groups.settle();
    await deliverGroups(2);
    expect(await texts(bob, groupId)).toEqual(['over the mesh']);
  }, 60_000);

  it('sends the group outbox at once when the internet is back, whatever the waits', async () => {
    const groupId = await alice.sdk.groups.createGroup('Two', [bob.sdk.userId]);
    await deliverGroups();
    const [invitation] = await bob.sdk.groups.invitations();
    await bob.sdk.groups.acceptInvitation(invitation.epochId);
    await deliverGroups();

    alice.internet.down = true;
    alice.mesh.down = true;
    await alice.sdk.groups.sendMessage(groupId, 'written offline');
    // Many failed tries: the next one would wait a long time.
    for (let i = 0; i < 12; i++) {
      await alice.sdk.groups.internetBack();
      await alice.sdk.groups.settle();
    }
    alice.internet.down = false;
    alice.mesh.down = false;
    await alice.sdk.groups.internetBack();
    await alice.sdk.groups.settle();
    await deliverGroups(2);
    expect(await texts(bob, groupId)).toEqual(['written offline']);
  }, 60_000);

  it('posts to the internet node an announcement only the mesh took', async () => {
    alice.internet.down = true;
    const boardBefore = internetStore.getStoredAnnouncements().length;
    const reset = await alice.sdk.discussions.createSessionForContact(
      bob.sdk.userId,
      new Uint8Array(0)
    );
    expect(reset.success).toBe(true);
    let discussion = await alice.sdk.discussions.get(bob.sdk.userId);
    expect(discussion?.sendAnnouncement?.internetOnly).toBe(true);
    expect(discussion?.sendAnnouncement?.mailbox).toBeUndefined();
    expect(internetStore.getStoredAnnouncements()).toHaveLength(boardBefore);

    alice.internet.down = false;
    const messagesBefore = internetStore.getStoredMessages().size;
    await alice.sdk.announcements.processOutgoingAnnouncements([discussion!]);
    expect(internetStore.getStoredAnnouncements()).toHaveLength(
      boardBefore + 1
    );
    // the addressed copy never goes to the internet node
    expect(internetStore.getStoredMessages().size).toBe(messagesBefore);
    discussion = await alice.sdk.discussions.get(bob.sdk.userId);
    expect(discussion?.sendAnnouncement).toBeNull();
  });

  it('asks the mesh for the next messages and for addressed re-announcements', async () => {
    await bob.sdk.messages.fetch();
    const session = sessionOf(bob.sdk);
    const [next] = session.getMessageBoardReadKeys();
    const ahead = session.getMessageBoardLookaheadKeys();
    expect(ahead).toHaveLength(3);
    // the current and the previous window's mailbox of the one contact
    const mailboxes = session.getReannouncementMailboxKeys();
    expect(mailboxes).toHaveLength(2);
    // lookahead and mailbox seekers are local-only: no bridge asks the internet
    expect(bob.mesh.wanted).toEqual([next]);
    expect(bob.mesh.localWanted).toEqual([...ahead, ...mailboxes]);

    await alice.sdk.closeSession();
    expect(alice.mesh.wanted).toEqual([]);
    expect(alice.mesh.localWanted).toEqual([]);
  });

  it('accepts announcements pushed by a transport', async () => {
    const carol = await openPeer(internetStore, meshStore);
    try {
      carol.internet.down = true;
      const captured: Uint8Array[] = [];
      const announceOnMesh = meshStore.sendAnnouncement.bind(meshStore);
      meshStore.sendAnnouncement = async announcement => {
        captured.push(announcement);
        return '0';
      };
      await carol.sdk.contacts.add(bob.sdk.userId, 'Bob', bob.sdk.publicKeys);
      const contact = await carol.sdk.contacts.get(bob.sdk.userId);
      const started = await carol.sdk.discussions.start(contact!);
      expect(started.success).toBe(true);
      meshStore.sendAnnouncement = announceOnMesh;
      expect(captured.length).toBeGreaterThan(0);

      bob.internet.down = true;
      bob.mesh.down = true;
      await bob.sdk.announcements.ingestAnnouncements(captured);
      expect(await bob.sdk.discussions.get(carol.sdk.userId)).toBeDefined();
    } finally {
      await carol.sdk.destroy();
    }
  });
  it('does not bring a deleted contact back from a replayed announcement', async () => {
    const carol = await openPeer(internetStore, meshStore);
    try {
      carol.internet.down = true;
      const captured: Uint8Array[] = [];
      const announceOnMesh = meshStore.sendAnnouncement.bind(meshStore);
      meshStore.sendAnnouncement = async announcement => {
        captured.push(announcement);
        return '0';
      };
      await carol.sdk.contacts.add(bob.sdk.userId, 'Bob', bob.sdk.publicKeys);
      const contact = await carol.sdk.contacts.get(bob.sdk.userId);
      expect((await carol.sdk.discussions.start(contact!)).success).toBe(true);
      meshStore.sendAnnouncement = announceOnMesh;

      bob.internet.down = true;
      bob.mesh.down = true;
      await bob.sdk.announcements.ingestAnnouncements(captured);
      expect(await bob.sdk.contacts.get(carol.sdk.userId)).toBeDefined();
      expect((await bob.sdk.contacts.delete(carol.sdk.userId)).success).toBe(
        true
      );

      // a neighbour offers the same announcement again
      await bob.sdk.announcements.ingestAnnouncements(captured);
      await bob.sdk.announcements.fetch();
      expect(await bob.sdk.contacts.get(carol.sdk.userId)).toBeFalsy();
      expect(await bob.sdk.discussions.get(carol.sdk.userId)).toBeFalsy();
    } finally {
      await carol.sdk.destroy();
    }
  });
});
