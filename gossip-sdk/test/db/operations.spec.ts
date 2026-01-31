/**
 * Database operations tests
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  GossipDatabase,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

const testDb = new GossipDatabase();

describe('Simple Database Tests', () => {
  beforeEach(async () => {
    if (!testDb.isOpen()) {
      await testDb.open();
    }
    await testDb.discussions.clear();
    await testDb.messages.clear();
    await testDb.contacts.clear();
    await testDb.pendingAnnouncements.clear();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('should create and retrieve a discussion', async () => {
    const discussionId = await testDb.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.direction).toBe(DiscussionDirection.INITIATED);
    expect(discussion?.weAccepted).toBe(true);
    expect(discussion?.ownerUserId).toBe(TEST_OWNER_USER_ID);
    expect(discussion?.contactUserId).toBe(TEST_CONTACT_USER_ID);
  });

  it('should update discussion weAccepted and sendAnnouncement', async () => {
    const discussionId = await testDb.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: false,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await testDb.discussions.update(discussionId, {
      weAccepted: true,
      sendAnnouncement: {
        announcement_bytes: new Uint8Array([1, 2, 3, 4, 5]),
        when_to_send: new Date(),
      },
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.weAccepted).toBe(true);
    expect(discussion?.sendAnnouncement).toBeDefined();
    expect(discussion?.sendAnnouncement?.announcement_bytes.length).toBe(5);
    expect(discussion?.sendAnnouncement?.when_to_send).toBeDefined();
  });

  it('should create and retrieve a message', async () => {
    const messageId = await testDb.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
    });

    const message = await testDb.messages.get(messageId);
    expect(message?.content).toBe('Test message');
    expect(message?.status).toBe(MessageStatus.READY);
  });

  it('should store announcement bytes for retry', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const discussionId = await testDb.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: {
        announcement_bytes: announcement,
        when_to_send: new Date(),
      },
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.sendAnnouncement).toBeDefined();
    expect(discussion?.sendAnnouncement?.announcement_bytes.length).toBe(5);
  });
});
