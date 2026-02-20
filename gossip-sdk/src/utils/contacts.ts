/**
 * Contact Utilities
 *
 * Functions for managing contacts including updating names and deleting contacts.
 */

import { decodeUserId } from './userId';
import type { SessionModule } from '../wasm/session';
import {
  getContactsByOwner,
  getContactByOwnerAndUser,
  updateContactByOwnerAndUser,
  deleteContactByOwnerAndUser,
  deleteDiscussionsByOwnerAndContact,
  deleteMessagesByOwnerAndContact,
} from '../queries';
import { withTransaction } from '../sqlite';

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
  newName: string
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
    const list = await getContactsByOwner(ownerUserId);
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

    await updateContactByOwnerAndUser(ownerUserId, contactUserId, {
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
  session: SessionModule
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
    const contact = await getContactByOwnerAndUser(ownerUserId, contactUserId);
    if (!contact) {
      return {
        success: false,
        reason: 'not_found',
        message: 'Contact not found.',
      };
    }

    // Delete contact, discussions, and messages atomically
    await withTransaction(async () => {
      await deleteContactByOwnerAndUser(ownerUserId, contactUserId);
      await deleteDiscussionsByOwnerAndContact(ownerUserId, contactUserId);
      await deleteMessagesByOwnerAndContact(ownerUserId, contactUserId);
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
