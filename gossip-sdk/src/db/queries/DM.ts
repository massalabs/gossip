import { eq, and, gt, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export type DMRow = typeof schema.dms.$inferSelect;
export type DMInsert = typeof schema.dms.$inferInsert;

export class DMQueries {
  constructor(private conn: DatabaseConnection) {}

  async getByContact(contactUserId: string): Promise<DMRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.dms)
      .where(eq(schema.dms.contactUserId, contactUserId))
      .get();
  }

  async getAll(): Promise<DMRow[]> {
    return this.conn.db.select().from(schema.dms).all();
  }

  async getById(id: number): Promise<DMRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.dms)
      .where(eq(schema.dms.id, id))
      .get();
  }

  async insert(values: DMInsert): Promise<number> {
    await this.conn.db.insert(schema.dms).values(values);
    return this.conn.getLastInsertRowId();
  }

  async updateById(id: number, data: Partial<DMInsert>): Promise<void> {
    await this.conn.db
      .update(schema.dms)
      .set(data)
      .where(eq(schema.dms.id, id));
  }

  async updateByContact(
    contactUserId: string,
    data: Partial<DMInsert>
  ): Promise<void> {
    await this.conn.db
      .update(schema.dms)
      .set(data)
      .where(eq(schema.dms.contactUserId, contactUserId));
  }

  async deleteById(id: number): Promise<void> {
    await this.conn.db.delete(schema.dms).where(eq(schema.dms.id, id));
  }

  async deleteByContact(contactUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.dms)
      .where(eq(schema.dms.contactUserId, contactUserId));
  }

  async incrementUnreadCount(dmId: number): Promise<void> {
    await this.conn.db
      .update(schema.dms)
      .set({
        unreadCount: sql`${schema.dms.unreadCount} + 1`,
      })
      .where(eq(schema.dms.id, dmId));
  }

  async decrementUnreadCount(dmId: number): Promise<void> {
    await this.conn.db
      .update(schema.dms)
      .set({
        unreadCount: sql`MAX(${schema.dms.unreadCount} - 1, 0)`,
      })
      .where(and(eq(schema.dms.id, dmId), gt(schema.dms.unreadCount, 0)));
  }
}
