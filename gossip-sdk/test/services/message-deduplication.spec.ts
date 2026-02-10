/**
 * Message Deduplication tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GossipDatabase,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../../src/db.js';
import { encodeUserId } from '../../src/utils/userId.js';
import { defaultSdkConfig, type SdkConfig } from '../../src/config/sdk.js';

const DEDUP_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const DEDUP_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));

describe('Message Deduplication', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    if (!testDb.isOpen()) {
      await testDb.open();
    }
    await Promise.all(testDb.tables.map(table => table.clear()));

    await testDb.discussions.add({
      ownerUserId: DEDUP_OWNER_USER_ID,
      contactUserId: DEDUP_CONTACT_USER_ID,
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  describe('isDuplicateMessage (via storeDecryptedMessages)', () => {
    async function storeIncomingMessage(
      content: string,
      timestamp: Date,
      seeker: Uint8Array
    ): Promise<number | null> {
      const existing = await testDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([DEDUP_OWNER_USER_ID, DEDUP_CONTACT_USER_ID])
        .and(
          msg =>
            msg.direction === MessageDirection.INCOMING &&
            msg.content === content &&
            msg.timestamp >= new Date(timestamp.getTime() - 30000) &&
            msg.timestamp <= new Date(timestamp.getTime() + 30000)
        )
        .first();

      if (existing) {
        return null;
      }

      return await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content,
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker,
      });
    }

    it('should store first message normally', async () => {
      const timestamp = new Date();
      const id = await storeIncomingMessage(
        'Hello world',
        timestamp,
        new Uint8Array([1, 2, 3])
      );

      expect(id).not.toBeNull();

      const message = await testDb.messages.get(id!);
      expect(message?.content).toBe('Hello world');
    });

    it('should detect duplicate with same content and similar timestamp', async () => {
      const timestamp = new Date();

      const id1 = await storeIncomingMessage(
        'Hello world',
        timestamp,
        new Uint8Array([1, 2, 3])
      );
      expect(id1).not.toBeNull();

      const timestamp2 = new Date(timestamp.getTime() + 5000);
      const id2 = await storeIncomingMessage(
        'Hello world',
        timestamp2,
        new Uint8Array([4, 5, 6])
      );

      expect(id2).toBeNull();
    });

    it('should NOT detect duplicate if content differs', async () => {
      const timestamp = new Date();

      const id1 = await storeIncomingMessage(
        'Hello world',
        timestamp,
        new Uint8Array([1, 2, 3])
      );
      expect(id1).not.toBeNull();

      const id2 = await storeIncomingMessage(
        'Goodbye world',
        timestamp,
        new Uint8Array([4, 5, 6])
      );

      expect(id2).not.toBeNull();
    });

    it('should NOT detect duplicate if timestamp outside window', async () => {
      const timestamp = new Date();

      const id1 = await storeIncomingMessage(
        'Hello world',
        timestamp,
        new Uint8Array([1, 2, 3])
      );
      expect(id1).not.toBeNull();

      const timestamp2 = new Date(timestamp.getTime() + 60000);
      const id2 = await storeIncomingMessage(
        'Hello world',
        timestamp2,
        new Uint8Array([4, 5, 6])
      );

      expect(id2).not.toBeNull();
    });

    it('should NOT flag outgoing messages as duplicates of incoming', async () => {
      const timestamp = new Date();

      await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Hello world',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const outgoingId = await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Hello world',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp,
        seeker: new Uint8Array([4, 5, 6]),
      });

      expect(outgoingId).toBeDefined();
    });
  });

  describe('deduplication window configuration', () => {
    it('should respect custom deduplication window', async () => {
      const customConfig: SdkConfig = {
        ...defaultSdkConfig,
        messages: {
          ...defaultSdkConfig.messages,
          deduplicationWindowMs: 5000,
        },
      };

      const timestamp = new Date();

      await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const timestamp2 = new Date(timestamp.getTime() + 10000);
      const windowMs = customConfig.messages.deduplicationWindowMs;
      const windowStart = new Date(timestamp2.getTime() - windowMs);
      const windowEnd = new Date(timestamp2.getTime() + windowMs);

      const duplicate = await testDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([DEDUP_OWNER_USER_ID, DEDUP_CONTACT_USER_ID])
        .and(
          msg =>
            msg.direction === MessageDirection.INCOMING &&
            msg.content === 'Test message' &&
            msg.timestamp >= windowStart &&
            msg.timestamp <= windowEnd
        )
        .first();

      expect(duplicate).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty content messages', async () => {
      const timestamp = new Date();

      const id1 = await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const windowMs = 30000;
      const windowStart = new Date(timestamp.getTime() - windowMs);
      const windowEnd = new Date(timestamp.getTime() + windowMs);

      const duplicate = await testDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([DEDUP_OWNER_USER_ID, DEDUP_CONTACT_USER_ID])
        .and(
          msg =>
            msg.direction === MessageDirection.INCOMING &&
            msg.content === '' &&
            msg.timestamp >= windowStart &&
            msg.timestamp <= windowEnd
        )
        .first();

      expect(duplicate?.id).toBe(id1);
    });

    it('should handle messages from different contacts separately', async () => {
      const timestamp = new Date();
      const CONTACT_2_USER_ID = encodeUserId(new Uint8Array(32).fill(3));

      await testDb.discussions.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: CONTACT_2_USER_ID,
        direction: DiscussionDirection.RECEIVED,
        status: DiscussionStatus.ACTIVE,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await testDb.messages.add({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Hello',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const windowMs = 30000;
      const windowStart = new Date(timestamp.getTime() - windowMs);
      const windowEnd = new Date(timestamp.getTime() + windowMs);

      const duplicateFromContact2 = await testDb.messages
        .where('[ownerUserId+contactUserId]')
        .equals([DEDUP_OWNER_USER_ID, CONTACT_2_USER_ID])
        .and(
          msg =>
            msg.direction === MessageDirection.INCOMING &&
            msg.content === 'Hello' &&
            msg.timestamp >= windowStart &&
            msg.timestamp <= windowEnd
        )
        .first();

      expect(duplicateFromContact2).toBeUndefined();
    });
  });
});
