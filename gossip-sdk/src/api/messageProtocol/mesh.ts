/**
 * Mesh node message protocol
 *
 * Talks to the gossip node embedded in the phone (Bluetooth mesh plus an
 * optional internet upstream) through a native plugin. Binary values cross
 * the plugin bridge as base64 strings.
 */

import {
  BulletinItem,
  EncryptedMessage,
  IMessageProtocol,
  MessageProtocolResponse,
  MessageRouting,
  TransportConnectivity,
} from './types.js';
import { decodeFromBase64, encodeToBase64 } from '../../utils/base64.js';
import { debugLogEnabled, dlog } from '../../utils/debugLog.js';
import { errFields, shortId, since } from '../../utils/debugFields.js';

/** `mesh.call.failed`: a call into the mesh plugin that threw. */
function meshFailed(
  call: string,
  started: number,
  error: unknown,
  fields?: Record<string, unknown>
): void {
  dlog(
    'mesh',
    'mesh.call.failed',
    { call, ...fields, ...errFields(error) },
    { lvl: 'error', dur: since(started) }
  );
}

export type MeshBlobKind = 'message' | 'announcement' | 'keys';

export interface MeshNodeStatus {
  running: boolean;
  /** Mesh neighbours currently linked. */
  meshPeers: number;
  /** Whether the internet upstream answered recently. */
  upstreamReachable: boolean;
  bridgeEnabled: boolean;
  /** Latest counter of the node's local bulletin. */
  bulletinCounter: string;
  storedBlobs: number;
  /** Mesh blobs waiting for a bridge to upload them (Rust node only). */
  uploadPending?: number;
  /** Seekers on the merged wanted table (Rust node only). */
  wantedEntries?: number;
  /** Estimated offset of the local clock from the mesh's (Rust node only). */
  clockOffsetMs?: number;
}

/** Blobs the node received for seekers on its wanted list, or announcements. */
export interface MeshNodeArrival {
  messages: { seeker: string; ciphertext: string }[];
  announcements: string[];
}

/**
 * The native MeshNode plugin (Capacitor). Implemented by the Android and iOS
 * plugins over the Rust node; the SDK only depends on this shape.
 */
export interface MeshNodePlugin {
  start(options?: { config?: Record<string, unknown> }): Promise<void>;
  stop(): Promise<void>;
  sendBlob(options: {
    kind: MeshBlobKind;
    /** Seeker for a message, absent otherwise. */
    key?: string;
    payload: string;
    /**
     * Keep the blob in the mesh: neither this phone nor a bridge that relays
     * it uploads it to an internet node.
     */
    localOnly?: boolean;
  }): Promise<{ id: string; counter?: string }>;
  fetch(options: {
    seekers: string[];
  }): Promise<{ messages: { seeker: string; ciphertext: string }[] }>;
  fetchBulletin(options: {
    cursor?: string;
    limit?: number;
  }): Promise<{ items: { counter: string; data: string }[] }>;
  /** Public key set by `blake3(keys)`, as published to the hash pool. */
  getKeys(options: { hash: string }): Promise<{ keys?: string }>;
  /**
   * Replaces the wanted list. `localSeekers` are waited on from the mesh
   * only: no bridge, nor this phone, fetches them from an internet node.
   */
  setWanted(options: {
    seekers: string[];
    localSeekers?: string[];
  }): Promise<void>;
  setUpstream(options: {
    urls: string[];
    bridgeEnabled: boolean;
  }): Promise<void>;
  status(): Promise<MeshNodeStatus>;
  /** Deletes everything the node stored, its own blobs and relayed ones. */
  wipe(): Promise<void>;
  addListener(
    event: 'arrival',
    handler: (arrival: MeshNodeArrival) => void
  ): Promise<{ remove(): Promise<void> }>;
}

/** Minimum gap between two status reads behind getConnectivity(). */
const STATUS_REFRESH_MS = 5000;

export class MeshNodeProtocol implements IMessageProtocol {
  private lastStatus: MeshNodeStatus | null = null;
  private lastStatusAt = 0;

  constructor(private readonly plugin: MeshNodePlugin) {}

  isMeshEnabled(): boolean {
    return true;
  }

  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    const started = performance.now();
    let messages: { seeker: string; ciphertext: string }[];
    try {
      ({ messages } = await this.plugin.fetch({
        seekers: seekers.map(encodeToBase64),
      }));
    } catch (error) {
      meshFailed('fetch', started, error, { seekers: seekers.length });
      throw error;
    }
    dlog(
      'mesh',
      'mesh.fetch',
      { seekers: seekers.length, messages: messages.length },
      { dur: since(started) }
    );
    return messages.map(m => ({
      seeker: decodeFromBase64(m.seeker),
      ciphertext: decodeFromBase64(m.ciphertext),
    }));
  }

  /**
   * With `meshOnly` routing (addressed re-announcements) the entry is
   * local-only on the node: it never reaches an internet node through this
   * phone or a bridge.
   */
  async sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void> {
    const started = performance.now();
    const fields = debugLogEnabled()
      ? {
          kind: 'message',
          seeker: shortId(message.seeker),
          size: message.ciphertext.length,
          localOnly: !!routing?.meshOnly,
        }
      : undefined;
    let sent: { id: string };
    try {
      sent = await this.plugin.sendBlob({
        kind: 'message',
        key: encodeToBase64(message.seeker),
        payload: encodeToBase64(message.ciphertext),
        ...(routing?.meshOnly ? { localOnly: true } : {}),
      });
    } catch (error) {
      meshFailed('sendBlob', started, error, fields);
      throw error;
    }
    dlog(
      'mesh',
      'mesh.send',
      { ...fields, blob: shortId(sent?.id) },
      { dur: since(started) }
    );
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    const started = performance.now();
    let counter: string | undefined;
    try {
      ({ counter } = await this.plugin.sendBlob({
        kind: 'announcement',
        payload: encodeToBase64(announcement),
      }));
    } catch (error) {
      meshFailed('sendBlob', started, error, {
        kind: 'announcement',
        size: announcement.length,
      });
      throw error;
    }
    dlog(
      'mesh',
      'mesh.send',
      { kind: 'announcement', size: announcement.length, counter },
      { dur: since(started) }
    );
    return counter ?? '';
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    const started = performance.now();
    let items: { counter: string; data: string }[];
    try {
      ({ items } = await this.plugin.fetchBulletin({ cursor, limit }));
    } catch (error) {
      meshFailed('fetchBulletin', started, error, { cursor, limit });
      throw error;
    }
    dlog(
      'mesh',
      'mesh.fetch_bulletin',
      { cursor, limit, items: items.length },
      { dur: since(started) }
    );
    return items.map(item => ({
      counter: item.counter,
      data: decodeFromBase64(item.data),
    }));
  }

  async fetchBulletinCounter(): Promise<string> {
    return (await this.refreshStatus()).bulletinCounter;
  }

  async changeNode(): Promise<MessageProtocolResponse> {
    return { success: false, error: 'The mesh node has no node to change' };
  }

  async setWantedSeekers(
    seekers: Uint8Array[],
    localSeekers: Uint8Array[] = []
  ): Promise<void> {
    const started = performance.now();
    try {
      await this.plugin.setWanted({
        seekers: seekers.map(encodeToBase64),
        localSeekers: localSeekers.map(encodeToBase64),
      });
    } catch (error) {
      meshFailed('setWanted', started, error, {
        seekers: seekers.length,
        localSeekers: localSeekers.length,
      });
      throw error;
    }
    dlog(
      'mesh',
      'mesh.wanted',
      { seekers: seekers.length, localSeekers: localSeekers.length },
      { dur: since(started) }
    );
  }

  /** Public key set published under `blake3(keys)`, if the node holds it. */
  async getKeys(hash: Uint8Array): Promise<Uint8Array | undefined> {
    const { keys } = await this.plugin.getKeys({ hash: encodeToBase64(hash) });
    return keys === undefined ? undefined : decodeFromBase64(keys);
  }

  /** The node's last status, refreshed now. */
  async status(): Promise<MeshNodeStatus> {
    return this.refreshStatus();
  }

  /**
   * Calls `handler` with what the node receives for our wanted seekers and
   * the announcements it relays; feed them to `messages.ingestMessages` and
   * `announcements.ingestAnnouncements`.
   */
  onArrival(
    handler: (arrival: {
      messages: EncryptedMessage[];
      announcements: Uint8Array[];
    }) => void
  ): Promise<{ remove(): Promise<void> }> {
    return this.plugin.addListener('arrival', arrival => {
      if (debugLogEnabled()) {
        dlog('mesh', 'mesh.arrival', {
          messages: arrival.messages.length,
          announcements: arrival.announcements.length,
          seekers: arrival.messages.map(m => {
            try {
              return shortId(decodeFromBase64(m.seeker));
            } catch {
              return '';
            }
          }),
        });
      }
      handler({
        messages: arrival.messages.map(m => ({
          seeker: decodeFromBase64(m.seeker),
          ciphertext: decodeFromBase64(m.ciphertext),
        })),
        announcements: arrival.announcements.map(decodeFromBase64),
      });
    });
  }

  /**
   * From the last status read, refreshed in the background at most every
   * few seconds: `mesh-only` while neighbours are linked, `internet` when
   * only the upstream answers, `offline` otherwise or before the first read.
   */
  getConnectivity(): TransportConnectivity {
    if (Date.now() - this.lastStatusAt > STATUS_REFRESH_MS) {
      this.refreshStatus().catch(() => {
        this.lastStatus = null;
      });
    }
    const status = this.lastStatus;
    if (!status?.running) return 'offline';
    if (status.meshPeers > 0) return 'mesh-only';
    return status.upstreamReachable ? 'internet' : 'offline';
  }

  private async refreshStatus(): Promise<MeshNodeStatus> {
    this.lastStatusAt = Date.now();
    const status = await this.plugin.status();
    const before = this.lastStatus;
    if (
      debugLogEnabled() &&
      (!before ||
        before.running !== status.running ||
        before.meshPeers !== status.meshPeers ||
        before.upstreamReachable !== status.upstreamReachable ||
        before.bridgeEnabled !== status.bridgeEnabled)
    ) {
      // Link up/down, peers and bridging, logged only when they change.
      dlog('mesh', 'mesh.status', { ...status }, { lvl: 'info' });
    }
    this.lastStatus = status;
    return status;
  }
}
