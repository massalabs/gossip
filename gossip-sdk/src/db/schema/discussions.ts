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
     * This device sent the contact request: it founds the direct chat once
     * the peer accepted (§5.12). Cleared when the chat is linked.
     */
    directChatOwed: integer('directChatOwed', { mode: 'boolean' })
      .notNull()
      .default(false),
    /**
     * The message timer (§7.7, milliseconds, 0 keeps messages forever) the
     * user chose when sending the contact request, for the direct chat this
     * device founds once it is accepted. Null: the account's default at that
     * time. Cleared when the chat is linked.
     */
    directChatTimer: integer('directChatTimer'),
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
