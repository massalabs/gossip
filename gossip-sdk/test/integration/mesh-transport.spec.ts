/**
 * Messaging over two transports at once (an internet node and a mesh), with
 * the delays, reordering, duplicates and partitions a store-and-forward mesh
 * produces. Real WASM sessions; in-memory transports.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { MessageDirection, MessageStatus, MessageType } from '../../src/db';
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
import { SessionStatus } from '../../src/assets/generated/wasm/gossip_wasm';
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

  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    await this.step();
    let messages = await this.store.fetchMessages(seekers);
    if (this.duplicate) messages = messages.concat(messages);
    if (this.shuffle) messages = [...messages].sort(() => Math.random() - 0.5);
    return messages;
  }

  async sendMessage(message: EncryptedMessage): Promise<void> {
    await this.step();
    await this.store.sendMessage(message);
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    await this.step();
    return this.store.sendAnnouncement(announcement);
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    await this.step();
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

  async setWantedSeekers(seekers: Uint8Array[]): Promise<void> {
    this.wanted = seekers;
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

async function sendText(from: GossipSdk, to: GossipSdk, content: string) {
  const result = await from.messages.send({
    ownerUserId: from.userId,
    contactUserId: to.userId,
    content,
    type: MessageType.TEXT,
    direction: MessageDirection.OUTGOING,
    status: MessageStatus.WAITING_SESSION,
    timestamp: new Date(),
  });
  expect(result.success).toBe(true);
}

async function texts(owner: GossipSdk, contact: GossipSdk): Promise<string[]> {
  return (await owner.messages.getMessages(contact.userId))
    .filter(
      m =>
        m.type === MessageType.TEXT && m.direction === MessageDirection.INCOMING
    )
    .map(m => m.content);
}

/** Fetches until `count` texts arrived or the attempts run out. */
async function receive(
  owner: GossipSdk,
  contact: GossipSdk,
  count: number
): Promise<string[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await owner.messages.fetch();
    const received = await texts(owner, contact);
    if (received.length >= count) return received;
  }
  return texts(owner, contact);
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

  it('keeps the conversation going over the mesh when the internet is cut', async () => {
    alice.internet.down = true;
    bob.internet.down = true;

    await sendText(alice.sdk, bob.sdk, 'one');
    await sendText(alice.sdk, bob.sdk, 'two');
    await sendText(alice.sdk, bob.sdk, 'three');
    expect(await receive(bob.sdk, alice.sdk, 3)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(internetStore.getStoredMessages().size).toBe(0);

    // the reply over the mesh acknowledges Alice's messages
    await sendText(bob.sdk, alice.sdk, 'got them');
    expect(await receive(alice.sdk, bob.sdk, 1)).toEqual(['got them']);
    const sent = (await alice.sdk.messages.getMessages(bob.sdk.userId)).filter(
      m => m.direction === MessageDirection.OUTGOING
    );
    expect(sent.map(m => m.status)).toEqual([
      MessageStatus.DELIVERED,
      MessageStatus.DELIVERED,
      MessageStatus.DELIVERED,
    ]);
    expect(bob.sdk.discussions.getStatus(alice.sdk.userId)).toBe(
      SessionStatus.Active
    );
  });

  it('delivers each message once despite delays, duplicates and reordering', async () => {
    for (const path of [alice.internet, alice.mesh, bob.internet, bob.mesh]) {
      path.duplicate = true;
      path.shuffle = true;
      path.maxDelayMs = 5;
    }
    const sentTexts = ['a', 'b', 'c', 'd', 'e'];
    for (const text of sentTexts) await sendText(alice.sdk, bob.sdk, text);

    expect(await receive(bob.sdk, alice.sdk, sentTexts.length)).toEqual(
      sentTexts
    );
    expect(bob.sdk.discussions.getStatus(alice.sdk.userId)).toBe(
      SessionStatus.Active
    );
  });

  it('switches between transports as partitions come and go', async () => {
    alice.mesh.down = true;
    await sendText(alice.sdk, bob.sdk, 'over the internet');
    alice.mesh.down = false;
    alice.internet.down = true;
    await sendText(alice.sdk, bob.sdk, 'over the mesh');

    // Bob only reaches the internet first, then only the mesh
    bob.mesh.down = true;
    expect(await receive(bob.sdk, alice.sdk, 2)).toEqual(['over the internet']);
    bob.mesh.down = false;
    bob.internet.down = true;
    expect(await receive(bob.sdk, alice.sdk, 2)).toEqual([
      'over the internet',
      'over the mesh',
    ]);
  });

  it('reads pushed messages that arrive before their predecessors', async () => {
    // Alice reaches neither store: capture what she sends instead
    const captured: EncryptedMessage[] = [];
    alice.internet.down = true;
    const sendOnMesh = meshStore.sendMessage.bind(meshStore);
    meshStore.sendMessage = async message => {
      captured.push(message);
    };
    await sendText(alice.sdk, bob.sdk, 'first');
    await sendText(alice.sdk, bob.sdk, 'second');
    await sendText(alice.sdk, bob.sdk, 'third');
    meshStore.sendMessage = sendOnMesh;
    expect(captured).toHaveLength(3);

    bob.internet.down = true;
    bob.mesh.down = true;
    await bob.sdk.messages.ingestMessages([captured[2]]);
    await bob.sdk.messages.ingestMessages([captured[1], captured[1]]);
    expect(await texts(bob.sdk, alice.sdk)).toEqual([]);
    await bob.sdk.messages.ingestMessages([captured[0]]);
    expect(await receive(bob.sdk, alice.sdk, 3)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('ignores junk posted at a seeker instead of closing the session', async () => {
    const [seeker] = sessionOf(bob.sdk).getMessageBoardReadKeys();
    await bob.sdk.messages.ingestMessages([
      { seeker, ciphertext: new Uint8Array([1, 2, 3]) },
    ]);
    await bob.sdk.messages.fetch();
    expect(bob.sdk.discussions.getStatus(alice.sdk.userId)).toBe(
      SessionStatus.Active
    );

    await sendText(alice.sdk, bob.sdk, 'still here');
    expect(await receive(bob.sdk, alice.sdk, 1)).toEqual(['still here']);
  });

  it('asks the mesh for the next message and the ones likely to follow', async () => {
    await bob.sdk.messages.fetch();
    const session = sessionOf(bob.sdk);
    const [next] = session.getMessageBoardReadKeys();
    const ahead = session.getMessageBoardLookaheadKeys();
    expect(ahead).toHaveLength(3);
    expect(bob.mesh.wanted).toEqual([next, ...ahead]);

    await alice.sdk.closeSession();
    expect(alice.mesh.wanted).toEqual([]);
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
});
