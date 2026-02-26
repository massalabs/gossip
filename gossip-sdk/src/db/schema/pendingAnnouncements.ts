import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers.js';

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
