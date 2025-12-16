/**
 * Discussion Management SDK
 *
 * Functions for managing discussions with contacts
 */

import {
  initializeDiscussion as initializeDiscussionService,
  acceptDiscussionRequest as acceptDiscussionRequestService,
  renewDiscussion as renewDiscussionService,
  isDiscussionStableState as isDiscussionStableStateService,
} from '../../src/services/discussion';
import { updateDiscussionName as updateDiscussionNameUtil } from '../../src/utils/discussions';
import { db } from '../../src/db';
import type {
  Discussion,
  Contact,
  UpdateDiscussionNameResult,
} from '../../src/db';
import type {
  UserPublicKeys,
  UserSecretKeys,
} from '../../src/assets/generated/wasm/gossip_wasm';
import type { SessionModule } from '../../src/wasm';

/**
 * Initialize a discussion with a contact
 * @param contact - The contact to start a discussion with
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @param session - The SessionModule instance
 * @param userId - The user ID of the current user (discussion owner)
 * @param message - Optional message to include in the announcement
 * @returns Result with discussion ID and announcement
 */
export async function initializeDiscussion(
  contact: Contact,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys,
  session: SessionModule,
  userId: string,
  message?: string
): Promise<{
  success: boolean;
  error?: string;
  discussionId?: number;
  announcement?: Uint8Array;
}> {
  try {
    const result = await initializeDiscussionService(
      contact,
      ourPk,
      ourSk,
      session,
      userId,
      message
    );
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
 * Accept a discussion request from a contact
 * @param discussion - The discussion to accept
 * @param session - The SessionModule instance
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @returns Result with success status
 */
export async function acceptDiscussionRequest(
  discussion: Discussion,
  session: SessionModule,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys
): Promise<{ success: boolean; error?: string }> {
  try {
    await acceptDiscussionRequestService(discussion, session, ourPk, ourSk);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Renew a broken discussion
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @param session - The SessionModule instance
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @returns Result with success status
 */
export async function renewDiscussion(
  ownerUserId: string,
  contactUserId: string,
  session: SessionModule,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys
): Promise<{ success: boolean; error?: string }> {
  try {
    await renewDiscussionService(
      ownerUserId,
      contactUserId,
      session,
      ourPk,
      ourSk
    );
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update discussion custom name
 * @param discussionId - Discussion ID
 * @param newName - New custom name (or undefined to clear)
 * @returns Result with success status
 */
export async function updateDiscussionName(
  discussionId: number,
  newName: string | undefined
): Promise<UpdateDiscussionNameResult> {
  return await updateDiscussionNameUtil(discussionId, newName);
}

/**
 * Check if discussion is in stable state (can send new messages)
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns True if discussion is stable
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
 * Get all discussions for an owner
 * @param ownerUserId - Owner user ID
 * @returns Array of discussions
 */
export async function getDiscussions(
  ownerUserId: string
): Promise<Discussion[]> {
  try {
    return await db.discussions
      .where('ownerUserId')
      .equals(ownerUserId)
      .toArray();
  } catch (error) {
    console.error('Error getting discussions:', error);
    return [];
  }
}

/**
 * Get a specific discussion
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns Discussion or null if not found
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
