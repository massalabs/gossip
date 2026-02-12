/**
 * Contacts utilities tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  gossipDb,
  DiscussionDirection,
  MessageType,
  MessageDirection,
  MessageStatus,
} from '../../src/db';
import { encodeUserId } from '../../src/utils/userId';
import { addContact, getContact, getContacts } from '../../src/contacts';
import { updateContactName, deleteContact } from '../../src/utils/contacts';
import type { SessionModule } from '../../src/wasm/session';
import type { UserPublicKeys as UserPublicKeysType } from '../../src/wasm/bindings';

const CONTACTS_OWNER_USER_ID = encodeUserId(new Uint8Array(32).fill(1));
const CONTACTS_CONTACT_USER_ID = encodeUserId(new Uint8Array(32).fill(2));
const CONTACTS_CONTACT_USER_ID_2 = encodeUserId(new Uint8Array(32).fill(3));

const publicKeys = {
  to_bytes: () => new Uint8Array([1, 2, 3]),
} as unknown as UserPublicKeysType;

const fakeSession = {
  peerDiscard: vi.fn(),
} as unknown as SessionModule;

describe('Contacts utilities', () => {
  let db: GossipDatabase;

  beforeEach(async () => {
    db = gossipDb();
    if (!db.isOpen()) {
      await db.open();
    }
    await Promise.all(db.tables.map(table => table.clear()));
  });

  it('adds and fetches a contact', async () => {
    const result = await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys,
      db
    );
    expect(result.success).toBe(true);

    const contact = await getContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      db
    );
    expect(contact?.name).toBe('Alice');
  });

  it('returns error when contact already exists', async () => {
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys,
      db
    );
    const result = await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice 2',
      publicKeys,
      db
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('exists');
  });

  it('updates contact name and rejects duplicates', async () => {
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys,
      db
    );
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID_2,
      'Bob',
      publicKeys,
      db
    );

    const updateResult = await updateContactName(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice Updated',
      db
    );
    expect(updateResult.success).toBe(true);

    const duplicateResult = await updateContactName(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Bob',
      db
    );
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success) {
      expect(duplicateResult.reason).toBe('duplicate');
    }
  });

  it('deletes contact and related data', async () => {
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys,
      db
    );

    await db.discussions.add({
      ownerUserId: CONTACTS_OWNER_USER_ID,
      contactUserId: CONTACTS_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await db.messages.add({
      ownerUserId: CONTACTS_OWNER_USER_ID,
      contactUserId: CONTACTS_CONTACT_USER_ID,
      content: 'Hello',
      type: MessageType.TEXT,
      direction: MessageDirection.OUTGOING,
      status: MessageStatus.SENT,
      timestamp: new Date(),
    });

    const result = await deleteContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      db,
      fakeSession
    );

    expect(result.success).toBe(true);
    expect(fakeSession.peerDiscard).toHaveBeenCalled();

    const contacts = await getContacts(CONTACTS_OWNER_USER_ID, db);
    expect(contacts.length).toBe(0);
  });
});
