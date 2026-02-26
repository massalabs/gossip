import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export class ActiveSeekerQueries {
  constructor(private conn: DatabaseConnection) {}

  async replaceAll(seekers: Uint8Array[]): Promise<void> {
    await this.conn.withTransaction(async () => {
      await this.conn.db.delete(schema.activeSeekers);
      if (seekers.length > 0) {
        await this.conn.db
          .insert(schema.activeSeekers)
          .values(seekers.map(seeker => ({ seeker })));
      }
    });
  }
}
