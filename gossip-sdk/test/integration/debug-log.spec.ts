/**
 * The debug log of the full debug build follows one message across two
 * devices: with a recording sink, a message sent by Bob and read by Alice
 * gives the expected events in order, and the short IDs that link the two
 * devices' lines match. Without a sink nothing is recorded. Two in-process
 * SDKs over an in-memory transport; no backend is used.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import { generateEncryptionKey } from '../../src/wasm/encryption';
import { getTestStorageConfig } from '../testDb';
import { setDebugLogSink } from '../../src/utils/debugLog';

type Line = {
  src: string;
  ev: string;
  lvl: string;
  dur?: number;
  f?: Record<string, unknown>;
};

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
  (
    sdk as unknown as { _announcement: { now: () => number } }
  )._announcement.now = () => clock;
  await sdk.conversations.settle();
  return sdk;
}

describe('Debug log of a message', { timeout: 300_000 }, () => {
  let peers: GossipSdk[] = [];

  beforeAll(async () => {
    await ensureWasmInitialized();
  });

  afterEach(async () => {
    setDebugLogSink(null);
    for (const p of peers) await p.closeSession();
    peers = [];
  });

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

  async function chatOfTwo(): Promise<[GossipSdk, GossipSdk, string]> {
    const net = new MockMessageProtocol();
    const alice = await openPeer(net);
    const bob = await openPeer(net);
    peers = [alice, bob];
    await setupSession(alice, bob, 'Bob', 'Alice', 'hello', {
      asNewContact: true,
    });
    await deliver();
    // Adding a contact starts no chat (§5.12): Alice starts it, Bob accepts.
    const groupId = await alice.conversations.startDirectChat(bob.userId);
    await deliver();
    await bob.conversations.acceptInvitation(groupId);
    await deliver();
    expect((await alice.groups.list()).map(g => g.groupId)).toContain(groupId);
    // What was shown before is not the message followed here.
    await alice.groups.timeline(groupId);
    return [alice, bob, groupId];
  }

  it('records each step of a sent-then-received message, linked across devices', async () => {
    const [alice, bob, groupId] = await chatOfTwo();

    const lines: Line[] = [];
    setDebugLogSink(line => lines.push(line));

    const published = await bob.groups.sendMessage(groupId, 'hi');
    await deliver();
    const shownTexts = (await alice.groups.timeline(groupId)).flatMap(i =>
      i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
    );
    expect(shownTexts).toContain('hi');

    const id = published.syncObjId.slice(0, 8);
    const evs = lines.map(l => l.ev);
    const at = (ev: string, pred: (l: Line) => boolean = () => true) =>
      lines.findIndex(l => l.ev === ev && pred(l));

    const created = at('message.created', l => l.f?.id === id);
    expect(created).toBeGreaterThanOrEqual(0);
    expect(lines[created].f?.c).toMatchObject({ body: expect.any(String) });
    // The text is content, never an ordinary field.
    expect(JSON.stringify({ ...lines[created].f, c: undefined })).not.toContain(
      'hi"'
    );

    // Bob's packet carrying the message, and Alice's receipt of the same.
    const out = at('engine.plaintext.out', l => (l.f?.size as number) > 0);
    const pt = lines[out].f?.pt;
    const encrypted = at('message.encrypted', l => l.f?.pt === pt);
    const seeker = lines[encrypted].f?.seeker;
    const queued = at('message.queued', l => l.f?.seeker === seeker);
    const sent = at('message.sent', l => l.f?.seeker === seeker);
    const received = at('message.received', l => l.f?.seeker === seeker);
    const decrypted = at('message.decrypted', l => l.f?.seeker === seeker);
    const handed = at('engine.plaintext.in', l => l.f?.pt === pt);
    const shown = at('message.shown', l => l.f?.id === id);

    const order = [
      created,
      out,
      encrypted,
      queued,
      sent,
      received,
      decrypted,
      handed,
      shown,
    ];
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(evs).toContain('engine.op');
    expect(lines[sent].dur).toEqual(expect.any(Number));
    // A single transport is taken as the backend: the send resolved there,
    // so the row was deleted rather than kept for a later post.
    expect(lines[sent].f?.by).toEqual(['internet']);
    expect(evs).not.toContain('message.mesh_only');
    expect(lines[shown].f?.mine).toBe(false);
  });

  it('records nothing without a sink', async () => {
    const [, bob, groupId] = await chatOfTwo();
    const lines: Line[] = [];
    setDebugLogSink(line => lines.push(line));
    setDebugLogSink(null);
    await bob.groups.sendMessage(groupId, 'quiet');
    await deliver(2);
    expect(lines).toEqual([]);
  });
});
