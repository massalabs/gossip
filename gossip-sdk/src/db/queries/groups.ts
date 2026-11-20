import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';
import type { DbContext } from './sqlBatch.js';

/** An event row as the engine bindings encode it. */
export interface GroupRowOut {
  chatId: string;
  eventId: string;
  state: string;
  fields?: string | null;
}

/**
 * One batch committed by the group engine (`GroupsNode.take_batches`). The
 * `removed…` lists delete one record each: a temporary-rejection marker, or
 * what the message timer erases of a message (its object, the rows of its
 * events and their parent edges). A key is never both written and removed by
 * one batch.
 */
export interface GroupBatch {
  rows: GroupRowOut[];
  removedRows: { chatId: string; eventId: string }[];
  edges: { chatId: string; eventId: string; parents: string }[];
  removedEdges: { chatId: string; eventId: string }[];
  objects: { chatId: string; syncObjId: string; fields: string }[];
  removedObjects: { chatId: string; syncObjId: string }[];
  node: { kind: string; key: string; fields?: string | null }[];
  erase: string[];
}

/** Every stored record of an account, to open the engine from. */
export type GroupSnapshot = Omit<
  GroupBatch,
  'removedRows' | 'removedEdges' | 'removedObjects' | 'erase'
>;

export type GroupOutboxRow = typeof schema.groupOutbox.$inferSelect;

export class GroupQueries {
  constructor(private conn: DatabaseConnection) {}

  async loadSnapshot(ownerUserId: string): Promise<GroupSnapshot> {
    const db = this.conn.db;
    const rows = await db
      .select()
      .from(schema.groupEventRows)
      .where(eq(schema.groupEventRows.ownerUserId, ownerUserId))
      .all();
    const edges = await db
      .select()
      .from(schema.groupEdges)
      .where(eq(schema.groupEdges.ownerUserId, ownerUserId))
      .all();
    const objects = await db
      .select()
      .from(schema.groupObjects)
      .where(eq(schema.groupObjects.ownerUserId, ownerUserId))
      .all();
    const node = await db
      .select()
      .from(schema.groupRecords)
      .where(eq(schema.groupRecords.ownerUserId, ownerUserId))
      .all();
    return {
      rows: rows.map(r => ({
        chatId: r.chatId,
        eventId: r.eventId,
        state: r.state,
        fields: r.fields,
      })),
      edges: edges.map(e => ({
        chatId: e.chatId,
        eventId: e.eventId,
        parents: e.parents,
      })),
      objects: objects.map(o => ({
        chatId: o.chatId,
        syncObjId: o.syncObjId,
        fields: o.fields,
      })),
      node: node.map(n => ({ kind: n.kind, key: n.key, fields: n.fields })),
    };
  }

  /**
   * Applies the engine's batches in order, all in one transaction (each batch
   * stays all-or-nothing). Optionally stores an outbox ciphertext in the same
   * transaction.
   */
  async applyBatches(
    ownerUserId: string,
    batches: GroupBatch[],
    extra?: (tx: DbContext) => Promise<void>
  ): Promise<void> {
    if (batches.length === 0 && !extra) return;
    await this.conn.withTransaction(async tx => {
      for (const b of batches) await applyBatch(tx, ownerUserId, b);
      if (extra) await extra(tx);
    });
  }

  async insertOutbox(
    tx: DbContext,
    row: Omit<typeof schema.groupOutbox.$inferInsert, 'id'>
  ): Promise<number> {
    const r = await tx
      .insert(schema.groupOutbox)
      .values(row)
      .returning({ id: schema.groupOutbox.id })
      .get();
    return r.id;
  }

  async dueOutbox(ownerUserId: string, now: Date): Promise<GroupOutboxRow[]> {
    return this.conn.db
      .select()
      .from(schema.groupOutbox)
      .where(
        and(
          eq(schema.groupOutbox.ownerUserId, ownerUserId),
          lte(schema.groupOutbox.whenToSend, now)
        )
      )
      .orderBy(asc(schema.groupOutbox.id))
      .all();
  }

  /** When the next stored ciphertext is due to be sent again, if any. */
  async nextOutboxRetry(ownerUserId: string): Promise<Date | null> {
    const row = await this.conn.db
      .select({ at: schema.groupOutbox.whenToSend })
      .from(schema.groupOutbox)
      .where(eq(schema.groupOutbox.ownerUserId, ownerUserId))
      .orderBy(asc(schema.groupOutbox.whenToSend))
      .limit(1)
      .get();
    return row?.at ?? null;
  }

  /** Deletes the ciphertexts waiting for a contact (when it is deleted). */
  async deleteOutboxByContact(
    ownerUserId: string,
    contactUserId: string,
    tx?: DbContext
  ): Promise<void> {
    await (tx ?? this.conn.db)
      .delete(schema.groupOutbox)
      .where(
        and(
          eq(schema.groupOutbox.ownerUserId, ownerUserId),
          eq(schema.groupOutbox.contactUserId, contactUserId)
        )
      );
  }

  async deleteOutbox(id: number): Promise<void> {
    await this.conn.db
      .delete(schema.groupOutbox)
      .where(eq(schema.groupOutbox.id, id));
  }

  async rescheduleOutbox(id: number, whenToSend: Date): Promise<void> {
    await this.conn.db
      .update(schema.groupOutbox)
      .set({ whenToSend })
      .where(eq(schema.groupOutbox.id, id));
  }

  /** Erases every group record of the account. */
  /**
   * Erases the group engine's own records of an account (rows, edges,
   * objects and node records), in one transaction. The outbox stays: its
   * ciphertexts were encrypted already and must still be sent in order.
   */
  async resetEngine(ownerUserId: string): Promise<void> {
    await this.conn.withTransaction(async tx => {
      await this.deleteEngineRecords(ownerUserId, tx);
    });
  }

  private async deleteEngineRecords(
    ownerUserId: string,
    db: DbContext
  ): Promise<void> {
    await db
      .delete(schema.groupEventRows)
      .where(eq(schema.groupEventRows.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupEdges)
      .where(eq(schema.groupEdges.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupObjects)
      .where(eq(schema.groupObjects.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupRecords)
      .where(eq(schema.groupRecords.ownerUserId, ownerUserId));
  }

  async deleteByOwner(ownerUserId: string, tx?: DbContext): Promise<void> {
    const db = tx ?? this.conn.db;
    await db
      .delete(schema.groupEventRows)
      .where(eq(schema.groupEventRows.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupEdges)
      .where(eq(schema.groupEdges.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupObjects)
      .where(eq(schema.groupObjects.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupRecords)
      .where(eq(schema.groupRecords.ownerUserId, ownerUserId));
    await db
      .delete(schema.groupOutbox)
      .where(eq(schema.groupOutbox.ownerUserId, ownerUserId));
  }
}

async function applyBatch(
  tx: DbContext,
  owner: string,
  b: GroupBatch
): Promise<void> {
  const t = schema;
  for (const r of b.rows) {
    const fields = r.fields ?? null;
    await tx
      .insert(t.groupEventRows)
      .values({
        ownerUserId: owner,
        chatId: r.chatId,
        eventId: r.eventId,
        state: r.state,
        fields,
      })
      .onConflictDoUpdate({
        target: [
          t.groupEventRows.ownerUserId,
          t.groupEventRows.chatId,
          t.groupEventRows.eventId,
        ],
        set: { state: r.state, fields },
      });
  }
  for (const k of b.removedRows) {
    await tx
      .delete(t.groupEventRows)
      .where(
        and(
          eq(t.groupEventRows.ownerUserId, owner),
          eq(t.groupEventRows.chatId, k.chatId),
          eq(t.groupEventRows.eventId, k.eventId)
        )
      );
  }
  for (const e of b.edges) {
    await tx
      .insert(t.groupEdges)
      .values({ ownerUserId: owner, ...e })
      .onConflictDoUpdate({
        target: [
          t.groupEdges.ownerUserId,
          t.groupEdges.chatId,
          t.groupEdges.eventId,
        ],
        set: { parents: e.parents },
      });
  }
  for (const k of b.removedEdges) {
    await tx
      .delete(t.groupEdges)
      .where(
        and(
          eq(t.groupEdges.ownerUserId, owner),
          eq(t.groupEdges.chatId, k.chatId),
          eq(t.groupEdges.eventId, k.eventId)
        )
      );
  }
  for (const o of b.objects) {
    await tx
      .insert(t.groupObjects)
      .values({ ownerUserId: owner, ...o })
      .onConflictDoUpdate({
        target: [
          t.groupObjects.ownerUserId,
          t.groupObjects.chatId,
          t.groupObjects.syncObjId,
        ],
        set: { fields: o.fields },
      });
  }
  for (const k of b.removedObjects) {
    await tx
      .delete(t.groupObjects)
      .where(
        and(
          eq(t.groupObjects.ownerUserId, owner),
          eq(t.groupObjects.chatId, k.chatId),
          eq(t.groupObjects.syncObjId, k.syncObjId)
        )
      );
  }
  if (b.erase.length > 0) {
    for (const table of [t.groupEventRows, t.groupEdges, t.groupObjects]) {
      await tx
        .delete(table)
        .where(
          and(eq(table.ownerUserId, owner), inArray(table.chatId, b.erase))
        );
    }
  }
  for (const n of b.node) {
    const where = and(
      eq(t.groupRecords.ownerUserId, owner),
      eq(t.groupRecords.kind, n.kind),
      eq(t.groupRecords.key, n.key)
    );
    if (n.fields == null) {
      await tx.delete(t.groupRecords).where(where);
    } else {
      await tx
        .insert(t.groupRecords)
        .values({
          ownerUserId: owner,
          kind: n.kind,
          key: n.key,
          fields: n.fields,
        })
        .onConflictDoUpdate({
          target: [
            t.groupRecords.ownerUserId,
            t.groupRecords.kind,
            t.groupRecords.key,
          ],
          set: { fields: n.fields },
        });
    }
  }
}
