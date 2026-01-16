/**
 * DiscussionService Tests
 *
 * Tests for the message status reset behavior during session renewal.
 * These tests directly verify the database query pattern used in renew()
 * without needing WASM dependencies.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionStatus,
  DiscussionDirection,
} from '../src/db';
import { encodeUserId } from '../src/utils/userId';

const OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

/**
 * This simulates the exact database query used in DiscussionService.renew()
 * to reset messages. This allows us to test the query behavior without
 * needing to mock WASM dependencies.
 */
async function simulateRenewMessageReset(
  ownerUserId: string,
  contactUserId: string
): Promise<number> {
  return await db.messages
    .where('[ownerUserId+contactUserId]')
    .equals([ownerUserId, contactUserId])
    .and(
      message =>
        message.direction === MessageDirection.OUTGOING &&
        (message.status === MessageStatus.SENDING ||
          message.status === MessageStatus.FAILED)
    )
    .modify({
      status: MessageStatus.WAITING_SESSION,
      encryptedMessage: undefined,
      seeker: undefined,
    });
}

describe('DiscussionService renew message reset behavior', () => {
  beforeEach(async () => {
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    // Create discussion
    await db.discussions.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should NOT reset SENT messages when renewing session', async () => {
    // Add a SENT message (already on the network)
    const sentMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Already sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify SENT message was NOT reset
    const sentMessage = await db.messages.get(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.SENT);
    expect(sentMessage?.seeker).toBeDefined();
    expect(sentMessage?.encryptedMessage).toBeDefined();
  });

  it('should NOT reset DELIVERED messages when renewing session', async () => {
    const deliveredMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Delivered message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify DELIVERED message was NOT reset
    const deliveredMessage = await db.messages.get(deliveredMessageId);
    expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
    expect(deliveredMessage?.seeker).toBeDefined();
    expect(deliveredMessage?.encryptedMessage).toBeDefined();
  });

  it('should NOT reset READ messages when renewing session', async () => {
    const readMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Read message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READ,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(5),
      encryptedMessage: new Uint8Array(64).fill(6),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify READ message was NOT reset
    const readMessage = await db.messages.get(readMessageId);
    expect(readMessage?.status).toBe(MessageStatus.READ);
    expect(readMessage?.seeker).toBeDefined();
  });

  it('should reset SENDING messages to WAITING_SESSION when renewing', async () => {
    const sendingMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Sending message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(5),
      encryptedMessage: new Uint8Array(64).fill(6),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify SENDING message WAS reset to WAITING_SESSION
    const sendingMessage = await db.messages.get(sendingMessageId);
    expect(sendingMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sendingMessage?.seeker).toBeUndefined();
    expect(sendingMessage?.encryptedMessage).toBeUndefined();
  });

  it('should reset FAILED messages to WAITING_SESSION when renewing', async () => {
    const failedMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Failed message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(7),
      encryptedMessage: new Uint8Array(64).fill(8),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify FAILED message WAS reset to WAITING_SESSION
    const failedMessage = await db.messages.get(failedMessageId);
    expect(failedMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(failedMessage?.seeker).toBeUndefined();
    expect(failedMessage?.encryptedMessage).toBeUndefined();
  });

  it('should keep WAITING_SESSION messages unchanged when renewing', async () => {
    const waitingMessageId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Waiting message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
      // No seeker or encryptedMessage - hasn't been encrypted yet
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify WAITING_SESSION message stays as WAITING_SESSION
    const waitingMessage = await db.messages.get(waitingMessageId);
    expect(waitingMessage?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should handle mixed message statuses correctly on renew', async () => {
    // Add messages with different statuses
    const sentId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Sent',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
    });

    const sendingId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Sending',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    const failedId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Failed',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    });

    const deliveredId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Delivered',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(3),
    });

    const waitingId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Waiting',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // SENT - should be unchanged
    const sent = await db.messages.get(sentId);
    expect(sent?.status).toBe(MessageStatus.SENT);
    expect(sent?.seeker).toBeDefined();

    // SENDING - should be reset to WAITING_SESSION
    const sending = await db.messages.get(sendingId);
    expect(sending?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sending?.seeker).toBeUndefined();

    // FAILED - should be reset to WAITING_SESSION
    const failed = await db.messages.get(failedId);
    expect(failed?.status).toBe(MessageStatus.WAITING_SESSION);

    // DELIVERED - should be unchanged
    const delivered = await db.messages.get(deliveredId);
    expect(delivered?.status).toBe(MessageStatus.DELIVERED);
    expect(delivered?.seeker).toBeDefined();

    // WAITING_SESSION - should be unchanged
    const waiting = await db.messages.get(waitingId);
    expect(waiting?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should NOT reset incoming messages when renewing', async () => {
    // Add an incoming SENDING message (shouldn't exist in practice, but test for safety)
    const incomingId = await db.messages.add({
      ownerUserId: OWNER_USER_ID,
      contactUserId: CONTACT_USER_ID,
      content: 'Incoming message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    await simulateRenewMessageReset(OWNER_USER_ID, CONTACT_USER_ID);

    // Verify incoming message was NOT modified
    const incoming = await db.messages.get(incomingId);
    expect(incoming?.status).toBe(MessageStatus.DELIVERED);
  });
});
