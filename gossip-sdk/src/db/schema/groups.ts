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
    /**
     * Whether the device may offer this record's events on its own initiative
     * (`ObjectRecord::shareable`, §7.7, §14.1). `false` for a deletion kept
     * for a message the device never processed, under a message timer: never
     * announced nor listed in a tips scan, still served on a direct request.
     *
     * No default, on purpose: every write states it, and a write that does not
     * is refused. A forgotten value would make a quiet record shareable, and
     * its deletion could then be renewed between devices forever.
     */
    shareable: integer('shareable', { mode: 'boolean' }).notNull(),
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
 * sent and retried as stored (§15.3), deleted once the backend took it, or
 * once a transport did when no backend is in use. It names the recipient
 * only, never a group.
 *
 * `meshOnlySince` marks a ciphertext that only a mesh took (the message is
 * sent; the backend has not got it yet): it stays to be posted to the backend
 * when one answers, at `whenToSend`, until the network's retention ends.
 */
export const groupOutbox = sqliteTable(
  'groupOutbox',
  {
    // A rowid key without AUTOINCREMENT: no sqlite_sequence counter keeps a
    // count of the group ciphertexts ever stored.
    id: integer('id').primaryKey(),
    ownerUserId: text('ownerUserId').notNull(),
    contactUserId: text('contactUserId').notNull(),
    seeker: bytes('seeker').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    whenToSend: integer('whenToSend', { mode: 'timestamp_ms' }).notNull(),
    meshOnlySince: integer('meshOnlySince', { mode: 'timestamp_ms' }),
  },
  table => [index('group_outbox_owner_idx').on(table.ownerUserId)]
);
