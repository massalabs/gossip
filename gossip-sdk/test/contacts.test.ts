/**
 * Contact Management SDK Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  addContact,
  getContacts,
  getContact,
  updateContactName,
  deleteContact,
} from '../src/contacts';
import { initializeAccount } from '../src/account';
import { getAccount } from '../src/utils';
import { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

describe('Contact Management', () => {
  let ownerUserId: string;
  let contactPublicKeys: UserPublicKeys;

  beforeEach(async () => {
    // Clean up database before each test
    try {
      const { db } = await import('../src/db');
      await db.delete();
    } catch (_) {
      // Ignore errors
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
    const account = getAccount();
    ownerUserId = account.userProfile?.userId || '';

    // Create mock public keys for contact
    contactPublicKeys = new UserPublicKeys(
      new Uint8Array(32),
      new Uint8Array(32),
      new Uint8Array(32)
    );
  });

  describe('addContact', () => {
    it('should add a new contact', async () => {
      const result = await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Test Contact',
        contactPublicKeys
      );
      expect(result.success).toBe(true);
      expect(result.contact).toBeDefined();
      expect(result.contact?.name).toBe('Test Contact');
    });

    it('should return error if contact already exists', async () => {
      await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Test Contact',
        contactPublicKeys
      );

      const result = await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Test Contact 2',
        contactPublicKeys
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('getContacts', () => {
    it('should return empty array when no contacts exist', async () => {
      const contacts = await getContacts(ownerUserId);
      expect(contacts).toEqual([]);
    });

    it('should return all contacts', async () => {
      await addContact(
        ownerUserId,
        'gossip1contact1',
        'Contact 1',
        contactPublicKeys
      );
      await addContact(
        ownerUserId,
        'gossip1contact2',
        'Contact 2',
        contactPublicKeys
      );

      const contacts = await getContacts(ownerUserId);
      expect(contacts.length).toBe(2);
    });
  });

  describe('getContact', () => {
    it('should return null for non-existent contact', async () => {
      const contact = await getContact(ownerUserId, 'gossip1nonexistent');
      expect(contact).toBeNull();
    });

    it('should return contact when it exists', async () => {
      await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Test Contact',
        contactPublicKeys
      );

      const contact = await getContact(ownerUserId, 'gossip1testcontact');
      expect(contact).toBeDefined();
      expect(contact?.name).toBe('Test Contact');
    });
  });

  describe('updateContactName', () => {
    it('should update contact name', async () => {
      await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Original Name',
        contactPublicKeys
      );

      const result = await updateContactName(
        ownerUserId,
        'gossip1testcontact',
        'Updated Name'
      );
      expect(result.ok).toBe(true);

      const contact = await getContact(ownerUserId, 'gossip1testcontact');
      expect(contact?.name).toBe('Updated Name');
    });

    it('should return error for empty name', async () => {
      await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Original Name',
        contactPublicKeys
      );

      const result = await updateContactName(
        ownerUserId,
        'gossip1testcontact',
        ''
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('empty');
    });
  });

  describe('deleteContact', () => {
    it('should delete contact', async () => {
      await addContact(
        ownerUserId,
        'gossip1testcontact',
        'Test Contact',
        contactPublicKeys
      );

      const result = await deleteContact(ownerUserId, 'gossip1testcontact');
      expect(result.ok).toBe(true);

      const contact = await getContact(ownerUserId, 'gossip1testcontact');
      expect(contact).toBeNull();
    });
  });
});
