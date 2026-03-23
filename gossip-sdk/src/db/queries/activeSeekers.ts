import * as schema from '../schema/index.js';
import type { DatabaseConnection } from '../sqlite.js';

function seekersEqual(a: Uint8Array[], b: Uint8Array[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].length !== b[i].length) return false;
    for (let j = 0; j < a[i].length; j++) {
      if (a[i][j] !== b[i][j]) return false;
    }
  }
  return true;
}

export class ActiveSeekerQueries {
  private lastSeekers: Uint8Array[] = [];

  constructor(private conn: DatabaseConnection) {}

  async replaceAll(seekers: Uint8Array[]): Promise<void> {
    if (seekersEqual(seekers, this.lastSeekers)) return;

    await this.conn.withTransaction(async () => {
      await this.conn.db.delete(schema.activeSeekers);
      if (seekers.length > 0) {
        await this.conn.db
          .insert(schema.activeSeekers)
          .values(seekers.map(seeker => ({ seeker })));
      }
    });
    this.lastSeekers = seekers.map(s => new Uint8Array(s));
  }
}
