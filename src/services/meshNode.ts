import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  CompositeMessageProtocol,
  MeshNodeProtocol,
  RestMessageProtocol,
  type GossipSdk,
  type IMessageProtocol,
  type MeshNodePlugin,
} from '@massalabs/gossip-sdk';
import { MESH_FEATURE_ENABLED } from '../config/features';
import { protocolConfig } from '../config/protocol';
import { logger } from '../utils/logger';

export type MeshPowerMode = 'performance' | 'balanced' | 'power_saver';

type MeshPermissionState =
  | 'granted'
  | 'denied'
  | 'prompt'
  | 'prompt-with-rationale';

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
  /** Android: `bluetooth` (12+) and `location` (before 12). iOS: `bluetooth`. */
  checkPermissions(): Promise<Record<string, MeshPermissionState>>;
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

/** Whether this build and platform can run the mesh at all. */
export function isMeshAvailable(): boolean {
  return MESH_FEATURE_ENABLED && Capacitor.isNativePlatform();
}

/** The user's choice; off until the settings screen turns it on. */
export async function isMeshEnabled(): Promise<boolean> {
  if (!isMeshAvailable()) return false;
  const { value } = await Preferences.get({ key: MESH_ENABLED_KEY });
  return value === 'true';
}

/** Takes effect at the next app start, when the message transports are built. */
export async function setMeshEnabled(enabled: boolean): Promise<void> {
  await Preferences.set({ key: MESH_ENABLED_KEY, value: String(enabled) });
  if (!enabled && isMeshAvailable()) {
    await MeshNode.stop().catch(() => undefined);
  }
}

export interface MeshTransport {
  messageProtocol: IMessageProtocol;
  mesh: MeshNodeProtocol;
}

/**
 * Starts the native node and returns the transports for SDK init: the REST
 * node first (its bulletin cursor is the one the SDK stores), the mesh second.
 * Null when the mesh is off or cannot start (no Bluetooth permission, no
 * Bluetooth hardware): the app then runs on REST alone, as before.
 */
export async function startMeshTransport(): Promise<MeshTransport | null> {
  if (!(await isMeshEnabled())) return null;
  try {
    await MeshNode.start({ powerMode: 'balanced' });
    // Upload as a bridge only once the user opts in; the setting comes with the mesh UX.
    await MeshNode.setUpstream({
      urls: [protocolConfig.baseUrl],
      bridgeEnabled: false,
    });
  } catch (error) {
    if (import.meta.env.DEV) {
      logger.warn('[MeshNode] mesh not started', error);
    }
    return null;
  }
  const mesh = new MeshNodeProtocol(MeshNode);
  const rest = new RestMessageProtocol(
    protocolConfig.baseUrl,
    protocolConfig.timeout,
    protocolConfig.retryAttempts
  );
  return {
    mesh,
    messageProtocol: new CompositeMessageProtocol(
      { protocol: rest, kind: 'internet' },
      [{ protocol: mesh, kind: 'mesh' }]
    ),
  };
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
