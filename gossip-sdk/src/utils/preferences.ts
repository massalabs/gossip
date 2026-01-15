/**
 * Preferences Storage Utilities
 *
 * Wrapper around storage APIs for cross-platform compatibility.
 * In SDK context (Node.js), these operations are no-ops.
 *
 * - On web: Uses Capacitor Preferences (accessible by service worker)
 * - On mobile: Uses native storage via Capacitor
 * - In Node.js/SDK: No-ops (data is in-memory only)
 */

import { encodeToBase64 } from './base64';

// Preferences keys
const ACTIVE_SEEKERS_KEY = 'gossip-active-seekers';

/**
 * Store active seekers for background runner access.
 *
 * In SDK/Node.js context, this is a no-op since there's no background runner.
 * On native platforms, this bridges main app storage with BackgroundRunner storage.
 *
 * @param seekers - Array of seeker Uint8Arrays to store
 */
export async function setActiveSeekersInPreferences(
  seekers: Uint8Array[]
): Promise<void> {
  // Check if we're in a browser/Capacitor environment
  if (typeof document === 'undefined') {
    // In Node.js/SDK context, this is a no-op
    return;
  }

  const serializedSeekers = seekers.map(seeker => encodeToBase64(seeker));
  const value = JSON.stringify(serializedSeekers);

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
