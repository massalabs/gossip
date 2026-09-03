import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const PRIVATE_MIGRATION_FORMAT_VERSION = 1 as const;
export const PRIVATE_MIGRATION_PHASE_COUNT = 5 as const;
export const PRIVATE_MIGRATION_SINGLETON_ID = 1 as const;

/**
 * Encrypted, account-local restoration journal. Each secure-storage slot has
 * its own SQLite image, so the singleton reveals no account identity or slot
 * metadata outside the already encrypted namespace.
 */
export const privateMigration = sqliteTable('privateMigration', {
  id: integer('id').primaryKey(),
  formatVersion: integer('formatVersion')
    .notNull()
    .default(PRIVATE_MIGRATION_FORMAT_VERSION),
  installationEpoch: text('installationEpoch').notNull(),
  completedPhase: integer('completedPhase').notNull().default(0),
});
