import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const announcementCursors = sqliteTable('announcementCursors', {
  userId: text('userId').primaryKey(),
  counter: text('counter').notNull(),
});
