/**
 * Composite message protocol
 *
 * Runs several transports side by side (for example the REST node and a
 * Bluetooth mesh node) behind one IMessageProtocol, so the services above it
 * do not care which path a message took.
 */

import {
  BackendPausedError,
  NetworkError,
  TransportsFailedError,
  isSeekerConflict,
  type TransportFailure,
  type TransportKind,
} from '../errors.js';
import {
  BulletinItem,
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
  MessageRouting,
  SendOutcome,
  TransportConnectivity,
} from './types.js';
import { encodeToBase64 } from '../../utils/base64.js';
import { dlog } from '../../utils/debugLog.js';

export type { TransportKind };

export interface CompositeTransport {
  protocol: IMessageProtocol;
  kind: TransportKind;
}

/** How many announcement digests are remembered to drop copies from other transports. */
const SEEN_ANNOUNCEMENTS_CAP = 4096;

/** How many recent sends keep the list of transports that took them. */
const ACCEPTED_BY_CAP = 1024;

/**
 * The first pause of the backend after a network failure, while a mesh is
 * on, and the longest one it doubles up to. Short, because the pause also
 * holds back what only the backend reaches (contact requests, other
 * people's announcements); growing, so that a phone offline for hours does
 * not send a failing request (three attempts, up to 36 s each) every few
 * seconds.
 */
export const BACKEND_PAUSE_FIRST_MS = 30_000;
export const BACKEND_PAUSE_MAX_MS = 5 * 60_000;

/**
 * How long a fetch still waits for the other transports once one answered.
 * A backend that answers at all does so well within it, so a normal round
 * reads both at once; one that hangs costs this, not its 36 s timeout.
 */
export const FETCH_GRACE_MS = 1_000;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function digest(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return encodeToBase64(new Uint8Array(hash));
}

/** The error of a call every transport refused: alone, or all reasons. */
function failureOf(failures: TransportFailure[]): unknown {
  return failures.length === 1
    ? failures[0].error
    : new TransportsFailedError(failures);
}

/** Exact copies merged; distinct values at one seeker all kept, in order. */
function mergeMessages(lists: EncryptedMessage[][]): EncryptedMessage[] {
  const bySeeker = new Map<string, Uint8Array[]>();
  const merged: EncryptedMessage[] = [];
  for (const message of lists.flat()) {
    const key = encodeToBase64(message.seeker);
    const copies = bySeeker.get(key) ?? [];
    if (copies.some(c => sameBytes(c, message.ciphertext))) continue;
    copies.push(message.ciphertext);
    bySeeker.set(key, copies);
    merged.push(message);
  }
  return merged;
}

/**
 * - Messages are sent on every transport and fetched from all of them. Exact
 *   copies are merged; distinct values at one seeker are all returned, in
 *   transport order, so the first copy seen is offered first. The session
 *   accepts one of them and ignores the rest.
 * - The bulletin cursor the SDK stores belongs to the primary transport.
 *   Announcements from the others carry no counter, so they never move it;
 *   their own cursors are kept here (the SDK saves them through
 *   export/importSecondaryCursors), and copies of an announcement already
 *   seen are dropped by content digest. The digests live in memory only: a
 *   copy offered again after a restart is refused by the session manager,
 *   which only accepts an announcement newer than the latest from that peer.
 *
 * While a mesh is on, the mesh never waits for the backend (a backend that
 * fails takes 8 s to say so with no network, and up to 54 s on one that
 * hangs, and every queued operation of the SDK used to wait for that):
 * - a send is done as soon as one transport took it; the others go on in the
 *   background and their answers come back through `sendMessageTracked`;
 * - a fetch returns what the first transports gave within `FETCH_GRACE_MS`
 *   of the first answer; what a later one brings goes to `onLateMessages`;
 * - after a network failure (not an HTTP answer) the backend is skipped for
 *   a pause that grows from `BACKEND_PAUSE_FIRST_MS` up to
 *   `BACKEND_PAUSE_MAX_MS`, ended by any answer from it or by
 *   `networkChanged`.
 * With no mesh on, every call waits for the backend exactly as a single REST
 * transport would, and the backend is never paused: there is nothing else
 * to carry the traffic, and pausing would only delay it.
 */
export class CompositeMessageProtocol implements IMessageProtocol {
  private readonly transports: CompositeTransport[];
  private readonly secondaryCursors: (string | undefined)[];
  private readonly seenAnnouncements = new Set<string>();
  /** Whether the latest operation on each transport succeeded. */
  private readonly reachable = new Map<IMessageProtocol, boolean>();
  /** Transports that took each recent send, by seeker, until read. */
  private readonly accepted = new Map<string, TransportKind[]>();
  /** Until when the backend is skipped (epoch ms), and the next pause. */
  private pausedUntil = 0;
  private nextPauseMs = BACKEND_PAUSE_FIRST_MS;
  /** Message fetches on an internet transport not answered yet. */
  private internetFetches = 0;
  /** The primary's announcement fetch still running, reused while it runs. */
  private primaryAnnouncements: {
    key: string;
    promise: Promise<BulletinItem[]>;
  } | null = null;
  private lateMessages: ((messages: EncryptedMessage[]) => void) | null = null;

  constructor(
    private readonly primary: CompositeTransport,
    private readonly secondaries: CompositeTransport[] = []
  ) {
    this.transports = [primary, ...secondaries];
    this.secondaryCursors = secondaries.map(() => undefined);
  }

  private async track<T>(
    transport: CompositeTransport,
    operation: Promise<T>
  ): Promise<T> {
    try {
      const result = await operation;
      this.reachable.set(transport.protocol, true);
      if (transport.kind === 'internet') this.backendAnswered();
      return result;
    } catch (error) {
      this.reachable.set(transport.protocol, false);
      if (transport.kind === 'internet') {
        if (error instanceof NetworkError) this.backendUnreachable();
        // an HTTP status is an answer: the network works
        else if (!(error instanceof BackendPausedError)) this.backendAnswered();
      }
      throw error;
    }
  }

  private backendAnswered(reason = 'answer'): void {
    if (this.pausedUntil !== 0) {
      dlog('api', 'api.backend.pause.end', {
        reason,
        early: Date.now() < this.pausedUntil,
      });
    }
    this.pausedUntil = 0;
    this.nextPauseMs = BACKEND_PAUSE_FIRST_MS;
  }

  private backendUnreachable(): void {
    // Without a mesh nothing else carries the traffic: never paused.
    if (!this.isMeshEnabled()) return;
    const now = Date.now();
    // Requests started before the pause fail during it: one pause each time.
    if (now < this.pausedUntil) return;
    this.pausedUntil = now + this.nextPauseMs;
    dlog('api', 'api.backend.pause.start', { ms: this.nextPauseMs });
    this.nextPauseMs = Math.min(this.nextPauseMs * 2, BACKEND_PAUSE_MAX_MS);
  }

  /** Whether the backend is skipped now (only ever while a mesh is on). */
  isBackendPaused(): boolean {
    return Date.now() < this.pausedUntil && this.isMeshEnabled();
  }

  /**
   * The device's network changed (a connection came or went): the backend is
   * worth asking again at once, and its next failure starts a short pause.
   */
  networkChanged(): void {
    this.backendAnswered('network');
  }

  /** Receives what a transport answered after its fetch had returned. */
  onLateMessages(
    handler: ((messages: EncryptedMessage[]) => void) | null
  ): void {
    this.lateMessages = handler;
  }

  private connectivityOf(transport: CompositeTransport): TransportConnectivity {
    const fallback = transport.kind === 'internet' ? 'internet' : 'mesh-only';
    const own = transport.protocol.getConnectivity?.();
    if (own !== undefined) {
      // a mesh node with a working upstream reaches the internet too
      return own === 'offline'
        ? 'offline'
        : own === 'internet'
          ? own
          : fallback;
    }
    // never used yet: assume reachable, like a single REST transport
    return (this.reachable.get(transport.protocol) ?? true)
      ? fallback
      : 'offline';
  }

  getConnectivity(): TransportConnectivity {
    const states = this.transports.map(t =>
      t.kind === 'internet' && this.isBackendPaused()
        ? 'offline'
        : this.connectivityOf(t)
    );
    if (states.includes('internet')) return 'internet';
    if (states.includes('mesh-only')) return 'mesh-only';
    return 'offline';
  }

  private meshTransports(): CompositeTransport[] {
    return this.transports.filter(
      t => t.kind === 'mesh' && (t.protocol.isMeshEnabled?.() ?? true)
    );
  }

  /** The transports a call with `routing` uses; throws when there are none. */
  private route(routing?: MessageRouting): CompositeTransport[] {
    if (routing?.internetOnly) {
      const internet = this.transports.filter(t => t.kind === 'internet');
      if (internet.length === 0) throw new Error('No internet transport');
      if (this.isBackendPaused()) throw new BackendPausedError();
      return internet;
    }
    if (!routing?.meshOnly) return this.transports;
    const mesh = this.meshTransports();
    if (mesh.length === 0) throw new Error('No mesh transport is on');
    return mesh;
  }

  /**
   * The transports of a call that goes everywhere it may: a mesh switched off
   * is left out (it would only fail), and so is the backend while paused.
   * The failures they stand for are returned to be reported with the others.
   */
  private live(routing?: MessageRouting): {
    transports: CompositeTransport[];
    skipped: TransportFailure[];
  } {
    const transports = this.route(routing);
    if (routing?.internetOnly || routing?.meshOnly) {
      return { transports, skipped: [] };
    }
    const mesh = new Set(this.meshTransports());
    const paused = this.isBackendPaused();
    const kept = transports.filter(t =>
      t.kind === 'mesh' ? mesh.has(t) : !paused
    );
    // nothing left (no mesh on and... cannot happen with a primary): as before
    if (kept.length === 0) return { transports, skipped: [] };
    const skipped: TransportFailure[] =
      paused && transports.some(t => t.kind === 'internet')
        ? [{ kind: 'internet', error: new BackendPausedError() }]
        : [];
    return { transports: kept, skipped };
  }

  isMeshEnabled(): boolean {
    return this.meshTransports().length > 0;
  }

  async fetchMessages(
    seekers: Uint8Array[],
    routing?: MessageRouting
  ): Promise<EncryptedMessage[]> {
    const { transports: all, skipped } = this.live(routing);
    // An internet fetch still running answers through onLateMessages: a
    // backend that hangs is not asked again on every round meanwhile.
    const transports =
      this.lateMessages && this.isMeshEnabled() && this.internetFetches > 0
        ? all.filter(t => t.kind !== 'internet')
        : all;
    const used = transports.length > 0 ? transports : all;
    // Without a mesh, or with nowhere to put a late answer, wait for all.
    const early =
      used.length > 1 && this.isMeshEnabled() && this.lateMessages !== null;

    return new Promise<EncryptedMessage[]>((resolve, reject) => {
      const answers: (EncryptedMessage[] | undefined)[] = used.map(
        () => undefined
      );
      const failures: TransportFailure[] = [...skipped];
      let pending = used.length;
      let done = false;
      let grace: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (grace) clearTimeout(grace);
        const got = answers.filter((a): a is EncryptedMessage[] => !!a);
        if (got.length === 0) reject(failureOf(failures));
        else resolve(mergeMessages(got));
      };
      used.forEach((t, i) => {
        if (t.kind === 'internet') this.internetFetches++;
        this.track(t, t.protocol.fetchMessages(seekers, routing))
          .then(
            messages => {
              if (done) {
                dlog('api', 'api.fetch.late', {
                  kind: t.kind,
                  count: messages.length,
                });
                // after the fetch returned: offered as if pushed
                if (messages.length > 0) this.lateMessages?.(messages);
                return;
              }
              answers[i] = messages;
              if (pending === 1 || !early) return;
              grace ??= setTimeout(finish, FETCH_GRACE_MS);
            },
            error => {
              failures.push({ kind: t.kind, error });
            }
          )
          .catch(() => undefined)
          .finally(() => {
            if (t.kind === 'internet') this.internetFetches--;
            pending--;
            if (pending === 0) finish();
          });
      });
    });
  }

  async sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void> {
    await this.sendMessageTracked(message, routing);
  }

  /**
   * Sends on every transport and resolves as soon as one took it, with the
   * kinds that had by then; `settled` resolves (never rejects) once all of
   * them answered. Rejects when every transport refused it, with each
   * reason, or when a server refused it for good at a seeker it holds
   * (409) before it resolved: as before, that is final even if a mesh took
   * it, since the peer reads the server's value. A 409 that comes after is
   * in `settled.failures`, for the caller to handle the same way.
   */
  sendMessageTracked(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<SendOutcome> {
    let live: ReturnType<CompositeMessageProtocol['live']>;
    try {
      live = this.live(routing);
    } catch (error) {
      return Promise.reject(error);
    }
    const { transports, skipped } = live;
    const acceptedBy: TransportKind[] = [];
    const failures: TransportFailure[] = [...skipped];
    const key = encodeToBase64(message.seeker);
    const remember = () => {
      this.accepted.delete(key);
      this.accepted.set(key, sortKinds(this.transports, acceptedBy));
      if (this.accepted.size > ACCEPTED_BY_CAP) {
        const oldest = this.accepted.keys().next().value;
        if (oldest !== undefined) this.accepted.delete(oldest);
      }
    };

    let settle!: () => void;
    const settled = new Promise<void>(resolve => {
      settle = resolve;
    }).then(() => {
      if (acceptedBy.length > 0) remember();
      return {
        acceptedBy: sortKinds(this.transports, acceptedBy),
        failures: [...failures],
      };
    });

    return new Promise<SendOutcome>((resolve, reject) => {
      let pending = transports.length;
      let done = false;
      for (const t of transports) {
        this.track(t, t.protocol.sendMessage(message, routing))
          .then(
            () => {
              acceptedBy.push(t.kind);
              if (done) {
                dlog('api', 'api.send.late', { kind: t.kind, ok: true });
                return;
              }
              done = true;
              const conflict = failures.find(
                f => f.kind === 'internet' && isSeekerConflict(f.error)
              );
              if (conflict) {
                reject(conflict.error);
                return;
              }
              remember();
              resolve({
                acceptedBy: sortKinds(this.transports, acceptedBy),
                settled,
              });
            },
            error => {
              failures.push({ kind: t.kind, error });
              if (done) {
                dlog(
                  'api',
                  'api.send.late',
                  {
                    kind: t.kind,
                    ok: false,
                    conflict: isSeekerConflict(error),
                  },
                  { lvl: 'warn' }
                );
              }
            }
          )
          .catch(() => undefined)
          .finally(() => {
            pending--;
            if (pending > 0) return;
            settle();
            if (!done) {
              done = true;
              reject(failureOf(failures));
            }
          });
      }
    });
  }

  /**
   * Which transports took the last send at `seeker`, read once: the message
   * service uses it to mark messages that only reached the mesh.
   */
  takeAcceptedBy(seeker: Uint8Array): TransportKind[] | undefined {
    const key = encodeToBase64(seeker);
    const kinds = this.accepted.get(key);
    this.accepted.delete(key);
    return kinds;
  }

  /**
   * Posts on every transport, or on the internet ones with `internetOnly`.
   * Returns the primary's counter, or '' when only another transport took it
   * (a mesh): the caller posts it to a server later.
   *
   * Unlike a message, it waits for the backend's answer (unless paused): the
   * counter tells the caller that the board has it, and a copy posted again
   * later would be a second entry on the board.
   */
  async sendAnnouncement(
    announcement: Uint8Array,
    routing?: MessageRouting
  ): Promise<string> {
    this.remember(await digest(announcement));
    const { transports, skipped } = routing?.internetOnly
      ? { transports: this.route(routing), skipped: [] }
      : this.live();
    const results = await Promise.allSettled(
      transports.map(t =>
        this.track(t, t.protocol.sendAnnouncement(announcement))
      )
    );
    const [first] = results;
    if (transports[0] === this.primary && first.status === 'fulfilled') {
      return first.value;
    }
    if (!results.some(r => r.status === 'fulfilled')) {
      throw failureOf([
        ...skipped,
        ...results.flatMap((r, i) =>
          r.status === 'rejected'
            ? [{ kind: transports[i].kind, error: r.reason }]
            : []
        ),
      ]);
    }
    // only another transport took it: there is no primary counter to report
    return '';
  }

  /**
   * The primary's announcements, from a request already running for the
   * same page if there is one (it may have outlived an earlier call).
   */
  private primaryFetch(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    const key = `${limit ?? ''}:${cursor ?? ''}`;
    if (this.primaryAnnouncements?.key === key) {
      return this.primaryAnnouncements.promise;
    }
    const promise = this.track(
      this.primary,
      this.primary.protocol.fetchAnnouncements(limit, cursor)
    );
    const entry = { key, promise };
    this.primaryAnnouncements = entry;
    const clear = () => {
      if (this.primaryAnnouncements === entry) {
        this.primaryAnnouncements = null;
      }
    };
    promise.then(clear, clear);
    return promise;
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    // The mesh is read at the same time as the backend, not after it. With a
    // mesh on, the backend's page is waited for at most FETCH_GRACE_MS once
    // the mesh answered: a page that comes later is not lost, since the
    // cursor stays where it was until a page is read, and the next call
    // takes the same request over while it runs.
    const meshOn = this.isMeshEnabled();
    const paused = this.isBackendPaused();
    const primary: Promise<BulletinItem[]> = paused
      ? Promise.reject(new BackendPausedError())
      : this.primaryFetch(limit, cursor);
    primary.catch(() => undefined);
    const secondary = this.secondaries.map((transport, index) =>
      this.track(
        transport,
        transport.protocol.fetchAnnouncements(
          limit,
          this.secondaryCursors[index]
        )
      ).then(
        items => ({ ok: true as const, items }),
        () => ({ ok: false as const, items: [] as BulletinItem[] })
      )
    );
    const fetched = await Promise.all(secondary);

    const items: BulletinItem[] = [];
    let primaryError: unknown;
    let primaryItems: BulletinItem[] | null = null;
    try {
      if (meshOn && fetched.some(r => r.ok)) {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const late = Symbol('late');
        const raced = await Promise.race([
          primary,
          new Promise<typeof late>(resolve => {
            timer = setTimeout(() => resolve(late), FETCH_GRACE_MS);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        // too late for this call: read again by the next one
        if (raced !== late) primaryItems = raced;
      } else {
        primaryItems = await primary;
      }
    } catch (error) {
      primaryError = error;
    }
    for (const item of primaryItems ?? []) {
      this.remember(await digest(item.data));
      items.push(item);
    }

    let secondaryOk = false;
    for (const [index, result] of fetched.entries()) {
      if (!result.ok) continue;
      secondaryOk = true;
      for (const item of result.items) {
        const current = this.secondaryCursors[index];
        if (
          item.counter !== undefined &&
          (current === undefined || Number(item.counter) > Number(current))
        ) {
          this.secondaryCursors[index] = item.counter;
        }
        const key = await digest(item.data);
        if (this.seenAnnouncements.has(key)) continue;
        this.remember(key);
        items.push({ data: item.data });
      }
    }

    if (primaryError !== undefined && !secondaryOk) throw primaryError;
    return items;
  }

  exportSecondaryCursors(): (string | undefined)[] {
    return [...this.secondaryCursors];
  }

  /** Restores saved cursors; ignored when the transports changed since. */
  importSecondaryCursors(cursors: (string | undefined)[]): void {
    if (cursors.length !== this.secondaryCursors.length) return;
    cursors.forEach((cursor, index) => {
      this.secondaryCursors[index] = cursor;
    });
  }

  fetchBulletinCounter(): Promise<string> {
    return this.track(
      this.primary,
      this.primary.protocol.fetchBulletinCounter()
    );
  }

  changeNode(nodeUrl?: string): Promise<MessageProtocolResponse> {
    return this.primary.protocol.changeNode(nodeUrl);
  }

  async setWantedSeekers(
    seekers: Uint8Array[],
    localSeekers: Uint8Array[] = []
  ): Promise<void> {
    await Promise.allSettled(
      this.transports.map(t =>
        // mesh-only seekers never go to a transport without a mesh
        t.kind === 'mesh'
          ? t.protocol.setWantedSeekers?.(seekers, localSeekers)
          : t.protocol.setWantedSeekers?.(seekers)
      )
    );
  }

  private remember(key: string): void {
    this.seenAnnouncements.delete(key);
    this.seenAnnouncements.add(key);
    if (this.seenAnnouncements.size > SEEN_ANNOUNCEMENTS_CAP) {
      const oldest = this.seenAnnouncements.values().next().value;
      if (oldest !== undefined) this.seenAnnouncements.delete(oldest);
    }
  }
}

/** `kinds` in the order of the transports, each once. */
function sortKinds(
  transports: CompositeTransport[],
  kinds: TransportKind[]
): TransportKind[] {
  const out: TransportKind[] = [];
  for (const t of transports) {
    if (kinds.includes(t.kind) && !out.includes(t.kind)) out.push(t.kind);
  }
  return out;
}

/**
 * Sends `message` through `protocol` and tells which kinds of transport took
 * it: at once from a transport that runs several paths, otherwise once the
 * send is done (a single transport is taken as the backend).
 */
export async function sendTracked(
  protocol: IMessageProtocol,
  message: EncryptedMessage,
  routing?: MessageRouting
): Promise<SendOutcome> {
  if (protocol.sendMessageTracked) {
    return protocol.sendMessageTracked(message, routing);
  }
  await protocol.sendMessage(message, routing);
  const acceptedBy = protocol.takeAcceptedBy?.(message.seeker) ?? [
    'internet' as const,
  ];
  return {
    acceptedBy,
    settled: Promise.resolve({ acceptedBy, failures: [] }),
  };
}
