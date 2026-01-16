/**
 * Startup Recovery Tests
 *
 * Tests for recovering from abnormal app termination:
 * - Reset SENDING messages to FAILED on startup
 * - Handle stuck states
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db, MessageDirection, MessageStatus, MessageType } from '../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

describe('Reset SENDING Messages on Startup', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await db.messages.clear();
  });

  it('should identify SENDING messages that need reset on startup', async () => {
    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Stuck sending message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Already sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Already failed message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    });

    const sendingMessages = await db.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .toArray();

    expect(sendingMessages.length).toBe(1);
    expect(sendingMessages[0].content).toBe('Stuck sending message');
  });

  it('should reset SENDING messages to FAILED (simulates openSession behavior)', async () => {
    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Stuck message 1',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Stuck message 2',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    // Simulate the reset operation (what GossipSdk.openSession does)
    const count = await db.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .modify({ status: MessageStatus.FAILED });

    expect(count).toBe(2);

    const remainingSending = await db.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .count();
    expect(remainingSending).toBe(0);

    const failedMessages = await db.messages
      .where('status')
      .equals(MessageStatus.FAILED)
      .toArray();
    expect(failedMessages.length).toBe(2);
  });

  it('should not affect messages in other states', async () => {
    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Delivered message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    // Reset SENDING (none exist)
    await db.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .modify({ status: MessageStatus.FAILED });

    const sentCount = await db.messages
      .where('status')
      .equals(MessageStatus.SENT)
      .count();
    const deliveredCount = await db.messages
      .where('status')
      .equals(MessageStatus.DELIVERED)
      .count();

    expect(sentCount).toBe(1);
    expect(deliveredCount).toBe(1);
  });

  it('should handle multiple contacts with SENDING messages', async () => {
    const contact2 = 'gossip1testcontact2';

    // Add SENDING messages for different contacts
    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Stuck for contact 1',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: contact2,
      content: 'Stuck for contact 2',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });

    const count = await db.messages
      .where('status')
      .equals(MessageStatus.SENDING)
      .modify({ status: MessageStatus.FAILED });

    expect(count).toBe(2);

    // Verify both contacts' messages were reset
    const failedForContact1 = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
      .and(m => m.status === MessageStatus.FAILED)
      .count();

    const failedForContact2 = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, contact2])
      .and(m => m.status === MessageStatus.FAILED)
      .count();

    expect(failedForContact1).toBe(1);
    expect(failedForContact2).toBe(1);
  });
});
