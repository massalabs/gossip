/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import {
  type Discussion,
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
  serializeSendAnnouncement,
} from '../db';
import { toDiscussion } from '../utils/discussions';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { IMessageProtocol } from '../api/messageProtocol';
import { UserPublicKeys, SessionStatus } from '../wasm/bindings';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { BulletinItem } from '../api/messageProtocol/types';
import { SdkConfig, defaultSdkConfig } from '../config/sdk';
import { decodeAnnouncementPayload } from '../utils/announcementPayload';
import { Result } from '../utils/type';
import { SdkEventEmitter, SdkEventType } from '../core/SdkEventEmitter';
import type { RefreshService } from './refresh';
import {
  getContactByOwnerAndUser,
  insertContact,
  getContactNamesByPrefix,
  getDiscussionByOwnerAndContact,
  getDiscussionById,
  insertDiscussion,
  updateDiscussionById,
  insertMessage,
  getAnnouncementMessagesByContact,
  resetSendQueueMessages,
  getAllPendingAnnouncements,
  deletePendingAnnouncementsByIds,
  getAnnouncementCursor,
  upsertAnnouncementCursor,
} from '../queries';

const logger = new Logger('AnnouncementService');

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
}

export const EstablishSessionError =
  'Session manager failed to establish outgoing session';

export class AnnouncementService {
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private isProcessingAnnouncements = false;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private refreshService?: RefreshService;

  constructor(
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig
  ) {
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
  }

  setRefreshService(refreshService: RefreshService): void {
    this.refreshService = refreshService;
  }

  setMessageProtocol(messageProtocol: IMessageProtocol): void {
    this.messageProtocol = messageProtocol;
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<{
    success: boolean;
    counter?: string;
    error?: string;
  }> {
    const log = logger.forMethod('sendAnnouncement');

    try {
      const counter = await this.messageProtocol.sendAnnouncement(announcement);
      log.info('broadcast successful', { counter });
      return { success: true, counter };
    } catch (error) {
      log.error('broadcast failed', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async establishSession(
    contactPublicKeys: UserPublicKeys,
    payloadBytes?: Uint8Array
  ): Promise<Result<Uint8Array, Error>> {
    const log = logger.forMethod('establishSession');

    const contactUserId = encodeUserId(contactPublicKeys.derive_id());

    // CRITICAL: await to ensure session state is persisted before returning
    const announcement = await this.session.establishOutgoingSession(
      contactPublicKeys,
      payloadBytes
    );

    if (announcement.length === 0) {
      log.error('empty announcement returned', { contactUserId });
      return {
        success: false,
        error: new Error(EstablishSessionError),
      };
    }

    log.info('announcement prepared for outgoing session', {
      contactUserId,
      bytes: announcement.length,
    });
    return { success: true, data: announcement };
  }

  async processOutgoingAnnouncements(discussions: Discussion[]): Promise<void> {
    const log = logger.forMethod('processOutgoingAnnouncements');
    const now = Date.now();

    for (const discussion of discussions) {
      if (!discussion.id) continue;

      // sendAnnouncement is deserialized by toDiscussion() before reaching here
      if (discussion.sendAnnouncement === null) continue;

      const { announcement_bytes, when_to_send } = discussion.sendAnnouncement;
      if (announcement_bytes.length === 0) {
        log.warn('skipping empty announcement bytes', {
          discussionId: discussion.id,
          contactUserId: discussion.contactUserId,
        });
        await updateDiscussionById(discussion.id, {
          sendAnnouncement: null,
          updatedAt: new Date(),
        });
        continue;
      }

      if (when_to_send.getTime() > now) {
        log.debug('skipping announcement, not yet time to send', {
          discussionId: discussion.id,
          contactUserId: discussion.contactUserId,
          when_to_send: when_to_send.toISOString(),
          now: new Date().toISOString(),
        });
        continue;
      }

      // Send the announcement and handle updates after transaction
      const result = await this.sendAnnouncement(announcement_bytes);

      // update discussion state after sending
      const latest = await getDiscussionById(discussion.id);
      if (!latest || latest.sendAnnouncement === null) {
        continue;
      }
      if (result.success) {
        await updateDiscussionById(discussion.id, {
          sendAnnouncement: null,
          updatedAt: new Date(),
        });
      } else {
        await updateDiscussionById(discussion.id, {
          sendAnnouncement: serializeSendAnnouncement({
            announcement_bytes,
            when_to_send: new Date(
              Date.now() + this.config.announcements.retryDelayMs
            ),
          }),
          updatedAt: new Date(),
        });
      }
    }
  }

  async fetchAndProcessAnnouncements(): Promise<AnnouncementReceptionResult> {
    const log = logger.forMethod('fetchAndProcessAnnouncements');

    if (this.isProcessingAnnouncements) {
      log.info('fetch already in progress, skipping');
      return { success: true, newAnnouncementsCount: 0 };
    }

    const errors: string[] = [];
    let announcements: Uint8Array[] = [];
    let fetchedCounters: string[] = [];

    this.isProcessingAnnouncements = true;
    try {
      const pending = await getAllPendingAnnouncements();
      const successfullyProcessedPendingIds: number[] = [];

      if (pending.length > 0) {
        log.info(
          `processing ${pending.length} pending announcements from SQLite`
        );

        // Process pending announcements one by one, tracking successes
        let newAnnouncementsCount = 0;
        for (const item of pending) {
          try {
            const result = await this._processIncomingAnnouncement(
              item.announcement
            );

            // Mark as successfully processed (even if announcement was for unknown peer)
            // Only keep if processing threw an error
            if (item.id !== undefined) {
              successfullyProcessedPendingIds.push(item.id);
            }

            if (result.success && result.contactUserId) {
              newAnnouncementsCount++;
              log.info(
                `processed pending announcement #${newAnnouncementsCount}`,
                {
                  contactUserId: result.contactUserId,
                }
              );
            }
            if (item.counter) fetchedCounters.push(item.counter);
            if (result.error) errors.push(result.error);
          } catch (error) {
            // Don't mark as processed - will be retried next time
            log.error('failed to process pending announcement, will retry', {
              id: item.id,
              error,
            });
            errors.push(
              error instanceof Error ? error.message : 'Unknown error'
            );
          }
        }

        // Delete only successfully processed pending announcements
        if (successfullyProcessedPendingIds.length > 0) {
          await deletePendingAnnouncementsByIds(
            successfullyProcessedPendingIds
          );
          log.info(
            `deleted ${successfullyProcessedPendingIds.length} processed pending announcements`
          );
        }

        if (fetchedCounters.length > 0) {
          const highestCounter = fetchedCounters.reduce((a, b) =>
            Number(a) > Number(b) ? a : b
          );
          await this._upsertLastBulletinCounter(highestCounter);
          log.info('updated lastBulletinCounter', { highestCounter });
        }

        return {
          success: errors.length === 0 || newAnnouncementsCount > 0,
          newAnnouncementsCount,
          error: errors.length > 0 ? errors.join(', ') : undefined,
        };
      }

      // No pending - fetch from API
      const cursor = await getAnnouncementCursor(this.session.userIdEncoded);

      // fetch from node all announcements since the last retrieved announcement
      const fetched = await this._fetchAnnouncements(cursor);
      announcements = fetched.map(a => a.data);
      fetchedCounters = fetched.map(a => a.counter);

      let newAnnouncementsCount = 0;

      for (const announcement of announcements) {
        try {
          const result = await this._processIncomingAnnouncement(announcement);

          if (result.success && result.contactUserId) {
            newAnnouncementsCount++;
            log.info(`processed new announcement #${newAnnouncementsCount}`, {
              contactUserId: result.contactUserId,
            });
          }

          if (result.error) errors.push(result.error);
        } catch (error) {
          errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
      }

      if (fetchedCounters.length > 0) {
        const highestCounter = fetchedCounters.reduce((a, b) =>
          Number(a) > Number(b) ? a : b
        );
        const cursorNum = cursor !== undefined ? Number(cursor) : 0;
        const highestNum = Number(highestCounter);
        // If API returned a batch with max <= cursor (same or older page), advance past it
        // so we don't re-fetch the same page forever (e.g. API returning "latest" regardless of after)
        const nextCounter =
          highestNum <= cursorNum ? String(cursorNum + 1) : highestCounter;
        await this._upsertLastBulletinCounter(nextCounter);
        log.info('updated lastBulletinCounter', {
          lastBulletinCounter: nextCounter,
        });
      }

      return {
        success: errors.length === 0 || newAnnouncementsCount > 0,
        newAnnouncementsCount,
        error: errors.length > 0 ? errors.join(', ') : undefined,
      };
    } catch (error) {
      log.error('unexpected error during fetch/process', error);
      return {
        success: false,
        newAnnouncementsCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      this.isProcessingAnnouncements = false;
    }
  }

  /**
   * Persist the bulletin polling cursor for the current user.
   * Stored in a dedicated announcementCursors table (not userProfile).
   */
  private async _upsertLastBulletinCounter(nextCounter: string): Promise<void> {
    await upsertAnnouncementCursor(this.session.userIdEncoded, nextCounter);
  }

  /**
   * Fetch the latest bulletin counter from the API and persist it so that
   * historical announcements (undecryptable by a new account) are skipped.
   * No-op if a counter already exists.
   */
  async skipHistoricalAnnouncements(): Promise<void> {
    const log = logger.forMethod('skipHistoricalAnnouncements');
    const existing = await getAnnouncementCursor(this.session.userIdEncoded);
    if (existing !== undefined) return;

    try {
      const counter = await this.messageProtocol.fetchBulletinCounter();
      await this._upsertLastBulletinCounter(counter);
      log.info('set initial bulletin counter for new account', { counter });
    } catch (err) {
      // Non-critical — on failure the first fetch starts from the beginning.
      log.warn('failed to initialize bulletin counter', { err });
    }
  }

  private async _fetchAnnouncements(
    cursor?: string,
    limit?: number
  ): Promise<BulletinItem[]> {
    const fetchLimit = limit ?? this.config.announcements.fetchLimit;
    const log = logger.forMethod('_fetchAnnouncements');

    try {
      const items = await this.messageProtocol.fetchAnnouncements(
        fetchLimit,
        cursor
      );
      return items;
    } catch (error) {
      log.error('network fetch failed', error);
      return [];
    }
  }

  private async _generateTemporaryContactName(
    ownerUserId: string
  ): Promise<string> {
    const newRequestContacts = await getContactNamesByPrefix(
      ownerUserId,
      'New Request'
    );

    const numbers = newRequestContacts
      .map(contact => {
        const match = contact.name.match(/^New Request (\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(number => number > 0);

    const next = numbers.length ? Math.max(...numbers) + 1 : 1;
    return `New Request ${next}`;
  }

  private async _processIncomingAnnouncement(
    announcementData: Uint8Array
  ): Promise<{
    success: boolean;
    discussionId?: number;
    contactUserId?: string;
    error?: string;
  }> {
    const log = logger.forMethod('_processIncomingAnnouncement');

    // feed incoming announcement to session manager to decrypt and get the announcement result (we are the recipient of the announcement)
    const result =
      await this.session.feedIncomingAnnouncement(announcementData);

    // if the result is null, it means the announcement is not intended for us. It's not an error
    if (!result) {
      return { success: true };
    }

    log.info('announcement intended for us — decrypting');

    const { username, message } = decodeAnnouncementPayload(result.user_data);

    const announcerPkeys = result.announcer_public_keys;
    const contactUserIdRaw = announcerPkeys.derive_id();
    const contactUserId = encodeUserId(contactUserIdRaw);

    const sessionStatus = this.session.peerSessionStatus(contactUserIdRaw);
    log.info('announcement received', {
      contactUserId,
      status: sessionStatusToString(sessionStatus),
    });

    let contact = await getContactByOwnerAndUser(
      this.session.userIdEncoded,
      contactUserId
    );
    const isNewContact = !contact;

    if (isNewContact) {
      // Use extracted username if present, otherwise generate temporary name
      const name =
        username ||
        (await this._generateTemporaryContactName(this.session.userIdEncoded));

      await insertContact({
        ownerUserId: this.session.userIdEncoded,
        userId: contactUserId,
        name,
        publicKeys: announcerPkeys.to_bytes(),
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      contact = await getContactByOwnerAndUser(
        this.session.userIdEncoded,
        contactUserId
      );
      log.info('created new contact', { contactUserId, name });
    }

    if (!contact) {
      log.error('contact lookup failed after creation');
      throw new Error('Could not find or create contact');
    }

    const { discussionId } = await this._handleReceivedDiscussion(
      this.session.userIdEncoded,
      contactUserId,
      message
    );

    // Store announcement message as an incoming message if present
    if (message) {
      const timestamp = new Date(result.timestamp);
      const windowStart = new Date(timestamp.getTime() - 1000);
      const windowEnd = new Date(timestamp.getTime() + 1000);

      const existing = await getAnnouncementMessagesByContact(
        this.session.userIdEncoded,
        contactUserId
      );

      // Filter in JS for content match and timestamp window (SQLite timestamp_ms comparison)
      const duplicate = existing.find(
        msg =>
          msg.content === message &&
          msg.timestamp >= windowStart &&
          msg.timestamp <= windowEnd
      );

      if (!duplicate) {
        await insertMessage({
          ownerUserId: this.session.userIdEncoded,
          contactUserId,
          content: message,
          type: MessageType.ANNOUNCEMENT,
          direction: MessageDirection.INCOMING,
          status: MessageStatus.READ,
          timestamp,
        });
      }
    }

    await this.refreshService?.stateUpdate();

    return {
      success: true,
      discussionId,
      contactUserId,
    };
  }

  private async _handleReceivedDiscussion(
    ownerUserId: string,
    contactUserId: string,
    message?: string
  ): Promise<{ discussionId: number }> {
    const log = logger.forMethod('handleReceivedDiscussion');

    const existing = await getDiscussionByOwnerAndContact(
      ownerUserId,
      contactUserId
    );

    if (existing) {
      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (message) updateData.announcementMessage = message;

      log.info('updating existing discussion', {
        discussionId: existing.id,
        contactUserId,
      });

      await updateDiscussionById(existing.id, updateData);

      // reset pending outgoing messages to WAITING_SESSION for this contact
      // Only reset READY and SENT — DELIVERED messages should not be resent.
      await resetSendQueueMessages(this.session.userIdEncoded, contactUserId, [
        MessageStatus.READY,
        MessageStatus.SENT,
      ]);

      const newDiscussion = await getDiscussionById(existing.id);
      const contactRow = await getContactByOwnerAndUser(
        ownerUserId,
        contactUserId
      );
      if (
        newDiscussion &&
        contactRow &&
        this.session.peerSessionStatus(decodeUserId(contactUserId)) ===
          SessionStatus.PeerRequested
      ) {
        this.eventEmitter.emit(
          SdkEventType.SESSION_REQUESTED,
          toDiscussion(newDiscussion),
          contactRow
        );
      }
      return { discussionId: existing.id };
    }

    log.info('creating new discussion', { contactUserId });
    const discussionId = await insertDiscussion({
      ownerUserId,
      contactUserId,
      direction: DiscussionDirection.RECEIVED,
      status: DiscussionStatus.PENDING,
      announcementMessage: message,
      unreadCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const discussion = await getDiscussionById(discussionId);
    const contactRow = await getContactByOwnerAndUser(
      ownerUserId,
      contactUserId
    );
    if (discussion && contactRow) {
      this.eventEmitter.emit(
        SdkEventType.SESSION_REQUESTED,
        toDiscussion(discussion),
        contactRow
      );
    }

    return { discussionId };
  }
}
