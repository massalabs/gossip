/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import { db, Discussion, DiscussionStatus, DiscussionDirection } from '../db';
import { decodeUserId, encodeUserId } from '../utils/userId';
import { IMessageProtocol, restMessageProtocol } from '../api/messageProtocol';
import {
  UserPublicKeys,
  SessionStatus,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule, sessionStatusToString } from '../wasm/session';
import { notificationService } from './notifications';
import { isAppInForeground } from '../utils/appState';
import { Logger } from '../utils/logs';
import { BulletinItem } from '../api/messageProtocol/types';

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
  private messageProtocol: IMessageProtocol;
  constructor(messageProtocol: IMessageProtocol) {
    this.messageProtocol = messageProtocol;
  }

  setMessageProtocol(messageProtocol: IMessageProtocol): void {
    this.messageProtocol = messageProtocol;
  }

  async sendAnnouncement(announcement: Uint8Array): Promise<{
    success: boolean;
    counter?: string;
    error?: string;
  }> {
    try {
      const counter = await this.messageProtocol.sendAnnouncement(announcement);
      logger.info(
        'sendAnnouncement',
        `announcement broadcast successful, counter: ${counter}`
      );
      return { success: true, counter };
    } catch (error) {
      logger.error('sendAnnouncement', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Establish a session with a contact via session manager and send the created announcement on the network.
   * Return type contains info about the success or failure of the encryption and broadcast of the announcement.
   * @param contactPublicKeys - The public keys of the contact to establish a session with.
   * @param session - The session module to use.
   * @param userData - Optional user data to include in the announcement.
   * @returns Return a type containing the created announcement (if any) and information about the success of the failure of the encryption and broadcast of the announcement.
   */
  async establishSession(
    contactPublicKeys: UserPublicKeys,
    session: SessionModule,
    userData?: Uint8Array
  ): Promise<{
    success: boolean;
    error?: string;
    announcement: Uint8Array;
  }> {
    const contactUserId = encodeUserId(contactPublicKeys.derive_id());
    logger.info(
      'establishSession',
      `establishing session with contact ${contactUserId}`
    );

    const announcement = session.establishOutgoingSession(
      contactPublicKeys,
      userData
    );

    if (announcement.length === 0) {
      logger.error(
        'establishSession',
        `session manager returned empty announcement for contact ${contactUserId}`
      );
      return {
        success: false,
        error: EstablishSessionError,
        announcement: announcement,
      };
    }

    // Check session status after establishing
    const sessionStatus = session.peerSessionStatus(
      contactPublicKeys.derive_id()
    );
    logger.info(
      'establishSession',
      `session status for ${contactUserId} after establish: ${sessionStatusToString(sessionStatus)}`
    );

    const result = await this.sendAnnouncement(announcement);
    if (!result.success) {
      logger.error(
        'establishSession',
        `failed to send announcement to ${contactUserId}: ${result.error}`
      );
      return {
        success: false,
        error: result.error,
        announcement: announcement,
      };
    }

    logger.info('establishSession', `sent to ${contactUserId}`);
    return { success: true, announcement };
  }

  async fetchAndProcessAnnouncements(
    session: SessionModule
  ): Promise<AnnouncementReceptionResult> {
    const errors: string[] = [];
    let announcements: Uint8Array[];
    let fetchedCounters: string[] = [];

    try {
      const pendingAnnouncements = await db.pendingAnnouncements.toArray();

      if (pendingAnnouncements.length > 0) {
        // Use announcements from IndexedDB
        announcements = pendingAnnouncements.map(p => p.announcement);
        // Delete only the announcements we just read (by their IDs) to avoid race condition
        // If service worker adds new announcements between read and delete, they won't be lost
        const announcementIds = pendingAnnouncements
          .map(p => p.id)
          .filter((id): id is number => id !== undefined);
        if (announcementIds.length > 0) {
          await db.pendingAnnouncements.bulkDelete(announcementIds);
        }
      } else {
        // If no pending announcements, fetch from API using cursor-based pagination
        const ownerUserId = session.userIdEncoded;
        const userProfile = await db.userProfile.get(ownerUserId);
        const cursor = userProfile?.lastBulletinCounter;
        const fetchedAnnouncements = await this._fetchAnnouncements(cursor);
        announcements = fetchedAnnouncements.map(a => a.data);
        fetchedCounters = fetchedAnnouncements.map(a => a.counter);
      }

      const BATCH_SIZE = 50;

      let newAnnouncementsCount = 0;

      for (let i = 0; i < announcements.length; i += BATCH_SIZE) {
        const batch = announcements.slice(i, i + BATCH_SIZE);

        for (const announcement of batch) {
          try {
            const result = await this._processIncomingAnnouncement(
              announcement,
              session
            );
            // if success but no contactUserId, it means the announcement is not for us. So we don't count it as a new announcement.
            if (result.success && result.contactUserId) {
              logger.info(
                'fetchAndProcessAnnouncements',
                `successfully processed announcement from contact ${result.contactUserId}`
              );
              newAnnouncementsCount++;
            }

            if (result.error) {
              errors.push(`${result.error}`);
            }
          } catch (error) {
            errors.push(
              `${error instanceof Error ? error.message : 'Unknown error'}`
            );
          }
        }

        // Yield back to the event loop between batches so the UI stays responsive.
        if (i + BATCH_SIZE < announcements.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      // Update lastBulletinCounter if we fetched announcements from API and have counters
      if (fetchedCounters.length > 0 && newAnnouncementsCount > 0) {
        const userProfile = await db.userProfile.get(session.userIdEncoded);
        if (userProfile) {
          // Find the highest counter among the fetched announcements
          const highestCounter = fetchedCounters.reduce((max, current) =>
            current > max ? current : max
          );

          // Update the user profile with the new cursor position
          await db.userProfile.update(session.userIdEncoded, {
            lastBulletinCounter: highestCounter,
          });

          logger.info(
            'fetchAndProcessAnnouncements',
            `Updated lastBulletinCounter to ${highestCounter}`
          );
        }
      }

      return {
        success: errors.length === 0 || newAnnouncementsCount > 0,
        newAnnouncementsCount,
        error: errors.length > 0 ? errors.join(', ') : undefined,
      };
    } catch (error) {
      errors.push(
        `${error instanceof Error ? error.message : 'Unknown error'}`
      );
      return {
        success: false,
        newAnnouncementsCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      if (errors.length > 0) {
        logger.error(
          'fetchAndProcessAnnouncements',
          `Failed to fetch/process incoming announcements: ${errors.join('\n')}`
        );
      }
    }
  }

  /**
   * Attempts to resend failed outgoing announcements for a list of discussions.
   *
   * For each failed discussion:
   * - Attempts to re-send the outgoing announcement.
   * - Successfully re-sent announcements are collected for DB updates.
   * - If resending fails, checks if the discussion's last update is older than 1 hour.
   *   If so, the discussion is marked as broken.
   *
   * After processing all discussions, updates the database in a single transaction:
   * - Sets the discussion status to PENDING or ACTIVE if successfully resent,
   *   or marks as BROKEN if too much time has passed without success.
   *
   * No action is taken if the input array is empty.
   *
   * @param {Discussion[]} failedDiscussions - Array of discussions whose announcements failed previously.
   * @param {SessionModule} session - The cryptographic session module used for re-encryption.
   * @returns {Promise<void>}
   */
  async resendAnnouncements(
    failedDiscussions: Discussion[],
    session: SessionModule
  ): Promise<void> {
    if (!failedDiscussions.length) return;

    // Perform async network calls outside transaction
    const sentDiscussions: Discussion[] = [];
    const brokenDiscussions: number[] = [];

    for (const discussion of failedDiscussions) {
      logger.info(
        'resendAnnouncements',
        `resending announcement for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId}. Status: ${discussion.status}`
      );
      try {
        const result = await this.sendAnnouncement(
          discussion.initiationAnnouncement! // if a discussion is failed, it means the announcement has been encrypted by session manager, so we can resend it
        );

        if (result.success) {
          logger.info(
            'resendAnnouncements',
            `announcement sent successfully on network for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId}`
          );
          sentDiscussions.push(discussion);

          continue;
        }

        logger.info(
          'resendAnnouncements',
          `failed to send announcement on network for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId}`
        );
        // Failed to send - check if should mark as broken
        const lastUpdate = discussion.updatedAt.getTime() ?? 0;
        if (Date.now() - lastUpdate > ONE_HOUR_MS) {
          logger.info(
            'resendAnnouncements',
            `discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} is too old. Marking as broken.`
          );
          brokenDiscussions.push(discussion.id!);
        }
      } catch (error) {
        logger.error(
          'resendAnnouncements',
          `Failed to resend announcement: ${error}`
        );
      }
    }

    // Perform all database updates in a single transaction
    if (sentDiscussions.length > 0 || brokenDiscussions.length > 0) {
      await db.transaction('rw', db.discussions, async () => {
        const now = new Date();

        // Update all successfully sent discussions to PENDING or ACTIVE based on the session status
        if (sentDiscussions.length > 0) {
          await Promise.all(
            sentDiscussions.map(async discussion => {
              const status = session.peerSessionStatus(
                decodeUserId(discussion.contactUserId)
              );

              logger.info(
                'resendAnnouncements',
                `session status for discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} is ${sessionStatusToString(status)}`
              );

              // If discussion has been broken, don't update it
              if (
                status !== SessionStatus.Active &&
                status !== SessionStatus.SelfRequested
              ) {
                logger.info(
                  'resendAnnouncements',
                  `discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} is not active or self requested. Skipping update.`
                );
                return;
              }

              const promis = db.discussions.update(discussion.id!, {
                status:
                  status === SessionStatus.Active
                    ? DiscussionStatus.ACTIVE
                    : DiscussionStatus.PENDING,
                updatedAt: now,
              });
              logger.info(
                'resendAnnouncements',
                `discussion between ${discussion.ownerUserId} and ${discussion.contactUserId} has been updated on db to ${status === SessionStatus.Active ? DiscussionStatus.ACTIVE : DiscussionStatus.PENDING}`
              );
              return promis;
            })
          );
        }

        // Update all broken discussions to BROKEN
        if (brokenDiscussions.length > 0) {
          logger.info(
            'resendAnnouncements',
            `updating ${brokenDiscussions.length} broken discussions on db to BROKEN`
          );
          await Promise.all(
            brokenDiscussions.map(id =>
              db.discussions.update(id, {
                status: DiscussionStatus.BROKEN,
                initiationAnnouncement: undefined,
                updatedAt: now,
              })
            )
          );
        }
      });
    }
  }

  private async _fetchAnnouncements(
    cursor?: string,
    limit: number = 20
  ): Promise<BulletinItem[]> {
    try {
      return await this.messageProtocol.fetchAnnouncements(limit, cursor);
    } catch (error) {
      logger.error(
        '_fetchAnnouncements',
        `Failed to fetch incoming announcements: ${error}`
      );
      return [];
    }
  }

  /**
   * Generates a temporary contact name for new incoming requests.
   * TODO: Replace with a better naming scheme.
   */
  private async _generateTemporaryContactName(
    ownerUserId: string
  ): Promise<string> {
    // Find all contacts with names starting with "New Request"
    // and extract the maximum number suffix
    const newRequestContacts = await db.contacts
      .where('ownerUserId')
      .equals(ownerUserId)
      .filter(contact => contact.name.startsWith('New Request'))
      .toArray();

    // Extract numbers from names like "New Request 1", "New Request 2", etc.
    const numbers = newRequestContacts
      .map(c => {
        const match = c.name.match(/^New Request (\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter(n => n > 0);

    const maxNumber = numbers.length > 0 ? Math.max(...numbers) : 0;
    const nextNumber = maxNumber + 1;

    return `New Request ${nextNumber}`;
  }

  private async _processIncomingAnnouncement(
    announcementData: Uint8Array,
    session: SessionModule
  ): Promise<{
    success: boolean;
    discussionId?: number;
    contactUserId?: string;
    error?: string;
  }> {
    try {
      const announcementResult =
        session.feedIncomingAnnouncement(announcementData);

      // if we can't decrypt the announcement, it means we are not the intended recipient. It's not an error.
      if (!announcementResult) {
        return {
          success: true,
        };
      }

      logger.info(
        '_processIncomingAnnouncement',
        `received an announcement intended for us, processing...`
      );

      // Extract announcement's optional message
      const userData = announcementResult.user_data;
      let announcementMessage: string | undefined;
      if (userData && userData.length > 0) {
        try {
          announcementMessage = new TextDecoder().decode(userData);
        } catch (error) {
          logger.error(
            '_processIncomingAnnouncement',
            `Failed to decode announcement user data: ${error}`
          );
        }
      }

      // Extract announcement's public keys
      const announcerPkeys = announcementResult.announcer_public_keys;
      const contactUserId = announcerPkeys.derive_id();
      const contactUserIdEncoded = encodeUserId(contactUserId);

      // Log session status after processing announcement
      const sessionStatus = session.peerSessionStatus(contactUserId);
      logger.info(
        '_processIncomingAnnouncement',
        `processed announcement from ${contactUserIdEncoded}, session status is now: ${sessionStatusToString(sessionStatus)}`
      );

      let contact = await db.getContactByOwnerAndUserId(
        session.userIdEncoded,
        contactUserIdEncoded
      );

      const isIncomingAnnouncement = !contact;

      // If the announcement is incoming, we need to create a new contact
      if (isIncomingAnnouncement) {
        const contactName = await this._generateTemporaryContactName(
          session.userIdEncoded
        );

        await db.contacts.add({
          ownerUserId: session.userIdEncoded,
          userId: contactUserIdEncoded,
          name: contactName,
          publicKeys: announcerPkeys.to_bytes(),
          avatar: undefined,
          isOnline: false,
          lastSeen: new Date(),
          createdAt: new Date(),
        });

        contact = await db.getContactByOwnerAndUserId(
          session.userIdEncoded,
          contactUserIdEncoded
        );
      }

      if (!contact) {
        throw new Error('Could not find contact');
      }

      const { discussionId } = await handleReceivedDiscussion(
        session.userIdEncoded,
        contactUserIdEncoded,
        announcementMessage
      );

      // Only show notification if app is not active (in background, minimized, or in another tab)
      const isAppActive = await isAppInForeground();

      if (isIncomingAnnouncement && !isAppActive) {
        try {
          await notificationService.showNewDiscussionNotification(
            announcementMessage
          );
        } catch (notificationError) {
          logger.error(
            '_processIncomingAnnouncement',
            `Failed to show new discussion notification: ${notificationError}`
          );
        }
      }

      return {
        success: true,
        discussionId,
        contactUserId: contactUserIdEncoded,
      };
    } catch (error) {
      logger.error(
        '_processIncomingAnnouncement',
        `Failed to process incoming announcement: ${error}`
      );
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to process incoming announcement',
      };
    }
  }
}

/**
 * When someone sent us an announcement, this function handles whether we should
 * Create or update a discussion based on the sending contact user id.
 * If discussion with the sending contact already exists, it will be updated accordingly.
 * Otherwise, a new discussion will be created.
 */
async function handleReceivedDiscussion(
  ownerUserId: string,
  contactUserId: string,
  announcementMessage?: string
): Promise<{ discussionId: number }> {
  const discussionId = await db.transaction(
    'rw',
    db.discussions,
    async (): Promise<number> => {
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
          existing.direction === DiscussionDirection.INITIATED
        ) {
          updateData.status = DiscussionStatus.ACTIVE;
          logger.info(
            'handleReceivedDiscussion',
            `transitioning discussion ${existing.id} with ${contactUserId} from PENDING/INITIATED to ACTIVE`
          );
        } else {
          logger.info(
            'handleReceivedDiscussion',
            `updating existing discussion ${existing.id} with ${contactUserId} (status: ${existing.status}, direction: ${existing.direction})`
          );
        }

        await db.discussions.update(existing.id!, updateData);
        return existing.id!;
      }

      console.log(
        `[INFO] handleReceivedDiscussion: creating new RECEIVED/PENDING discussion with contact ${contactUserId}`
      );
      const discussionId = await db.discussions.add({
        ownerUserId: ownerUserId,
        contactUserId: contactUserId,
        direction: DiscussionDirection.RECEIVED,
        status: DiscussionStatus.PENDING,
        nextSeeker: undefined,
        announcementMessage,
        unreadCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return discussionId;
    }
  );

  return { discussionId };
}

export const announcementService = new AnnouncementService(restMessageProtocol);
