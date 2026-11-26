import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

/**
 * Relays heard on the radio: temporary copies of group messages sent online,
 * put on the air for members who only have radio. Shown until the message
 * itself arrives (its `syncObjId` starts with `syncRef`), then ignored.
 */
export const radioRelays = sqliteTable(
  'radioRelays',
  {
    ownerUserId: text('ownerUserId').notNull(),
    /** The group key, lowercase hex. */
    groupId: text('groupId').notNull(),
    /** The first 8 bytes of the message's `syncObjId`, lowercase hex. */
    syncRef: text('syncRef').notNull(),
    /** The epoch it was opened with, lowercase hex. */
    chatId: text('chatId').notNull(),
    /** The message's author (Gossip user ID). */
    author: text('author').notNull(),
    /** The message's creation time, Unix milliseconds. */
    createdAt: integer('createdAt').notNull(),
    text: text('text').notNull(),
    /** The text was cut to fit the radio. */
    truncated: integer('truncated', { mode: 'boolean' }).notNull(),
    /** Opened with an epoch this device knows to be superseded. */
    olderKey: integer('olderKey', { mode: 'boolean' }).notNull(),
    atMillis: integer('atMillis').notNull(),
  },
  table => [
    primaryKey({ columns: [table.ownerUserId, table.syncRef] }),
    index('radioRelays_group_idx').on(table.ownerUserId, table.groupId),
  ]
);
