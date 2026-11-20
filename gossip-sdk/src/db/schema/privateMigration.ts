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
  /**
   * The journal was found from another generation (a backup imported): the
   * messaging sessions it holds were used elsewhere and are given up. Kept
   * until the user has been told.
   */
  sessionReset: integer('sessionReset', { mode: 'boolean' })
    .notNull()
    .default(false),
});
