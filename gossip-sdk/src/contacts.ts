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
import { type Contact } from './db';
import type {
  UpdateContactNameResult,
  DeleteContactResult,
} from './utils/contacts';
import type { UserPublicKeys } from './wasm/bindings';
import type { SessionModule } from './wasm/session';
import {
  getContactsByOwner,
  getContactByOwnerAndUser,
  insertContact as queryInsertContact,
} from './queries';

// Re-export result types
export type { UpdateContactNameResult, DeleteContactResult };

/**
 * Get all contacts for an owner.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @returns Array of contacts
 *
 * @example
 * ```typescript
 * const contacts = await getContacts(myUserId);
 * contacts.forEach(c => console.log(c.name, c.userId));
 * ```
 */
export async function getContacts(ownerUserId: string): Promise<Contact[]> {
  try {
    return await getContactsByOwner(ownerUserId);
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
 * @returns Contact or null if not found
 *
 * @example
 * ```typescript
 * const contact = await getContact(myUserId, theirUserId);
 * if (contact) {
 *   console.log('Found contact:', contact.name);
 * }
 * ```
 */
export async function getContact(
  ownerUserId: string,
  contactUserId: string
): Promise<Contact | null> {
  try {
    const contact = await getContactByOwnerAndUser(ownerUserId, contactUserId);
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
 * @returns Result with success status and optional contact
 *
 * @example
 * ```typescript
 * const result = await addContact(
 *   myUserId,
 *   'gossip1abc...',
 *   'Alice',
 *   alicePublicKeys
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
  publicKeys: UserPublicKeys
): Promise<{ success: boolean; error?: string; contact?: Contact }> {
  try {
    // Check if contact already exists
    const existing = await getContactByOwnerAndUser(ownerUserId, userId);
    if (existing) {
      return { success: false, error: 'Contact already exists' };
    }

    await queryInsertContact({
      ownerUserId,
      userId,
      name,
      publicKeys: publicKeys.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    const newContact = await getContactByOwnerAndUser(ownerUserId, userId);
    return { success: true, contact: newContact ?? undefined };
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
 * @returns Result with success status and trimmed name
 *
 * @example
 * ```typescript
 * const result = await updateContactName(myUserId, theirUserId, 'Alice Smith');
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
  newName: string
): Promise<UpdateContactNameResult> {
  return await updateContactNameUtil(ownerUserId, contactUserId, newName);
}

/**
 * Delete a contact and all associated discussions and messages.
 *
 * @param ownerUserId - The user ID of the contact owner
 * @param contactUserId - The user ID of the contact to delete
 * @param session - Session module for peer management
 * @returns Result with success status
 *
 * @example
 * ```typescript
 * const result = await deleteContact(myUserId, theirUserId, session);
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
  session: SessionModule
): Promise<DeleteContactResult> {
  return await deleteContactUtil(ownerUserId, contactUserId, session);
}
