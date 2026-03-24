import { eq, and, gt, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export type DiscussionRow = typeof schema.discussions.$inferSelect;
export type DiscussionInsert = typeof schema.discussions.$inferInsert;

export class DiscussionQueries {
  constructor(private conn: DatabaseConnection) {}

  async getByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<DiscussionRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.discussions)
      .where(
        and(
          eq(schema.discussions.ownerUserId, ownerUserId),
          eq(schema.discussions.contactUserId, contactUserId)
        )
      )
      .get();
  }

  async getByOwner(ownerUserId: string): Promise<DiscussionRow[]> {
    return this.conn.db
      .select()
      .from(schema.discussions)
      .where(eq(schema.discussions.ownerUserId, ownerUserId))
      .all();
  }

  async getById(id: number): Promise<DiscussionRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.discussions)
      .where(eq(schema.discussions.id, id))
      .get();
  }

  async insert(values: DiscussionInsert): Promise<number> {
    await this.conn.db.insert(schema.discussions).values(values);
    return this.conn.getLastInsertRowId();
  }

  async updateById(id: number, data: Partial<DiscussionInsert>): Promise<void> {
    await this.conn.db
      .update(schema.discussions)
      .set(data)
      .where(eq(schema.discussions.id, id));
  }

  async updateByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string,
    data: Partial<DiscussionInsert>
  ): Promise<void> {
    await this.conn.db
      .update(schema.discussions)
      .set(data)
      .where(
        and(
          eq(schema.discussions.ownerUserId, ownerUserId),
          eq(schema.discussions.contactUserId, contactUserId)
        )
      );
  }

  async deleteById(id: number): Promise<void> {
    await this.conn.db
      .delete(schema.discussions)
      .where(eq(schema.discussions.id, id));
  }

  async deleteByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<void> {
    await this.conn.db
      .delete(schema.discussions)
      .where(
        and(
          eq(schema.discussions.ownerUserId, ownerUserId),
          eq(schema.discussions.contactUserId, contactUserId)
        )
      );
  }

  async incrementUnreadCount(discussionId: number): Promise<void> {
    await this.conn.db
      .update(schema.discussions)
      .set({
        unreadCount: sql`${schema.discussions.unreadCount} + 1`,
      })
      .where(eq(schema.discussions.id, discussionId));
  }

  async decrementUnreadCount(discussionId: number): Promise<void> {
    await this.conn.db
      .update(schema.discussions)
      .set({
        unreadCount: sql`MAX(${schema.discussions.unreadCount} - 1, 0)`,
      })
      .where(
        and(
          eq(schema.discussions.id, discussionId),
          gt(schema.discussions.unreadCount, 0)
        )
      );
  }
}
