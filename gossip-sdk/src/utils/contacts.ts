/**
 * Contact Utilities
 *
 * Functions for managing contacts including updating names and deleting contacts.
 */

import { decodeUserId } from './userId.js';
import type { SessionModule } from '../wasm/session.js';
import type { UserPublicKeys } from '../wasm/bindings.js';
import type { Contact } from '../db/index.js';
import { Queries } from '../db/queries/index.js';

export type AddContactResult = {
  success: boolean;
  error?: string;
  contact?: Contact;
};

export type UpdateContactNameResult =
  | { success: true; trimmedName: string }
  | {
      success: false;
      reason: 'empty' | 'duplicate' | 'error';
      message: string;
    };

export type DeleteContactResult =
  | { success: true }
  | {
      success: false;
      reason: 'not_found' | 'error';
      message: string;
    };

/**
 * Update the name of a contact
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @param newName - New name for the contact
 * @returns Result with success status
 */
export async function updateContactName(
  ownerUserId: string,
  contactUserId: string,
  newName: string,
  queries: Queries
): Promise<UpdateContactNameResult> {
  if (!ownerUserId || !contactUserId) {
    return {
      success: false,
      reason: 'error',
      message: 'Invalid parameters.',
    };
  }

  const trimmed = newName.trim();
  if (!trimmed)
    return {
      success: false,
      reason: 'empty',
      message: 'Name cannot be empty.',
    };
  try {
    const list = await queries.contacts.getByOwner(ownerUserId);
    const duplicate = list.find(
      contact =>
        contact.userId !== contactUserId &&
        contact.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate)
      return {
        success: false,
        reason: 'duplicate',
        message: 'This name is already used by another contact.',
      };

    await queries.contacts.updateByOwnerAndUser(ownerUserId, contactUserId, {
      name: trimmed,
    });

    return { success: true, trimmedName: trimmed };
  } catch (e) {
    console.error('updateContactName failed', e);
    return {
      success: false,
      reason: 'error',
      message: 'Failed to update name. Please try again.',
    };
  }
}

/**
 * Delete a contact and all associated discussions and messages
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @param session - Session module for peer management
 * @returns Result with success status
 */
export async function deleteContact(
  ownerUserId: string,
  contactUserId: string,
  session: SessionModule,
  queries: Queries
): Promise<DeleteContactResult> {
  try {
    if (!ownerUserId || !contactUserId) {
      return {
        success: false,
        reason: 'error',
        message: 'Invalid parameters.',
      };
    }

    // Verify contact exists
    const contact = await queries.contacts.getByOwnerAndUser(
      ownerUserId,
      contactUserId
    );
    if (!contact) {
      return {
        success: false,
        reason: 'not_found',
        message: 'Contact not found.',
      };
    }

    // Delete contact, discussions, and messages atomically
    await queries.conn.withTransaction(async tx => {
      await queries.contacts.deleteByOwnerAndUser(
        ownerUserId,
        contactUserId,
        tx
      );
      await queries.discussions.deleteByOwnerAndContact(
        ownerUserId,
        contactUserId,
        tx
      );
      await queries.messages.deleteByOwnerAndContact(
        ownerUserId,
        contactUserId,
        tx
      );
    });

    // Discard peer from session manager (WASM state, outside transaction)
    await session.peerDiscard(decodeUserId(contactUserId));

    return { success: true };
  } catch (e) {
    console.error('deleteContact failed', e);
    return {
      success: false,
      reason: 'error',
      message: 'Failed to delete contact. Please try again.',
    };
  }
}

/**
 * Add a new contact.
 */
export async function addContact(
  ownerUserId: string,
  userId: string,
  name: string,
  publicKeys: UserPublicKeys,
  queries: Queries
): Promise<AddContactResult> {
  try {
    const existing = await queries.contacts.getByOwnerAndUser(
      ownerUserId,
      userId
    );
    if (existing) {
      return { success: false, error: 'Contact already exists' };
    }

    await queries.contacts.insert({
      ownerUserId,
      userId,
      name,
      publicKeys: publicKeys.to_bytes(),
      isOnline: false,
      lastSeen: new Date(),
      createdAt: new Date(),
    });

    const newContact = await queries.contacts.getByOwnerAndUser(
      ownerUserId,
      userId
    );
    return { success: true, contact: newContact ?? undefined };
  } catch (error) {
    console.error('Error adding contact:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
