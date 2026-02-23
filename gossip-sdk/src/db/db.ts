/**
 * Gossip Database Types
 *
 * Type definitions for the Gossip messenger data models.
 * Database operations use SQLite via Drizzle ORM (see sqlite.ts and schema.ts).
 */

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
  avatar?: string | null;
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
  avatar?: string | null;
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
  SENDING = 'sending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed', // Only for unrecoverable errors (network down, blocked, etc.)
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

export interface ReadyAnnouncement {
  announcement_bytes: Uint8Array;
  when_to_send: Date;
}

export type SendAnnouncement = null | ReadyAnnouncement;

/** Serialize a SendAnnouncement to a JSON string for SQLite text column */
export function serializeSendAnnouncement(
  announcement: ReadyAnnouncement
): string {
  return JSON.stringify({
    announcement_bytes: Array.from(announcement.announcement_bytes),
    when_to_send: announcement.when_to_send.toISOString(),
  });
}

/** Deserialize a SendAnnouncement JSON string from SQLite back to an object */
export function deserializeSendAnnouncement(json: string): ReadyAnnouncement {
  const parsed = JSON.parse(json);
  return {
    announcement_bytes: new Uint8Array(parsed.announcement_bytes),
    when_to_send: new Date(parsed.when_to_send),
  };
}

/** Convert a raw SQLite discussion row to a Discussion object.
 *  Deserializes sendAnnouncement from JSON text to SendAnnouncement. */
export function rowToDiscussion(row: Record<string, unknown>): Discussion {
  return {
    ...row,
    sendAnnouncement:
      typeof row.sendAnnouncement === 'string'
        ? deserializeSendAnnouncement(row.sendAnnouncement)
        : null,
    lastAnnouncementMessage:
      (row.announcementMessage as string | null) ?? undefined,
  } as Discussion;
}

export interface Discussion {
  id?: number;
  ownerUserId: string; // The current user's userId owning this discussion
  contactUserId: string; // Reference to Contact.userId - unique per contact

  // Protocol/Encryption fields
  /*weAccepted: Whether the user has expressed the will to communicate with the peer
  i.e. the user has initiated a new discussion or it accepted the discussion initiated by the peer. */
  weAccepted: boolean;
  sendAnnouncement: SendAnnouncement;
  direction: DiscussionDirection; // Whether this user initiated or received the discussion
  status: DiscussionStatus;
  nextSeeker: Uint8Array | null; // The next seeker for sending messages (from SendMessageOutput)
  initiationAnnouncement: Uint8Array | null; // Outgoing announcement bytes when we initiate
  announcementMessage: string | null; // Optional message from incoming announcement (user_data)
  lastSyncTimestamp: Date | null; // Last time messages were synced from protocol

  // UI/Display fields
  customName: string | null; // Optional custom name for the discussion (overrides contact name)
  lastAnnouncementMessage?: string; // Last message from incoming announcement (the last one the user received)
  lastMessageId: number | null;
  lastMessageContent: string | null;
  lastMessageTimestamp: Date | null;
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
