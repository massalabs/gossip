import { inArray } from 'drizzle-orm';
import * as schema from '../schema';
import type { DatabaseConnection } from '../sqlite';

export type PendingAnnouncementRow =
  typeof schema.pendingAnnouncements.$inferSelect;

export class PendingAnnouncementQueries {
  constructor(private conn: DatabaseConnection) {}

  async getAll(): Promise<PendingAnnouncementRow[]> {
    return this.conn.db.select().from(schema.pendingAnnouncements).all();
  }

  async deleteByIds(ids: number[]): Promise<void> {
    await this.conn.db
      .delete(schema.pendingAnnouncements)
      .where(inArray(schema.pendingAnnouncements.id, ids));
  }
}
