/**
 * Discussion Management SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getDiscussions,
  getDiscussion,
  updateDiscussionName,
  isDiscussionStableState,
} from '../src/discussions';
import { initializeAccount } from '../src/account';
import { getAccount } from '../src/utils';
import { addContact } from '../src/contacts';
import { db } from '../../src/db';
import { DiscussionStatus, DiscussionDirection } from '../../src/db';
import { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

describe('Discussion Management', () => {
  let ownerUserId: string;
  let contactUserId: string;
  let contactPublicKeys: UserPublicKeys;

  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    if (!db.isOpen()) {
      await db.open();
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
    const account = getAccount();
    ownerUserId = account.userProfile?.userId || '';

    // Create mock public keys for contact
    contactPublicKeys = new UserPublicKeys(
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32)
    );
    contactUserId = 'gossip1testcontact';

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
});
