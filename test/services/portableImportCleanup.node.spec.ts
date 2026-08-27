import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  biometric: vi.fn(),
  notifications: vi.fn(),
  sync: vi.fn(),
  bridgeSet: vi.fn(),
  bridgeSetMany: vi.fn(),
  discussion: vi.fn(),
  message: vi.fn(),
  self: vi.fn(),
  resetSettings: vi.fn(),
  clearLegacySettings: vi.fn(),
  deepLink: vi.fn(),
  shared: vi.fn(),
  forward: vi.fn(),
  logs: vi.fn(),
  mns: vi.fn(),
  qrClear: vi.fn(),
}));

vi.mock('../../src/services/biometricService', () => ({
  clearBiometricLoginCredential: mocks.biometric,
}));
vi.mock('../../src/services/notifications', () => ({
  notificationService: { clearAllNotifications: mocks.notifications },
}));
vi.mock('../../src/utils/preferences', () => ({
  clearAccountLinkedSyncState: mocks.sync,
}));
vi.mock('../../src/sw-bridge', () => ({
  bridgeGet: vi.fn().mockResolvedValue(0),
  bridgeSet: mocks.bridgeSet,
  bridgeSetMany: mocks.bridgeSetMany,
}));
vi.mock('../../src/stores/discussionStore', () => ({
  useDiscussionStore: { getState: () => ({ cleanup: mocks.discussion }) },
}));
vi.mock('../../src/stores/messageStore', () => ({
  useMessageStore: { getState: () => ({ cleanup: mocks.message }) },
}));
vi.mock('../../src/stores/selfMessageStore', () => ({
  useSelfMessageStore: { getState: () => ({ clearMessages: mocks.self }) },
}));
vi.mock('../../src/stores/appStore', () => ({
  useAppStore: {
    getState: () => ({
      resetAccountSettings: mocks.resetSettings,
      clearLegacyAccountSettingsMigration: mocks.clearLegacySettings,
      setPendingDeepLinkInfo: mocks.deepLink,
      setPendingSharedContent: mocks.shared,
      setPendingForwardMessageId: mocks.forward,
    }),
  },
}));
vi.mock('../../src/stores/useDebugLogs', () => ({
  clearDebugLogsDurably: mocks.logs,
}));
vi.mock('../../src/services/mns', () => ({
  mnsService: { reset: mocks.mns },
}));
vi.mock('../../src/components/settings/shareContactQrCache', () => ({
  qrCache: { clear: mocks.qrClear },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: { remove: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false },
}));

import {
  isPortableImportCleanupPending,
  markPortableImportCleanupPending,
  runPortableImportPostCommitCleanup,
} from '../../src/services/portableImportCleanup';

describe('portable import post-commit cleanup', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.stubGlobal('sessionStorage', {
      removeItem: vi.fn(),
    });
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.clearAllMocks();
  });

  it('clears every account-linked target and removes its marker last', async () => {
    markPortableImportCleanupPending();
    await runPortableImportPostCommitCleanup();

    expect(mocks.sync).toHaveBeenCalledOnce();
    expect(mocks.bridgeSetMany).toHaveBeenCalledWith([
      ['accountOutputGeneration', 1],
      ['activeSeekers', []],
      ['lastSyncTimestamp', 0],
    ]);
    expect(mocks.discussion).toHaveBeenCalledOnce();
    expect(mocks.message).toHaveBeenCalledOnce();
    expect(mocks.self).toHaveBeenCalledOnce();
    expect(mocks.resetSettings).toHaveBeenCalledOnce();
    expect(mocks.clearLegacySettings).toHaveBeenCalledOnce();
    expect(mocks.deepLink).toHaveBeenCalledWith(null);
    expect(mocks.shared).toHaveBeenCalledWith(null);
    expect(mocks.forward).toHaveBeenCalledWith(null);
    expect(mocks.biometric).toHaveBeenCalledOnce();
    expect(mocks.notifications).toHaveBeenCalledOnce();
    expect(mocks.logs).toHaveBeenCalledOnce();
    expect(isPortableImportCleanupPending()).toBe(false);
  });

  it('attempts later targets and retains recovery after any failure', async () => {
    mocks.sync.mockRejectedValueOnce(new Error('sync cleanup failed'));
    markPortableImportCleanupPending();

    await expect(runPortableImportPostCommitCleanup()).rejects.toThrow(
      'cleanup is incomplete'
    );
    expect(mocks.biometric).toHaveBeenCalledOnce();
    expect(mocks.notifications).toHaveBeenCalledOnce();
    expect(mocks.logs).toHaveBeenCalledOnce();
    expect(isPortableImportCleanupPending()).toBe(true);
  });
});
