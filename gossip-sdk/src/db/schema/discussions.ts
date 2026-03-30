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
