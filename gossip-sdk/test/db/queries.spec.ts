/**
 * Database query tests
 *
 * Tests for MessageQueries and other query functions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageDirection, MessageStatus, MessageType } from '../../src/db';
import { clearAllTables, getTestQueries } from '../testDb';

const OWNER = 'owner1';
const CONTACT = 'contact1';
const OTHER_CONTACT = 'contact2';

function q() {
  return getTestQueries();
}

describe('resetSendQueue', () => {
  beforeEach(clearAllTables);

  it('resets READY outgoing messages to WAITING_SESSION and clears encryptedMessage and seeker', async () => {
    for (let i = 0; i < 10; i++) {
      await q().messages.insert({
        ownerUserId: OWNER,
        contactUserId: CONTACT,
        content: 'Hello' + i,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.READY,
        timestamp: new Date(),
        encryptedMessage: new Uint8Array([1, 2, 3]),
        seeker: new Uint8Array([4, 5, 6]),
        whenToSend: new Date(),
      });
    }

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const messages = await q().messages.getByOwnerAndContact(OWNER, CONTACT);
    expect(messages.length).toBe(10);
    for (const msg of messages) {
      expect(msg.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg.encryptedMessage).toBeNull();
      expect(msg.seeker).toBeNull();
    }
  });

  it('resets SENT outgoing messages to WAITING_SESSION and clears encryptedMessage and seeker', async () => {
    for (let i = 0; i < 10; i++) {
      await q().messages.insert({
        ownerUserId: OWNER,
        contactUserId: CONTACT,
        content: 'Hello',
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
        encryptedMessage: new Uint8Array([1, 2, 3]),
        seeker: new Uint8Array([4, 5, 6]),
      });
    }

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const messages = await q().messages.getByOwnerAndContact(OWNER, CONTACT);
    expect(messages.length).toBe(10);
    for (const msg of messages) {
      expect(msg.status).toBe(MessageStatus.WAITING_SESSION);
      expect(msg.encryptedMessage).toBeNull();
      expect(msg.seeker).toBeNull();
    }
  });

  it('does not affect incoming messages', async () => {
    const id = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'From contact',
      type: MessageType.TEXT,
      direction: MessageDirection.INCOMING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const msg = await q().messages.getById(id);
    expect(msg?.status).toBe(MessageStatus.SENT);
  });

  it('does not affect messages for other contacts', async () => {
    const id = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: OTHER_CONTACT,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });
    const ourId = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const msg = await q().messages.getById(id);
    const ourMsg = await q().messages.getById(ourId);
    expect(msg?.status).toBe(MessageStatus.SENT);
    expect(ourMsg?.status).toBe(MessageStatus.WAITING_SESSION);
  });

  it('does not affect WAITING_SESSION, DELIVERED, SENDING, or FAILED messages', async () => {
    const idWaiting = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'a',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });
    const idDelivered = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'b',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.DELIVERED,
      timestamp: new Date(),
    });
    const idSending = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'c',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENDING,
      timestamp: new Date(),
    });
    const idFailed = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'd',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.FAILED,
      timestamp: new Date(),
    });

    await q().messages.resetSendQueue(OWNER, CONTACT);

    expect((await q().messages.getById(idWaiting))?.status).toBe(
      MessageStatus.WAITING_SESSION
    );
    expect((await q().messages.getById(idDelivered))?.status).toBe(
      MessageStatus.DELIVERED
    );
    expect((await q().messages.getById(idSending))?.status).toBe(
      MessageStatus.SENDING
    );
    expect((await q().messages.getById(idFailed))?.status).toBe(
      MessageStatus.FAILED
    );
  });

  it('when only keep-alive in WAITING_SESSION, keeps keep-alive (no delete)', async () => {
    const id = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.WAITING_SESSION,
      timestamp: new Date(),
    });

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const msg = await q().messages.getById(id);
    expect(msg).toBeDefined();
    expect(msg?.type).toBe(MessageType.KEEP_ALIVE);
  });

  it('when both keep-alive and text in WAITING_SESSION, deletes keep-alive and keeps text', async () => {
    const textId = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
    });
    const keepAliveId = await q().messages.insert({
      ownerUserId: OWNER,
      contactUserId: CONTACT,
      content: '',
      type: MessageType.KEEP_ALIVE,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
    });

    await q().messages.resetSendQueue(OWNER, CONTACT);

    const textMsg = await q().messages.getById(textId);
    const keepAliveMsg = await q().messages.getById(keepAliveId);

    expect(textMsg).toBeDefined();
    expect(textMsg?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(keepAliveMsg).toBeUndefined();
  });
});
