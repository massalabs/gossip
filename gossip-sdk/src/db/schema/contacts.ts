import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers.js';
import type { ContactConnection } from '../db.js';

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
    /**
     * `accepted`: the user accepted this contact. `automatic`: only a
     * connection opened for a group (§5.12), revoked once no group needs it.
     * `requested`: an automatic connection whose peer also asked to become a
     * contact; shown as a request until the user answers it.
     */
    connection: text('connection')
      .$type<ContactConnection>()
      .notNull()
      .default('accepted'),
  },
  table => [
    index('contacts_owner_user_idx').on(table.ownerUserId, table.userId),
    index('contacts_owner_name_idx').on(table.ownerUserId, table.name),
  ]
);
