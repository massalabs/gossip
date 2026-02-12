/**
 * DiscussionService tests
 *
 * Tests for resetSendQueue function behavior.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  gossipDb,
  MessageStatus,
  MessageDirection,
  MessageType,
  DiscussionDirection,
} from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { resetSendQueue } from '../../src/services/discussion';

// ============================================================================
// resetSendQueue function tests
// ============================================================================

const RENEW_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(11));
const RENEW_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(12));

describe('resetSendQueue function', () => {
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));

    await db.discussions.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('should reset READY messages to WAITING_SESSION', async () => {
    const readyMessageId = await db.messages.add({
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

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const readyMessage = await db.messages.get(readyMessageId);
    expect(readyMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(readyMessage?.seeker).toBeUndefined();
    expect(readyMessage?.encryptedMessage).toBeUndefined();
    expect(readyMessage?.whenToSend).toBeUndefined();
  });

  it('should reset SENT messages to WAITING_SESSION', async () => {
    const sentMessageId = await db.messages.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Already sent message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(1),
      encryptedMessage: new Uint8Array(64).fill(2),
      whenToSend: new Date(),
    });

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const sentMessage = await db.messages.get(sentMessageId);
    expect(sentMessage?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sentMessage?.seeker).toBeUndefined();
    expect(sentMessage?.encryptedMessage).toBeUndefined();
    expect(sentMessage?.whenToSend).toBeUndefined();
  });

  it('should NOT reset DELIVERED messages', async () => {
    const deliveredMessageId = await db.messages.add({
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

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const deliveredMessage = await db.messages.get(deliveredMessageId);
    expect(deliveredMessage?.status).toBe(MessageStatus.DELIVERED);
    expect(deliveredMessage?.seeker).toBeDefined();
    expect(deliveredMessage?.encryptedMessage).toBeDefined();
  });

  it('should NOT reset READ messages', async () => {
    const readMessageId = await db.messages.add({
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

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const readMessage = await db.messages.get(readMessageId);
    expect(readMessage?.status).toBe(MessageStatus.READ);
    expect(readMessage?.seeker).toBeDefined();
  });

  it('should keep WAITING_SESSION messages unchanged', async () => {
    const waitingMessageId = await db.messages.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Waiting message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const waitingMessage = await db.messages.get(waitingMessageId);
    expect(waitingMessage?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should handle mixed message statuses correctly', async () => {
    const readyId = await db.messages.add({
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

    const sentId = await db.messages.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Sent',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
      seeker: new Uint8Array(32).fill(2),
      encryptedMessage: new Uint8Array(64).fill(2),
      whenToSend: new Date(),
    });

    const deliveredId = await db.messages.add({
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

    const readId = await db.messages.add({
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

    const waitingId = await db.messages.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Waiting',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const ready = await db.messages.get(readyId);
    expect(ready?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(ready?.seeker).toBeUndefined();
    expect(ready?.encryptedMessage).toBeUndefined();
    expect(ready?.whenToSend).toBeUndefined();

    const sent = await db.messages.get(sentId);
    expect(sent?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(sent?.seeker).toBeUndefined();
    expect(sent?.encryptedMessage).toBeUndefined();
    expect(sent?.whenToSend).toBeUndefined();

    const delivered = await db.messages.get(deliveredId);
    expect(delivered?.status).toBe(MessageStatus.DELIVERED);
    expect(delivered?.seeker).toBeDefined();
    expect(delivered?.encryptedMessage).toBeDefined();

    const read = await db.messages.get(readId);
    expect(read?.status).toBe(MessageStatus.READ);
    expect(read?.seeker).toBeDefined();
    expect(read?.encryptedMessage).toBeDefined();

    const waiting = await db.messages.get(waitingId);
    expect(waiting?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('should NOT reset incoming messages', async () => {
    const incomingId = await db.messages.add({
      ownerUserId: RENEW_OWNER_USER_ID,
      contactUserId: RENEW_CONTACT_USER_ID,
      content: 'Incoming message',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await resetSendQueue(db, RENEW_OWNER_USER_ID, RENEW_CONTACT_USER_ID);

    const incoming = await db.messages.get(incomingId);
    expect(incoming?.status).toBe(MessageStatus.SENT);
  });
});
