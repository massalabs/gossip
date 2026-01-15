/**
 * Preferences Storage Utilities
 *
 * Wrapper around storage APIs for cross-platform compatibility.
 * In SDK context (Node.js), these operations are no-ops.
 *
 * - On web: Uses injected adapter or Capacitor Preferences
 * - On mobile: Uses injected adapter or native storage via Capacitor
 * - In Node.js/SDK: No-ops (data is in-memory only)
 */

import { encodeToBase64 } from './base64';

export interface PreferencesAdapter {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  remove?: (key: string) => Promise<void>;
}

let preferencesAdapter: PreferencesAdapter | null = null;

export function setPreferencesAdapter(
  adapter: PreferencesAdapter | null
): void {
  preferencesAdapter = adapter;
}

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';

/**
 * Store active seekers for background runner access.
 *
 * In SDK/Node.js context, this is a no-op since there's no background runner.
 * On native platforms, this bridges host app storage with BackgroundRunner storage.
 *
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

  if (preferencesAdapter) {
    await preferencesAdapter.set(ACTIVE_SEEKERS_KEY, value);
    return;
  }

  // Check if we're in a browser/Capacitor environment
  if (typeof document === 'undefined') {
    // In Node.js/SDK context, this is a no-op
    return;
  }

  // Try to use Capacitor if available
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      // On native: write to BackgroundRunner's storage
      const { isAppInForeground } = await import('./appState');
      const foreground = await isAppInForeground();

      if (foreground) {
        try {
          // Dynamic import to avoid errors when not available
          const { backgroundRunnerStorageService } =
            await import('../services/backgroundRunnerStorage');
          await backgroundRunnerStorageService.set(ACTIVE_SEEKERS_KEY, value);
        } catch {
          // BackgroundRunner storage not available, silently ignore
        }
      }
    }
  } catch {
    // Capacitor not available, silently ignore
  }
}
