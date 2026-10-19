import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  CompositeMessageProtocol,
  MeshNodeProtocol,
  RestMessageProtocol,
  UserPublicKeys,
  decodeUserId,
  encodeUserId,
  type BulletinItem,
  type EncryptedMessage,
  type GossipSdk,
  type IMessageProtocol,
  type MessageRouting,
  type MeshNodePlugin,
  type MeshNodeStatus,
  type TransportConnectivity,
} from '@massalabs/gossip-sdk';
import { MESH_FEATURE_ENABLED } from '../config/features';
import { protocolConfig } from '../config/protocol';
import { logger } from '../utils/logger';

export type MeshPowerMode = 'performance' | 'balanced' | 'power_saver';

export const MESH_POWER_MODES: MeshPowerMode[] = [
  'performance',
  'balanced',
  'power_saver',
];

type MeshPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'prompt-with-rationale';

/** What the native status adds to the SDK's view of the node. */
export interface MeshNativeStatus extends MeshNodeStatus {
  /** Bluetooth links the radio holds, handshake done or not. */
  radioLinks?: number;
  /** Whether this build runs the Rust node rather than the in-memory stub. */
  rustCore?: boolean;
}

/**
 * Native offline mesh node: the Rust gossip node embedded in the phone, with
 * a Bluetooth radio (Android: `net.massa.gossip.mesh`, iOS:
 * `plugins/meshNode`). The SDK talks to it through `MeshNodeProtocol`; the
 * extra methods here are app-level controls.
 */
export interface MeshNodeNativePlugin extends MeshNodePlugin {
  start(options?: {
    config?: Record<string, unknown>;
    powerMode?: MeshPowerMode;
  }): Promise<void>;
  setPowerMode(options: { powerMode: MeshPowerMode }): Promise<void>;
  status(): Promise<MeshNativeStatus>;
  /** Android: `bluetooth` (12+) and `location` (before 12). iOS: `bluetooth`. */
  checkPermissions(): Promise<Record<string, MeshPermissionState>>;
  /**
   * What this build can do, before the node is started, and the id of this
   * installation, which backups do not carry.
   */
  capabilities(): Promise<{ rustCore: boolean; installId?: string }>;
  /**
   * Makes the node stop serving the key set it published under `hash`;
   * `forgotten` is false when it held none.
   */
  forgetKeys(options: { hash: string }): Promise<{ forgotten?: boolean }>;
  addListener(
    event: 'arrival',
    handler: Parameters<MeshNodePlugin['addListener']>[1]
  ): Promise<{ remove(): Promise<void> }>;
  addListener(
    event: 'status',
    handler: (status: { links: number }) => void
  ): Promise<{ remove(): Promise<void> }>;
}

export const MeshNode = registerPlugin<MeshNodeNativePlugin>('MeshNode');

const MESH_ENABLED_KEY = 'gossip-mesh-enabled';
const MESH_BRIDGE_KEY = 'gossip-mesh-bridge';
const MESH_POWER_MODE_KEY = 'gossip-mesh-power-mode';

export interface MeshSettings {
  enabled: boolean;
  /** Upload other phones' mesh blobs to the internet and fetch theirs. */
  bridgeEnabled: boolean;
  powerMode: MeshPowerMode;
}

/** Whether the native build carries the Rust node; null until probed. */
let rustCoreAvailable: boolean | null = null;

/** This installation's id from the native side, which backups do not carry. */
let installId: string | null = null;

/**
 * Asks the native plugin whether this build carries the Rust node. Without
 * it the mesh is hidden: the stand-in core relays nothing, and a radio that
 * advertises without relaying only makes the phone visible.
 */
export async function probeMeshAvailability(): Promise<boolean> {
  if (!MESH_FEATURE_ENABLED || !Capacitor.isNativePlatform()) {
    rustCoreAvailable = false;
    return false;
  }
  try {
    const capabilities = await MeshNode.capabilities();
    rustCoreAvailable = capabilities.rustCore;
    installId = capabilities.installId || null;
  } catch {
    rustCoreAvailable = false;
  }
  return rustCoreAvailable;
}

/**
 * Whether this build and platform can run the mesh at all; false until
 * `probeMeshAvailability` found the Rust node.
 */
export function isMeshAvailable(): boolean {
  return (
    MESH_FEATURE_ENABLED &&
    Capacitor.isNativePlatform() &&
    rustCoreAvailable === true
  );
}

export async function getMeshSettings(): Promise<MeshSettings> {
  if (!isMeshAvailable()) {
    return { enabled: false, bridgeEnabled: false, powerMode: 'balanced' };
  }
  const [enabled, bridge, mode] = await Promise.all([
    Preferences.get({ key: MESH_ENABLED_KEY }),
    Preferences.get({ key: MESH_BRIDGE_KEY }),
    Preferences.get({ key: MESH_POWER_MODE_KEY }),
  ]);
  return {
    enabled: enabled.value === 'true',
    // the consent names the installation it was given on: a phone restored
    // from a backup, or a value from before, is asked again
    bridgeEnabled: installId !== null && bridge.value === installId,
    powerMode: MESH_POWER_MODES.includes(mode.value as MeshPowerMode)
      ? (mode.value as MeshPowerMode)
      : 'balanced',
  };
}

/** The user's choice; off until the settings screen turns it on. */
export async function isMeshEnabled(): Promise<boolean> {
  return (await getMeshSettings()).enabled;
}

/**
 * The mesh member of the SDK's composite transport. It exists for the whole
 * app run, so the user can turn the mesh on and off without rebuilding the
 * SDK: while off it fails every call, which the composite treats as an
 * unreachable transport.
 */
class SwitchableMeshProtocol implements IMessageProtocol {
  private active = false;
  private wanted: Uint8Array[] = [];
  private localWanted: Uint8Array[] = [];

  constructor(readonly mesh: MeshNodeProtocol) {}

  get isActive(): boolean {
    return this.active;
  }

  /** Starts serving, and gives the node the seekers the SDK last asked for. */
  async activate(): Promise<void> {
    this.active = true;
    if (this.wanted.length > 0 || this.localWanted.length > 0) {
      await this.mesh.setWantedSeekers(this.wanted, this.localWanted);
    }
  }

  deactivate(): void {
    this.active = false;
  }

  private use(): MeshNodeProtocol {
    if (!this.active) throw new Error('The offline mesh is off');
    return this.mesh;
  }

  isMeshEnabled(): boolean {
    return this.active;
  }

  // the node is all mesh: mesh-only routing only marks what it sends local-only
  async fetchMessages(seekers: Uint8Array[]): Promise<EncryptedMessage[]> {
    return this.use().fetchMessages(seekers);
  }

  async sendMessage(
    message: EncryptedMessage,
    routing?: MessageRouting
  ): Promise<void> {
    return this.use().sendMessage(message, routing);
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<string> {
    return this.use().sendAnnouncement(announcement);
  }

  async fetchAnnouncements(
    limit?: number,
    cursor?: string
  ): Promise<BulletinItem[]> {
    return this.use().fetchAnnouncements(limit, cursor);
  }

  async fetchBulletinCounter(): Promise<string> {
    return this.use().fetchBulletinCounter();
  }

  changeNode(): ReturnType<IMessageProtocol['changeNode']> {
    return this.mesh.changeNode();
  }

  async setWantedSeekers(
    seekers: Uint8Array[],
    localSeekers: Uint8Array[] = []
  ): Promise<void> {
    this.wanted = seekers;
    this.localWanted = localSeekers;
    if (this.active) await this.mesh.setWantedSeekers(seekers, localSeekers);
  }

  getConnectivity(): TransportConnectivity {
    return this.active ? this.mesh.getConnectivity() : 'offline';
  }
}

let switchable: SwitchableMeshProtocol | null = null;

export interface MeshTransport {
  messageProtocol: IMessageProtocol;
  mesh: MeshNodeProtocol;
}

/**
 * The transports for SDK init where the mesh is available: the REST node
 * first (its bulletin cursor is the one the SDK stores), the mesh second,
 * switched on and off by `startMesh` / `stopMesh`. Null elsewhere: the SDK
 * then builds its default REST transport.
 */
export function createMeshTransport(): MeshTransport | null {
  if (!isMeshAvailable()) return null;
  const mesh = new MeshNodeProtocol(MeshNode);
  switchable = new SwitchableMeshProtocol(mesh);
  const rest = new RestMessageProtocol(
    protocolConfig.baseUrl,
    protocolConfig.timeout,
    protocolConfig.retryAttempts
  );
  return {
    mesh,
    messageProtocol: new CompositeMessageProtocol(
      { protocol: rest, kind: 'internet' },
      [{ protocol: switchable, kind: 'mesh' }]
    ),
  };
}

/** Whether the node runs and the SDK uses it. */
export function isMeshActive(): boolean {
  return switchable?.isActive ?? false;
}

/**
 * Starts the native node with the saved settings (asking for the Bluetooth
 * permissions first) and puts it in the SDK's transports. Throws when it
 * cannot start: permission refused, no Bluetooth.
 */
export async function startMesh(): Promise<void> {
  if (!switchable) throw new Error('The offline mesh is not available');
  const settings = await getMeshSettings();
  await MeshNode.start({ powerMode: settings.powerMode });
  await MeshNode.setUpstream({
    urls: [protocolConfig.baseUrl],
    bridgeEnabled: settings.bridgeEnabled,
  });
  await switchable.activate();
}

export async function stopMesh(): Promise<void> {
  await stopSharingKeysNearby();
  switchable?.deactivate();
  if (isMeshAvailable()) await MeshNode.stop().catch(() => undefined);
}

/**
 * Saves the choice and applies it now. Turning it on fails (and stays off)
 * when the node cannot start, so the caller can show why.
 */
export async function setMeshEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    await startMesh();
  } else {
    await stopMesh();
  }
  await Preferences.set({ key: MESH_ENABLED_KEY, value: String(enabled) });
}

export async function setMeshBridgeEnabled(enabled: boolean): Promise<void> {
  if (enabled && installId === null) {
    throw new Error('Bridging needs the native mesh node');
  }
  await Preferences.set({
    key: MESH_BRIDGE_KEY,
    value: enabled ? installId! : 'false',
  });
  if (isMeshActive()) {
    await MeshNode.setUpstream({
      urls: [protocolConfig.baseUrl],
      bridgeEnabled: enabled,
    });
  }
}

export async function setMeshPowerMode(
  powerMode: MeshPowerMode
): Promise<void> {
  await Preferences.set({ key: MESH_POWER_MODE_KEY, value: powerMode });
  if (isMeshActive()) await MeshNode.setPowerMode({ powerMode });
}

/** The node's status, or null when it does not run. */
export async function getMeshStatus(): Promise<MeshNativeStatus | null> {
  if (!isMeshActive()) return null;
  try {
    return await MeshNode.status();
  } catch {
    return null;
  }
}

/**
 * Public keys of `userId` from the mesh's key pool, without any server: the
 * pool indexes key sets by `blake3(keys)`, which is the user id, and the
 * keys are checked against it again here, so a phone nearby cannot pass off
 * other keys. Null when the mesh is off or nobody nearby published them.
 */
export async function fetchKeysFromMesh(
  userId: string
): Promise<UserPublicKeys | null> {
  if (!switchable?.isActive) return null;
  const bytes = await switchable.mesh.getKeys(decodeUserId(userId));
  if (!bytes) return null;
  let keys: UserPublicKeys;
  try {
    keys = UserPublicKeys.from_bytes(bytes);
  } catch {
    return null;
  }
  if (encodeUserId(keys.derive_id()) !== userId) {
    keys.free();
    return null;
  }
  return keys;
}

/** How long "let people nearby add me" keeps our keys on the mesh. */
export const SHARE_KEYS_NEARBY_MS = 10 * 60 * 1000;

let sharedKeys: {
  userId: string;
  until: number;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/** Until when our keys are shared nearby, or null. */
export function keysSharedNearbyUntil(): number | null {
  return sharedKeys ? sharedKeys.until : null;
}

/**
 * Publishes our public keys to the mesh for a few minutes, so someone nearby
 * who scanned our QR code can add us without a server. Only on the user's
 * request: whoever receives the keys can tie this phone, and where it is, to
 * our user id.
 */
export async function shareKeysNearby(
  sdk: GossipSdk,
  durationMs: number = SHARE_KEYS_NEARBY_MS
): Promise<number> {
  if (!switchable?.isActive || !sdk.isSessionOpen) {
    throw new Error('The offline mesh is off');
  }
  await stopSharingKeysNearby();
  await switchable.mesh.publishKeys(new Uint8Array(sdk.publicKeys.to_bytes()));
  const until = Date.now() + durationMs;
  sharedKeys = {
    userId: sdk.userId,
    until,
    timer: setTimeout(() => void stopSharingKeysNearby(), durationMs),
  };
  return until;
}

/** Stops serving the keys `shareKeysNearby` published, if any. */
export async function stopSharingKeysNearby(): Promise<void> {
  const shared = sharedKeys;
  if (!shared) return;
  sharedKeys = null;
  clearTimeout(shared.timer);
  try {
    // neighbours that took a copy keep it for their retention
    await switchable?.mesh.forgetKeys(decodeUserId(shared.userId));
  } catch (error) {
    // the node is off (it then serves nothing) or the call failed; an
    // account change wipes the node either way
    if (import.meta.env.DEV) {
      logger.warn('[MeshNode] could not withdraw our keys', error);
    }
  }
}

/**
 * Clears the node when the account changes or goes away, so it no longer
 * serves the previous account's keys or waits on its seekers, which would
 * tie the two accounts together.
 */
export async function wipeMeshForAccountChange(): Promise<void> {
  await stopSharingKeysNearby();
  if (!isMeshAvailable()) return;
  try {
    await MeshNode.wipe();
  } catch (error) {
    if (import.meta.env.DEV) {
      logger.warn('[MeshNode] failed to wipe the node', error);
    }
  }
}

/**
 * Feeds what the node pushes (messages for our wanted seekers, relayed
 * announcements) to the SDK. Arrivals while no session is open are dropped
 * here: the node keeps them, and the next fetch after login reads them.
 */
export async function attachMeshArrivals(
  sdk: GossipSdk,
  mesh: MeshNodeProtocol
): Promise<{ remove(): Promise<void> }> {
  return mesh.onArrival(({ messages, announcements }) => {
    if (!sdk.isSessionOpen) return;
    if (messages.length > 0) {
      sdk.messages.ingestMessages(messages).catch(error => {
        if (import.meta.env.DEV) {
          logger.warn('[MeshNode] failed to ingest messages', error);
        }
      });
    }
    if (announcements.length > 0) {
      sdk.announcements.ingestAnnouncements(announcements).catch(error => {
        if (import.meta.env.DEV) {
          logger.warn('[MeshNode] failed to ingest announcements', error);
        }
      });
    }
  });
}
