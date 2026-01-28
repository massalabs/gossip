/**
 * Gossip Database
 *
 * IndexedDB database implementation using Dexie for the Gossip messenger.
 * Provides tables for contacts, messages, discussions, user profiles, and more.
 */

import Dexie, { Table } from 'dexie';

// Define authentication method type
export type AuthMethod = 'capacitor' | 'webauthn' | 'password';

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
  ownerUserId: string; // The current user's userId owning this message
  contactUserId: string; // Reference to Contact.userId
  content: string;
  serializedContent?: Uint8Array; // Serialized message content
  type: MessageType;
  direction: MessageDirection;
  status: MessageStatus;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  seeker?: Uint8Array; // Seeker for this message (stored when sending or receiving)
  replyTo?: {
    originalContent?: string;
    originalSeeker: Uint8Array; // Seeker of the original message (required for replies)
  };
  forwardOf?: {
    originalContent?: string;
    originalSeeker: Uint8Array;
  };
  encryptedMessage?: Uint8Array; // Ciphertext of the message
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

// Unified discussion interface combining protocol state and UI metadata

export enum DiscussionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  CLOSED = 'closed', // closed by the user
  BROKEN = 'broken', // The session is killed. Need to be reinitiated
  SEND_FAILED = 'sendFailed', // The discussion was initiated by the session manager but could not be broadcasted on network
  RECONNECTING = 'reconnecting', // Session recovery in progress, waiting for peer's response
}

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum MessageStatus {
  WAITING_SESSION = 'waiting_session', // Waiting for active session with peer
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed', // Only for unrecoverable errors (network down, blocked, etc.)
}

export enum DiscussionDirection {
  INITIATED = 'initiated',
  RECEIVED = 'received',
}

export enum MessageType {
  TEXT = 'text',
  KEEP_ALIVE = 'keep_alive',
  IMAGE = 'image',
  FILE = 'file',
  AUDIO = 'audio',
  VIDEO = 'video',
}

export interface Discussion {
  id?: number;
  ownerUserId: string; // The current user's userId owning this discussion
  contactUserId: string; // Reference to Contact.userId - unique per contact

  // Protocol/Encryption fields
  direction: DiscussionDirection; // Whether this user initiated or received the discussion
  status: DiscussionStatus;
  nextSeeker?: Uint8Array; // The next seeker for sending messages (from SendMessageOutput)
  initiationAnnouncement?: Uint8Array; // Outgoing announcement bytes when we initiate
  announcementMessage?: string; // Optional message from incoming announcement (user_data)
  lastSyncTimestamp?: Date; // Last time messages were synced from protocol

  // UI/Display fields
  customName?: string; // Optional custom name for the discussion (overrides contact name)
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

  /**
   * Get all active discussions with their sync status
   * @returns Array of active discussions
   */
  async getActiveDiscussionsByOwner(
    ownerUserId: string
  ): Promise<Discussion[]> {
    return await this.discussions
      .where('[ownerUserId+status]')
      .equals([ownerUserId, DiscussionStatus.ACTIVE])
      .toArray();
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
        direction:
          message.direction === MessageDirection.INCOMING
            ? DiscussionDirection.RECEIVED
            : DiscussionDirection.INITIATED,
        status: DiscussionStatus.PENDING,
        nextSeeker: undefined,
        lastMessageId: messageId,
        lastMessageContent: message.content,
        lastMessageTimestamp: message.timestamp,
        unreadCount: message.direction === MessageDirection.INCOMING ? 1 : 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
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

// Database instance - initialized lazily or via setDb()
let _db: GossipDatabase | null = null;
let _warnedGlobalDbAccess = false;

/**
 * Get the database instance.
 * Creates a default instance if none was set via setDb().
 */
export function getDb(): GossipDatabase {
  if (!_db) {
    _db = new GossipDatabase();
  }
  return _db;
}

/**
 * Set the database instance.
 * Call this before using any SDK functions if you need a custom db instance.
 */
export function setDb(database: GossipDatabase): void {
  _db = database;
}

/**
 * Get the database instance.
 * Creates a default instance if none was set via setDb().
 */
export const db: GossipDatabase = new Proxy({} as GossipDatabase, {
  get(_target, prop) {
    if (!_warnedGlobalDbAccess) {
      _warnedGlobalDbAccess = true;
      console.warn(
        '[GossipSdk] Global db access is deprecated. Use createGossipSdk() or setDb().'
      );
    }
    const target = getDb();
    const value = Reflect.get(target, prop);
    if (typeof value === 'function') {
      return value.bind(target);
    }
    return value;
  },
});
