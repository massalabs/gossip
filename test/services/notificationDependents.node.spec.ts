import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = {
    platform: 'android',
    preferences: new Map<string, string>(),
    runnerKv: new Map<string, string>(),
    bridge: new Map<string, unknown>(),
    serviceFlag: false,
    notificationsEnabled: true,
  };
  const foregroundSync = {
    start: vi.fn(async () => {
      state.serviceFlag = true;
    }),
    stop: vi.fn(async () => {
      state.serviceFlag = false;
    }),
    isEnabled: vi.fn(async () => ({ enabled: state.serviceFlag })),
    setSyncPreset: vi.fn(async () => undefined),
  };
  return { state, foregroundSync };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => mocks.state.platform !== 'web',
    getPlatform: () => mocks.state.platform,
  },
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

vi.mock('../../src/services/foregroundSync', () => ({
  ForegroundSync: mocks.foregroundSync,
}));

vi.mock('../../src/services/backgroundRunnerStorage', () => ({
  backgroundRunnerStorageService: {
    set: async (key: string, value: string) => {
      mocks.state.runnerKv.set(key, value);
    },
  },
}));

vi.mock('../../src/services/notifications', () => ({
  notificationService: {
    isEnabled: () => mocks.state.notificationsEnabled,
    setEnabled: (enabled: boolean) => {
      mocks.state.notificationsEnabled = enabled;
    },
  },
}));

vi.mock('../../src/sw-bridge', () => ({
  bridgeSet: async (key: string, value: unknown) => {
    mocks.state.bridge.set(key, value);
  },
}));

import {
  KEEP_SYNC_CHOICE_KEY,
  NOTIFICATIONS_ENABLED_BRIDGE_KEY,
  NOTIFICATIONS_ENABLED_RUNNER_KEY,
  getKeepSyncChoice,
  setKeepSyncChoice,
  setNotificationsEnabled,
  syncNotificationDependents,
} from '../../src/services/notificationDependents';

const { state, foregroundSync } = mocks;

beforeEach(() => {
  state.platform = 'android';
  state.preferences.clear();
  state.runnerKv.clear();
  state.bridge.clear();
  state.serviceFlag = false;
  state.notificationsEnabled = true;
  vi.clearAllMocks();
});

describe('notifications switch governs its dependents', () => {
  it('stops keep sync active when notifications go off, and keeps the choice', async () => {
    await setKeepSyncChoice(true);
    expect(foregroundSync.start).toHaveBeenCalledTimes(1);

    await setNotificationsEnabled(false);

    expect(foregroundSync.stop).toHaveBeenCalledTimes(1);
    expect(state.serviceFlag).toBe(false);
    expect(state.preferences.get(KEEP_SYNC_CHOICE_KEY)).toBe('true');
    expect(await getKeepSyncChoice()).toBe(true);
  });

  it('restarts keep sync active when notifications come back on', async () => {
    await setKeepSyncChoice(true);
    await setNotificationsEnabled(false);
    vi.clearAllMocks();

    await setNotificationsEnabled(true);

    expect(foregroundSync.start).toHaveBeenCalledTimes(1);
    expect(state.serviceFlag).toBe(true);
  });

  it('does not start keep sync active the user had left off', async () => {
    await setKeepSyncChoice(false);
    await setNotificationsEnabled(false);
    await setNotificationsEnabled(true);

    expect(foregroundSync.start).not.toHaveBeenCalled();
    expect(state.serviceFlag).toBe(false);
  });

  it('records a choice made while notifications are off without starting', async () => {
    await setNotificationsEnabled(false);
    await setKeepSyncChoice(true);

    expect(foregroundSync.start).not.toHaveBeenCalled();
    await setNotificationsEnabled(true);
    expect(state.serviceFlag).toBe(true);
  });

  it('keeps the choice of a service left running by an older version', async () => {
    // Before this fix the service could run with notifications off.
    state.serviceFlag = true;
    state.notificationsEnabled = false;

    await syncNotificationDependents();

    expect(foregroundSync.stop).toHaveBeenCalledTimes(1);
    expect(state.preferences.get(KEEP_SYNC_CHOICE_KEY)).toBe('true');
    await setNotificationsEnabled(true);
    expect(state.serviceFlag).toBe(true);
  });

  it('tells the background runner, the last switch position winning', async () => {
    void setNotificationsEnabled(false);
    void setNotificationsEnabled(true);
    await setNotificationsEnabled(false);

    expect(state.runnerKv.get(NOTIFICATIONS_ENABLED_RUNNER_KEY)).toBe('false');
    expect(state.notificationsEnabled).toBe(false);
    expect(state.serviceFlag).toBe(false);
  });

  it('tells the service worker on the web, and never touches the service', async () => {
    state.platform = 'web';

    await setNotificationsEnabled(false);

    expect(state.bridge.get(NOTIFICATIONS_ENABLED_BRIDGE_KEY)).toBe(false);
    expect(state.runnerKv.size).toBe(0);
    expect(foregroundSync.isEnabled).not.toHaveBeenCalled();
    expect(foregroundSync.stop).not.toHaveBeenCalled();
  });

  it('only writes the runner flag on iOS', async () => {
    state.platform = 'ios';

    await setNotificationsEnabled(false);

    expect(state.runnerKv.get(NOTIFICATIONS_ENABLED_RUNNER_KEY)).toBe('false');
    expect(foregroundSync.stop).not.toHaveBeenCalled();
    expect(await getKeepSyncChoice()).toBe(false);
  });
});
