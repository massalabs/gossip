/**
 * Database state transitions tests
 *
 * Tests for discussion and message state transitions, stability detection,
 * pending announcements, and contact deletion cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  gossipDb,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

describe('Announcement Storage for Retry', () => {
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await db.discussions.clear();
    await db.pendingAnnouncements.clear();
  });

  it('should find discussions needing retry (Ready to send)', async () => {
    const announcement = new Uint8Array([10, 20, 30]);
    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: {
        announcement_bytes: announcement,
        when_to_send: new Date(),
      },
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const now = new Date();
    const retryDiscussions = await db.discussions
      .where('ownerUserId')
      .equals(TEST_OWNER_USER_ID)
      .filter(
        d =>
          d.sendAnnouncement !== null && d.sendAnnouncement!.when_to_send <= now
      )
      .toArray();

    expect(retryDiscussions.length).toBe(1);
    expect(retryDiscussions[0].sendAnnouncement).toBeDefined();
    expect(
      retryDiscussions[0].sendAnnouncement?.announcement_bytes
    ).toBeDefined();
  });
});

describe('Message Status Transitions', () => {
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await db.messages.clear();
  });

  it('should transition READY -> SENT on successful send', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.SENT,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.SENT);
  });

  it('should transition READY -> WAITING_SESSION on send failure', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      whenToSend: new Date(),
      seeker: new Uint8Array([1, 2, 3]),
      encryptedMessage: new Uint8Array([1, 2, 3]),
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.WAITING_SESSION,
      whenToSend: undefined,
      seeker: undefined,
      encryptedMessage: undefined,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(message?.whenToSend).toBeUndefined();
    expect(message?.seeker).toBeUndefined();
    expect(message?.encryptedMessage).toBeUndefined();
  });

  it('should transition SENT -> WAITING_SESSION on send failure', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.WAITING_SESSION,
      whenToSend: undefined,
      seeker: undefined,
      encryptedMessage: undefined,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(message?.whenToSend).toBeUndefined();
    expect(message?.seeker).toBeUndefined();
    expect(message?.encryptedMessage).toBeUndefined();
  });

  it('should transition SENT -> DELIVERED on acknowledgment', async () => {
    const messageId = await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await db.messages.update(messageId, {
      status: MessageStatus.DELIVERED,
    });

    const message = await db.messages.get(messageId);
    expect(message?.status).toBe(MessageStatus.DELIVERED);
  });
});

describe('Pending Announcements', () => {
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await db.pendingAnnouncements.clear();
  });

  it('should store pending announcements for later processing', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const counter = '12345';

    await db.pendingAnnouncements.add({
      announcement,
      counter,
      fetchedAt: new Date(),
    });

    const pending = await db.pendingAnnouncements.toArray();
    expect(pending.length).toBe(1);
    expect(pending[0].counter).toBe(counter);
  });

  it('should support partial deletion of processed announcements', async () => {
    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([1]),
      counter: '1',
      fetchedAt: new Date(),
    });

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([2]),
      counter: '2',
      fetchedAt: new Date(),
    });

    await db.pendingAnnouncements.add({
      announcement: new Uint8Array([3]),
      counter: '3',
      fetchedAt: new Date(),
    });

    const pending = await db.pendingAnnouncements.toArray();
    const idsToDelete = pending.slice(0, 2).map(p => p.id!);
    await db.pendingAnnouncements.bulkDelete(idsToDelete);

    const remaining = await db.pendingAnnouncements.toArray();
    expect(remaining.length).toBe(1);
    expect(remaining[0].counter).toBe('3');
  });
});

describe('Contact Deletion Cleanup', () => {
  let db: ReturnType<typeof gossipDb>;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await db.contacts.clear();
    await db.discussions.clear();
    await db.messages.clear();
  });

  it('should delete associated discussions when contact is deleted', async () => {
    await db.contacts.add({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await db.discussions.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let discussion = await db.getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(discussion).toBeDefined();

    await db.transaction(
      'rw',
      [db.contacts, db.discussions, db.messages],
      async () => {
        await db.contacts
          .where('[ownerUserId+userId]')
          .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
          .delete();

        await db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
          .delete();
      }
    );

    const contact = await db.getContactByOwnerAndUserId(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    discussion = await db.getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );

    expect(contact).toBeUndefined();
    expect(discussion).toBeUndefined();
  });

  it('should delete associated messages when contact is deleted', async () => {
    await db.contacts.add({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    let messages = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
      .toArray();
    expect(messages.length).toBe(1);

    await db.transaction('rw', [db.contacts, db.messages], async () => {
      await db.contacts
        .where('[ownerUserId+userId]')
        .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
        .delete();

      await db.messages
        .where('[ownerUserId+contactUserId]')
        .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
        .delete();
    });

    messages = await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID])
      .toArray();
    expect(messages.length).toBe(0);
  });
});
