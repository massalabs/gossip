import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { bytes } from './_helpers.js';

/**
 * The records of the group engine (`GroupsNode`), stored field by field as the
 * bindings encode them (JSON text, identifiers in lowercase hex). Every table is
 * scoped by the account (`ownerUserId`) and written only through the batches
 * the engine commits, one transaction per batch.
 *
 * What a group holds lives in these tables only: closing a group erases its
 * rows, edges and objects (`Batch.erase`) and deletes its node records, which
 * leaves a closed-chat marker (a chat ID) as the protocol allows.
 */

/** Event rows keyed by `(chat_id, eventId)`: held (role and the event's fields), pruned stub, or temporary-rejection marker. */
export const groupEventRows = sqliteTable(
  'groupEventRows',
  {
    ownerUserId: text('ownerUserId').notNull(),
    chatId: text('chatId').notNull(),
    eventId: text('eventId').notNull(),
    /** `held`, `pruned` or `marker`. */
    state: text('state').notNull(),
    fields: text('fields'),
  },
  table => [
    primaryKey({
      columns: [table.ownerUserId, table.chatId, table.eventId],
    }),
  ]
);

/** Parent edges of every processed event. */
export const groupEdges = sqliteTable(
  'groupEdges',
  {
    ownerUserId: text('ownerUserId').notNull(),
    chatId: text('chatId').notNull(),
    eventId: text('eventId').notNull(),
    parents: text('parents').notNull(),
  },
  table => [
    primaryKey({
      columns: [table.ownerUserId, table.chatId, table.eventId],
    }),
  ]
);

/** Current objects keyed by `(chat_id, syncObjId)`. */
export const groupObjects = sqliteTable(
  'groupObjects',
  {
    ownerUserId: text('ownerUserId').notNull(),
    chatId: text('chatId').notNull(),
    syncObjId: text('syncObjId').notNull(),
    fields: text('fields').notNull(),
  },
  table => [
    primaryKey({
      columns: [table.ownerUserId, table.chatId, table.syncObjId],
    }),
  ]
);

/**
 * The engine's device records (epochs, groups, signed objects, key cache,
 * markers, tasks, scans, requests, hints, queued work, peers…), one row per
 * record: `kind` is the engine's table, `key` its key.
 */
export const groupRecords = sqliteTable(
  'groupRecords',
  {
    ownerUserId: text('ownerUserId').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    fields: text('fields').notNull(),
  },
  table => [primaryKey({ columns: [table.ownerUserId, table.kind, table.key] })]
);

/**
 * The encrypted outbox of group plaintexts: a ciphertext stored before it is
 * sent and retried as stored (§15.3), deleted once the transport took it.
 * It names the recipient only, never a group.
 */
export const groupOutbox = sqliteTable(
  'groupOutbox',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    seeker: bytes('seeker').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    whenToSend: integer('whenToSend', { mode: 'timestamp_ms' }).notNull(),
  },
  table => [index('group_outbox_owner_idx').on(table.ownerUserId)]
);
