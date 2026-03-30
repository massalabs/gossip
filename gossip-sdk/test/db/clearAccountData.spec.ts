/**
 * Tests for DatabaseConnection.clearAccountData(userId).
 *
 * Verifies that calling clearAccountData for one user removes only that
 * user's rows from owner-scoped tables, leaves another user's rows intact,
 * and clears the session-wide tables entirely.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../../src/db';
import * as schema from '../../src/db/schema';
import { clearAllTables, getTestConnection, getTestDb } from '../testDb';

const USER_A = 'gossip1userA';
const USER_B = 'gossip1userB';
const CONTACT = 'gossip1contact';

function db() {
  return getTestDb();
}

function conn() {
  return getTestConnection();
}

// ── Seed helpers ─────────────────────────────────────────────────────

async function seedMessages(ownerUserId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await db()
      .insert(schema.messages)
      .values({
        ownerUserId,
        contactUserId: CONTACT,
        content: `msg-${i}`,
        type: MessageType.TEXT,
        direction: MessageDirection.OUTGOING,
        status: MessageStatus.SENT,
        timestamp: new Date(),
      });
  }
}

async function seedDiscussions(ownerUserId: string) {
  await db().insert(schema.discussions).values({
    ownerUserId,
    contactUserId: CONTACT,
    direction: DiscussionDirection.INITIATED,
    weAccepted: true,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedContacts(ownerUserId: string) {
  await db()
    .insert(schema.contacts)
    .values({
      ownerUserId,
      userId: CONTACT,
      name: `contact-of-${ownerUserId}`,
      publicKeys: new Uint8Array([1, 2, 3]),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });
}

async function seedUserProfile(userId: string) {
  await db()
    .insert(schema.userProfile)
    .values({
      userId,
      username: `user-${userId}`,
      security: JSON.stringify({
        encKeySalt: [],
        authMethod: 'password',
        mnemonicBackup: {
          encryptedMnemonic: [],
          createdAt: Date.now(),
          backedUp: false,
        },
      }),
      session: new Uint8Array([0]),
      status: 'online',
      lastSeen: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
}

async function seedAnnouncementCursors(userId: string) {
  await db().insert(schema.announcementCursors).values({
    userId,
    counter: '42',
  });
}

async function seedSessionTables() {
  await db()
    .insert(schema.pendingEncryptedMessages)
    .values({
      seeker: new Uint8Array([10, 20]),
      ciphertext: new Uint8Array([30, 40]),
      fetchedAt: new Date(),
    });
  await db()
    .insert(schema.pendingAnnouncements)
    .values({
      announcement: new Uint8Array([50, 60]),
      fetchedAt: new Date(),
    });
  await db()
    .insert(schema.activeSeekers)
    .values({
      seeker: new Uint8Array([70, 80]),
    });
}

/** Insert data for both USER_A and USER_B, plus session-table rows. */
async function seedAll() {
  await seedMessages(USER_A, 3);
  await seedMessages(USER_B, 2);

  await seedDiscussions(USER_A);
  await seedDiscussions(USER_B);

  await seedContacts(USER_A);
  await seedContacts(USER_B);

  await seedUserProfile(USER_A);
  await seedUserProfile(USER_B);

  await seedAnnouncementCursors(USER_A);
  await seedAnnouncementCursors(USER_B);

  await seedSessionTables();
}

// ── Queries ──────────────────────────────────────────────────────────

async function messagesFor(ownerUserId: string) {
  return db()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.ownerUserId, ownerUserId));
}

async function discussionsFor(ownerUserId: string) {
  return db()
    .select()
    .from(schema.discussions)
    .where(eq(schema.discussions.ownerUserId, ownerUserId));
}

async function contactsFor(ownerUserId: string) {
  return db()
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.ownerUserId, ownerUserId));
}

async function profileFor(userId: string) {
  return db()
    .select()
    .from(schema.userProfile)
    .where(eq(schema.userProfile.userId, userId));
}

async function cursorFor(userId: string) {
  return db()
    .select()
    .from(schema.announcementCursors)
    .where(eq(schema.announcementCursors.userId, userId));
}

async function allPendingEncrypted() {
  return db().select().from(schema.pendingEncryptedMessages);
}

async function allPendingAnnouncements() {
  return db().select().from(schema.pendingAnnouncements);
}

async function allActiveSeekers() {
  return db().select().from(schema.activeSeekers);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('clearAccountData', () => {
  beforeEach(async () => {
    await clearAllTables();
    await seedAll();
  });

  it('deletes messages belonging to the specified user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await messagesFor(USER_A)).toHaveLength(0);
  });

  it('preserves messages belonging to another user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await messagesFor(USER_B)).toHaveLength(2);
  });

  it('deletes discussions belonging to the specified user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await discussionsFor(USER_A)).toHaveLength(0);
  });

  it('preserves discussions belonging to another user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await discussionsFor(USER_B)).toHaveLength(1);
  });

  it('deletes contacts belonging to the specified user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await contactsFor(USER_A)).toHaveLength(0);
  });

  it('preserves contacts belonging to another user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await contactsFor(USER_B)).toHaveLength(1);
  });

  it('deletes userProfile of the specified user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await profileFor(USER_A)).toHaveLength(0);
  });

  it('preserves userProfile of another user', async () => {
    await conn().clearAccountData(USER_A);

    const rows = await profileFor(USER_B);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(USER_B);
  });

  it('deletes announcementCursors of the specified user', async () => {
    await conn().clearAccountData(USER_A);

    expect(await cursorFor(USER_A)).toHaveLength(0);
  });

  it('preserves announcementCursors of another user', async () => {
    await conn().clearAccountData(USER_A);

    const rows = await cursorFor(USER_B);
    expect(rows).toHaveLength(1);
    expect(rows[0].counter).toBe('42');
  });

  it('clears all pendingEncryptedMessages (session table)', async () => {
    await conn().clearAccountData(USER_A);

    expect(await allPendingEncrypted()).toHaveLength(0);
  });

  it('clears all pendingAnnouncements (session table)', async () => {
    await conn().clearAccountData(USER_A);

    expect(await allPendingAnnouncements()).toHaveLength(0);
  });

  it('clears all activeSeekers (session table)', async () => {
    await conn().clearAccountData(USER_A);

    expect(await allActiveSeekers()).toHaveLength(0);
  });

  it('is idempotent — calling twice for the same user does not error', async () => {
    await conn().clearAccountData(USER_A);
    await conn().clearAccountData(USER_A);

    expect(await messagesFor(USER_A)).toHaveLength(0);
    expect(await messagesFor(USER_B)).toHaveLength(2);
  });

  it('leaves the database fully intact for userB after clearing userA', async () => {
    await conn().clearAccountData(USER_A);

    // Verify every table still has userB's data
    expect(await messagesFor(USER_B)).toHaveLength(2);
    expect(await discussionsFor(USER_B)).toHaveLength(1);
    expect(await contactsFor(USER_B)).toHaveLength(1);
    expect(await profileFor(USER_B)).toHaveLength(1);
    expect(await cursorFor(USER_B)).toHaveLength(1);
  });
});
