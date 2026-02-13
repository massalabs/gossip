import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb } from '../sqlite';

export async function getAnnouncementCursor(
  userId: string
): Promise<string | undefined> {
  const row = await getSqliteDb()
    .select({ counter: schema.announcementCursors.counter })
    .from(schema.announcementCursors)
    .where(eq(schema.announcementCursors.userId, userId))
    .get();
  return row?.counter;
}

export async function upsertAnnouncementCursor(
  userId: string,
  counter: string
): Promise<void> {
  await getSqliteDb()
    .insert(schema.announcementCursors)
    .values({ userId, counter })
    .onConflictDoUpdate({
      target: schema.announcementCursors.userId,
      set: { counter },
    });
}
