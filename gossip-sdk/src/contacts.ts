/**
 * Contact Management SDK
 *
 * Functions for managing contacts
 */

import {
  updateContactName as updateContactNameUtil,
  deleteContact as deleteContactUtil,
} from '../../src/utils/contacts';
import { db } from '../../src/db';
import type {
  Contact,
  UpdateContactNameResult,
  DeleteContactResult,
} from '../../src/db';
import type { UserPublicKeys } from '../../src/assets/generated/wasm/gossip_wasm';

/**
 * Update contact name
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @param newName - New name for the contact
 * @returns Result with success status
 */
export async function updateContactName(
  ownerUserId: string,
  contactUserId: string,
  newName: string
): Promise<UpdateContactNameResult> {
  return await updateContactNameUtil(ownerUserId, contactUserId, newName);
}

/**
 * Delete a contact and all associated discussions and messages
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns Result with success status
 */
export async function deleteContact(
  ownerUserId: string,
  contactUserId: string
): Promise<DeleteContactResult> {
  return await deleteContactUtil(ownerUserId, contactUserId);
}

/**
 * Get all contacts for an owner
 * @param ownerUserId - Owner user ID
 * @returns Array of contacts
 */
export async function getContacts(ownerUserId: string): Promise<Contact[]> {
  try {
    return await db.getContactsByOwner(ownerUserId);
  } catch (error) {
    console.error('Error getting contacts:', error);
    return [];
  }
}

/**
 * Get a specific contact
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns Contact or null if not found
 */
export async function getContact(
  ownerUserId: string,
  contactUserId: string
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
 * Add a new contact
 * @param ownerUserId - Owner user ID
 * @param userId - Contact user ID (Bech32-encoded)
 * @param name - Contact name
 * @param publicKeys - Contact's public keys
 * @returns Result with success status and contact
 */
export async function addContact(
  ownerUserId: string,
  userId: string,
  name: string,
  publicKeys: UserPublicKeys
): Promise<{ success: boolean; error?: string; contact?: Contact }> {
  try {
    // Check if contact already exists
    const existing = await db.getContactByOwnerAndUserId(ownerUserId, userId);
    if (existing) {
      return {
        success: false,
        error: 'Contact already exists',
        contact: existing,
      };
    }

    const contact: Omit<Contact, 'id'> = {
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
    return {
      success: true,
      contact: newContact ?? undefined,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
