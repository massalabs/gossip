import Dexie, { Table } from 'dexie';
import { EncryptedMessage } from './api/messageProtocol/types';

// Define authentication method type
export type AuthMethod = 'capacitor' | 'webauthn' | 'password';

// Define interfaces for your data models
export interface Contact {
  ownerUserId: string; // The current user's userId owning this contact
  userId: string; // 32-byte user ID (gossip Bech32 encoded) - primary key
  name: string;
  avatar?: string;
  publicKeys: Uint8Array; // Serialized UserPublicKeys bytes (from UserPublicKeys.to_bytes())
  isOnline: boolean;
  lastSeen: Date;
  createdAt: Date;
}

export interface Message {
  id?: number;
  ownerUserId: string; // The current user's userId owning this message
  contactUserId: string; // Reference to Contact.userId
  content: string;
  type: 'text' | 'image' | 'file' | 'audio' | 'video';
  direction: 'incoming' | 'outgoing';
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface UserProfile {
  userId: string; // 32-byte user ID (gossip Bech32 encoded) - primary key
  username: string;
  avatar?: string;
  security: {
    encKeySalt: Uint8Array;

    // Authentication method used to create the account
    authMethod: AuthMethod;

    // WebAuthn/FIDO2 (biometric) details when used
    webauthn?: {
      credentialId?: string;
    };

    // iCloud Keychain sync preference (iOS only)
    iCloudSync?: boolean;

    // Mnemonic backup details
    mnemonicBackup: {
      encryptedMnemonic: Uint8Array;
      createdAt: Date;
      backedUp: boolean;
    };
  };
  session: Uint8Array;
  bio?: string;
  status: 'online' | 'away' | 'busy' | 'offline';
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

// Unified discussion interface combining protocol state and UI metadata
export interface Discussion {
  id?: number;
  ownerUserId: string; // The current user's userId owning this discussion
  contactUserId: string; // Reference to Contact.userId - unique per contact

  // Protocol/Encryption fields
  direction: 'initiated' | 'received'; // Whether this user initiated or received the discussion
  status: 'pending' | 'active' | 'closed';
  nextSeeker?: Uint8Array; // The next seeker for sending messages (from SendMessageOutput)
  initiationAnnouncement?: Uint8Array; // Outgoing announcement bytes when we initiate
  announcementMessage?: string; // Optional message from incoming announcement (user_data)
  lastSyncTimestamp?: Date; // Last time messages were synced from protocol

  // UI/Display fields
  lastMessageId?: number;
  lastMessageContent?: string;
  lastMessageTimestamp?: Date;
  unreadCount: number;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;

  // Failed encrypted message. The last msg has failed and must be sent before sending another msg.
  failedEncryptedMessage?: EncryptedMessage;
}

export interface PendingEncryptedMessage {
  id?: number;
  seeker: Uint8Array;
  ciphertext: Uint8Array;
  fetchedAt: Date;
}

export interface PendingAnnouncement {
  id?: number;
  announcement: Uint8Array;
  fetchedAt: Date;
}

// Define the database class
export class GossipDatabase extends Dexie {
  // Define tables
  contacts!: Table<Contact>;
  messages!: Table<Message>;
  userProfile!: Table<UserProfile>;
  discussions!: Table<Discussion>;
  pendingEncryptedMessages!: Table<PendingEncryptedMessage>;
  pendingAnnouncements!: Table<PendingAnnouncement>;

  constructor() {
    super('GossipDatabase');

    this.version(11).stores({
      contacts:
        '++id, ownerUserId, userId, name, isOnline, lastSeen, createdAt, [ownerUserId+userId] , [ownerUserId+name]',
      messages:
        '++id, ownerUserId, contactUserId, type, direction, status, timestamp, [ownerUserId+contactUserId], [ownerUserId+contactUserId+status]',
      userProfile: 'userId, username, status, lastSeen',
      discussions:
        '++id, ownerUserId, &[ownerUserId+contactUserId], status, [ownerUserId+status], lastSyncTimestamp, unreadCount, lastMessageTimestamp, createdAt, updatedAt',
      pendingEncryptedMessages: '++id, fetchedAt, seeker',
      pendingAnnouncements: '++id, fetchedAt, &announcement',
    });

    // Add hooks for automatic timestamps
    this.contacts.hook('creating', function (_primKey, obj, _trans) {
      obj.createdAt = new Date();
    });

    this.userProfile.hook('creating', function (_primKey, obj, _trans) {
      obj.createdAt = new Date();
      obj.updatedAt = new Date();
    });

    this.userProfile.hook(
      'updating',
      function (modifications, _primKey, _obj, _trans) {
        (modifications as Record<string, unknown>).updatedAt = new Date();
      }
    );

    this.discussions.hook('creating', function (_primKey, obj, _trans) {
      obj.createdAt = new Date();
      obj.updatedAt = new Date();
    });

    this.discussions.hook(
      'updating',
      function (modifications, _primKey, _obj, _trans) {
        (modifications as Record<string, unknown>).updatedAt = new Date();
      }
    );
  }

  // Helper methods for common operations
  async getContactsByOwner(ownerUserId: string): Promise<Contact[]> {
    return await this.contacts
      .where('ownerUserId')
      .equals(ownerUserId)
      .toArray();
  }

  async getContactByOwnerAndUserId(
    ownerUserId: string,
    userId: string
  ): Promise<Contact | undefined> {
    return await this.contacts
      .where('[ownerUserId+userId]')
      .equals([ownerUserId, userId])
      .first();
  }

  async getMessagesForContactByOwner(
    ownerUserId: string,
    contactUserId: string,
    limit = 50
  ): Promise<Message[]> {
    return await this.messages
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .reverse()
      .limit(limit)
      .toArray();
  }

  async getDiscussionsByOwner(ownerUserId: string): Promise<Discussion[]> {
    const all = await this.discussions
      .where('ownerUserId')
      .equals(ownerUserId)
      .toArray();
    return all.sort((a, b) => {
      if (a.lastMessageTimestamp && b.lastMessageTimestamp) {
        return (
          b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime()
        );
      }
      if (a.lastMessageTimestamp) return -1;
      if (b.lastMessageTimestamp) return 1;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });
  }

  async getUnreadCountByOwner(ownerUserId: string): Promise<number> {
    const discussions = await this.discussions
      .where('ownerUserId')
      .equals(ownerUserId)
      .toArray();
    return discussions.reduce((total, d) => total + d.unreadCount, 0);
  }

  async getDiscussionByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined> {
    return await this.discussions
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .first();
  }

  async markMessagesAsRead(
    ownerUserId: string,
    contactUserId: string
  ): Promise<void> {
    await this.messages
      .where('[ownerUserId+contactUserId+status]')
      .equals([ownerUserId, contactUserId, 'delivered'])
      .modify({ status: 'read' });

    await this.discussions
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .modify({ unreadCount: 0 });
  }

  async addMessage(message: Omit<Message, 'id'>): Promise<number> {
    const messageId = await this.messages.add(message);

    // Get existing discussion
    const discussion = await this.discussions
      .where('[ownerUserId+contactUserId]')
      .equals([message.ownerUserId, message.contactUserId])
      .first();

    if (discussion) {
      await this.discussions.update(discussion.id!, {
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount:
          message.direction === 'incoming'
            ? discussion.unreadCount + 1
            : discussion.unreadCount,
        updatedAt: new Date(),
      });
    } else {
      // Note: For new messages, a discussion should already exist from the protocol
      // If not, we'll create a minimal one (this shouldn't normally happen)
      console.log(
        'Warning: Creating discussion for contact without protocol setup:',
        message.contactUserId
      );
      await this.discussions.put({
        ownerUserId: message.ownerUserId,
        contactUserId: message.contactUserId,
        direction: message.direction === 'incoming' ? 'received' : 'initiated',
        status: 'pending',
        nextSeeker: undefined,
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount: message.direction === 'incoming' ? 1 : 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    return messageId;
  }

  /**
   * Get all active discussions with their sync status
   * @returns Array of active discussions
   */
  async getActiveDiscussionsByOwner(
    ownerUserId: string
  ): Promise<Discussion[]> {
    return await this.discussions
      .where('[ownerUserId+status]')
      .equals([ownerUserId, 'active'])
      .toArray();
  }

  /**
   * Update the last sync timestamp for a discussion
   * @param discussionId - The discussion ID
   * @param timestamp - The sync timestamp
   */
  async updateLastSyncTimestamp(
    discussionId: number,
    timestamp: Date
  ): Promise<void> {
    await this.discussions.update(discussionId, {
      lastSyncTimestamp: timestamp,
      updatedAt: new Date(),
    });
  }

  async deleteDb(): Promise<void> {
    await this.close();
    await this.delete();
  }
}

// Create and export the database instance
export const db = new GossipDatabase();
