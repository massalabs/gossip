import { inArray } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export type PendingAnnouncementRow =
  typeof schema.pendingAnnouncements.$inferSelect;

export class PendingAnnouncementQueries {
  constructor(private conn: DatabaseConnection) {}

  /** Queues announcements pushed by a transport; exact repeats are ignored. */
  async insertNew(announcements: Uint8Array[]): Promise<void> {
    if (announcements.length === 0) return;
    const fetchedAt = new Date();
    await this.conn.db
      .insert(schema.pendingAnnouncements)
      .values(announcements.map(announcement => ({ announcement, fetchedAt })))
      .onConflictDoNothing();
  }

  async getAll(): Promise<PendingAnnouncementRow[]> {
    return this.conn.db.select().from(schema.pendingAnnouncements).all();
  }

  async deleteByIds(ids: number[]): Promise<void> {
    await this.conn.db
      .delete(schema.pendingAnnouncements)
      .where(inArray(schema.pendingAnnouncements.id, ids));
  }
}
