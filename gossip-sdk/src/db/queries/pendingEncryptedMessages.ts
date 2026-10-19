import { inArray, lt } from 'drizzle-orm';
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
      if (fresh.length > 0) {
        const fetchedAt = new Date();
        await tx
          .insert(schema.pendingEncryptedMessages)
          .values(fresh.map(m => ({ ...m, fetchedAt })));
      }
      return fresh.length;
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

  async deleteFetchedBefore(cutoff: Date): Promise<void> {
    await this.conn.db
      .delete(schema.pendingEncryptedMessages)
      .where(lt(schema.pendingEncryptedMessages.fetchedAt, cutoff));
  }
}
