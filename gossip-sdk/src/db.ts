/**
 * Gossip Database
 *
 * IndexedDB database implementation using Dexie for the Gossip messenger.
 * Provides tables for contacts, messages, discussions, user profiles, and more.
 */

import Dexie, { Table } from 'dexie';

// Define authentication method type
export type AuthMethod = 'capacitor' | 'webauthn' | 'password';

// Constants
export const MESSAGE_ID_SIZE = 12;

// Define interfaces for data models
export interface Contact {
  id?: number;
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
  messageId?: Uint8Array; // 12-byte random ID for deduplication
  ownerUserId: string; // The current user's userId owning this message
  contactUserId: string; // Reference to Contact.userId
  content: string;
  serializedContent?: Uint8Array; // Serialized message content
  encryptedMessage?: Uint8Array; // Ciphertext of the message
  whenToSend?: Date;
  type: MessageType;
  direction: MessageDirection;
  status: MessageStatus;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  seeker?: Uint8Array; // Seeker for this message (stored when sending or receiving)
  replyTo?: {
    originalMsgId: Uint8Array; // Message ID of the original message (required for replies)
  };
  forwardOf?: {
    originalContent?: string;
    originalContactId?: Uint8Array;
  };
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
  lastPublicKeyPush?: Date;
  lastBulletinCounter?: string;
}

export enum DiscussionDirection {
  RECEIVED = 'received',
  INITIATED = 'initiated',
}

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum MessageStatus {
  WAITING_SESSION = 'waiting_session', // Waiting for active session with peer
  READY = 'ready',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
}

export enum MessageType {
  TEXT = 'text',
  ANNOUNCEMENT = 'announcement',
  KEEP_ALIVE = 'keep_alive',
  IMAGE = 'image',
  FILE = 'file',
  AUDIO = 'audio',
  VIDEO = 'video',
}

export interface readyAnnouncement {
  announcement_bytes: Uint8Array;
  when_to_send: Date;
}

export type SendAnnouncement = null | readyAnnouncement;

export interface Discussion {
  id?: number;
  ownerUserId: string; // The current user's userId owning this discussion
  contactUserId: string; // Reference to Contact.userId - unique per contact

  // Protocol/Encryption fields
  /*weAccepted: Whether the user has expressed the will to communicate with the peer 
  i.e. the user has initiated a new discussion or it accepted the discussion initiated by the peer. */
  weAccepted: boolean;
  sendAnnouncement: SendAnnouncement;
  direction: DiscussionDirection;
  lastSyncTimestamp?: Date; // Last time messages were synced from protocol

  // UI/Display fields
  customName?: string; // Optional custom name for the discussion (overrides contact name)
  lastAnnouncementMessage?: string; // ptional message from incoming announcement (the last one the user received)
  lastMessageId?: number;
  lastMessageContent?: string;
  lastMessageTimestamp?: Date;
  unreadCount: number;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
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
  counter?: string;
}

export interface ActiveSeeker {
  id?: number;
  seeker: Uint8Array;
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
  activeSeekers!: Table<ActiveSeeker>;

  constructor() {
    super('GossipDatabase');

    this.version(13).stores({
      contacts:
        '++id, ownerUserId, userId, name, isOnline, lastSeen, createdAt, [ownerUserId+userId] , [ownerUserId+name]',
      messages:
        '++id, ownerUserId, contactUserId, type, direction, status, timestamp, seeker, [ownerUserId+contactUserId], [ownerUserId+status], [ownerUserId+contactUserId+status], [ownerUserId+seeker], [ownerUserId+contactUserId+direction], [ownerUserId+direction+status]',
      userProfile: 'userId, username, status, lastSeen',
      discussions:
        '++id, ownerUserId, &[ownerUserId+contactUserId], status, [ownerUserId+status], lastSyncTimestamp, unreadCount, lastMessageTimestamp, createdAt, updatedAt',
      pendingEncryptedMessages: '++id, fetchedAt, seeker',
      pendingAnnouncements: '++id, fetchedAt, &announcement',
      activeSeekers: '++id, seeker',
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

  /** CONTACTS */
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

  /** DISCUSSIONS */
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
    if (!ownerUserId || !contactUserId) {
      return undefined;
    }
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
      .equals([ownerUserId, contactUserId, MessageStatus.DELIVERED])
      .and(msg => msg.direction === MessageDirection.INCOMING)
      .modify({ status: MessageStatus.READ });

    await this.discussions
      .where('[ownerUserId+contactUserId]')
      .equals([ownerUserId, contactUserId])
      .modify({ unreadCount: 0 });
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

  async addMessage(message: Omit<Message, 'id'>): Promise<number> {
    const messageId = await this.messages.add(message);

    // Get existing discussion
    const discussion = await this.getDiscussionByOwnerAndContact(
      message.ownerUserId,
      message.contactUserId
    );

    if (discussion) {
      await this.discussions.update(discussion.id!, {
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount:
          message.direction === MessageDirection.INCOMING
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
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount: message.direction === MessageDirection.INCOMING ? 1 : 0,
        updatedAt: new Date(),
      } as Discussion);
    }

    return messageId;
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

  /**
   * Set all active seekers, replacing any existing ones
   * @param seekers - Array of seeker Uint8Arrays to store
   */
  async setActiveSeekers(seekers: Uint8Array[]): Promise<void> {
    await this.transaction('rw', this.activeSeekers, async () => {
      // Clear all existing seekers
      await this.activeSeekers.clear();

      // Bulk add all new seekers
      if (seekers.length > 0) {
        await this.activeSeekers.bulkAdd(
          seekers.map(seeker => ({
            seeker,
          }))
        );
      }
    });
  }

  /**
   * Get all active seekers from the database
   * @returns Array of seeker Uint8Arrays
   */
  async getActiveSeekers(): Promise<Uint8Array[]> {
    const activeSeekers = await this.activeSeekers.toArray();
    return activeSeekers.map(item => item.seeker);
  }
}

// Database instance - lazily initialized singleton
let _db: GossipDatabase | null = null;

/**
 * Get the database instance. Creates a default instance on first call.
 */
export function gossipDb(): GossipDatabase {
  if (!_db || !(_db instanceof GossipDatabase)) {
    _db = new GossipDatabase();
  }
  return _db;
}
