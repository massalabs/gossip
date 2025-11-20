import { Preferences } from '@capacitor/preferences';

const PENDING_DEEPLINK_KEY = 'pending_deeplink';

/**
 * Store pending deep link for processing after authentication
 * Uses Capacitor Preferences for native (reliable when app is killed)
 * Also uses Preferences for web as fallback (in case URL params are lost during route switch)
 */
export const setPendingDeepLink = async (url: string): Promise<void> => {
  // Always store in Preferences as backup (works for both native and web)
  // For web, we also use URL params, but Preferences ensures it survives route switches
  try {
    await Preferences.set({ key: PENDING_DEEPLINK_KEY, value: url });
    console.log('[deepLinkStorage] Stored pending deep link:', url);

    // Verify it was stored (for debugging)
    const { value } = await Preferences.get({ key: PENDING_DEEPLINK_KEY });
    console.log('[deepLinkStorage] Verification - stored value:', value);
  } catch (error) {
    console.error(
      '[deepLinkStorage] Failed to store pending deep link:',
      error
    );
    throw error;
  }
};

/**
 * Get and remove pending deep link
 * Returns null if no pending deep link exists
 * Checks Capacitor Preferences (works for both native and web)
 */
export const getPendingDeepLink = async (): Promise<string | null> => {
  try {
    const { value } = await Preferences.get({ key: PENDING_DEEPLINK_KEY });
    console.log('[deepLinkStorage] Retrieved pending deep link:', value);
    if (value) {
      // Remove after reading (one-time use)
      await Preferences.remove({ key: PENDING_DEEPLINK_KEY });
      console.log('[deepLinkStorage] Removed pending deep link after reading');
      return value;
    }
    return null;
  } catch (error) {
    console.error('[deepLinkStorage] Failed to get pending deep link:', error);
    return null;
  }
};
