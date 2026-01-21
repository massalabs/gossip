/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import {
  type Discussion,
  type GossipDatabase,
  DiscussionStatus,
  DiscussionDirection,
} from '../db';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { IMessageProtocol } from '../api/messageProtocol';
import {
  UserPublicKeys,
  SessionStatus,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { Logger } from '../utils/logs';
import { BulletinItem } from '../api/messageProtocol/types';
import { GossipSdkEvents } from '../types/events';
import { SdkConfig, defaultSdkConfig } from '../config/sdk';

const logger = new Logger('AnnouncementService');

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
}

export const EstablishSessionError =
  'Session manager failed to establish outgoing session';

export class AnnouncementService {
  private db: GossipDatabase;
  private messageProtocol: IMessageProtocol;
  private session: SessionModule;
  private isProcessingAnnouncements = false;
  private events: GossipSdkEvents;
  private config: SdkConfig;

  constructor(
    db: GossipDatabase,
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    events: GossipSdkEvents = {},
    config: SdkConfig = defaultSdkConfig
  ) {
    this.db = db;
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.events = events;
    this.config = config;
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
    userData?: Uint8Array
  ): Promise<{
    success: boolean;
    error?: string;
    announcement: Uint8Array;
  }> {
    const log = logger.forMethod('establishSession');

    const contactUserId = encodeUserId(contactPublicKeys.derive_id());

    // CRITICAL: await to ensure session state is persisted before sending
    const announcement = await this.session.establishOutgoingSession(
      contactPublicKeys,
      userData
    );

    if (announcement.length === 0) {
      log.error('empty announcement returned', { contactUserId });
      return {
        success: false,
        error: EstablishSessionError,
        announcement,
      };
    }

    const result = await this.sendAnnouncement(announcement);
    if (!result.success) {
      log.error('failed to broadcast announcement', {
        contactUserId,
        error: result.error,
      });
      return {
        success: false,
        error: result.error,
        announcement,
      };
    }

    log.info('announcement sent successfully', { contactUserId });
    return { success: true, announcement };
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
      const pending = await this.db.pendingAnnouncements.toArray();
      const successfullyProcessedPendingIds: number[] = [];

      if (pending.length > 0) {
        log.info(
          `processing ${pending.length} pending announcements from IndexedDB`
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
          await this.db.pendingAnnouncements.bulkDelete(
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
          await this.db.userProfile.update(this.session.userIdEncoded, {
            lastBulletinCounter: highestCounter,
          });
          log.info('updated lastBulletinCounter', { highestCounter });
        }

        return {
          success: errors.length === 0 || newAnnouncementsCount > 0,
          newAnnouncementsCount,
          error: errors.length > 0 ? errors.join(', ') : undefined,
        };
      }

      // No pending - fetch from API
      const cursor = (await this.db.userProfile.get(this.session.userIdEncoded))
        ?.lastBulletinCounter;

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
        await this.db.userProfile.update(this.session.userIdEncoded, {
          lastBulletinCounter: highestCounter,
        });
        log.info('updated lastBulletinCounter', { highestCounter });
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

  async resendAnnouncements(failedDiscussions: Discussion[]): Promise<void> {
    const log = logger.forMethod('resendAnnouncements');

    if (!failedDiscussions.length) {
      log.info('no failed discussions to resend');
      return;
    }

    log.info(
      `starting resend for ${failedDiscussions.length} failed discussions`
    );

    const sentDiscussions: Discussion[] = [];
    const brokenDiscussions: number[] = [];

    for (const discussion of failedDiscussions) {
      const { ownerUserId, contactUserId } = discussion;

      try {
        const result = await this.sendAnnouncement(
          discussion.initiationAnnouncement!
        );

        if (result.success) {
          log.info('resent successfully', { ownerUserId, contactUserId });
          sentDiscussions.push(discussion);
          continue;
        }

        log.info('network send failed (retry)', { ownerUserId, contactUserId });

        const ageMs = Date.now() - (discussion.updatedAt.getTime() ?? 0);
        if (ageMs > this.config.announcements.brokenThresholdMs) {
          log.info(
            `marking as broken (too old: ${Math.round(ageMs / 60000)}min)`,
            {
              ownerUserId,
              contactUserId,
            }
          );
          brokenDiscussions.push(discussion.id!);
        }
      } catch (error) {
        log.error('exception during resend', {
          error: error instanceof Error ? error.message : 'Unknown error',
          ownerUserId,
          contactUserId,
        });
      }
    }

    if (sentDiscussions.length > 0 || brokenDiscussions.length > 0) {
      await this.db.transaction('rw', this.db.discussions, async () => {
        const now = new Date();

        if (sentDiscussions.length > 0) {
          await Promise.all(
            sentDiscussions.map(async discussion => {
              const status = this.session.peerSessionStatus(
                decodeUserId(discussion.contactUserId)
              );
              const statusStr = sessionStatusToString(status);

              if (
                status !== SessionStatus.Active &&
                status !== SessionStatus.SelfRequested
              ) {
                log.info('skipping DB update - session not ready', {
                  contactUserId: discussion.contactUserId,
                  status: statusStr,
                });
                return;
              }

              const newStatus =
                status === SessionStatus.Active
                  ? DiscussionStatus.ACTIVE
                  : DiscussionStatus.PENDING;

              await this.db.discussions.update(discussion.id!, {
                status: newStatus,
                updatedAt: now,
              });

              log.info('updated discussion status in DB', {
                contactUserId: discussion.contactUserId,
                newStatus,
              });

              // Emit status change event
              const updatedDiscussion = await this.db.discussions.get(
                discussion.id!
              );
              if (updatedDiscussion) {
                this.events.onDiscussionStatusChanged?.(updatedDiscussion);
              }
            })
          );
        }

        if (brokenDiscussions.length > 0) {
          // Per spec: announcement failures should trigger session renewal, not BROKEN status
          // Clear the failed announcement and trigger renewal
          log.info(
            `${brokenDiscussions.length} announcements timed out, triggering renewal`
          );
          await Promise.all(
            brokenDiscussions.map(async id => {
              await this.db.discussions.update(id, {
                initiationAnnouncement: undefined,
                updatedAt: now,
              });

              // Emit renewal needed event
              const discussion = await this.db.discussions.get(id);
              if (discussion) {
                this.events.onSessionRenewalNeeded?.(discussion.contactUserId);
              }
            })
          );
        }
      });
    }

    log.info('resend completed', {
      sent: sentDiscussions.length,
      broken: brokenDiscussions.length,
    });
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
    const newRequestContacts = await this.db.contacts
      .where('ownerUserId')
      .equals(ownerUserId)
      .filter(contact => contact.name.startsWith('New Request'))
      .toArray();

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

    const result =
      await this.session.feedIncomingAnnouncement(announcementData);

    if (!result) {
      return { success: true };
    }

    log.info('announcement intended for us — decrypting');

    let rawMessage: string | undefined;
    if (result.user_data?.length > 0) {
      try {
        rawMessage = new TextDecoder().decode(result.user_data);
      } catch (error) {
        log.error('failed to decode user data', error);
      }
    }

    // Parse announcement message format:
    // - JSON format: {"u":"username","m":"message"} (current)
    // - Legacy colon format: "username:message" (backwards compat)
    // - Plain text: "message" (oldest format)
    // The username is used as the initial contact name if present.
    // TODO: Remove legacy colon and plain text format support once all clients are updated
    let extractedUsername: string | undefined;
    let announcementMessage: string | undefined;

    if (rawMessage) {
      // Try JSON format first (starts with '{')
      if (rawMessage.startsWith('{')) {
        try {
          const parsed = JSON.parse(rawMessage) as { u?: string; m?: string };
          extractedUsername = parsed.u?.trim() || undefined;
          announcementMessage = parsed.m?.trim() || undefined;
        } catch {
          // Invalid JSON, treat as plain text
          announcementMessage = rawMessage;
        }
      } else {
        // Legacy format: check for colon separator
        const colonIndex = rawMessage.indexOf(':');
        if (colonIndex !== -1) {
          extractedUsername =
            rawMessage.slice(0, colonIndex).trim() || undefined;
          announcementMessage =
            rawMessage.slice(colonIndex + 1).trim() || undefined;
        } else {
          // Plain text (oldest format)
          announcementMessage = rawMessage;
        }
      }
    }

    const announcerPkeys = result.announcer_public_keys;
    const contactUserIdRaw = announcerPkeys.derive_id();
    const contactUserId = encodeUserId(contactUserIdRaw);

    const sessionStatus = this.session.peerSessionStatus(contactUserIdRaw);
    // Log clearly for debugging
    console.log(
      `[Announcement] Received from ${contactUserId.slice(0, 12)}... -> session status: ${sessionStatusToString(sessionStatus)}`
    );
    log.info('session updated', {
      contactUserId,
      status: sessionStatusToString(sessionStatus),
    });

    let contact = await this.db.getContactByOwnerAndUserId(
      this.session.userIdEncoded,
      contactUserId
    );
    const isNewContact = !contact;

    if (isNewContact) {
      // Use extracted username if present, otherwise generate temporary name
      const name =
        extractedUsername ||
        (await this._generateTemporaryContactName(this.session.userIdEncoded));
      await this.db.contacts.add({
        ownerUserId: this.session.userIdEncoded,
        userId: contactUserId,
        name,
        publicKeys: announcerPkeys.to_bytes(),
        avatar: undefined,
        isOnline: false,
        lastSeen: new Date(),
        createdAt: new Date(),
      });

      contact = await this.db.getContactByOwnerAndUserId(
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
      announcementMessage
    );

    // Emit event for new discussion request
    if (this.events.onDiscussionRequest) {
      const discussion = await this.db.discussions.get(discussionId);
      if (discussion && contact) {
        this.events.onDiscussionRequest(discussion, contact);
      }
    }

    // Auto-accept ONLY for existing contacts (session recovery scenario).
    // For NEW contacts, the user must manually accept the discussion request.
    // This completes the handshake by sending our announcement back.
    if (sessionStatus === SessionStatus.PeerRequested && !isNewContact) {
      log.info(
        'session is PeerRequested for existing contact, triggering auto-accept',
        { contactUserId }
      );
      this.events.onSessionAcceptNeeded?.(contactUserId);
    } else if (sessionStatus === SessionStatus.PeerRequested && isNewContact) {
      log.info(
        'session is PeerRequested for NEW contact, waiting for manual accept',
        { contactUserId }
      );
    }

    // When session becomes Active after peer accepts our announcement,
    // trigger processing of WAITING_SESSION messages.
    // This happens when we initiated (SelfRequested) and peer accepted.
    if (sessionStatus === SessionStatus.Active) {
      log.info(
        'session is now Active, triggering WAITING_SESSION message processing',
        { contactUserId }
      );
      this.events.onSessionBecameActive?.(contactUserId);
    }

    return {
      success: true,
      discussionId,
      contactUserId,
    };
  }

  private async _handleReceivedDiscussion(
    ownerUserId: string,
    contactUserId: string,
    announcementMessage?: string
  ): Promise<{ discussionId: number }> {
    const log = logger.forMethod('handleReceivedDiscussion');

    const discussionId = await this.db.transaction(
      'rw',
      this.db.discussions,
      async () => {
        const existing = await this.db.getDiscussionByOwnerAndContact(
          ownerUserId,
          contactUserId
        );

        if (existing) {
          const updateData: Partial<Discussion> = { updatedAt: new Date() };
          if (announcementMessage)
            updateData.announcementMessage = announcementMessage;

          if (
            existing.status === DiscussionStatus.PENDING &&
            existing.direction === DiscussionDirection.INITIATED
          ) {
            updateData.status = DiscussionStatus.ACTIVE;
            log.info('transitioning to ACTIVE', {
              discussionId: existing.id,
              contactUserId,
            });
          } else {
            log.info('updating existing discussion', {
              discussionId: existing.id,
              status: existing.status,
              direction: existing.direction,
            });
          }

          await this.db.discussions.update(existing.id!, updateData);
          return existing.id!;
        }

        log.info('creating new RECEIVED/PENDING discussion', { contactUserId });
        return await this.db.discussions.add({
          ownerUserId,
          contactUserId,
          direction: DiscussionDirection.RECEIVED,
          status: DiscussionStatus.PENDING,
          nextSeeker: undefined,
          announcementMessage,
          unreadCount: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    );

    return { discussionId };
  }
}
