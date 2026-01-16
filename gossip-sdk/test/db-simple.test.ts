/**
 * Simple Database Operations Tests
 *
 * Minimal test to verify database operations work.
 */

import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  GossipDatabase,
  DiscussionStatus,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

// Create a fresh database for these tests
const testDb = new GossipDatabase();

describe('Simple Database Tests', () => {
  beforeEach(async () => {
    if (!testDb.isOpen()) {
      await testDb.open();
    }
    // Clear relevant tables
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
      status: DiscussionStatus.PENDING,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.direction).toBe(DiscussionDirection.INITIATED);
    expect(discussion?.status).toBe(DiscussionStatus.PENDING);
  });

  it('should update discussion status', async () => {
    const discussionId = await testDb.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.PENDING,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await testDb.discussions.update(discussionId, {
      status: DiscussionStatus.ACTIVE,
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.status).toBe(DiscussionStatus.ACTIVE);
  });

  it('should create and retrieve a message', async () => {
    const messageId = await testDb.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    const message = await testDb.messages.get(messageId);
    expect(message?.content).toBe('Test message');
    expect(message?.status).toBe(MessageStatus.SENDING);
  });

  it('should reset SENDING messages to FAILED', async () => {
    await testDb.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Stuck message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    const count = await testDb.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .modify({ status: MessageStatus.FAILED });

    expect(count).toBe(1);

    const messages = await testDb.messages
      .where('status')
      .equals(MessageStatus.FAILED)
      .toArray();
    expect(messages.length).toBe(1);
  });

  it('should store announcement bytes for retry', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const discussionId = await testDb.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.SEND_FAILED,
      initiationAnnouncement: announcement,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await testDb.discussions.get(discussionId);
    expect(discussion?.initiationAnnouncement).toBeDefined();
    expect(discussion?.initiationAnnouncement?.length).toBe(5);
  });
});
