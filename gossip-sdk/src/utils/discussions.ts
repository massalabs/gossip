/**
 * Discussion Utilities
 *
 * Functions for managing discussion metadata.
 */

import { type GossipDatabase } from '../db';

export type UpdateDiscussionNameResult =
  | { success: true; trimmedName: string | undefined }
  | {
      success: false;
      reason: 'not_found' | 'error';
      message: string;
    };

/**
 * Update the custom name of a discussion.
 * Pass an empty string or undefined to clear the custom name (will revert to contact name).
 *
 * @param discussionId - The discussion ID to update
 * @param newName - The new custom name (or empty/undefined to clear)
 * @param db - Database instance
 * @returns Result with success status
 */
export async function updateDiscussionName(
  discussionId: number,
  newName: string | undefined,
  db: GossipDatabase
): Promise<UpdateDiscussionNameResult> {
  const trimmed = newName?.trim();
  const customName = trimmed && trimmed.length > 0 ? trimmed : undefined;

  try {
    const discussion = await db.discussions.get(discussionId);
    if (!discussion) {
      return {
        success: false,
        reason: 'not_found',
        message: 'Discussion not found.',
      };
    }

    await db.discussions.update(discussionId, { customName });

    return { success: true, trimmedName: customName };
  } catch (e) {
    console.error('updateDiscussionName failed', e);
    return {
      success: false,
      reason: 'error',
      message: 'Failed to update name. Please try again.',
    };
  }
}
