/**
 * Service Instances
 *
 * Sets up SDK event handlers and exports auth service.
 * The SDK singleton (gossipSdk) handles all session-scoped services.
 */

import {
  AuthService,
  createMessageProtocol,
  gossipSdk,
} from '@massalabs/gossip-sdk';
import { notificationService } from './notifications';
import { isAppInForeground } from '../utils/appState';
import { db } from '../db';

// Create message protocol instance (app-scoped)
const messageProtocol = createMessageProtocol();

// AuthService doesn't need session - app-scoped
export const authService = new AuthService(db, messageProtocol);

/**
 * Wire up SDK events to app behaviors like notifications.
 *
 * Note: Zustand stores use liveQuery to watch the database directly,
 * so we don't need to manually push state updates here. The events
 * are primarily for side effects like notifications.
 */
function setupSdkEventHandlers(): void {
  // Show notification for new discussion requests when app is in background
  gossipSdk.on('discussionRequest', async (discussion, contact) => {
    const foreground = await isAppInForeground();
    if (!foreground) {
      try {
        await notificationService.showNewDiscussionNotification(
          discussion.announcementMessage
        );
        console.log('[SDK Event] New discussion request notification shown', {
          contactUserId: contact.userId,
        });
      } catch (error) {
        console.error('[SDK Event] Failed to show notification:', error);
      }
    }
  });

  // Log errors for debugging
  gossipSdk.on('error', (error, context) => {
    console.error(`[SDK Error:${context}]`, error);
  });
}

// Set up event handlers (will be ready when SDK initializes)
setupSdkEventHandlers();

export { AuthService };
