import { secureStorageEnabled } from '../config/features';
import { useSdkStore } from '../stores/sdkStore';

export function useStorageMode() {
  const sdk = useSdkStore.use.sdk();
  return {
    secureStorageEnabled,
    isSecureStorage: sdk?.isSecureStorage ?? false,
    needsUnlock: sdk?.needsUnlock ?? false,
    dbReady: sdk?.dbReady ?? false,
  };
}

// Re-export for non-React code (store actions, main.tsx) that can't use hooks
export { secureStorageEnabled } from '../config/features';
