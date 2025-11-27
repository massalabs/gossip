/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import { db, Discussion, DiscussionStatus, DiscussionDirection } from '../db';
import { encodeUserId } from '../utils/userId';
import {
  createMessageProtocol,
  IMessageProtocol,
} from '../api/messageProtocol';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm/session';
import { notificationService } from './notifications';

const ONE_HOUR_MS = 60 * 60 * 1000;

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
}

/**
 * Centralized error logger for announcement-related operations.
 * In test environment we suppress the very noisy "No authenticated user"
 * errors that can legitimately occur during setup and in isolated tests.
 */
function logAnnouncementError(prefix: string, error: unknown): void {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';

  console.error(prefix, message);
}

export class AnnouncementService {
  constructor(public readonly messageProtocol: IMessageProtocol) {}

  async sendAnnouncement(announcement: Uint8Array): Promise<{
    success: boolean;
    counter?: string;
    error?: string;
  }> {
    try {
      const counter = await this.messageProtocol.sendAnnouncement(announcement);

      return { success: true, counter };
    } catch (error) {
      logAnnouncementError('Failed to broadcast outgoing session:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**fails
   * Establish a session with a contact via session manager and send the created announcement on the network.
   * Return type contains info about the success of the broadcast of the announcement.
   * If the session manager fails to create an announcement, let the error bubble up.
   * @param contactPublicKeys - The public keys of the contact to establish a session with.
   * @param ourPk - Our public keys.
   * @param ourSk - Our secret keys.
   * @param session - The session module to use.
   * @param userData - Optional user data to include in the announcement.
   * @returns Return a type containing the created announcement (if any) and information about the success of the broadcast of the announcement.
   */
  async establishSession(
    contactPublicKeys: UserPublicKeys,
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys,
    session: SessionModule,
    userData?: Uint8Array
  ): Promise<{
    success: boolean;
    error?: string;
    announcement: Uint8Array;
  }> {
    const announcement = session.establishOutgoingSession(
      contactPublicKeys,
      ourPk,
      ourSk,
      userData
    );

    const result = await this.sendAnnouncement(announcement);
    if (!result.success) {
      return {
        success: false,
        error: result.error,
        announcement: announcement,
      };
    }

    return { success: true, announcement };
  }

  async fetchAndProcessAnnouncements(
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys,
    session: SessionModule
  ): Promise<AnnouncementReceptionResult> {
    try {
      // First, check if service worker has already fetched announcements
      let announcements: Uint8Array[];
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
        // If no pending announcements, fetch from API
        announcements = await this._fetchAnnouncements();
      }

      let newAnnouncementsCount = 0;

      for (const announcement of announcements) {
        try {
          const result = await this._processIncomingAnnouncement(
            announcement,
            ourPk,
            ourSk,
            session
          );
          if (result.success) {
            newAnnouncementsCount++;
          } else if (result.error) {
            errors.push(`${result.error}`);
          }
        } catch (error) {
          errors.push(
            `${error instanceof Error ? error.message : 'Unknown error'}`
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
        console.error(
          'Failed to fetch/process incoming announcements:',
          errors.join('\n')
        );
      }
    }
  }

  async resendAnnouncements(failedDiscussions: Discussion[]): Promise<void> {
    if (!failedDiscussions.length) return;

    // Perform async network calls outside transaction
    const sentDiscussions: number[] = [];
    const brokenDiscussions: number[] = [];

    for (const discussion of failedDiscussions) {
      try {
        const result = await this.sendAnnouncement(
          discussion.initiationAnnouncement!
        );

        if (result.success) {
          sentDiscussions.push(discussion.id!);
          continue;
        }

        // Failed to send - check if should mark as broken
        const lastUpdate = discussion.updatedAt.getTime() ?? 0;
        if (Date.now() - lastUpdate > ONE_HOUR_MS) {
          brokenDiscussions.push(discussion.id!);
        }
      } catch (error) {
        console.error('Failed to resend announcement:', error);
      }
    }

    // Perform all database updates in a single transaction
    if (sentDiscussions.length > 0 || brokenDiscussions.length > 0) {
      await db.transaction('rw', db.discussions, async () => {
        const now = new Date();

        // Update all successfully sent discussions to ACTIVE
        if (sentDiscussions.length > 0) {
          await Promise.all(
            sentDiscussions.map(id =>
              db.discussions.update(id, {
                status: DiscussionStatus.ACTIVE,
                updatedAt: now,
              })
            )
          );
        }

        // Update all broken discussions to BROKEN
        if (brokenDiscussions.length > 0) {
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

  private async _fetchAnnouncements(): Promise<Uint8Array[]> {
    try {
      const announcements = await this.messageProtocol.fetchAnnouncements();
      return announcements;
    } catch (error) {
      logAnnouncementError('Failed to fetch incoming announcements:', error);
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
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys,
    session: SessionModule
  ): Promise<{
    success: boolean;
    discussionId?: number;
    contactUserId?: string;
    error?: string;
  }> {
    if (!ourPk || !ourSk) throw new Error('WASM keys unavailable');
    if (!session) throw new Error('Session module not initialized');
    try {
      const announcementResult = session.feedIncomingAnnouncement(
        announcementData,
        ourPk,
        ourSk
      );

      // if we can't decrypt the announcement, it means we are not the intended recipient. It's not an error.
      if (!announcementResult) {
        return {
          success: true,
        };
      }

      // Extract user data from the announcement (optional message)
      const userData = announcementResult.user_data;
      let announcementMessage: string | undefined;
      if (userData && userData.length > 0) {
        try {
          announcementMessage = new TextDecoder().decode(userData);
          console.log(
            'Received announcement with user data:',
            announcementMessage
          );
        } catch (error) {
          logAnnouncementError(
            'Failed to decode announcement user data:',
            error
          );
        }
      }

      const announcerPkeys = announcementResult.announcer_public_keys;
      const contactUserId = announcerPkeys.derive_id();
      const contactUserIdString = encodeUserId(contactUserId);
      const ownerUserId = encodeUserId(ourPk.derive_id());

      let contact = await db.getContactByOwnerAndUserId(
        ownerUserId,
        contactUserIdString
      );

      const isIncomingAnnouncement = !contact;

      // If the announcement is incoming, we need to create a new contact
      if (isIncomingAnnouncement) {
        const contactName =
          await this._generateTemporaryContactName(ownerUserId);

        await db.contacts.add({
          ownerUserId: ownerUserId,
          userId: contactUserIdString,
          name: contactName,
          publicKeys: announcerPkeys.to_bytes(),
          avatar: undefined,
          isOnline: false,
          lastSeen: new Date(),
          createdAt: new Date(),
        });

        contact = await db.getContactByOwnerAndUserId(
          ownerUserId,
          contactUserIdString
        );
      }

      if (!contact) {
        throw new Error('Could not find contact');
      }

      const { discussionId } = await handleReceivedDiscussion(
        ownerUserId,
        contactUserIdString,
        contact.name,
        announcementMessage
      );

      // Only show notification if app is not active (in background, minimized, or in another tab)
      const isAppActive = typeof document !== 'undefined' && !document.hidden;
      if (isIncomingAnnouncement && !isAppActive) {
        try {
          await notificationService.showNewDiscussionNotification(
            announcementMessage
          );
        } catch (notificationError) {
          logAnnouncementError(
            'Failed to show new discussion notification:',
            notificationError
          );
        }
      }

      return {
        success: true,
        discussionId,
        contactUserId: contactUserIdString,
      };
    } catch (error) {
      logAnnouncementError('Failed to process incoming announcement:', error);
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
export async function handleReceivedDiscussion(
  ownerUserId: string,
  contactUserId: string,
  contactName?: string,
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
        }

        await db.discussions.update(existing.id!, updateData);
        return existing.id!;
      }

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

  try {
    await notificationService.showNewDiscussionNotification(
      contactName || `User ${contactUserId.substring(0, 8)}`
    );
  } catch (notificationError) {
    console.error(
      'Failed to show new discussion notification:',
      notificationError
    );
  }

  return { discussionId };
}

export const announcementService = new AnnouncementService(
  createMessageProtocol()
);
