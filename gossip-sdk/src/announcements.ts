/**
 * Announcement Handling SDK
 *
 * Functions for managing session announcements using the configured protocol.
 *
 * @example
 * ```typescript
 * import {
 *   fetchAndProcessAnnouncements,
 *   establishSession,
 * } from 'gossip-sdk';
 *
 * // Fetch and process new announcements
 * const result = await fetchAndProcessAnnouncements(session);
 *
 * // Establish a session with a contact
 * const sessionResult = await establishSession(contactPublicKeys, session);
 * ```
 */

import { announcementService } from './services/announcement';
import type { Discussion } from './db';
import type { SessionModule } from './wasm';
import type { AnnouncementReceptionResult } from './services/announcement';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

// Re-export result type
export type { AnnouncementReceptionResult };

/**
 * Fetch and process new announcements from the server.
 *
 * @param session - The SessionModule instance
 * @returns Result with success status and new announcement count
 *
 * @example
 * ```typescript
 * const result = await fetchAndProcessAnnouncements(session);
 * if (result.success) {
 *   console.log('Processed', result.newAnnouncementsCount, 'announcements');
 * }
 * ```
 */
export async function fetchAndProcessAnnouncements(
  session: SessionModule
): Promise<AnnouncementReceptionResult> {
  return await announcementService.fetchAndProcessAnnouncements(session);
}

/**
 * Resend announcements for failed discussions.
 *
 * @param failedDiscussions - Array of discussions that failed to send
 * @param session - The SessionModule instance
 *
 * @example
 * ```typescript
 * const failedDiscussions = discussions.filter(d => d.status === 'sendFailed');
 * await resendAnnouncements(failedDiscussions, session);
 * ```
 */
export async function resendAnnouncements(
  failedDiscussions: Discussion[],
  session: SessionModule
): Promise<void> {
  return await announcementService.resendAnnouncements(
    failedDiscussions,
    session
  );
}

/**
 * Send an announcement directly.
 *
 * @param announcement - The announcement bytes to send
 * @returns Result with success status and counter
 *
 * @example
 * ```typescript
 * const result = await sendAnnouncement(announcementBytes);
 * if (result.success) {
 *   console.log('Announcement sent, counter:', result.counter);
 * }
 * ```
 */
export async function sendAnnouncement(announcement: Uint8Array): Promise<{
  success: boolean;
  counter?: string;
  error?: string;
}> {
  return await announcementService.sendAnnouncement(announcement);
}

/**
 * Establish a session with a contact.
 *
 * @param contactPublicKeys - The contact's public keys
 * @param session - The SessionModule instance
 * @param userData - Optional user data to include in announcement
 * @returns Result with announcement bytes
 *
 * @example
 * ```typescript
 * const result = await establishSession(contactPublicKeys, session, userData);
 * if (result.success) {
 *   console.log('Session established');
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function establishSession(
  contactPublicKeys: UserPublicKeys,
  session: SessionModule,
  userData?: Uint8Array
): Promise<{
  success: boolean;
  error?: string;
  announcement: Uint8Array;
}> {
  return await announcementService.establishSession(
    contactPublicKeys,
    session,
    userData
  );
}
