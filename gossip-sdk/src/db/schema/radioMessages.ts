import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/**
 * Group messages that travelled by radio (MeshCore), for the interface only:
 * the events themselves are ordinary group events in the group tables. A
 * message received with an older group key is shown with a warning.
 */
export const radioMessages = sqliteTable(
  'radioMessages',
  {
    ownerUserId: text('ownerUserId').notNull(),
    /** The group event's ID, lowercase hex. */
    eventId: text('eventId').notNull(),
    /** Its message (sync object), lowercase hex: how the timeline names it. */
    syncObjId: text('syncObjId').notNull(),
    /** The epoch it belongs to, lowercase hex. */
    chatId: text('chatId').notNull(),
    /** `sent` by this device, or `received` from the radio. */
    direction: text('direction').notNull(),
    /** Received under an epoch this device knows to be superseded. */
    olderKey: integer('olderKey', { mode: 'boolean' }).notNull(),
    atMillis: integer('atMillis').notNull(),
  },
  table => [
    primaryKey({ columns: [table.ownerUserId, table.eventId] }),
    index('radioMessages_sync_obj_idx').on(table.ownerUserId, table.syncObjId),
  ]
);
