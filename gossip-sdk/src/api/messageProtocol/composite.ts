/**
 * Composite message protocol
 *
 * Runs several transports side by side (for example the REST node and a
 * Bluetooth mesh node) behind one IMessageProtocol, so the services above it
 * do not care which path a message took.
 */

import {
  BulletinItem,
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
  MessageRouting,
  TransportConnectivity,
} from './types.js';
import { encodeToBase64 } from '../../utils/base64.js';

export type TransportKind = 'internet' | 'mesh';

export interface CompositeTransport {
  protocol: IMessageProtocol;
  kind: TransportKind;
}

/** How many announcement digests are remembered to drop copies from other transports. */
const SEEN_ANNOUNCEMENTS_CAP = 4096;

/** How many recent sends keep the list of transports that took them. */
const ACCEPTED_BY_CAP = 1024;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function digest(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return encodeToBase64(new Uint8Array(hash));
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
 */
export class CompositeMessageProtocol implements IMessageProtocol {
  private readonly transports: CompositeTransport[];
  private readonly secondaryCursors: (string | undefined)[];
  private readonly seenAnnouncements = new Set<string>();
  /** Whether the latest operation on each transport succeeded. */
  private readonly reachable = new Map<IMessageProtocol, boolean>();
  /** Transports that took each recent send, by seeker, until read. */
  private readonly accepted = new Map<string, TransportKind[]>();

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
      return result;
    } catch (error) {
      this.reachable.set(transport.protocol, false);
      throw error;
    }
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
    const states = this.transports.map(t => this.connectivityOf(t));
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
      return internet;
    }
    if (!routing?.meshOnly) return this.transports;
    const mesh = this.meshTransports();
    if (mesh.length === 0) throw new Error('No mesh transport is on');
    return mesh;
  }

  isMeshEnabled(): boolean {
    return this.meshTransports().length > 0;
  }

  async fetchMessages(
    seekers: Uint8Array[],
    routing?: MessageRouting
  ): Promise<EncryptedMessage[]> {
    const transports = this.route(routing);
    const results = await Promise.allSettled(
      transports.map(t =>
        this.track(t, t.protocol.fetchMessages(seekers, routing))
      )
    );
    const fulfilled = results.flatMap(r =>
      r.status === 'fulfilled' ? [r.value] : []
    );
    if (fulfilled.length === 0) {
      throw (results[0] as PromiseRejectedResult).reason;
    }

    const bySeeker = new Map<string, Uint8Array[]>();
    const merged: EncryptedMessage[] = [];
    for (const message of fulfilled.flat()) {
      const key = encodeToBase64(message.seeker);
      const copies = bySeeker.get(key) ?? [];
      if (copies.some(c => sameBytes(c, message.ciphertext))) continue;
      copies.push(message.ciphertext);
      bySeeker.set(key, copies);
      merged.push(message);
    }
    return merged;
  }

  async sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void> {
    const transports = this.route(routing);
    const results = await Promise.allSettled(
      transports.map(t =>
        this.track(t, t.protocol.sendMessage(message, routing))
      )
    );
    if (!results.some(r => r.status === 'fulfilled')) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
    const key = encodeToBase64(message.seeker);
    this.accepted.delete(key);
    this.accepted.set(
      key,
      transports.flatMap((t, i) =>
        results[i].status === 'fulfilled' ? [t.kind] : []
      )
    );
    if (this.accepted.size > ACCEPTED_BY_CAP) {
      const oldest = this.accepted.keys().next().value;
      if (oldest !== undefined) this.accepted.delete(oldest);
    }
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
   */
  async sendAnnouncement(
    announcement: Uint8Array,
    routing?: MessageRouting
  ): Promise<string> {
    this.remember(await digest(announcement));
    const transports = routing?.internetOnly
      ? this.route(routing)
      : this.transports;
    const results = await Promise.allSettled(
      transports.map(t =>
        this.track(t, t.protocol.sendAnnouncement(announcement))
      )
    );
    const [first] = results;
    if (transports[0] === this.primary && first.status === 'fulfilled') {
      return first.value;
    }
    if (
      first.status === 'rejected' &&
      !results.some(r => r.status === 'fulfilled')
    ) {
      throw first.reason;
    }
    // only another transport took it: there is no primary counter to report
    return '';
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    const items: BulletinItem[] = [];
    let primaryError: unknown;
    try {
      const primaryItems = await this.track(
        this.primary,
        this.primary.protocol.fetchAnnouncements(limit, cursor)
      );
      for (const item of primaryItems) {
        this.remember(await digest(item.data));
        items.push(item);
      }
    } catch (error) {
      primaryError = error;
    }

    let secondaryOk = false;
    for (const [index, transport] of this.secondaries.entries()) {
      let fetched: BulletinItem[];
      try {
        fetched = await this.track(
          transport,
          transport.protocol.fetchAnnouncements(
            limit,
            this.secondaryCursors[index]
          )
        );
        secondaryOk = true;
      } catch {
        continue;
      }
      for (const item of fetched) {
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
