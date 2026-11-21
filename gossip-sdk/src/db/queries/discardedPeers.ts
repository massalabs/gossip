import { and, eq } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export class DiscardedPeerQueries {
  constructor(private conn: DatabaseConnection) {}

  /** Latest announcement timestamp a replay must exceed, if the peer was deleted. */
  async getFloor(
    ownerUserId: string,
    userId: string
  ): Promise<number | undefined> {
    const row = await this.conn.db
      .select({ floor: schema.discardedPeers.announcementFloorMillis })
      .from(schema.discardedPeers)
      .where(
        and(
          eq(schema.discardedPeers.ownerUserId, ownerUserId),
          eq(schema.discardedPeers.userId, userId)
        )
      )
      .get();
    return row?.floor;
  }

  /** Keeps the highest floor seen for the peer. */
  async raise(
    ownerUserId: string,
    userId: string,
    announcementFloorMillis: number
  ): Promise<void> {
    const current = await this.getFloor(ownerUserId, userId);
    if (current !== undefined && current >= announcementFloorMillis) return;
    await this.conn.db
      .insert(schema.discardedPeers)
      .values({ ownerUserId, userId, announcementFloorMillis })
      .onConflictDoUpdate({
        target: [
          schema.discardedPeers.ownerUserId,
          schema.discardedPeers.userId,
        ],
        set: { announcementFloorMillis },
      });
  }

  async deleteByOwner(ownerUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.discardedPeers)
      .where(eq(schema.discardedPeers.ownerUserId, ownerUserId));
  }
}
