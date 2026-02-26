import { eq, and, sql } from 'drizzle-orm';
import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';
import type { Contact } from '../db.js';

export type ContactRow = typeof schema.contacts.$inferSelect;
type ContactInsert = typeof schema.contacts.$inferInsert;

/** Escape LIKE wildcard characters so they match literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, '\\$&');
}

export class ContactQueries {
  constructor(private conn: DatabaseConnection) {}

  async getByOwnerAndUser(
    ownerUserId: string,
    userId: string
  ): Promise<ContactRow | undefined> {
    return this.conn.db
      .select()
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.ownerUserId, ownerUserId),
          eq(schema.contacts.userId, userId)
        )
      )
      .get();
  }

  async getByOwner(ownerUserId: string): Promise<Contact[]> {
    return this.conn.db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.ownerUserId, ownerUserId))
      .all();
  }

  async insert(values: ContactInsert): Promise<number> {
    await this.conn.db.insert(schema.contacts).values(values);
    return this.conn.getLastInsertRowId();
  }

  async updateByOwnerAndUser(
    ownerUserId: string,
    userId: string,
    data: Partial<ContactInsert>
  ): Promise<void> {
    await this.conn.db
      .update(schema.contacts)
      .set(data)
      .where(
        and(
          eq(schema.contacts.ownerUserId, ownerUserId),
          eq(schema.contacts.userId, userId)
        )
      );
  }

  async deleteByOwnerAndUser(
    ownerUserId: string,
    userId: string
  ): Promise<void> {
    await this.conn.db
      .delete(schema.contacts)
      .where(
        and(
          eq(schema.contacts.ownerUserId, ownerUserId),
          eq(schema.contacts.userId, userId)
        )
      );
  }

  async getNamesByPrefix(
    ownerUserId: string,
    prefix: string
  ): Promise<{ name: string }[]> {
    return this.conn.db
      .select({ name: schema.contacts.name })
      .from(schema.contacts)
      .where(
        and(
          eq(schema.contacts.ownerUserId, ownerUserId),
          sql`${schema.contacts.name} LIKE ${escapeLike(prefix) + '%'} ESCAPE '\\'`
        )
      )
      .all();
  }
}
