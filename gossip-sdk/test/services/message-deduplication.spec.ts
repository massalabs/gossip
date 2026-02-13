/**
 * Message Deduplication tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionDirection,
  DiscussionStatus,
} from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { defaultSdkConfig, type SdkConfig } from '../../src/config/sdk';
import { eq, and, gte, lte } from 'drizzle-orm';
import { getSqliteDb, clearAllTables } from '../../src/sqlite';
import * as schema from '../../src/schema';
import { insertDiscussion } from '../../src/queries/discussions';
import { insertMessage, getMessageById } from '../../src/queries/messages';

const DEDUP_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const DEDUP_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));

/** Helper: insert the default discussion for dedup tests */
async function addDefaultDiscussion(
  ownerUserId: string = DEDUP_OWNER_USER_ID,
  contactUserId: string = DEDUP_CONTACT_USER_ID
) {
  await insertDiscussion({
    ownerUserId,
    contactUserId,
    direction: DiscussionDirection.RECEIVED,
    status: DiscussionStatus.ACTIVE,
    weAccepted: true,
    sendAnnouncement: null,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Helper: add a message and return its id */
async function addMessage(
  data: typeof schema.messages.$inferInsert
): Promise<number> {
  return insertMessage(data);
}

/** Helper: get a message by id */
async function getMessage(id: number) {
  return getMessageById(id);
}

/** Helper: find duplicate incoming message within a time window */
async function findDuplicateIncoming(
  ownerUserId: string,
  contactUserId: string,
  content: string,
  timestamp: Date,
  windowMs: number = 30000
) {
  const windowStart = new Date(timestamp.getTime() - windowMs);
  const windowEnd = new Date(timestamp.getTime() + windowMs);

  return getSqliteDb()
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.INCOMING),
        eq(schema.messages.content, content),
        gte(schema.messages.timestamp, windowStart),
        lte(schema.messages.timestamp, windowEnd)
      )
    )
    .get();
}

describe('Message Deduplication', () => {
  beforeEach(clearAllTables);

  describe('isDuplicateMessage (via storeDecryptedMessages)', () => {
    async function storeIncomingMessage(
      content: string,
      timestamp: Date,
      seeker: Uint8Array
    ): Promise<number | null> {
      const existing = await findDuplicateIncoming(
        DEDUP_OWNER_USER_ID,
        DEDUP_CONTACT_USER_ID,
        content,
        timestamp
      );

      if (existing) {
        return null;
      }

      return await addMessage({
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
      await addDefaultDiscussion();
      const timestamp = new Date();
      const id = await storeIncomingMessage(
        'Hello world',
        timestamp,
        new Uint8Array([1, 2, 3])
      );

      expect(id).not.toBeNull();

      const message = await getMessage(id!);
      expect(message?.content).toBe('Hello world');
    });

    it('should detect duplicate with same content and similar timestamp', async () => {
      await addDefaultDiscussion();
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
      await addDefaultDiscussion();
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
      await addDefaultDiscussion();
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
      await addDefaultDiscussion();
      const timestamp = new Date();

      await addMessage({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Hello world',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const outgoingId = await addMessage({
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
      await addDefaultDiscussion();
      const customConfig: SdkConfig = {
        ...defaultSdkConfig,
        messages: {
          ...defaultSdkConfig.messages,
          deduplicationWindowMs: 5000,
        },
      };

      const timestamp = new Date();

      await addMessage({
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

      const duplicate = await findDuplicateIncoming(
        DEDUP_OWNER_USER_ID,
        DEDUP_CONTACT_USER_ID,
        'Test message',
        timestamp2,
        windowMs
      );

      expect(duplicate).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty content messages', async () => {
      await addDefaultDiscussion();
      const timestamp = new Date();

      const id1 = await addMessage({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: '',
        type: MessageType.KEEP_ALIVE,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const duplicate = await findDuplicateIncoming(
        DEDUP_OWNER_USER_ID,
        DEDUP_CONTACT_USER_ID,
        '',
        timestamp
      );

      expect(duplicate?.id).toBe(id1);
    });

    it('should handle messages from different contacts separately', async () => {
      await addDefaultDiscussion();
      const timestamp = new Date();
      const CONTACT_2_USER_ID = encodeUserId(new Uint8Array(32).fill(3));

      await addDefaultDiscussion(DEDUP_OWNER_USER_ID, CONTACT_2_USER_ID);

      await addMessage({
        ownerUserId: DEDUP_OWNER_USER_ID,
        contactUserId: DEDUP_CONTACT_USER_ID,
        content: 'Hello',
        type: MessageType.TEXT,
        direction: MessageDirection.INCOMING,
        status: MessageStatus.DELIVERED,
        timestamp,
        seeker: new Uint8Array([1, 2, 3]),
      });

      const duplicateFromContact2 = await findDuplicateIncoming(
        DEDUP_OWNER_USER_ID,
        CONTACT_2_USER_ID,
        'Hello',
        timestamp
      );

      expect(duplicateFromContact2).toBeUndefined();
    });
  });
});
