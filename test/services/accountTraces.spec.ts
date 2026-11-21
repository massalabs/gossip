import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  native: false,
  calls: [] as string[],
  bridge: new Map<string, unknown>([['accountOutputGeneration', 4]]),
  blockGate: null as Promise<void> | null,
  failNotifications: false,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock('../../src/services/index', () => ({
  suspendSdkEventOutputs: async () => {
    mocks.calls.push('suspend');
    return 7;
  },
  resumeSdkEventOutputs: () => mocks.calls.push('resume'),
}));
vi.mock('../../src/utils/preferences', () => ({
  blockAccountLinkedSyncState: async (epoch: number) => {
    mocks.calls.push(`block:${epoch}`);
    if (mocks.blockGate) await mocks.blockGate;
  },
  clearAccountLinkedSyncState: async () => mocks.calls.push('clearPrefs'),
}));
vi.mock('../../src/sw-bridge', () => ({
  bridgeGet: async (key: string) => mocks.bridge.get(key),
  bridgeSetMany: async (entries: Array<[string, unknown]>) => {
    mocks.calls.push('bridge');
    for (const [key, value] of entries) mocks.bridge.set(key, value);
  },
}));
vi.mock('../../src/services/notifications', () => ({
  notificationService: {
    clearAllNotifications: async () => {
      mocks.calls.push('notifications');
      if (mocks.failNotifications) throw new Error('denied');
    },
  },
}));
vi.mock('../../src/stores/useDebugLogs', () => ({
  clearDebugLogsDurably: async () => mocks.calls.push('logs'),
}));

import {
  admitAccountOutputs,
  clearAccountTraces,
} from '../../src/services/accountTraces';

beforeEach(() => {
  mocks.native = false;
  mocks.calls.length = 0;
  mocks.bridge = new Map<string, unknown>([
    ['accountOutputGeneration', 4],
    ['activeSeekers', [[1, 2, 3]]],
    ['lastSyncTimestamp', 123],
  ]);
  mocks.blockGate = null;
  mocks.failNotifications = false;
});

describe('clearAccountTraces', () => {
  it('on web, empties the service-worker bridge and everything else, logs last', async () => {
    await clearAccountTraces();
    expect(mocks.calls).toEqual([
      'suspend',
      'bridge',
      'clearPrefs',
      'notifications',
      'logs',
    ]);
    expect(mocks.bridge.get('activeSeekers')).toEqual([]);
    expect(mocks.bridge.get('lastSyncTimestamp')).toBe(0);
    // A new generation turns away writes still in flight for the old owner.
    expect(mocks.bridge.get('accountOutputGeneration')).toBe(5);
  });

  it('on native, blocks background sync before clearing it', async () => {
    mocks.native = true;
    await clearAccountTraces();
    expect(mocks.calls).toEqual([
      'suspend',
      'block:7',
      'clearPrefs',
      'notifications',
      'logs',
    ]);
  });

  it('keeps going past a failing step and never rejects', async () => {
    mocks.failNotifications = true;
    await expect(clearAccountTraces()).resolves.toBeUndefined();
    expect(mocks.calls.at(-1)).toBe('logs');
  });

  it('makes the next login wait until the traces are gone', async () => {
    mocks.native = true;
    let release!: () => void;
    mocks.blockGate = new Promise(resolve => {
      release = resolve;
    });
    void clearAccountTraces();
    const login = admitAccountOutputs({} as never);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.calls).not.toContain('resume');
    release();
    await login;
    expect(mocks.calls.indexOf('resume')).toBeGreaterThan(
      mocks.calls.indexOf('logs')
    );
  });
});
