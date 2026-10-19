import { eq } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export class TransportCursorQueries {
  constructor(private conn: DatabaseConnection) {}

  async get(userId: string): Promise<(string | undefined)[] | undefined> {
    const row = await this.conn.db
      .select({ cursors: schema.transportCursors.cursors })
      .from(schema.transportCursors)
      .where(eq(schema.transportCursors.userId, userId))
      .get();
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.cursors);
      if (!Array.isArray(parsed)) return undefined;
      return parsed.map(c => (typeof c === 'string' ? c : undefined));
    } catch {
      return undefined;
    }
  }

  async upsert(userId: string, cursors: (string | undefined)[]): Promise<void> {
    // JSON has no undefined: null marks a transport with no cursor yet
    const value = JSON.stringify(cursors.map(c => c ?? null));
    await this.conn.db
      .insert(schema.transportCursors)
      .values({ userId, cursors: value })
      .onConflictDoUpdate({
        target: schema.transportCursors.userId,
        set: { cursors: value },
      });
  }
}
