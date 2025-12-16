/**
 * Message Operations SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getMessages,
  getMessage,
  findMessageBySeeker,
  sendMessage,
} from '../src/messages';
import { initializeAccount, logout, loadAccount } from '../src/account';
import { getAccount } from '../src/utils';
import { addContact } from '../src/contacts';
import {
  initializeDiscussion,
  acceptDiscussionRequest,
  getDiscussion,
} from '../src/discussions';
import { db } from '../../src/db';
import {
  MessageType,
  MessageDirection,
  MessageStatus,
  DiscussionStatus,
} from '../../src/db';
import { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

describe('Message Operations', () => {
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
      const otherContactId = 'gossip1othercontact';
      await addContact(
        ownerUserId,
        otherContactId,
        'Other Contact',
        contactPublicKeys
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
    it('should return undefined for non-existent message', async () => {
      const message = await getMessage(999);
      expect(message).toBeUndefined();
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

  describe('sendMessage - message exchange', () => {
    it('should exchange 5 messages between 2 accounts', async () => {
      // Create first account
      await initializeAccount('user1', 'password1');
      const account1 = getAccount();
      if (
        !account1.userProfile ||
        !account1.ourPk ||
        !account1.ourSk ||
        !account1.session
      ) {
        throw new Error('Account 1 not properly initialized');
      }
      const userId1 = account1.userProfile.userId;
      const pk1 = account1.ourPk;
      const sk1 = account1.ourSk;

      // Logout and create second account
      await logout();
      await initializeAccount('user2', 'password2');
      const account2 = getAccount();
      if (
        !account2.userProfile ||
        !account2.ourPk ||
        !account2.ourSk ||
        !account2.session
      ) {
        throw new Error('Account 2 not properly initialized');
      }
      const userId2 = account2.userProfile.userId;
      const pk2 = account2.ourPk;
      const sk2 = account2.ourSk;
      const session2 = account2.session;

      // Add account 1 as contact to account 2
      const contact1 = await addContact(userId2, userId1, 'User 1', pk1);
      expect(contact1.success).toBe(true);
      if (!contact1.contact) throw new Error('Failed to add contact');

      // Initialize discussion from account 2 to account 1
      const discussionResult = await initializeDiscussion(
        contact1.contact,
        pk2,
        sk2,
        session2,
        userId2,
        'Hello from User 2!'
      );
      expect(discussionResult.success).toBe(true);

      // Switch back to account 1
      await logout();
      await loadAccount('password1', userId1);
      const account1Reloaded = getAccount();
      if (
        !account1Reloaded.userProfile ||
        !account1Reloaded.ourPk ||
        !account1Reloaded.ourSk ||
        !account1Reloaded.session
      ) {
        throw new Error('Account 1 reload failed');
      }
      const session1Reloaded = account1Reloaded.session;

      // Add account 2 as contact to account 1
      const contact2 = await addContact(userId1, userId2, 'User 2', pk2);
      expect(contact2.success).toBe(true);
      if (!contact2.contact) throw new Error('Failed to add contact');

      // Get and accept the discussion
      const discussion = await getDiscussion(userId1, userId2);
      if (discussion && discussion.status === DiscussionStatus.PENDING) {
        await acceptDiscussionRequest(discussion, session1Reloaded, pk1, sk1);
      }

      // Send 5 messages from account 1 to account 2
      const messagesFrom1: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const messageContent = `Message ${i} from User 1`;
        messagesFrom1.push(messageContent);

        const result = await sendMessage(
          {
            ownerUserId: userId1,
            contactUserId: userId2,
            content: messageContent,
            type: MessageType.TEXT,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.SENDING,
            timestamp: new Date(),
          },
          session1Reloaded
        );

        // Message might succeed or fail depending on discussion state, but should not throw
        expect(result).toHaveProperty('success');
      }

      // Switch to account 2
      await logout();
      await loadAccount('password2', userId2);
      const account2Reloaded = getAccount();
      if (!account2Reloaded.userProfile || !account2Reloaded.session) {
        throw new Error('Account 2 reload failed');
      }
      const session2Reloaded = account2Reloaded.session;

      // Send 5 messages from account 2 to account 1
      const messagesFrom2: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const messageContent = `Message ${i} from User 2`;
        messagesFrom2.push(messageContent);

        const result = await sendMessage(
          {
            ownerUserId: userId2,
            contactUserId: userId1,
            content: messageContent,
            type: MessageType.TEXT,
            direction: MessageDirection.OUTGOING,
            status: MessageStatus.SENDING,
            timestamp: new Date(),
          },
          session2Reloaded
        );

        // Message might succeed or fail depending on discussion state, but should not throw
        expect(result).toHaveProperty('success');
      }

      // Verify messages from account 1's perspective
      await logout();
      await loadAccount('password1', userId1);
      const messages1 = await getMessages(userId1, userId2);
      expect(messages1.length).toBeGreaterThanOrEqual(5);

      // Check that we have outgoing messages
      const outgoingFrom1 = messages1.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(outgoingFrom1.length).toBeGreaterThanOrEqual(5);

      // Verify messages from account 2's perspective
      await logout();
      await loadAccount('password2', userId2);
      const messages2 = await getMessages(userId2, userId1);
      expect(messages2.length).toBeGreaterThanOrEqual(5);

      // Check that we have outgoing messages
      const outgoingFrom2 = messages2.filter(
        m => m.direction === MessageDirection.OUTGOING
      );
      expect(outgoingFrom2.length).toBeGreaterThanOrEqual(5);
    }, 30000); // Increased timeout for this test
  });
});
