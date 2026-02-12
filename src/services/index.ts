/**
 * Service Instances
 *
 * Sets up SDK event handlers and exports auth service.
 * The SDK instance is managed via getSdk().
 */

import {
  SdkEventType,
  type Discussion,
  type Contact,
} from '@massalabs/gossip-sdk';
import { notificationService } from './notifications';
import { isAppInForeground } from '../utils/appState';

/**
 * Wire up SDK events to app behaviors like notifications.
 *
 * Note: Zustand stores use liveQuery to watch the database directly,
 * so we don't need to manually push state updates here. The events
 * are primarily for side effects like notifications.
 */
function setupSdkEventHandlers(
  sdk: import('@massalabs/gossip-sdk').GossipSdk
): void {
  // Show notification for new discussion requests when app is in background
  sdk.on(
    SdkEventType.SESSION_REQUESTED,
    async (discussion: Discussion, contact: Contact) => {
      const foreground = await isAppInForeground();
      if (!foreground) {
        try {
          await notificationService.showNewDiscussionNotification(
            discussion.lastAnnouncementMessage
          );
          console.log('[SDK Event] New discussion request notification shown', {
            contactUserId: contact.userId,
          });
        } catch (error) {
          console.error('[SDK Event] Failed to show notification:', error);
        }
      }
    }
  );

  // Log errors for debugging
  sdk.on(SdkEventType.ERROR, (error: Error, context: string) => {
    console.error(`[SDK Error:${context}]`, error);
  });
}

export { setupSdkEventHandlers };
