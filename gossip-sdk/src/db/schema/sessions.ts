import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers.js';

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contactUserId: text('contactUserId').notNull(),
    announcement_bytes: bytes('announcement_bytes'),
    when_to_send: integer('when_to_send', { mode: 'timestamp_ms' }),
    killedNextRetryAt: integer('killedNextRetryAt', { mode: 'timestamp_ms' }),
    saturatedRetryAt: integer('saturatedRetryAt', { mode: 'timestamp_ms' }),
    saturatedRetryDone: integer('saturatedRetryDone', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [uniqueIndex('sessions_contact_idx').on(table.contactUserId)]
);
