/**
 * Discussion utilities tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, DiscussionDirection, DiscussionStatus } from '../../src/db.js';
import { encodeUserId } from '../../src/utils/userId.js';
import { updateDiscussionName } from '../../src/utils/discussions.js';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(6));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(7));

describe('Discussion utilities', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('updates the custom discussion name', async () => {
    const discussionId = await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await updateDiscussionName(discussionId, 'Custom Name', db);

    expect(result.success).toBe(true);
    const discussion = await db.discussions.get(discussionId);
    expect(discussion?.customName).toBe('Custom Name');
  });

  it('clears the custom name when empty', async () => {
    const discussionId = await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      customName: 'Old Name',
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await updateDiscussionName(discussionId, '  ', db);

    expect(result.success).toBe(true);
    const discussion = await db.discussions.get(discussionId);
    expect(discussion?.customName).toBeUndefined();
  });

  it('returns not_found for unknown discussion', async () => {
    const result = await updateDiscussionName(99999, 'Name', db);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('not_found');
    }
  });
});
