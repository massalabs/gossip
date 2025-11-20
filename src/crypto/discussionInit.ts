/**
 * Discussion Initialization Module
 *
 * Implements initialization using the new WASM SessionManager API.
 */

import { Contact, db, Discussion, DiscussionStatus } from '../db';
import { useAccountStore } from '../stores/accountStore';
import { UserPublicKeys } from '../assets/generated/wasm/gossip_wasm';
import { announcementService } from '../services/announcement';

/**
 * Discussion Initialization Logic using high-level SessionManager API
 */

/**
 * Initialize a discussion with a contact using SessionManager
 * @param contact - The contact to start a discussion with
 * @param message - Optional message to include in the announcement
 * @returns The discussion ID and session information
 */
export async function initializeDiscussion(
  contact: Contact,
  message?: string
): Promise<{
  discussionId: number;
  announcement: Uint8Array;
}> {
  try {
    const { ourPk, ourSk, userProfile, session } = useAccountStore.getState();
    if (!ourPk || !ourSk) throw new Error('WASM keys unavailable');
    if (!userProfile?.userId) throw new Error('No authenticated user');
    if (!session) throw new Error('Session module not initialized');

    // Encode message as UTF-8 if provided
    const userData = message
      ? new TextEncoder().encode(message)
      : new Uint8Array(0);

    const announcement = session.establishOutgoingSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      ourPk,
      ourSk,
      userData
    );

    // Persist discussion immediately with the announcement for reliable retry
    const discussionId = await db.discussions.add({
      ownerUserId: userProfile.userId,
      contactUserId: contact.userId,
      direction: 'initiated',
      status: DiscussionStatus.PENDING,
      nextSeeker: undefined,
      initiationAnnouncement: announcement,
      announcementMessage: message,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Send the announcement to the contact
    const result = await announcementService.sendAnnouncement(announcement);
    if (!result.success) {
      console.warn(
        `Failed to send announcement: ${result.error || 'Unknown error'}. Discussion saved for retry.`
      );
      // Don't throw - the discussion is saved and can be retried later
    }

    return { discussionId, announcement };
  } catch (error) {
    console.error('Failed to initialize discussion:', error);
    throw new Error('Discussion initialization failed');
  }
}

export async function acceptDiscussionRequest(
  discussion: Discussion
): Promise<void> {
  try {
    const { ourPk, ourSk, session } = useAccountStore.getState();
    if (!ourPk || !ourSk) throw new Error('WASM keys unavailable');
    if (!session) throw new Error('Session module not initialized');

    const contact = await db.getContactByOwnerAndUserId(
      discussion.ownerUserId,
      discussion.contactUserId
    );

    if (!contact) throw new Error('Contact not found');

    // establish outgoing session and get announcement bytes
    const announcement = session.establishOutgoingSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      ourPk,
      ourSk
    );

    // send announcement to contact

    const result = await announcementService.sendAnnouncement(announcement);
    if (!result.success) {
      throw new Error(
        `Failed to send outgoing session: ${result.error || 'Unknown error'}`
      );
    }

    // update discussion status
    await db.discussions.update(discussion.id, {
      status: DiscussionStatus.ACTIVE,
      updatedAt: new Date(),
    });

    return;
  } catch (error) {
    console.error('Failed to accept pending discussion:', error);
    throw new Error('Failed to accept pending discussion');
  }
}

/**
 * Ensure a discussion exists for a contact, creating one if it doesn't exist
 * @param contact - The contact to ensure a discussion exists for
 * @param existingDiscussion - Optional existing discussion (if already loaded)
 * @param message - Optional message to include in the announcement
 * @returns true if a discussion exists (or was created), false otherwise
 */
export async function ensureDiscussionExists(
  contact: Contact,
  existingDiscussion?: Discussion | null,
  message?: string
): Promise<boolean> {
  try {
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) {
      console.warn('No authenticated user, cannot ensure discussion exists');
      return false;
    }

    // If we already have a discussion, check if it's valid
    if (existingDiscussion) {
      return true;
    }

    // Check if a discussion already exists in the database
    const existing = await db.getDiscussionByOwnerAndContact(
      userProfile.userId,
      contact.userId
    );

    if (existing) {
      return true;
    }

    // No discussion exists, try to create one
    // Guard: we cannot initialize a discussion without the contact's public keys
    if (!contact.publicKeys || contact.publicKeys.length === 0) {
      console.warn(
        'Contact is missing public keys. Cannot create discussion yet.'
      );
      return false;
    }

    // Initialize a new discussion
    await initializeDiscussion(contact, message);
    return true;
  } catch (error) {
    console.error('Failed to ensure discussion exists:', error);
    return false;
  }
}
