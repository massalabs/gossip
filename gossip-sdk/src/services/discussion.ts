/**
 * Discussion Service
 *
 * Class-based service for initializing, accepting, and managing discussions.
 */

import {
  type Discussion,
  type Contact,
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  serializeSendAnnouncement,
} from '../db';
import { toDiscussion } from '../utils/discussions';
import {
  AnnouncementPayload,
  encodeAnnouncementPayload,
} from '../utils/announcementPayload';
import { UserPublicKeys } from '../wasm/bindings';
import { AnnouncementService } from './announcement';
import { SessionModule } from '../wasm/session';
import { Logger } from '../utils/logs';
import { RefreshService } from './refresh';
import { Result } from '../utils/type';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';
import {
  getContactByOwnerAndUser,
  getDiscussionByOwnerAndContact,
  getDiscussionById,
  insertDiscussion,
  updateDiscussionById,
  deleteDiscussionById,
  insertMessage,
  resetSendQueueMessages,
} from '../queries';

const logger = new Logger('DiscussionService');

export interface DiscussionInitializationResult {
  discussionId: number;
  announcement: Uint8Array;
}

/**
 * Service for managing discussions between users.
 *
 * @example
 * ```typescript
 * const discussionService = new DiscussionService(announcementService, session, eventEmitter, refreshService);
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
  private announcementService: AnnouncementService;
  private session: SessionModule;
  private eventEmitter: SdkEventEmitter;
  private refreshService?: RefreshService;

  constructor(
    announcementService: AnnouncementService,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    refreshService?: RefreshService
  ) {
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
  ): Promise<Result<DiscussionInitializationResult, Error>> {
    const log = logger.forMethod('initialize');

    try {
      const userId = this.session.userIdEncoded;

      const existing = await getDiscussionByOwnerAndContact(
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
      const discussionId = await insertDiscussion({
        ownerUserId: userId,
        contactUserId: contact.userId,
        weAccepted: true,
        direction: DiscussionDirection.INITIATED,
        status: DiscussionStatus.PENDING,
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
        await deleteDiscussionById(discussionId);
        return { success: false, error: result.error };
      }

      if (payload?.message) {
        await insertMessage({
          ownerUserId: userId,
          contactUserId: contact.userId,
          content: payload.message,
          type: MessageType.ANNOUNCEMENT,
          direction: MessageDirection.OUTGOING,
          status: MessageStatus.READ, // Announcement message are not like other msg. they are set as read to prevent them from being sent again if session is renewed
          timestamp: new Date(),
        });
        // Store the announcement message on the discussion so the UI can display it
        await updateDiscussionById(discussionId, {
          announcementMessage: payload.message,
        });
      }

      // Emit status change event
      const discussion = await getDiscussionById(discussionId);
      if (discussion) {
        this.eventEmitter.emit(
          SdkEventType.SESSION_CREATED,
          toDiscussion(discussion)
        );
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
        const updatedDiscussion = await getDiscussionById(discussion.id!);
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

    const discussion = await getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    );
    if (!discussion) {
      return { success: false, error: new Error('Discussion not found') };
    }

    const contact = await getContactByOwnerAndUser(ownerUserId, contactUserId);
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

    try {
      // add the new announcement to the discussion
      await updateDiscussionById(discussion.id!, {
        weAccepted: true,
        sendAnnouncement: serializeSendAnnouncement({
          announcement_bytes: sessionResult.data,
          when_to_send: now,
        }),
        initiationAnnouncement: sessionResult.data,
        updatedAt: now,
      });

      // reset all messages in send queue to WAITING_SESSION for this contact
      await resetSendQueueMessages(ownerUserId, contactUserId, [
        MessageStatus.READY,
        MessageStatus.SENT,
      ]);
    } catch (error) {
      return {
        success: false,
        error: new Error('Failed to update discussion: ' + error),
      };
    }

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

    return { success: true, data: sessionResult.data };
  }
}
