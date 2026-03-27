import { type DM } from '../../db/index.js';
import type { DMRow } from '../../db/queries/index.js';
import { Queries } from '../../db/queries/index.js';

function toDM(row: DMRow): DM {
  return {
    ...row,
    //lastAnnouncementMessage: row.announcementMessage ?? undefined,
  } as unknown as DM;
}

function toSortedDMs(rows: DMRow[]): DM[] {
  return rows.map(toDM).sort((a, b) => {
    if (a.lastMessageTimestamp && b.lastMessageTimestamp) {
      return b.lastMessageTimestamp.getTime() - a.lastMessageTimestamp.getTime();
    }
    if (a.lastMessageTimestamp) return -1;
    if (b.lastMessageTimestamp) return 1;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });
}

export class DMService {
  private queries: Queries;

  constructor(queries: Queries) {
    this.queries = queries;
  }

  async list(): Promise<DM[]> {
    const all = await this.queries.dms.getAll();
    return toSortedDMs(all);
  }

  async get(contactUserId: string): Promise<DM | undefined> {
    const row = await this.queries.dms.getByContact(contactUserId);
    return row ? toDM(row) : undefined;
  }
}
