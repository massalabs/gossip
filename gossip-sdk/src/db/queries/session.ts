import { eq } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export type SessionRow = typeof schema.sessions.$inferSelect;
export type SessionInsert = typeof schema.sessions.$inferInsert;

export class SessionQueries {
  constructor(private conn: DatabaseConnection) {}

  async getByContact(contactUserId: string): Promise<SessionRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.contactUserId, contactUserId))
      .get();
  }

  async getAll(): Promise<SessionRow[]> {
    return this.conn.db.select().from(schema.sessions).all();
  }

  async getById(id: number): Promise<SessionRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, id))
      .get();
  }

  async insert(values: SessionInsert): Promise<number> {
    await this.conn.db.insert(schema.sessions).values(values);
    return this.conn.getLastInsertRowId();
  }

  async updateById(id: number, data: Partial<SessionInsert>): Promise<void> {
    await this.conn.db
      .update(schema.sessions)
      .set(data)
      .where(eq(schema.sessions.id, id));
  }

  async updateByContact(
    contactUserId: string,
    data: Partial<SessionInsert>
  ): Promise<void> {
    await this.conn.db
      .update(schema.sessions)
      .set(data)
      .where(eq(schema.sessions.contactUserId, contactUserId));
  }

  async deleteById(id: number): Promise<void> {
    await this.conn.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.id, id));
  }

  async deleteByContact(contactUserId: string): Promise<void> {
    await this.conn.db
      .delete(schema.sessions)
      .where(eq(schema.sessions.contactUserId, contactUserId));
  }
}
