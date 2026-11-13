import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/**
 * Contacts the user deleted, with the timestamp of the latest announcement the
 * session manager had accepted from them: announcements dated at or before it
 * are replays (a mesh can bring old ones back at any time) and must not bring
 * the contact back.
 */
export const discardedPeers = sqliteTable(
  'discardedPeers',
  {
    ownerUserId: text('ownerUserId').notNull(),
    userId: text('userId').notNull(),
    announcementFloorMillis: integer('announcementFloorMillis').notNull(),
  },
  table => [primaryKey({ columns: [table.ownerUserId, table.userId] })]
);
