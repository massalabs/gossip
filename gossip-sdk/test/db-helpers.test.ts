/**
 * Database Helper Methods Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../src/db';
import { encodeUserId } from '../src/utils/userId';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(6));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(7));

describe('Database helper methods', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('returns discussions sorted by last message timestamp', async () => {
    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      lastMessageTimestamp: new Date('2024-01-01'),
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
    });

    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: encodeUserId(new Uint8Array(32).fill(8)),
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      lastMessageTimestamp: new Date('2024-02-01'),
      createdAt: new Date('2024-02-01'),
      updatedAt: new Date('2024-02-01'),
    });

    const discussions = await db.getDiscussionsByOwner(OWNER_USER_ID);
    expect(discussions[0].lastMessageTimestamp?.toISOString()).toBe(
      new Date('2024-02-01').toISOString()
    );
  });

  it('returns active discussions only', async () => {
    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: encodeUserId(new Uint8Array(32).fill(9)),
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.PENDING,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const active = await db.getActiveDiscussionsByOwner(OWNER_USER_ID);
    expect(active.length).toBe(1);
    expect(active[0].status).toBe(DiscussionStatus.ACTIVE);
  });

  it('aggregates unread counts across discussions', async () => {
    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 2,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: encodeUserId(new Uint8Array(32).fill(10)),
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 3,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const unread = await db.getUnreadCountByOwner(OWNER_USER_ID);
    expect(unread).toBe(5);
  });

  it('marks delivered incoming messages as read', async () => {
    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    await db.markMessagesAsRead(OWNER_USER_ID, CONTACT_USER_ID);

    const messages = await db.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([OWNER_USER_ID, CONTACT_USER_ID, MessageStatus.READ])
      .toArray();
    expect(messages.length).toBe(1);

    const discussion = await db.getDiscussionByOwnerAndContact(
      OWNER_USER_ID,
      CONTACT_USER_ID
    );
    expect(discussion?.unreadCount).toBe(0);
  });
});
