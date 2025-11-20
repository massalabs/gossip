/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import { db, Discussion, DiscussionStatus } from '../db';
import { encodeUserId } from '../utils/userId';
import { useAccountStore } from '../stores/accountStore';
import {
  createMessageProtocol,
  IMessageProtocol,
} from '../api/messageProtocol';
import { createUpdateDiscussion } from './discussion';
import {
  UserPublicKeys,
  UserSecretKeys,
} from '../assets/generated/wasm/gossip_wasm';
import { SessionModule } from '../wasm/session';

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

  async establishSession(
    contactPublicKeys: UserPublicKeys,
    ourPk: UserPublicKeys,
    ourSk: UserSecretKeys,
    session: SessionModule
  ): Promise<{
    success: boolean;
    error?: string;
    announcement: Uint8Array;
  }> {
    const announcement = session.establishOutgoingSession(
      contactPublicKeys,
      ourPk,
      ourSk
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

  async fetchAndProcessAnnouncements(): Promise<AnnouncementReceptionResult> {
    const errors: string[] = [];
    try {
      const { userProfile } = useAccountStore.getState();

      if (!userProfile?.userId) {
        return {
          success: false,
          newAnnouncementsCount: 0,
          error: 'No authenticated user',
        };
      }

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
          const result = await this._processIncomingAnnouncement(announcement);
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

  async simulateIncomingDiscussion(): Promise<{
    success: boolean;
    newMessagesCount: number;
    error?: string;
  }> {
    const { userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) throw new Error('No authenticated user');

    try {
      console.log('Simulating incoming discussion announcement...');
      const mockAnnouncement = new Uint8Array(64);
      crypto.getRandomValues(mockAnnouncement);
      const result = await this._processIncomingAnnouncement(mockAnnouncement);
      return {
        success: result.success,
        newMessagesCount: result.discussionId ? 1 : 0,
        error: result.error,
      };
    } catch (error) {
      console.error('Failed to simulate incoming discussion:', error);
      return {
        success: false,
        newMessagesCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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
    announcementData: Uint8Array
  ): Promise<{
    success: boolean;
    discussionId?: number;
    contactUserId?: string;
    error?: string;
  }> {
    const { ourPk, ourSk, session, userProfile } = useAccountStore.getState();
    if (!userProfile?.userId) throw new Error('No authenticated user');

    const ownerUserId = userProfile.userId;

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

      const { discussionId } = await createUpdateDiscussion(
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

export const announcementService = new AnnouncementService(
  createMessageProtocol()
);
