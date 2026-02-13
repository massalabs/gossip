/**
 * Discussion Utilities
 *
 * Functions for managing discussion metadata.
 */

import { getDiscussionById, updateDiscussionById } from '../queries';

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
  newName: string | undefined
): Promise<UpdateDiscussionNameResult> {
  const trimmed = newName?.trim();
  const customName = trimmed && trimmed.length > 0 ? trimmed : null;

  try {
    const discussion = await getDiscussionById(discussionId);
    if (!discussion) {
      return {
        success: false,
        reason: 'not_found',
        message: 'Discussion not found.',
      };
    }

    await updateDiscussionById(discussionId, { customName });

    return { success: true, trimmedName: customName ?? undefined };
  } catch (e) {
    console.error('updateDiscussionName failed', e);
    return {
      success: false,
      reason: 'error',
      message: 'Failed to update name. Please try again.',
    };
  }
}
