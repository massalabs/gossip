import { sqliteTable, integer, index } from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers';

export const activeSeekers = sqliteTable(
  'activeSeekers',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    seeker: bytes('seeker').notNull(),
  },
  table => [index('active_seekers_seeker_idx').on(table.seeker)]
);
