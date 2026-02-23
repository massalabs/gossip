import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers';

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
