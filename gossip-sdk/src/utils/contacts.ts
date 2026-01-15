/**
 * Contact Utilities
 *
 * Functions for managing contacts including updating names and deleting contacts.
 */

import { db } from '../db';
import { decodeUserId } from './userId';
import { getAccountStore } from '../utils';

export type UpdateContactNameResult =
  | { ok: true; trimmedName: string }
  | {
      ok: false;
      reason: 'empty' | 'duplicate' | 'error';
      message: string;
    };

export type DeleteContactResult =
  | { ok: true }
  | {
      ok: false;
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
      ok: false,
      reason: 'error',
      message: 'Invalid parameters.',
    };
  }

  const trimmed = newName.trim();
  if (!trimmed)
    return { ok: false, reason: 'empty', message: 'Name cannot be empty.' };
  try {
    const list = await db.getContactsByOwner(ownerUserId);
    const duplicate = list.find(
      contact =>
        contact.userId !== contactUserId &&
        contact.name.toLowerCase() === trimmed.toLowerCase()
    );
    if (duplicate)
      return {
        ok: false,
        reason: 'duplicate',
        message: 'This name is already used by another contact.',
      };

    await db.contacts
      .where('[ownerUserId+userId]')
      .equals([ownerUserId, contactUserId])
      .modify({ name: trimmed });

    return { ok: true, trimmedName: trimmed };
  } catch (e) {
    console.error('updateContactName failed', e);
    return {
      ok: false,
      reason: 'error',
      message: 'Failed to update name. Please try again.',
    };
  }
}

/**
 * Delete a contact and all associated discussions and messages
 *
 * NOTE: This function reads the session from the configured account store adapter.
 * Set the adapter via configureSdk() before calling in non-React runtimes.
 * TODO: Refactor to accept the session explicitly for full decoupling.
 *
 * @param ownerUserId - Owner user ID
 * @param contactUserId - Contact user ID
 * @returns Result with success status
 */
export async function deleteContact(
  ownerUserId: string,
  contactUserId: string
): Promise<DeleteContactResult> {
  try {
    if (!ownerUserId || !contactUserId) {
      return {
        ok: false,
        reason: 'error',
        message: 'Invalid parameters.',
      };
    }

    // Verify contact exists
    const contact = await db.getContactByOwnerAndUserId(
      ownerUserId,
      contactUserId
    );
    if (!contact) {
      return {
        ok: false,
        reason: 'not_found',
        message: 'Contact not found.',
      };
    }

    // Delete in a transaction to ensure atomicity
    await db.transaction(
      'rw',
      [db.contacts, db.discussions, db.messages],
      async () => {
        // Delete the contact
        await db.contacts
          .where('[ownerUserId+userId]')
          .equals([ownerUserId, contactUserId])
          .delete();

        // Delete related discussions
        await db.discussions
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .delete();

        // Delete related messages
        await db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .delete();
      }
    );

    // Discard peer from session manager
    // NOTE: This reads the adapter directly - see note above
    const session = getAccountStore().getState().session;
    if (!session) {
      return {
        ok: false,
        reason: 'error',
        message: 'Session not found.',
      };
    }
    session.peerDiscard(decodeUserId(contactUserId));

    return { ok: true };
  } catch (e) {
    console.error('deleteContact failed', e);
    return {
      ok: false,
      reason: 'error',
      message: 'Failed to delete contact. Please try again.',
    };
  }
}
