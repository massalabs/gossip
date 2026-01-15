/**
 * Discussion Management SDK
 *
 * Functions for managing discussions using SDK services and adapters.
 *
 * @example
 * ```typescript
 * import {
 *   initializeDiscussion,
 *   acceptDiscussionRequest,
 *   getDiscussions,
 * } from 'gossip-sdk';
 *
 * // Initialize a new discussion
 * const result = await initializeDiscussion(contact, session, 'Hello!');
 *
 * // Accept a discussion request
 * await acceptDiscussionRequest(discussion, session);
 *
 * // Get all discussions
 * const discussions = await getDiscussions(userId);
 * ```
 */

import {
  initializeDiscussion as initializeDiscussionService,
  acceptDiscussionRequest as acceptDiscussionRequestService,
  renewDiscussion as renewDiscussionService,
  isDiscussionStableState as isDiscussionStableStateService,
} from './services/discussion';
import { updateDiscussionName as updateDiscussionNameUtil } from './utils/discussions';
import { db, type Discussion, type Contact } from './db';
import type { SessionModule } from './wasm';
import type { UpdateDiscussionNameResult } from './utils/discussions';

// Re-export result type
export type { UpdateDiscussionNameResult };

/**
 * Initialize a discussion with a contact.
 *
 * @param contact - The contact to start a discussion with
 * @param session - The SessionModule instance
 * @param message - Optional initial message
 * @returns Result with discussion ID and announcement
 *
 * @example
 * ```typescript
 * const result = await initializeDiscussion(contact, session, 'Hello!');
 * console.log('Discussion ID:', result.discussionId);
 * ```
 */
export async function initializeDiscussion(
  contact: Contact,
  session: SessionModule,
  message?: string
): Promise<{ discussionId: number; announcement: Uint8Array }> {
  return await initializeDiscussionService(contact, session, message);
}

/**
 * Accept a discussion request from a contact.
 *
 * @param discussion - The discussion to accept
 * @param session - The SessionModule instance
 *
 * @example
 * ```typescript
 * await acceptDiscussionRequest(pendingDiscussion, session);
 * ```
 */
export async function acceptDiscussionRequest(
  discussion: Discussion,
  session: SessionModule
): Promise<void> {
  return await acceptDiscussionRequestService(discussion, session);
}

/**
 * Renew a broken or failed discussion.
 *
 * @param contactUserId - The contact's user ID
 * @param session - The SessionModule instance
 *
 * @example
 * ```typescript
 * await renewDiscussion(contactUserId, session);
 * ```
 */
export async function renewDiscussion(
  contactUserId: string,
  session: SessionModule
): Promise<void> {
  return await renewDiscussionService(contactUserId, session);
}

/**
 * Update the custom name of a discussion.
 *
 * @param discussionId - The discussion ID
 * @param newName - New custom name (empty to clear)
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await updateDiscussionName(discussionId, 'Work Chat');
 * if (result.ok) {
 *   console.log('Updated to:', result.trimmedName);
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
 * Check if a discussion is in a stable state for sending messages.
 *
 * @param ownerUserId - The owner user ID
 * @param contactUserId - The contact user ID
 * @returns True if messages can be sent
 *
 * @example
 * ```typescript
 * const canSend = await isDiscussionStableState(myUserId, contactUserId);
 * if (canSend) {
 *   // Safe to send messages
 * }
 * ```
 */
export async function isDiscussionStableState(
  ownerUserId: string,
  contactUserId: string
): Promise<boolean> {
  return await isDiscussionStableStateService(ownerUserId, contactUserId);
}

/**
 * Get all discussions for an owner.
 *
 * @param ownerUserId - The owner user ID
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
 * Get a specific discussion by owner and contact IDs.
 *
 * @param ownerUserId - The owner user ID
 * @param contactUserId - The contact user ID
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
 * @param ownerUserId - The owner user ID
 * @returns Array of active discussions
 *
 * @example
 * ```typescript
 * const activeDiscussions = await getActiveDiscussions(myUserId);
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
 * Get total unread message count for an owner.
 *
 * @param ownerUserId - The owner user ID
 * @returns Total unread count across all discussions
 *
 * @example
 * ```typescript
 * const unread = await getUnreadCount(myUserId);
 * console.log('Unread messages:', unread);
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
 * @param ownerUserId - The owner user ID
 * @param contactUserId - The contact user ID
 *
 * @example
 * ```typescript
 * await markDiscussionAsRead(myUserId, contactUserId);
 * ```
 */
export async function markDiscussionAsRead(
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  try {
    await db.markMessagesAsRead(ownerUserId, contactUserId);
  } catch (error) {
    console.error('Error marking discussion as read:', error);
  }
}
