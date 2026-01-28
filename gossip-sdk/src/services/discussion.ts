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
import { UserPublicKeys, SessionStatus } from '#wasm';
import { AnnouncementService, EstablishSessionError } from './announcement';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { decodeUserId } from '../utils/userId';
import { Logger } from '../utils/logs';
import { GossipSdkEvents } from '../types/events';

const logger = new Logger('DiscussionService');

/**
 * Service for managing discussions between users.
 *
 * @example
 * ```typescript
 * const discussionService = new DiscussionService(db, announcementService, session);
 *
 * // Initialize a new discussion
 * const result = await discussionService.initialize(contact, 'Hello!');
 *
 * // Accept a discussion request
 * await discussionService.accept(discussion);
 *
 * // Renew a broken discussion
 * await discussionService.renew(contactUserId);
 * ```
 */
export class DiscussionService {
  private db: GossipDatabase;
  private announcementService: AnnouncementService;
  private session: SessionModule;
  private events: GossipSdkEvents;

  constructor(
    db: GossipDatabase,
    announcementService: AnnouncementService,
    session: SessionModule,
    events: GossipSdkEvents = {}
  ) {
    this.db = db;
    this.announcementService = announcementService;
    this.session = session;
    this.events = events;
  }

  /**
   * Initialize a discussion with a contact using SessionManager
   * @param contact - The contact to start a discussion with
   * @param message - Optional message to include in the announcement
   * @returns The discussion ID and the created announcement
   */
  async initialize(
    contact: Contact,
    message?: string
  ): Promise<{
    discussionId: number;
    announcement: Uint8Array;
  }> {
    const log = logger.forMethod('initialize');
    try {
      const userId = this.session.userIdEncoded;
      // Encode message as UTF-8 if provided
      const userData = message
        ? new TextEncoder().encode(message)
        : new Uint8Array(0);

      log.info(
        `${userId} is establishing session with contact ${contact.name}`
      );
      const result = await this.announcementService.establishSession(
        UserPublicKeys.from_bytes(contact.publicKeys),
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

      // Parse announcement message to extract only the actual message content.
      // The message parameter may be JSON format: {"u":"username","m":"message"}
      // We only want to store the "m" (message) field, not the full JSON.
      let parsedAnnouncementMessage: string | undefined;
      if (message) {
        if (message.startsWith('{')) {
          try {
            const parsed = JSON.parse(message) as { u?: string; m?: string };
            parsedAnnouncementMessage = parsed.m?.trim() || undefined;
          } catch {
            // Invalid JSON, treat as plain text
            parsedAnnouncementMessage = message;
          }
        } else {
          parsedAnnouncementMessage = message;
        }
      }

      // Persist discussion immediately with the announcement for reliable retry
      const discussionId = await this.db.discussions.add({
        ownerUserId: userId,
        contactUserId: contact.userId,
        direction: DiscussionDirection.INITIATED,
        status: status,
        nextSeeker: undefined,
        initiationAnnouncement: result.announcement,
        announcementMessage: parsedAnnouncementMessage,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      log.info(`discussion created with id: ${discussionId}`);

      // Emit status change event
      const discussion = await this.db.discussions.get(discussionId);
      if (discussion) {
        this.events.onDiscussionStatusChanged?.(discussion);
      }

      return { discussionId, announcement: result.announcement };
    } catch (error) {
      log.error(`Failed to initialize discussion, error: ${error}`);
      throw new Error('Discussion initialization failed, error: ' + error);
    }
  }

  /**
   * Accept a discussion request from a contact using SessionManager
   * @param discussion - The discussion to accept
   */
  async accept(discussion: Discussion): Promise<void> {
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
        UserPublicKeys.from_bytes(contact.publicKeys)
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

      // Emit status change event
      const updatedDiscussion = await this.db.discussions.get(discussion.id!);
      if (updatedDiscussion) {
        this.events.onDiscussionStatusChanged?.(updatedDiscussion);
      }

      return;
    } catch (error) {
      log.error(`Failed to accept pending discussion, error: ${error}`);
      throw new Error('Failed to accept pending discussion, error: ' + error);
    }
  }

  /**
   * Renew a discussion by resetting sent outgoing messages and sending a new announcement.
   * @param contactUserId - The user ID of the contact whose discussion should be renewed.
   */
  async renew(contactUserId: string): Promise<void> {
    const log = logger.forMethod('renew');
    const ownerUserId = this.session.userIdEncoded;

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
      UserPublicKeys.from_bytes(contact.publicKeys)
    );

    // if the error is due to the session manager failed to establish outgoing session, throw the error
    if (result.error && result.error.includes(EstablishSessionError))
      throw new Error(EstablishSessionError);

    // get the new session status
    const sessionStatus = this.session.peerSessionStatus(
      decodeUserId(contactUserId)
    );
    log.info(
      `session status for discussion between ${ownerUserId} and ${contactUserId} after reinitiation is ${sessionStatusToString(sessionStatus)}`
    );

    // Determine discussion status based on send result and session state:
    // - SEND_FAILED: announcement couldn't be sent
    // - ACTIVE: session fully established (peer responded)
    // - RECONNECTING: true renewal, waiting for peer's response
    // - PENDING: first contact retry, waiting for peer's response
    let status: DiscussionStatus;
    if (!result.success) {
      status = DiscussionStatus.SEND_FAILED;
    } else if (sessionStatus === SessionStatus.Active) {
      // Session fully established (peer already responded)
      status = DiscussionStatus.ACTIVE;
    } else if (existingDiscussion.status === DiscussionStatus.ACTIVE) {
      // True renewal: had working session before, now recovering
      status = DiscussionStatus.RECONNECTING;
    } else {
      // First contact retry: never had working session
      status = DiscussionStatus.PENDING;
    }

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

        /* Reset outgoing messages that haven't been acknowledged by the peer.
         * When session is renewed, messages encrypted with the old session
         * may not be decryptable by the peer with the new session.
         *
         * Messages to reset (not acknowledged):
         * - SENDING: Was in progress, needs re-encryption with new session
         * - FAILED: Previous send failed, needs re-encryption
         * - SENT: On network but not acknowledged - peer may not have received
         *
         * Messages to keep (acknowledged by peer):
         * - DELIVERED: Peer confirmed receipt
         * - READ: Peer read it
         */
        const messagesToReset = await this.db.messages
          .where('[ownerUserId+contactUserId]')
          .equals([ownerUserId, contactUserId])
          .and(
            message =>
              message.direction === MessageDirection.OUTGOING &&
              (message.status === MessageStatus.SENDING ||
                message.status === MessageStatus.FAILED ||
                message.status === MessageStatus.SENT)
          )
          .modify({
            status: MessageStatus.WAITING_SESSION,
            encryptedMessage: undefined,
            seeker: undefined,
          });
        log.info(`reset ${messagesToReset} messages to WAITING_SESSION`);
      }
    );

    // Emit events after transaction completes
    const updatedDiscussion = await this.db.discussions.get(
      existingDiscussion.id!
    );
    if (updatedDiscussion) {
      this.events.onDiscussionStatusChanged?.(updatedDiscussion);
      this.events.onSessionRenewed?.(updatedDiscussion);
    }
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
