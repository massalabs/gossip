/**
 * Group chats over the mesh while the backend fails slowly or hangs.
 *
 * Every SDK runs `CompositeMessageProtocol(rest, mesh)`. The REST member is
 * the real `RestMessageProtocol` (its retries and timeouts included) over a
 * fake `fetch`: a refused connection fails a call after about 8 s, a network
 * that swallows requests after about 36 s, as measured on a phone. A third
 * variant never answers at all. The mesh member is an in-memory loopback.
 *
 * Time is virtual (fake timers): latencies are measured in virtual
 * milliseconds and must be bounded by the mesh, not by the backend.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import { MockMessageProtocol } from '../mocks';
import { setupSession } from '../utils';
import { GossipSdk } from '../../src/gossip';
import { ensureWasmInitialized } from '../../src/wasm/loader';
import { generateMnemonic } from '../../src/crypto/bip39';
import {
  encryptionKeyFromBytes,
  generateEncryptionKey,
} from '../../src/wasm/encryption';
import { CompositeMessageProtocol } from '../../src/api/messageProtocol/composite';
import { RestMessageProtocol } from '../../src/api/messageProtocol/rest';
import type {
  BulletinItem,
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
} from '../../src/api/messageProtocol/types';
import type { GroupService } from '../../src/services/groups';
import type { Queries } from '../../src/db/queries';
import type { GroupOutboxRow } from '../../src/db/queries/groups';
import * as schema from '../../src/db/schema';
import { eq } from 'drizzle-orm';
import { NETWORK_RETENTION_MS } from '../../src/config/protocol';
import { encodeToBase64 } from '../../src/utils/base64';
import { getTestStorageConfig } from '../testDb';

type RestMode = 'up' | 'refused' | 'timeout' | 'silent';

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/**
 * The backend's HTTP contract over a shared store, as a `fetch` stand-in:
 * first writer wins at a seeker (409 for another value, 200 for the same).
 * Each peer reaches it under its own path, so each has its own failure mode.
 */
class FakeBackend {
  readonly messages = new Map<string, string>();
  readonly bulletin: { counter: string; data: string }[] = [];
  /** Accepted posts, by seeker. */
  readonly posts = new Map<string, number>();
  readonly modes = new Map<string, RestMode>();
  /** Requests that reached the fake, by peer. */
  readonly requests = new Map<string, number>();
  /** Requests being failed slowly now. */
  inflight = 0;

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(String(input));
    const [, peer, , ...rest] = url.pathname.split('/');
    this.requests.set(peer, (this.requests.get(peer) ?? 0) + 1);
    const mode = this.modes.get(peer) ?? 'up';
    const signal = init?.signal;
    if (mode === 'refused') {
      // no route: each attempt fails after a short while
      this.inflight++;
      await new Promise(r => setTimeout(r, 667));
      this.inflight--;
      throw new TypeError('fetch failed');
    }
    if (mode === 'timeout' || mode === 'silent') {
      // the request is swallowed: only the client's own timeout ends it
      return new Promise<Response>((_, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        );
      });
    }
    return this.answer(rest.join('/'), url, init);
  };

  private answer(path: string, url: URL, init?: RequestInit): Response {
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === 'messages/' || path === 'messages') {
      const held = this.messages.get(body.key);
      if (held !== undefined && held !== body.value) {
        return json(409, { error: 'seeker taken' });
      }
      this.messages.set(body.key, body.value);
      this.posts.set(body.key, (this.posts.get(body.key) ?? 0) + 1);
      return json(200, {});
    }
    if (path === 'messages/fetch') {
      return json(
        200,
        (body.seekers as string[]).flatMap(key => {
          const value = this.messages.get(key);
          return value === undefined ? [] : [{ key, value }];
        })
      );
    }
    if (path === 'bulletin/counter') {
      return json(200, { counter: String(this.bulletin.length) });
    }
    if (path === 'bulletin' && init?.method === 'POST') {
      const counter = String(this.bulletin.length + 1);
      this.bulletin.push({ counter, data: body.data });
      return json(200, { counter });
    }
    if (path === 'bulletin') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      return json(
        200,
        this.bulletin.filter(i => Number(i.counter) > after).slice(0, limit)
      );
    }
    return json(404, {});
  }
}

/** A backend that never answers and never fails: a call stays pending. */
class SilentProtocol implements IMessageProtocol {
  silent = false;
  constructor(private readonly inner: IMessageProtocol) {}
  private gate<T>(op: () => Promise<T>): Promise<T> {
    return this.silent ? new Promise<T>(() => {}) : op();
  }
  fetchMessages(seekers: Uint8Array[]) {
    return this.gate(() => this.inner.fetchMessages(seekers));
  }
  sendMessage(message: EncryptedMessage) {
    return this.gate(() => this.inner.sendMessage(message));
  }
  sendAnnouncement(announcement: Uint8Array) {
    return this.gate(() => this.inner.sendAnnouncement(announcement));
  }
  fetchAnnouncements(limit?: number, cursor?: string) {
    return this.gate(() => this.inner.fetchAnnouncements(limit, cursor));
  }
  fetchBulletinCounter() {
    return this.gate(() => this.inner.fetchBulletinCounter());
  }
  changeNode(): Promise<MessageProtocolResponse> {
    return Promise.resolve({ success: true });
  }
}

/** The mesh: one shared in-memory store, reached at once. */
class LoopbackMesh implements IMessageProtocol {
  wanted: Uint8Array[] = [];
  localWanted: Uint8Array[] = [];
  /** Every fetch: the seekers asked, and the wanted list at that moment. */
  readonly fetches: { asked: string[]; wanted: string[] }[] = [];
  constructor(private readonly store: MockMessageProtocol) {}
  isMeshEnabled(): boolean {
    return true;
  }
  fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    this.fetches.push({
      asked: seekers.map(b64),
      wanted: this.wanted.map(b64),
    });
    return this.store.fetchMessages(seekers);
  }
  sendMessage(message: EncryptedMessage): Promise<void> {
    return this.store.sendMessage(message);
  }
  sendAnnouncement(announcement: Uint8Array): Promise<string> {
    return this.store.sendAnnouncement(announcement);
  }
  fetchAnnouncements(limit?: number, cursor?: string): Promise<BulletinItem[]> {
    return this.store.fetchAnnouncements(limit, cursor);
  }
  fetchBulletinCounter(): Promise<string> {
    return this.store.fetchBulletinCounter();
  }
  changeNode(): Promise<MessageProtocolResponse> {
    return Promise.resolve({ success: true });
  }
  async setWantedSeekers(
    seekers: Uint8Array[],
    localSeekers: Uint8Array[] = []
  ): Promise<void> {
    this.wanted = seekers;
    this.localWanted = localSeekers;
  }
}

interface Peer {
  name: string;
  sdk: GossipSdk;
  mesh: LoopbackMesh | null;
  silent: SilentProtocol;
  mnemonic: string;
  key: Uint8Array;
}

/**
 * Runs `op` under fake timers, moving virtual time on in 10 ms steps while
 * it waits; real I/O is given a few turns of the event loop before each
 * step so that it does not count as waiting. Returns the virtual time spent.
 */
async function timed<T>(
  op: () => Promise<T>,
  capMs = 300_000
): Promise<{ value: T; ms: number }> {
  const start = Date.now();
  let done = false;
  let value: T | undefined;
  let failure: unknown;
  let failed = false;
  op().then(
    v => {
      done = true;
      value = v;
    },
    e => {
      done = true;
      failed = true;
      failure = e;
    }
  );
  while (!done) {
    for (let i = 0; i < 8 && !done; i++) {
      await new Promise(r => setImmediate(r));
    }
    if (done) break;
    if (Date.now() - start > capMs) {
      throw new Error(`still waiting after ${capMs} ms of virtual time`);
    }
    await vi.advanceTimersByTimeAsync(10);
  }
  if (failed) throw failure;
  return { value: value as T, ms: Date.now() - start };
}

async function texts(groups: GroupService, groupId: string): Promise<string[]> {
  return (await groups.timeline(groupId)).flatMap(i =>
    i.kind === 'message' && i.body.type === 'text' ? [i.body.text] : []
  );
}

describe(
  'Group chats over the mesh while the backend is slow',
  {
    timeout: 600_000,
  },
  () => {
    let backend: FakeBackend;
    let meshStore: MockMessageProtocol;
    let peers: Peer[];

    beforeAll(async () => {
      await ensureWasmInitialized();
    });

    beforeEach(() => {
      backend = new FakeBackend();
      vi.stubGlobal('fetch', backend.fetch);
      meshStore = new MockMessageProtocol();
      peers = [];
    });

    afterEach(async () => {
      vi.useRealTimers();
      for (const p of peers) await p.sdk.destroy().catch(() => undefined);
      vi.unstubAllGlobals();
    });

    /** A peer with REST and, unless `restOnly`, the loopback mesh. */
    async function openPeer(name: string, restOnly = false): Promise<Peer> {
      const rest = new RestMessageProtocol(`http://backend.test/${name}/api`);
      const silent = new SilentProtocol(rest);
      const mesh = restOnly ? null : new LoopbackMesh(meshStore);
      const sdk = new GossipSdk();
      await sdk.init({
        storage: getTestStorageConfig(),
        messageProtocol: mesh
          ? new CompositeMessageProtocol(
              { protocol: silent, kind: 'internet' },
              [{ protocol: mesh, kind: 'mesh' }]
            )
          : silent,
      });
      const mnemonic = generateMnemonic();
      const encryptionKey = await generateEncryptionKey();
      await sdk.openSession({
        mnemonic,
        encryptionKey,
        onPersist: async () => {},
        autoStartPolling: false,
        publishPublicKey: false,
      });
      const peer = {
        name,
        sdk,
        mesh,
        silent,
        mnemonic,
        key: encryptionKey.to_bytes(),
      };
      peers.push(peer);
      return peer;
    }

    /** `p` closed and opened again on its own database, as after a reload. */
    /**
     * With `between`, run while `p` is closed (locked). `asApp` opens it as
     * the app does, without the tests' opt-out of background work (polling
     * stays off, as by default).
     */
    async function reload(
      p: Peer,
      between?: () => Promise<void>,
      asApp = false
    ): Promise<void> {
      const encryptedSession = p.sdk.getEncryptedSession();
      await p.sdk.closeSession();
      await between?.();
      await p.sdk.openSession({
        mnemonic: p.mnemonic,
        encryptedSession,
        encryptionKey: await encryptionKeyFromBytes(p.key),
        onPersist: async () => {},
        ...(asApp ? {} : { autoStartPolling: false }),
        publishPublicKey: false,
      });
    }

    /** Fetches on every SDK until nothing new arrives (backend up). */
    async function deliver(rounds = 6) {
      for (let r = 0; r < rounds; r++) {
        for (const p of peers) {
          await p.sdk.groups.tick();
          await p.sdk.groups.settle();
          await p.sdk.messages.fetch();
          await p.sdk.groups.settle();
        }
      }
    }

    /** Sessions between every pair, then a group of all, every member in. */
    async function group(members: Peer[]): Promise<string> {
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          await setupSession(
            members[i].sdk,
            members[j].sdk,
            members[j].name,
            members[i].name
          );
        }
      }
      const [owner, ...invited] = members;
      const groupId = await owner.sdk.groups.createGroup(
        'Field',
        invited.map(p => p.sdk.userId)
      );
      await deliver();
      for (const p of invited) {
        const [inv] = await p.sdk.groups.invitations();
        expect(await p.sdk.groups.acceptInvitation(inv.epochId)).toBe(groupId);
      }
      await deliver();
      for (const p of members) {
        expect((await p.sdk.groups.get(groupId))?.status).toBe('member');
      }
      return groupId;
    }

    function backendDown(mode: RestMode) {
      for (const p of peers) {
        if (mode === 'silent') p.silent.silent = true;
        else backend.modes.set(p.name, mode);
      }
    }

    /**
     * Sends 10 messages each way between the first two members over the mesh
     * alone, every member reading them; returns the longest latencies seen.
     */
    async function exchange(
      groupId: string,
      members: Peer[]
    ): Promise<{ send: number; receive: number }> {
      const [a, b] = members;
      let send = 0;
      let receive = 0;
      const sent: string[] = [];
      for (let i = 0; i < 10; i++) {
        for (const [from, text] of [
          [a, `${a.name} ${i}`],
          [b, `${b.name} ${i}`],
        ] as const) {
          const s = await timed(async () => {
            await from.sdk.groups.sendMessage(groupId, text);
            await from.sdk.groups.settle();
          });
          send = Math.max(send, s.ms);
          sent.push(text);
          for (const to of members) {
            if (to === from) continue;
            const r = await timed(async () => {
              for (let round = 0; round < 20; round++) {
                await to.sdk.messages.fetch();
                await to.sdk.groups.settle();
                if ((await texts(to.sdk.groups, groupId)).includes(text))
                  return;
              }
              throw new Error(`${to.name} never got "${text}"`);
            });
            receive = Math.max(receive, r.ms);
          }
        }
      }
      for (const p of members) {
        expect(await texts(p.sdk.groups, groupId)).toEqual(sent);
      }
      return { send, receive };
    }

    for (const mode of ['refused', 'timeout', 'silent'] as const) {
      for (const size of [2, 3]) {
        it(`delivers a chat of ${size} at mesh speed while the backend is ${mode}`, async () => {
          const members: Peer[] = [];
          for (const name of ['alice', 'bob', 'carol'].slice(0, size)) {
            members.push(await openPeer(name));
          }
          const groupId = await group(members);

          backendDown(mode);
          vi.useFakeTimers({
            toFake: [
              'setTimeout',
              'clearTimeout',
              'setInterval',
              'clearInterval',
              'Date',
            ],
          });
          const { send, receive } = await exchange(groupId, members);
          console.info(
            `[latency] ${mode}, chat of ${size}: send ${send} ms, receive ${receive} ms (virtual)`
          );
          // The backend takes 8 s (refused) or 36 s (timeout) to fail, or never
          // answers (silent): the mesh path must not wait for it.
          expect(send).toBeLessThan(2_000);
          expect(receive).toBeLessThan(3_000);
        });
      }
    }

    const eqId = (id: number) => eq(schema.groupOutbox.id, id);

    /** The group service's parts these tests reach into. */
    interface GroupInternals {
      queries: Queries;
      owner: string;
      node: { published: (handle: number, now: number) => void } | null;
      reposting: Promise<void> | null;
      seekerConflicts?: { handle: (contactUserId: string) => Promise<boolean> };
    }
    const internalsOf = (p: Peer) => p.sdk.groups as unknown as GroupInternals;

    /** Every outbox row of `p`, due or not. */
    async function outbox(p: Peer): Promise<GroupOutboxRow[]> {
      const g = internalsOf(p);
      return g.queries.groups.dueOutbox(g.owner, new Date(8.64e15));
    }

    /** Records the handles `p`'s engine is told were published. */
    function spyPublished(p: Peer): number[] {
      const node = internalsOf(p).node!;
      const published = node.published.bind(node);
      const calls: number[] = [];
      node.published = (handle, now) => {
        calls.push(handle);
        published(handle, now);
      };
      return calls;
    }

    /**
     * Lets the requests of the backend's client end (three attempts, 2 s and
     * 4 s apart), so that none started before reaches the backend once it is
     * back.
     */
    async function quiet(): Promise<void> {
      await timed(async () => {
        let idle = 0;
        while (idle < 5_000) {
          await vi.advanceTimersByTimeAsync(100);
          idle = backend.inflight > 0 ? 0 : idle + 100;
        }
      });
    }

    /** The network came back for `p`: the backend is asked, posts follow. */
    async function networkBack(p: Peer): Promise<void> {
      p.sdk.networkChanged();
      await p.sdk.groups.networkChanged();
      await internalsOf(p).reposting;
    }

    it('posts to the backend what only the mesh took, once, across a restart', async () => {
      const alice = await openPeer('alice');
      const bob = await openPeer('bob');
      // Carol has no mesh: she reads the backend alone.
      const carol = await openPeer('carol', true);
      const groupId = await group([alice, bob, carol]);

      backend.modes.set('alice', 'refused');
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      const published = spyPublished(alice);
      const texts5 = [0, 1, 2, 3, 4].map(i => `offline ${i}`);
      for (const text of texts5) {
        const { ms } = await timed(async () => {
          await alice.sdk.groups.sendMessage(groupId, text);
          await alice.sdk.groups.settle();
        });
        expect(ms).toBeLessThan(2_000);
        await timed(() => vi.advanceTimersByTimeAsync(1_000));
      }
      // the backend's 8 s failures come in, in the background
      await quiet();

      // Bob has them over the mesh; Carol has nothing yet.
      await timed(async () => {
        for (let r = 0; r < 5; r++) {
          await bob.sdk.messages.fetch();
          await bob.sdk.groups.settle();
        }
      });
      expect(await texts(bob.sdk.groups, groupId)).toEqual(texts5);
      await timed(async () => {
        await carol.sdk.messages.fetch();
        await carol.sdk.groups.settle();
      });
      expect(await texts(carol.sdk.groups, groupId)).toEqual([]);

      // Every ciphertext is kept, marked as taken by the mesh only; each was
      // published once, when the mesh took it.
      const kept = await outbox(alice);
      expect(kept.length).toBeGreaterThanOrEqual(texts5.length * 2);
      expect(kept.every(row => row.meshOnlySince !== null)).toBe(true);
      expect(new Set(published).size).toBe(published.length);
      expect(published.length).toBe(kept.length);
      const seekers = kept.map(row => encodeToBase64(row.seeker));
      for (const seeker of seekers)
        expect(backend.posts.get(seeker)).toBe(undefined);

      // Alice restarts while the backend is still out of reach: the mark is
      // in her database.
      await timed(() => reload(alice));
      await quiet();
      const afterRestart = await outbox(alice);
      expect(afterRestart.map(r => r.id)).toEqual(kept.map(r => r.id));
      expect(afterRestart.every(r => r.meshOnlySince !== null)).toBe(true);
      const publishedAgain = spyPublished(alice);

      // The internet returns: each is posted once, then deleted.
      backend.modes.set('alice', 'up');
      await timed(() => networkBack(alice));
      expect(await outbox(alice)).toEqual([]);
      for (const seeker of seekers) expect(backend.posts.get(seeker)).toBe(1);
      expect(publishedAgain).toEqual([]);

      // Carol, who reads the backend alone, now gets the whole chain.
      await timed(async () => {
        for (let r = 0; r < 5; r++) {
          await carol.sdk.messages.fetch();
          await carol.sdk.groups.settle();
        }
      });
      expect(await texts(carol.sdk.groups, groupId)).toEqual(texts5);

      // Nothing is posted twice later on.
      await timed(async () => {
        await alice.sdk.groups.tick();
        await alice.sdk.groups.settle();
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await alice.sdk.groups.settle();
        await internalsOf(alice).reposting;
      });
      for (const seeker of seekers) expect(backend.posts.get(seeker)).toBe(1);
    });

    it('drops what the mesh took past the retention, and renews on a 409', async () => {
      const alice = await openPeer('alice');
      const bob = await openPeer('bob');
      const groupId = await group([alice, bob]);

      backend.modes.set('alice', 'refused');
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      for (const text of ['one', 'two']) {
        await timed(async () => {
          await alice.sdk.groups.sendMessage(groupId, text);
          await alice.sdk.groups.settle();
        });
      }
      await quiet();
      const [old, taken] = await outbox(alice);
      expect(old?.meshOnlySince).not.toBeNull();
      expect(taken?.meshOnlySince).not.toBeNull();

      // One was taken by the mesh longer ago than the network keeps a message;
      // the backend holds another value at the other's seeker.
      const g = internalsOf(alice);
      await g.queries.conn.db
        .update(schema.groupOutbox)
        .set({ meshOnlySince: new Date(Date.now() - NETWORK_RETENTION_MS - 1) })
        .where(eqId(old.id));
      backend.messages.set(encodeToBase64(taken.seeker), 'b3RoZXI=');
      const renewed: string[] = [];
      const conflicts = g.seekerConflicts!;
      const handle = conflicts.handle.bind(conflicts);
      conflicts.handle = contact => {
        renewed.push(contact);
        return handle(contact);
      };

      backend.modes.set('alice', 'up');
      await timed(() => networkBack(alice));
      const rest = (await outbox(alice)).map(r => r.id);
      expect(rest).not.toContain(old.id);
      expect(rest).not.toContain(taken.id);
      // the old one was not posted; the taken one renewed the session
      expect(backend.posts.get(encodeToBase64(old.seeker))).toBe(undefined);
      expect(renewed).toEqual([bob.sdk.userId]);
    });

    it('gives the mesh the next seeker as soon as a message is read', async () => {
      const alice = await openPeer('alice');
      const bob = await openPeer('bob');
      const groupId = await group([alice, bob]);
      // The backend answers: this is about when the mesh hears of the seeker.
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      await timed(async () => {
        await alice.sdk.groups.sendMessage(groupId, 'ping');
        await alice.sdk.groups.settle();
      });
      const mesh = bob.mesh!;
      mesh.fetches.length = 0;
      await timed(() => bob.sdk.messages.fetch());
      expect(await texts(bob.sdk.groups, groupId)).toEqual(['ping']);
      // The fetch read Alice's message, then asked for the next seeker: by
      // then the mesh node already waited on it, before the fetch ended.
      const first = mesh.fetches[0];
      const next = mesh.fetches.find(f =>
        f.asked.some(seeker => !first.asked.includes(seeker))
      );
      expect(next).toBeDefined();
      expect(next!.wanted).toEqual(next!.asked);
    });

    it('reads at login what the mesh node took before it was asked for it', async () => {
      const alice = await openPeer('alice');
      const bob = await openPeer('bob');
      const groupId = await group([alice, bob]);
      backendDown('silent');
      vi.useFakeTimers({
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'Date',
        ],
      });
      // Bob is locked (his wanted list is empty) while Alice writes: the node
      // holds the blob but, like the real node, never pushes a blob stored
      // before its seeker was wanted (LoopbackMesh pushes nothing at all).
      // Bob unlocks; nothing else asks for a fetch.
      await timed(() =>
        reload(
          bob,
          async () => {
            await alice.sdk.groups.sendMessage(groupId, 'while you were away');
            await alice.sdk.groups.settle();
          },
          true
        )
      );
      const { ms } = await timed(async () => {
        while ((await texts(bob.sdk.groups, groupId)).length === 0) {
          await vi.advanceTimersByTimeAsync(100);
        }
      }, 60_000);
      expect(await texts(bob.sdk.groups, groupId)).toEqual([
        'while you were away',
      ]);
      expect(ms).toBeLessThan(3_000);
    });
  }
);
