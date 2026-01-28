/**
 * Shared data models for storage layer.
 * These are the canonical types used across all storage backends.
 */

// ============ Enums ============

export enum MessageDirection {
  INCOMING = 'incoming',
  OUTGOING = 'outgoing',
}

export enum MessageStatus {
  WAITING_SESSION = 'waiting_session',
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export enum MessageType {
  TEXT = 'text',
  KEEP_ALIVE = 'keep_alive',
  IMAGE = 'image',
  FILE = 'file',
  AUDIO = 'audio',
  VIDEO = 'video',
}

export enum DiscussionStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  CLOSED = 'closed',
  BROKEN = 'broken',
  SEND_FAILED = 'sendFailed',
  RECONNECTING = 'reconnecting',
}

export enum DiscussionDirection {
  INITIATED = 'initiated',
  RECEIVED = 'received',
}

export type AuthMethod = 'capacitor' | 'webauthn' | 'password';

// ============ Entity Interfaces ============

export interface Contact {
  id?: number;
  ownerUserId: string;
  userId: string;
  name: string;
  avatar?: string;
  publicKeys: Uint8Array;
  isOnline: boolean;
  lastSeen: Date;
  createdAt: Date;
}

export interface Message {
  id?: number;
  ownerUserId: string;
  contactUserId: string;
  content: string;
  serializedContent?: Uint8Array;
  type: MessageType;
  direction: MessageDirection;
  status: MessageStatus;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  seeker?: Uint8Array;
  replyTo?: {
    originalContent?: string;
    originalSeeker: Uint8Array;
  };
  forwardOf?: {
    originalContent?: string;
    originalSeeker: Uint8Array;
  };
  encryptedMessage?: Uint8Array;
}

export interface UserProfile {
  userId: string;
  username: string;
  avatar?: string;
  security: {
    encKeySalt: Uint8Array;
    authMethod: AuthMethod;
    webauthn?: {
      credentialId?: string;
    };
    iCloudSync?: boolean;
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

export interface Discussion {
  id?: number;
  ownerUserId: string;
  contactUserId: string;
  direction: DiscussionDirection;
  status: DiscussionStatus;
  nextSeeker?: Uint8Array;
  initiationAnnouncement?: Uint8Array;
  announcementMessage?: string;
  lastSyncTimestamp?: Date;
  customName?: string;
  lastMessageId?: number;
  lastMessageContent?: string;
  lastMessageTimestamp?: Date;
  unreadCount: number;
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

// ============ Helper Types ============

/** Entity with required ID (after persistence) */
export type Persisted<T extends { id?: number }> = T & { id: number };

/** Omit ID for creation */
export type CreateInput<T extends { id?: number }> = Omit<T, 'id'>;

/** Partial update (ID required separately) */
export type UpdateInput<T extends { id?: number }> = Partial<Omit<T, 'id'>>;
