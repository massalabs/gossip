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
    rustCore: true,
    installId: 'install-1',
  };
  const plugin = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setUpstream: vi.fn(async () => undefined),
    setPowerMode: vi.fn(async () => undefined),
    setWanted: vi.fn(async () => undefined),
    getKeys: vi.fn(async () => ({ keys: state.keys })),
    status: vi.fn(async () => ({ running: true, meshPeers: 2 })),
    capabilities: vi.fn(async () => ({
      rustCore: state.rustCore,
      installId: state.installId,
    })),
    sendBlob: vi.fn(async () => ({ id: 'aWQ=' })),
    wipe: vi.fn(async () => undefined),
    lock: vi.fn(async () => undefined),
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
    remove: async ({ key }: { key: string }) => {
      mocks.state.preferences.delete(key);
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
  type GossipSdk,
} from '@massalabs/gossip-sdk';
import {
  attachMeshArrivals,
  createMeshTransport,
  getMeshSettings,
  isMeshActive,
  isMeshAvailable,
  probeMeshAvailability,
  setMeshBridgeEnabled,
  setMeshEnabled,
  setMeshPowerMode,
  lockMesh,
  wipeMesh,
} from '../../src/services/meshNode';

const seeker = new Uint8Array([1, 2]);

describe('mesh transport', () => {
  beforeEach(async () => {
    mocks.state.featureEnabled = true;
    mocks.state.rustCore = true;
    mocks.state.installId = 'install-1';
    mocks.state.preferences.clear();
    mocks.state.arrival = null;
    mocks.state.keys = undefined;
    vi.clearAllMocks();
    await probeMeshAvailability();
  });

  it('gives no transport when the build has no mesh', async () => {
    mocks.state.featureEnabled = false;
    await probeMeshAvailability();
    expect(createMeshTransport()).toBeNull();
  });

  it('hides the mesh when the build has only the stand-in core', async () => {
    mocks.state.rustCore = false;
    expect(await probeMeshAvailability()).toBe(false);
    expect(isMeshAvailable()).toBe(false);
    expect(createMeshTransport()).toBeNull();
    expect((await getMeshSettings()).enabled).toBe(false);
  });

  it('publishes no keys when the mesh turns on', async () => {
    createMeshTransport();
    await setMeshEnabled(true);
    expect(mocks.plugin.sendBlob).not.toHaveBeenCalled();
  });

  it('asks for bridging again on a phone restored from a backup', async () => {
    createMeshTransport();
    await setMeshBridgeEnabled(true);
    expect((await getMeshSettings()).bridgeEnabled).toBe(true);

    // same preferences, new installation
    mocks.state.installId = 'install-2';
    await probeMeshAvailability();
    expect((await getMeshSettings()).bridgeEnabled).toBe(false);
  });

  it('locks the node without wiping it, and drops what it shared', async () => {
    const transport = createMeshTransport()!;
    await setMeshEnabled(true);
    await transport.messageProtocol.setWantedSeekers?.([new Uint8Array([1])]);
    await lockMesh();
    expect(mocks.plugin.lock).toHaveBeenCalledOnce();
    expect(mocks.plugin.wipe).not.toHaveBeenCalled();
    // the next account's session starts from an empty wanted list
    mocks.plugin.setWanted.mockClear();
    await setMeshEnabled(false);
    await setMeshEnabled(true);
    expect(mocks.plugin.setWanted).not.toHaveBeenCalled();
  });

  it('deletes the account a development build recorded in the clear', async () => {
    mocks.state.preferences.set('gossip-mesh-owner', 'alice');
    await probeMeshAvailability();
    expect(mocks.state.preferences.has('gossip-mesh-owner')).toBe(false);
  });

  it('sets the upstream again and drops old seekers after a wipe of a running node', async () => {
    const transport = createMeshTransport()!;
    await setMeshEnabled(true);
    await transport.messageProtocol.setWantedSeekers?.([new Uint8Array([1])]);
    mocks.plugin.setUpstream.mockClear();
    mocks.plugin.setWanted.mockClear();

    expect(await wipeMesh()).toBe(true);
    expect(mocks.plugin.setUpstream).toHaveBeenCalledOnce();
    expect(mocks.plugin.setWanted).not.toHaveBeenCalled();
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
