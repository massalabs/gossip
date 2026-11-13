/**
 * In-memory stand-in for the native MeshNode plugin: one node's pools, with
 * values as base64 strings like the real plugin bridge.
 */

import type {
  MeshBlobKind,
  MeshNodeArrival,
  MeshNodePlugin,
  MeshNodeStatus,
} from '../../src/api/messageProtocol/mesh';

export class MockMeshNodePlugin implements MeshNodePlugin {
  running = false;
  meshPeers = 0;
  upstreamReachable = false;
  bridgeEnabled = false;
  upstreamUrls: string[] = [];
  wanted: string[] = [];
  localWanted: string[] = [];
  /** Keys of the messages sent local-only. */
  readonly localOnly = new Set<string>();
  readonly messages = new Map<string, string[]>();
  readonly bulletin: { counter: string; data: string }[] = [];
  readonly keys = new Map<string, string>();
  private listeners: ((arrival: MeshNodeArrival) => void)[] = [];

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async sendBlob(options: {
    kind: MeshBlobKind;
    key?: string;
    payload: string;
    localOnly?: boolean;
  }): Promise<{ id: string; counter?: string }> {
    if (options.kind === 'message') {
      if (options.localOnly) this.localOnly.add(options.key!);
      const copies = this.messages.get(options.key!) ?? [];
      if (!copies.includes(options.payload)) copies.push(options.payload);
      this.messages.set(options.key!, copies);
      return { id: `${options.key}:${copies.length}` };
    }
    if (options.kind === 'announcement') {
      const counter = String(this.bulletin.length + 1);
      this.bulletin.push({ counter, data: options.payload });
      return { id: counter, counter };
    }
    this.keys.set(`hash:${options.payload}`, options.payload);
    return { id: options.payload };
  }

  async fetch(options: { seekers: string[] }) {
    return {
      messages: options.seekers.flatMap(seeker =>
        (this.messages.get(seeker) ?? []).map(ciphertext => ({
          seeker,
          ciphertext,
        }))
      ),
    };
  }

  async fetchBulletin(options: { cursor?: string; limit?: number }) {
    const after = Number(options.cursor ?? '0');
    const items = this.bulletin.filter(item => Number(item.counter) > after);
    return { items: items.slice(0, options.limit ?? items.length) };
  }

  async getKeys(options: { hash: string }) {
    return { keys: this.keys.get(options.hash) };
  }

  async setWanted(options: {
    seekers: string[];
    localSeekers?: string[];
  }): Promise<void> {
    this.wanted = options.seekers;
    this.localWanted = options.localSeekers ?? [];
  }

  async setUpstream(options: {
    urls: string[];
    bridgeEnabled: boolean;
  }): Promise<void> {
    this.upstreamUrls = options.urls;
    this.bridgeEnabled = options.bridgeEnabled;
  }

  async status(): Promise<MeshNodeStatus> {
    return {
      running: this.running,
      meshPeers: this.meshPeers,
      upstreamReachable: this.upstreamReachable,
      bridgeEnabled: this.bridgeEnabled,
      bulletinCounter: String(this.bulletin.length),
      storedBlobs:
        [...this.messages.values()].reduce((n, c) => n + c.length, 0) +
        this.bulletin.length,
    };
  }

  async wipe(): Promise<void> {
    this.messages.clear();
    this.bulletin.length = 0;
    this.keys.clear();
  }

  async addListener(
    _event: 'arrival',
    handler: (arrival: MeshNodeArrival) => void
  ) {
    this.listeners.push(handler);
    return {
      remove: async () => {
        this.listeners = this.listeners.filter(l => l !== handler);
      },
    };
  }

  /** Test helper: the node received blobs for a wanted seeker. */
  emitArrival(arrival: MeshNodeArrival): void {
    for (const listener of this.listeners) listener(arrival);
  }
}
