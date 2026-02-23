import { sqliteTable, integer, index } from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers';

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
