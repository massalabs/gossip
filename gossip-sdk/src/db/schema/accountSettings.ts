import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const ACCOUNT_SETTINGS_FORMAT_VERSION = 1 as const;
export const DEFAULT_RETENTION_DURATION_SECONDS = 2_592_000;

export const accountSettings = sqliteTable('accountSettings', {
  userId: text('userId').primaryKey(),
  formatVersion: integer('formatVersion')
    .notNull()
    .default(ACCOUNT_SETTINGS_FORMAT_VERSION),
  mnsEnabled: integer('mnsEnabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  defaultRetentionDuration: integer('defaultRetentionDuration').default(
    DEFAULT_RETENTION_DURATION_SECONDS
  ),
});
