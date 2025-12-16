/**
 * Announcement Handling SDK
 *
 * Functions for handling session announcements
 */

import { announcementService } from '../../src/services/announcement';
import type { AnnouncementReceptionResult } from '../../src/services/announcement';
import type {
  UserPublicKeys,
  UserSecretKeys,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { SessionModule } from '../../src/wasm';
import type { Discussion } from '../../src/db';

/**
 * Fetch and process incoming announcements
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @param session - The SessionModule instance
 * @returns Result with count of new announcements processed
 */
export async function fetchAndProcessAnnouncements(
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys,
  session: SessionModule
): Promise<AnnouncementReceptionResult> {
  return await announcementService.fetchAndProcessAnnouncements(
    ourPk,
    ourSk,
    session
  );
}

/**
 * Resend failed announcements for discussions
 * @param failedDiscussions - Array of discussions with failed announcements
 * @param session - The SessionModule instance
 * @returns Promise that resolves when complete
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
 * Establish a session with a contact and send announcement
 * @param contactPublicKeys - The public keys of the contact
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @param session - The SessionModule instance
 * @param userData - Optional user data to include in the announcement
 * @returns Result with announcement and success status
 */
export async function establishSession(
  contactPublicKeys: UserPublicKeys,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys,
  session: SessionModule,
  userData?: Uint8Array
): Promise<{
  success: boolean;
  error?: string;
  announcement: Uint8Array;
}> {
  const result = await announcementService.establishSession(
    contactPublicKeys,
    ourPk,
    ourSk,
    session,
    userData
  );
  return {
    success: result.success,
    error: result.error,
    announcement: result.announcement,
  };
}

/**
 * Send an announcement
 * @param announcement - Announcement bytes to send
 * @returns Result with success status and counter
 */
export async function sendAnnouncement(announcement: Uint8Array): Promise<{
  success: boolean;
  counter?: string;
  error?: string;
}> {
  return await announcementService.sendAnnouncement(announcement);
}
