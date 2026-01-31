/**
 * Encrypted SQLite implementation of IDiscussionRepository
 */

import type { IRuntimeAdapter } from '../../interfaces';
import type { IDiscussionRepository } from '../../interfaces/repositories';
import type {
  Discussion,
  DiscussionStatus,
  DiscussionDirection,
} from '../../models';
import type { Observable } from '../../base/Observable';
import { BehaviorSubject, map } from '../../base/Observable';
import {
  dateToSql,
  sqlToDate,
  blobToSql,
  sqlToBlob,
} from '../../schema/sqlite';

interface DiscussionRow {
  id: number;
  ownerUserId: string;
  contactUserId: string;
  direction: string;
  status: string;
  nextSeeker: Uint8Array | null;
  initiationAnnouncement: Uint8Array | null;
  announcementMessage: string | null;
  lastSyncTimestamp: string | null;
  customName: string | null;
  lastMessageId: number | null;
  lastMessageContent: string | null;
  lastMessageTimestamp: string | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
}

function rowToDiscussion(row: DiscussionRow): Discussion {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    contactUserId: row.contactUserId,
    direction: row.direction as DiscussionDirection,
    status: row.status as DiscussionStatus,
    nextSeeker: sqlToBlob(row.nextSeeker),
    initiationAnnouncement: sqlToBlob(row.initiationAnnouncement),
    announcementMessage: row.announcementMessage || undefined,
    lastSyncTimestamp: row.lastSyncTimestamp
      ? sqlToDate(row.lastSyncTimestamp)
      : undefined,
    customName: row.customName || undefined,
    lastMessageId: row.lastMessageId || undefined,
    lastMessageContent: row.lastMessageContent || undefined,
    lastMessageTimestamp: row.lastMessageTimestamp
      ? sqlToDate(row.lastMessageTimestamp)
      : undefined,
    unreadCount: row.unreadCount,
    createdAt: sqlToDate(row.createdAt),
    updatedAt: sqlToDate(row.updatedAt),
  };
}

export class EncryptedDiscussionRepository implements IDiscussionRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Discussion | undefined> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToDiscussion(rows[0]) : undefined;
  }

  async getAll(): Promise<Discussion[]> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions ORDER BY lastMessageTimestamp DESC, createdAt DESC`
    );
    return rows.map(rowToDiscussion);
  }

  async create(entity: Omit<Discussion, 'id'>): Promise<Discussion> {
    const now = new Date();
    const createdAt = entity.createdAt || now;
    const updatedAt = entity.updatedAt || now;

    const result = await this.runtime.runSql(
      `INSERT INTO discussions (ownerUserId, contactUserId, direction, status, nextSeeker, initiationAnnouncement, announcementMessage, lastSyncTimestamp, customName, lastMessageId, lastMessageContent, lastMessageTimestamp, unreadCount, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.ownerUserId,
        entity.contactUserId,
        entity.direction,
        entity.status,
        blobToSql(entity.nextSeeker),
        blobToSql(entity.initiationAnnouncement),
        entity.announcementMessage || null,
        entity.lastSyncTimestamp ? dateToSql(entity.lastSyncTimestamp) : null,
        entity.customName || null,
        entity.lastMessageId || null,
        entity.lastMessageContent || null,
        entity.lastMessageTimestamp
          ? dateToSql(entity.lastMessageTimestamp)
          : null,
        entity.unreadCount,
        dateToSql(createdAt),
        dateToSql(updatedAt),
      ]
    );

    this.notifyChange();

    return {
      ...entity,
      id: result.lastInsertRowid,
      createdAt,
      updatedAt,
    };
  }

  async update(
    id: number,
    changes: Partial<Discussion>
  ): Promise<Discussion | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const updates: string[] = ['updatedAt = ?'];
    const values: unknown[] = [dateToSql(new Date())];

    if (changes.status !== undefined) {
      updates.push('status = ?');
      values.push(changes.status);
    }
    if (changes.nextSeeker !== undefined) {
      updates.push('nextSeeker = ?');
      values.push(blobToSql(changes.nextSeeker));
    }
    if (changes.initiationAnnouncement !== undefined) {
      updates.push('initiationAnnouncement = ?');
      values.push(blobToSql(changes.initiationAnnouncement));
    }
    if (changes.announcementMessage !== undefined) {
      updates.push('announcementMessage = ?');
      values.push(changes.announcementMessage || null);
    }
    if (changes.lastSyncTimestamp !== undefined) {
      updates.push('lastSyncTimestamp = ?');
      values.push(
        changes.lastSyncTimestamp ? dateToSql(changes.lastSyncTimestamp) : null
      );
    }
    if (changes.customName !== undefined) {
      updates.push('customName = ?');
      values.push(changes.customName || null);
    }
    if (changes.lastMessageId !== undefined) {
      updates.push('lastMessageId = ?');
      values.push(changes.lastMessageId || null);
    }
    if (changes.lastMessageContent !== undefined) {
      updates.push('lastMessageContent = ?');
      values.push(changes.lastMessageContent || null);
    }
    if (changes.lastMessageTimestamp !== undefined) {
      updates.push('lastMessageTimestamp = ?');
      values.push(
        changes.lastMessageTimestamp
          ? dateToSql(changes.lastMessageTimestamp)
          : null
      );
    }
    if (changes.unreadCount !== undefined) {
      updates.push('unreadCount = ?');
      values.push(changes.unreadCount);
    }

    values.push(id);
    await this.runtime.runSql(
      `UPDATE discussions SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    this.notifyChange();

    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM discussions WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Discussion | undefined> {
    const subject = new BehaviorSubject<Discussion | undefined>(undefined);
    this.get(id).then(d => subject.next(d));
    this.changeSubject.subscribe(() => {
      this.get(id).then(d => subject.next(d));
    });
    return subject;
  }

  observeAll(): Observable<Discussion[]> {
    const subject = new BehaviorSubject<Discussion[]>([]);
    this.getAll().then(ds => subject.next(ds));
    this.changeSubject.subscribe(() => {
      this.getAll().then(ds => subject.next(ds));
    });
    return subject;
  }

  // ============ Domain-specific ============

  async getByOwner(ownerUserId: string): Promise<Discussion[]> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions WHERE ownerUserId = ?
       ORDER BY
         CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
         lastMessageTimestamp DESC,
         createdAt DESC`,
      [ownerUserId]
    );
    return rows.map(rowToDiscussion);
  }

  async getByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Promise<Discussion | undefined> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions WHERE ownerUserId = ? AND contactUserId = ?`,
      [ownerUserId, contactUserId]
    );
    return rows.length > 0 ? rowToDiscussion(rows[0]) : undefined;
  }

  async getByStatus(
    ownerUserId: string,
    status: DiscussionStatus
  ): Promise<Discussion[]> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions WHERE ownerUserId = ? AND status = ?`,
      [ownerUserId, status]
    );
    return rows.map(rowToDiscussion);
  }

  async getActive(ownerUserId: string): Promise<Discussion[]> {
    const rows = await this.runtime.executeSql<DiscussionRow>(
      `SELECT * FROM discussions WHERE ownerUserId = ? AND status = 'active'`,
      [ownerUserId]
    );
    return rows.map(rowToDiscussion);
  }

  observeByOwner(ownerUserId: string): Observable<Discussion[]> {
    const subject = new BehaviorSubject<Discussion[]>([]);
    this.getByOwner(ownerUserId).then(ds => subject.next(ds));
    this.changeSubject.subscribe(() => {
      this.getByOwner(ownerUserId).then(ds => subject.next(ds));
    });
    return subject;
  }

  observeByOwnerAndContact(
    ownerUserId: string,
    contactUserId: string
  ): Observable<Discussion | undefined> {
    const subject = new BehaviorSubject<Discussion | undefined>(undefined);
    this.getByOwnerAndContact(ownerUserId, contactUserId).then(d =>
      subject.next(d)
    );
    this.changeSubject.subscribe(() => {
      this.getByOwnerAndContact(ownerUserId, contactUserId).then(d =>
        subject.next(d)
      );
    });
    return subject;
  }

  async getUnreadCount(ownerUserId: string): Promise<number> {
    const rows = await this.runtime.executeSql<{ total: number }>(
      `SELECT SUM(unreadCount) as total FROM discussions WHERE ownerUserId = ?`,
      [ownerUserId]
    );
    return rows[0]?.total || 0;
  }

  observeUnreadCount(ownerUserId: string): Observable<number> {
    return map(this.observeByOwner(ownerUserId), discussions =>
      discussions.reduce((total, d) => total + d.unreadCount, 0)
    );
  }

  async updateStatus(id: number, status: DiscussionStatus): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET status = ?, updatedAt = ? WHERE id = ?`,
      [status, dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async updateNextSeeker(id: number, nextSeeker: Uint8Array): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET nextSeeker = ?, updatedAt = ? WHERE id = ?`,
      [blobToSql(nextSeeker), dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async updateLastSyncTimestamp(id: number, timestamp: Date): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET lastSyncTimestamp = ?, updatedAt = ? WHERE id = ?`,
      [dateToSql(timestamp), dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async resetUnreadCount(id: number): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET unreadCount = 0, updatedAt = ? WHERE id = ?`,
      [dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async incrementUnreadCount(id: number): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET unreadCount = unreadCount + 1, updatedAt = ? WHERE id = ?`,
      [dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async updateLastMessage(
    id: number,
    messageId: number,
    content: string,
    timestamp: Date
  ): Promise<void> {
    await this.runtime.runSql(
      `UPDATE discussions SET lastMessageId = ?, lastMessageContent = ?, lastMessageTimestamp = ?, updatedAt = ? WHERE id = ?`,
      [messageId, content, dateToSql(timestamp), dateToSql(new Date()), id]
    );
    this.notifyChange();
  }

  async upsert(
    ownerUserId: string,
    contactUserId: string,
    data: Partial<Omit<Discussion, 'id' | 'ownerUserId' | 'contactUserId'>>
  ): Promise<Discussion> {
    const existing = await this.getByOwnerAndContact(
      ownerUserId,
      contactUserId
    );

    if (existing) {
      await this.update(existing.id!, data);
      return (await this.get(existing.id!))!;
    }

    // Create new
    const now = new Date();
    return await this.create({
      ownerUserId,
      contactUserId,
      direction: data.direction || ('initiated' as DiscussionDirection),
      status: data.status || ('pending' as DiscussionStatus),
      unreadCount: data.unreadCount ?? 0,
      createdAt: now,
      updatedAt: now,
      ...data,
    });
  }

  // ============ Internal ============

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}
