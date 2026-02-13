/**
 * Database state transitions tests
 *
 * Tests for discussion and message state transitions, stability detection,
 * pending announcements, and contact deletion cleanup.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';
import { clearAllTables } from '../../src/sqlite';
import {
  insertMessage,
  getMessageById,
  updateMessageById,
  getMessagesByOwnerAndContact,
  deleteMessagesByOwnerAndContact,
} from '../../src/queries/messages';
import {
  insertDiscussion,
  getDiscussionByOwnerAndContact,
  deleteDiscussionsByOwnerAndContact,
  getDiscussionsByOwner,
} from '../../src/queries/discussions';
import {
  insertContact,
  getContactByOwnerAndUser,
  deleteContactByOwnerAndUser,
} from '../../src/queries/contacts';
import {
  getAllPendingAnnouncements,
  deletePendingAnnouncementsByIds,
} from '../../src/queries/pendingAnnouncements';
import {
  insertUserProfile,
  getUserProfileField,
  updateUserProfileById,
  rowToUserProfile,
  userProfileToRow,
} from '../../src/queries/userProfile';
import { getSqliteDb } from '../../src/sqlite';
import * as schema from '../../src/schema';
import type { UserProfile } from '../../src/db';

const TEST_OWNER_USER_ID = 'gossip1testowner';
const TEST_CONTACT_USER_ID = 'gossip1testcontact';

describe('Announcement Storage for Retry', () => {
  beforeEach(clearAllTables);

  it('should find discussions needing retry (Ready to send)', async () => {
    const announcement = new Uint8Array([10, 20, 30]);
    await insertDiscussion({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      sendAnnouncement: JSON.stringify({
        announcement_bytes: Array.from(announcement),
        when_to_send: new Date().toISOString(),
      }),
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const now = new Date();

    const allDiscussions = await getDiscussionsByOwner(TEST_OWNER_USER_ID);

    const retryDiscussions = allDiscussions.filter(d => {
      if (!d.sendAnnouncement) return false;
      const parsed = JSON.parse(d.sendAnnouncement);
      return new Date(parsed.when_to_send) <= now;
    });

    expect(retryDiscussions.length).toBe(1);
    expect(retryDiscussions[0].sendAnnouncement).toBeDefined();
    const parsed = JSON.parse(retryDiscussions[0].sendAnnouncement!);
    expect(parsed.announcement_bytes).toBeDefined();
  });
});

describe('Message Status Transitions', () => {
  beforeEach(clearAllTables);

  it('should transition READY -> SENT on successful send', async () => {
    const messageId = await insertMessage({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.READY,
      timestamp: new Date(),
    });

    await updateMessageById(messageId, { status: MessageStatus.SENT });

    const message = await getMessageById(messageId);
    expect(message?.status).toBe(MessageStatus.SENT);
  });

  it('should transition READY -> WAITING_SESSION on send failure', async () => {
    const messageId = await insertMessage({
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

    await updateMessageById(messageId, {
      status: MessageStatus.WAITING_SESSION,
      whenToSend: null,
      seeker: null,
      encryptedMessage: null,
    });

    const message = await getMessageById(messageId);
    expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(message?.whenToSend).toBeNull();
    expect(message?.seeker).toBeNull();
    expect(message?.encryptedMessage).toBeNull();
  });

  it('should transition SENT -> WAITING_SESSION on send failure', async () => {
    const messageId = await insertMessage({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await updateMessageById(messageId, {
      status: MessageStatus.WAITING_SESSION,
      whenToSend: null,
      seeker: null,
      encryptedMessage: null,
    });

    const message = await getMessageById(messageId);
    expect(message?.status).toBe(MessageStatus.WAITING_SESSION);
    expect(message?.whenToSend).toBeNull();
    expect(message?.seeker).toBeNull();
    expect(message?.encryptedMessage).toBeNull();
  });

  it('should transition SENT -> DELIVERED on acknowledgment', async () => {
    const messageId = await insertMessage({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    await updateMessageById(messageId, { status: MessageStatus.DELIVERED });

    const message = await getMessageById(messageId);
    expect(message?.status).toBe(MessageStatus.DELIVERED);
  });
});

describe('Pending Announcements', () => {
  beforeEach(clearAllTables);

  it('should store pending announcements for later processing', async () => {
    const announcement = new Uint8Array([1, 2, 3, 4, 5]);
    const counter = '12345';

    await getSqliteDb().insert(schema.pendingAnnouncements).values({
      announcement,
      counter,
      fetchedAt: new Date(),
    });

    const pending = await getAllPendingAnnouncements();
    expect(pending.length).toBe(1);
    expect(pending[0].counter).toBe(counter);
  });

  it('should support partial deletion of processed announcements', async () => {
    await getSqliteDb()
      .insert(schema.pendingAnnouncements)
      .values({
        announcement: new Uint8Array([1]),
        counter: '1',
        fetchedAt: new Date(),
      });

    await getSqliteDb()
      .insert(schema.pendingAnnouncements)
      .values({
        announcement: new Uint8Array([2]),
        counter: '2',
        fetchedAt: new Date(),
      });

    await getSqliteDb()
      .insert(schema.pendingAnnouncements)
      .values({
        announcement: new Uint8Array([3]),
        counter: '3',
        fetchedAt: new Date(),
      });

    const pending = await getAllPendingAnnouncements();
    const idsToDelete = pending.slice(0, 2).map(p => p.id);
    await deletePendingAnnouncementsByIds(idsToDelete);

    const remaining = await getAllPendingAnnouncements();
    expect(remaining.length).toBe(1);
    expect(remaining[0].counter).toBe('3');
  });
});

describe('Contact Deletion Cleanup', () => {
  beforeEach(clearAllTables);

  it('should delete associated discussions when contact is deleted', async () => {
    await insertContact({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await insertDiscussion({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let discussion = await getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(discussion).toBeDefined();

    // Delete contact and discussion
    await deleteContactByOwnerAndUser(TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID);
    await deleteDiscussionsByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );

    const contact = await getContactByOwnerAndUser(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    discussion = await getDiscussionByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );

    expect(contact).toBeUndefined();
    expect(discussion).toBeUndefined();
  });

  it('should delete associated messages when contact is deleted', async () => {
    await insertContact({
      ownerUserId: TEST_OWNER_USER_ID,
      userId: TEST_CONTACT_USER_ID,
      name: 'Test Contact',
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    await insertMessage({
      ownerUserId: TEST_OWNER_USER_ID,
      contactUserId: TEST_CONTACT_USER_ID,
      content: 'Test message',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    let messages = await getMessagesByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(messages.length).toBe(1);

    // Delete contact and messages
    await deleteContactByOwnerAndUser(TEST_OWNER_USER_ID, TEST_CONTACT_USER_ID);
    await deleteMessagesByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );

    messages = await getMessagesByOwnerAndContact(
      TEST_OWNER_USER_ID,
      TEST_CONTACT_USER_ID
    );
    expect(messages.length).toBe(0);
  });
});

describe('Session Blob Round-Trip', () => {
  beforeEach(clearAllTables);

  const makeProfile = (session: Uint8Array): UserProfile => ({
    userId: 'gossip1testsession',
    username: 'testuser',
    security: {
      authMethod: 'password',
      encKeySalt: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      mnemonicBackup: {
        encryptedMnemonic: new Uint8Array([10, 20, 30]),
        createdAt: new Date(),
        backedUp: false,
      },
    },
    session,
    status: 'online',
    lastSeen: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it('should store and retrieve a small session blob (62 bytes)', async () => {
    const blob = new Uint8Array(62);
    for (let i = 0; i < 62; i++) blob[i] = i;

    await insertUserProfile(userProfileToRow(makeProfile(blob)));

    const row = await getUserProfileField('gossip1testsession');
    expect(row).toBeDefined();
    const profile = rowToUserProfile(row!);
    expect(profile.session).toBeInstanceOf(Uint8Array);
    expect(profile.session.length).toBe(62);
    expect(Array.from(profile.session)).toEqual(Array.from(blob));
  });

  it('should store and retrieve a large session blob (25 KB)', async () => {
    const blob = new Uint8Array(25_000);
    for (let i = 0; i < blob.length; i++) blob[i] = i % 256;

    await insertUserProfile(userProfileToRow(makeProfile(blob)));

    const row = await getUserProfileField('gossip1testsession');
    const profile = rowToUserProfile(row!);
    expect(profile.session.length).toBe(25_000);
    expect(Array.from(profile.session)).toEqual(Array.from(blob));
  });

  it('should update session blob from small to large', async () => {
    // Insert with a small (empty-session-sized) blob
    const smallBlob = new Uint8Array(62);
    for (let i = 0; i < 62; i++) smallBlob[i] = i;
    await insertUserProfile(userProfileToRow(makeProfile(smallBlob)));

    // Verify small blob is stored
    let row = await getUserProfileField('gossip1testsession');
    let profile = rowToUserProfile(row!);
    expect(profile.session.length).toBe(62);

    // Update to a large blob (simulating handleSessionPersist)
    const largeBlob = new Uint8Array(20_000);
    for (let i = 0; i < largeBlob.length; i++) largeBlob[i] = i % 256;

    await updateUserProfileById('gossip1testsession', {
      session: largeBlob,
      updatedAt: new Date(),
    });

    // Verify large blob is stored correctly
    row = await getUserProfileField('gossip1testsession');
    profile = rowToUserProfile(row!);
    expect(profile.session.length).toBe(20_000);
    expect(Array.from(profile.session)).toEqual(Array.from(largeBlob));
  });

  it('should survive multiple rapid updates (persist race)', async () => {
    const blob1 = new Uint8Array(100).fill(1);
    await insertUserProfile(userProfileToRow(makeProfile(blob1)));

    // Simulate rapid persist calls
    const blob2 = new Uint8Array(5_000).fill(2);
    const blob3 = new Uint8Array(10_000).fill(3);
    const blob4 = new Uint8Array(15_000).fill(4);

    await updateUserProfileById('gossip1testsession', { session: blob2 });
    await updateUserProfileById('gossip1testsession', { session: blob3 });
    await updateUserProfileById('gossip1testsession', { session: blob4 });

    const row = await getUserProfileField('gossip1testsession');
    const profile = rowToUserProfile(row!);
    expect(profile.session.length).toBe(15_000);
    expect(profile.session.every(b => b === 4)).toBe(true);
  });
});
