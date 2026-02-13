import { eq, and, gt, sql } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb, getLastInsertRowId } from '../sqlite';
import type { DiscussionStatus } from '../db';

export type DiscussionRow = typeof schema.discussions.$inferSelect;
type DiscussionInsert = typeof schema.discussions.$inferInsert;

export async function getDiscussionByOwnerAndContact(
  ownerUserId: string,
  contactUserId: string
): Promise<DiscussionRow | undefined> {
  return getSqliteDb()
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

export async function getDiscussionsByOwner(
  ownerUserId: string
): Promise<DiscussionRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.discussions)
    .where(eq(schema.discussions.ownerUserId, ownerUserId))
    .all();
}

export async function getDiscussionById(
  id: number
): Promise<DiscussionRow | undefined> {
  return getSqliteDb()
    .select()
    .from(schema.discussions)
    .where(eq(schema.discussions.id, id))
    .get();
}

export async function insertDiscussion(
  values: DiscussionInsert
): Promise<number> {
  await getSqliteDb().insert(schema.discussions).values(values);
  return getLastInsertRowId();
}

export async function updateDiscussionById(
  id: number,
  data: Partial<DiscussionInsert>
): Promise<void> {
  await getSqliteDb()
    .update(schema.discussions)
    .set(data)
    .where(eq(schema.discussions.id, id));
}

export async function deleteDiscussionById(id: number): Promise<void> {
  await getSqliteDb()
    .delete(schema.discussions)
    .where(eq(schema.discussions.id, id));
}

export async function deleteDiscussionsByOwnerAndContact(
  ownerUserId: string,
  contactUserId: string
): Promise<void> {
  await getSqliteDb()
    .delete(schema.discussions)
    .where(
      and(
        eq(schema.discussions.ownerUserId, ownerUserId),
        eq(schema.discussions.contactUserId, contactUserId)
      )
    );
}

/**
 * Atomically increment unreadCount by 1.
 */
export async function incrementUnreadCount(
  discussionId: number
): Promise<void> {
  await getSqliteDb()
    .update(schema.discussions)
    .set({
      unreadCount: sql`${schema.discussions.unreadCount} + 1`,
    })
    .where(eq(schema.discussions.id, discussionId));
}

/**
 * Atomically decrement unreadCount by 1, ensuring it never goes below 0.
 */
export async function decrementUnreadCount(
  discussionId: number
): Promise<void> {
  await getSqliteDb()
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

export async function getDiscussionsByOwnerAndStatus(
  ownerUserId: string,
  status: DiscussionStatus
): Promise<DiscussionRow[]> {
  return getSqliteDb()
    .select()
    .from(schema.discussions)
    .where(
      and(
        eq(schema.discussions.ownerUserId, ownerUserId),
        eq(schema.discussions.status, status)
      )
    )
    .all();
}
