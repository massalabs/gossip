/**
 * Contact Management SDK
 *
 * Functions for managing contacts including CRUD operations.
 *
 * @example
 * ```typescript
 * import { getContacts, addContact, deleteContact } from '@massalabs/gossip-sdk';
 *
 * // Get all contacts
 * const contacts = await getContacts(userId);
 *
 * // Add a new contact
 * const result = await addContact(userId, contactUserId, 'Alice', publicKeys);
 *
 * // Delete a contact
 * await deleteContact(userId, contactUserId);
 * ```
 */

import {
  updateContactName as updateContactNameUtil,
  deleteContact as deleteContactUtil,
} from './utils/contacts';
import { type Contact, type GossipDatabase } from './db';
import type {
  UpdateContactNameResult,
  DeleteContactResult,
} from './utils/contacts';
import type { UserPublicKeys } from './wasm/bindings';
import type { SessionModule } from './wasm/session';

// Re-export result types
export type { UpdateContactNameResult, DeleteContactResult };

/**
 * Get all contacts for an owner.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param db - Database instance
 * @returns Array of contacts
 *
 * @example
 * ```typescript
 * const contacts = await getContacts(myUserId, db);
 * contacts.forEach(c => console.log(c.name, c.userId));
 * ```
 */
export async function getContacts(
  ownerUserId: string,
  db: GossipDatabase
): Promise<Contact[]> {
  try {
    return await db.getContactsByOwner(ownerUserId);
  } catch (error) {
    console.error('Error getting contacts:', error);
    return [];
  }
}

/**
 * Get a specific contact by owner and contact user IDs.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param contactUserId - The user ID of the contact
 * @param db - Database instance
 * @returns Contact or null if not found
 *
 * @example
 * ```typescript
 * const contact = await getContact(myUserId, theirUserId, db);
 * if (contact) {
 *   console.log('Found contact:', contact.name);
 * }
 * ```
 */
export async function getContact(
  ownerUserId: string,
  contactUserId: string,
  db: GossipDatabase
): Promise<Contact | null> {
  try {
    const contact = await db.getContactByOwnerAndUserId(
      ownerUserId,
      contactUserId
    );
    return contact ?? null;
  } catch (error) {
    console.error('Error getting contact:', error);
    return null;
  }
}

/**
 * Add a new contact.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param userId - The user ID of the contact (Bech32-encoded)
 * @param name - Display name for the contact
 * @param publicKeys - The contact's public keys
 * @param db - Database instance
 * @returns Result with success status and optional contact
 *
 * @example
 * ```typescript
 * const result = await addContact(
 *   myUserId,
 *   'gossip1abc...',
 *   'Alice',
 *   alicePublicKeys,
 *   db
 * );
 * if (result.success) {
 *   console.log('Contact added:', result.contact?.name);
 * } else if (result.error === 'Contact already exists') {
 *   console.log('Contact already exists');
 * }
 * ```
 */
export async function addContact(
  ownerUserId: string,
  userId: string,
  name: string,
  publicKeys: UserPublicKeys,
  db: GossipDatabase
): Promise<{ success: boolean; error?: string; contact?: Contact }> {
  try {
    // Check if contact already exists
    const existing = await db.getContactByOwnerAndUserId(ownerUserId, userId);
    if (existing) {
      return { success: false, error: 'Contact already exists' };
    }

    const contact: Contact = {
      ownerUserId,
      userId,
      name,
      publicKeys: publicKeys.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    };

    const id = await db.contacts.add(contact);
    const newContact = await db.contacts.get(id);
    return { success: true, contact: newContact };
  } catch (error) {
    console.error('Error adding contact:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update contact name.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param contactUserId - The user ID of the contact
 * @param newName - New name for the contact
 * @param db - Database instance
 * @returns Result with success status and trimmed name
 *
 * @example
 * ```typescript
 * const result = await updateContactName(myUserId, theirUserId, 'Alice Smith', db);
 * if (result.ok) {
 *   console.log('Updated to:', result.trimmedName);
 * } else {
 *   console.error('Failed:', result.message);
 * }
 * ```
 */
export async function updateContactName(
  ownerUserId: string,
  contactUserId: string,
  newName: string,
  db: GossipDatabase
): Promise<UpdateContactNameResult> {
  return await updateContactNameUtil(ownerUserId, contactUserId, newName, db);
}

/**
 * Delete a contact and all associated discussions and messages.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param contactUserId - The user ID of the contact to delete
 * @param db - Database instance
 * @param session - Session module for peer management
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await deleteContact(myUserId, theirUserId, db, session);
 * if (result.ok) {
 *   console.log('Contact deleted');
 * } else {
 *   console.error('Failed:', result.message);
 * }
 * ```
 */
export async function deleteContact(
  ownerUserId: string,
  contactUserId: string,
  db: GossipDatabase,
  session: SessionModule
): Promise<DeleteContactResult> {
  return await deleteContactUtil(ownerUserId, contactUserId, db, session);
}
