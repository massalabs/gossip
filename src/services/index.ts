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
  GossipSdk,
  setOnSeekersUpdated,
} from '@massalabs/gossip-sdk';
import { notificationService } from './notifications';
import { isAppInForeground } from '../utils/appState';
import { bridgeSet } from '../sw-bridge';
import { setActiveSeekersInPreferences } from '../utils/preferences';

/**
 * Wire up SDK events to app behaviors like notifications.
 *
 * Note: Zustand stores poll SQLite via SDK service APIs and listen to SDK events
 * for immediate refetch. The event handlers here are primarily for side effects
 * like notifications.
 */
export function setupSdkEventHandlers(gossip: GossipSdk): void {
  // Propagate seekers to SW bridge (web) and BackgroundRunner (mobile)
  setOnSeekersUpdated(seekers => {
    bridgeSet(
      'activeSeekers',
      seekers.map(s => Array.from(s))
    ).catch(() => {});
    setActiveSeekersInPreferences(seekers).catch(() => {});
  });

  // Show notification for new discussion requests when app is in background
  gossip.on(
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
  gossip.on(SdkEventType.ERROR, (error: Error, context: string) => {
    console.error(`[SDK Error:${context}]`, error);
  });
}
