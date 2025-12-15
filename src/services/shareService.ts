import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';

export interface ShareInvitationOptions {
  deepLinkUrl: string;
}

/**
 * Returns true if we can open a native share sheet or Web Share API,
 * i.e. actually share via other apps and not just copy to clipboard.
 */
export function canShareInvitationViaOtherApp(): boolean {
  if (Capacitor.isNativePlatform()) {
    return true;
  }

  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function'
  ) {
    return true;
  }

  return false;
}

/**
 * Share invitation link using native share sheet on mobile devices
 * or Web Share API on web browsers.
 *
 * @param options - Share options containing the invite URL
 * @returns Promise that resolves when sharing is complete or fails
 */
export async function shareInvitation(
  options: ShareInvitationOptions
): Promise<void> {
  const { deepLinkUrl } = options;

  if (!deepLinkUrl) {
    throw new Error('deepLinkUrl is required');
  }

  const shareText = 'Join me on Gossip!';
  const shareTitle = 'Join me on Gossip';

  // Use native Capacitor Share plugin on native platforms
  if (Capacitor.isNativePlatform()) {
    try {
      await Share.share({
        title: shareTitle,
        text: shareText,
        url: deepLinkUrl,
        dialogTitle: shareTitle,
      });
      return;
    } catch (error) {
      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.message.includes('cancel') ||
          error.message.includes('User cancelled'))
      ) {
        return;
      }
      // Re-throw other errors
      throw error;
    }
  }

  // Use Web Share API on web platforms
  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: deepLinkUrl,
      });
      return;
    } catch (error) {
      // User cancelled sharing - this is expected behavior, don't throw
      if (
        error instanceof Error &&
        (error.name === 'AbortError' || error.message.includes('cancel'))
      ) {
        return;
      }
      // If Web Share API fails, fall back to clipboard
      console.warn('Web Share API failed, falling back to clipboard:', error);
    }
  }

  // Fallback: Copy to clipboard if share is not available
  try {
    await navigator.clipboard.writeText(deepLinkUrl);
    // Note: We don't throw here since copying succeeded, but we could
  } catch (clipboardError) {
    throw new Error(
      `Failed to share invitation: ${clipboardError instanceof Error ? clipboardError.message : 'Unknown error'}`
    );
  }
}
