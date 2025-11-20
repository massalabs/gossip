import { Discussion, DiscussionStatus, db } from '../db';
import { notificationService } from './notifications';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { announcementService } from './announcement';
import { SessionModule } from '../wasm/session';

/**
 * Create or update a discussion based on a contact user id.
 * If a discussion already exists, it will be updated accordingly.
 * Otherwise, a new discussion will be created.
 */
export async function createUpdateDiscussion(
  ownerUserId: string,
  contactUserId: string,
  contactName?: string,
  announcementMessage?: string
): Promise<{ discussionId: number }> {
  const existing = await db.getDiscussionByOwnerAndContact(
    ownerUserId,
    contactUserId
  );

  if (existing) {
    const updateData: Partial<Discussion> = {
      updatedAt: new Date(),
    };

    if (announcementMessage) {
      updateData.announcementMessage = announcementMessage;
    }

    if (
      existing.status === DiscussionStatus.PENDING &&
      existing.direction === 'initiated'
    ) {
      updateData.status = DiscussionStatus.ACTIVE;
    }

    await db.discussions.update(existing.id!, updateData);
    return { discussionId: existing.id! };
  }

  const discussionId = await db.discussions.add({
    ownerUserId: ownerUserId,
    contactUserId: contactUserId,
    direction: 'received',
    status: DiscussionStatus.PENDING,
    nextSeeker: undefined,
    announcementMessage,
    unreadCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    await notificationService.showNewDiscussionNotification(
      contactName || `User ${contactUserId.substring(0, 8)}`
    );
  } catch (notificationError) {
    console.error(
      'Failed to show new discussion notification:',
      notificationError
    );
  }

  return { discussionId };
}

/**
 * Renew a discussion by resetting sent outgoing messages and sending a new announcement.
 */
export async function renewDiscussion(
  ownerUserId: string,
  contactUserId: string,
  session: SessionModule,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys
): Promise<void> {
  const contact = await db.getContactByOwnerAndUserId(
    ownerUserId,
    contactUserId
  );

  if (!contact) throw new Error('Contact not found');

  const existingDiscussion = await db.getDiscussionByOwnerAndContact(
    ownerUserId,
    contactUserId
  );

  if (!existingDiscussion)
    throw new Error('Discussion with contact ' + contact.name + ' not found');

  const result = await announcementService.establishSession(
    UserPublicKeys.from_bytes(contact.publicKeys),
    ourPk,
    ourSk,
    session
  );

  let status: DiscussionStatus = DiscussionStatus.PENDING;
  if (!result.success) {
    status = DiscussionStatus.SEND_FAILED;
  }

  db.transaction('rw', db.discussions, async () => {
    db.discussions.update(existingDiscussion.id, {
      status: status,
      direction: 'initiated',
      initiationAnnouncement: result.announcement,
      updatedAt: new Date(),
    });

    /* Mark all outgoing messages that are not delivered or read as failed and remove the encryptedMessage */
    db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .and(
        msg =>
          msg.direction === 'outgoing' &&
          msg.status !== 'delivered' &&
          msg.status !== 'read'
      )
      .modify({ status: 'failed', encryptedMessage: undefined });
  });
}
