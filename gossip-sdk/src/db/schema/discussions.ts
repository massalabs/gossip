import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { DiscussionDirection } from '../db';
import { bytes } from './_helpers.js';

export const discussions = sqliteTable(
  'discussions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    weAccepted: integer('weAccepted', { mode: 'boolean' })
      .notNull()
      .default(false),
    sendAnnouncement: text('sendAnnouncement'),
    direction: text('direction').$type<DiscussionDirection>().notNull(),
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
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    killedNextRetryAt: integer('killedNextRetryAt', { mode: 'timestamp_ms' }),
    saturatedRetryAt: integer('saturatedRetryAt', { mode: 'timestamp_ms' }),
    messageRetentionDuration: integer('messageRetentionDuration'),
    retentionPolicySetAt: integer('retentionPolicySetAt'), // nullable, ms timestamp when policy was last configured
    mutedNotifications: integer('mutedNotifications', { mode: 'boolean' })
      .notNull()
      .default(false),
    saturatedRetryDone: integer('saturatedRetryDone', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * It holds an earlier one-to-one conversation (format 0), shown read-only
     * as an archive: every discussion that existed before group chats.
     */
    isArchive: integer('isArchive', { mode: 'boolean' })
      .notNull()
      .default(false),
    /** The user moved it to the archived list. */
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    /**
     * The group key of the direct chat that continues it (§5.12): set when the
     * archive is migrated, a migration accepted, or a new contact's chat
     * founded or adopted.
     */
    linkedGroupId: text('linkedGroupId'),
    /**
     * 0.1.0 and 0.1.1 only: this device sent the contact request and was to
     * found the direct chat once accepted. No longer written nor read: a
     * contact request starts no chat (§5.12). Cleared when a chat is linked.
     */
    directChatOwed: integer('directChatOwed', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * 0.1.0 and 0.1.1 only: the message timer a contact request stated for
     * the chat it asked for. No longer written nor read (§5.12).
     */
    directChatTimer: integer('directChatTimer'),
    /**
     * When the session was last renewed because the server refused a send
     * at a seeker it already held (409): at most one such renewal an hour.
     */
    seekerConflictRenewedAt: integer('seekerConflictRenewedAt', {
      mode: 'timestamp_ms',
    }),
    /**
     * This device's latest announcement to the peer was made on its own
     * initiative (a request, a renewal) and the peer has not announced
     * itself since: the peer's next announcement answers it.
     */
    awaitingAnswer: integer('awaitingAnswer', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * When this device last answered a new announcement of the peer: it
     * answers at most one in ten minutes. Null if never.
     */
    renewalAnsweredAt: integer('renewalAnsweredAt', { mode: 'timestamp_ms' }),
    /**
     * A new announcement of the peer came within those ten minutes and is
     * answered once they end.
     */
    renewalAnswerOwed: integer('renewalAnswerOwed', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [
    uniqueIndex('discussions_owner_contact_idx').on(
      table.ownerUserId,
      table.contactUserId
    ),
  ]
);
