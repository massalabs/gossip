import * as schema from '../schema';
import { getSqliteDb, withTransaction } from '../sqlite';

export async function replaceActiveSeekers(
  seekers: Uint8Array[]
): Promise<void> {
  await withTransaction(async () => {
    const db = getSqliteDb();
    await db.delete(schema.activeSeekers);
    if (seekers.length > 0) {
      await db
        .insert(schema.activeSeekers)
        .values(seekers.map(seeker => ({ seeker })));
    }
  });
}
