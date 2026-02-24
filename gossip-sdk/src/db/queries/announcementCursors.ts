import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DatabaseConnection } from '../sqlite';

export class AnnouncementCursorQueries {
  constructor(private conn: DatabaseConnection) {}

  async get(userId: string): Promise<string | undefined> {
    const row = await this.conn.db
      .select({ counter: schema.announcementCursors.counter })
      .from(schema.announcementCursors)
      .where(eq(schema.announcementCursors.userId, userId))
      .get();
    return row?.counter;
  }

  async upsert(userId: string, counter: string): Promise<void> {
    await this.conn.db
      .insert(schema.announcementCursors)
      .values({ userId, counter })
      .onConflictDoUpdate({
        target: schema.announcementCursors.userId,
        set: { counter },
      });
  }
}
