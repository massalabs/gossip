/**
 * Android-only: optional foreground service for higher background sync reliability
 * without server push. Registered natively in MainActivity.
 */

import { registerPlugin } from '@capacitor/core';

export interface ForegroundSyncPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  isEnabled(): Promise<{ enabled: boolean }>;
}

export const ForegroundSync = registerPlugin<ForegroundSyncPlugin>(
  'ForegroundSync',
  {
    web: () => ({
      start: async () => {
        /* no-op */
      },
      stop: async () => {
        /* no-op */
      },
      isEnabled: async () => ({ enabled: false }),
    }),
  }
);
