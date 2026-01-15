/**
 * Message Operations SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMessages,
  getMessage,
  findMessageBySeeker,
  getMessagesForContact,
} from '../src/messages';
import { initializeAccount } from '../src/account';
import { getSession } from '../src/utils';
import { addContact } from '../src/contacts';
import { db, MessageType, MessageDirection, MessageStatus } from '../src/db';
import { generateUserKeys } from '../src/wasm/userKeys';
import { encodeUserId } from '../src/utils/userId';
import type { UserPublicKeys } from '@/assets/generated/wasm/gossip_wasm';

describe('Message Operations', () => {
  let ownerUserId: string;
  let contactUserId: string;
  let contactPublicKeys: UserPublicKeys;

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

  describe('getMessages', () => {
    it('should return empty array when no messages exist', async () => {
      const messages = await getMessages(ownerUserId);
      expect(messages).toEqual([]);
    });

    it('should return all messages for owner', async () => {
      await db.messages.add({
        ownerUserId,
        contactUserId,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
      });

      const messages = await getMessages(ownerUserId);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Test message');
    });

    it('should filter by contactUserId when provided', async () => {
      // Generate another contact
      const mnemonic2 = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';
      const keys2 = await generateUserKeys(mnemonic2);
      const otherContactId = encodeUserId(keys2.public_keys().derive_id());

      await addContact(
        ownerUserId,
        otherContactId,
        'Other Contact',
        keys2.public_keys()
      );

      await db.messages.add({
        ownerUserId,
        contactUserId,
        content: 'Message 1',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
      });

      await db.messages.add({
        ownerUserId,
        contactUserId: otherContactId,
        content: 'Message 2',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
      });

      const messages = await getMessages(ownerUserId, contactUserId);
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe('Message 1');
    });
  });

  describe('getMessage', () => {
    it('should return null for non-existent message', async () => {
      const message = await getMessage(999);
      expect(message).toBeNull();
    });

    it('should return message when it exists', async () => {
      const messageId = await db.messages.add({
        ownerUserId,
        contactUserId,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
      });

      const message = await getMessage(messageId);
      expect(message).toBeDefined();
      expect(message?.content).toBe('Test message');
    });
  });

  describe('findMessageBySeeker', () => {
    it('should return undefined for non-existent seeker', async () => {
      const seeker = new Uint8Array(32);
      const message = await findMessageBySeeker(seeker, ownerUserId);
      expect(message).toBeUndefined();
    });

    it('should return message when seeker exists', async () => {
      const seeker = new Uint8Array(32);
      seeker.fill(1);

      await db.messages.add({
        ownerUserId,
        contactUserId,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker,
      });

      const message = await findMessageBySeeker(seeker, ownerUserId);
      expect(message).toBeDefined();
      expect(message?.content).toBe('Test message');
    });
  });

  describe('getMessagesForContact', () => {
    it('should return messages with pagination', async () => {
      // Add multiple messages
      for (let i = 1; i <= 10; i++) {
        await db.messages.add({
          ownerUserId,
          contactUserId,
          content: `Message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
          timestamp: new Date(),
        });
      }

      // Get only 5 messages
      const messages = await getMessagesForContact(
        ownerUserId,
        contactUserId,
        5
      );
      expect(messages.length).toBe(5);
    });

    it('should return messages in reverse order (most recent first)', async () => {
      // Add messages with different timestamps
      const now = Date.now();
      for (let i = 1; i <= 3; i++) {
        await db.messages.add({
          ownerUserId,
          contactUserId,
          content: `Message ${i}`,
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
          timestamp: new Date(now + i * 1000),
        });
      }

      const messages = await getMessagesForContact(
        ownerUserId,
        contactUserId,
        3
      );
      // Most recent message should be first
      expect(messages[0].content).toBe('Message 3');
      expect(messages[2].content).toBe('Message 1');
    });
  });
});
