/**
 * Contact Management SDK Tests
 */

import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
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
import { createMessageProtocol } from '../../src/api/messageProtocol';
import { MessageProtocolType } from '../../src/config/protocol';
import { announcementService } from '../../src/services/announcement';
import { messageService } from '../../src/services/message';
import { generateUserKeys } from '../../src/wasm/userKeys';
import { encodeUserId } from '../../src/utils/userId';

describe('Contact Management', () => {
  let ownerUserId: string;
  let contactPublicKeys: UserPublicKeys;
  let contactUserId: string;

  beforeAll(async () => {
    const mockProtocol = createMessageProtocol(MessageProtocolType.MOCK);
    announcementService.setMessageProtocol(mockProtocol);
    messageService.setMessageProtocol(mockProtocol);
  });

  beforeEach(async () => {
    // Database is already cleaned up by setup.ts afterEach hook
    // Just ensure it's open
    const { db } = await import('../../src/db');
    if (!db.isOpen()) {
      await db.open();
    }

    // Initialize account
    await initializeAccount('testuser', 'testpassword123');
    const account = getAccount();
    ownerUserId = account.userProfile?.userId || '';

    // Generate real public keys for contact using the same method as the app
    const mnemonic =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const keys = await generateUserKeys(mnemonic);
    contactPublicKeys = keys.public_keys();
    contactUserId = encodeUserId(contactPublicKeys.derive_id());
  });

  describe('addContact', () => {
    it('should add a new contact', async () => {
      const result = await addContact(
        ownerUserId,
        contactUserId,
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
        contactUserId,
        'Test Contact',
        contactPublicKeys
      );

      const result = await addContact(
        ownerUserId,
        contactUserId,
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
      // Generate a different userId for non-existent contact
      const mnemonic2 =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
      const keys2 = await generateUserKeys(mnemonic2);
      const nonExistentUserId = encodeUserId(keys2.public_keys().derive_id());
      const contact = await getContact(ownerUserId, nonExistentUserId);
      expect(contact).toBeNull();
    });

    it('should return contact when it exists', async () => {
      await addContact(
        ownerUserId,
        contactUserId,
        'Test Contact',
        contactPublicKeys
      );

      const contact = await getContact(ownerUserId, contactUserId);
      expect(contact).toBeDefined();
      expect(contact?.name).toBe('Test Contact');
    });
  });

  describe('updateContactName', () => {
    it('should update contact name', async () => {
      await addContact(
        ownerUserId,
        contactUserId,
        'Original Name',
        contactPublicKeys
      );

      const result = await updateContactName(
        ownerUserId,
        contactUserId,
        'Updated Name'
      );
      expect(result.ok).toBe(true);

      const contact = await getContact(ownerUserId, contactUserId);
      expect(contact?.name).toBe('Updated Name');
    });

    it('should return error for empty name', async () => {
      await addContact(
        ownerUserId,
        contactUserId,
        'Original Name',
        contactPublicKeys
      );

      const result = await updateContactName(ownerUserId, contactUserId, '');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('empty');
    });
  });

  describe('deleteContact', () => {
    it('should delete contact', async () => {
      await addContact(
        ownerUserId,
        contactUserId,
        'Test Contact',
        contactPublicKeys
      );

      const result = await deleteContact(ownerUserId, contactUserId);
      expect(result.ok).toBe(true);

      const contact = await getContact(ownerUserId, contactUserId);
      expect(contact).toBeNull();
    });
  });
});
