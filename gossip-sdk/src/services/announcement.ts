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

const logger = new Logger('AnnouncementService');

const ONE_HOUR_MS = 60 * 60 * 1000;

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

  constructor(
    db: GossipDatabase,
    messageProtocol: IMessageProtocol,
    session: SessionModule,
    events: GossipSdkEvents = {}
  ) {
    this.db = db;
    this.messageProtocol = messageProtocol;
    this.session = session;
    this.events = events;
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

    const announcement = this.session.establishOutgoingSession(
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

      if (pending.length > 0) {
        log.info(
          `processing ${pending.length} pending announcements from IndexedDB`
        );
        announcements = pending.map(p => p.announcement);
        // Track counters from pending announcements to avoid re-processing
        fetchedCounters = pending
          .map(p => p.counter)
          .filter((counter): counter is string => counter !== undefined);

        const ids = pending
          .map(p => p.id)
          .filter((id): id is number => id !== undefined);
        if (ids.length > 0) await this.db.pendingAnnouncements.bulkDelete(ids);
      } else {
        const cursor = (
          await this.db.userProfile.get(this.session.userIdEncoded)
        )?.lastBulletinCounter;

        const fetched = await this._fetchAnnouncements(cursor);
        announcements = fetched.map(a => a.data);
        fetchedCounters = fetched.map(a => a.counter);
      }

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
        if (ageMs > ONE_HOUR_MS) {
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
          log.info(`marking ${brokenDiscussions.length} discussions as BROKEN`);
          await Promise.all(
            brokenDiscussions.map(async id => {
              await this.db.discussions.update(id, {
                status: DiscussionStatus.BROKEN,
                initiationAnnouncement: undefined,
                updatedAt: now,
              });

              // Emit status change event
              const updatedDiscussion = await this.db.discussions.get(id);
              if (updatedDiscussion) {
                this.events.onDiscussionStatusChanged?.(updatedDiscussion);
                this.events.onSessionBroken?.(updatedDiscussion);
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
    limit = 500
  ): Promise<BulletinItem[]> {
    const log = logger.forMethod('_fetchAnnouncements');

    try {
      const items = await this.messageProtocol.fetchAnnouncements(
        limit,
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

    const result = this.session.feedIncomingAnnouncement(announcementData);

    if (!result) {
      return { success: true };
    }

    log.info('announcement intended for us — decrypting');

    let announcementMessage: string | undefined;
    if (result.user_data?.length > 0) {
      try {
        announcementMessage = new TextDecoder().decode(result.user_data);
      } catch (error) {
        log.error('failed to decode user data', error);
      }
    }

    const announcerPkeys = result.announcer_public_keys;
    const contactUserIdRaw = announcerPkeys.derive_id();
    const contactUserId = encodeUserId(contactUserIdRaw);

    const sessionStatus = this.session.peerSessionStatus(contactUserIdRaw);
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
      const name = await this._generateTemporaryContactName(
        this.session.userIdEncoded
      );
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
