import { Capacitor } from '@capacitor/core';

const CLEANUP_PENDING_KEY = 'gossip:portable-import-cleanup-pending-v1';
export const PORTABLE_IMPORT_CLEANUP_EVENT =
  'gossip:portable-import-cleanup-state';

export function markPortableImportCleanupPending(): void {
  localStorage.setItem(CLEANUP_PENDING_KEY, 'pending');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PORTABLE_IMPORT_CLEANUP_EVENT));
  }
}

export function isPortableImportCleanupPending(): boolean {
  return localStorage.getItem(CLEANUP_PENDING_KEY) === 'pending';
}

export function clearPortableImportCleanupPending(): void {
  localStorage.removeItem(CLEANUP_PENDING_KEY);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PORTABLE_IMPORT_CLEANUP_EVENT));
  }
}

export async function blockPortableImportAccountOutputs(): Promise<void> {
  const { suspendSdkEventOutputs } = await import('./index');
  const outputEpoch = await suspendSdkEventOutputs();
  if (Capacitor.isNativePlatform()) {
    const { blockAccountLinkedSyncState } =
      await import('../utils/preferences');
    await blockAccountLinkedSyncState(outputEpoch);
    const { notificationService } = await import('./notifications');
    await notificationService.clearAllNotifications();
    return;
  }
  if (!navigator.locks) {
    throw new Error('Account output fencing is unavailable');
  }
  await navigator.locks.request(
    'gossip-account-output-v1',
    { mode: 'exclusive' },
    async () => {
      const { bridgeGet, bridgeSetMany } = await import('../sw-bridge');
      const generation =
        (await bridgeGet<number>('accountOutputGeneration')) ?? 0;
      await bridgeSetMany([
        ['accountOutputGeneration', generation + 1],
        ['accountCleanupBlocked', true],
      ]);
    }
  );
}

export async function unblockPortableImportAccountOutputs(): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const { backgroundRunnerStorageService } =
      await import('./backgroundRunnerStorage');
    await backgroundRunnerStorageService.setStrict(
      'gossip-account-cleanup-blocked-v1',
      null
    );
    return;
  }
  const { bridgeSet } = await import('../sw-bridge');
  await bridgeSet('accountCleanupBlocked', false);
}

async function clearExternalSeekers(): Promise<void> {
  const { clearAccountLinkedSyncState } = await import('../utils/preferences');
  const operations: Promise<void>[] = [clearAccountLinkedSyncState()];
  if (!Capacitor.isNativePlatform()) {
    operations.push(
      (async () => {
        const { bridgeGet, bridgeSetMany } = await import('../sw-bridge');
        const generation =
          (await bridgeGet<number>('accountOutputGeneration')) ?? 0;
        await bridgeSetMany([
          ['accountOutputGeneration', generation + 1],
          ['activeSeekers', []],
          ['lastSyncTimestamp', 0],
        ]);
      })()
    );
  }
  const results = await Promise.allSettled(operations);
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('External seeker cleanup is incomplete');
  }
}

async function clearRuntimeAccountState(): Promise<void> {
  const [
    { useAppStore },
    { useDiscussionStore },
    { useMessageStore },
    { useSelfMessageStore },
    { mnsService },
    { qrCache },
  ] = await Promise.all([
    import('../stores/appStore'),
    import('../stores/discussionStore'),
    import('../stores/messageStore'),
    import('../stores/selfMessageStore'),
    import('./mns'),
    import('../components/settings/shareContactQrCache'),
  ]);
  const app = useAppStore.getState();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => useDiscussionStore.getState().cleanup()),
    Promise.resolve().then(() => useMessageStore.getState().cleanup()),
    Promise.resolve().then(() =>
      useSelfMessageStore.getState().clearMessages()
    ),
    Promise.resolve().then(() => mnsService.reset()),
    Promise.resolve().then(() => qrCache.clear()),
    Promise.resolve().then(() => app.resetAccountSettings()),
    Promise.resolve().then(() => app.clearLegacyAccountSettingsMigration()),
    Promise.resolve().then(() => app.setPendingDeepLinkInfo(null)),
    Promise.resolve().then(() => app.setPendingSharedContent(null)),
    Promise.resolve().then(() => app.setPendingForwardMessageId(null)),
  ]);
  sessionStorage.removeItem('gossip-app-state');
  localStorage.removeItem('pendingGossipShareUrl');
  const { Preferences } = await import('@capacitor/preferences');
  await Preferences.remove({ key: 'pendingGossipShareUrl' });
  if (results.some(result => result.status === 'rejected')) {
    throw new Error('Runtime account cleanup is incomplete');
  }
}

/**
 * Idempotent destination cleanup after the secure-storage replacement commits.
 * Every target is attempted; the generic marker remains until all durable
 * steps succeed, so startup can retry without exposing account routes.
 */
export async function runPortableImportPostCommitCleanup(): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      failures.push(error);
    }
  };

  await attempt(clearExternalSeekers);
  await attempt(clearRuntimeAccountState);
  await attempt(async () => {
    const { clearBiometricLoginCredential } =
      await import('./biometricService');
    await clearBiometricLoginCredential();
  });
  await attempt(async () => {
    const { notificationService } = await import('./notifications');
    await notificationService.clearAllNotifications();
  });
  // Clear diagnostics last so errors or account-linked context retained before
  // this boundary cannot survive a successful cleanup.
  await attempt(async () => {
    const { clearDebugLogsDurably } = await import('../stores/useDebugLogs');
    await clearDebugLogsDurably();
  });

  if (failures.length === 0) {
    await attempt(unblockPortableImportAccountOutputs);
  }
  if (failures.length > 0) {
    throw new Error('Portable import cleanup is incomplete');
  }
  clearPortableImportCleanupPending();
}
