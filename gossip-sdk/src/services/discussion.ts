/**
 * Discussion Service
 *
 * Class-based service for initializing, accepting, and managing discussions.
 */

import {
  DiscussionStatus,
  type Discussion,
  type Contact,
  type GossipDatabase,
  MessageDirection,
  MessageStatus,
  DiscussionDirection,
} from '../db';
import { UserPublicKeys } from '../assets/generated/wasm/gossip_wasm';
import { AnnouncementService, EstablishSessionError } from './announcement';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { decodeUserId } from '../utils/userId';
import { SessionStatus } from '../assets/generated/wasm/gossip_wasm';
import { Logger } from '../utils/logs';

const logger = new Logger('DiscussionService');

/**
 * Service for managing discussions between users.
 *
 * @example
 * ```typescript
 * const discussionService = new DiscussionService(db, announcementService);
 *
 * // Initialize a new discussion
 * const result = await discussionService.initialize(contact, session, 'Hello!');
 *
 * // Accept a discussion request
 * await discussionService.accept(discussion, session);
 *
 * // Renew a broken discussion
 * await discussionService.renew(contactUserId, session);
 * ```
 */
export class DiscussionService {
  private db: GossipDatabase;
  private announcementService: AnnouncementService;

  constructor(db: GossipDatabase, announcementService: AnnouncementService) {
    this.db = db;
    this.announcementService = announcementService;
  }

  /**
   * Initialize a discussion with a contact using SessionManager
   * @param contact - The contact to start a discussion with
   * @param session - The SessionModule instance to use
   * @param message - Optional message to include in the announcement
   * @returns The discussion ID and the created announcement
   */
  async initialize(
    contact: Contact,
    session: SessionModule,
    message?: string
  ): Promise<{
    discussionId: number;
    announcement: Uint8Array;
  }> {
    const log = logger.forMethod('initialize');
    try {
      const userId = session.userIdEncoded;
      // Encode message as UTF-8 if provided
      const userData = message
        ? new TextEncoder().encode(message)
        : new Uint8Array(0);

      log.info(
        `${userId} is establishing session with contact ${contact.name}`
      );
      const result = await this.announcementService.establishSession(
        UserPublicKeys.from_bytes(contact.publicKeys),
        session,
        userData
      );

      let status: DiscussionStatus = DiscussionStatus.PENDING;
      if (!result.success) {
        log.error(
          `Failed to establish session with contact ${contact.name}, got error: ${result.error}`
        );
        // if the error is due to the session manager failed to establish outgoing session, throw the error
        if (result.error && result.error.includes(EstablishSessionError))
          throw new Error(EstablishSessionError);

        status = DiscussionStatus.SEND_FAILED;
      } else {
        log.info(
          `session established with contact and announcement sent: ${result.announcement.length}... bytes`
        );
      }

      // Persist discussion immediately with the announcement for reliable retry
      const discussionId = await this.db.discussions.add({
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

      log.info(`discussion created with id: ${discussionId}`);

      return { discussionId, announcement: result.announcement };
    } catch (error) {
      log.error(`Failed to initialize discussion, error: ${error}`);
      throw new Error('Discussion initialization failed, error: ' + error);
    }
  }

  /**
   * Accept a discussion request from a contact using SessionManager
   * @param discussion - The discussion to accept
   * @param session - The SessionModule instance to use
   */
  async accept(discussion: Discussion, session: SessionModule): Promise<void> {
    const log = logger.forMethod('accept');
    try {
      const contact = await this.db.getContactByOwnerAndUserId(
        discussion.ownerUserId,
        discussion.contactUserId
      );
      if (!contact)
        throw new Error(
          `Contact ${discussion.contactUserId} not found for ownerUserId ${discussion.ownerUserId}`
        );

      const result = await this.announcementService.establishSession(
        UserPublicKeys.from_bytes(contact.publicKeys),
        session
      );

      let status: DiscussionStatus = DiscussionStatus.ACTIVE;
      if (!result.success) {
        log.error(
          `Failed to establish session with contact ${contact.name}, got error: ${result.error}`
        );

        // if the error is due to the session manager failed to establish outgoing session, throw the error
        if (result.error && result.error.includes(EstablishSessionError))
          throw new Error(EstablishSessionError);

        status = DiscussionStatus.SEND_FAILED;
      } else {
        log.info(
          `session established with contact and announcement sent: ${result.announcement.length}... bytes`
        );
      }

      // update discussion status
      await this.db.discussions.update(discussion.id, {
        status: status,
        initiationAnnouncement: result.announcement,
        updatedAt: new Date(),
      });
      log.info(`discussion updated in db with status: ${status}`);

      return;
    } catch (error) {
      log.error(`Failed to accept pending discussion, error: ${error}`);
      throw new Error('Failed to accept pending discussion, error: ' + error);
    }
  }

  /**
   * Renew a discussion by resetting sent outgoing messages and sending a new announcement.
   * @param contactUserId - The user ID of the contact whose discussion should be renewed.
   * @param session - The SessionModule instance for the current owner user.
   */
  async renew(contactUserId: string, session: SessionModule): Promise<void> {
    const log = logger.forMethod('renew');
    const ownerUserId = session.userIdEncoded;

    const contact = await this.db.getContactByOwnerAndUserId(
      ownerUserId,
      contactUserId
    );
    if (!contact) throw new Error('Contact not found');

    const existingDiscussion = await this.db.getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    );

    if (!existingDiscussion)
      throw new Error('Discussion with contact ' + contact.name + ' not found');

    log.info(`renewing discussion between ${ownerUserId} and ${contactUserId}`);

    // reset session by creating and sending a new announcement
    const result = await this.announcementService.establishSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      session
    );

    // if the error is due to the session manager failed to establish outgoing session, throw the error
    if (result.error && result.error.includes(EstablishSessionError))
      throw new Error(EstablishSessionError);

    // get the new session status
    const sessionStatus = session.peerSessionStatus(
      decodeUserId(contactUserId)
    );
    log.info(
      `session status for discussion between ${ownerUserId} and ${contactUserId} after reinitiation is ${sessionStatusToString(sessionStatus)}`
    );

    const status: DiscussionStatus = !result.success
      ? DiscussionStatus.SEND_FAILED
      : sessionStatus === SessionStatus.Active
        ? DiscussionStatus.ACTIVE
        : DiscussionStatus.PENDING;

    await this.db.transaction(
      'rw',
      [this.db.discussions, this.db.messages],
      async () => {
        await this.db.discussions.update(existingDiscussion.id, {
          status: status,
          direction: DiscussionDirection.INITIATED,
          initiationAnnouncement: result.announcement,
          updatedAt: new Date(),
        });

        log.info(`discussion updated with status: ${status}`);

        /* Mark all outgoing messages that are not delivered or read as failed and remove the encryptedMessage */
        await this.db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .and(
            message =>
              message.direction === MessageDirection.OUTGOING &&
              message.status !== MessageStatus.DELIVERED &&
              message.status !== MessageStatus.READ
          )
          .modify({
            status: MessageStatus.FAILED,
            encryptedMessage: undefined,
            seeker: undefined,
          });
        log.info(
          `all outgoing messages that are not delivered or read have been marked as failed`
        );
      }
    );
  }

  /**
   * Check if new messages can be sent to session manager for encryption.
   * Returns false if the discussion is broken or if there are failed messages
   * that have not been encrypted.
   *
   * @param ownerUserId - The owner user ID
   * @param contactUserId - The contact user ID
   * @returns true if discussion is in stable state for sending messages
   */
  async isStableState(
    ownerUserId: string,
    contactUserId: string
  ): Promise<boolean> {
    const log = logger.forMethod('isStableState');
    const discussion: Discussion | undefined =
      await this.db.getDiscussionByOwnerAndContact(ownerUserId, contactUserId);

    if (!discussion) throw new Error('Discussion not found');

    if (discussion.status === DiscussionStatus.BROKEN) {
      log.info(
        `Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} is broken`
      );
      return false;
    }

    const messages = await this.db.messages
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
      log.info(
        `Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} has no encryptedMessage failed messages`
      );
      return false;
    }

    return true;
  }
}

/**
 * Standalone function to check if a discussion is in a stable state.
 * Used internally by MessageService.
 *
 * @param ownerUserId - The owner user ID
 * @param contactUserId - The contact user ID
 * @param db - Database instance
 * @returns true if discussion is in stable state for sending messages
 */
export async function isDiscussionStableState(
  ownerUserId: string,
  contactUserId: string,
  db: GossipDatabase
): Promise<boolean> {
  const log = logger.forMethod('isDiscussionStableState');
  const discussion: Discussion | undefined =
    await db.getDiscussionByOwnerAndContact(ownerUserId, contactUserId);

  if (!discussion) throw new Error('Discussion not found');

  if (discussion.status === DiscussionStatus.BROKEN) {
    log.info(
      `Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} is broken`
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

  if (
    messages.length > 0 &&
    !messages[messages.length - 1].encryptedMessage &&
    messages[messages.length - 1].status === MessageStatus.FAILED
  ) {
    log.info(
      `Discussion with ownerUserId ${ownerUserId} and contactUserId ${contactUserId} has no encryptedMessage failed messages`
    );
    return false;
  }

  return true;
}
