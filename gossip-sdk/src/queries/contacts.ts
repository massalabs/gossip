import { eq, and, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb, getLastInsertRowId } from '../sqlite';
import { Contact } from '../db';

export type ContactRow = typeof schema.contacts.$inferSelect;
type ContactInsert = typeof schema.contacts.$inferInsert;

export async function getContactByOwnerAndUser(
  ownerUserId: string,
  userId: string
): Promise<ContactRow | undefined> {
  return getSqliteDb()
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

export async function getContactsByOwner(
  ownerUserId: string
): Promise<Contact[]> {
  return getSqliteDb()
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.ownerUserId, ownerUserId))
    .all();
}

export async function insertContact(values: ContactInsert): Promise<number> {
  await getSqliteDb().insert(schema.contacts).values(values);
  return getLastInsertRowId();
}

export async function updateContactByOwnerAndUser(
  ownerUserId: string,
  userId: string,
  data: Partial<ContactInsert>
): Promise<void> {
  await getSqliteDb()
    .update(schema.contacts)
    .set(data)
    .where(
      and(
        eq(schema.contacts.ownerUserId, ownerUserId),
        eq(schema.contacts.userId, userId)
      )
    );
}

export async function deleteContactByOwnerAndUser(
  ownerUserId: string,
  userId: string
): Promise<void> {
  await getSqliteDb()
    .delete(schema.contacts)
    .where(
      and(
        eq(schema.contacts.ownerUserId, ownerUserId),
        eq(schema.contacts.userId, userId)
      )
    );
}

/** Escape LIKE wildcard characters so they match literally. */
function escapeLike(value: string): string {
  return value.replace(/[%_]/g, '\\$&');
}

export async function getContactNamesByPrefix(
  ownerUserId: string,
  prefix: string
): Promise<{ name: string }[]> {
  return getSqliteDb()
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
