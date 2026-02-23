import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers';

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
    security: text('security').notNull(),
    session: bytes('session').notNull(),
  },
  table => [
    index('userProfile_username_idx').on(table.username),
    index('userProfile_status_idx').on(table.status),
  ]
);
