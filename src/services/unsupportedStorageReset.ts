import { Capacitor, registerPlugin } from '@capacitor/core';

const RESET_MODE_KEY = 'gossip:unsupported-storage-reset-mode-v1';
const RESET_PENDING_KEY = 'gossip:unsupported-storage-reset-pending-v1';

interface SecureStorageResetPlugin {
  resetStorage(): Promise<void>;
}

const SecureStorageNative = registerPlugin<SecureStorageResetPlugin>(
  'SecureStorageNative'
);

export function isUnsupportedStorageVersionError(error: unknown): boolean {
  const candidate = error as { code?: unknown; name?: unknown } | null;
  return (
    candidate?.code === 'UNSUPPORTED_VERSION' ||
    candidate?.name === 'UNSUPPORTED_VERSION'
  );
}

export function requestUnsupportedStorageReset(): void {
  sessionStorage.setItem(RESET_MODE_KEY, 'required');
  window.location.reload();
}

export function isUnsupportedStorageResetRequested(): boolean {
  return (
    sessionStorage.getItem(RESET_MODE_KEY) === 'required' ||
    localStorage.getItem(RESET_PENDING_KEY) === 'confirmed'
  );
}

export function isUnsupportedStorageResetConfirmed(): boolean {
  return localStorage.getItem(RESET_PENDING_KEY) === 'confirmed';
}

function deleteBrowserSecureStorage(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('secure_storage');
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Secure storage could not be reset'));
    request.onblocked = () =>
      reject(new Error('Close other Gossip tabs before resetting storage'));
  });
}

async function closeSdkBeforeStorageReset(): Promise<void> {
  const { getSdk } = await import('../stores/sdkStore');
  let sdk: ReturnType<typeof getSdk>;
  try {
    sdk = getSdk();
  } catch {
    return;
  }
  if (!sdk.isInitialized) return;

  if (!sdk.isSecureStorage) {
    if (sdk.isSessionOpen) await sdk.closeSession();
    await sdk.clearAllTables();
    await sdk.clearSessionBlob();
  }
  await sdk.destroy();
}

/**
 * Irreversibly remove every account-owned local artifact while preserving
 * language, appearance, and other non-account preferences.
 */
export async function resetAllAccountStorage(): Promise<void> {
  localStorage.setItem(RESET_PENDING_KEY, 'confirmed');
  const [cleanup, authorization] = await Promise.all([
    import('./portableImportCleanup'),
    import('./portableImportAuthorization'),
  ]);
  cleanup.markPortableImportCleanupPending();
  await cleanup.blockPortableImportAccountOutputs();
  await closeSdkBeforeStorageReset();

  if (Capacitor.isNativePlatform()) {
    await SecureStorageNative.resetStorage();
  } else {
    await deleteBrowserSecureStorage();
  }

  await cleanup.runPortableImportPostCommitCleanup();
  await authorization.resetOnboardingAuthorityAfterStorageReset();
  localStorage.removeItem(RESET_PENDING_KEY);
  sessionStorage.removeItem(RESET_MODE_KEY);
  window.location.replace('/');
}

export async function resetUnsupportedSecureStorage(): Promise<void> {
  await resetAllAccountStorage();
}
