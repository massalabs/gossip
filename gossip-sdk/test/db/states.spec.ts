/**
 * Database state transitions tests
 *
 * Tests for discussion and message state transitions, stability detection,
 * pending announcements, and contact deletion cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

describe('Discussion State Transitions', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.discussions.clear();
    await db.messages.clear();
    await db.contacts.clear();
  });

  describe('Discussion Direction', () => {
    it('should track INITIATED direction when we start discussion', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId: TEST_OWNER_USER_ID,
        contactUserId: TEST_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.PENDING,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.direction).toBe(DiscussionDirection.INITIATED);
    });

    it('should track RECEIVED direction when peer starts discussion', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId: TEST_OWNER_USER_ID,
        contactUserId: TEST_CONTACT_USER_ID,
        direction: DiscussionDirection.RECEIVED,
        status: DiscussionStatus.PENDING,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.direction).toBe(DiscussionDirection.RECEIVED);
    });
  });

  describe('Status Transitions', () => {
    it('should allow PENDING -> ACTIVE transition', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId: TEST_OWNER_USER_ID,
        contactUserId: TEST_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.PENDING,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.discussions.update(discussionId, {
        status: DiscussionStatus.ACTIVE,
        updatedAt: new Date(),
      });

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
    });

    it('should allow SEND_FAILED -> PENDING on successful retry', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId: TEST_OWNER_USER_ID,
        contactUserId: TEST_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.SEND_FAILED,
        initiationAnnouncement: new Uint8Array([1, 2, 3]),
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.discussions.update(discussionId, {
        status: DiscussionStatus.PENDING,
        updatedAt: new Date(),
      });

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.status).toBe(DiscussionStatus.PENDING);
    });

    it('should allow ACTIVE -> BROKEN on session killed', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId: TEST_OWNER_USER_ID,
        contactUserId: TEST_CONTACT_USER_ID,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await db.discussions.update(discussionId, {
        status: DiscussionStatus.BROKEN,
        updatedAt: new Date(),
      });

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.status).toBe(DiscussionStatus.BROKEN);
    });
  });
});

describe('Announcement Storage for Retry', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.discussions.clear();
    await db.pendingAnnouncements.clear();
  });

  it('should persist announcement bytes for retry on SEND_FAILED', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const discussionId = await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: announcement,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await db.discussions.get(discussionId);
    expect(discussion?.initiationAnnouncement).toBeDefined();
    expect(discussion?.initiationAnnouncement?.length).toBe(5);
  });

  it('should find discussions needing retry', async () => {
    const announcement = new Uint8Array([10, 20, 30]);
    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: announcement,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const failedDiscussions = await db.discussions
      .where('status')
      .equals(DiscussionStatus.SEND_FAILED)
      .filter(d => d.initiationAnnouncement !== undefined)
      .toArray();

    expect(failedDiscussions.length).toBe(1);
    expect(failedDiscussions[0].initiationAnnouncement).toBeDefined();
  });

  it('should clear initiationAnnouncement when marked BROKEN', async () => {
    const discussionId = await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: new Uint8Array([1, 2, 3]),
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.discussions.update(discussionId, {
      status: DiscussionStatus.BROKEN,
      initiationAnnouncement: undefined,
      updatedAt: new Date(),
    });

    const discussion = await db.discussions.get(discussionId);
    expect(discussion?.status).toBe(DiscussionStatus.BROKEN);
    expect(discussion?.initiationAnnouncement).toBeUndefined();
  });
});

describe('Message Status Transitions', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.messages.clear();
  });

  it('should transition SENDING -> SENT on successful send', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.SENT,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.SENT);
  });

  it('should transition SENDING -> FAILED on send failure', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.FAILED,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.FAILED);
  });

  it('should transition SENT -> DELIVERED on acknowledgment', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.DELIVERED,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.DELIVERED);
  });
});

describe('Discussion Stability Detection', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.discussions.clear();
    await db.messages.clear();
  });

  it('should detect unstable state when FAILED messages exist without encryptedMessage', async () => {
    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    });

    const messages = await db.messages
      .where('[ownerUserId+contactUserId+direction]')
      .equals([
        TEST_OWNER_USER_ID,
        TEST_CONTACT_USER_ID,
        MessageDirection.OUTGOING,
      ])
      .sortBy('id');

    const lastMessage = messages[messages.length - 1];
    const isUnstable =
      lastMessage?.status === MessageStatus.FAILED &&
      !lastMessage?.encryptedMessage;

    expect(isUnstable).toBe(true);
  });

  it('should detect stable state when failed messages have encryptedMessage', async () => {
    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      encryptedMessage: new Uint8Array([1, 2, 3]),
      timestamp: new Date(),
    });

    const messages = await db.messages
      .where('[ownerUserId+contactUserId+direction]')
      .equals([
        TEST_OWNER_USER_ID,
        TEST_CONTACT_USER_ID,
        MessageDirection.OUTGOING,
      ])
      .sortBy('id');

    const lastMessage = messages[messages.length - 1];
    const isUnstable =
      lastMessage?.status === MessageStatus.FAILED &&
      !lastMessage?.encryptedMessage;

    expect(isUnstable).toBe(false);
  });

  it('should identify BROKEN discussion status', async () => {
    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.BROKEN,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await db.getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(discussion?.status).toBe(DiscussionStatus.BROKEN);
  });
});

describe('Pending Announcements', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.pendingAnnouncements.clear();
  });

  it('should store pending announcements for later processing', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const counter = '12345';

    await db.pendingAnnouncements.add({
      announcement,
      counter,
      fetchedAt: new Date(),
    });

    const pending = await db.pendingAnnouncements.toArray();
    expect(pending.length).toBe(1);
    expect(pending[0].counter).toBe(counter);
  });

  it('should support partial deletion of processed announcements', async () => {
    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([1]),
      counter: '1',
      fetchedAt: new Date(),
    });

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([2]),
      counter: '2',
      fetchedAt: new Date(),
    });

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([3]),
      counter: '3',
      fetchedAt: new Date(),
    });

    const pending = await db.pendingAnnouncements.toArray();
    const idsToDelete = pending.slice(0, 2).map(p => p.id!);
    await db.pendingAnnouncements.bulkDelete(idsToDelete);

    const remaining = await db.pendingAnnouncements.toArray();
    expect(remaining.length).toBe(1);
    expect(remaining[0].counter).toBe('3');
  });
});

describe('Contact Deletion Cleanup', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.contacts.clear();
    await db.discussions.clear();
    await db.messages.clear();
  });

  it('should delete associated discussions when contact is deleted', async () => {
    await db.contacts.add({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let discussion = await db.getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(discussion).toBeDefined();

    await db.transaction(
      'rw',
      [db.contacts, db.discussions, db.messages],
      async () => {
        await db.contacts
          .where('[ownerUserId+userId]')
          .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
          .delete();

        await db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
          .delete();
      }
    );

    const contact = await db.getContactByOwnerAndUserId(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    discussion = await db.getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );

    expect(contact).toBeUndefined();
    expect(discussion).toBeUndefined();
  });

  it('should delete associated messages when contact is deleted', async () => {
    await db.contacts.add({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    let messages = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
      .toArray();
    expect(messages.length).toBe(1);

    await db.transaction('rw', [db.contacts, db.messages], async () => {
      await db.contacts
        .where('[ownerUserId+userId]')
        .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
        .delete();

      await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
        .delete();
    });

    messages = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
      .toArray();
    expect(messages.length).toBe(0);
  });
});
