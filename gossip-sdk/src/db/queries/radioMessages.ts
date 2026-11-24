import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export interface RadioMessageRecord {
  eventId: string;
  syncObjId: string;
  chatId: string;
  direction: 'sent' | 'received';
  olderKey: boolean;
  atMillis: number;
}

export class RadioMessageQueries {
  constructor(private conn: DatabaseConnection) {}

  /** Records that a group event travelled by radio; the first record wins. */
  async record(ownerUserId: string, r: RadioMessageRecord): Promise<void> {
    await this.conn.db
      .insert(schema.radioMessages)
      .values({ ownerUserId, ...r })
      .onConflictDoNothing();
  }

  /** The radio records of these messages, by sync object ID. */
  async bySyncObjIds(
    ownerUserId: string,
    syncObjIds: string[]
  ): Promise<Map<string, RadioMessageRecord>> {
    const out = new Map<string, RadioMessageRecord>();
    if (syncObjIds.length === 0) return out;
    const rows = await this.conn.db
      .select()
      .from(schema.radioMessages)
      .where(
        and(
          eq(schema.radioMessages.ownerUserId, ownerUserId),
          inArray(schema.radioMessages.syncObjId, syncObjIds)
        )
      )
      .all();
    for (const row of rows) {
      out.set(row.syncObjId, {
        eventId: row.eventId,
        syncObjId: row.syncObjId,
        chatId: row.chatId,
        direction: row.direction === 'sent' ? 'sent' : 'received',
        olderKey: row.olderKey,
        atMillis: row.atMillis,
      });
    }
    return out;
  }

  async deleteByOwner(ownerUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.radioMessages)
      .where(eq(schema.radioMessages.ownerUserId, ownerUserId));
  }
}
