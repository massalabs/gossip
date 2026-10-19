import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Bulletin cursors of the secondary transports (a mesh node), by account, as
 * a JSON array in transport order, so a restart does not read their whole
 * bulletin again.
 */
export const transportCursors = sqliteTable('transportCursors', {
  userId: text('userId').primaryKey(),
  cursors: text('cursors').notNull(),
});
