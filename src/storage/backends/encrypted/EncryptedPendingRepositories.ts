/**
 * Encrypted SQLite implementations of pending/queue repositories
 */

import type { IRuntimeAdapter } from '../../interfaces';
import type {
  IPendingMessageRepository,
  IPendingAnnouncementRepository,
  IActiveSeekerRepository,
} from '../../interfaces/repositories';
import type {
  PendingEncryptedMessage,
  PendingAnnouncement,
  ActiveSeeker,
} from '../../models';
import type { Observable } from '../../base/Observable';
import { BehaviorSubject, map } from '../../base/Observable';
import {
  dateToSql,
  sqlToDate,
  blobToSql,
  sqlToBlob,
} from '../../schema/sqlite';

// ============ PendingMessageRepository ============

interface PendingMessageRow {
  id: number;
  seeker: Uint8Array;
  ciphertext: Uint8Array;
  fetchedAt: string;
}

function rowToPendingMessage(row: PendingMessageRow): PendingEncryptedMessage {
  return {
    id: row.id,
    seeker: sqlToBlob(row.seeker) || new Uint8Array(),
    ciphertext: sqlToBlob(row.ciphertext) || new Uint8Array(),
    fetchedAt: sqlToDate(row.fetchedAt),
  };
}

export class EncryptedPendingMessageRepository implements IPendingMessageRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  async get(id: number): Promise<PendingEncryptedMessage | undefined> {
    const rows = await this.runtime.executeSql<PendingMessageRow>(
      `SELECT * FROM pendingEncryptedMessages WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToPendingMessage(rows[0]) : undefined;
  }

  async getAll(): Promise<PendingEncryptedMessage[]> {
    const rows = await this.runtime.executeSql<PendingMessageRow>(
      `SELECT * FROM pendingEncryptedMessages`
    );
    return rows.map(rowToPendingMessage);
  }

  async getAllOrdered(): Promise<PendingEncryptedMessage[]> {
    const rows = await this.runtime.executeSql<PendingMessageRow>(
      `SELECT * FROM pendingEncryptedMessages ORDER BY fetchedAt`
    );
    return rows.map(rowToPendingMessage);
  }

  async create(
    entity: Omit<PendingEncryptedMessage, 'id'>
  ): Promise<PendingEncryptedMessage> {
    const result = await this.runtime.runSql(
      `INSERT INTO pendingEncryptedMessages (seeker, ciphertext, fetchedAt) VALUES (?, ?, ?)`,
      [
        blobToSql(entity.seeker),
        blobToSql(entity.ciphertext),
        dateToSql(entity.fetchedAt),
      ]
    );
    this.notifyChange();
    return { ...entity, id: result.lastInsertRowid };
  }

  async update(
    id: number,
    changes: Partial<PendingEncryptedMessage>
  ): Promise<PendingEncryptedMessage | undefined> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (changes.seeker !== undefined) {
      updates.push('seeker = ?');
      values.push(blobToSql(changes.seeker));
    }
    if (changes.ciphertext !== undefined) {
      updates.push('ciphertext = ?');
      values.push(blobToSql(changes.ciphertext));
    }

    if (updates.length === 0) return await this.get(id);

    values.push(id);
    await this.runtime.runSql(
      `UPDATE pendingEncryptedMessages SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    this.notifyChange();
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM pendingEncryptedMessages WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  observe(id: number): Observable<PendingEncryptedMessage | undefined> {
    const subject = new BehaviorSubject<PendingEncryptedMessage | undefined>(
      undefined
    );
    this.get(id).then(m => subject.next(m));
    this.changeSubject.subscribe(() => this.get(id).then(m => subject.next(m)));
    return subject;
  }

  observeAll(): Observable<PendingEncryptedMessage[]> {
    const subject = new BehaviorSubject<PendingEncryptedMessage[]>([]);
    this.getAll().then(ms => subject.next(ms));
    this.changeSubject.subscribe(() =>
      this.getAll().then(ms => subject.next(ms))
    );
    return subject;
  }

  async createMany(
    entities: Omit<PendingEncryptedMessage, 'id'>[]
  ): Promise<PendingEncryptedMessage[]> {
    const results: PendingEncryptedMessage[] = [];
    for (const entity of entities) {
      results.push(await this.create(entity));
    }
    return results;
  }

  async deleteMany(ids: number[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async clear(): Promise<void> {
    await this.runtime.runSql(`DELETE FROM pendingEncryptedMessages`);
    this.notifyChange();
  }

  async getBySeeker(
    seeker: Uint8Array
  ): Promise<PendingEncryptedMessage | undefined> {
    const rows = await this.runtime.executeSql<PendingMessageRow>(
      `SELECT * FROM pendingEncryptedMessages WHERE seeker = ?`,
      [blobToSql(seeker)]
    );
    return rows.length > 0 ? rowToPendingMessage(rows[0]) : undefined;
  }

  async hasSeeker(seeker: Uint8Array): Promise<boolean> {
    const msg = await this.getBySeeker(seeker);
    return msg !== undefined;
  }

  async deleteBySeeker(seeker: Uint8Array): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM pendingEncryptedMessages WHERE seeker = ?`,
      [blobToSql(seeker)]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), msgs => msgs.length);
  }

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}

// ============ PendingAnnouncementRepository ============

interface PendingAnnouncementRow {
  id: number;
  announcement: Uint8Array;
  fetchedAt: string;
  counter: string | null;
}

function rowToPendingAnnouncement(
  row: PendingAnnouncementRow
): PendingAnnouncement {
  return {
    id: row.id,
    announcement: sqlToBlob(row.announcement) || new Uint8Array(),
    fetchedAt: sqlToDate(row.fetchedAt),
    counter: row.counter || undefined,
  };
}

export class EncryptedPendingAnnouncementRepository implements IPendingAnnouncementRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  async get(id: number): Promise<PendingAnnouncement | undefined> {
    const rows = await this.runtime.executeSql<PendingAnnouncementRow>(
      `SELECT * FROM pendingAnnouncements WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToPendingAnnouncement(rows[0]) : undefined;
  }

  async getAll(): Promise<PendingAnnouncement[]> {
    const rows = await this.runtime.executeSql<PendingAnnouncementRow>(
      `SELECT * FROM pendingAnnouncements`
    );
    return rows.map(rowToPendingAnnouncement);
  }

  async getAllOrdered(): Promise<PendingAnnouncement[]> {
    const rows = await this.runtime.executeSql<PendingAnnouncementRow>(
      `SELECT * FROM pendingAnnouncements ORDER BY fetchedAt`
    );
    return rows.map(rowToPendingAnnouncement);
  }

  async create(
    entity: Omit<PendingAnnouncement, 'id'>
  ): Promise<PendingAnnouncement> {
    const result = await this.runtime.runSql(
      `INSERT INTO pendingAnnouncements (announcement, fetchedAt, counter) VALUES (?, ?, ?)`,
      [
        blobToSql(entity.announcement),
        dateToSql(entity.fetchedAt),
        entity.counter || null,
      ]
    );
    this.notifyChange();
    return { ...entity, id: result.lastInsertRowid };
  }

  async update(
    id: number,
    changes: Partial<PendingAnnouncement>
  ): Promise<PendingAnnouncement | undefined> {
    const updates: string[] = [];
    const values: unknown[] = [];

    if (changes.announcement !== undefined) {
      updates.push('announcement = ?');
      values.push(blobToSql(changes.announcement));
    }
    if (changes.counter !== undefined) {
      updates.push('counter = ?');
      values.push(changes.counter || null);
    }

    if (updates.length === 0) return await this.get(id);

    values.push(id);
    await this.runtime.runSql(
      `UPDATE pendingAnnouncements SET ${updates.join(', ')} WHERE id = ?`,
      values
    );
    this.notifyChange();
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM pendingAnnouncements WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  observe(id: number): Observable<PendingAnnouncement | undefined> {
    const subject = new BehaviorSubject<PendingAnnouncement | undefined>(
      undefined
    );
    this.get(id).then(a => subject.next(a));
    this.changeSubject.subscribe(() => this.get(id).then(a => subject.next(a)));
    return subject;
  }

  observeAll(): Observable<PendingAnnouncement[]> {
    const subject = new BehaviorSubject<PendingAnnouncement[]>([]);
    this.getAll().then(as => subject.next(as));
    this.changeSubject.subscribe(() =>
      this.getAll().then(as => subject.next(as))
    );
    return subject;
  }

  async createMany(
    entities: Omit<PendingAnnouncement, 'id'>[]
  ): Promise<PendingAnnouncement[]> {
    const results: PendingAnnouncement[] = [];
    for (const entity of entities) {
      results.push(await this.create(entity));
    }
    return results;
  }

  async deleteMany(ids: number[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async clear(): Promise<void> {
    await this.runtime.runSql(`DELETE FROM pendingAnnouncements`);
    this.notifyChange();
  }

  async hasAnnouncement(announcement: Uint8Array): Promise<boolean> {
    const rows = await this.runtime.executeSql<{ count: number }>(
      `SELECT COUNT(*) as count FROM pendingAnnouncements WHERE announcement = ?`,
      [blobToSql(announcement)]
    );
    return (rows[0]?.count || 0) > 0;
  }

  async deleteByAnnouncement(announcement: Uint8Array): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM pendingAnnouncements WHERE announcement = ?`,
      [blobToSql(announcement)]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  async getLatestCounter(): Promise<string | undefined> {
    const rows = await this.runtime.executeSql<{ counter: string | null }>(
      `SELECT counter FROM pendingAnnouncements ORDER BY fetchedAt DESC LIMIT 1`
    );
    return rows[0]?.counter || undefined;
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), as => as.length);
  }

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}

// ============ ActiveSeekerRepository ============

interface ActiveSeekerRow {
  id: number;
  seeker: Uint8Array;
}

function rowToActiveSeeker(row: ActiveSeekerRow): ActiveSeeker {
  return {
    id: row.id,
    seeker: sqlToBlob(row.seeker) || new Uint8Array(),
  };
}

export class EncryptedActiveSeekerRepository implements IActiveSeekerRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  async get(id: number): Promise<ActiveSeeker | undefined> {
    const rows = await this.runtime.executeSql<ActiveSeekerRow>(
      `SELECT * FROM activeSeekers WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToActiveSeeker(rows[0]) : undefined;
  }

  async getAll(): Promise<ActiveSeeker[]> {
    const rows = await this.runtime.executeSql<ActiveSeekerRow>(
      `SELECT * FROM activeSeekers`
    );
    return rows.map(rowToActiveSeeker);
  }

  async create(entity: Omit<ActiveSeeker, 'id'>): Promise<ActiveSeeker> {
    const result = await this.runtime.runSql(
      `INSERT INTO activeSeekers (seeker) VALUES (?)`,
      [blobToSql(entity.seeker)]
    );
    this.notifyChange();
    return { ...entity, id: result.lastInsertRowid };
  }

  async update(
    id: number,
    changes: Partial<ActiveSeeker>
  ): Promise<ActiveSeeker | undefined> {
    if (changes.seeker === undefined) return await this.get(id);

    await this.runtime.runSql(
      `UPDATE activeSeekers SET seeker = ? WHERE id = ?`,
      [blobToSql(changes.seeker), id]
    );
    this.notifyChange();
    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM activeSeekers WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  observe(id: number): Observable<ActiveSeeker | undefined> {
    const subject = new BehaviorSubject<ActiveSeeker | undefined>(undefined);
    this.get(id).then(s => subject.next(s));
    this.changeSubject.subscribe(() => this.get(id).then(s => subject.next(s)));
    return subject;
  }

  observeAll(): Observable<ActiveSeeker[]> {
    const subject = new BehaviorSubject<ActiveSeeker[]>([]);
    this.getAll().then(ss => subject.next(ss));
    this.changeSubject.subscribe(() =>
      this.getAll().then(ss => subject.next(ss))
    );
    return subject;
  }

  async createMany(
    entities: Omit<ActiveSeeker, 'id'>[]
  ): Promise<ActiveSeeker[]> {
    const results: ActiveSeeker[] = [];
    for (const entity of entities) {
      results.push(await this.create(entity));
    }
    return results;
  }

  async deleteMany(ids: number[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async clear(): Promise<void> {
    await this.runtime.runSql(`DELETE FROM activeSeekers`);
    this.notifyChange();
  }

  async setAll(seekers: Uint8Array[]): Promise<void> {
    await this.clear();
    for (const seeker of seekers) {
      await this.create({ seeker });
    }
  }

  async getAllSeekers(): Promise<Uint8Array[]> {
    const all = await this.getAll();
    return all.map(s => s.seeker);
  }

  async addSeeker(seeker: Uint8Array): Promise<void> {
    if (await this.hasSeeker(seeker)) return;
    await this.create({ seeker });
  }

  async removeSeeker(seeker: Uint8Array): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM activeSeekers WHERE seeker = ?`,
      [blobToSql(seeker)]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  async hasSeeker(seeker: Uint8Array): Promise<boolean> {
    const rows = await this.runtime.executeSql<{ count: number }>(
      `SELECT COUNT(*) as count FROM activeSeekers WHERE seeker = ?`,
      [blobToSql(seeker)]
    );
    return (rows[0]?.count || 0) > 0;
  }

  observeCount(): Observable<number> {
    return map(this.observeAll(), ss => ss.length);
  }

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}
