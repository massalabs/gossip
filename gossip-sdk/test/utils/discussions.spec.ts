/**
 * Discussion utilities tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DiscussionDirection, DiscussionStatus } from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { updateDiscussionName } from '../../src/utils/discussions';
import { clearAllTables } from '../../src/sqlite';
import {
  insertDiscussion,
  getDiscussionById,
} from '../../src/queries/discussions';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(6));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(7));

describe('Discussion utilities', () => {
  beforeEach(clearAllTables);

  it('updates the custom discussion name', async () => {
    const discussionId = await insertDiscussion({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await updateDiscussionName(discussionId, 'Custom Name');

    expect(result.success).toBe(true);
    const discussion = await getDiscussionById(discussionId);
    expect(discussion?.customName).toBe('Custom Name');
  });

  it('clears the custom name when empty', async () => {
    const discussionId = await insertDiscussion({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      sendAnnouncement: null,
      customName: 'Old Name',
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await updateDiscussionName(discussionId, '  ');

    expect(result.success).toBe(true);
    const discussion = await getDiscussionById(discussionId);
    expect(discussion?.customName).toBeNull();
  });

  it('returns not_found for unknown discussion', async () => {
    const result = await updateDiscussionName(99999, 'Name');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('not_found');
    }
  });
});
