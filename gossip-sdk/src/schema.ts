/**
 * Drizzle ORM schema for the Gossip SDK database.
 *
 * IMPORTANT: The raw DDL in sqlite.ts must stay in sync with these definitions.
 * When adding/removing/renaming columns, tables, or indexes, update BOTH files.
 *
 * Type mappings from SQLite:
 *   Date       → integer (epoch milliseconds)
 *   boolean    → integer (0/1)
 *   Uint8Array → blob (wa-sqlite handles natively)
 *   JSON       → text (JSON.stringify/parse in service layer)
 */

import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/sqlite-core';
import type {
  DiscussionDirection,
  DiscussionStatus,
  MessageDirection,
  MessageStatus,
  MessageType,
} from './db';

// Custom blob type — wa-sqlite returns Uint8Array natively for BLOB columns.
// Drizzle's built-in blob mode converts to/from hex strings, which breaks
// with wa-sqlite's direct Uint8Array handling. This custom type passes through.
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'blob';
  },
  fromDriver(value) {
    return value;
  },
  toDriver(value) {
    return value;
  },
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------
export const contacts = sqliteTable(
  'contacts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    userId: text('userId').notNull(),
    name: text('name').notNull(),
    avatar: text('avatar'),
    publicKeys: bytes('publicKeys').notNull(),
    isOnline: integer('isOnline', { mode: 'boolean' }).notNull(),
    lastSeen: integer('lastSeen', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    index('contacts_owner_user_idx').on(table.ownerUserId, table.userId),
    index('contacts_owner_name_idx').on(table.ownerUserId, table.name),
  ]
);

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    messageId: bytes('messageId'), // 12-byte random ID for deduplication
    content: text('content').notNull(),
    serializedContent: bytes('serializedContent'),
    type: text('type').$type<MessageType>().notNull(),
    direction: text('direction').$type<MessageDirection>().notNull(),
    status: text('status').$type<MessageStatus>().notNull(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
    metadata: text('metadata'), // JSON — service layer handles stringify/parse
    seeker: bytes('seeker'),
    replyTo: text('replyTo'), // JSON — contains Uint8Array fields (base64 encoded)
    forwardOf: text('forwardOf'), // JSON — contains Uint8Array fields (base64 encoded)
    encryptedMessage: bytes('encryptedMessage'),
    whenToSend: integer('whenToSend', { mode: 'timestamp_ms' }),
  },
  table => [
    index('messages_owner_contact_idx').on(
      table.ownerUserId,
      table.contactUserId
    ),
    index('messages_owner_status_idx').on(table.ownerUserId, table.status),
    index('messages_owner_contact_status_idx').on(
      table.ownerUserId,
      table.contactUserId,
      table.status
    ),
    index('messages_owner_seeker_idx').on(table.ownerUserId, table.seeker),
    index('messages_owner_contact_dir_idx').on(
      table.ownerUserId,
      table.contactUserId,
      table.direction
    ),
    index('messages_owner_dir_status_idx').on(
      table.ownerUserId,
      table.direction,
      table.status
    ),
    index('messages_timestamp_idx').on(table.timestamp),
  ]
);

// ---------------------------------------------------------------------------
// userProfile
// ---------------------------------------------------------------------------
export const userProfile = sqliteTable(
  'userProfile',
  {
    userId: text('userId').primaryKey(),
    username: text('username').notNull(),
    avatar: text('avatar'),
    bio: text('bio'),
    status: text('status').notNull(),
    lastSeen: integer('lastSeen', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
    lastPublicKeyPush: integer('lastPublicKeyPush', {
      mode: 'timestamp_ms',
    }),
    security: text('security').notNull(), // JSON — contains Uint8Array fields (base64 encoded)
    session: bytes('session').notNull(),
  },
  table => [
    index('userProfile_username_idx').on(table.username),
    index('userProfile_status_idx').on(table.status),
  ]
);

// ---------------------------------------------------------------------------
// discussions
// ---------------------------------------------------------------------------
export const discussions = sqliteTable(
  'discussions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    weAccepted: integer('weAccepted', { mode: 'boolean' })
      .notNull()
      .default(false),
    sendAnnouncement: text('sendAnnouncement'), // JSON — nullable
    direction: text('direction').$type<DiscussionDirection>().notNull(),
    status: text('status').$type<DiscussionStatus>().notNull(),
    nextSeeker: bytes('nextSeeker'),
    initiationAnnouncement: bytes('initiationAnnouncement'),
    announcementMessage: text('announcementMessage'),
    lastSyncTimestamp: integer('lastSyncTimestamp', {
      mode: 'timestamp_ms',
    }),
    customName: text('customName'),
    lastMessageId: integer('lastMessageId'),
    lastMessageContent: text('lastMessageContent'),
    lastMessageTimestamp: integer('lastMessageTimestamp', {
      mode: 'timestamp_ms',
    }),
    unreadCount: integer('unreadCount').notNull().default(0),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    uniqueIndex('discussions_owner_contact_idx').on(
      table.ownerUserId,
      table.contactUserId
    ),
    index('discussions_owner_status_idx').on(table.ownerUserId, table.status),
  ]
);

// ---------------------------------------------------------------------------
// pendingEncryptedMessages
// ---------------------------------------------------------------------------
export const pendingEncryptedMessages = sqliteTable(
  'pendingEncryptedMessages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seeker: bytes('seeker').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    fetchedAt: integer('fetchedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    index('pending_encrypted_seeker_idx').on(table.seeker),
    index('pending_encrypted_fetchedAt_idx').on(table.fetchedAt),
  ]
);

// ---------------------------------------------------------------------------
// pendingAnnouncements
// ---------------------------------------------------------------------------
export const pendingAnnouncements = sqliteTable(
  'pendingAnnouncements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    announcement: bytes('announcement').notNull(),
    fetchedAt: integer('fetchedAt', { mode: 'timestamp_ms' }).notNull(),
    counter: text('counter'),
  },
  table => [
    uniqueIndex('pending_announcements_announcement_idx').on(
      table.announcement
    ),
    index('pending_announcements_fetchedAt_idx').on(table.fetchedAt),
  ]
);

// ---------------------------------------------------------------------------
// activeSeekers
// ---------------------------------------------------------------------------
export const activeSeekers = sqliteTable(
  'activeSeekers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seeker: bytes('seeker').notNull(),
  },
  table => [index('active_seekers_seeker_idx').on(table.seeker)]
);

// ---------------------------------------------------------------------------
// announcementCursors
// ---------------------------------------------------------------------------
export const announcementCursors = sqliteTable('announcementCursors', {
  userId: text('userId').primaryKey(),
  counter: text('counter').notNull(),
});
