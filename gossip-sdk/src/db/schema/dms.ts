import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { DiscussionDirection } from '../db';

export const dms = sqliteTable(
  'dms',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contactUserId: text('contactUserId').notNull(),
    accepted: integer('weAccepted', { mode: 'boolean' })
      .notNull()
      .default(false),
    direction: text('direction').$type<DiscussionDirection>().notNull(),
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
    messageRetentionDuration: integer('messageRetentionDuration'),
    retentionPolicySetAt: integer('retentionPolicySetAt'),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [uniqueIndex('dms_contact_idx').on(table.contactUserId)]
);
