import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

export class ActiveSeekerQueries {
  constructor(private conn: DatabaseConnection) {}

  async replaceAll(seekers: Uint8Array[]): Promise<void> {
    await this.conn.withTransaction(async tx => {
      await tx.delete(schema.activeSeekers);
      if (seekers.length > 0) {
        await tx
          .insert(schema.activeSeekers)
          .values(seekers.map(seeker => ({ seeker })));
      }
    });
  }
}
