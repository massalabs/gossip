/**
 * Contact Utilities
 *
 * Functions for managing contacts including updating names and deleting contacts.
 */

import { type GossipDatabase } from '../db';
import { decodeUserId } from './userId';
import type { SessionModule } from '../wasm/session';

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
 * @param db - Database instance
 * @returns Result with success status
 */
export async function updateContactName(
  ownerUserId: string,
  contactUserId: string,
  newName: string,
  db: GossipDatabase
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
    const list = await db.getContactsByOwner(ownerUserId);
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

    await db.contacts
      .where('[ownerUserId+userId]')
      .equals([ownerUserId, contactUserId])
      .modify({ name: trimmed });

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
 * @param db - Database instance
 * @param session - Session module for peer management
 * @returns Result with success status
 */
export async function deleteContact(
  ownerUserId: string,
  contactUserId: string,
  db: GossipDatabase,
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

    // Delete in a transaction to ensure atomicity
    const result: DeleteContactResult = await db.transaction(
      'rw',
      [db.contacts, db.discussions, db.messages],
      async () => {
        // Verify contact exists
        const contact = await db.getContactByOwnerAndUserId(
          ownerUserId,
          contactUserId
        );
        if (!contact) {
          return {
            success: false,
            reason: 'not_found',
            message: 'Contact not found',
          };
        }
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

        return { success: true };
      }
    );

    if (!result.success) return result;

    // Discard peer from session manager and persist
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
