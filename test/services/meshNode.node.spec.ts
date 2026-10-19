import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type ArrivalHandler = (arrival: {
    messages: { seeker: string; ciphertext: string }[];
    announcements: string[];
  }) => void;
  const state = {
    featureEnabled: true,
    preferences: new Map<string, string>(),
    arrival: null as ArrivalHandler | null,
    keys: undefined as string | undefined,
  };
  const plugin = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setUpstream: vi.fn(async () => undefined),
    setPowerMode: vi.fn(async () => undefined),
    setWanted: vi.fn(async () => undefined),
    getKeys: vi.fn(async () => ({ keys: state.keys })),
    status: vi.fn(async () => ({ running: true, meshPeers: 2 })),
    addListener: vi.fn(async (_event: string, handler: ArrivalHandler) => {
      state.arrival = handler;
      return { remove: async () => undefined };
    }),
  };
  return { state, plugin };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true },
  registerPlugin: () => mocks.plugin,
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: mocks.state.preferences.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      mocks.state.preferences.set(key, value);
    },
  },
}));

vi.mock('../../src/config/features', () => ({
  get MESH_FEATURE_ENABLED() {
    return mocks.state.featureEnabled;
  },
}));

import {
  CompositeMessageProtocol,
  MeshNodeProtocol,
  encodeUserId,
  type GossipSdk,
} from '@massalabs/gossip-sdk';
import {
  attachMeshArrivals,
  createMeshTransport,
  fetchKeysFromMesh,
  getMeshSettings,
  isMeshActive,
  setMeshBridgeEnabled,
  setMeshEnabled,
  setMeshPowerMode,
} from '../../src/services/meshNode';

const seeker = new Uint8Array([1, 2]);

describe('mesh transport', () => {
  beforeEach(() => {
    mocks.state.featureEnabled = true;
    mocks.state.preferences.clear();
    mocks.state.arrival = null;
    mocks.state.keys = undefined;
    vi.clearAllMocks();
  });

  it('gives no transport when the build has no mesh', () => {
    mocks.state.featureEnabled = false;
    expect(createMeshTransport()).toBeNull();
  });

  it('composes REST then a mesh member that stays off until turned on', async () => {
    const transport = createMeshTransport()!;
    expect(transport.messageProtocol).toBeInstanceOf(CompositeMessageProtocol);
    expect(transport.mesh).toBeInstanceOf(MeshNodeProtocol);
    expect(isMeshActive()).toBe(false);
    // the SDK's wanted seekers wait for the node
    await transport.messageProtocol.setWantedSeekers?.([seeker]);
    expect(mocks.plugin.setWanted).not.toHaveBeenCalled();
    expect(mocks.plugin.start).not.toHaveBeenCalled();
  });

  it('starts the node with the saved settings when turned on', async () => {
    const transport = createMeshTransport()!;
    await transport.messageProtocol.setWantedSeekers?.([seeker]);
    await setMeshPowerMode('power_saver');
    await setMeshEnabled(true);

    expect(isMeshActive()).toBe(true);
    expect(mocks.plugin.start).toHaveBeenCalledWith({
      powerMode: 'power_saver',
    });
    expect(mocks.plugin.setUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeEnabled: false })
    );
    expect(mocks.plugin.setWanted).toHaveBeenCalledOnce();
    expect((await getMeshSettings()).enabled).toBe(true);

    await setMeshBridgeEnabled(true);
    expect(mocks.plugin.setUpstream).toHaveBeenLastCalledWith(
      expect.objectContaining({ bridgeEnabled: true })
    );
  });

  it('stays off and unsaved when the node cannot start', async () => {
    createMeshTransport();
    mocks.plugin.start.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    await expect(setMeshEnabled(true)).rejects.toThrow('PERMISSION_DENIED');
    expect(isMeshActive()).toBe(false);
    expect((await getMeshSettings()).enabled).toBe(false);
  });

  it('stops the node when the user turns the mesh off', async () => {
    createMeshTransport();
    await setMeshEnabled(true);
    await setMeshEnabled(false);
    expect(mocks.plugin.stop).toHaveBeenCalledOnce();
    expect(isMeshActive()).toBe(false);
  });

  it('finds no keys when the mesh is off, has none, or has unreadable ones', async () => {
    const userId = encodeUserId(new Uint8Array(32).fill(7));
    createMeshTransport();
    expect(await fetchKeysFromMesh(userId)).toBeNull();

    await setMeshEnabled(true);
    expect(await fetchKeysFromMesh(userId)).toBeNull();
    expect(mocks.plugin.getKeys).toHaveBeenCalledOnce();

    mocks.state.keys = btoa('not keys');
    expect(await fetchKeysFromMesh(userId)).toBeNull();
  });

  it('feeds arrivals to the SDK only while a session is open', async () => {
    const transport = createMeshTransport()!;
    const ingestMessages = vi.fn(async () => 1);
    const ingestAnnouncements = vi.fn(async () => ({
      success: true,
      newAnnouncementsCount: 0,
    }));
    const sdk = {
      isSessionOpen: false,
      messages: { ingestMessages },
      announcements: { ingestAnnouncements },
    };
    await attachMeshArrivals(sdk as unknown as GossipSdk, transport.mesh);

    const arrival = {
      messages: [{ seeker: btoa('\x01\x02'), ciphertext: btoa('\x03') }],
      announcements: [btoa('\x04\x05')],
    };
    mocks.state.arrival!(arrival);
    expect(ingestMessages).not.toHaveBeenCalled();

    sdk.isSessionOpen = true;
    mocks.state.arrival!(arrival);
    expect(ingestMessages).toHaveBeenCalledWith([
      { seeker: new Uint8Array([1, 2]), ciphertext: new Uint8Array([3]) },
    ]);
    expect(ingestAnnouncements).toHaveBeenCalledWith([new Uint8Array([4, 5])]);
  });
});
