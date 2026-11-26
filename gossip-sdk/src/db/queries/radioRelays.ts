import { and, eq, lt } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export interface RadioRelayRecord {
  groupId: string;
  syncRef: string;
  chatId: string;
  author: string;
  createdAt: number;
  text: string;
  truncated: boolean;
  olderKey: boolean;
  atMillis: number;
}

export class RadioRelayQueries {
  constructor(private conn: DatabaseConnection) {}

  /** Records a relay heard; the first one of a message wins. Returns whether it was new. */
  async record(ownerUserId: string, r: RadioRelayRecord): Promise<boolean> {
    const rows = await this.conn.db
      .insert(schema.radioRelays)
      .values({ ownerUserId, ...r })
      .onConflictDoNothing()
      .returning({ syncRef: schema.radioRelays.syncRef });
    return rows.length > 0;
  }

  /** The relays heard for a group, oldest message first. */
  async byGroup(
    ownerUserId: string,
    groupId: string
  ): Promise<RadioRelayRecord[]> {
    const rows = await this.conn.db
      .select()
      .from(schema.radioRelays)
      .where(
        and(
          eq(schema.radioRelays.ownerUserId, ownerUserId),
          eq(schema.radioRelays.groupId, groupId)
        )
      )
      .orderBy(schema.radioRelays.createdAt)
      .all();
    return rows.map(({ ownerUserId: _, ...r }) => r);
  }

  /** Forgets the relays heard before `beforeMillis`. */
  async deleteOlderThan(
    ownerUserId: string,
    beforeMillis: number
  ): Promise<void> {
    await this.conn.db
      .delete(schema.radioRelays)
      .where(
        and(
          eq(schema.radioRelays.ownerUserId, ownerUserId),
          lt(schema.radioRelays.atMillis, beforeMillis)
        )
      );
  }

  async deleteByOwner(ownerUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.radioRelays)
      .where(eq(schema.radioRelays.ownerUserId, ownerUserId));
  }
}
