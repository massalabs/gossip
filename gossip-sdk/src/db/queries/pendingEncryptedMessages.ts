import { asc, inArray, lt } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export type PendingEncryptedMessageRow =
  typeof schema.pendingEncryptedMessages.$inferSelect;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Distinct values kept at one seeker. Only one is the real message; the rest
 * is what anyone who learnt the seeker posted there (it is on the mesh's
 * wanted list), so a few are enough to keep the real one among them.
 */
export const MAX_PENDING_PER_SEEKER = 4;

/** Rows kept in all; the oldest go first. */
export const MAX_PENDING_ROWS = 2048;

/**
 * Messages pushed by a transport (for example a mesh node) rather than
 * fetched, kept until the fetch loop reads them at their seeker.
 */
export class PendingEncryptedMessageQueries {
  constructor(private conn: DatabaseConnection) {}

  /** Stores the messages not held yet; returns how many were new. */
  async insertNew(
    messages: { seeker: Uint8Array; ciphertext: Uint8Array }[]
  ): Promise<number> {
    if (messages.length === 0) return 0;
    return this.conn.withTransaction(async tx => {
      const existing = await tx
        .select()
        .from(schema.pendingEncryptedMessages)
        .where(
          inArray(
            schema.pendingEncryptedMessages.seeker,
            messages.map(m => m.seeker)
          )
        )
        .all();
      const fresh = messages.filter(
        (m, index) =>
          !existing.some(
            row =>
              sameBytes(row.seeker, m.seeker) &&
              sameBytes(row.ciphertext, m.ciphertext)
          ) &&
          // and not a repeat within this batch
          messages.findIndex(
            other =>
              sameBytes(other.seeker, m.seeker) &&
              sameBytes(other.ciphertext, m.ciphertext)
          ) === index
      );
      // at most MAX_PENDING_PER_SEEKER values per seeker, first come first kept
      const held = new Map<string, number>();
      const key = (seeker: Uint8Array) => seeker.join(',');
      for (const row of existing) {
        held.set(key(row.seeker), (held.get(key(row.seeker)) ?? 0) + 1);
      }
      const kept = fresh.filter(m => {
        const count = held.get(key(m.seeker)) ?? 0;
        if (count >= MAX_PENDING_PER_SEEKER) return false;
        held.set(key(m.seeker), count + 1);
        return true;
      });
      if (kept.length > 0) {
        const fetchedAt = new Date();
        await tx
          .insert(schema.pendingEncryptedMessages)
          .values(kept.map(m => ({ ...m, fetchedAt })));

        const ids = await tx
          .select({ id: schema.pendingEncryptedMessages.id })
          .from(schema.pendingEncryptedMessages)
          .orderBy(asc(schema.pendingEncryptedMessages.id))
          .all();
        const excess = ids.length - MAX_PENDING_ROWS;
        if (excess > 0) {
          await tx.delete(schema.pendingEncryptedMessages).where(
            inArray(
              schema.pendingEncryptedMessages.id,
              ids.slice(0, excess).map(row => row.id)
            )
          );
        }
      }
      return kept.length;
    });
  }

  async getBySeekers(
    seekers: Uint8Array[]
  ): Promise<PendingEncryptedMessageRow[]> {
    if (seekers.length === 0) return [];
    return this.conn.db
      .select()
      .from(schema.pendingEncryptedMessages)
      .where(inArray(schema.pendingEncryptedMessages.seeker, seekers))
      .all();
  }

  async deleteBySeekers(seekers: Uint8Array[]): Promise<void> {
    if (seekers.length === 0) return;
    await this.conn.db
      .delete(schema.pendingEncryptedMessages)
      .where(inArray(schema.pendingEncryptedMessages.seeker, seekers));
  }

  /** Deletes the rows at any seeker but `keep`. */
  async deleteExceptSeekers(keep: Uint8Array[]): Promise<void> {
    const kept = new Set(keep.map(seeker => seeker.join(',')));
    const rows = await this.conn.db
      .select({
        id: schema.pendingEncryptedMessages.id,
        seeker: schema.pendingEncryptedMessages.seeker,
      })
      .from(schema.pendingEncryptedMessages)
      .all();
    const stale = rows
      .filter(row => !kept.has(row.seeker.join(',')))
      .map(row => row.id);
    if (stale.length === 0) return;
    await this.conn.db
      .delete(schema.pendingEncryptedMessages)
      .where(inArray(schema.pendingEncryptedMessages.id, stale));
  }

  async deleteFetchedBefore(cutoff: Date): Promise<void> {
    await this.conn.db
      .delete(schema.pendingEncryptedMessages)
      .where(lt(schema.pendingEncryptedMessages.fetchedAt, cutoff));
  }
}
