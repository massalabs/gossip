import {
  DiscussionStatus,
  Discussion,
  Contact,
  db,
  MessageDirection,
  MessageStatus,
  DiscussionDirection,
} from '../db';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { announcementService, EstablishSessionError } from './announcement';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { decodeUserId } from '../utils';
import { SessionStatus } from '../assets/generated/wasm/gossip_wasm';

/**
/**
 * Initialize a discussion with a contact using SessionManager
 * @param contact - The contact to start a discussion with
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @param session - The SessionModule instance to use
 * @param userId - The user ID of the current user (discussion owner)
 * @param message - Optional message to include in the announcement
 * @returns The discussion ID and the created announcement
 */
export async function initializeDiscussion(
  contact: Contact,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys,
  session: SessionModule,
  userId: string,
  message?: string
): Promise<{
  discussionId: number;
  announcement: Uint8Array;
}> {
  try {
    // Encode message as UTF-8 if provided
    const userData = message
      ? new TextEncoder().encode(message)
      : new Uint8Array(0);

    console.log(
      `initializeDiscussion: ${userId} is establishing session with contact ${contact.name}`
    );
    const result = await announcementService.establishSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      ourPk,
      ourSk,
      session,
      userData
    );

    let status: DiscussionStatus = DiscussionStatus.PENDING;
    if (!result.success) {
      console.error(
        'Failed to establish session with contact',
        contact.name,
        ', got error: ',
        result.error
      );
      status = DiscussionStatus.SEND_FAILED;
    } else {
      console.log(
        `initializeDiscussion: session established with contact and announcement sent: ${result.announcement}... bytes`
      );
    }

    // Persist discussion immediately with the announcement for reliable retry
    const discussionId = await db.discussions.add({
      ownerUserId: userId,
      contactUserId: contact.userId,
      direction: DiscussionDirection.INITIATED,
      status: status,
      nextSeeker: undefined,
      initiationAnnouncement: result.announcement,
      announcementMessage: message,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log(
      `initializeDiscussion: discussion created with id: ${discussionId}`
    );

    return { discussionId, announcement: result.announcement };
  } catch (error) {
    console.error('Failed to initialize discussion:', error);
    throw new Error('Discussion initialization failed');
  }
}

/**
 * Accept a discussion request from a contact using SessionManager
 * @param discussion - The discussion to accept
 * @param session - The SessionModule instance to use
 * @param ourPk - Our public keys
 * @param ourSk - Our secret keys
 * @returns void
 */
export async function acceptDiscussionRequest(
  discussion: Discussion,
  session: SessionModule,
  ourPk: UserPublicKeys,
  ourSk: UserSecretKeys
): Promise<void> {
  try {
    const contact = await db.getContactByOwnerAndUserId(
      discussion.ownerUserId,
      discussion.contactUserId
    );

    if (!contact)
      throw new Error(
        `Contact ${discussion.contactUserId} not found for ownerUserId ${discussion.ownerUserId}`
      );

    const result = await announcementService.establishSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      ourPk,
      ourSk,
      session
    );

    let status: DiscussionStatus = DiscussionStatus.ACTIVE;
    if (!result.success) {
      console.error(
        'Failed to establish session with contact',
        contact.name,
        ', got error: ',
        result.error
      );
      status = DiscussionStatus.SEND_FAILED;
    } else {
      console.log(
        `acceptDiscussionRequest: session established with contact and announcement sent: ${result.announcement}... bytes`
      );
    }

    // update discussion status
    await db.discussions.update(discussion.id, {
      status: status,
      initiationAnnouncement: result.announcement,
      updatedAt: new Date(),
    });
    console.log(
      `acceptDiscussionRequest: discussion updated with status: ${status}`
    );

    return;
  } catch (error) {
    console.error('Failed to accept pending discussion:', error);
    throw new Error('Failed to accept pending discussion');
  }
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

  console.log(
    `renewDiscussion: renewing discussion between ${ownerUserId} and ${contactUserId}`
  );

  const result = await announcementService.establishSession(
    UserPublicKeys.from_bytes(contact.publicKeys),
    ourPk,
    ourSk,
    session
  );

  // if the error is due to the session manager failed to establish outgoing session, throw the error
  if (result.error && result.error.includes(EstablishSessionError))
    throw new Error(EstablishSessionError);

  const sessionStatus = session.peerSessionStatus(decodeUserId(contactUserId));
  console.log(
    `renewDiscussion: session status for discussion between ${ownerUserId} and ${contactUserId} after reinitiation is ${sessionStatusToString(sessionStatus)}`
  );

  const status: DiscussionStatus = !result.success
    ? DiscussionStatus.SEND_FAILED
    : sessionStatus === SessionStatus.Active
      ? DiscussionStatus.ACTIVE
      : DiscussionStatus.PENDING;

  await db.transaction('rw', [db.discussions, db.messages], async () => {
    await db.discussions.update(existingDiscussion.id, {
      status: status,
      direction: DiscussionDirection.INITIATED,
      initiationAnnouncement: result.announcement,
      updatedAt: new Date(),
    });

    console.log(`renewDiscussion: discussion updated with status: ${status}`);

    /* Mark all outgoing messages that are not delivered or read as failed and remove the encryptedMessage */
    await db.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .and(
        msg =>
          msg.direction === MessageDirection.OUTGOING &&
          msg.status !== MessageStatus.DELIVERED &&
          msg.status !== MessageStatus.READ
      )
      .modify({
        status: MessageStatus.FAILED,
        encryptedMessage: undefined,
        seeker: undefined,
      });
    console.log(
      `renewDiscussion: all outgoing messages that are not delivered or read have been marked as failed`
    );
  });
}

/* Return true if new message can be sent to session manager for encryption. 
If the discusison is Broken or if there is a failed message that has not been encrypted by the session manager, return false.
To send new messages to discussion, the discussion must be non Broken and all failed messages must have a non null
encryptedMessage field. If it's not the case, new messages can still be added in discussion but as failed and without encryptedMessage field.
 */
export async function isDiscussionStableState(
  ownerUserId: string,
  contactUserId: string
): Promise<boolean> {
  const discussion: Discussion | undefined =
    await db.getDiscussionByOwnerAndContact(ownerUserId, contactUserId);

  if (!discussion) throw new Error('Discussion not found');

  if (discussion.status === DiscussionStatus.BROKEN) {
    console.log(
      `isDiscussionStableState: Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} is broken`
    );
    return false;
  }

  const messages = await db.messages
    .where('[ownerUserId+contactUserId+direction]')
    .equals([
      discussion.ownerUserId,
      discussion.contactUserId,
      MessageDirection.OUTGOING,
    ])
    .sortBy('id');

  /* If the discussion has been broken, all non delivered messages have been marked as failed and
  their encryptedMessage field has been deleted. 
  If there are some unencrypted unsent messages in the conversation, the discussion is not stable
  i.e. we should not encrypt any new message via session manager before these messages are not resent */
  if (
    messages.length > 0 &&
    !messages[messages.length - 1].encryptedMessage &&
    messages[messages.length - 1].status === MessageStatus.FAILED
  ) {
    console.log(
      `isDiscussionStableState: Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} has no encryptedMessage failed messages`
    );
    return false;
  }

  return true;
}
