/**
 * Discussion Service
 *
 * Class-based service for initializing, accepting, and managing discussions.
 */

import {
  type Discussion,
  type Contact,
  type GossipDatabase,
  DiscussionDirection,
  MessageDirection,
  MessageStatus,
  MessageType,
} from '../db';
import { UserPublicKeys, SessionStatus } from '../wasm/bindings';
import { AnnouncementService, EstablishSessionError } from './announcement';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { decodeUserId } from '../utils/userId';
import {
  AnnouncementPayload,
  encodeAnnouncementPayload,
} from '../utils/announcementPayload';
import { Logger } from '../utils/logs';
import { RefreshService } from './refresh';
import { Result } from '../utils/type';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';

const logger = new Logger('DiscussionService');

export interface discussionInitializationResult {
  discussionId: number;
  announcement: Uint8Array;
}

/**
 * Service for managing discussions between users.
 *
 * @example
 * ```typescript
 * const discussionService = new DiscussionService(db, announcementService, session, refreshService);
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
  private eventEmitter: SdkEventEmitter;
  private refreshService?: RefreshService;

  constructor(
    db: GossipDatabase,
    announcementService: AnnouncementService,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    refreshService?: RefreshService
  ) {
    this.db = db;
    this.announcementService = announcementService;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.refreshService = refreshService;
  }

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
  }

  /**
   * Initialize a discussion with a contact using SessionManager
   * @param contact - The contact to start a discussion with
   * @param payload - Optional payload to include in the announcement (username and message)
   * @returns The discussion ID and the created announcement
   *
   * @example
   * ```ts
   * const payload: AnnouncementPayload = {
   *   username: 'alice',
   *   message: 'Hello!',
   * };
   *
   * const { discussionId, announcement } =
   *   await discussionService.initialize(contact, payload);
   * ```
   */
  async initialize(
    contact: Contact,
    payload?: AnnouncementPayload
  ): Promise<Result<discussionInitializationResult, Error>>  {
    const log = logger.forMethod('initialize');

    try {
      const userId = this.session.userIdEncoded;

      const existing = await this.db.getDiscussionByOwnerAndContact(
        userId,
        contact.userId
      );

      if (existing?.id) {
        return {
          success: false,
          error: new Error('Discussion already exists'),
        };
      }

      log.info(
        `${userId} is establishing session with contact ${contact.name}`
      );
      const discussionId = await this.db.discussions.add({
        ownerUserId: userId,
        contactUserId: contact.userId,
        weAccepted: true,
        sendAnnouncement: null,
        lastAnnouncementMessage: payload?.message,
        direction: DiscussionDirection.INITIATED,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      log.info(`discussion created with id: ${discussionId}`);

      let payloadBytes: Uint8Array | undefined;
      if (payload) {
        payloadBytes = encodeAnnouncementPayload(
          payload.username,
          payload.message
        );
      }

      const result = await this.createSessionForContact(
        contact.userId,
        payloadBytes ?? new Uint8Array(0)
      );

      if (!result.success) {
        await this.db.discussions.delete(discussionId);
        return { success: false, error: result.error };
      }

      if (payload?.message) {
        await this.db.addMessage({
          ownerUserId: userId,
          contactUserId: contact.userId,
          content: payload.message,
          type: MessageType.ANNOUNCEMENT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.SENT,
          timestamp: new Date(),
        });
      }

      // Emit status change event
      const discussion = await this.db.discussions.get(discussionId);
      if (discussion) {
        this.eventEmitter.emit(SdkEventType.SESSION_CREATED, discussion);
      }

      return {
        success: true,
        data: { discussionId, announcement: result.data },
      };
    } catch (error) {
      return {
        success: false,
        error: new Error('Discussion initialization failed, error: ' + error),
      };
    }
  }

  /**
   * Accept a discussion request from a contact using SessionManager
   * @param discussion - The discussion to accept
   */
  async accept(discussion: Discussion): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('accept');
    try {
      if (!discussion.id) {
        return { success: false, error: new Error('Discussion ID is missing') };
      }

      const result = await this.createSessionForContact(
        discussion.contactUserId,
        new Uint8Array(0)
      );

      if (result.success) {
        log.info(
          `Discussion with contact ${discussion.contactUserId} accepted`,
          {
            contactUserId: discussion.contactUserId,
            bytes: result.data?.length ?? 0,
          }
        );

        // Emit status change event
        const updatedDiscussion = await this.db.discussions.get(discussion.id!);
        if (updatedDiscussion) {
          this.eventEmitter.emit(
            SdkEventType.SESSION_ACCEPTED,
            updatedDiscussion.contactUserId
          );
        }
      }

      return result;
    } catch (error) {
      log.error(`Failed to accept pending discussion, error: ${error}`);
      return {
        success: false,
        error: new Error(
          'Failed to accept pending discussion, error: ' + error
        ),
      };
    }
  }

  /**
   * Create or recreate an outgoing encrypted session with a peer and queue the new announcement to be sent to the contact.
   * Updates the discussion with the new announcement and resets the outgoing message send queue.
   * Warining : This function can only be called on a peer with whom we have a discussion.
   * @param contactUserId - Encoded user ID of the contact to create the session for
   * @param userData - Optional extra data to include in the announcement (usually empty)
   * @returns A Result containing the announcement bytes if successful, or an Error if failed
   */

  async createSessionForContact(
    contactUserId: string,
    userData: Uint8Array
  ): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('createSessionForContact');
    const ownerUserId = this.session.userIdEncoded;

    const discussion = await this.db.getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    if (!discussion) {
      return { success: false, error: new Error('Discussion not found') };
    }

    const contact = await this.db.getContactByOwnerAndUserId(
      ownerUserId,
      contactUserId
    );
    if (!contact) {
      return { success: false, error: new Error('Contact not found') };
    }

    // Establish a new outgoing encrypted session with the peer
    const sessionResult = await this.announcementService.establishSession(
      UserPublicKeys.from_bytes(contact.publicKeys),
      userData
    );

    if (!sessionResult.success) {
      log.error('failed to establish outgoing session', {
        contactUserId,
        error: sessionResult.error,
      });
      return sessionResult;
    }

    const now = new Date();

    // Wrap discussion update and queue reset in a transaction for atomicity
    const err = await this.db.transaction(
      'rw',
      this.db.discussions,
      this.db.messages,
      async () => {
        try {
          // add the new announcement to the discussion
          await this.db.discussions.update(discussion.id!, {
            weAccepted: true,
            sendAnnouncement: {
              announcement_bytes: sessionResult.data,
              when_to_send: now,
            },
            updatedAt: now,
          });

          // reset all messages in send queue to WAITING_SESSION for this contact
          await resetSendQueue(this.db, ownerUserId, contactUserId);
          return undefined;
        } catch (error) {
          return new Error('Failed to update discussion: ' + error);
        }
      }
    );

    if (!err) {
      try {
        /* trigger a state update to send the new announcement
        If the stateUpdate function is already running, it will be skipped.
        */
        await this.refreshService?.stateUpdate();
      } catch (error) {
        return {
          success: false,
          error: new Error('Failed to trigger state update: ' + error),
        };
      }
    } else {
      return { success: false, error: err };
    }

    return { success: true, data: sessionResult.data };
  }
}

/**
 * Reset the send queue for a contact.
 * All messages that are not yet delivered (i.e. READY, SENDING, SENT) are reset to WAITING_SESSION.
 * @param db - The database instance
 * @param ownerUserId - The user ID of the owner
 * @param contactUserId - The user ID of the contact
 * @returns A Promise that resolves when the send queue is reset
 */
export async function resetSendQueue(
  db: GossipDatabase,
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  await db.messages
    .where('[ownerUserId+contactUserId]')
    .equals([ownerUserId, contactUserId])
    .and(
      message =>
        message.direction === MessageDirection.OUTGOING &&
        [MessageStatus.READY, MessageStatus.SENT].includes(message.status)
    )
    .modify({
      status: MessageStatus.WAITING_SESSION,
      encryptedMessage: undefined,
      seeker: undefined,
      whenToSend: undefined,
    });
}
