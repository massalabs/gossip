/**
 * Contacts utilities tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  DiscussionDirection,
  DiscussionStatus,
  MessageType,
  MessageDirection,
  MessageStatus,
} from '../../src/db';
import { getSqliteDb } from '../../src/sqlite';
import * as schema from '../../src/schema';
import { encodeUserId } from '../../src/utils/userId';
import { addContact, getContact, getContacts } from '../../src/contacts';
import { updateContactName, deleteContact } from '../../src/utils/contacts';
import { clearAllTables } from '../../src/sqlite';
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
  beforeEach(async () => {
    await clearAllTables();
  });

  it('adds and fetches a contact', async () => {
    const result = await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys
    );
    expect(result.success).toBe(true);

    const contact = await getContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID
    );
    expect(contact?.name).toBe('Alice');
  });

  it('returns error when contact already exists', async () => {
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys
    );
    const result = await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice 2',
      publicKeys
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('exists');
  });

  it('updates contact name and rejects duplicates', async () => {
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice',
      publicKeys
    );
    await addContact(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID_2,
      'Bob',
      publicKeys
    );

    const updateResult = await updateContactName(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Alice Updated'
    );
    expect(updateResult.success).toBe(true);

    const duplicateResult = await updateContactName(
      CONTACTS_OWNER_USER_ID,
      CONTACTS_CONTACT_USER_ID,
      'Bob'
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
      publicKeys
    );

    await getSqliteDb().insert(schema.discussions).values({
      ownerUserId: CONTACTS_OWNER_USER_ID,
      contactUserId: CONTACTS_CONTACT_USER_ID,
      direction: DiscussionDirection.INITIATED,
      status: DiscussionStatus.ACTIVE,
      weAccepted: true,
      sendAnnouncement: null,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await getSqliteDb().insert(schema.messages).values({
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
      fakeSession
    );

    expect(result.success).toBe(true);
    expect(fakeSession.peerDiscard).toHaveBeenCalled();

    const contacts = await getContacts(CONTACTS_OWNER_USER_ID);
    expect(contacts.length).toBe(0);
  });
});
