/**
 * SENDING Reset on Startup Tests
 *
 * Per spec: SENDING is a transient state that should never persist across app restarts.
 * If app crashes during send, messages stuck in SENDING should be reset to WAITING_SESSION.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GossipDatabase,
  MessageStatus,
  MessageDirection,
  MessageType,
} from '../src/db';
import { encodeUserId } from '../src/utils/userId';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));

describe('SENDING Reset on Startup', () => {
  let testDb: GossipDatabase;

  beforeEach(async () => {
    testDb = new GossipDatabase();
    if (!testDb.isOpen()) {
      await testDb.open();
    }
    await Promise.all(testDb.tables.map(table => table.clear()));
  });

  describe('resetStuckSendingMessages behavior', () => {
    /**
     * Simulates what GossipSdk.resetStuckSendingMessages does.
     * This is extracted for testing since the actual method is private.
     */
    async function resetStuckSendingMessages(): Promise<number> {
      return await testDb.messages
        .where('status')
        .equals(MessageStatus.SENDING)
        .modify({
          status: MessageStatus.WAITING_SESSION,
          encryptedMessage: undefined,
          seeker: undefined,
        });
    }

    it('should reset SENDING messages to WAITING_SESSION', async () => {
      // Create a message stuck in SENDING (simulates app crash during send)
      const messageId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Test message',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        encryptedMessage: new Uint8Array([1, 2, 3]),
        seeker: new Uint8Array([4, 5, 6]),
      });

      // Simulate app restart - reset stuck messages
      const count = await resetStuckSendingMessages();

      expect(count).toBe(1);

      // Verify message was reset
      const message = await testDb.messages.get(messageId);
      expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
      expect(message?.encryptedMessage).toBeUndefined();
      expect(message?.seeker).toBeUndefined();
    });

    it('should clear encryptedMessage and seeker for re-encryption', async () => {
      const originalEncrypted = new Uint8Array([10, 20, 30, 40]);
      const originalSeeker = new Uint8Array([50, 60, 70, 80]);

      const messageId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Message with encryption data',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENDING,
        timestamp: new Date(),
        encryptedMessage: originalEncrypted,
        seeker: originalSeeker,
      });

      await resetStuckSendingMessages();

      const message = await testDb.messages.get(messageId);

      // Both should be cleared so message can be re-encrypted with fresh session
      expect(message?.encryptedMessage).toBeUndefined();
      expect(message?.seeker).toBeUndefined();
      expect(message?.content).toBe('Message with encryption data'); // Content preserved
    });

    it('should NOT affect messages in other statuses', async () => {
      // Create messages in various statuses
      const waitingId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Waiting',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.WAITING_SESSION,
        timestamp: new Date(),
      });

      const sentId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Sent',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        seeker: new Uint8Array([1, 2, 3]),
      });

      const deliveredId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Delivered',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.DELIVERED,
        timestamp: new Date(),
        seeker: new Uint8Array([4, 5, 6]),
      });

      const failedId = await testDb.messages.add({
        ownerUserId: OWNER_USER_ID,
        contactUserId: CONTACT_USER_ID,
        content: 'Failed',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.FAILED,
        timestamp: new Date(),
      });

      // Reset stuck messages
      const count = await resetStuckSendingMessages();

      expect(count).toBe(0); // No SENDING messages to reset

      // Verify all messages unchanged
      expect((await testDb.messages.get(waitingId))?.status).toBe(
        MessageStatus.WAITING_SESSION
      );
      expect((await testDb.messages.get(sentId))?.status).toBe(
        MessageStatus.SENT
      );
      expect((await testDb.messages.get(deliveredId))?.status).toBe(
        MessageStatus.DELIVERED
      );
      expect((await testDb.messages.get(failedId))?.status).toBe(
        MessageStatus.FAILED
      );
    });

    it('should reset multiple SENDING messages', async () => {
      // Create 3 messages stuck in SENDING
      await testDb.messages.bulkAdd([
        {
          ownerUserId: OWNER_USER_ID,
          contactUserId: CONTACT_USER_ID,
          content: 'Message 1',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([1]),
          seeker: new Uint8Array([1]),
        },
        {
          ownerUserId: OWNER_USER_ID,
          contactUserId: CONTACT_USER_ID,
          content: 'Message 2',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([2]),
          seeker: new Uint8Array([2]),
        },
        {
          ownerUserId: OWNER_USER_ID,
          contactUserId: CONTACT_USER_ID,
          content: 'Message 3',
          type: MessageType.TEXT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENDING,
          timestamp: new Date(),
          encryptedMessage: new Uint8Array([3]),
          seeker: new Uint8Array([3]),
        },
      ]);

      const count = await resetStuckSendingMessages();

      expect(count).toBe(3);

      // Verify all are now WAITING_SESSION
      const messages = await testDb.messages.toArray();
      expect(
        messages.every(m => m.status === MessageStatus.WAITING_SESSION)
      ).toBe(true);
      expect(messages.every(m => m.encryptedMessage === undefined)).toBe(true);
      expect(messages.every(m => m.seeker === undefined)).toBe(true);
    });

    it('should handle empty database gracefully', async () => {
      const count = await resetStuckSendingMessages();
      expect(count).toBe(0);
    });
  });
});
