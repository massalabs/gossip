import { inArray } from 'drizzle-orm';
import * as schema from '../schema';
import { getSqliteDb } from '../sqlite';

export type PendingAnnouncementRow =
  typeof schema.pendingAnnouncements.$inferSelect;

export async function getAllPendingAnnouncements(): Promise<
  PendingAnnouncementRow[]
> {
  return getSqliteDb().select().from(schema.pendingAnnouncements).all();
}

export async function deletePendingAnnouncementsByIds(
  ids: number[]
): Promise<void> {
  await getSqliteDb()
    .delete(schema.pendingAnnouncements)
    .where(inArray(schema.pendingAnnouncements.id, ids));
}
