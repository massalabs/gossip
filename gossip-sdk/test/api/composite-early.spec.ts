/**
 * The composite transport while the backend is slow, failing or paused: a
 * send is done when one transport took it, a fetch does not wait for a slow
 * one, and after a network failure the backend is skipped for a while (only
 * while a mesh is on).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BACKEND_PAUSE_FIRST_MS,
  BACKEND_PAUSE_MAX_MS,
  CompositeMessageProtocol,
  FETCH_GRACE_MS,
} from '../../src/api/messageProtocol/composite';
import type {
  EncryptedMessage,
  IMessageProtocol,
} from '../../src/api/messageProtocol/types';
import { MockMessageProtocol } from '../mocks';
import {
  BackendPausedError,
  HttpStatusError,
  NetworkError,
  TransportsFailedError,
  isFinalSendError,
  isSeekerConflict,
} from '../../src/api/errors';

const bytes = (...values: number[]) => new Uint8Array(values);
const msg = (seeker: number, value = 9): EncryptedMessage => ({
  seeker: bytes(seeker),
  ciphertext: bytes(value),
});

/** A transport whose calls wait for the test to settle them. */
class ManualProtocol extends MockMessageProtocol {
  calls: string[] = [];
  private gates: {
    op: string;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  /** Fails every call at once with this, when set. */
  failWith: unknown = null;
  /** Holds every call until `release`/`fail`. */
  manual = false;

  isMeshEnabled?: () => boolean;

  private gate<T>(op: string, run: () => Promise<T>): Promise<T> {
    this.calls.push(op);
    if (this.failWith !== null) return Promise.reject(this.failWith);
    if (!this.manual) return run();
    return new Promise<void>((resolve, reject) => {
      this.gates.push({ op, resolve, reject });
    }).then(run);
  }
  release(): void {
    for (const g of this.gates.splice(0)) g.resolve();
  }
  fail(error: unknown): void {
    for (const g of this.gates.splice(0)) g.reject(error);
  }
  override fetchMessages(seekers: Uint8Array[]) {
    return this.gate('fetch', () => super.fetchMessages(seekers));
  }
  override sendMessage(message: EncryptedMessage) {
    return this.gate('send', () => super.sendMessage(message));
  }
  override sendAnnouncement(announcement: Uint8Array) {
    return this.gate('announce', () => super.sendAnnouncement(announcement));
  }
  override fetchAnnouncements(limit?: number, cursor?: string) {
    return this.gate('board', () => super.fetchAnnouncements(limit, cursor));
  }
}

function composite(internet: IMessageProtocol, mesh: IMessageProtocol) {
  return new CompositeMessageProtocol(
    { protocol: internet, kind: 'internet' },
    [{ protocol: mesh, kind: 'mesh' }]
  );
}

/** Lets pending promise callbacks run. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('CompositeMessageProtocol with a slow or failing backend', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'Date'],
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    // a rejection nobody handled is reported after a turn of the loop
    await new Promise(r => setTimeout(r, 0));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it('resolves a send as soon as one transport took it', async () => {
    const internet = new ManualProtocol();
    internet.manual = true;
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);

    const outcome = await protocol.sendMessageTracked(msg(1));
    expect(outcome.acceptedBy).toEqual(['mesh']);
    let settled = false;
    void outcome.settled.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);

    internet.release();
    expect(await outcome.settled).toEqual({
      acceptedBy: ['internet', 'mesh'],
      failures: [],
    });
    expect(internet.getStoredMessages().size).toBe(1);
  });

  it('reports a 409 that comes after the mesh took the send', async () => {
    const internet = new ManualProtocol();
    internet.manual = true;
    const protocol = composite(internet, new MockMessageProtocol());

    const outcome = await protocol.sendMessageTracked(msg(1));
    expect(outcome.acceptedBy).toEqual(['mesh']);
    internet.fail(new HttpStatusError(409, 'Conflict'));
    const settled = await outcome.settled;
    expect(settled.acceptedBy).toEqual(['mesh']);
    expect(settled.failures).toHaveLength(1);
    expect(settled.failures[0].kind).toBe('internet');
    expect(isSeekerConflict(settled.failures[0].error)).toBe(true);
  });

  it('waits for the other transport when the first to answer failed', async () => {
    const internet = new ManualProtocol();
    internet.manual = true;
    const mesh = new ManualProtocol();
    mesh.failWith = new Error('node stopped');
    const protocol = composite(internet, mesh);

    let resolved = false;
    const sending = protocol.sendMessageTracked(msg(1)).then(o => {
      resolved = true;
      return o;
    });
    await flush();
    expect(resolved).toBe(false);
    internet.release();
    expect((await sending).acceptedBy).toEqual(['internet']);
  });

  it('reports both reasons when both transports refuse a send', async () => {
    const internet = new ManualProtocol();
    internet.failWith = new HttpStatusError(503, 'Service Unavailable');
    const mesh = new ManualProtocol();
    mesh.failWith = new Error('blob refused: rejected: PoolFull');
    const error = await composite(internet, mesh)
      .sendMessage(msg(1))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportsFailedError);
    expect((error as Error).message).toBe(
      'internet: HTTP 503: Service Unavailable; mesh: blob refused: rejected: PoolFull'
    );
    expect(isFinalSendError(error)).toBe(false);
    expect(isSeekerConflict(error)).toBe(false);
  });

  it('classifies a mesh refusal like a backend one', () => {
    const failed = (internet: unknown, mesh: unknown) =>
      new TransportsFailedError([
        { kind: 'internet', error: internet },
        { kind: 'mesh', error: mesh },
      ]);
    const http = (s: number) => new HttpStatusError(s, 'x');
    const taken = new Error('reason=rejected: KeyTaken');
    const invalid = new Error('blob refused: rejected: payload too large');
    const full = new Error('blob refused: rejected: PoolFull');
    const offline = new NetworkError('fetch failed');

    // a server's 409 is a conflict whatever the mesh said, as before
    expect(isSeekerConflict(failed(http(409), full))).toBe(true);
    // the mesh's taken seeker only when no transport may take it later
    expect(isSeekerConflict(failed(http(400), taken))).toBe(true);
    expect(isSeekerConflict(failed(offline, taken))).toBe(false);
    // final only if both refused for good
    expect(isFinalSendError(failed(http(400), invalid))).toBe(true);
    expect(isFinalSendError(failed(http(400), full))).toBe(false);
    expect(isFinalSendError(failed(offline, invalid))).toBe(false);
    expect(isFinalSendError(failed(http(429), invalid))).toBe(false);
    expect(
      isFinalSendError(
        failed(new BackendPausedError(), { code: 'INVALID_ARGUMENT' })
      )
    ).toBe(false);
  });

  it('never rejects unhandled when a transport fails after the send resolved', async () => {
    const internet = new ManualProtocol();
    internet.manual = true;
    const protocol = composite(internet, new MockMessageProtocol());
    // the caller ignores `settled`
    await protocol.sendMessage(msg(1));
    internet.fail(new NetworkError('fetch failed'));
    await flush();
    // checked in afterEach: no unhandled rejection
  });

  it('pauses the backend after a network failure, longer each time', async () => {
    const internet = new ManualProtocol();
    const mesh = new MockMessageProtocol();
    const protocol = composite(internet, mesh);

    internet.failWith = new NetworkError('fetch failed');
    await protocol.sendMessage(msg(1));
    await flush();
    expect(protocol.isBackendPaused()).toBe(true);
    expect(protocol.getConnectivity()).toBe('mesh-only');

    // paused: neither sends nor fetches ask the backend
    internet.calls = [];
    const outcome = await protocol.sendMessageTracked(msg(2));
    expect(outcome.acceptedBy).toEqual(['mesh']);
    expect((await outcome.settled).failures[0].error).toBeInstanceOf(
      BackendPausedError
    );
    expect(await protocol.fetchMessages([bytes(2)])).toHaveLength(1);
    await expect(
      protocol.sendMessage(msg(3), { internetOnly: true })
    ).rejects.toBeInstanceOf(BackendPausedError);
    expect(internet.calls).toEqual([]);

    // the pause doubles at each failure, up to its longest
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const start = Date.now();
      while (protocol.isBackendPaused())
        await vi.advanceTimersByTimeAsync(1000);
      pauses.push(Date.now() - start);
      await protocol.sendMessage(msg(10 + i));
      await flush();
    }
    // the first was measured from the first failure, at the start of the test
    expect(pauses).toEqual([
      BACKEND_PAUSE_FIRST_MS,
      BACKEND_PAUSE_FIRST_MS * 2,
      BACKEND_PAUSE_FIRST_MS * 4,
      BACKEND_PAUSE_FIRST_MS * 8,
      BACKEND_PAUSE_MAX_MS,
      BACKEND_PAUSE_MAX_MS,
    ]);
  });

  it('ends the pause when the backend answers, and when the network changes', async () => {
    const internet = new ManualProtocol();
    const protocol = composite(internet, new MockMessageProtocol());

    internet.failWith = new NetworkError('fetch failed');
    await protocol.sendMessage(msg(1));
    await flush();
    expect(protocol.isBackendPaused()).toBe(true);
    protocol.networkChanged();
    expect(protocol.isBackendPaused()).toBe(false);

    // failing again: the pause starts over from the shortest
    await protocol.sendMessage(msg(2));
    await flush();
    await vi.advanceTimersByTimeAsync(BACKEND_PAUSE_FIRST_MS);
    expect(protocol.isBackendPaused()).toBe(false);

    // an HTTP answer, even an error, means the backend is reachable
    await protocol.sendMessage(msg(3));
    await flush();
    expect(protocol.isBackendPaused()).toBe(true);
    await vi.advanceTimersByTimeAsync(BACKEND_PAUSE_FIRST_MS * 2);
    internet.failWith = new HttpStatusError(500, 'Internal Server Error');
    await protocol.sendMessage(msg(4));
    await flush();
    internet.failWith = new NetworkError('fetch failed');
    await protocol.sendMessage(msg(5));
    await flush();
    const start = Date.now();
    while (protocol.isBackendPaused()) await vi.advanceTimersByTimeAsync(1000);
    expect(Date.now() - start).toBe(BACKEND_PAUSE_FIRST_MS);

    // a success too: the pause after it starts over from the shortest
    internet.failWith = new NetworkError('fetch failed');
    await protocol.sendMessage(msg(6));
    await flush();
    while (protocol.isBackendPaused()) await vi.advanceTimersByTimeAsync(1000);
    internet.failWith = null;
    await protocol.sendMessage(msg(7));
    await flush();
    internet.failWith = new NetworkError('fetch failed');
    await protocol.sendMessage(msg(8));
    await flush();
    const again = Date.now();
    while (protocol.isBackendPaused()) await vi.advanceTimersByTimeAsync(1000);
    expect(Date.now() - again).toBe(BACKEND_PAUSE_FIRST_MS);
  });

  it('never pauses the backend and waits for it when no mesh is on', async () => {
    const internet = new ManualProtocol();
    const mesh = new ManualProtocol();
    mesh.isMeshEnabled = () => false;
    mesh.failWith = new Error('The offline mesh is off');
    const protocol = composite(internet, mesh);

    internet.failWith = new NetworkError('fetch failed');
    // the backend's own error, alone, as with a single REST transport
    await expect(protocol.sendMessage(msg(1))).rejects.toBeInstanceOf(
      NetworkError
    );
    await expect(protocol.fetchMessages([bytes(1)])).rejects.toBeInstanceOf(
      NetworkError
    );
    expect(protocol.isBackendPaused()).toBe(false);
    internet.calls = [];
    await expect(protocol.sendMessage(msg(2))).rejects.toThrow('fetch failed');
    expect(internet.calls).toEqual(['send']);
    expect(mesh.calls).toEqual([]);

    // a slow backend is waited for, however long
    internet.failWith = null;
    internet.manual = true;
    let done = false;
    const sending = protocol.sendMessage(msg(3)).then(() => (done = true));
    const fetching = protocol.fetchMessages([bytes(4)]);
    protocol.onLateMessages(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(done).toBe(false);
    internet.release();
    await sending;
    await flush();
    internet.release();
    expect(await fetching).toEqual([]);
  });

  it('returns what the mesh fetched without waiting for a slow backend', async () => {
    const internet = new ManualProtocol();
    const mesh = new MockMessageProtocol();
    await mesh.sendMessage(msg(1, 11));
    await internet.sendMessage(msg(2, 22));
    internet.calls = [];
    internet.manual = true;
    const late: EncryptedMessage[][] = [];
    const protocol = composite(internet, mesh);
    protocol.onLateMessages(m => late.push(m));

    const fetching = protocol.fetchMessages([bytes(1), bytes(2)]);
    let result: EncryptedMessage[] | null = null;
    void fetching.then(r => (result = r));
    await vi.advanceTimersByTimeAsync(FETCH_GRACE_MS - 1);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual([msg(1, 11)]);

    // the backend still running is not asked again meanwhile
    expect(await protocol.fetchMessages([bytes(1), bytes(2)])).toEqual([
      msg(1, 11),
    ]);
    expect(internet.calls).toEqual(['fetch']);

    // what it brings later is not lost
    internet.release();
    await flush();
    expect(late).toEqual([[msg(2, 22)]]);
  });

  it('reads both when the backend answers within the grace', async () => {
    const internet = new ManualProtocol();
    const mesh = new MockMessageProtocol();
    await mesh.sendMessage(msg(1, 11));
    await internet.sendMessage(msg(2, 22));
    internet.manual = true;
    const late: EncryptedMessage[][] = [];
    const protocol = composite(internet, mesh);
    protocol.onLateMessages(m => late.push(m));

    const fetching = protocol.fetchMessages([bytes(1), bytes(2)]);
    await vi.advanceTimersByTimeAsync(FETCH_GRACE_MS / 2);
    internet.release();
    expect(await fetching).toEqual([msg(2, 22), msg(1, 11)]);
    expect(late).toEqual([]);
  });

  it('waits for every transport when nothing takes late answers', async () => {
    const internet = new ManualProtocol();
    const protocol = composite(internet, new MockMessageProtocol());
    await internet.sendMessage(msg(2, 22));
    internet.manual = true;
    let result: EncryptedMessage[] | null = null;
    void protocol.fetchMessages([bytes(2)]).then(r => (result = r));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result).toBeNull();
    internet.release();
    await flush();
    expect(result).toEqual([msg(2, 22)]);
  });

  it('reads the mesh board without waiting for the backend', async () => {
    const internet = new ManualProtocol();
    const mesh = new MockMessageProtocol();
    await mesh.sendAnnouncement(bytes(7));
    await internet.sendAnnouncement(bytes(8));
    internet.calls = [];
    internet.manual = true;
    const protocol = composite(internet, mesh);

    let items: unknown = null;
    void protocol.fetchAnnouncements(10).then(r => (items = r));
    await vi.advanceTimersByTimeAsync(FETCH_GRACE_MS);
    // the digests of the items are computed off the event loop
    for (let i = 0; i < 100 && items === null; i++) {
      await new Promise(r => setImmediate(r));
    }
    expect(items).toEqual([{ data: bytes(7) }]);

    // the next call takes the same request over, and gets its page
    const next = protocol.fetchAnnouncements(10);
    internet.release();
    expect(await next).toEqual([{ counter: '1', data: bytes(8) }]);
    expect(internet.calls).toEqual(['board']);
  });
});
