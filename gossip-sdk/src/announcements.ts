/**
 * Announcement Handling SDK
 *
 * Functions for sending, receiving, and processing announcements.
 * Announcements are used for session establishment between users.
 *
 * @example
 * ```typescript
 * import {
 *   fetchAndProcessAnnouncements,
 *   resendAnnouncements,
 * } from 'gossip-sdk';
 *
 * // Fetch and process new announcements
 * const result = await fetchAndProcessAnnouncements(session);
 *
 * // Resend failed announcements
 * await resendAnnouncements(failedDiscussions, session);
 * ```
 */

import { announcementService } from '@/services/announcement';
import type { AnnouncementReceptionResult } from '@/services/announcement';
import type { Discussion } from '@/db';
import type { SessionModule } from '@/wasm';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

// Re-export result type
export type { AnnouncementReceptionResult };

/**
 * Fetch and process announcements from the server.
 * Processes incoming session requests and updates discussions accordingly.
 *
 * @param session - The SessionModule instance for the current user
 * @returns Result with count of new announcements processed
 *
 * @example
 * ```typescript
 * const result = await fetchAndProcessAnnouncements(session);
 * if (result.success) {
 *   console.log(`Processed ${result.newAnnouncementsCount} announcements`);
 * } else if (result.error) {
 *   console.error('Error:', result.error);
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
 * Attempts to resend announcements that failed to be broadcast.
 *
 * @param failedDiscussions - Array of discussions with SEND_FAILED status
 * @param session - The SessionModule instance for the current user
 *
 * @example
 * ```typescript
 * // Get failed discussions from database
 * const failed = discussions.filter(d => d.status === DiscussionStatus.SEND_FAILED);
 * await resendAnnouncements(failed, session);
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
 * Used internally for session establishment.
 *
 * @param announcement - The announcement bytes to broadcast
 * @returns Result with success status and optional counter
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
 * Creates and sends an announcement to initiate or accept a session.
 *
 * @param contactPublicKeys - The contact's public keys
 * @param session - The SessionModule instance for the current user
 * @param userData - Optional user data to include in the announcement
 * @returns Result with success status and announcement bytes
 *
 * @example
 * ```typescript
 * const result = await establishSession(contactPubKeys, session, userData);
 * if (result.success) {
 *   console.log('Session established');
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
