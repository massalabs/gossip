/**
 * DiscussionService tests
 *
 * Tests for resetSendQueueMessages function behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionDirection,
  DiscussionStatus,
} from '../../src/db';
import { clearAllTables, getTestDb, getTestQueries } from '../testDb';
import * as schema from '../../src/db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { encodeUserId } from '../../src/utils/userId';

// ============================================================================
// resetSendQueueMessages function tests
// ============================================================================

const RENEW_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const RENEW_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

async function simulateRenewMessageReset(
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  await getTestDb()
    .update(schema.messages)
    .set({
      status: MessageStatus.WAITING_SESSION,
      encryptedMessage: null,
      seeker: null,
    })
    .where(
      and(
        eq(schema.messages.ownerUserId, ownerUserId),
        eq(schema.messages.contactUserId, contactUserId),
        eq(schema.messages.direction, MessageDirection.OUTGOING),
        inArray(schema.messages.status, [
          MessageStatus.SENDING,
          MessageStatus.FAILED,
          MessageStatus.SENT,
        ])
      )
    );
}

describe('resetSendQueueMessages function', () => {
  beforeEach(async () => {
    await clearAllTables();
    await getTestQueries().discussions.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.PENDING,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should reset READY messages to WAITING_SESSION', async () => {
    const readyMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Ready message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
      whenToSend: new Date(),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const readyMessage =
      await getTestQueries().messages.getById(readyMessageId);
    expect(readyMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(readyMessage?.seeker).toBeNull();
    expect(readyMessage?.encryptedMessage).toBeNull();
  });

  it('should reset SENT messages to WAITING_SESSION', async () => {
    const sentMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Already sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const sentMessage = await getTestQueries().messages.getById(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sentMessage?.seeker).toBeNull();
    expect(sentMessage?.encryptedMessage).toBeNull();
  });

  it('should NOT reset DELIVERED messages', async () => {
    const deliveredMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Delivered message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const deliveredMessage =
      await getTestQueries().messages.getById(deliveredMessageId);
    expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
    expect(deliveredMessage?.seeker).toBeDefined();
    expect(deliveredMessage?.encryptedMessage).toBeDefined();
  });

  it('should NOT reset READ messages', async () => {
    const readMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Read message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READ,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(5),
      encryptedMessage: new Uint8Array(64).fill(6),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const readMessage = await getTestQueries().messages.getById(readMessageId);
    expect(readMessage?.status).toBe(MessageStatus.READ);
    expect(readMessage?.seeker).toBeDefined();
  });

  it('should keep WAITING_SESSION messages unchanged', async () => {
    const waitingMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Waiting message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const waitingMessage =
      await getTestQueries().messages.getById(waitingMessageId);
    expect(waitingMessage?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should handle mixed message statuses correctly', async () => {
    const readyId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Ready',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
      whenToSend: new Date(),
    });

    const sentId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Sent',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    const deliveredId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Delivered',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(3),
    });

    const readId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Read',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READ,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(4),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    const waitingId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Waiting',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const ready = await getTestQueries().messages.getById(readyId);
    expect(ready?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(ready?.seeker).toBeNull();
    expect(ready?.encryptedMessage).toBeNull();

    const sent = await getTestQueries().messages.getById(sentId);
    expect(sent?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sent?.seeker).toBeNull();
    expect(sent?.encryptedMessage).toBeNull();

    const delivered = await getTestQueries().messages.getById(deliveredId);
    expect(delivered?.status).toBe(MessageStatus.DELIVERED);
    expect(delivered?.seeker).toBeDefined();
    expect(delivered?.encryptedMessage).toBeDefined();

    const read = await getTestQueries().messages.getById(readId);
    expect(read?.status).toBe(MessageStatus.READ);
    expect(read?.seeker).toBeDefined();
    expect(read?.encryptedMessage).toBeDefined();

    const waiting = await getTestQueries().messages.getById(waitingId);
    expect(waiting?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should NOT reset incoming messages', async () => {
    const incomingId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Incoming message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await getTestQueries().messages.resetSendQueue(
      RENEW_OWNER_USER_ID,
      RENEW_CONTACT_USER_ID,
      [MessageStatus.READY, MessageStatus.SENT]
    );

    const incoming = await getTestQueries().messages.getById(incomingId);
    expect(incoming?.status).toBe(MessageStatus.SENT);
  });
});

// ============================================================================
// simulateRenewMessageReset tests (renew session resets SENDING/FAILED/SENT)
// ============================================================================

describe('DiscussionService renew message reset behavior', () => {
  beforeEach(async () => {
    await clearAllTables();
    await getTestQueries().discussions.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.PENDING,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should reset SENDING messages to WAITING_SESSION when renewing', async () => {
    const sendingMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Sending message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(5),
      encryptedMessage: new Uint8Array(64).fill(6),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const sendingMessage =
      await getTestQueries().messages.getById(sendingMessageId);
    expect(sendingMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sendingMessage?.seeker).toBeNull();
    expect(sendingMessage?.encryptedMessage).toBeNull();
  });

  it('should reset FAILED messages to WAITING_SESSION when renewing', async () => {
    const failedMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Failed message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(7),
      encryptedMessage: new Uint8Array(64).fill(8),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const failedMessage =
      await getTestQueries().messages.getById(failedMessageId);
    expect(failedMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(failedMessage?.seeker).toBeNull();
    expect(failedMessage?.encryptedMessage).toBeNull();
  });

  it('should reset SENT messages to WAITING_SESSION when renewing session', async () => {
    const sentMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Already sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const sentMessage = await getTestQueries().messages.getById(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sentMessage?.seeker).toBeNull();
    expect(sentMessage?.encryptedMessage).toBeNull();
  });

  it('should NOT reset DELIVERED messages when renewing session', async () => {
    const deliveredMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Delivered message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(4),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const deliveredMessage =
      await getTestQueries().messages.getById(deliveredMessageId);
    expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
    expect(deliveredMessage?.seeker).toBeDefined();
    expect(deliveredMessage?.encryptedMessage).toBeDefined();
  });

  it('should NOT reset READ messages when renewing session', async () => {
    const readMessageId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Read message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READ,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(5),
      encryptedMessage: new Uint8Array(64).fill(6),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const readMessage = await getTestQueries().messages.getById(readMessageId);
    expect(readMessage?.status).toBe(MessageStatus.READ);
    expect(readMessage?.seeker).toBeDefined();
  });

  it('should handle mixed message statuses correctly on renew', async () => {
    const sentId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Sent',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(1),
    });

    const sendingId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Sending',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
    });

    const failedId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Failed',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    });

    const deliveredId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Delivered',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(3),
      encryptedMessage: new Uint8Array(64).fill(3),
    });

    const waitingId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Waiting',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const sent = await getTestQueries().messages.getById(sentId);
    expect(sent?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sent?.seeker).toBeNull();

    const sending = await getTestQueries().messages.getById(sendingId);
    expect(sending?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sending?.seeker).toBeNull();

    const failed = await getTestQueries().messages.getById(failedId);
    expect(failed?.status).toBe(MessageStatus.WAITING_SESSION);

    const delivered = await getTestQueries().messages.getById(deliveredId);
    expect(delivered?.status).toBe(MessageStatus.DELIVERED);
    expect(delivered?.seeker).toBeDefined();
    expect(delivered?.encryptedMessage).toBeDefined();

    const waiting = await getTestQueries().messages.getById(waitingId);
    expect(waiting?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should NOT reset incoming messages when renewing', async () => {
    const incomingId = await getTestQueries().messages.insert({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Incoming message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });

    await simulateRenewMessageReset(RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const incoming = await getTestQueries().messages.getById(incomingId);
    expect(incoming?.status).toBe(MessageStatus.DELIVERED);
  });
});
