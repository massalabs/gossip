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
  /**
   * Stops serving a key set this node published, by `blake3(keys)`;
   * `forgotten` is false when the node held none.
   */
  forgetKeys?(options: { hash: string }): Promise<{ forgotten?: boolean }>;
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
    const { messages } = await this.plugin.fetch({
      seekers: seekers.map(encodeToBase64),
    });
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
    await this.plugin.sendBlob({
      kind: 'message',
      key: encodeToBase64(message.seeker),
      payload: encodeToBase64(message.ciphertext),
      ...(routing?.meshOnly ? { localOnly: true } : {}),
    });
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    const { counter } = await this.plugin.sendBlob({
      kind: 'announcement',
      payload: encodeToBase64(announcement),
    });
    return counter ?? '';
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    const { items } = await this.plugin.fetchBulletin({ cursor, limit });
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
    await this.plugin.setWanted({
      seekers: seekers.map(encodeToBase64),
      localSeekers: localSeekers.map(encodeToBase64),
    });
  }

  /** Public key set published under `blake3(keys)`, if the node holds it. */
  async getKeys(hash: Uint8Array): Promise<Uint8Array | undefined> {
    const { keys } = await this.plugin.getKeys({ hash: encodeToBase64(hash) });
    return keys === undefined ? undefined : decodeFromBase64(keys);
  }

  /** Publishes our public key set to the hash pool, under `blake3(keys)`. */
  async publishKeys(keys: Uint8Array): Promise<void> {
    await this.plugin.sendBlob({ kind: 'keys', payload: encodeToBase64(keys) });
  }

  /**
   * Stops serving a key set `publishKeys` put on the node. Throws when the
   * plugin or its node cannot do it.
   */
  async forgetKeys(hash: Uint8Array): Promise<void> {
    if (!this.plugin.forgetKeys) {
      throw new Error('The mesh node cannot forget published keys');
    }
    await this.plugin.forgetKeys({ hash: encodeToBase64(hash) });
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
    return this.plugin.addListener('arrival', arrival =>
      handler({
        messages: arrival.messages.map(m => ({
          seeker: decodeFromBase64(m.seeker),
          ciphertext: decodeFromBase64(m.ciphertext),
        })),
        announcements: arrival.announcements.map(decodeFromBase64),
      })
    );
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
    this.lastStatus = status;
    return status;
  }
}
