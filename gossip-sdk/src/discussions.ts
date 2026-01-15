/**
 * Discussion Management SDK
 *
 * Functions for managing discussions with contacts, including
 * initialization, acceptance, renewal, and status checking.
 *
 * @example
 * ```typescript
 * import {
 *   getDiscussions,
 *   initializeDiscussion,
 *   acceptDiscussionRequest,
 * } from 'gossip-sdk';
 *
 * // Get all discussions
 * const discussions = await getDiscussions(userId);
 *
 * // Initialize a new discussion
 * const result = await initializeDiscussion(contact, session, 'Hello!');
 * ```
 */

import {
  initializeDiscussion as initializeDiscussionService,
  acceptDiscussionRequest as acceptDiscussionRequestService,
  renewDiscussion as renewDiscussionService,
  isDiscussionStableState as isDiscussionStableStateService,
} from '@/services/discussion';
import { updateDiscussionName as updateDiscussionNameUtil } from '@/utils/discussions';
import { db } from '@/db';
import type { Discussion, Contact } from '@/db';
import type { UpdateDiscussionNameResult } from '@/utils/discussions';
import type { SessionModule } from '@/wasm';

// Re-export result type
export type { UpdateDiscussionNameResult };

/**
 * Initialize a discussion with a contact.
 * Creates a new discussion and sends an announcement to the contact.
 *
 * @param contact - The contact to start a discussion with
 * @param session - The SessionModule instance for the current user
 * @param message - Optional initial message to include in the announcement
 * @returns Result with discussion ID and announcement
 *
 * @example
 * ```typescript
 * const result = await initializeDiscussion(contact, session, 'Hello!');
 * if (result.success) {
 *   console.log('Discussion created:', result.discussionId);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * ```
 */
export async function initializeDiscussion(
  contact: Contact,
  session: SessionModule,
  message?: string
): Promise<{
  success: boolean;
  error?: string;
  discussionId?: number;
  announcement?: Uint8Array;
}> {
  try {
    const result = await initializeDiscussionService(contact, session, message);
    return {
      success: true,
      discussionId: result.discussionId,
      announcement: result.announcement,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Accept a discussion request from a contact.
 * Transitions a PENDING/RECEIVED discussion to ACTIVE.
 *
 * @param discussion - The discussion to accept
 * @param session - The SessionModule instance for the current user
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await acceptDiscussionRequest(pendingDiscussion, session);
 * if (result.success) {
 *   console.log('Discussion accepted');
 * }
 * ```
 */
export async function acceptDiscussionRequest(
  discussion: Discussion,
  session: SessionModule
): Promise<{ success: boolean; error?: string }> {
  try {
    await acceptDiscussionRequestService(discussion, session);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Renew a broken discussion.
 * Resets the session and sends a new announcement.
 *
 * @param contactUserId - Contact user ID
 * @param session - The SessionModule instance for the current user
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await renewDiscussion(contactUserId, session);
 * if (result.success) {
 *   console.log('Discussion renewed');
 * }
 * ```
 */
export async function renewDiscussion(
  contactUserId: string,
  session: SessionModule
): Promise<{ success: boolean; error?: string }> {
  try {
    await renewDiscussionService(contactUserId, session);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update discussion custom name.
 *
 * @param discussionId - Discussion ID
 * @param newName - New custom name (or undefined to clear)
 * @returns Result with success status and trimmed name
 *
 * @example
 * ```typescript
 * const result = await updateDiscussionName(discussionId, 'Work Chat');
 * if (result.ok) {
 *   console.log('Name updated to:', result.trimmedName);
 * }
 * ```
 */
export async function updateDiscussionName(
  discussionId: number,
  newName: string | undefined
): Promise<UpdateDiscussionNameResult> {
  return await updateDiscussionNameUtil(discussionId, newName);
}

/**
 * Check if discussion is in stable state (can send new messages).
 * Returns false if the discussion is broken or has failed messages
 * that haven't been encrypted.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns True if discussion is stable and can send messages
 *
 * @example
 * ```typescript
 * const canSend = await isDiscussionStableState(myUserId, contactUserId);
 * if (canSend) {
 *   // Safe to send messages
 * } else {
 *   // Need to renew discussion first
 * }
 * ```
 */
export async function isDiscussionStableState(
  ownerUserId: string,
  contactUserId: string
): Promise<boolean> {
  try {
    return await isDiscussionStableStateService(ownerUserId, contactUserId);
  } catch (error) {
    console.error('Error checking discussion state:', error);
    return false;
  }
}

/**
 * Get all discussions for an owner.
 *
 * @param ownerUserId - Owner user ID
 * @returns Array of discussions sorted by last message timestamp
 *
 * @example
 * ```typescript
 * const discussions = await getDiscussions(myUserId);
 * discussions.forEach(d => console.log(d.contactUserId, d.status));
 * ```
 */
export async function getDiscussions(
  ownerUserId: string
): Promise<Discussion[]> {
  try {
    return await db.getDiscussionsByOwner(ownerUserId);
  } catch (error) {
    console.error('Error getting discussions:', error);
    return [];
  }
}

/**
 * Get a specific discussion by owner and contact user IDs.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns Discussion or null if not found
 *
 * @example
 * ```typescript
 * const discussion = await getDiscussion(myUserId, contactUserId);
 * if (discussion) {
 *   console.log('Status:', discussion.status);
 * }
 * ```
 */
export async function getDiscussion(
  ownerUserId: string,
  contactUserId: string
): Promise<Discussion | null> {
  try {
    const discussion = await db.getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    return discussion ?? null;
  } catch (error) {
    console.error('Error getting discussion:', error);
    return null;
  }
}

/**
 * Get all active discussions for an owner.
 *
 * @param ownerUserId - Owner user ID
 * @returns Array of active discussions
 *
 * @example
 * ```typescript
 * const activeDiscussions = await getActiveDiscussions(myUserId);
 * console.log(`${activeDiscussions.length} active discussions`);
 * ```
 */
export async function getActiveDiscussions(
  ownerUserId: string
): Promise<Discussion[]> {
  try {
    return await db.getActiveDiscussionsByOwner(ownerUserId);
  } catch (error) {
    console.error('Error getting active discussions:', error);
    return [];
  }
}

/**
 * Get total unread message count across all discussions.
 *
 * @param ownerUserId - Owner user ID
 * @returns Total unread count
 *
 * @example
 * ```typescript
 * const unreadCount = await getUnreadCount(myUserId);
 * console.log(`${unreadCount} unread messages`);
 * ```
 */
export async function getUnreadCount(ownerUserId: string): Promise<number> {
  try {
    return await db.getUnreadCountByOwner(ownerUserId);
  } catch (error) {
    console.error('Error getting unread count:', error);
    return 0;
  }
}

/**
 * Mark all messages in a discussion as read.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 *
 * @example
 * ```typescript
 * await markDiscussionAsRead(myUserId, contactUserId);
 * console.log('Messages marked as read');
 * ```
 */
export async function markDiscussionAsRead(
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  try {
    await db.markMessagesAsRead(ownerUserId, contactUserId);
  } catch (error) {
    console.error('Error marking messages as read:', error);
  }
}
