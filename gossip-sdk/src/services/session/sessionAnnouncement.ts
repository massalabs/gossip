/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import {
  MessageDirection,
  MessageStatus,
  MessageType,
  Session,
} from '../../db/index.js';
import { encodeUserId } from '../../utils/userId.js';
import { IMessageProtocol } from '../../api/messageProtocol/index.js';
import { SessionModule, sessionStatusToString } from '../../wasm/session.js';
import { Logger } from '../../utils/logs.js';
import { BulletinItem } from '../../api/messageProtocol/types.js';
import { SdkConfig, defaultSdkConfig } from '../../config/sdk.js';
import { decodeAnnouncementPayload } from '../../utils/announcementPayload.js';
import { SdkEventEmitter, SdkEventType } from '../../core/SdkEventEmitter.js';
import { Queries } from '../../db/queries/index.js';

const logger = new Logger('SessionAnnouncementService');

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
}

export const EstablishSessionError =
  'Session manager failed to establish outgoing session';

export class SessionAnnouncementService {
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private isProcessingAnnouncements = false;
  private eventEmitter: SdkEventEmitter;
  private config: SdkConfig;
  private queries: Queries;

  constructor(
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    eventEmitter: SdkEventEmitter,
    config: SdkConfig = defaultSdkConfig,
    queries: Queries
  ) {
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.eventEmitter = eventEmitter;
    this.config = config;
    this.queries = queries;
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

  async processOutgoingAnnouncements(sessions: Session[]): Promise<void> {
    const log = logger.forMethod('processOutgoingAnnouncements');
    const now = Date.now();

    for (const session of sessions) {
      if (!session.id) continue;

      // If there is no announcement to send, skip
      if (session.announcement_bytes === null || session.when_to_send === null)
        continue;

      // If the announcement is not yet time to send, skip
      if (session.when_to_send.getTime() > now) {
        log.debug('skipping announcement, not yet time to send', {
          sessionId: session.id,
          contactUserId: session.contactUserId,
          when_to_send: session.when_to_send.toISOString(),
          now: new Date().toISOString(),
        });
        continue;
      }

      // Send the announcement
      const result = await this.sendAnnouncement(session.announcement_bytes);

      // update session state after sending
      const latest = await this.queries.sessions.getById(session.id);
      if (!latest || latest.announcement_bytes === null) {
        continue;
      }
      if (result.success) {
        await this.queries.sessions.updateById(session.id, {
          announcement_bytes: null,
          when_to_send: null,
          updatedAt: new Date(),
        });
      } else {
        // If sending the announcement throught the network failed, retry later
        await this.queries.sessions.updateById(session.id, {
          announcement_bytes: session.announcement_bytes, // keep the encrypted announcement bytes for later retry
          when_to_send: new Date(
            Date.now() + this.config.announcements.retryDelayMs // retry later
          ),
          updatedAt: new Date(),
          /* If send announcement failed, There are chances that the session will be killed again the next state_update call.
          We don't want to wait a delay before reseting the session so we set killedNextRetryAt to null*/
          killedNextRetryAt: null,
        });
      }
    }
  }

  async fetchAndProcessAnnouncements(): Promise<AnnouncementReceptionResult> {
    const log = logger.forMethod('fetchAndProcessAnnouncements');

    // If this function is already running, skip
    if (this.isProcessingAnnouncements) {
      log.info('fetch already in progress, skipping');
      return { success: true, newAnnouncementsCount: 0 };
    }

    const errors: string[] = [];
    let announcements: Uint8Array[] = [];
    let fetchedCounters: string[] = [];

    this.isProcessingAnnouncements = true;
    try {
      /* First attempt to process pending announcements from DB if any. 
      These announcements were fetched by webservice and stored in the database when the app was not up, to be processed later when the app is back up.*/
      const pending = await this.queries.pendingAnnouncements.getAll();
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
          await this.queries.pendingAnnouncements.deleteByIds(
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

      /* No pending announcements un DB - fetch from API */
      const cursor = await this.queries.announcementCursors.get(
        this.session.userIdEncoded
      );

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
    await this.queries.announcementCursors.upsert(
      this.session.userIdEncoded,
      nextCounter
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // Consumer-facing aliases
  // ─────────────────────────────────────────────────────────────────

  /** Fetch and process announcements from the protocol (alias) */
  async fetch(): Promise<AnnouncementReceptionResult> {
    return this.fetchAndProcessAnnouncements();
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
    const newRequestContacts = await this.queries.contacts.getNamesByPrefix(
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
    contactUserId?: string;
    error?: string;
  }> {
    const log = logger.forMethod('_processIncomingAnnouncement');

    /* feed incoming announcement to session manager to decrypt and get the announcement result
     If the result is not null, it means the announcement is intended for us. 
     After this line, the announcement is stored in session manager:
      - If no outgoing announcement sent to this contact, a new peerRequested session is now setup
      - If we already have an outgoing announcement sent to this contact, the session is now active.
     If the result is null, it means the announcement is not intended for us. It's not an error*/
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

    let contact = await this.queries.contacts.getByOwnerAndUser(
      this.session.userIdEncoded,
      contactUserId
    );
    const isNewContact = !contact;

    if (isNewContact) {
      // Use extracted username if present, otherwise generate temporary name
      const name =
        username ||
        (await this._generateTemporaryContactName(this.session.userIdEncoded));

      await this.queries.contacts.insert({
        ownerUserId: this.session.userIdEncoded,
        userId: contactUserId,
        name,
        publicKeys: announcerPkeys.to_bytes(),
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      contact = await this.queries.contacts.getByOwnerAndUser(
        this.session.userIdEncoded,
        contactUserId
      );
      log.info('created new contact', { contactUserId, name });
    }

    if (!contact) {
      log.error('contact lookup failed after creation');
      throw new Error('Could not find or create contact');
    }

    const existingSession =
      await this.queries.sessions.getByContact(contactUserId);
    if (!existingSession) {
      const now = new Date();
      await this.queries.sessions.insert({
        contactUserId,
        announcement_bytes: null,
        when_to_send: null,
        createdAt: now,
        updatedAt: now,
      });
    } else {
      // reset pending outgoing messages to WAITING_SESSION for this contact
      // Only reset READY and SENT — DELIVERED messages should not be resent.
      await this.queries.messages.resetSendQueue(
        this.session.userIdEncoded,
        contactUserId
      );
    }

    this.eventEmitter.emit(
      SdkEventType.ANNOUNCEMENT_RECEIVED,
      contactUserId,
      contact.name,
      message
    );

    // Store announcement message as an incoming message if present
    if (message) {
      const timestamp = new Date(result.timestamp);
      const windowStart = new Date(timestamp.getTime() - 1000);
      const windowEnd = new Date(timestamp.getTime() + 1000);

      const existing = await this.queries.messages.getAnnouncementsByContact(
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
        await this.queries.messages.insert({
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

    return {
      success: true,
      contactUserId,
    };
  }
}
