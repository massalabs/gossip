import { db } from '../db';

export type UpdateDiscussionNameResult =
  | { ok: true; trimmedName: string | undefined }
  | {
      ok: false;
      reason: 'not_found' | 'error';
      message: string;
    };

/**
 * Update the custom name of a discussion.
 * Pass an empty string or undefined to clear the custom name (will revert to contact name).
 */
export async function updateDiscussionName(
  discussionId: number,
  newName: string | undefined
): Promise<UpdateDiscussionNameResult> {
  const trimmed = newName?.trim();
  const customName = trimmed && trimmed.length > 0 ? trimmed : undefined;

  try {
    const discussion = await db.discussions.get(discussionId);
    if (!discussion) {
      return {
        ok: false,
        reason: 'not_found',
        message: 'Discussion not found.',
      };
    }

    await db.discussions.update(discussionId, { customName });

    return { ok: true, trimmedName: customName };
  } catch (e) {
    console.error('updateDiscussionName failed', e);
    return {
      ok: false,
      reason: 'error',
      message: 'Failed to update name. Please try again.',
    };
  }
}
