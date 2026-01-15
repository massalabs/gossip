/**
 * Discussion Management SDK Tests
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import {
  getDiscussions,
  getDiscussion,
  updateDiscussionName,
  isDiscussionStableState,
  getActiveDiscussions,
  getUnreadCount,
  markDiscussionAsRead,
} from '../src/discussions';
import { initializeAccount } from '../src/account';
import { getSession } from '../src/utils';
import { addContact } from '../src/contacts';
import {
  db,
  DiscussionStatus,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '@/db';
import { createMessageProtocol } from '@/api/messageProtocol';
import { MessageProtocolType } from '@/config/protocol';
import { announcementService } from '@/services/announcement';
import { messageService } from '@/services/message';
import { generateUserKeys } from '@/wasm/userKeys';
import { encodeUserId } from '@/utils/userId';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

describe('Discussion Management', () => {
  let ownerUserId: string;
  let contactUserId: string;
  let contactPublicKeys: UserPublicKeys;

  beforeAll(async () => {
    const mockProtocol = createMessageProtocol(MessageProtocolType.MOCK);
    announcementService.setMessageProtocol(mockProtocol);
    messageService.setMessageProtocol(mockProtocol);
  });

  beforeEach(async () => {
    // Database is cleaned up by setup.ts afterEach hook
    if (!db.isOpen()) {
      await db.open();
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
    const session = getSession();
    ownerUserId = session?.userIdEncoded || '';

    // Generate contact keys
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const keys = await generateUserKeys(mnemonic);
    contactPublicKeys = keys.public_keys();
    contactUserId = encodeUserId(contactPublicKeys.derive_id());

    // Add contact
    await addContact(
      ownerUserId,
      contactUserId,
      'Test Contact',
      contactPublicKeys
    );
  });

  describe('getDiscussions', () => {
    it('should return empty array when no discussions exist', async () => {
      const discussions = await getDiscussions(ownerUserId);
      expect(discussions).toEqual([]);
    });

    it('should return all discussions', async () => {
      // Create a discussion manually
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const discussions = await getDiscussions(ownerUserId);
      expect(discussions.length).toBe(1);
    });
  });

  describe('getDiscussion', () => {
    it('should return null for non-existent discussion', async () => {
      const discussion = await getDiscussion(ownerUserId, 'gossip1nonexistent');
      expect(discussion).toBeNull();
    });

    it('should return discussion when it exists', async () => {
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const discussion = await getDiscussion(ownerUserId, contactUserId);
      expect(discussion).toBeDefined();
      expect(discussion?.contactUserId).toBe(contactUserId);
    });
  });

  describe('getActiveDiscussions', () => {
    it('should return only active discussions', async () => {
      // Create active discussion
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Create pending discussion with different contact
      const mnemonic2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      const keys2 = await generateUserKeys(mnemonic2);
      const contactUserId2 = encodeUserId(keys2.public_keys().derive_id());

      await db.discussions.add({
        ownerUserId,
        contactUserId: contactUserId2,
        direction: DiscussionDirection.RECEIVED,
        status: DiscussionStatus.PENDING,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const activeDiscussions = await getActiveDiscussions(ownerUserId);
      expect(activeDiscussions.length).toBe(1);
      expect(activeDiscussions[0].status).toBe(DiscussionStatus.ACTIVE);
    });
  });

  describe('updateDiscussionName', () => {
    it('should update discussion custom name', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await updateDiscussionName(discussionId, 'Custom Name');
      expect(result.ok).toBe(true);

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.customName).toBe('Custom Name');
    });

    it('should clear custom name when undefined', async () => {
      const discussionId = await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        customName: 'Old Name',
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await updateDiscussionName(discussionId, undefined);
      expect(result.ok).toBe(true);

      const discussion = await db.discussions.get(discussionId);
      expect(discussion?.customName).toBeUndefined();
    });

    it('should return error for non-existent discussion', async () => {
      const result = await updateDiscussionName(99999, 'New Name');
      expect(result.ok).toBe(false);
    });
  });

  describe('isDiscussionStableState', () => {
    it('should return true for active discussion', async () => {
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const isStable = await isDiscussionStableState(
        ownerUserId,
        contactUserId
      );
      expect(isStable).toBe(true);
    });

    it('should return false for broken discussion', async () => {
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.BROKEN,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const isStable = await isDiscussionStableState(
        ownerUserId,
        contactUserId
      );
      expect(isStable).toBe(false);
    });
  });

  describe('getUnreadCount', () => {
    it('should return 0 when no unread messages', async () => {
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const count = await getUnreadCount(ownerUserId);
      expect(count).toBe(0);
    });

    it('should return total unread count across discussions', async () => {
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 3,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const count = await getUnreadCount(ownerUserId);
      expect(count).toBe(3);
    });
  });

  describe('markDiscussionAsRead', () => {
    it('should mark all messages as read', async () => {
      // Create discussion with unread count
      await db.discussions.add({
        ownerUserId,
        contactUserId,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Add some delivered incoming messages
      await db.messages.add({
        ownerUserId,
        contactUserId,
        content: 'Test message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
      });

      await markDiscussionAsRead(ownerUserId, contactUserId);

      // Check discussion unread count is reset
      const discussion = await getDiscussion(ownerUserId, contactUserId);
      expect(discussion?.unreadCount).toBe(0);
    });
  });
});
