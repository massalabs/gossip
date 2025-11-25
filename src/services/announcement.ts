/**
 * Announcement Service
 *
 * Handles broadcasting and processing of session announcements.
 */

import { db } from '../db';
import { notificationService } from './notifications';
import { encodeUserId } from '../utils/userId';
import { processIncomingAnnouncement } from '../crypto/discussionInit';
import { useAccountStore } from '../stores/accountStore';
import {
  createMessageProtocol,
  IMessageProtocol,
} from '../api/messageProtocol';

export interface AnnouncementReceptionResult {
  success: boolean;
  newAnnouncementsCount: number;
  error?: string;
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
      console.error('Failed to broadcast outgoing session:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async fetchAndProcessAnnouncements(): Promise<AnnouncementReceptionResult> {
    try {
      const { userProfile } = useAccountStore.getState();
      if (!userProfile?.userId) throw new Error('No authenticated user');

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
      let hasErrors = false;

      for (const announcement of announcements) {
        try {
          const result = await this._processIncomingAnnouncement(announcement);
          if (result.success) {
            newAnnouncementsCount++;
          } else if (result.error) {
            hasErrors = true;
          }
        } catch (error) {
          console.error('Failed to process incoming announcement:', error);
          hasErrors = true;
        }
      }

      return {
        success: !hasErrors || newAnnouncementsCount > 0,
        newAnnouncementsCount,
        error: hasErrors ? 'Some announcements failed to process' : undefined,
      };
    } catch (error) {
      console.error('Failed to fetch/process incoming announcements:', error);
      return {
        success: false,
        newAnnouncementsCount: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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

  private async _fetchAnnouncements(): Promise<Uint8Array[]> {
    try {
      const announcements = await this.messageProtocol.fetchAnnouncements();
      return announcements;
    } catch (error) {
      console.error('Failed to fetch incoming announcements:', error);
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
          console.error('Failed to decode announcement user data:', error);
        }
      }

      const announcerPkeys = announcementResult.announcer_public_keys;
      const contactUserId = announcerPkeys.derive_id();
      const contactUserIdString = encodeUserId(contactUserId);

      let contact = await db.getContactByOwnerAndUserId(
        ownerUserId,
        contactUserIdString
      );

      if (!contact) {
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

      const { discussionId } = await processIncomingAnnouncement(
        contact,
        announcementData,
        announcementMessage
      );

      try {
        await notificationService.showNewDiscussionNotification(
          contact?.name || `User ${contactUserIdString.substring(0, 8)}`
        );
      } catch (notificationError) {
        console.error(
          'Failed to show new discussion notification:',
          notificationError
        );
      }

      return {
        success: true,
        discussionId,
        contactUserId: contactUserIdString,
      };
    } catch (error) {
      console.error('Failed to process incoming announcement:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}

export const announcementService = new AnnouncementService(
  createMessageProtocol()
);
