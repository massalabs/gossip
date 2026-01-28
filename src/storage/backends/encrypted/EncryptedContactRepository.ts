/**
 * Encrypted SQLite implementation of IContactRepository
 */

import type { IRuntimeAdapter } from '../../interfaces';
import type { IContactRepository } from '../../interfaces/repositories';
import type { Contact } from '../../models';
import type { Observable } from '../../base/Observable';
import { BehaviorSubject } from '../../base/Observable';
import {
  dateToSql,
  sqlToDate,
  boolToSql,
  sqlToBool,
  blobToSql,
  sqlToBlob,
} from '../../schema/sqlite';

interface ContactRow {
  id: number;
  ownerUserId: string;
  userId: string;
  name: string;
  avatar: string | null;
  publicKeys: Uint8Array;
  isOnline: number;
  lastSeen: string;
  createdAt: string;
}

function rowToContact(row: ContactRow): Contact {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    userId: row.userId,
    name: row.name,
    avatar: row.avatar || undefined,
    publicKeys: sqlToBlob(row.publicKeys) || new Uint8Array(),
    isOnline: sqlToBool(row.isOnline),
    lastSeen: sqlToDate(row.lastSeen),
    createdAt: sqlToDate(row.createdAt),
  };
}

export class EncryptedContactRepository implements IContactRepository {
  private changeSubject = new BehaviorSubject<number>(0);

  constructor(private runtime: IRuntimeAdapter) {}

  // ============ Basic CRUD ============

  async get(id: number): Promise<Contact | undefined> {
    const rows = await this.runtime.executeSql<ContactRow>(
      `SELECT * FROM contacts WHERE id = ?`,
      [id]
    );
    return rows.length > 0 ? rowToContact(rows[0]) : undefined;
  }

  async getAll(): Promise<Contact[]> {
    const rows = await this.runtime.executeSql<ContactRow>(
      `SELECT * FROM contacts ORDER BY name`
    );
    return rows.map(rowToContact);
  }

  async create(entity: Omit<Contact, 'id'>): Promise<Contact> {
    const now = new Date();
    const createdAt = entity.createdAt || now;

    const result = await this.runtime.runSql(
      `INSERT INTO contacts (ownerUserId, userId, name, avatar, publicKeys, isOnline, lastSeen, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entity.ownerUserId,
        entity.userId,
        entity.name,
        entity.avatar || null,
        blobToSql(entity.publicKeys),
        boolToSql(entity.isOnline),
        dateToSql(entity.lastSeen),
        dateToSql(createdAt),
      ]
    );

    this.notifyChange();

    return {
      ...entity,
      id: result.lastInsertRowid,
      createdAt,
    };
  }

  async update(
    id: number,
    changes: Partial<Contact>
  ): Promise<Contact | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const updates: string[] = [];
    const values: unknown[] = [];

    if (changes.name !== undefined) {
      updates.push('name = ?');
      values.push(changes.name);
    }
    if (changes.avatar !== undefined) {
      updates.push('avatar = ?');
      values.push(changes.avatar || null);
    }
    if (changes.publicKeys !== undefined) {
      updates.push('publicKeys = ?');
      values.push(blobToSql(changes.publicKeys));
    }
    if (changes.isOnline !== undefined) {
      updates.push('isOnline = ?');
      values.push(boolToSql(changes.isOnline));
    }
    if (changes.lastSeen !== undefined) {
      updates.push('lastSeen = ?');
      values.push(dateToSql(changes.lastSeen));
    }

    if (updates.length === 0) return existing;

    values.push(id);
    await this.runtime.runSql(
      `UPDATE contacts SET ${updates.join(', ')} WHERE id = ?`,
      values
    );

    this.notifyChange();

    return await this.get(id);
  }

  async delete(id: number): Promise<boolean> {
    const result = await this.runtime.runSql(
      `DELETE FROM contacts WHERE id = ?`,
      [id]
    );
    if (result.changes > 0) {
      this.notifyChange();
      return true;
    }
    return false;
  }

  // ============ Reactivity ============

  observe(id: number): Observable<Contact | undefined> {
    const subject = new BehaviorSubject<Contact | undefined>(undefined);

    // Initial fetch
    this.get(id).then(contact => subject.next(contact));

    // Subscribe to changes
    this.changeSubject.subscribe(() => {
      this.get(id).then(contact => subject.next(contact));
    });

    return subject;
  }

  observeAll(): Observable<Contact[]> {
    const subject = new BehaviorSubject<Contact[]>([]);

    // Initial fetch
    this.getAll().then(contacts => subject.next(contacts));

    // Subscribe to changes
    this.changeSubject.subscribe(() => {
      this.getAll().then(contacts => subject.next(contacts));
    });

    return subject;
  }

  // ============ Domain-specific ============

  async getByOwner(ownerUserId: string): Promise<Contact[]> {
    const rows = await this.runtime.executeSql<ContactRow>(
      `SELECT * FROM contacts WHERE ownerUserId = ? ORDER BY name`,
      [ownerUserId]
    );
    return rows.map(rowToContact);
  }

  async getByOwnerAndUserId(
    ownerUserId: string,
    userId: string
  ): Promise<Contact | undefined> {
    const rows = await this.runtime.executeSql<ContactRow>(
      `SELECT * FROM contacts WHERE ownerUserId = ? AND userId = ?`,
      [ownerUserId, userId]
    );
    return rows.length > 0 ? rowToContact(rows[0]) : undefined;
  }

  observeByOwner(ownerUserId: string): Observable<Contact[]> {
    const subject = new BehaviorSubject<Contact[]>([]);

    // Initial fetch
    this.getByOwner(ownerUserId).then(contacts => subject.next(contacts));

    // Subscribe to changes
    this.changeSubject.subscribe(() => {
      this.getByOwner(ownerUserId).then(contacts => subject.next(contacts));
    });

    return subject;
  }

  async updateOnlineStatus(
    ownerUserId: string,
    userId: string,
    isOnline: boolean
  ): Promise<void> {
    const lastSeen = isOnline ? new Date() : undefined;

    await this.runtime.runSql(
      `UPDATE contacts SET isOnline = ?${lastSeen ? ', lastSeen = ?' : ''}
       WHERE ownerUserId = ? AND userId = ?`,
      lastSeen
        ? [boolToSql(isOnline), dateToSql(lastSeen), ownerUserId, userId]
        : [boolToSql(isOnline), ownerUserId, userId]
    );

    this.notifyChange();
  }

  async searchByName(ownerUserId: string, query: string): Promise<Contact[]> {
    const rows = await this.runtime.executeSql<ContactRow>(
      `SELECT * FROM contacts
       WHERE ownerUserId = ? AND name LIKE ?
       ORDER BY name`,
      [ownerUserId, `%${query}%`]
    );
    return rows.map(rowToContact);
  }

  // ============ Internal ============

  private notifyChange(): void {
    this.changeSubject.next(this.changeSubject.getValue() + 1);
  }
}
