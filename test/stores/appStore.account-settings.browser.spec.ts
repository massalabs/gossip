import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateSettings = vi.hoisted(() => vi.fn());
const getDomains = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/mns', () => ({
  mnsService: { getDomainsFromGossipId: getDomains },
}));

vi.mock('../../src/stores/sdkStore', () => ({
  getSdk: () => ({
    queries: {
      accountSettings: { update: updateSettings },
    },
  }),
}));

import { useAppStore } from '../../src/stores/appStore';
import { STORAGE_KEYS } from '../../src/utils/localStorage';

describe('encrypted account settings runtime state', () => {
  beforeEach(() => {
    updateSettings.mockReset();
    getDomains.mockReset();
    useAppStore.getState().resetAccountSettings();
  });

  it('updates runtime MNS state only after the durable row resolves', async () => {
    let resolveUpdate:
      | ((settings: {
          userId: string;
          formatVersion: 1;
          mnsEnabled: boolean;
          defaultRetentionDuration: number | null;
        }) => void)
      | undefined;
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1settings',
      formatVersion: 1,
      mnsEnabled: false,
      defaultRetentionDuration: 2_592_000,
    });
    updateSettings.mockReturnValue(
      new Promise(resolve => {
        resolveUpdate = resolve;
      })
    );

    const pending = useAppStore.getState().setMnsEnabled(true);
    expect(useAppStore.getState().mnsEnabled).toBe(false);
    resolveUpdate?.({
      userId: 'gossip1settings',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: 2_592_000,
    });
    await pending;

    expect(updateSettings).toHaveBeenCalledWith('gossip1settings', {
      mnsEnabled: true,
    });
    expect(useAppStore.getState().mnsEnabled).toBe(true);
  });

  it('ignores a durable completion after the active account changes', async () => {
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1alice',
      formatVersion: 1,
      mnsEnabled: false,
      defaultRetentionDuration: 2_592_000,
    });
    let resolveUpdate:
      | ((settings: {
          userId: string;
          formatVersion: 1;
          mnsEnabled: boolean;
          defaultRetentionDuration: number | null;
        }) => void)
      | undefined;
    updateSettings.mockReturnValue(
      new Promise(resolve => {
        resolveUpdate = resolve;
      })
    );
    const pending = useAppStore.getState().setMnsEnabled(true);
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1bob',
      formatVersion: 1,
      mnsEnabled: false,
      defaultRetentionDuration: null,
    });
    resolveUpdate?.({
      userId: 'gossip1alice',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: 2_592_000,
    });
    await pending;

    expect(useAppStore.getState()).toMatchObject({
      activeAccountSettingsUserId: 'gossip1bob',
      mnsEnabled: false,
      defaultRetentionDuration: null,
    });
  });

  it('does not apply an MNS lookup after the account changes', async () => {
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1alice',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: 2_592_000,
    });
    let resolveDomains: ((domains: string[]) => void) | undefined;
    getDomains.mockReturnValue(
      new Promise(resolve => {
        resolveDomains = resolve;
      })
    );
    const pending = useAppStore
      .getState()
      .fetchMnsDomains({ userId: 'gossip1alice' } as never, {} as never);
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1bob',
      formatVersion: 1,
      mnsEnabled: false,
      defaultRetentionDuration: null,
    });
    resolveDomains?.(['alice']);
    await pending;

    expect(useAppStore.getState().mnsDomains).toEqual([]);
  });

  it('does not repopulate domains after MNS is disabled', async () => {
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1alice',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: 2_592_000,
    });
    let resolveDomains: ((domains: string[]) => void) | undefined;
    getDomains.mockReturnValue(
      new Promise(resolve => {
        resolveDomains = resolve;
      })
    );
    const pendingLookup = useAppStore
      .getState()
      .fetchMnsDomains({ userId: 'gossip1alice' } as never, {} as never);
    updateSettings.mockResolvedValue({
      userId: 'gossip1alice',
      formatVersion: 1,
      mnsEnabled: false,
      defaultRetentionDuration: 2_592_000,
    });
    await useAppStore.getState().setMnsEnabled(false);
    resolveDomains?.(['alice']);
    await pendingLookup;

    expect(useAppStore.getState()).toMatchObject({
      mnsEnabled: false,
      mnsDomains: [],
    });
  });

  it('does not persist encrypted account settings in local storage', () => {
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1settings',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: null,
    });

    const persisted = JSON.parse(
      localStorage.getItem(STORAGE_KEYS.APP_STORE) ?? '{}'
    ) as { state?: Record<string, unknown> };
    expect(persisted.state).not.toHaveProperty('mnsEnabled');
    expect(persisted.state).not.toHaveProperty('mnsDomains');
    expect(persisted.state).not.toHaveProperty('defaultRetentionDuration');
  });

  it('hydrates, durably updates, and resets retention state', async () => {
    useAppStore.getState().hydrateAccountSettings({
      userId: 'gossip1settings',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: null,
    });
    expect(useAppStore.getState()).toMatchObject({
      mnsEnabled: true,
      defaultRetentionDuration: null,
      mnsDomains: [],
    });

    updateSettings.mockResolvedValue({
      userId: 'gossip1settings',
      formatVersion: 1,
      mnsEnabled: true,
      defaultRetentionDuration: 86_400,
    });
    await useAppStore.getState().setDefaultRetentionDuration(86_400);
    expect(useAppStore.getState().defaultRetentionDuration).toBe(86_400);

    useAppStore.getState().resetAccountSettings();
    expect(useAppStore.getState()).toMatchObject({
      mnsEnabled: false,
      defaultRetentionDuration: 2_592_000,
      mnsDomains: [],
    });
  });
});
