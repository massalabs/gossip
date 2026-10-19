import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  type ArrivalHandler = (arrival: {
    messages: { seeker: string; ciphertext: string }[];
    announcements: string[];
  }) => void;
  const state = {
    featureEnabled: true,
    preference: null as string | null,
    arrival: null as ArrivalHandler | null,
  };
  const plugin = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setUpstream: vi.fn(async () => undefined),
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
    get: async () => ({ value: mocks.state.preference }),
    set: async ({ value }: { value: string }) => {
      mocks.state.preference = value;
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
  setMeshEnabled,
  startMeshTransport,
} from '../../src/services/meshNode';

describe('mesh transport', () => {
  beforeEach(() => {
    mocks.state.featureEnabled = true;
    mocks.state.preference = null;
    mocks.state.arrival = null;
    vi.clearAllMocks();
  });

  it('stays on REST alone until the user turns the mesh on', async () => {
    expect(await startMeshTransport()).toBeNull();
    expect(mocks.plugin.start).not.toHaveBeenCalled();
  });

  it('stays on REST alone when the build has no mesh', async () => {
    mocks.state.featureEnabled = false;
    mocks.state.preference = 'true';
    expect(await startMeshTransport()).toBeNull();
    expect(mocks.plugin.start).not.toHaveBeenCalled();
  });

  it('starts the node, without bridging, and composes REST then mesh', async () => {
    await setMeshEnabled(true);
    const transport = await startMeshTransport();
    expect(transport).not.toBeNull();
    expect(transport!.messageProtocol).toBeInstanceOf(CompositeMessageProtocol);
    expect(transport!.mesh).toBeInstanceOf(MeshNodeProtocol);
    expect(mocks.plugin.start).toHaveBeenCalledOnce();
    expect(mocks.plugin.setUpstream).toHaveBeenCalledWith(
      expect.objectContaining({ bridgeEnabled: false })
    );
  });

  it('falls back to REST when the node cannot start', async () => {
    await setMeshEnabled(true);
    mocks.plugin.start.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    expect(await startMeshTransport()).toBeNull();
  });

  it('stops the node when the user turns the mesh off', async () => {
    await setMeshEnabled(false);
    expect(mocks.plugin.stop).toHaveBeenCalledOnce();
  });

  it('feeds arrivals to the SDK only while a session is open', async () => {
    await setMeshEnabled(true);
    const transport = await startMeshTransport();
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
    await attachMeshArrivals(sdk as unknown as GossipSdk, transport!.mesh);

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
